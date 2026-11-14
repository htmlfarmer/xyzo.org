import { Hono } from "hono";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";

/**
 * Per-story relationship tree.
 *
 * The map renders EVENTS (a pin is a cluster of articles), but the link graph
 * (`news_story_links`) is ARTICLE↔ARTICLE. A pin therefore cannot answer
 * "what else is connected to this story" from the link table alone — one
 * representative article of a 1,000-member cluster carries a fraction of the
 * cluster's edges.
 *
 * This route resolves the pin to its EVENT and builds a ranked tree:
 *
 *   root
 *   ├─ siblings      same story, other outlets (the event's other articles)
 *   ├─ ★ strongest   semantic neighbours (HNSW) + same_event / semantic links
 *   ├─ ◐ related     same_entity / same_topic / moderate cosine
 *   └─ ○ long tail   same_city / same_country / weak ai_detected
 *
 * Candidates come from three sources, unioned:
 *   A. HNSW KNN over `nn_article_sentence_embeddings` — true "same story"
 *      neighbours, cross-language. Needs the embeddings timer running.
 *   B. `news_story_links` via bounded LATERAL fan-out — the graph's existing
 *      edges, which are mostly same-language/same-day, so they land in the
 *      lower buckets.
 *   C. The root event's own member articles — siblings.
 *
 * Every knob below is a measured value, not a guess. See
 * docs/STORY_TREE_2026-10-27.md for the benchmarks.
 */

export const storyTreeRoute = new Hono();

const treeLimiter = new RateLimiter({ max: 240, windowMs: 60 * 1000 });

// ── Tunables ────────────────────────────────────────────────────────
const MEMBER_FANOUT = 12; // links considered per root member article
const SEM_SEEDS = 2; // root members used as HNSW seeds
const SEM_PER_SEED = 30; // neighbours fetched per seed
const MAX_CHILDREN = 60; // children returned per level
const SIBLING_LIMIT = 25;
const ROOT_TITLE_LIMIT = 8;
const ROOT_KW_LIMIT = 40;

// Score blend. `sem_cos` dominates because it is the only signal that
// actually measures "same story"; link_strength is saturated (89% of
// ai_detected rows sit in [0.9,1.0]) and is kept only as a weak prior.
const W_SEM = 0.7;
const W_KW = 0.2;
const W_LINK = 0.1;
const KW_SCALE = 4; // containment ratio → 0..1

// How much a stored link strength is worth, per link type.
//
// `ai_detected` is worth NOTHING: 89 % of its rows sit in [0.9, 1.0] and
// the model returns `same_story` at 0.99 for articles about different
// countries, so the raw strength carries no signal. The rule-based links
// (same_entity, semantic_similarity, same_event) were computed from real
// overlap and do carry one.
const LINK_TYPE_WEIGHT: Record<string, number> = {
  same_entity: 1.0,
  semantic_similarity: 1.0,
  same_event: 0.9,
  same_topic: 0.45,
  same_city: 0.3,
  same_country: 0.15,
  manual: 0.8,
  ai_detected: 0.0,
};

const BUCKET_STRONG = 0.55;
const BUCKET_MEDIUM = 0.32;

const CACHE_TTL_MS = 15 * 60 * 1000; // matches the 15-minute link write cadence

// Hard ceiling on the level query. A cold query pays random I/O into a
// 25 GB link table and a 1.2 GB HNSW index — the worst observed cold case
// was 26 s, and the product contract is 10 s per click.
const LEVEL_TIMEOUT_MS = 6000;

/**
 * Run a query under a statement timeout.
 *
 * `SET LOCAL` only applies inside a transaction, and postgres.js pools
 * connections, so the timeout is set and reset on the same connection
 * around the query. postgres.js runs one statement at a time per
 * connection, so nothing else can be affected in between.
 */
async function withTimeout(sql: any, query: any, ms: number): Promise<any[]> {
  // SET takes no bind parameters, and `ms` is an internal constant (never
  // user input), so a literal is safe here.
  await sql.unsafe(`SET statement_timeout = ${Math.floor(ms)}`);
  try {
    return await query;
  } finally {
    await sql.unsafe("RESET statement_timeout");
  }
}

type TreeChild = {
  event_id: number;
  article_id: number;
  headline: string;
  url: string | null;
  source_name: string | null;
  place: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  published_at: string | null;
  source_count: number;
  first_reported_at: string | null;
  score: number;
  semantic_cos: number | null;
  keyword_ratio: number | null;
  link_strength: number | null;
  kinds: string[];
  n_articles: number;
  has_children: boolean;
};

type TreeResult = {
  root: {
    article_id: number;
    event_id: number | null;
    headline: string;
    url: string | null;
    place: string | null;
    lat: number | null;
    lng: number | null;
    published_at: string | null;
    members: number;
    is_mega_cluster: boolean;
  };
  siblings: { count: number; items: any[]; excluded: number };
  buckets: { key: string; label: string; children: TreeChild[] }[];
  meta: {
    elapsed_ms: number;
    timings: { resolve_ms: number; siblings_ms: number; level_ms: number };
    candidates: number;
    semantic_available: boolean;
    cached: boolean;
    truncated: boolean;
    timed_out: boolean;
  };
};

const cache = new Map<string, { at: number; data: TreeResult }>();

function cachedGet(key: string): TreeResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { ...hit.data, meta: { ...hit.data.meta, cached: true } };
}

function cachedSet(key: string, data: TreeResult): void {
  // Bounded cache — the map can surface tens of thousands of events.
  if (cache.size > 2000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 500);
    for (const [k] of oldest) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), data });
}

/** Resolve a pin id (either `pins.id` or `news_articles.id`) to a root. */
async function resolveRoot(sql: any, pinId: number) {
  // Community / editorial pins live in `pins` and carry their own id space.
  // The `pins` schema has drifted between environments (prod carries
  // `article_id`; older copies carry `canonical_url`/`lat`/`lng` inline), so
  // read the optional fields through to_jsonb() and COALESCE — that way the
  // route works on both without a migration.
  const [pin] = await sql<any[]>`
    SELECT p.id, p.title, p.source_type, p.published_at,
           ST_Y(p.location::geometry) AS lat,
           ST_X(p.location::geometry) AS lng,
           to_jsonb(p) ->> 'article_id' AS pin_article_id,
           coalesce(ed.canonical_url, cd.canonical_url, a.url,
                    to_jsonb(p) ->> 'canonical_url') AS canonical_url,
           coalesce(l.place_name, to_jsonb(p) ->> 'place_name') AS place_name,
           l.country
    FROM pins p
    LEFT JOIN news_articles a ON a.id = (to_jsonb(p) ->> 'article_id')::bigint
    LEFT JOIN editorial_details ed ON ed.pin_id = p.id
    LEFT JOIN community_details cd ON cd.pin_id = p.id
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE p.id = ${pinId}
    LIMIT 1
  `;
  if (pin) {
    const articleId = pin.pin_article_id != null ? Number(pin.pin_article_id) : null;
    let eventId: number | null = null;
    if (articleId) {
      const [ev] = await sql<any[]>`
        SELECT event_id FROM news_event_sources WHERE article_id = ${articleId} LIMIT 1
      `;
      eventId = ev ? Number(ev.event_id) : null;
    }
    return {
      articleId,
      eventId,
      headline: pin.title,
      url: pin.canonical_url || null,
      place: pin.place_name || null,
      country: pin.country || null,
      lat: pin.lat != null ? Number(pin.lat) : null,
      lng: pin.lng != null ? Number(pin.lng) : null,
      publishedAt: pin.published_at ? new Date(pin.published_at).toISOString() : null,
      sourceType: pin.source_type,
    };
  }

  // Editorial / RSS pins: the map returns `news_articles.id` for these.
  const [art] = await sql<any[]>`
    SELECT a.id, a.title, a.url, a.published_at, a.fetched_at,
           COALESCE(a.extracted_lat, l.lat) AS lat,
           COALESCE(a.extracted_lng, l.lng) AS lng,
           l.place_name, l.country,
           s.name AS source_name
    FROM news_articles a
    LEFT JOIN news_locations l ON l.id = a.location_id
    LEFT JOIN news_sources s ON s.id = a.source_id
    WHERE a.id = ${pinId}
    LIMIT 1
  `;
  if (!art) return null;

  const [ev] = await sql<any[]>`
    SELECT event_id FROM news_event_sources WHERE article_id = ${art.id} LIMIT 1
  `;
  return {
    articleId: Number(art.id),
    eventId: ev ? Number(ev.event_id) : null,
    headline: art.title,
    url: art.url || null,
    place: art.place_name || null,
    country: art.country || null,
    lat: art.lat != null ? Number(art.lat) : null,
    lng: art.lng != null ? Number(art.lng) : null,
    publishedAt: art.published_at
      ? new Date(art.published_at).toISOString()
      : art.fetched_at
        ? new Date(art.fetched_at).toISOString()
        : null,
    sourceName: art.source_name || null,
    sourceType: "rss",
  };
}

/**
 * Build one level of the tree for `rootEventId`.
 *
 * All of it is one round trip. The two hot parts are:
 *  - the graph fan-out: a LATERAL with `ORDER BY link_strength DESC LIMIT n`
 *    per member, which turns a 42.9M-row table into an index-only scan that
 *    stops early (measured: 22 ms for 3,212 members);
 *  - the semantic fan-out: HNSW KNN (measured: 130 ms).
 */
async function buildLevel(
  sql: any,
  rootEventId: number | null,
  rootArticleId: number | null,
  seedArticleIds: number[],
  skipSemantic = false,
): Promise<{ children: TreeChild[]; semanticAvailable: boolean; candidateCount: number; timedOut?: boolean }> {
  const buildBody = (q: any, skipSem: boolean) => q`
    WITH
    -- An article with no event cluster still gets a tree: it is its own
    -- root, and the semantic + graph fan-out runs off root_ids.
    members AS MATERIALIZED (
      SELECT article_id FROM news_event_sources
      WHERE event_id = coalesce(${rootEventId}::bigint, -1)
    ),
    root_ids AS MATERIALIZED (
      SELECT article_id FROM members
      UNION
      SELECT ${rootArticleId}::bigint WHERE ${rootArticleId}::bigint IS NOT NULL
    ),
    root_titles AS MATERIALIZED (
      SELECT DISTINCT a.title
      FROM news_articles a
      WHERE a.id IN (SELECT article_id FROM root_ids)
        AND a.title IS NOT NULL AND length(a.title) > 25
      LIMIT ${ROOT_TITLE_LIMIT}
    ),
    root_kw AS MATERIALIZED (
      SELECT kw, sum(w) AS tot
      FROM (
        SELECT key AS kw, value::float8 AS w
        FROM news_articles a, LATERAL jsonb_each_text(a.word_freq) x
        WHERE a.id IN (SELECT article_id FROM root_ids)
          AND a.word_freq IS NOT NULL
          -- jsonb_each_text throws on a non-object; a mis-encoded row must
          -- not take the whole tree down.
          AND jsonb_typeof(a.word_freq) = 'object'
      ) z
      GROUP BY kw
      ORDER BY tot DESC
      LIMIT ${ROOT_KW_LIMIT}
    ),
    root_tot AS (
      SELECT coalesce(sum(tot), 1.0) AS s FROM root_kw
    ),

    -- (A) semantic candidates: HNSW KNN from a few root members
    sem AS MATERIALIZED (
      SELECT DISTINCT ON (n.article_id)
             n.article_id,
             (1 - (n.vector <=> s.vector))::float8 AS cos
      FROM (
        SELECT e.article_id, e.vector
        FROM nn_article_sentence_embeddings e
        WHERE ${skipSem} = false
          AND e.article_id = ANY(${seedArticleIds}::bigint[])
        -- The seeds are the clicked article plus the cluster members that
        -- are semantically the SAME story. Seeding from arbitrary members
        -- poisons the result: a router-bug article once shared a stale
        -- event with eight Ballon d'Or articles, and half the retrieved
        -- "related" stories came from the wrong story entirely.
      ) s
      CROSS JOIN LATERAL (
        SELECT se.article_id, se.vector
        FROM nn_article_sentence_embeddings se
        ORDER BY se.vector <=> s.vector
        LIMIT ${SEM_PER_SEED}
      ) n
      WHERE n.article_id NOT IN (SELECT article_id FROM root_ids)
      ORDER BY n.article_id, (1 - (n.vector <=> s.vector)) DESC
    ),

    -- (B) graph candidates: bounded fan-out over news_story_links
    ba AS MATERIALIZED (
      SELECT l.o AS other_id, l.link_type, l.link_strength
      FROM root_ids m
      JOIN LATERAL (
        SELECT target_article_id AS o, link_type, link_strength
        FROM news_story_links l
        WHERE l.source_article_id = m.article_id
        ORDER BY link_strength DESC
        LIMIT ${MEMBER_FANOUT}
      ) l ON true
    ),
    bb AS MATERIALIZED (
      SELECT l.o AS other_id, l.link_type, l.link_strength
      FROM root_ids m
      JOIN LATERAL (
        SELECT source_article_id AS o, link_type, link_strength
        FROM news_story_links l
        WHERE l.target_article_id = m.article_id
        ORDER BY link_strength DESC
        LIMIT ${MEMBER_FANOUT}
      ) l ON true
    ),
    graph AS (
      SELECT other_id,
             max(link_strength) AS s,
             array_agg(DISTINCT link_type) AS kinds,
             count(*) AS n
      FROM (SELECT * FROM ba UNION ALL SELECT * FROM bb) u
      WHERE other_id IS NOT NULL
        -- the root's own cluster is not "related" — it is the root
        AND other_id NOT IN (SELECT article_id FROM root_ids)
      GROUP BY other_id
    ),
    cand AS (
      SELECT article_id, cos, NULL::float8 AS lnk, ARRAY[]::text[] AS kinds
      FROM sem
      UNION ALL
      SELECT other_id, NULL::float8, s, kinds FROM graph
    ),
    merged AS (
      SELECT u.article_id,
             max(u.cos) AS sem_cos,
             max(u.lnk) AS lnk,
             coalesce(array_agg(DISTINCT kk.k) FILTER (WHERE kk.k IS NOT NULL), ARRAY[]::text[]) AS kinds
      FROM cand u
      LEFT JOIN LATERAL (SELECT unnest(u.kinds) AS k) kk ON true
      GROUP BY u.article_id
    ),
    scored AS (
      SELECT m.article_id, m.sem_cos, m.lnk, m.kinds,
             a.title, a.url, a.published_at, a.fetched_at, a.word_freq,
             a.location_id AS article_location_id,
             s.name AS source_name,
             (
               SELECT coalesce(sum(rk.tot), 0)
               FROM root_kw rk
               WHERE a.word_freq ? rk.kw
             ) AS kw_hit
      FROM merged m
      JOIN news_articles a ON a.id = m.article_id
      LEFT JOIN news_sources s ON s.id = a.source_id AND s.deleted_at IS NULL
    ),
    agg AS (
      -- A candidate may not belong to any event (a great many articles do
      -- not). It still belongs in the tree, under a synthetic negative id
      -- so it cannot collide with a real event.
      SELECT
        coalesce(es.event_id, -sc.article_id) AS event_id,
        max(sc.sem_cos) AS sem_cos,
        max(sc.lnk) AS lnk,
        max(sc.kw_hit) AS kw_hit,
        count(DISTINCT sc.article_id) AS n_articles,
        coalesce(array_agg(DISTINCT kk.k) FILTER (WHERE kk.k IS NOT NULL), ARRAY[]::text[]) AS kinds,
        (array_agg(sc.title ORDER BY sc.sem_cos DESC NULLS LAST, sc.published_at DESC NULLS LAST))[1] AS title,
        (array_agg(sc.url ORDER BY sc.sem_cos DESC NULLS LAST, sc.published_at DESC NULLS LAST))[1] AS url,
        (array_agg(sc.source_name ORDER BY sc.sem_cos DESC NULLS LAST, sc.published_at DESC NULLS LAST))[1] AS source_name,
        (array_agg(coalesce(sc.published_at, sc.fetched_at) ORDER BY sc.sem_cos DESC NULLS LAST, sc.published_at DESC NULLS LAST))[1] AS published_at,
        (array_agg(sc.article_id ORDER BY sc.sem_cos DESC NULLS LAST, sc.published_at DESC NULLS LAST))[1] AS article_id,
        (array_agg(sc.article_location_id ORDER BY sc.sem_cos DESC NULLS LAST, sc.published_at DESC NULLS LAST))[1] AS article_location_id
      FROM scored sc
      LEFT JOIN news_event_sources es ON es.article_id = sc.article_id
      LEFT JOIN LATERAL (SELECT unnest(coalesce(sc.kinds, ARRAY[]::text[])) AS k) kk ON true
      GROUP BY coalesce(es.event_id, -sc.article_id)
    )
    SELECT
      ag.event_id, ag.article_id, ag.title, ag.url, ag.source_name,
      ag.published_at, ag.sem_cos, ag.lnk, ag.kinds, ag.n_articles, ag.kw_hit,
      coalesce(ev.headline, ag.title) AS headline, ev.source_count, ev.first_reported_at, ev.event_type, ev.status,
      loc.place_name, loc.country, loc.lat, loc.lng,
      rt.s AS root_tot,
      (SELECT count(*) FROM news_event_sources x WHERE x.event_id = ag.event_id) AS child_members
    FROM agg ag
    LEFT JOIN news_events ev ON ev.id = ag.event_id
    LEFT JOIN news_locations loc ON loc.id = coalesce(ev.primary_location_id, ag.article_location_id)
    CROSS JOIN root_tot rt
    WHERE ag.event_id IS DISTINCT FROM ${rootEventId}::bigint
    ORDER BY (
      ${W_SEM} * coalesce(ag.sem_cos, 0)
      + ${W_KW} * least(1.0, (ag.kw_hit / rt.s) * ${KW_SCALE})
      + ${W_LINK} * coalesce(ag.lnk, 0)
    ) DESC
    LIMIT ${MAX_CHILDREN}
  `;
  // ?explain=1 returns the plan instead of the rows — used to chase the
  // cold-start cost of this query.
  const body = buildBody(sql, skipSemantic);
  let timedOut = false;
  let rows: any[];
  {
    try {
      rows = await withTimeout(sql, body, LEVEL_TIMEOUT_MS);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!/timeout|canceling statement/i.test(msg)) throw e;
      // HARD CEILING. A cold query pays random I/O into a 25 GB link table
      // and a 1.2 GB HNSW index; the worst observed cold case was 26 s.
      // The contract is 10 s per click, so on a timeout the tree falls
      // back to the graph-only result instead of hanging.
      console.warn("[story-tree] level query timed out — falling back to graph-only");
      rows = await withTimeout(sql, buildBody(sql, true), LEVEL_TIMEOUT_MS);
      timedOut = true;
    }
  }

  const children: TreeChild[] = rows.map((r: any) => {
    const semCos = r.sem_cos != null ? Number(r.sem_cos) : null;
    const kwRatio = Number(r.kw_hit || 0) / Number(r.root_tot || 1);
    const lnk = r.lnk != null ? Number(r.lnk) : null;
    const kinds: string[] = (r.kinds || []).filter((k: unknown) => typeof k === "string");
    // The best link type decides how much the stored strength is worth.
    const typeWeight = kinds.length
      ? Math.max(...kinds.map((k) => LINK_TYPE_WEIGHT[k] ?? 0.25))
      : 0.25;
    const score =
      W_SEM * (semCos ?? 0) +
      W_KW * Math.min(1, kwRatio * KW_SCALE) +
      W_LINK * (lnk ?? 0) * typeWeight;
    return {
      event_id: Number(r.event_id),
      article_id: Number(r.article_id),
      headline: r.title || r.headline || "(untitled)",
      url: r.url || null,
      source_name: r.source_name || null,
      place: r.place_name || null,
      country: r.country || null,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      source_count: Number(r.source_count || 0),
      first_reported_at: r.first_reported_at ? new Date(r.first_reported_at).toISOString() : null,
      score: Math.round(score * 1000) / 1000,
      semantic_cos: semCos != null ? Math.round(semCos * 1000) / 1000 : null,
      keyword_ratio: Math.round(kwRatio * 1000) / 1000,
      link_strength: lnk != null ? Math.round(lnk * 1000) / 1000 : null,
      kinds,
      n_articles: Number(r.n_articles || 0),
      has_children: Number(r.child_members || 0) > 0,
    };
  });

  const semanticAvailable = rows.some((r: any) => r.sem_cos != null);
  return { children, semanticAvailable, candidateCount: rows.length, timedOut };
}

function bucketize(children: TreeChild[]) {
  const strong: TreeChild[] = [];
  const medium: TreeChild[] = [];
  const weak: TreeChild[] = [];
  for (const c of children) {
    if (c.score >= BUCKET_STRONG) strong.push(c);
    else if (c.score >= BUCKET_MEDIUM) medium.push(c);
    else weak.push(c);
  }
  return [
    { key: "strong", label: "Most related", children: strong },
    { key: "medium", label: "Related", children: medium },
    { key: "weak", label: "Long tail", children: weak },
  ];
}

// ── GET /api/pins/:id/tree ──────────────────────────────────────────
storyTreeRoute.get("/pins/:id/tree", async (c) => {
  const started = Date.now();
  const ip = getClientIp(c.req.raw);
  const rl = treeLimiter.check(ip);
  if (!rl.allowed) return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);

  const raw = c.req.param("id");
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

  const sql = getDb();

  const resolveStart = Date.now();
  const root = await resolveRoot(sql, id);
  if (!root) return c.json({ error: "not_found" }, 404);
  const resolveMs = Date.now() - resolveStart;

  const cacheKey = `pin:${id}`;
  // ?fresh=1 bypasses the cache (used to measure the real query cost).
  const fresh = c.req.query("fresh") === "1";
  const hit = fresh ? null : cachedGet(cacheKey);
  if (hit) return c.json(hit);

  // A pin with no event cluster is still a valid root: it is its own root
  // and the semantic + graph fan-out runs off the article itself.
  const rootEventId = root.eventId;

  const [memberRow] = await sql<any[]>`
    SELECT count(*) AS n FROM news_event_sources
    WHERE event_id = coalesce(${rootEventId}::bigint, -1)
  `;
  const memberCount = Number(memberRow?.n || 0);

  // Siblings — the same story carried by other outlets.
  const siblingsStart = Date.now();
  const siblingRows = rootEventId
    ? await sql<any[]>`
    SELECT a.id, a.title, a.url, a.published_at, a.fetched_at,
           s.name AS source_name, s.country AS source_country,
           l.place_name, l.lat, l.lng,
           (SELECT 1 - (e.vector <=> r.vector)
            FROM nn_article_sentence_embeddings e
            CROSS JOIN nn_article_sentence_embeddings r
            WHERE e.article_id = a.id AND r.article_id = ${root.articleId}::bigint
           ) AS root_cos
    FROM news_event_sources es
    JOIN news_articles a ON a.id = es.article_id
    LEFT JOIN news_sources s ON s.id = a.source_id AND s.deleted_at IS NULL
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE es.event_id = ${rootEventId}
      AND a.id <> coalesce(${root.articleId}::bigint, -1)
    ORDER BY coalesce(a.published_at, a.fetched_at) DESC NULLS LAST
    LIMIT ${SIBLING_LIMIT * 3}
  `
    : [];
  // A cluster member is only a "sibling" (the same story, another outlet)
  // if it is semantically the same story as the clicked article. 840 stale
  // clusters hold 25% of all event membership, and some of them mix five
  // unrelated stories — presenting those as "same story, other outlets"
  // is simply wrong. Members that fail the test are counted and dropped.
  const SIBLING_MIN_COS = 0.45;
  const scoredSiblings = siblingRows.map((r) => ({
    ...r,
    root_cos: r.root_cos != null ? Number(r.root_cos) : null,
  }));
  const keptSiblings = scoredSiblings.filter(
    (r) => r.root_cos == null || r.root_cos >= SIBLING_MIN_COS,
  );
  const siblings = keptSiblings.slice(0, SIBLING_LIMIT).map((r) => ({
    article_id: Number(r.id),
    headline: r.title || "(untitled)",
    url: r.url || null,
    source_name: r.source_name || null,
    source_country: r.source_country || null,
    place: r.place_name || null,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
  }));
  const siblingsExcluded = Math.max(0, memberCount - 1 - keptSiblings.length);

  // Semantic seeds: the clicked article first, then the members that are
  // verifiably the same story. Never an arbitrary member of the cluster.
  const seedArticleIds: number[] = [];
  if (root.articleId) seedArticleIds.push(root.articleId);
  for (const r of keptSiblings) {
    if (seedArticleIds.length >= SEM_SEEDS) break;
    seedArticleIds.push(Number(r.id));
  }

  const siblingsMs = Date.now() - siblingsStart;

  const levelStart = Date.now();
  const { children, semanticAvailable, candidateCount, timedOut } = await buildLevel(
    sql,
    rootEventId,
    root.articleId,
    seedArticleIds,
  );
  const levelMs = Date.now() - levelStart;

  const data: TreeResult = {
    root: {
      article_id: root.articleId ?? 0,
      event_id: rootEventId,
      headline: root.headline,
      url: root.url,
      place: root.place,
      lat: root.lat,
      lng: root.lng,
      published_at: root.publishedAt,
      members: memberCount,
      // A cluster whose members were re-geocoded without rebuilding the
      // cluster (840 events hold 25% of all membership) is not a real story.
      is_mega_cluster: memberCount > 40,
    },
    siblings: {
      count: keptSiblings.length,
      items: siblings,
      // Cluster members that are NOT the same story (stale mega-clusters).
      excluded: siblingsExcluded,
    },
    buckets: bucketize(children),
    meta: {
      elapsed_ms: Date.now() - started,
      timings: { resolve_ms: resolveMs, siblings_ms: siblingsMs, level_ms: levelMs },
      candidates: candidateCount,
      semantic_available: semanticAvailable,
      cached: false,
      truncated: candidateCount >= MAX_CHILDREN,
      timed_out: !!timedOut,
    },
  };
  cachedSet(cacheKey, data);
  return c.json(data);
});

// ── GET /api/events/:id/tree ─────────────────────────────────────────
// One level of the tree rooted at an event — used to expand a branch.
storyTreeRoute.get("/events/:id/tree", async (c) => {
  const started = Date.now();
  const raw = c.req.param("id");
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

  const sql = getDb();
  const cacheKey = `ev:${id}`;
  const hit = cachedGet(cacheKey);
  if (hit) return c.json(hit);

  const [ev] = await sql<any[]>`
    SELECT e.id, e.headline, e.source_count, e.first_reported_at, e.status,
           l.place_name, l.lat, l.lng
    FROM news_events e
    LEFT JOIN news_locations l ON l.id = e.primary_location_id
    WHERE e.id = ${id}
    LIMIT 1
  `;
  if (!ev) return c.json({ error: "not_found" }, 404);

  const [memberRow] = await sql<any[]>`
    SELECT count(*) AS n FROM news_event_sources WHERE event_id = ${id}
  `;
  const memberCount = Number(memberRow?.n || 0);

  const levelStart = Date.now();
  const seedRows = await sql<any[]>`
    SELECT es.article_id
    FROM news_event_sources es
    JOIN nn_article_sentence_embeddings e ON e.article_id = es.article_id
    WHERE es.event_id = ${id}
    LIMIT ${SEM_SEEDS}
  `;
  const seedArticleIds = seedRows.map((r: any) => Number(r.article_id));
  const { children, semanticAvailable, candidateCount, timedOut } = await buildLevel(
    sql,
    id,
    null,
    seedArticleIds,
  );
  const levelMs = Date.now() - levelStart;

  const data: TreeResult = {
    root: {
      article_id: 0,
      event_id: id,
      headline: ev.headline,
      url: null,
      place: ev.place_name || null,
      lat: ev.lat != null ? Number(ev.lat) : null,
      lng: ev.lng != null ? Number(ev.lng) : null,
      published_at: ev.first_reported_at ? new Date(ev.first_reported_at).toISOString() : null,
      members: memberCount,
      is_mega_cluster: memberCount > 40,
    },
    siblings: { count: 0, items: [], excluded: 0 },
    buckets: bucketize(children),
    meta: {
      elapsed_ms: Date.now() - started,
      timings: { resolve_ms: 0, siblings_ms: 0, level_ms: levelMs },
      candidates: candidateCount,
      semantic_available: semanticAvailable,
      cached: false,
      truncated: candidateCount >= MAX_CHILDREN,
      timed_out: !!timedOut,
    },
  };
  cachedSet(cacheKey, data);
  return c.json(data);
});
