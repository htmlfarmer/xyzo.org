// FUTURE_WORK:
//
// - news_events has 0 rows with status='active'. The hot-event query always falls
//   back to article backfill. Seed active events for proper hot-event testing.
//
// - distance_km is null in bbox tests because article backfill geometries aren't
//   within the test bbox. Either widen the test bbox or use articles with known
//   coordinates in the test bbox range.
//
// - pins.ts and cities.ts also use the `::geography` ST_Distance pattern that
//   was buggy here. Verify they don't have the same operator-precedence bug
//   (search: `ST_SetSRID.*4326\)::geography`).
//
// - The 5 bbox failures in feed-bbox.test.ts all return 200 now (SQL fixed) but
//   distance_km assertion fails because of missing active events + geom data.
//   Update test fixtures or relax the assertion.
//
// - When adding new ST_Distance expressions, ALWAYS wrap in parens before casting:
//   GOOD:  (ST_Distance(a, b))::geography
//   BAD:   ST_Distance(a, b)::geography   ← :: binds before () in PostgreSQL
//
// - Similarly, when dividing ST_Distance output, do it BEFORE the cast or on the
//   numeric result. Never: ST_Distance(...)::geography / 1000

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db";
import { lookup, publicIpFromRequest } from "../geoip";
import { SimpleLRUCache } from "../cache";
import { RateLimiter, getClientIp } from "../ratelimit";
import {
  addClient as addFeedClient,
  removeClient as removeFeedClient,
  broadcastSnapshot,
} from "../feed-broadcaster";

// `sql` here is the postgres.js template tag — same one getDb() uses
// internally. We need it to compose optional fragments (e.g. "skip
// when no bbox") into queries. The runtime helper getDb() returns a
// configured sql instance; `postgres.sql` is the bare template tag.
import postgres from "postgres";
const sql = postgres.sql;

export const feedRoute = new Hono();

// Rate limit concurrent SSE connections per IP. The endpoint holds a
// long-lived stream, so the limit is connection-count, not request-
// count — a single client making 10 polls/s and one holding an SSE
// connection for 10 minutes are very different things.
// 100 concurrent / IP / 60s window is generous for browsers (each tab
// opens one) but caps a misbehaving scraper.
const sseLimiter = new RateLimiter({ max: 100, windowMs: 60 * 1000 });

// Cache for /api/feed/live — keyed on rounded lat/lng so nearby users
// share the same cache entry. 20s TTL matches the frontend's 30s poll.
const liveFeedCache = new SimpleLRUCache<any>(50, 20_000);

// ── the graph term of the Hot & Latest score ────────────────────────────
//
// ONE definition. It used to be written out THREE times in this file
// (twice as `graphBoostExpr`, once inlined in the stream's 60-second
// resync query) and all three carried the same two defects — which is
// exactly how three copies get fixed twice and stay wrong once.
//
// 1. SCALE. `connectivity_score` is stored on a 0..10 scale (observed
//    max 10) and `same_event_avg_strength` as a raw magnitude (observed
//    max 3,357), but the expression multiplied them as if they were 0..1
//    fractions. The graph term reached ~4,600 while the recency term
//    peaks near 500, so the graph decided the ORDER BY outright.
// 2. NO TIME FACTOR AT ALL. A heavily-linked event scored the same at 28
//    days as at 28 hours. Together these put five 27-29 day-old events
//    permanently above fresh ones carrying 419/330/223 sources — the
//    reported symptom: "it says the same thing day after day".
//
// The decay is applied INSIDE this term as well as to source_count, so
// every part of the score ages. It references the alias `e`, which is
// what all three event queries name their `news_events` row.
//
// Clamp BOTH raw fields to a fraction: the graph is then a tiebreaker
// among comparable stories (max ≈ 5 × 2.45 ≈ 12) instead of a dictator
// over a recency term that peaks around 500.
//
// It is a FACTORY, not a value: the file's module-scope
// `const sql = postgres.sql` is `undefined` at runtime (verified — only
// `import { sql } from "postgres"` exports a tag), so it has always been
// dead code shadowed by each handler's own `const sql = getDb()`.
// Evaluating the fragment at module scope therefore threw
// "undefined is not a function" and killed every route registered below
// it, which is how /api/feed/live/stream started 404-ing. Each handler
// passes its own working tag; the EXPRESSION still exists exactly once.
const graphBoostExpr = (tag: any) => tag`(
  exp(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600)
  * LEAST(COALESCE(g.connectivity_score, 0) / 10.0, 1.0) * 5.0
  * POWER(1 + LEAST(COALESCE(g.same_event_links, 0), 500) / 100.0, 0.5)
  * LEAST(COALESCE(g.same_event_avg_strength, 0) / 1000.0, 1.0)
)`;

// ── the feed's time window ──────────────────────────────────────────────
//
// The panel's time control (24h / 3d / 7d / …) reached NEITHER this route
// nor its sibling: the client never sent it and the route never read it.
// Switching `time=3d` to `24h` therefore returned byte-identical feeds,
// and with no cutoff at all a 28-day-old story could sit at the top of
// "Hot & Latest" under `time=3d`.
//
// `hours` is what the client sends (its own timeFilter vocabulary);
// `since` accepts an ISO instant for a caller that already has one.
// Neither present means NO cutoff, so existing callers keep their
// behaviour.
//
// MODULE SCOPE, deliberately. It was first written INSIDE the
// /feed/live handler, where it was visible to that route's own call and
// to nothing else — so /feed/live/stream's copy of the same call threw
// "parseSince is not defined" and every SSE client's initial snapshot
// failed with `snapshot_failed` (2026-11-01). A nested function parses
// fine, so validate-api.sh could never catch it; only a live request
// could. Two routes need it, so it lives at module scope.
function parseSince(c: { req: { query: (k: string) => string | undefined } }): Date | null {
  const hoursRaw = c.req.query("hours");
  if (hoursRaw != null && hoursRaw !== "") {
    const hours = Number(hoursRaw);
    if (Number.isFinite(hours) && hours > 0) {
      // clamp to a year so a garbage value cannot ask for everything
      return new Date(Date.now() - Math.min(hours, 366 * 24) * 3_600_000);
    }
  }
  const iso = c.req.query("since");
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

// ── GET /api/feed/live ───────────────────────────────────────────────
// Live news feed for the side panel. Returns two ranked lists:
//   - "hot": trending events in the visible viewport (by source_count × recency × proximity)
//   - "near": events close to the user's location (geoip or browser)
//
// The frontend calls this every 30s and renders whichever tab is active.
// Query params:
//   lat, lng      — viewport center (used for proximity ranking of "hot")
//   bbox          — visible map bounds as "sw_lng,sw_lat,ne_lng,ne_lat"
//   zoom          — map zoom level (affects proximity boost strength)
//   radius_km     — radius for "near" tab (default 500)
//   limit         — max items per list (default 30)
feedRoute.get("/feed/live", async (c) => {
  const sql = getDb();
  // FIX_NOTES 4.17: Number("abc") = NaN propagates through Math.min/max
  // untouched and 500s on the bound parameter — coerce to defaults.
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const limit = Math.min(Math.max(num(c.req.query("limit"), 30), 1), 100);
  const radiusKm = Math.min(Math.max(num(c.req.query("radius_km"), 500), 1), 2000);
  const zoom = Math.min(Math.max(num(c.req.query("zoom"), 8), 3), 18);

  // Parse optional viewport bbox: "sw_lng,sw_lat,ne_lng,ne_lat"
  let bbox: [number, number, number, number] | null = null;
  const bboxRaw = c.req.query("bbox");
  if (bboxRaw) {
    const parts = bboxRaw.split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      bbox = [Math.min(parts[0], parts[2]), Math.min(parts[1], parts[3]),
              Math.max(parts[0], parts[2]), Math.max(parts[1], parts[3])];
    }
  }

  // Resolve user location: explicit lat/lng params > geoip
  let lat = Number(c.req.query("lat"));
  let lng = Number(c.req.query("lng"));
  let home: { lat: number; lng: number; city: string | null; country: string | null; source: string } | null = null;

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    home = { lat, lng, city: null, country: null, source: "param" };
  } else {
    // Try geoip. publicIpFromRequest scans the XFF chain for the first
    // public address so a LAN/CGNAT leftmost entry doesn't kill "near".
    const geo = await lookup(publicIpFromRequest(c.req.raw));
    if (geo && geo.lat != null && geo.lng != null) {
      lat = geo.lat;
      lng = geo.lng;
      home = { lat, lng, city: geo.city, country: geo.country, source: geo.source };
    }
  }

  // Check cache — key on rounded location + bbox so nearby users share
  const bboxKey = bbox ? `${bbox[0].toFixed(1)},${bbox[1].toFixed(1)},${bbox[2].toFixed(1)},${bbox[3].toFixed(1)}` : "global";
  // The window MUST be part of the key: without it a 3d request can be
  // served a 24h response and the time control looks broken even after
  // the queries honour it.
  const since = parseSince(c);
  const eventCut = since ? sql`AND e.first_reported_at >= ${since}` : sql``;
  const articleCut = since ? sql`AND COALESCE(a.published_at, a.fetched_at) >= ${since}` : sql``;
  const sinceKey = since ? Math.floor(since.getTime() / 60_000) : "any";
  const cacheKey = home
    ? `${Math.round(lat * 10)}:${Math.round(lng * 10)}:${limit}:${radiusKm}:${bboxKey}:${sinceKey}`
    : `global:${limit}:${bboxKey}:${sinceKey}`;
  const cached = liveFeedCache.get(cacheKey);
  if (cached) {
    return c.json(cached);
  }

  // Hot & Latest: trending events ranked by source_count × recency × proximity
  // to the viewport center. When bbox is provided, nearby events get a ranking
  // boost so "hot" reflects what's happening in the visible map area.
  const centerGeom = bbox
    ? `ST_Centroid(ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326))`
    : null;
  const distExpr = centerGeom
    ? `ST_Distance(l.geom, ${centerGeom}::geography) / 1000`
    : null;
  // Inverse-distance proximity: nearby events get massively boosted so geography
  //   drives ranking.  Score = hot_score / (1 + distance_km/500)^2
  //   → 1× at 0 km, 0.5× at 500 km, 0.2× at 1500 km, 0.1× at 2500 km, ~0.01× at 8500 km
  //   This ensures a local West-Africa event (src=5) beats a global Seoul (src=400)
  //   by a factor of ~17× after distance penalty.
  // Zoom-adaptive proximity: at low zoom (6) a wider radius is "local"; at
  // high zoom (11+) only very close events should dominate.  Formula:
  //   distance_denom = 200 * 2^(8 - zoom)
  //   → zoom 6: 800 km denom (regional view)
  //   → zoom 8: 200 km denom (city view)
  //   → zoom 11: 25 km denom (street view)
  //   → zoom 14: 3 km denom (block view)
  const zoomFactor = Math.pow(2, 8 - zoom);
  const distanceDenom = 200 * zoomFactor;
  const proximityBoost = distExpr
    ? `POWER(1 + LEAST(${distExpr}, 10000) / ${distanceDenom}, -3)`
    : "1";
  const distCol = distExpr
    ? sql`, ${distExpr} AS distance_km`
    : sql`, NULL::bigint AS distance_km`;

  // Graph-enhanced hot ranking: source_count × recency × proximity
  // + connectivity boost from news_story_links interconnection
  // Graph boost = connectivity_score × same_event_avg_strength × same_event_links_factor
  //   → rewards events that are well-connected AND have strong same-event consensus
  //   → a singleton with 50 sources but no links scores lower than a connected cluster
  // graphBoostExpr now lives at module scope — see the comment there for
  // why it stopped being a local (three copies, two defects, fixed twice).

  let hot = await sql<any[]>`
    SELECT e.id, e.event_type, e.headline, e.summary,
           e.first_reported_at, e.source_count, e.avg_confidence,
           e.relevance_days, e.expires_at,
           l.lat, l.lng, l.place_name, l.country, l.precision,
           first_source.url AS event_url,
           first_source.image_url AS event_image,
           g.total_links AS graph_total_links,
           g.connectivity_score AS graph_connectivity,
           g.same_event_links AS graph_same_event_links,
           g.same_event_avg_strength AS graph_consensus,
           g.link_type_count AS graph_link_types,
           g.avg_link_strength AS graph_avg_strength
           ${distCol}
     FROM news_events e
    LEFT JOIN news_locations l ON l.id = e.primary_location_id
    LEFT JOIN news_event_graph_features g ON g.event_id = e.id
    LEFT JOIN LATERAL (
      SELECT a.url, a.image_url FROM news_event_sources es
      JOIN news_articles a ON a.id = es.article_id
      WHERE es.event_id = e.id
      ORDER BY (NULLIF(a.image_url, '') IS NULL), a.published_at DESC NULLS LAST
      LIMIT 1
    ) first_source ON true
    WHERE e.status = 'active'
      AND (e.expires_at IS NULL OR e.expires_at > now()) ${eventCut}
      ${bbox ? sql`AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : sql``}
    ORDER BY
      (
        (e.source_count * exp(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600))
        * ${sql.unsafe(proximityBoost)}
        + ${graphBoostExpr(sql)}
      ) DESC,
      e.first_reported_at DESC
    LIMIT ${limit}
  `;

  // If event clusters are under limit, backfill with fresh high-confidence articles
  if (hot.length < limit) {
    const recentArticles = await sql<any[]>`
      SELECT a.id, COALESCE(a.event_type, 'other') AS event_type, a.title AS headline, a.summary,
             a.published_at AS first_reported_at, 1 AS source_count, 0.9 AS avg_confidence,
             7 AS relevance_days, NULL AS expires_at,
             l.lat, l.lng, l.place_name, l.country, l.precision,
             'article'::text AS _kind, a.url AS _url, s.name AS _source_name, a.image_url AS _image
             ${distCol}
      FROM news_articles a
      JOIN news_locations l ON l.id = a.location_id
      LEFT JOIN news_sources s ON s.id = a.source_id
      WHERE a.status IN ('extracted', 'processed') ${articleCut}
        AND l.geom IS NOT NULL
        AND a.id NOT IN (SELECT article_id FROM news_event_sources)
        ${bbox ? sql`AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : sql``}
      ORDER BY
        ((1.0 * exp(-0.1 * EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, a.fetched_at))) / 3600)) * ${sql.unsafe(proximityBoost)}) DESC,
        a.published_at DESC NULLS LAST
      LIMIT ${limit - hot.length}
    `;
    hot = [...hot, ...recentArticles];
  }

  // Near: events within radius_km of the user, ranked by combined distance × recency score
  // Score = exp(-distance_km/200) × exp(-0.05 × hours_old)
  // → 1.0 at 0km/0h, 0.37 at 200km or 20h, 0.14 at 400km or 40h
  let near: any[] = [];
  if (home) {
    near = await sql<any[]>`
      SELECT e.id, e.event_type, e.headline, e.summary,
             e.first_reported_at, e.source_count, e.avg_confidence,
             e.relevance_days, e.expires_at,
             l.lat, l.lng, l.place_name, l.country, l.precision,
              first_source.url AS event_url,
              first_source.image_url AS event_image,
              ST_Distance(l.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) / 1000 AS distance_km,
             (EXP(-ST_Distance(l.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) / 1000 / 200)
              * EXP(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600)) AS near_score
      FROM news_events e
      LEFT JOIN news_locations l ON l.id = e.primary_location_id
      LEFT JOIN LATERAL (
        SELECT a.url, a.image_url FROM news_event_sources es
        JOIN news_articles a ON a.id = es.article_id
        WHERE es.event_id = e.id
        ORDER BY (NULLIF(a.image_url, '') IS NULL), a.published_at DESC NULLS LAST
        LIMIT 1
      ) first_source ON true
      WHERE e.status = 'active'
        AND (e.expires_at IS NULL OR e.expires_at > now()) ${eventCut}
        AND l.geom IS NOT NULL
        AND ST_DWithin(
          l.geom,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${radiusKm * 1000}
        )
      ORDER BY near_score DESC, e.first_reported_at DESC
      LIMIT ${limit}
    `;
  }

  const mapItem = (r: any) => ({
    id: Number(r.id),
    type: r._kind === "article" ? "article" : "event",
    event_type: r.event_type,
    headline: r.headline,
    summary: r.summary,
    first_reported_at: new Date(r.first_reported_at).toISOString(),
    source_count: Number(r.source_count),
    avg_confidence: Number(r.avg_confidence),
    relevance_days: Number(r.relevance_days),
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    location: r.lat != null && r.lng != null
      ? { lat: Number(r.lat), lng: Number(r.lng), place_name: r.place_name, country: r.country, precision: r.precision }
      : null,
    distance_km: r.distance_km != null ? Math.round(Number(r.distance_km)) : null,
    url: r._url || r.event_url || null,
    image_url: r._image || r.event_image || null,
    source_name: r._source_name || null,
    // Graph interconnection signals (from news_event_graph_features)
    graph: r.graph_total_links != null ? {
      total_links: Number(r.graph_total_links),
      connectivity_score: Math.round(Number(r.graph_connectivity) * 100) / 100,
      same_event_links: Number(r.graph_same_event_links),
      consensus: Math.round(Number(r.graph_consensus) * 100) / 100,
      link_types: Number(r.graph_link_types),
      avg_strength: Math.round(Number(r.graph_avg_strength) * 100) / 100,
    } : null,
  });

  const payload = {
    home,
    hot: hot.map(mapItem),
    near: near.map(mapItem),
    radius_km: radiusKm,
    generated_at: new Date().toISOString(),
  };
  liveFeedCache.set(cacheKey, payload);
  return c.json(payload);
});

// ── GET /api/feed/live/stream ──────────────────────────────────────────
//
// Server-Sent Events version of /api/feed/live. Audit 4 found that
// clients were polling the JSON endpoint every 10–30s, wasting ~80% of
// requests and adding 0–30s of latency to when a new article shows up
// on the user's screen.
//
// This handler subscribes the client to the in-process feed broadcaster
// (see feed-broadcaster.ts). On connect we send the current snapshot
// immediately so the first byte a client sees is their own copy — not
// a stale cached version. A 30s heartbeat keeps proxies from killing
// the connection, and a 60s safety-net resync catches any broadcasts
// that the worker might have lost (worker crash mid-POST, server
// restart mid-broadcast, etc.).
//
// The legacy /api/feed/live JSON endpoint above remains as a fallback
// for curl/scripts/clients that can't or won't open EventSource.
feedRoute.get("/feed/live/stream", (c) => {
  // Connection-level rate limit. Per-message rate limiting makes no
  // sense for SSE — there's exactly one message from the client (the
  // initial GET) and zero from there on.
  const ip = getClientIp(c.req.raw);
  const gate = sseLimiter.check(ip);
  if (!gate.allowed) {
    c.header("Retry-After", String(Math.ceil(gate.retryAfterMs / 1000)));
    return c.json({ error: "rate_limited" }, 429);
  }

  return streamSSE(c, async (stream) => {
    addFeedClient(stream);

    // FIX_NOTES 4.15: cleanup is armed BEFORE any await. The old code
    // registered onAbort only after the slow initial snapshot — a client
    // disconnecting during that query left heartbeat + resync intervals
    // running forever (one zombie DB query per minute per lost client).
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    let settleAbort!: () => void;
    const aborted = new Promise<void>((res) => { settleAbort = res; });
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (snapshotTimer) clearInterval(snapshotTimer);
      removeFeedClient(stream);
      settleAbort();
    };
    stream.onAbort(cleanup);

    // Heartbeat: keeps proxies and load balancers from killing the
    // connection. 30s matches the typical idle timeout on cloud LBs.
    heartbeat = setInterval(() => {
      stream
        .writeSSE({ event: "heartbeat", data: String(Date.now()) })
        .catch(() => {
          // Client disconnected mid-write — cleanup() handles it now.
        });
    }, 30_000);

    // Safety net: re-send the snapshot every 60s. Catches missed
    // broadcasts (worker crash mid-POST, server restarted, etc.) and
    // also gives new clients a fresh view if they connect right after
    // a burst of articles.

    // Initial snapshot — same query as the JSON handler but we send
    // it inline as the first SSE event so the client has data on
    // connect without waiting for the next broadcast.
    try {
      const sql = getDb();
      // We reuse the same shape as /feed/live so the client can treat
      // snapshot and the legacy JSON body identically. The "hot"/"near"
      // computation depends on the user's home — we accept the same
      // lat/lng/radius_km params as the JSON endpoint.
      const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30), 1), 100);
      const radiusKm = Math.min(Math.max(Number(c.req.query("radius_km") ?? 500), 1), 2000);
      const zoom = Math.min(Math.max(Number(c.req.query("zoom") ?? 8), 3), 18);

      // Parse optional viewport bbox: "sw_lng,sw_lat,ne_lng,ne_lat"
      let bbox: [number, number, number, number] | null = null;
      const bboxRaw = c.req.query("bbox");
      if (bboxRaw) {
        const parts = bboxRaw.split(",").map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          bbox = [Math.min(parts[0], parts[2]), Math.min(parts[1], parts[3]),
                  Math.max(parts[0], parts[2]), Math.max(parts[1], parts[3])];
        }
      }

      let lat = Number(c.req.query("lat"));
      let lng = Number(c.req.query("lng"));
      let home: { lat: number; lng: number; city: string | null; country: string | null; source: string } | null = null;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        home = { lat, lng, city: null, country: null, source: "param" };
      } else {
        const geo = await lookup(publicIpFromRequest(c.req.raw));
        if (geo && geo.lat != null && geo.lng != null) {
          lat = geo.lat;
          lng = geo.lng;
          home = { lat, lng, city: geo.city, country: geo.country, source: geo.source };
        }
      }

      // Proximity boost for viewport-aware ranking
      const centerGeom = bbox
        ? `ST_Centroid(ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326))`
        : null;
      const since = parseSince(c);
      const eventCut = since ? sql`AND e.first_reported_at >= ${since}` : sql``;
      const articleCut = since ? sql`AND COALESCE(a.published_at, a.fetched_at) >= ${since}` : sql``;
      const distExpr = centerGeom
        ? `ST_Distance(l.geom, ${centerGeom}::geography) / 1000`
        : null;
      const zoomFactor = Math.pow(2, 8 - zoom);
      const distanceDenom = 200 * zoomFactor;
      const proximityBoost = distExpr
        ? `POWER(1 + LEAST(${distExpr}, 10000) / ${distanceDenom}, -3)`
        : "1";
      const distCol = distExpr
        ? sql`, ${sql.unsafe(distExpr)} AS distance_km`
        : sql`, NULL::bigint AS distance_km`;

      // graphBoostExpr is now the module-scope definition — this local
      // copy was the THIRD spelling of the same expression, inlined in
      // the stream's 60-second resync, and the only place a fix applied
      // to the other two would not have reached.

      let hot = await sql<any[]>`
        SELECT e.id, e.event_type, e.headline, e.summary,
               e.first_reported_at, e.source_count, e.avg_confidence,
               e.relevance_days, e.expires_at,
               l.lat, l.lng, l.place_name, l.country, l.precision,
               first_source.url AS event_url, first_source.image_url AS event_image,
               NULL::text AS _kind, NULL::text AS _url, NULL::text AS _source_name,
               g.total_links AS graph_total_links,
               g.connectivity_score AS graph_connectivity,
               g.same_event_links AS graph_same_event_links,
               g.same_event_avg_strength AS graph_consensus,
               g.link_type_count AS graph_link_types,
               g.avg_link_strength AS graph_avg_strength
               ${distCol}
        FROM news_events e
       LEFT JOIN news_locations l ON l.id = e.primary_location_id
       LEFT JOIN news_event_graph_features g ON g.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT a.url, a.image_url FROM news_event_sources es
         JOIN news_articles a ON a.id = es.article_id
         WHERE es.event_id = e.id
         ORDER BY (NULLIF(a.image_url, '') IS NULL), a.published_at DESC NULLS LAST
         LIMIT 1
       ) first_source ON true
        WHERE e.status = 'active'
          AND (e.expires_at IS NULL OR e.expires_at > now()) ${eventCut}
          ${bbox ? sql`AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : sql``}
        ORDER BY
          (
            (e.source_count * exp(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600))
            * ${sql.unsafe(proximityBoost)}
            + ${graphBoostExpr(sql)}
          ) DESC,
          e.first_reported_at DESC
        LIMIT ${limit}
      `;

      if (hot.length < limit) {
        const recentArticles = await sql<any[]>`
          SELECT a.id, COALESCE(a.event_type, 'other') AS event_type,
                 a.title AS headline, a.summary,
                 a.published_at AS first_reported_at, 1 AS source_count,
                 0.9 AS avg_confidence,
                 7 AS relevance_days, NULL::timestamptz AS expires_at,
                 l.lat, l.lng, l.place_name, l.country, l.precision,
                 'article'::text AS _kind, a.url AS _url, s.name AS _source_name, a.image_url AS _image
                 ${distCol}
          FROM news_articles a
          JOIN news_locations l ON l.id = a.location_id
          LEFT JOIN news_sources s ON s.id = a.source_id
          WHERE a.status IN ('extracted', 'processed') ${articleCut}
            AND l.geom IS NOT NULL
            AND a.id NOT IN (SELECT article_id FROM news_event_sources)
            ${bbox ? sql`AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : sql``}
          ORDER BY
            ((1.0 * exp(-0.1 * EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, a.fetched_at))) / 3600)) * ${sql.unsafe(proximityBoost)}) DESC,
            a.published_at DESC NULLS LAST
          LIMIT ${limit - hot.length}
        `;
        hot = [...hot, ...recentArticles];
      }

      let near: any[] = [];
      if (home) {
        near = await sql<any[]>`
          SELECT e.id, e.event_type, e.headline, e.summary,
                 e.first_reported_at, e.source_count, e.avg_confidence,
                 e.relevance_days, e.expires_at,
                 l.lat, l.lng, l.place_name, l.country, l.precision,
                 first_source.url AS event_url, first_source.image_url AS event_image,
                 NULL::text AS _kind, NULL::text AS _url, NULL::text AS _source_name,
                 ST_Distance(l.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) / 1000 AS distance_km,
                 (EXP(-ST_Distance(l.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) / 1000 / 200)
                  * EXP(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600)) AS near_score
          FROM news_events e
          LEFT JOIN news_locations l ON l.id = e.primary_location_id
          LEFT JOIN LATERAL (
            SELECT a.url, a.image_url FROM news_event_sources es
            JOIN news_articles a ON a.id = es.article_id
            WHERE es.event_id = e.id
            ORDER BY (NULLIF(a.image_url, '') IS NULL), a.published_at DESC NULLS LAST
            LIMIT 1
          ) first_source ON true
          WHERE e.status = 'active'
            AND (e.expires_at IS NULL OR e.expires_at > now()) ${eventCut}
            AND l.geom IS NOT NULL
            AND ST_DWithin(
              l.geom,
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
              ${radiusKm * 1000}
            )
          ORDER BY near_score DESC, e.first_reported_at DESC
          LIMIT ${limit}
        `;
      }

      const mapItem = (r: any) => ({
        id: Number(r.id),
        type: r._kind === "article" ? "article" : "event",
        event_type: r.event_type,
        headline: r.headline,
        summary: r.summary,
        first_reported_at: new Date(r.first_reported_at).toISOString(),
        source_count: Number(r.source_count),
        avg_confidence: Number(r.avg_confidence),
        relevance_days: Number(r.relevance_days),
        expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        location:
          r.lat != null && r.lng != null
            ? { lat: Number(r.lat), lng: Number(r.lng), place_name: r.place_name, country: r.country, precision: r.precision }
            : null,
        distance_km: r.distance_km != null ? Math.round(Number(r.distance_km)) : null,
        url: r._url || r.event_url || null,
        image_url: r._image || r.event_image || null,
        source_name: r._source_name || null,
      });

      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify({
          home,
          hot: hot.map(mapItem),
          near: near.map(mapItem),
          radius_km: radiusKm,
          generated_at: new Date().toISOString(),
          note: "sse-stream-initial",
        }),
      });

      // 60 s safety-net resync — same query keeps results fresh.
      // FIX_NOTES 4.14: this payload is personalized (home/bbox/radius),
      // so it must go ONLY to this client. It used to call
      // broadcastSnapshot(), which fanned one client's snapshot to EVERY
      // connected client — O(N^2) messages and cross-user data mixing.
      if (!stream.closed) {
      snapshotTimer = setInterval(async () => {
        if (stream.closed) { if (snapshotTimer) clearInterval(snapshotTimer); return; }
        try {
          let freshHot = await sql<any[]>`
            SELECT e.id, e.event_type, e.headline, e.summary,
                   e.first_reported_at, e.source_count, e.avg_confidence,
                   e.relevance_days, e.expires_at,
                   l.lat, l.lng, l.place_name, l.country, l.precision,
                    first_source.url AS event_url, first_source.image_url AS event_image,
                    NULL::text AS _kind, NULL::text AS _url, NULL::text AS _source_name,
                    g.total_links AS graph_total_links,
                    g.connectivity_score AS graph_connectivity,
                    g.same_event_links AS graph_same_event_links,
                    g.same_event_avg_strength AS graph_consensus,
                    g.link_type_count AS graph_link_types,
                    g.avg_link_strength AS graph_avg_strength
                    ${distCol}
             FROM news_events e
             LEFT JOIN news_locations l ON l.id = e.primary_location_id
             LEFT JOIN news_event_graph_features g ON g.event_id = e.id
             LEFT JOIN LATERAL (
              SELECT a.url, a.image_url FROM news_event_sources es
              JOIN news_articles a ON a.id = es.article_id
              WHERE es.event_id = e.id
              ORDER BY (NULLIF(a.image_url, '') IS NULL), a.published_at DESC NULLS LAST
              LIMIT 1
            ) first_source ON true
             WHERE e.status = 'active'
               AND (e.expires_at IS NULL OR e.expires_at > now()) ${eventCut}
               ${bbox ? sql`AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : sql``}
             ORDER BY
               (
                 (e.source_count * exp(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600))
                 * ${sql.unsafe(proximityBoost)}
                 + ${graphBoostExpr(sql)}
               ) DESC,
               e.first_reported_at DESC
             LIMIT ${limit}
           `;

          if (freshHot.length < limit) {
            const extra = await sql<any[]>`
              SELECT a.id, COALESCE(a.event_type, 'other') AS event_type,
                     a.title AS headline, a.summary,
                     a.published_at AS first_reported_at, 1 AS source_count,
                     0.9 AS avg_confidence,
                     7 AS relevance_days, NULL::timestamptz AS expires_at,
                     l.lat, l.lng, l.place_name, l.country, l.precision,
             'article'::text AS _kind, a.url AS _url, s.name AS _source_name, a.image_url AS _image
                      ${distCol}
               FROM news_articles a
              JOIN news_locations l ON l.id = a.location_id
              LEFT JOIN news_sources s ON s.id = a.source_id
              WHERE a.status IN ('extracted', 'processed') ${articleCut}
                AND l.geom IS NOT NULL
                AND a.id NOT IN (SELECT article_id FROM news_event_sources)
                ${bbox ? sql`AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : sql``}
              ORDER BY
                ((1.0 * exp(-0.1 * EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, a.fetched_at))) / 3600)) * ${sql.unsafe(proximityBoost)}) DESC,
                a.published_at DESC NULLS LAST
              LIMIT ${limit - freshHot.length}
            `;
            freshHot = [...freshHot, ...extra];
          }

          let freshNear: any[] = [];
          if (home) {
            freshNear = await sql<any[]>`
              SELECT e.id, e.event_type, e.headline, e.summary,
                     e.first_reported_at, e.source_count, e.avg_confidence,
                     e.relevance_days, e.expires_at,
                     l.lat, l.lng, l.place_name, l.country, l.precision,
                     first_source.url AS event_url, first_source.image_url AS event_image,
                     NULL::text AS _kind, NULL::text AS _url, NULL::text AS _source_name,
                     ST_Distance(l.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) / 1000 AS distance_km,
                     (EXP(-ST_Distance(l.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) / 1000 / 200)
                      * EXP(-0.05 * EXTRACT(EPOCH FROM (now() - e.first_reported_at)) / 3600)) AS near_score
              FROM news_events e
              LEFT JOIN news_locations l ON l.id = e.primary_location_id
              LEFT JOIN LATERAL (
                SELECT a.url, a.image_url FROM news_event_sources es
                JOIN news_articles a ON a.id = es.article_id
                WHERE es.event_id = e.id
                ORDER BY (NULLIF(a.image_url, '') IS NULL), a.published_at DESC NULLS LAST
                LIMIT 1
              ) first_source ON true
              WHERE e.status = 'active'
                AND (e.expires_at IS NULL OR e.expires_at > now()) ${eventCut}
                AND l.geom IS NOT NULL
                AND ST_DWithin(
                  l.geom,
                  ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
                  ${radiusKm * 1000}
                )
              ORDER BY near_score DESC, e.first_reported_at DESC
              LIMIT ${limit}
            `;
          }

          await stream.writeSSE({
            event: "snapshot",
            data: JSON.stringify({
              home,
              hot: freshHot.map(mapItem),
              near: freshNear.map(mapItem),
              radius_km: radiusKm,
              generated_at: new Date().toISOString(),
              note: "sse-stream-resync",
            }),
          });
        } catch (e) {
          console.error(
            "[sse-feed] resync snapshot failed:",
            e instanceof Error ? `${e.message}` : e,
          );
          /* next interval will try again */
        }
      }, 60_000);
      }
    } catch (e) {
      // Initial snapshot failed — send a hello so the client at least
      // knows the connection is live, then stay open. Log the cause:
      // this path used to swallow errors silently, hiding bugs like the
      // graphBoost sql.unsafe() mismatch (2026-10-15).
      console.error(
        "[sse-feed] initial snapshot failed:",
        e instanceof Error ? `${e.message}` : e,
      );
      await stream
        .writeSSE({ event: "snapshot", data: JSON.stringify({ home: null, hot: [], near: [], error: "snapshot_failed" }) })
        .catch(() => {});
    }

    // Hold the stream open until the client disconnects — cleanup() was
    // armed at connect time, so the intervals die with the connection.
    await aborted;
  });
});

// ── GET /api/feed/links ────────────────────────────────────────────────
//
// Story-to-story connection graph for the "Links" overlay. Returns the
// node list (one entry per article/event referenced by at least one link)
// plus a deduplicated edge list — multiple link_types between the same
// pair are aggregated into one edge with `kinds` and a summed weight.
//
// The frontend draws each edge as a great-circle arc, colored by the
// kind(s) the link has (source / location / entity / topic). We map our
// DB's link_types onto that vocabulary so the tooltip copy matches.
//
//   same_city     → "location" (both cover the same city)
//   same_country  → "location" (both cover the same country)
//   same_event    → "source"   (linked into the same event cluster)
//
// Optional `bbox` filters edges to those whose at-least-one endpoint
// falls inside the map viewport. We deliberately allow ONE endpoint
// outside so cross-viewport connections still appear when the user pans.
//
// Cache: hot data, no per-user variation — safe to add cache headers.
// (Frontend also keeps a 60s in-memory cache so we don't thrash here.)
// How many articles in the viewport are considered for connections, and
// how many links each of them contributes. The endpoint used to scan the
// whole news_story_links table (36.6 M rows) for every request — 65 s for
// one viewport, so the browser's fetch timed out and the Links arcs
// never rendered.
const LINK_ARTICLES_IN_VIEW = 1200;
const LINKS_PER_ARTICLE = 12;

feedRoute.get("/feed/links", async (c) => {
  const sql = getDb();

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 150), 1), 500);
  const minWeight = Math.max(Number(c.req.query("min_weight") ?? 0.5), 0.1);
  const bboxRaw = c.req.query("bbox");
  const qRaw = c.req.query("q");
  const searchQuery = qRaw && qRaw.length >= 2 ? qRaw.trim().toLowerCase() : null;
  let bbox: number[] | null = null;
  if (bboxRaw && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bboxRaw)) {
    bbox = bboxRaw.split(",").map(Number);
  }

  // ── Pull candidate edges ─────────────────────────────────────────
  // When searchQuery is provided, filter to edges where BOTH articles
  // mention the search term — this lets users see how "Taiwan" stories
  // connect to each other across the globe.
  const searchFilter = searchQuery
    ? sql`AND (a1.title ILIKE ${"%" + searchQuery + "%"} ESCAPE '\\' AND a2.title ILIKE ${"%" + searchQuery + "%"} ESCAPE '\\')`
    : sql``;

  // The edges are driven from the ARTICLES IN VIEW, not from a scan of
  // news_story_links (36.6 M rows — the old form filtered them with an
  // OR of four geometry/coordinate tests and had to read the whole table
  // before it could sort: 65 s for one viewport, so the browser's fetch
  // timed out and the arcs never appeared — the Links toggle looked
  // broken).
  //
  // in_view resolves the viewport through the article spatial index
  // (newest first, capped), and the LATERAL lets PostgreSQL use the two
  // indexes on news_story_links (source / target) per article.
  const inViewCte = bbox
    ? sql`
      WITH in_view AS MATERIALIZED (
        SELECT a.id
        FROM news_articles a
        WHERE a.extracted_lat BETWEEN ${bbox[1]} AND ${bbox[3]}
          AND a.extracted_lng BETWEEN ${bbox[0]} AND ${bbox[2]}
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
        LIMIT ${LINK_ARTICLES_IN_VIEW}
      )`
    : sql`
      WITH in_view AS MATERIALIZED (
        SELECT a.id
        FROM news_articles a
        WHERE a.status = 'extracted'
          AND (a.extracted_lat IS NOT NULL OR a.location_id IS NOT NULL)
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
        LIMIT ${LINK_ARTICLES_IN_VIEW}
      )`;

  const candidates = await sql<any[]>`
    ${inViewCte}
    SELECT l.id, l.source_article_id, l.target_article_id,
           l.link_type, l.link_strength, l.link_reason,
           l.city_name, l.country_code,
           l.entity_name, l.topic,
           COALESCE(a1.extracted_lat, l1.lat) AS a_lat,
           COALESCE(a1.extracted_lng, l1.lng) AS a_lng,
           a1.title AS a_headline, COALESCE(a1.extracted_location, a1.location_text) AS a_place,
           COALESCE(a2.extracted_lat, l2.lat) AS b_lat,
           COALESCE(a2.extracted_lng, l2.lng) AS b_lng,
           a2.title AS b_headline, COALESCE(a2.extracted_location, a2.location_text) AS b_place
    FROM in_view v
    CROSS JOIN LATERAL (
      SELECT l.* FROM news_story_links l
      WHERE (l.source_article_id = v.id OR l.target_article_id = v.id)
        AND l.link_strength >= ${minWeight}
      ORDER BY l.link_strength DESC
      LIMIT ${LINKS_PER_ARTICLE}
    ) l
    JOIN news_articles a1 ON a1.id = l.source_article_id
    LEFT JOIN news_locations l1 ON l1.id = a1.location_id
    JOIN news_articles a2 ON a2.id = l.target_article_id
    LEFT JOIN news_locations l2 ON l2.id = a2.location_id
    WHERE (a1.extracted_lat IS NOT NULL OR a1.location_id IS NOT NULL)
      AND (a2.extracted_lat IS NOT NULL OR a2.location_id IS NOT NULL)
      AND (
        COALESCE(a1.extracted_lat, l1.lat) != COALESCE(a2.extracted_lat, l2.lat)
        OR COALESCE(a1.extracted_lng, l1.lng) != COALESCE(a2.extracted_lng, l2.lng)
      )
      ${searchFilter}
    ORDER BY l.link_strength DESC, l.updated_at DESC
    LIMIT ${Math.max(limit * 3, 500)}
  `;

  // ── Aggregate into edges (a, b) → {kinds, weight, shared} ────────
  // Map DB link_types to the frontend's color vocabulary.
  const TYPE_TO_KIND: Record<string, string> = {
    same_city: "location",
    same_country: "location",
    same_event: "source",
    same_topic: "topic",
    same_entity: "entity",
    same_source: "source",
    semantic_similarity: "semantic",
    ai_detected: "ai",
  };

  type EdgeAgg = {
    a: number;
    b: number;
    kinds: Set<string>;
    weight: number;
    reason: string | null;
    shared: { sources: number; locations: number; entities: number; topics: number; place: string | null };
  };
  const edgesMap = new Map<string, EdgeAgg>();

  for (const r of candidates) {
    // Always order (a < b) so duplicate-detection is symmetric.
    const [lo, hi] = r.source_article_id < r.target_article_id
      ? [r.source_article_id, r.target_article_id]
      : [r.target_article_id, r.source_article_id];
    const key = `${lo},${hi}`;
    let agg = edgesMap.get(key);
    if (!agg) {
      agg = {
        a: Number(lo),
        b: Number(hi),
        kinds: new Set(),
        weight: 0,
        reason: null,
        shared: { sources: 0, locations: 0, entities: 0, topics: 0, place: null },
      };
      edgesMap.set(key, agg);
    }
    const mappedKind = TYPE_TO_KIND[r.link_type] ?? r.link_type;
    agg.kinds.add(mappedKind);
    agg.weight += Number(r.link_strength);

    if (mappedKind === "source")   agg.shared.sources += 1;
    if (mappedKind === "location") agg.shared.locations += 1;
    if (r.entity_name)             agg.shared.entities  += 1;
    if (r.topic)                   agg.shared.topics    += 1;
    // Why are these two connected? The NN relationship model writes a
    // human-readable reason ("NN: same_story (cosine=0.85)") that no
    // other link type carries. It was selected into the row and then
    // thrown away, so every tooltip rendered the useless word "linked".
    if (!agg.reason && r.link_reason) agg.reason = r.link_reason;
    // Surface the most specific place we have for the tooltip
    // (city > country > the article's own location). ai_detected rows
    // carry no city/country/entity/topic at all, so without this
    // fallback the place bit is empty for ~97% of all edges.
    const fallbackPlace = r.city_name || r.country_code || r.a_place || r.b_place || null;
    if (!agg.shared.place) {
      agg.shared.place = fallbackPlace;
    } else if (r.city_name && !agg.shared.place.includes(r.city_name)) {
      agg.shared.place = r.city_name;
    }
  }

  // ── Build the response ────────────────────────────────────────────
  // Nodes: every distinct article referenced by an aggregated edge.
  // We re-fetch headlines/locations from the candidates we already have
  // (no second DB roundtrip needed) so we keep the response tight.
  const nodeById = new Map<number, { id: number; headline: string; location: { lat: number; lng: number; place: string | null } }>();
  for (const r of candidates) {
    const aId = Number(r.source_article_id);
    const bId = Number(r.target_article_id);
    if (!nodeById.has(aId)) {
      nodeById.set(aId, {
        id: aId,
        headline: r.a_headline || "",
        location: { lat: Number(r.a_lat), lng: Number(r.a_lng), place: r.a_place || null },
      });
    }
    if (!nodeById.has(bId)) {
      nodeById.set(bId, {
        id: bId,
        headline: r.b_headline || "",
        location: { lat: Number(r.b_lat), lng: Number(r.b_lng), place: r.b_place || null },
      });
    }
  }

  // Sort edges by weight desc, take top N.
  const sortedEdges = [...edgesMap.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);

  let edges = sortedEdges.map((e) => ({
    a: e.a,
    b: e.b,
    weight: Math.round(e.weight * 100) / 100,
    kinds: [...e.kinds],
    reason: e.reason,
    shared: e.shared,
  }));

  // Fallback: If bbox returned fewer than 10 edges, dynamically link active viewport markers by city/country/category
  // Uses O(n) HashMap grouping instead of O(n²) pairwise comparison
  if (edges.length < 10 && bbox) {
    const activeArticles = await sql<any[]>`
      SELECT a.id, a.title AS headline, COALESCE(a.event_type, 'other') AS event_type,
             l.lat, l.lng, l.place_name, l.country
      FROM news_articles a
      JOIN news_locations l ON l.id = a.location_id
      WHERE l.geom IS NOT NULL
        AND l.geom::geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)
      ORDER BY COALESCE(a.published_at, a.fetched_at) DESC NULLS LAST
      LIMIT 40
    `;

    // O(n) grouping: group articles by city, country, and category
    const byCity = new Map<string, typeof activeArticles>();
    const byCountry = new Map<string, typeof activeArticles>();
    const byTopic = new Map<string, typeof activeArticles>();

    for (const art of activeArticles) {
      const city = art.place_name || "";
      const country = art.country || "";
      const topic = art.event_type || "other";
      const id = Number(art.id);

      // Track node
      if (!nodeById.has(id)) {
        nodeById.set(id, { id, headline: art.headline || "", location: { lat: Number(art.lat), lng: Number(art.lng), place: art.place_name } });
      }

      // Group by city (highest weight link)
      if (city) {
        if (!byCity.has(city)) byCity.set(city, []);
        byCity.get(city)!.push(art);
      }
      // Group by country (medium weight link)
      if (country) {
        if (!byCountry.has(country)) byCountry.set(country, []);
        byCountry.get(country)!.push(art);
      }
      // Group by topic (lower weight link)
      if (topic) {
        if (!byTopic.has(topic)) byTopic.set(topic, []);
        byTopic.get(topic)!.push(art);
      }
    }

    // Helper to add edges within a group
    const addEdgesInGroup = (group: Map<string, typeof activeArticles>, weight: number, kind: string, sharedKey: keyof typeof edgesMap.prototype.shared) => {
      for (const [, articles] of group) {
        if (articles.length < 2) continue;
        for (let i = 0; i < articles.length; i++) {
          for (let j = i + 1; j < articles.length; j++) {
            const a1 = articles[i];
            const a2 = articles[j];
            if (
              Math.abs(Number(a1.lat) - Number(a2.lat)) < 0.005 &&
              Math.abs(Number(a1.lng) - Number(a2.lng)) < 0.005
            ) {
              continue; // Skip lines between identical points
            }
            const aId = Number(a1.id);
            const bId = Number(a2.id);
            const lo = Math.min(aId, bId);
            const hi = Math.max(aId, bId);
            const key = `${lo},${hi}`;

            if (!edgesMap.has(key)) {
              edgesMap.set(key, {
                a: lo,
                b: hi,
                kinds: new Set([kind]),
                weight,
                reason: null,
                shared: { sources: 0, locations: 0, entities: 0, topics: 0, place: a1.place_name || a1.country || null },
              });
              edgesMap.get(key)!.shared[sharedKey] = 1;
            }
          }
        }
      }
    };

    addEdgesInGroup(byCity, 0.85, "location", "locations");
    addEdgesInGroup(byCountry, 0.50, "location", "locations");
    addEdgesInGroup(byTopic, 0.70, "topic", "topics");

    const reSorted = [...edgesMap.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    edges = reSorted.map((e) => ({
      a: e.a,
      b: e.b,
      weight: Math.round(e.weight * 100) / 100,
      kinds: [...e.kinds],
      reason: e.reason,
      shared: e.shared,
    }));
  }

  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    nodes: [...nodeById.values()],
    edges,
    total_edges: edges.length,
    generated_at: new Date().toISOString(),
  });
});
