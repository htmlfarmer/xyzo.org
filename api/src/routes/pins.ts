import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { CommunitySubmissionSchema, ListPinsQuerySchema, MapPinsQuerySchema } from "../validate";
import { encodeCursor, decodeCursor } from "../cursors";
import { understandQuery, KNOWN_COMPANIES } from "../lib/query_understanding";
import { findCity, makeBbox, warmCityLookup } from "../lib/cityLookup";
import { isShortTerm, wordBoundaryPattern } from "../lib/wordmatch";
import { lookupPreindex, windowKeyFor, recordQueryUse } from "../lib/preindex";
import { RateLimiter, getClientIp } from "../ratelimit";
import { normalizeEmail } from "../normalize";
import { pinsCache, searchCache } from "../cache";
import { fastScan } from "../lib/quickmod";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";

export const pinsRoute = new Hono();

/**
 * The condition a set of text columns must satisfy to match a term.
 *
 * A SHORT term (≤ SHORT_TERM_MAX_LEN characters) must match a WHOLE
 * WORD: as a bare substring "ai" is inside "said", "rain", "air",
 * "detail"… — 499,582 of the corpus's titles are that noise, and a
 * reader who searched "ai" got a map of the weather. A LONGER term keeps
 * the substring match on purpose: "coronavirus" must still find
 * "coronaviruses", which a word boundary would miss.
 *
 * See api/src/lib/wordmatch.ts for the measurement and the reasoning.
 */
function termCondition(term: string, columns: string[]): any {
  const sql = getDb();
  const parts = columns.map((col) =>
    isShortTerm(term)
      ? sql`${sql(col)} ~* ${wordBoundaryPattern(term)}`
      : sql`${sql(col)} ILIKE ${"%" + term + "%"} ESCAPE '\\'`
  );
  return parts.reduce(
    (acc: any, cond: any, i: number) => (i === 0 ? sql`${cond}` : sql`${acc} OR ${cond}`),
    sql`FALSE`
  );
}

// THE WORD-SIMILARITY THRESHOLD for the fuzzy branch of the text search.
//
// The `%>` operator compares the query against a WORD in the title and
// reads its cut-off from the pg_trgm GUC — which is per CONNECTION.
// A server whose default had been changed would silently change every
// search, so the value is set explicitly (SET LOCAL) on the connection
// that runs the statement. Measured 2026-11-11: the old whole-string
// similarity branch made a search take 25,463 ms; this one takes 102 ms
// and finds MORE of the right articles (see singleTermMatch).
const WORD_SIMILARITY_THRESHOLD = 0.6;

const submitLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
// Burst guard: 3 submissions per 10 min per IP. The hourly cap alone let a
// script dump 10 pins in one second.
const submitBurstLimiter = new RateLimiter({ max: 3, windowMs: 10 * 60 * 1000 });
// Pin-spread is a much higher-frequency action (a user can drag many pins
// in one session). Use a separate, more permissive bucket.
const spreadLimiter = new RateLimiter({ max: 240, windowMs: 60 * 60 * 1000 });

// ── POST /api/pins — community submission (click-to-submit flow) ────────
//
// Two-stage moderation (owner spec 2026-09-28):
//   Stage 1 (here, synchronous, zero I/O beyond two small indexed queries):
//     quickmod.fastScan — multilingual spam/scam/gibberish gate + lite
//     topic classification whose summary is returned to the submitter.
//     Rejects never touch the pins table.
//   Stage 2 (deferred, best-effort): community_triage queue →
//     worker/pin_moderate.py — langdetect + word_freq analysis, robots.txt
//     + bounded fetch + frequency analysis of any submitted URL, ocean/land
//     coordinate check, then a circuit-breaker-gated LLM verdict. An LLM
//     rejection flips the pin to status='hidden'. Never blocks this route;
//     skipped entirely when the queue or AI box is busy.
pinsRoute.post("/pins", zValidator("json", CommunitySubmissionSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = submitLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }
  const burst = submitBurstLimiter.check(`burst:${ip}`);
  if (!burst.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: burst.retryAfterMs }, 429);
  }

  const data = c.req.valid("json");
  if (data.hp_company && data.hp_company.length > 0) {
    return c.json({ error: "spam_detected" }, 400);
  }

  // ── Stage 1: deterministic fast scan (spam/gibberish/topic) ──
  const scan = fastScan(data.title, data.story_note, data.canonical_url);
  if (!scan.pass) {
    return c.json({
      error: "rejected",
      reasons: scan.reasons,
      message: "Our automated check flagged this submission. If this is a mistake, rephrase and try again.",
      topic_summary: scan.topic_summary,
    }, 400);
  }

  // Coordinate sanity: (0,0) is the classic "no location" sentinel — a real
  // story at Null Island is a misclick. Ocean/land validation is deferred to
  // stage 2 (needs PostGIS polygon work we don't want in the hot path).
  if (data.lat === 0 && data.lng === 0) {
    return c.json({ error: "invalid_coordinates", message: "Click a real spot on the map." }, 400);
  }

  const sql = getDb();

  // ── Near-duplicate gate: exact title (7d) or trigram-similar title within
  // 250 km (7d). The community subset over 7 days is tiny, so this stays
  // cheap; pg_trgm is already installed for the pins title index.
  const normTitle = data.title.trim().toLowerCase();
  const dupRows = await sql<any[]>`
    SELECT id FROM pins
    WHERE source_type = 'community'
      AND created_at > now() - interval '7 days'
      AND (
        lower(btrim(title)) = ${normTitle}
        OR (similarity(title, ${normTitle}) > 0.55
            AND ST_DWithin(
              location,
              ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
              250000))
      )
    LIMIT 1
  `;
  if (dupRows.length > 0) {
    return c.json({
      error: "duplicate",
      message: "Somebody already submitted this story recently.",
      existing_pin_id: Number(dupRows[0].id),
    }, 409);
  }

  // ── DB-level per-IP velocity (defense in depth behind the in-memory
  // limiters — e.g. after an API restart clears the buckets).
  const submitterIp = ip !== "unknown" ? ip : null;
  if (submitterIp) {
    const [vel] = await sql<any[]>`
      SELECT COUNT(*)::int AS n
      FROM community_details cd
      JOIN pins p ON p.id = cd.pin_id
      WHERE cd.submitter_ip = ${submitterIp}::inet
        AND p.created_at > now() - interval '1 hour'
    `;
    if (Number(vel?.n ?? 0) >= 5) {
      return c.json({ error: "rate_limited", message: "Too many submissions from your connection this hour." }, 429);
    }
  }

  // ── Insert. Category: user pick wins; else the fast-scan guess when it's
  // a DB-valid pins.category; else 'other'.
  const detectedCategory = scan.topic.confidence >= 0.4 ? scan.topic.category : null;
  const category = data.category ?? detectedCategory ?? "other";

  const [pinRow] = await sql<{ id: number | bigint }[]>`
    INSERT INTO pins (
      source_type, title, location, category, published_at,
      location_precision, confidence_score
    )
    VALUES (
      'community', ${data.title},
      ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
      ${category},
      ${data.published_at ? new Date(data.published_at) : sql`now()`},
      'exact', 0.95
    )
    RETURNING id
  `;
  const pinId = Number(pinRow.id);
  await sql`
    INSERT INTO community_details
      (pin_id, submitter_name, submitter_email, canonical_url,
       story_note, submitter_ip, mod_fast, mod_status)
    VALUES
      (${pinId}, ${data.submitter_name?.trim() || "Anonymous"},
       ${data.submitter_email ? normalizeEmail(data.submitter_email) : null},
       ${data.canonical_url ?? null},
       ${data.story_note ?? null}, ${submitterIp}::inet,
       ${JSON.stringify({
         reasons: scan.reasons,
         signals: scan.signals,
         script: scan.script,
         topic: scan.topic,
         topic_summary: scan.topic_summary,
       })}::jsonb,
       'fast_published')
  `;

  // ── Stage 2: queue the deep check (fire-and-forget). Skipped silently on
  // any queue failure — the pin is already live under its stage-1 verdict.
  let deepCheck: "queued" | "skipped" = "skipped";
  try {
    await enqueueOrSpawn(
      "community_triage",
      { op: "moderate_pin", pin_id: pinId, user_category: data.category ?? null },
      { waitMs: 0, enqueuedBy: "api/pins/community-submit" },
    );
    deepCheck = "queued";
  } catch (e: any) {
    console.log(`[pins] community_triage enqueue skipped for pin ${pinId}: ${e?.message}`);
  }

  pinsCache.clear();
  searchCache.clear();
  return c.json({
    id: pinId,
    title: data.title,
    status: "published",
    detected: {
      category,
      confidence: Math.round(scan.topic.confidence * 100) / 100,
      lang_hint: scan.topic.lang_hint,
      script: scan.script,
      topic_summary: scan.topic_summary,
    },
    moderation: {
      stage: "fast_passed",
      deep_check: deepCheck,
      signals: scan.signals,
    },
  }, 201);
});

pinsRoute.get("/pins", zValidator("query", ListPinsQuerySchema), async (c) => {
  const query = c.req.query();
  const q = c.req.valid("query");
  // Use normalized q.q as cache key to treat "mental+health" and "mental health" identically
  //
  // AND THE TIME WINDOW, NOT THE TIMESTAMP. The frontend asks for "24h"
  // as `since=<now - 24h, snapped to the MINUTE>`, so a key built from
  // the raw `since` changed every minute — the RAM cache was written
  // and never read back, and every reader paid for a fresh scan. This
  // is the same trap the browser-side saved-searches store documents
  // ("which is exactly what happened when this was first built: the
  // saved copy was written and never read back"). The window is derived
  // from the AGE of `since` (windowKeyFor), so the key is stable for
  // the whole window.
  const cacheKey = q.q
    ? JSON.stringify({ ...query, q: q.q, since: q.since ? windowKeyFor(q.since) : query.since })
    : JSON.stringify(query);
  const isTextSearch = !!(q.q && q.q.trim());
  // A REFRESH REQUEST BYPASSES BOTH CACHES.
  //
  // The pre-index builder asks the API for the live answer to a query
  // that is ALREADY in the pre-index — without this it would fetch the
  // stored answer and copy it back, refreshing nothing and making the
  // stored answer older with every pass. The builder sends
  // `X-Search-Fresh: 1`; it costs the database a query, which is the
  // whole point of that job.
  // …and only for a LOCAL caller. The builder runs on this host
  // (http://localhost:3008), so the bypass is not reachable from the
  // public internet — otherwise any reader could opt out of the cache
  // and make the box run the query for them, every time.
  const xff = c.req.header("x-forwarded-for") || "";
  const isLocal = !xff || xff.split(",")[0].trim() === "127.0.0.1" || xff.split(",")[0].trim() === "::1";
  const fresh = c.req.header("x-search-fresh") === "1" && isLocal;
  // Text searches get a 5-minute shared cache; bbox-only get the short 20s one.
  const activeCache = isTextSearch ? searchCache : pinsCache;
  const cached = fresh ? null : activeCache.get(cacheKey);
  if (cached) {
    c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return c.json(cached);
  }
  const sql = getDb();
  const limit = q.limit ?? 500;
  // THE PRE-INDEX: the answer to a popular query, computed in the
  // background (worker/search_preindex.py) and stored with the age it
  // was built at.
  //
  // It is consulted ONLY for a plain text search — a bbox, a cursor, a
  // category, a tag or a source filter is a DIFFERENT answer and the
  // pre-index does not hold those. The RAM cache above comes first
  // because it is fresher (5 minutes against the pre-index's refresh
  // cycle).
  //
  // And every query is RECORDED, so the list of what to precompute is
  // the real demand rather than a guess.
  if (isTextSearch && !fresh && !q.bbox && !q.before && !q.category && !q.tag && !q.source_type && !q.min_confidence) {
    const textQuery = q.q ?? "";
    void recordQueryUse(sql, textQuery);
    const pre = await lookupPreindex(sql, {
      query: textQuery, window: windowKeyFor(q.since), tag: null, limit,
    });
    if (pre) {
      // THE READER IS TOLD HOW OLD THE ANSWER IS. A stored answer that
      // does not say its age is yesterday's news served as if it were
      // this morning's.
      c.header("X-Search-Source", "preindex");
      c.header("X-Search-Built-At", pre.built_at);
      c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
      return c.json({ ...pre.payload, built_at: pre.built_at, source: "preindex" });
    }
  }

  const pinsWhere: any[] = [sql`status = 'published'`];
  const articlesWhere: any[] = [
    sql`a.status IN ('extracted', 'discovered')`,
    sql`a.hidden_at IS NULL`,
  ];

  if (q.bbox) {
    const [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
    pinsWhere.push(sql`location::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)`);
    // Also include articles with extracted_lat/lng but no location_id (e.g., web-discovered articles
    // that were geolocated via country fallback but not assigned a news_locations row).
    // Without this, ~44K articles in 7 days (16% of the index) would be invisible to bbox filters.
    // FIX_NOTES 8.1: single-table predicate on maintained extracted_lat/lng —
    // indexable (idx_news_articles_native_coords) instead of a 1.1M-row seq scan
    // + post-join OR. Filter coords == rendered coords (spread-pin fix too).
    articlesWhere.push(sql`a.extracted_lat IS NOT NULL AND a.extracted_lat != 0 AND a.extracted_lng BETWEEN ${minLng} AND ${maxLng} AND a.extracted_lat BETWEEN ${minLat} AND ${maxLat}`);
  }
  if (q.source_type) {
    const types = Array.isArray(q.source_type) ? q.source_type : [q.source_type];
    pinsWhere.push(sql`source_type = ANY(${types})`);
    if (!types.includes("rss")) {
      articlesWhere.push(sql`FALSE`);
    }
  }
  if (q.category) {
    pinsWhere.push(sql`category = ${q.category}`);
    articlesWhere.push(sql`COALESCE(a.event_type, 'other') = ${q.category}`);
  }
  // Tag filter is dynamic (AI-extracted topic_tags). It only applies to the
  // news_articles side of the union — pins table has no topic_tags column,
  // so when a tag is active we just exclude the pins leg. See /api/tags/top
  // for the ranked tag vocabulary (533 distinct today).
  //
  // The AI extractor occasionally emits mixed casing ("Germany" vs
  // "germany"); the GIN @> operator is case-sensitive, so we use EXISTS
  // + LOWER() to match. validate.ts already lowercases the query string.
  if (q.tag) {
    articlesWhere.push(sql`EXISTS (SELECT 1 FROM unnest(a.topic_tags) tag WHERE LOWER(tag) = ${q.tag})`);
  }
  if (q.since) {
    // Qualify with `p.` — the pins leg now LEFT JOINs editorial_details,
    // which also has created_at, so unqualified references are ambiguous.
    pinsWhere.push(sql`COALESCE(p.published_at, p.created_at) >= ${new Date(q.since)}`);
    articlesWhere.push(sql`COALESCE(a.published_at, a.fetched_at) >= ${new Date(q.since)}`);
  }
  if (q.until) {
    // THE OTHER END OF THE WINDOW. `since` alone is "everything since",
    // which is not what a reader asking for "the news of 3 March" wants
    // — that is the DAY. The archive's time machine sets both ends, so
    // the map shows the news of the day it is showing the weather of.
    pinsWhere.push(sql`COALESCE(p.published_at, p.created_at) <= ${new Date(q.until)}`);
    articlesWhere.push(sql`COALESCE(a.published_at, a.fetched_at) <= ${new Date(q.until)}`);
  }
  if (q.q) {
    // ── Query Understanding ────────────────────────────────────────────
    // Run lightweight query parser to extract entities, domain, intent.
    // For known-entity searches (company, person), also search by location.
    // For complex/topic queries, add expansion terms.
    const understood = understandQuery(q.q);
    // Split query into individual words for AND matching - "insurance property"
    // should find articles containing BOTH words, not just the exact phrase.
    const queryWords = q.q.split(/\s+/).filter(w => w.length > 1);
    const searchTerms = [...queryWords, ...understood.expansion_terms];

    // The pins-table leg. The SAME short-term rule as the articles leg:
    // "ai" as a substring is inside "said", "rain", "detail"…
    pinsWhere.push(termCondition(q.q, ["p.title"]));

    // ── City-based geographic filter ───────────────────────────────────
    // "mental health in Las Vegas" → filter to Las Vegas metro area.
    // Uses in-memory city lookup (~200 major cities, no network overhead).
    let cityBbox: ReturnType<typeof makeBbox> | null = null;
    if (understood.explicit_location && !q.bbox) {
      warmCityLookup().catch(() => {});
      const city = findCity(understood.explicit_location);
      if (city) {
        const [minLng, minLat, maxLng, maxLat] = makeBbox(city.lat, city.lng, city.radiusKm);
        cityBbox = [minLng, minLat, maxLng, maxLat];
        pinsWhere.push(sql`location::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)`);
      }
    }

    // Build the text-match condition from the original query + expansions.
    // Multi-word queries use AND between individual words (require ALL terms present).
    // The full query phrase is matched first as an OR group, then expansion terms
    // are AND'd together so "nigerian tech" returns articles containing both words.
    // For discovered articles (web_discovered), we also match by discovery_query since
    // the article title may not contain all query terms (e.g., "Nigeria" ≠ "nigerian").
    // Tech acronyms (GPU, CPU, TPU, etc.) use word-boundary regex to avoid matching
    // substrings within city names (e.g., "gpu" inside "Nagpur", "Kharagpur").
    // Case-insensitive: handles both "gpu" and "GPU".
    const TECH_ACRONYM_RE = /^[a-zA-Z]{2,5}$/;
    const TECH_ACRONYMS = new Set(['gpu', 'cpu', 'tpu', 'npu', 'apu', 'fpga', 'asic', 'ssd', 'ram', 'hdd', 'pcie', 'usb', 'hdmi', 'displayport', 'thunderbolt', 'ethernet', 'wifi', 'bluetooth', 'zigbee', 'lcd', 'led', 'oled', 'dns', 'tcp', 'udp', 'http', 'https', 'ftp', 'ssh', 'vpn', 'lan', 'wan', 'man', 'gan', 'nan']);
    // THE FUZZY BRANCH IS WORD SIMILARITY, NOT WHOLE-STRING SIMILARITY.
    //
    // MEASURED 2026-11-11, on the live corpus (3,796,777 rows):
    //
    //   OLD: (title % t AND similarity(title, t) > 0.3) OR (summary …)
    //        → the trigram index returned 1,149,700 index tuples and
    //          584,762 heap rechecks to produce 1,584 rows
    //        → Execution Time 25,463 ms for the WHERE alone, and the
    //          whole statement read 397,043 buffers (3.1 GB) for 978 rows
    //
    //   NEW: title %> t OR summary %> t   (word similarity, threshold 0.6)
    //        → 1,005 rows, Execution Time 102 ms
    //
    // WHY THE OLD ONE WAS SO EXPENSIVE: `similarity(title, t)` compares the
    // WHOLE title string with the query, so a 5-letter word can only reach
    // 0.3 against a SHORT title — and the index scan for it starts from
    // the query's three trigrams, which match a sixth of the corpus. The
    // planner therefore fell back to a parallel seq scan (the whole
    // 3.8 M-row table, 759,156 rows discarded by the filter).
    //
    // WORD SIMILARITY IS ALSO THE BETTER RULE, not just the faster one:
    // it compares the query against a WORD in the title, so it finds
    // "Chinese companies bag contracts…" for "china" and "Japanese
    // President" for "japan" — which the substring rule misses
    // entirely ("chinese" does not contain "china"). Measured over the
    // real query mix, the switch LOSES 0–3 rows per query and GAINS
    // 33 (tokyo) … 10,961 (china, all of them about China). The rows it
    // loses are junk: for "tokyo" they were two articles titled
    // "Tok tok tok".
    //
    // The threshold is set EXPLICITLY on the connection that runs the
    // query (pg_trgm.word_similarity_threshold) — the operator reads it
    // from the GUC, and a server that changed it would silently change
    // every search.
    const singleTermMatch = (t: string) => {
      const lower = t.toLowerCase();
      if (TECH_ACRONYM_RE.test(t) && TECH_ACRONYMS.has(lower)) {
        // Word-boundary match for tech acronyms: \yGPU\y matches "GPU" as a whole word
        const pattern = `\\y${t.toUpperCase()}\\y`;
        return sql`(a.title ~* ${pattern} OR a.summary ~* ${pattern})`;
      }
      if (isShortTerm(t)) {
        // A short term must match a WHOLE WORD (see termCondition).
        const pattern = wordBoundaryPattern(t);
        return sql`(a.title ~* ${pattern} OR a.summary ~* ${pattern})`;
      }
      return sql`(a.title ILIKE ${"%" + t + "%"} ESCAPE '\\' OR a.summary ILIKE ${"%" + t + "%"} ESCAPE '\\' OR a.title %> ${t} OR a.summary %> ${t})`;
    };
    const discoveryQueryMatch = sql`(a.source_kind = 'web_discovered' AND a.discovery_query IS NOT NULL AND a.discovery_query ILIKE ${"%" + q.q + "%"} ESCAPE '\\')`;
    const termMatches = searchTerms.map(singleTermMatch);
    let textMatch: any;
    if (searchTerms.length === 1) {
      textMatch = sql`(${singleTermMatch(searchTerms[0])}) OR (${discoveryQueryMatch})`;
    } else {
      // The PHRASE is the whole query — and it needs the SAME short-term
      // rule as a term. It used to be a bare substring, and that was the
      // last hole: "ai" has expansion terms ("artificial intelligence",
      // "machine learning"…) so it took this branch, and the phrase
      // matched every title containing the two letters anywhere.
      const queryPhraseMatch = termCondition(q.q, ["a.title", "a.summary"]);
      const allTermsMatch = termMatches.reduce((acc: any, cond: any, i: number) => i === 0 ? sql`${cond}` : sql`${acc} AND ${cond}`, sql`TRUE`);
      textMatch = sql`(${queryPhraseMatch}) OR (${allTermsMatch})`;
    }

    // Entity-based location search: known companies carry implicit location context.
    // e.g. "NXP Semiconductors" → search Eindhoven area even without explicit city name.
    const locationTerms: string[] = [];
    for (const entity of understood.entities) {
      const known = KNOWN_COMPANIES.get(entity.toLowerCase());
      if (known?.location) {
        // Extract city name (before the comma) for extracted_location matching
        const city = known.location.split(",")[0].trim().toLowerCase();
        locationTerms.push(city);
      }
    }

    let articlesCondition: any = textMatch;
    if (locationTerms.length > 0) {
      // THE LOCATION BRANCH IS A LOCATION ID, NOT A TEXT MATCH ON THE
      // ARTICLE.
      //
      // `a.extracted_location ILIKE '%santa clara%'` cannot use an index —
      // extracted_location is a free-text field on 3.59 M rows — and an
      // un-indexable leg inside the OR forces the planner to seq-scan the
      // whole corpus. MEASURED 2026-11-11: the search for "nvidia" (a
      // KNOWN_COMPANIES entity, so this branch fires) took **155,931 ms**;
      // the same query without the branch takes 718 ms.
      //
      // The city is resolved to its news_locations row FIRST — 45 k rows
      // with a trigram index, so that lookup is a millisecond — and the
      // article side becomes `location_id = ANY(...)`, which the
      // location_id index serves. Measured on "santa clara": 35,291
      // articles match the text form and 35,231 match the id form — the
      // 58 that differ are articles whose location text was never turned
      // into a location row, and they are no longer found.
      const locIds: number[] = [];
      for (const city of locationTerms) {
        try {
          const rows = await sql<{ id: number }[]>`
            SELECT id FROM news_locations
            WHERE place_name ILIKE ${"%" + city + "%"} ESCAPE '\\'
            LIMIT 50`;
          for (const r of rows) locIds.push(Number(r.id));
        } catch { /* a failed lookup must not fail the search */ }
      }
      if (locIds.length > 0) {
        articlesCondition = sql`(${articlesCondition}) OR (a.location_id = ANY(${locIds}))`;
      }
    }
    if (cityBbox) {
      const [minLng, minLat, maxLng, maxLat] = cityBbox;
      const bboxCondition = sql`a.extracted_lat IS NOT NULL AND a.extracted_lat != 0 AND a.extracted_lng BETWEEN ${minLng} AND ${maxLng} AND a.extracted_lat BETWEEN ${minLat} AND ${maxLat}`;
      articlesCondition = sql`(${articlesCondition}) AND (${bboxCondition})`;
    }

    articlesWhere.push(articlesCondition);
    // Exclude articles with lat=0 (null island) from text search results.
    // These are unlocated articles that would appear off Africa's coast.
    articlesWhere.push(sql`(COALESCE(NULLIF(a.extracted_lat, 0), l.lat) IS NOT NULL AND COALESCE(NULLIF(a.extracted_lat, 0), l.lat) != 0)`);
  }
  if (q.before) {
    const cursor = decodeCursor(q.before);
    if (cursor) {
      pinsWhere.push(sql`(p.created_at, p.id) < (${cursor.timestamp}, ${cursor.id})`);
      articlesWhere.push(sql`(a.fetched_at, a.id) < (${cursor.timestamp}, ${cursor.id})`);
    }
  }
  if (q.min_confidence != null) {
    pinsWhere.push(sql`confidence_score >= ${q.min_confidence}`);
    articlesWhere.push(sql`COALESCE(a.location_confidence, 1.0) >= ${q.min_confidence}`);
  }

  const pinsWhereSql = pinsWhere.reduce((acc, w, i) => i === 0 ? sql`${w}` : sql`${acc} AND ${w}`, sql`TRUE`);
  const articlesWhereSql = articlesWhere.reduce((acc, w, i) => i === 0 ? sql`${w}` : sql`${acc} AND ${w}`, sql`TRUE`);

  // THE WORD-SIMILARITY THRESHOLD IS SET ON THE CONNECTION THAT RUNS
  // THE QUERY. The `%>` operator reads pg_trgm.word_similarity_threshold
  // from the GUC — and the GUC is per CONNECTION, so a plain `SET` on
  // the pool could land on a different connection than the query, and a
  // server whose default had been changed would silently change every
  // search. set_config(..., true) is SET LOCAL: it applies to the
  // transaction, on the connection that runs the statement, and it takes
  // its value as a PARAMETER (a `SET` cannot take one — `SET x = $1` is
  // a syntax error in Postgres).
  //
  // AND THE PLAN MUST BE CUSTOM. The statement TEXT is the same for
  // every search — only the parameter values differ — so after five
  // executions Postgres switches it to a GENERIC plan. For a text search
  // that is a disaster: the generic plan cannot know that the parameter
  // is a selective trigram, so it picks a parallel SEQ SCAN of the whole
  // 3.8 M-row table. MEASURED 2026-11-11: the same statement ran in
  // 718 ms under a custom plan and 37,679 ms under the generic one.
  // force_custom_plan makes every execution plan with the real values.
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(WORD_SIMILARITY_THRESHOLD)}, true)`;
    await tx`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`;
    return tx<any[]>`
    SELECT id, article_id, source_type, title, lat, lng, location_precision, confidence_score, status, category, published_at, created_at, updated_at, canonical_url, image_url, word_freq, source_count, event_id, is_top_story, auto_categorize_method, auto_categorize_confidence, source_kind, discovery_query
    FROM (
      SELECT p.id, NULL::bigint AS article_id, p.source_type, p.title,
             ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
             p.location_precision, p.confidence_score, p.status, p.category,
             p.published_at, p.created_at, p.updated_at,
             ed.canonical_url AS canonical_url,
             ed.image_url AS image_url,
             NULL::jsonb AS word_freq,
             1 AS source_count,
             NULL::bigint AS event_id,
             FALSE AS is_top_story,
             NULL::text AS auto_categorize_method,
             NULL::text AS auto_categorize_confidence,
             NULL::text AS source_kind,
             NULL::text AS discovery_query
      FROM pins p
      LEFT JOIN editorial_details ed ON ed.pin_id = p.id
      WHERE ${pinsWhereSql}
      UNION ALL
       SELECT a.id, a.id AS article_id, 'rss' AS source_type, a.title,
              a.lat, a.lng,
              a.location_precision,
              COALESCE(a.location_confidence, 1.0) AS confidence_score,
              'published' AS status,
              COALESCE(a.event_type, 'other') AS category,
              COALESCE(a.published_at, a.fetched_at) AS published_at,
              a.fetched_at AS created_at,
               a.fetched_at AS updated_at,
               a.url AS canonical_url,
               a.image_url,
               a.word_freq,
               COALESCE(ev.source_count, 1) AS source_count,
                ev.event_id,
                (COALESCE(ev.source_count, 1) >= 20) AS is_top_story,
                a.auto_categorize_method,
                a.auto_categorize_confidence,
                a.source_kind,
                a.discovery_query
          FROM (
             SELECT a.id, a.title, a.status, a.event_type, a.published_at, a.fetched_at, a.url, a.image_url, a.word_freq, a.location_confidence, a.auto_categorize_method, a.auto_categorize_confidence, a.source_kind, a.discovery_query,
                   a.extracted_lat, a.extracted_lng,
                   COALESCE(NULLIF(a.extracted_lat, 0), l.lat) AS lat,
                   COALESCE(NULLIF(a.extracted_lng, 0), l.lng) AS lng,
                  CASE WHEN a.extracted_lat IS NOT NULL AND a.extracted_lat != 0 THEN 'article' ELSE l.precision END AS location_precision,
                 nes.event_id AS article_event_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY (
                      CASE 
                        WHEN a.source_kind = 'web_discovered' THEN a.id
                        ELSE COALESCE(nes.event_id, a.location_id)
                      END
                    )
                    ORDER BY a.fetched_at DESC
                  ) AS event_rank
           FROM news_articles a
           LEFT JOIN news_locations l ON l.id = a.location_id
          LEFT JOIN news_event_sources nes ON nes.article_id = a.id
          WHERE ${articlesWhereSql}
        ) a
       LEFT JOIN LATERAL (
         SELECT nes.event_id, ne.source_count
         FROM news_event_sources nes
         JOIN news_events ne ON ne.id = nes.event_id
         WHERE nes.article_id = a.id
         ORDER BY ne.source_count DESC
         LIMIT 1
       ) ev ON TRUE
        WHERE a.event_rank = 1
      ) combined
      -- FIX_NOTES 4.16: the feedback bonus used to be a correlated scalar
      -- subquery RE-EXECUTED FOR EVERY ROW of the sorted set (against an
      -- empty nn_feedback table). Same semantics now: one tiny pre-
      -- aggregated join, computed once.
      LEFT JOIN (
        SELECT DISTINCT ON (feedback_target_id)
               feedback_target_id AS fb_target,
               CASE kind WHEN 'positive' THEN 300
                         WHEN 'negative' THEN -500
                         WHEN 'override' THEN 200
                         WHEN 'observed' THEN 100
                         ELSE 0 END AS fb_bonus
        FROM nn_feedback
        WHERE feedback_target_type = 'article' AND valid_until > NOW()
        ORDER BY feedback_target_id, created_at DESC
      ) fb ON fb.fb_target = combined.id
        ORDER BY
        ${q.q
          ? sql`COALESCE(ts_rank_cd(to_tsvector('english', title), plainto_tsquery('english', ${q.q})), 0) * 10000 + (CASE WHEN source_kind = 'web_discovered' AND discovery_query ILIKE ${"%" + q.q + "%"} THEN 2000 ELSE 0 END) +`
          : sql`0 +`}
        (CASE WHEN is_top_story THEN 100 ELSE 0 END) +
        LEAST((COALESCE(source_count, 1) * 5), 500) +
        (CASE
          WHEN auto_categorize_method IN ('nn_word_freq', 'ai_study') AND auto_categorize_confidence = 'high' THEN 2000
          WHEN auto_categorize_method IN ('nn_word_freq', 'ai_study') AND auto_categorize_confidence = 'medium' THEN 1500
          WHEN auto_categorize_method IN ('nn_word_freq', 'ai_study') AND auto_categorize_confidence = 'low' THEN 800
          WHEN auto_categorize_method IN ('nn_word_freq', 'ai_study') THEN 1000
          WHEN auto_categorize_confidence = 'high' THEN 300
          ELSE 0
         END) +
         GREATEST(0, 100 - EXTRACT(EPOCH FROM (NOW() - COALESCE(created_at, NOW()))) / 3600) +
         COALESCE(fb.fb_bonus, 0)
         DESC NULLS LAST,
        created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  });

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor(new Date(last.created_at), Number(last.id))
    : null;

  const payload = {
    pins: trimmed.map((r) => ({
      id: Number(r.id),
      // The map pin's `id` is a news_articles.id for RSS/editorial pins
      // and a pins.id for community submissions (the query UNIONs the
      // two). Sending it back as `article_id` lets /api/analytics/batch
      // resolve the source server-side — see Q3 in README.
      article_id: r.article_id ? Number(r.article_id) : null,
      source_type: r.source_type,
      title: r.title,
      location: { lat: Number(r.lat), lng: Number(r.lng) },
      location_precision: r.location_precision,
      confidence_score: r.confidence_score,
      status: r.status,
      category: r.category,
      canonical_url: r.canonical_url,
      image_url: r.image_url,
      word_freq: r.word_freq || null,
      source_count: Number(r.source_count) || 1,
      event_id: r.event_id ? Number(r.event_id) : null,
      is_top_story: Boolean(r.is_top_story),
      auto_categorize_method: r.auto_categorize_method || null,
      auto_categorize_confidence: r.auto_categorize_confidence || null,
      source_kind: r.source_kind || null,
      discovery_query: r.discovery_query || null,
      published_at: new Date(r.published_at).toISOString(),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
  };

  // The cache is byte-budgeted (api/src/cache.ts), so it needs to know
  // how big this answer is. Measured: a 1,000-pin answer is ~1.5 MB of
  // JSON, so the pins are counted rather than the body measured — the
  // body is about to be serialised anyway and a second JSON.stringify
  // of 1.5 MB is not free.
  const approxBytes = (payload.pins?.length || 0) * 1600 + 512;
  activeCache.set(cacheKey, payload, undefined, approxBytes);
  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  return c.json(payload);
});

// Map view — single-shot fetch of every visible pin in the current
// bbox so the canvas can render without paginating. Mirrors the /pins
// query semantics but with a higher limit cap (default 1500, max 6000)
// to support density settings. No cursor pagination (the canvas doesn't
// need next_cursor; it re-queries on every pan/zoom). Cache key is the
// raw query string.
pinsRoute.get("/pins/map", zValidator("query", MapPinsQuerySchema), async (c) => {
  const q = c.req.valid("query");
  const sql = getDb();
  const limit = q.limit ?? 1500;

  // Round bbox to 0.01° grid (~1km) so similar viewports share cache
  const roundBbox = (bbox: string | undefined): string | null => {
    if (!bbox) return null;
    const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
    const round = (n: number) => Math.round(n * 100) / 100;
    return `${round(minLng)},${round(minLat)},${round(maxLng)},${round(maxLat)}`;
  };

  const roundSince = (since: string | undefined): string | null => {
    if (!since) return null;
    const ms = new Date(since).getTime();
    if (isNaN(ms)) return null;
    const roundedMs = Math.floor(ms / 60000) * 60000;
    return new Date(roundedMs).toISOString();
  };

  // ── Validate BEFORE cache (FIX_NOTES 9 follow-up, 2026-09-26) ─────
  // The bbox→400 check used to run AFTER the pinsCache lookup, so a bad
  // bbox hitting a coincidentally-rounded cache key returned 200 (test
  // batch caught this). Malformed input must be rejected before anything
  // else on the hot map path.
  let isWorldView = false;
  let spanLng = 360;
  let spanLat = 180;
  let bboxValid = true;
  if (q.bbox) {
    let [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
    // FIX_NOTES 9: an invalid bbox used to silently escalate to the
    // WORST-possible query (full-world scan, no spatial filter, unbounded
    // window dedup) with no rate limit on this GET — a cheap DB DoS.
    // Leaflet worldCopyJump legitimately overflows longitude, so wrap
    // that; anything still invalid is a client error → 400.
    const wrapLng = (n: number) => (((n + 180) % 360) + 360) % 360 - 180;
    if (isFinite(minLng) && isFinite(maxLng)) {
      minLng = wrapLng(minLng);
      maxLng = wrapLng(maxLng);
    }
    if (!isFinite(minLng) || !isFinite(minLat) || !isFinite(maxLng) || !isFinite(maxLat) ||
        minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) {
      return c.json({ error: "invalid_bbox", message: "bbox must be 4 finite numbers: minLng,minLat,maxLng,maxLat" }, 400);
    } else {
      spanLng = Math.abs(maxLng - minLng);
      spanLat = Math.abs(maxLat - minLat);
      isWorldView = spanLng >= 350 && spanLat >= 160;
      // Continental-scale bboxes (>80° span) also skip the heavy spatial CTE
      // to avoid timeout on huge envelopes that the PostGIS index can't narrow.
      if (!isWorldView && (spanLng >= 80 || spanLat >= 80)) isWorldView = true;
    }
  } else {
    isWorldView = true;
  }

  const cacheKey = "map:" + JSON.stringify({
    bbox: roundBbox(q.bbox),
    since: roundSince(q.since),
    category: q.category,
    source_type: q.source_type,
    tag: q.tag,
    q: q.q,
    limit: q.limit,
    // FIX_NOTES 9: light and format change the response SHAPE — sharing
    // one cache entry between a full client and a light=1/ndjson client
    // intermittently served the wrong shape.
    light: q.light ?? false,
    format: c.req.query("format") ?? null,
  });
  const cached = pinsCache.get(cacheKey);
  if (cached) {
    c.header("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
    return c.json(cached);
  }

  // `maxPerLocation` used to be computed here and applied as
  // `loc_rank <= maxPerLocation` in the dedup CTE — but the outer
  // `event_rank = 1` filter subsumed it, so it never changed the output.
  // It is gone rather than honoured, because honouring it would change
  // how many pins a city view draws. See the comment in the query.

  // The guardrail that the frontend's checkServerGuardrails() already
  // looks for (body.guardrail.applied). It only fires for a WORLD view
  // with no time filter — the one request that would otherwise scan the
  // full 30-day article table. Measured cold on this box (2.99 M rows):
  // 30-day floor = 10-16 s, 7-day = 16 s, 3-day = 2 s. The 30 s
  // statement_timeout cancels the wide windows under load. The pins
  // shown at world zoom are the NEWEST per location and the ranking is
  // recency, so a 3-day floor is indistinguishable on screen — there
  // are ~170k articles in 3 days and the map draws 1,500 of them, all
  // from the newest hours.
  const guardrailInfo: {
    applied: boolean;
    reason?: string;
    effective_since?: string;
    estimated_server_resource_saved?: { ram_mb: number; cpu_time_ms: number };
  } = { applied: false };

  const buildWhere = (bboxStr?: string) => {
    const pW: any[] = [sql`status = 'published'`];
    const aW: any[] = [
      sql`a.status IN ('extracted', 'discovered')`,
      // FIX_NOTES 9: /pins respects hidden_at (the moderation signal) but
      // /pins/map — the DEFAULT map view — did not, so hidden articles
      // kept serving on the map.
      sql`a.hidden_at IS NULL`,
    ];
    if (bboxStr && !isWorldView && bboxValid) {
      const [minLng, minLat, maxLng, maxLat] = bboxStr.split(",").map(Number);
      pW.push(sql`location::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)`);
      // FIX_NOTES 8.1 — single-table indexable predicate (see /pins above).
      aW.push(sql`a.extracted_lat IS NOT NULL AND a.extracted_lat != 0 AND a.extracted_lng BETWEEN ${minLng} AND ${maxLng} AND a.extracted_lat BETWEEN ${minLat} AND ${maxLat}`);
    }
    if (q.source_type) {
      const types = Array.isArray(q.source_type) ? q.source_type : [q.source_type];
      pW.push(sql`source_type = ANY(${types})`);
      // FIX_NOTES 9: this pushed FALSE into the PINS leg (emptying it)
      // instead of the ARTICLES leg (which only ever contains rss-derived
      // rows) — inverted vs the /pins list handler, so ANY source_type
      // param returned all RSS articles and zero pins.
      if (!types.includes("rss")) aW.push(sql`FALSE`);
    }
    if (q.category) {
      pW.push(sql`category = ${q.category}`);
      aW.push(sql`COALESCE(a.event_type, 'other') = ${q.category}`);
    }
    if (q.tag) {
      aW.push(sql`EXISTS (SELECT 1 FROM unnest(a.topic_tags) tag WHERE LOWER(tag) = ${q.tag})`);
    }
    // A time floor keeps the query bounded. Without one ("All time" in
    // the UI) the map had to scan the whole 2.5 M-row news_articles table
    // and rank it with a window function: 10–16 s for a world view at a
    // 30-day floor, and the API's 30 s statement_timeout could still
    // cancel it under load.
    //
    // The pins shown at world zoom are the NEWEST per location and the
    // ranking is recency, so a shorter floor is indistinguishable on
    // screen. A 3-day floor is 2 s cold; 7 days is 16 s cold. The
    // 30-day floor is 10-16 s and the 30 s statement_timeout can still
    // cancel it under load.
    //
    // When the client sends NO `since` at all ("All time") and the view
    // is global, the floor is tightened to 3 days and reported as a
    // guardrail — the shape the frontend's checkServerGuardrails() has
    // always looked for (body.guardrail.applied). An explicit `since`
    // from the client is honoured as-is: the user asked for it.
    //
    // Measured cold on this box (2.99 M articles): 30-day floor = 10-16 s,
    // 7-day = 16 s, 3-day = 2 s. The 30 s statement_timeout cancels the
    // wide windows under load. A 3-day floor is indistinguishable at
    // world zoom: the ranking is recency and the map draws 1,500 pins,
    // all from the newest hours, out of ~170k articles in 3 days.
    let since: Date;
    if (q.since) {
      since = new Date(q.since);
    } else if (isWorldView) {
      since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      guardrailInfo.applied = true;
      guardrailInfo.reason = "global_unbounded_scan";
      guardrailInfo.effective_since = since.toISOString();
      guardrailInfo.estimated_server_resource_saved = { ram_mb: 185, cpu_time_ms: 1450 };
    } else {
      since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    }
    pW.push(sql`COALESCE(p.published_at, p.created_at) >= ${since}`);
    aW.push(sql`COALESCE(a.published_at, a.fetched_at) >= ${since}`);
    if (q.q) {
      // The same short-term rule as the text-search route: a short query
      // must match a WHOLE WORD (see termCondition).
      pW.push(termCondition(q.q, ["title"]));
      aW.push(termCondition(q.q, ["a.title", "a.summary"]));
    }
    // Converts an array of postgres.js Query objects into a SQL string with interleaved $1, $2, ...
    // placeholders and a flat args array. Each Query object contributes its args sequentially.
    // E.g. [sql`a=${1}`, sql`b=${2}`] + sql`c=${3}` -> sql`a=$1 AND b=$2 AND c=$3` with args=[1,2,3]
    const queryToSQL = (queries: any[]): { sql: string; args: any[] } => {
      let sql = '';
      const allArgs: any[] = [];
      for (let qi = 0; qi < queries.length; qi++) {
        const q = queries[qi];
        if (qi > 0) sql += ' AND ';
        if (q && q.strings && q.args) {
          for (let i = 0; i < q.strings.length; i++) {
            sql += q.strings[i];
            if (i < q.args.length) {
              allArgs.push(q.args[i]);
              sql += '$' + allArgs.length;
            }
          }
        }
      }
      return { sql, args: allArgs };
    };
    const pResult = queryToSQL(pW);
    const aResult = queryToSQL(aW);
    return {
      pSql: pResult.sql,
      aSql: aResult.sql,
      pArgs: pResult.args,
      aArgs: aResult.args,
    };
  };

  const fetchRows = async (pSql: any, aSql: any, pArgs: any[] = [], aArgs: any[] = [], light = false) => {
    const offset = pArgs.length;
    const aSqlRenumbered = aSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + offset}`);
    const allArgs = [...pArgs, ...aArgs];

    // Light mode (canvas renderer): skip expensive LATERAL joins and large
    // JSONB columns. The canvas only needs id/title/lat/lng/category.
    // This cuts world-view cold queries from ~20s to ~3-5s.
    const lateralJoins = light ? "" : `
        LEFT JOIN LATERAL (
          SELECT nes.event_id, ne.source_count
          FROM news_event_sources nes
          JOIN news_events ne ON ne.id = nes.event_id
          WHERE nes.article_id = a.id
          ORDER BY ne.source_count DESC
          LIMIT 1
        ) ev ON TRUE
        LEFT JOIN LATERAL (
          SELECT f.kind AS feedback_kind
          FROM nn_feedback f
          WHERE f.feedback_target_id = a.id
            AND f.feedback_target_type = 'article'
            AND f.valid_until > NOW()
          ORDER BY f.created_at DESC
          LIMIT 1
        ) fb ON TRUE`;

    const wordFreqCol = light ? "NULL::jsonb AS word_freq" : "a.word_freq";
    const sourceCountExpr = light ? "1" : "COALESCE(ev.source_count, 1)";
    const isTopStoryExpr = light ? "FALSE" : "(COALESCE(ev.source_count, 1) >= 20)";

    const query = `
      WITH ranked_articles AS (
        SELECT a.id, a.title, a.status, a.event_type, a.published_at, a.fetched_at, a.url, a.image_url, a.location_confidence, a.auto_categorize_method, a.word_freq,
               a.location_id, a.extracted_lat, a.extracted_lng, a.source_kind,
               COALESCE(NULLIF(a.extracted_lat, 0), l.lat) AS lat,
               COALESCE(NULLIF(a.extracted_lng, 0), l.lng) AS lng,
               CASE WHEN a.extracted_lat IS NOT NULL AND a.extracted_lat != 0 THEN 'article' ELSE l.precision END AS location_precision,
               COALESCE(l.place_name, a.extracted_location) AS place_name,
               COALESCE(l.country, s.country) AS source_country,
               nes.event_id AS article_event_id,
               ROW_NUMBER() OVER (PARTITION BY (
                 CASE
                   WHEN a.source_kind = 'web_discovered' THEN 'a' || a.id::text
                   WHEN nes.event_id IS NOT NULL THEN 'e' || nes.event_id::text
                   WHEN a.location_id IS NOT NULL THEN 'l' || a.location_id::text
                   ELSE 'c' || a.id::text
                 END) ORDER BY a.fetched_at DESC, a.id DESC) as loc_rank
        FROM news_articles a
        LEFT JOIN news_locations l ON l.id = a.location_id
        LEFT JOIN news_sources s ON s.id = a.source_id
        LEFT JOIN news_event_sources nes ON nes.article_id = a.id
        WHERE ${aSqlRenumbered}
      )   /* no trailing comma: ranked_articles is the ONLY CTE now */
      /* ONE window function, not two.
         This used to have a second ROW_NUMBER() in a deduped_articles CTE
         with the SAME partition expression and the SAME ordering as
         loc_rank, so event_rank was meant to equal loc_rank and the outer
         'WHERE event_rank = 1' was meant to be 'WHERE loc_rank = 1'.
         It was not the same: ROW_NUMBER() breaks ties arbitrarily, and two
         WindowAggs break them differently, so ~3.7 % of groups came back
         with a different (equally new) article each time the plan changed.
         One window function with an explicit a.id DESC tie-break is both
         deterministic and materially cheaper (10.5-15.8 s -> 7.2-9.8 s).
         maxPerLocation never had any effect: the outer filter subsumed it,
         so the map has always shown exactly ONE article per event/location. */
      SELECT id, article_id, source_type, title, lat, lng, location_precision, confidence_score, status, category, published_at, created_at, updated_at, canonical_url, image_url, word_freq, source_count, event_id, is_top_story, auto_categorize_method, place_name, source_country
      FROM (
        SELECT p.id, NULL::bigint AS article_id, p.source_type, p.title,
               ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
               p.location_precision, p.confidence_score, p.status, p.category,
               p.published_at, p.created_at, p.updated_at,
               ed.canonical_url AS canonical_url,
               ed.image_url AS image_url,
               NULL::jsonb AS word_freq,
               1 AS source_count,
               NULL::bigint AS event_id,
               FALSE AS is_top_story,
               NULL::text AS auto_categorize_method,
               NULL::text AS place_name,
               NULL::text AS source_country
        FROM pins p
        LEFT JOIN editorial_details ed ON ed.pin_id = p.id
        WHERE ${pSql}
        UNION ALL
        SELECT a.id, a.id AS article_id, 'rss' AS source_type, a.title,
               a.lat, a.lng,
               a.location_precision,
               COALESCE(a.location_confidence, 1.0) AS confidence_score,
               'published' AS status,
               COALESCE(a.event_type, 'other') AS category,
               COALESCE(a.published_at, a.fetched_at) AS published_at,
               a.fetched_at AS created_at,
               a.fetched_at AS updated_at,
               a.url AS canonical_url,
               a.image_url,
               ${wordFreqCol},
               ${sourceCountExpr} AS source_count,
               a.article_event_id AS event_id,
               ${isTopStoryExpr} AS is_top_story,
               a.auto_categorize_method,
               a.place_name,
               a.source_country
        FROM ranked_articles a
        ${lateralJoins}
        WHERE a.loc_rank = 1
      ) combined
      ORDER BY
        (CASE WHEN is_top_story THEN 500 ELSE 0 END) +
        (COALESCE(source_count, 1) * 50) +
        GREATEST(0, 100 - EXTRACT(EPOCH FROM (NOW() - COALESCE(created_at, NOW()))) / 3600)
        DESC NULLS LAST,
        created_at DESC, id DESC
      LIMIT ${limit}
    `;
    // work_mem for THIS query only.
    //
    // The world-view sort carries ~526 bytes per row: 170k rows over a
    // 3-day window is 89 MB, which spills past the connection default of
    // 32 MB and spent 2.7 s in page cache (measured on this box, load
    // 22). At 64 MB it sorts in memory and the query drops to 1.2 s —
    // 2.3x, which is the margin between a slow page and the 30 s
    // statement_timeout firing under load.
    //
    // SET LOCAL, inside a transaction: it reverts at COMMIT, so it can
    // never leak onto another query using the same pooled connection.
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL work_mem = '64MB'");
      return await tx.unsafe(query, allArgs) as any[];
    });
  };

  const { pSql, aSql, pArgs, aArgs } = buildWhere(q.bbox);
  const isLight = q.light === true || q.light === "true" || q.light === "1";
  let rows = await fetchRows(pSql, aSql, pArgs, aArgs, isLight);

  let widened = false;
  let actualBbox: string | null = q.bbox ?? null;

  if (q.bbox && !isWorldView && rows.length < 10) {
    const [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const baseHalfLng = Math.max(Math.abs(maxLng - minLng) / 2, 0.05);
    const baseHalfLat = Math.max(Math.abs(maxLat - minLat) / 2, 0.05);

    // Only auto-widen when user is zoomed in to a local/city viewport
    // (baseHalfLng < 1.5 deg, ~150km). At zoom <= 7 or continental scale,
    // widening would pull news from other continents that renders off-canvas.
    if (baseHalfLng < 1.5 && baseHalfLat < 1.5) {
      const maxHalfLng = 2.0; // ~150-200km cap
      const maxHalfLat = 1.8;

      const tiers = [
        { lng: Math.min(baseHalfLng * 1.5, maxHalfLng), lat: Math.min(baseHalfLat * 1.5, maxHalfLat) },
        { lng: Math.min(baseHalfLng * 2.5, maxHalfLng), lat: Math.min(baseHalfLat * 2.5, maxHalfLat) },
      ];

      for (const tier of tiers) {
        if (rows.length >= 8) break;
        const wMinLng = Number(Math.max(-180, centerLng - tier.lng).toFixed(4));
        const wMaxLng = Number(Math.min(180, centerLng + tier.lng).toFixed(4));
        const wMinLat = Number(Math.max(-85, centerLat - tier.lat).toFixed(4));
        const wMaxLat = Number(Math.min(85, centerLat + tier.lat).toFixed(4));

        const candidateBbox = `${wMinLng},${wMinLat},${wMaxLng},${wMaxLat}`;
        if (candidateBbox !== actualBbox) {
          const { pSql: wPSql, aSql: wASql, pArgs: wPArgs, aArgs: wAArgs } = buildWhere(candidateBbox);
          const widenedRows = await fetchRows(wPSql, wASql, wPArgs, wAArgs, isLight);
          if (widenedRows.length > rows.length) {
            rows = widenedRows;
            widened = true;
            actualBbox = candidateBbox;
          }
        }
      }
    }
  }

  const payload = {
    pins: rows.map((r) => {
      const base = {
        id: Number(r.id),
        // `id` is a news_articles.id for RSS/editorial pins and a
        // pins.id for community submissions (the query UNIONs the two).
        // The map fetches with light=1, so this MUST live in `base` and
        // not only in the full-response branch. /api/analytics/batch
        // resolves source_id from it server-side — README Q3.
        article_id: r.article_id ? Number(r.article_id) : null,
        location: { lat: Number(r.lat), lng: Number(r.lng) },
        category: r.category,
        is_top_story: Boolean(r.is_top_story),
        event_id: r.event_id ? Number(r.event_id) : null,
        source_country: r.source_country || null,
      };
      if (q.light) {
        return {
          ...base,
          source_type: r.source_type,
          title: r.title,
          place_name: r.place_name || null,
          canonical_url: r.canonical_url,
          image_url: r.image_url,
          published_at: new Date(r.published_at).toISOString(),
        };
      }
      return {
        ...base,
        source_type: r.source_type,
        title: r.title,
        location_precision: r.location_precision,
        confidence_score: r.confidence_score,
        status: r.status,
        place_name: r.place_name || null,
        canonical_url: r.canonical_url,
        image_url: r.image_url,
        word_freq: r.word_freq || null,
        source_count: Number(r.source_count) || 1,
        auto_categorize_method: r.auto_categorize_method || null,
        published_at: new Date(r.published_at).toISOString(),
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      };
    }),
    count: rows.length,
    widened,
    actual_bbox: actualBbox,
    generated_at: new Date().toISOString(),
    // The frontend's checkServerGuardrails() reads this — it has always
    // looked for body.guardrail.applied but the API never sent it, so
    // the warning card never fired even though the scan WAS capped.
    guardrail: guardrailInfo,
  };

  // The map cache has no byte budget (it holds 15-second entries), but
  // the size is passed anyway so the accounting is honest if one is
  // added later.
  pinsCache.set(cacheKey, payload, undefined, (payload.pins?.length || 0) * 1600 + 512);

  const format = c.req.query("format");
  const acceptHeader = c.req.header("accept") || "";
  const isNdjson = format === "ndjson" || acceptHeader.includes("application/x-ndjson");

  if (isNdjson) {
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-cache");
    const metaLine = JSON.stringify({
      meta: true,
      count: payload.count,
      widened: payload.widened,
      actual_bbox: payload.actual_bbox,
      generated_at: payload.generated_at,
    }) + "\n";

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(metaLine));
        let chunk = "";
        for (let i = 0; i < payload.pins.length; i++) {
          chunk += JSON.stringify(payload.pins[i]) + "\n";
          if ((i + 1) % 50 === 0) {
            controller.enqueue(encoder.encode(chunk));
            chunk = "";
          }
        }
        if (chunk.length > 0) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return c.body(stream);
  }

  c.header("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
  return c.json(payload);
});

// FIX_NOTES 3.7/10: /pins/stats runs a ~900 k-row full-scan COUNT (top-3
// query in pg_stat_statements) and the frontend used to call it after
// EVERY pan. One global 60 s memo + in-flight dedup makes it irrelevant.
let _pinStatsCache: { payload: any; at: number } | null = null;
let _pinStatsInflight: Promise<any> | null = null;
const PIN_STATS_TTL_MS = 60_000;

pinsRoute.get("/pins/stats", async (c) => {
  const now = Date.now();
  if (_pinStatsCache && now - _pinStatsCache.at < PIN_STATS_TTL_MS) {
    c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return c.json(_pinStatsCache.payload);
  }
  if (_pinStatsInflight) {
    const payload = await _pinStatsInflight;
    c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return c.json(payload);
  }
  const sql = getDb();
  _pinStatsInflight = (async () => {
  // Each window is its own range scan over
  // idx_articles_pub_loc (COALESCE(published_at, fetched_at) DESC)
  // WHERE status='extracted' AND location_id IS NOT NULL.
  //
  // The old form counted a UNION of pins + articles with five
  // COUNT(*) FILTERs over it — one full scan of the 2.5 M-row table per
  // call. That took 1.2 s idle and >8 s under load, and the
  // api_watchdog treats an 8 s timeout as a hung API: it restarted
  // xyzo-api every couple of minutes, and because the unit validates the
  // API in ExecStartPre, every restart was a ~40 s outage in which Caddy
  // answered 502 (the browser console showed /api/feed/live/stream and
  // /api/feed/links failing). Range scans cut the whole endpoint to
  // ~0.3 s.
  const counts = await sql<any[]>`
    SELECT
      (SELECT COUNT(*) FROM news_articles
        WHERE status = 'extracted' AND location_id IS NOT NULL
          AND COALESCE(published_at, fetched_at) >= now() - interval '24 hours')
      + (SELECT COUNT(*) FROM pins
        WHERE status = 'published'
          AND COALESCE(published_at, created_at) >= now() - interval '24 hours') AS count_24h,
      (SELECT COUNT(*) FROM news_articles
        WHERE status = 'extracted' AND location_id IS NOT NULL
          AND COALESCE(published_at, fetched_at) >= now() - interval '3 days')
      + (SELECT COUNT(*) FROM pins
        WHERE status = 'published'
          AND COALESCE(published_at, created_at) >= now() - interval '3 days') AS count_3d,
      (SELECT COUNT(*) FROM news_articles
        WHERE status = 'extracted' AND location_id IS NOT NULL
          AND COALESCE(published_at, fetched_at) >= now() - interval '7 days')
      + (SELECT COUNT(*) FROM pins
        WHERE status = 'published'
          AND COALESCE(published_at, created_at) >= now() - interval '7 days') AS count_7d,
      (SELECT COUNT(*) FROM news_articles
        WHERE status = 'extracted' AND location_id IS NOT NULL
          AND COALESCE(published_at, fetched_at) >= now() - interval '30 days')
      + (SELECT COUNT(*) FROM pins
        WHERE status = 'published'
          AND COALESCE(published_at, created_at) >= now() - interval '30 days') AS count_30d,
      (SELECT COUNT(*) FROM news_articles
        WHERE status = 'extracted' AND location_id IS NOT NULL
          AND COALESCE(published_at, fetched_at) >= now() - interval '365 days')
      + (SELECT COUNT(*) FROM pins
        WHERE status = 'published'
          AND COALESCE(published_at, created_at) >= now() - interval '365 days') AS count_365d,
      (SELECT COUNT(*) FROM news_articles
        WHERE status = 'extracted' AND location_id IS NOT NULL)
      + (SELECT COUNT(*) FROM pins WHERE status = 'published') AS count_all,
      GREATEST(
        (SELECT MAX(COALESCE(published_at, fetched_at)) FROM news_articles
          WHERE status = 'extracted' AND location_id IS NOT NULL),
        (SELECT MAX(COALESCE(published_at, created_at)) FROM pins
          WHERE status = 'published')
      ) AS latest_timestamp
  `;
  const row = counts[0] || {};
  const [sourcesCount] = await sql<any[]>`
    -- Tier 1.4: filter retired sources so the stats endpoint doesn't
    -- count soft-deleted ones as "active" (active=TRUE is a separate
    -- dimension from deleted_at; both must be cleared for retirement).
    SELECT COUNT(*) AS active_sources FROM news_sources WHERE active = TRUE AND deleted_at IS NULL
  `;

  const payload = {
    counts: {
      "24h": Number(row.count_24h || 0),
      "3d": Number(row.count_3d || 0),
      "7d": Number(row.count_7d || 0),
      "30d": Number(row.count_30d || 0),
      "365d": Number(row.count_365d || 0),
      "all": Number(row.count_all || 0),
    },
    latest_timestamp: row.latest_timestamp ? new Date(row.latest_timestamp).toISOString() : null,
    active_sources: Number(sourcesCount?.active_sources || 0),
    healthy: Number(row.count_24h || 0) > 0 || Number(row.count_7d || 0) > 0,
  };
  _pinStatsCache = { payload, at: Date.now() };
  return payload;
  })().finally(() => { _pinStatsInflight = null; });

  const payload = await _pinStatsInflight;
  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  return c.json(payload);
});

// ── POST /api/pins/spread-positions ─────────────────────────────────
// Persist user-driven pin-spread adjustments (drag-to-spread in the canvas
// renderer). Writes to pins.spread_position; the map endpoint prefers
// spread_position over the original location when present, so the user's
// edits persist across reloads. Caller: app.js:4617 saveSpreadPositions().
//
// CRITICAL: app.js:4625 swallows non-2xx responses and returns
// { saved: 0, errors: N }, so a 404 here means edits vanish silently.
// This route closes that silent-data-loss path (T-13).
import { z } from "zod";

const SpreadPositionSchema = z.object({
  positions: z.array(
    z.object({
      id: z.number().int().positive(),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
  ).min(1).max(500),
});

pinsRoute.post(
  "/pins/spread-positions",
  zValidator("json", SpreadPositionSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = spreadLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const { positions } = c.req.valid("json");
    const sql = getDb();

    // Bulk update in a single round-trip — postgres.js lets us pass a
    // JSON array parameter, and the UPDATE … FROM (VALUES) form is the
    // fastest way to apply N updates without an N+1. Cast explicitly to
    // geography(Point,4326) because pins.spread_position is a PostGIS
    // geography column, not text.
    const result = await sql<{ id: string }[]>`
      UPDATE pins AS p SET
        spread_position = ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,
        updated_at = now()
      FROM (
        SELECT * FROM jsonb_to_recordset(${sql.json(positions)}::jsonb)
          AS x(id bigint, lat double precision, lng double precision)
      ) AS v
      WHERE p.id = v.id
      RETURNING p.id
    `;

    const saved = result.length;
    const errors = positions.length - saved;
    return c.json({ saved, errors });
  },
);

// Composite popup payload — pin details + word frequency + linked
// sources + reports in one round-trip. The frontend used to issue
// 5-6 separate fetches to render the popup; this collapses it into
// one. Accepts either a pin id or an article id (news_articles row)
// because some map pins are article-backed with no separate pin row.
pinsRoute.get("/pins/:id/enriched", async (c) => {
  const raw = c.req.param("id");
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const sql = getDb();

  // Try pin first.
  const [pin] = await sql<any[]>`
    SELECT id, source_type, title,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
           location_precision, confidence_score, status, category,
           published_at, created_at, updated_at, image_url, word_freq
    FROM pins WHERE id = ${id} LIMIT 1
  `;
  if (pin) {
    const pinPayload = {
      id: Number(pin.id),
      source_type: pin.source_type,
      title: pin.title,
      location: { lat: pin.lat, lng: pin.lng },
      location_precision: pin.location_precision,
      confidence_score: pin.confidence_score,
      status: pin.status,
      category: pin.category,
      published_at: pin.published_at ? new Date(pin.published_at).toISOString() : null,
      created_at: pin.created_at ? new Date(pin.created_at).toISOString() : null,
      updated_at: pin.updated_at ? new Date(pin.updated_at).toISOString() : null,
      image_url: pin.image_url,
    };
    // Linked articles (same location + topic) for related-stories panel.
    const links = await sql<any[]>`
      SELECT a.id, a.title, a.url, a.published_at
      FROM news_articles a
      WHERE a.status = 'extracted'
        AND a.extracted_lat IS NOT NULL
        AND a.extracted_lng IS NOT NULL
        AND a.id != ${id}
        AND ABS(a.extracted_lat - ${pin.lat}) < 0.5
        AND ABS(a.extracted_lng - ${pin.lng}) < 0.5
      ORDER BY a.published_at DESC NULLS LAST
      LIMIT 10
    `;
    // Reports — flagged articles.
    const reports = await sql<any[]>`
      SELECT id, title, report_count
      FROM news_articles
      WHERE report_count >= 1
        AND ABS(COALESCE(extracted_lat, 0) - ${pin.lat}) < 1
        AND ABS(COALESCE(extracted_lng, 0) - ${pin.lng}) < 1
      ORDER BY report_count DESC
      LIMIT 5
    `;
    return c.json({
      pin: pinPayload,
      words: pin.word_freq ?? {},
      links: links.map((l) => ({
        id: Number(l.id),
        title: l.title,
        url: l.url,
        published_at: l.published_at ? new Date(l.published_at).toISOString() : null,
      })),
      reports: reports.map((r) => ({
        id: Number(r.id),
        title: r.title,
        report_count: Number(r.report_count),
      })),
    });
  }

  // Fall back to article — some map entries are article-backed.
  const [article] = await sql<any[]>`
    SELECT id, title, word_freq, extracted_lat, extracted_lng,
           published_at, image_url
    FROM news_articles WHERE id = ${id} LIMIT 1
  `;
  if (!article) return c.json({ error: "not_found" }, 404);

  const links = await sql<any[]>`
    SELECT a.id, a.title, a.url, a.published_at
    FROM news_articles a
    WHERE a.status = 'extracted'
      AND a.extracted_lat IS NOT NULL
      AND a.extracted_lng IS NOT NULL
      AND a.id != ${id}
      AND ABS(a.extracted_lat - ${article.extracted_lat ?? 0}) < 0.5
      AND ABS(a.extracted_lng - ${article.extracted_lng ?? 0}) < 0.5
    ORDER BY a.published_at DESC NULLS LAST
    LIMIT 10
  `;
  const reports = await sql<any[]>`
    SELECT id, title, report_count
    FROM news_articles
    WHERE report_count >= 1
      AND ABS(COALESCE(extracted_lat, 0) - ${article.extracted_lat ?? 0}) < 1
      AND ABS(COALESCE(extracted_lng, 0) - ${article.extracted_lng ?? 0}) < 1
    ORDER BY report_count DESC
    LIMIT 5
  `;
  return c.json({
    pin: {
      id: Number(article.id),
      source_type: "article",
      title: article.title,
      location: { lat: article.extracted_lat, lng: article.extracted_lng },
      image_url: article.image_url,
      published_at: article.published_at ? new Date(article.published_at).toISOString() : null,
    },
    words: article.word_freq ?? {},
    links: links.map((l) => ({
      id: Number(l.id),
      title: l.title,
      url: l.url,
      published_at: l.published_at ? new Date(l.published_at).toISOString() : null,
    })),
    reports: reports.map((r) => ({
      id: Number(r.id),
      title: r.title,
      report_count: Number(r.report_count),
    })),
  });
});

pinsRoute.get("/pins/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const sql = getDb();
  const pins = await sql<any[]>`
    SELECT id, source_type, title,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
           location_precision, confidence_score, status, category,
           published_at, created_at, updated_at
    FROM pins WHERE id = ${id} LIMIT 1
  `;
  if (pins.length > 0) {
    const p = pins[0];
    let detail: any = {};
    if (p.source_type === "editorial") {
      const rows = await sql<any[]>`
        SELECT body_markdown, image_url, author_name, canonical_url, created_at, updated_at
        FROM editorial_details WHERE pin_id = ${id} LIMIT 1
      `;
      const r = rows[0];
      if (r) {
        detail = {
          body_markdown: r.body_markdown,
          image_url: r.image_url,
          author_name: r.author_name,
          canonical_url: r.canonical_url,
          created_at: new Date(r.created_at).toISOString(),
          updated_at: new Date(r.updated_at).toISOString(),
        };
      }
    } else if (p.source_type === "community") {
      const rows = await sql<any[]>`
        SELECT submitter_name, canonical_url, story_note, mod_status, created_at, updated_at
        FROM community_details WHERE pin_id = ${id} LIMIT 1
      `;
      const r = rows[0];
      if (r) {
        detail = {
          submitter_name: r.submitter_name || "Anonymous",
          canonical_url: r.canonical_url,
          story_note: r.story_note ?? null,
          mod_status: r.mod_status ?? null,
          created_at: new Date(r.created_at).toISOString(),
          updated_at: new Date(r.updated_at).toISOString(),
        };
      }
    } else if (p.source_type === "rss") {
      const rows = await sql<any[]>`
        SELECT source_feed, source_url, original_published_at, summary, created_at, updated_at
        FROM rss_details WHERE pin_id = ${id} LIMIT 1
      `;
      const r = rows[0];
      if (r) {
        detail = {
          source_feed: r.source_feed,
          source_url: r.source_url,
          original_published_at: r.original_published_at ? new Date(r.original_published_at).toISOString() : null,
          summary: r.summary,
          created_at: new Date(r.created_at).toISOString(),
          updated_at: new Date(r.updated_at).toISOString(),
        };
      }
    }

    return c.json({
      id: Number(p.id),
      source_type: p.source_type,
      title: p.title,
      location: { lat: Number(p.lat), lng: Number(p.lng) },
      location_precision: p.location_precision,
      confidence_score: p.confidence_score,
      status: p.status,
      category: p.category,
      published_at: new Date(p.published_at).toISOString(),
      created_at: new Date(p.created_at).toISOString(),
      updated_at: new Date(p.updated_at).toISOString(),
      detail,
    });
  }

  // Fallback: check news_articles (LEFT JOIN allows articles without location_id)
  const articles = await sql<any[]>`
    SELECT a.id, a.title, a.summary, a.url, a.published_at, a.fetched_at,
           a.image_url, a.extracted_lat, a.extracted_lng,
           l.lat, l.lng, l.precision AS location_precision, s.name AS source_name
    FROM news_articles a
    LEFT JOIN news_locations l ON l.id = a.location_id
    LEFT JOIN news_sources s ON s.id = a.source_id
    WHERE a.id = ${id}
      AND s.deleted_at IS NULL
    LIMIT 1
  `;
  if (articles.length === 0) return c.json({ error: "not_found" }, 404);
  const a = articles[0];

  const lat = a.lat ?? a.extracted_lat;
  const lng = a.lng ?? a.extracted_lng;
  if (lat == null || lng == null) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json({
    id: Number(a.id),
    source_type: "rss",
    title: a.title,
    location: { lat: Number(lat), lng: Number(lng) },
    location_precision: a.location_precision ?? (a.extracted_lat != null ? "article" : null),
    confidence_score: 1.0,
    status: "published",
    category: "other",
    canonical_url: a.url,
    image_url: a.image_url ?? null,
    published_at: new Date(a.published_at || a.fetched_at).toISOString(),
    created_at: new Date(a.fetched_at).toISOString(),
    updated_at: new Date(a.fetched_at).toISOString(),
    detail: {
      source_feed: a.source_name,
      source_url: a.url,
      original_published_at: a.published_at ? new Date(a.published_at).toISOString() : null,
      summary: a.summary,
      created_at: new Date(a.fetched_at).toISOString(),
      updated_at: new Date(a.fetched_at).toISOString(),
    },
  });
});

// ── GET /api/pins/:id/words ─────────────────────────────────────────
// Returns word frequency for a pin/article. Used to show top words
// in the pin popup without re-downloading the article.
pinsRoute.get("/pins/:id/words", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const sql = getDb();

  // Try news_articles first (RSS sources)
  const articles = await sql<any[]>`
    SELECT word_freq FROM news_articles WHERE id = ${id} AND word_freq IS NOT NULL AND word_freq != '{}'::jsonb LIMIT 1
  `;
  if (articles.length > 0 && articles[0].word_freq) {
    return c.json({ id, words: articles[0].word_freq });
  }

  return c.json({ id, words: {} });
});
