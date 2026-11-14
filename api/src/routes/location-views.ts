import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { adminAuth } from "../auth";

export const locationViewsRoute = new Hono();

// Rate limiter for location views: 100 per minute per IP
const viewLimiter = new RateLimiter({ max: 100, windowMs: 60 * 1000 });

// ── POST /api/location-views ─────────────────────────────────────────────
//
// Log location views from the client-side tracker.
// Accepts batched views to reduce API calls.
const LocationViewSchema = z.object({
  session_id: z.string().min(1).max(100).optional(),
  views: z.array(z.object({
    view_type: z.enum(['map_view', 'pin_click', 'search', 'explore', 'auto_discover']),
    center_lat: z.number().min(-90).max(90),
    center_lng: z.number().min(-180).max(180),
    // Leaflet can report a fractional zoom (pinch-zoom, zoomToFit on a
    // fractional target) — accept it and round when storing, otherwise
    // every such flush was rejected with a 400 and the view was lost.
    zoom_level: z.number().min(1).max(20),
    bbox: z.string().nullable().optional(),
    city_name: z.string().max(200).nullable().optional(),
    country_code: z.string().max(2).nullable().optional(),
    region_name: z.string().max(100).nullable().optional(),
    duration_ms: z.number().int().min(0).nullable().optional(),
    pin_count: z.number().int().min(0).nullable().optional(),
    metadata: z.any().optional(),
    created_at: z.string().optional(),
  })).max(100),
});

locationViewsRoute.post(
  "/location-views",
  zValidator("json", LocationViewSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = viewLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();
    const sessionId = data.session_id || 'anonymous';
    // Tier 1.2: read header once, derive a per-view key by appending
    // the view's position in the batch. Retry of the same flush payload
    // → every per-view key collides → 0 inserts (good). NULL header
    // (legacy callers) → all views get NULL idempotency_key → no
    // dedup, but no conflict either since NULLs are excluded by the
    // partial unique index.
    //
    // Tier 1.2 hardening: prefix the stored key with session_id so two
    // different sessions can't collide on the same UUID, and an attacker
    // who can guess a client key still can't claim another session's
    // slot (they'd need the session_id to forge the composite key).
    // Per-row derivation `${headerKey}:${i}` cascades naturally into
    // `${sessionId}:${rawKey}:${i}`.
    const rawHeaderKey = c.req.header("X-Idempotency-Key") || null;
    const headerKey = rawHeaderKey ? `${sessionId}:${rawHeaderKey}` : null;

    // Get user's detected location
    let userLat: number | null = null;
    let userLng: number | null = null;
    let userCountry: string | null = null;

    if (sessionId !== 'anonymous') {
      try {
        const userRows = await sql<any[]>`
          SELECT active_lat, active_lng, home_country, detected_country
          FROM news_user_locations
          WHERE session_id = ${sessionId}
          LIMIT 1
        `;
        if (userRows[0]) {
          userLat = userRows[0].active_lat;
          userLng = userRows[0].active_lng;
          userCountry = userRows[0].home_country || userRows[0].detected_country;
        }
      } catch (e) {}
    }

    const ipAddress = ip !== 'unknown' ? ip : null;

    // Empty-batch shortcut: skip the round-trip entirely. Legacy callers
    // that send `{views: []}` (or a buggy client) get a clean ack instead
    // of a postgres error from `unnest()` over zero-row arrays.
    if (data.views.length === 0) {
      return c.json({ ok: true, inserted: 0, duplicates: 0 });
    }

    // Batch insert views in a SINGLE round-trip via unnest(...). Each
    // view gets a per-position key derived from the batch header; ON
    // CONFLICT DO NOTHING skips duplicates silently so a retry of the
    // same flush payload is a no-op instead of doubling every view's
    // row (Tier 1.2 review finding #4: prior loop was N+1 round-trips).
    const viewTypes = data.views.map((v) => v.view_type);
    const centerLats = data.views.map((v) => v.center_lat);
    const centerLngs = data.views.map((v) => v.center_lng);
    const zoomLevels = data.views.map((v) => Math.round(v.zoom_level));
    const bboxes = data.views.map((v) => v.bbox ?? null);
    const cityNames = data.views.map((v) => v.city_name ?? null);
    const countryCodes = data.views.map((v) => v.country_code ?? null);
    const regionNames = data.views.map((v) => v.region_name ?? null);
    const durations = data.views.map((v) => v.duration_ms ?? null);
    const pinCounts = data.views.map((v) => v.pin_count ?? null);
    const metadatas = data.views.map((v) =>
      v.metadata ? JSON.stringify(v.metadata) : null,
    );
    const keys = data.views.map((_, i) => (headerKey ? `${headerKey}:${i}` : null));
    const createdAts = data.views.map((v) =>
      v.created_at ? new Date(v.created_at).toISOString() : null,
    );

    let inserted = 0;
    try {
      const result = await sql<any[]>`
        INSERT INTO news_location_views (
          session_id, view_type,
          center_lat, center_lng, zoom_level, bbox,
          city_name, country_code, region_name,
          user_lat, user_lng, user_country,
          ip_address, duration_ms, pin_count, metadata,
          idempotency_key,
          created_at
        )
        SELECT
          ${sessionId}::text,
          v.view_type,
          v.center_lat, v.center_lng, v.zoom_level, v.bbox,
          v.city_name, v.country_code, v.region_name,
          ${userLat}::double precision, ${userLng}::double precision, ${userCountry}::text,
          ${ipAddress}::inet,
          v.duration_ms, v.pin_count, v.metadata::jsonb,
          v.key,
          COALESCE(v.created_at, now())
        FROM unnest(
          ${viewTypes}::text[],
          ${centerLats}::double precision[],
          ${centerLngs}::double precision[],
          ${zoomLevels}::int[],
          ${bboxes}::text[],
          ${cityNames}::text[],
          ${countryCodes}::text[],
          ${regionNames}::text[],
          ${durations}::int[],
          ${pinCounts}::int[],
          ${metadatas}::text[],
          ${keys}::text[],
          ${createdAts}::timestamptz[]
        ) AS v(view_type, center_lat, center_lng, zoom_level, bbox,
               city_name, country_code, region_name,
               duration_ms, pin_count, metadata, key, created_at)
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      inserted = result.length;
    } catch (e) {
      console.warn('[location-views] Failed to insert views:', e);
    }

    const duplicates = headerKey ? Math.max(0, data.views.length - inserted) : 0;
    return c.json({ ok: true, inserted, duplicates });
  }
);

// ── GET /api/location-views/trending ─────────────────────────────────────
//
// Get trending locations based on user views.
// Returns cities sorted by view count and engagement.
locationViewsRoute.get("/location-views/trending", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 20), 100);
  const hours = Math.min(Number(c.req.query("hours") || 24), 168);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT
      city_name,
      country_code,
      center_lat,
      center_lng,
      COUNT(*) as view_count,
      COUNT(DISTINCT session_id) as unique_users,
      COUNT(*) FILTER (WHERE view_type = 'pin_click') as pin_clicks,
      COUNT(*) FILTER (WHERE view_type = 'search') as searches,
      AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration,
      -- Trending score: views + engagement
      (
        COUNT(*) * 1.0 +
        COUNT(DISTINCT session_id) * 5.0 +
        COUNT(*) FILTER (WHERE view_type = 'pin_click') * 3.0
      ) as trend_score
    FROM news_location_views
    WHERE created_at > now() - (${hours}::int * interval '1 hour')
      AND city_name IS NOT NULL
    GROUP BY city_name, country_code, center_lat, center_lng
    ORDER BY trend_score DESC
    LIMIT ${limit}::int
  `;

  return c.json({
    trending: rows.map(r => ({
      city: r.city_name,
      country: r.country_code,
      lat: Number(r.center_lat),
      lng: Number(r.center_lng),
      views: Number(r.view_count),
      users: Number(r.unique_users),
      clicks: Number(r.pin_clicks),
      searches: Number(r.searches),
      avg_duration_ms: r.avg_duration ? Math.round(Number(r.avg_duration)) : null,
      trend_score: Math.round(Number(r.trend_score) * 10) / 10,
    })),
    window_hours: hours,
  });
});

// ── GET /api/location-views/coverage-gaps ────────────────────────────────
//
// Get locations with high user interest but low news coverage.
// Used to prioritize news source discovery.
// ── Haversine distance (km) between two lat/lng points ───────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

locationViewsRoute.get("/location-views/coverage-gaps", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 20), 100);
  const nearbyRadiusKm = Math.min(Number(c.req.query("nearby_radius_km") || 250), 1500);
  const nearbyLimit = Math.min(Number(c.req.query("nearby_limit") || 3), 8);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT
      lr.city_name,
      lr.country_code,
      lr.center_lat,
      lr.center_lng,
      lr.views_24h,
      lr.unique_users_24h,
      lr.trend_score,
      lr.has_coverage,
      lr.article_count,
      lr.source_count,
      lr.discovery_priority as gap_score
    FROM news_location_rankings lr
    WHERE lr.views_24h > 0
    ORDER BY lr.discovery_priority DESC
    LIMIT ${limit}
  `;

  // Pull all covered cities once. Volume is small (one row per city) so we
  // can compute haversine in JS cheaply. Pulling per-gap would N+1.
  const covered = await sql<any[]>`
    SELECT city_name, country_code, center_lat, center_lng, article_count, source_count
    FROM news_location_rankings
    WHERE has_coverage = true
      AND article_count > 0
      AND center_lat IS NOT NULL
      AND center_lng IS NOT NULL
  `;

  const gaps = rows.map((r) => {
    const lat = Number(r.center_lat);
    const lng = Number(r.center_lng);
    const nearby: Array<{
      city: string;
      country: string;
      lat: number;
      lng: number;
      article_count: number;
      source_count: number;
      distance_km: number;
    }> = [];

    for (const cc of covered) {
      const cLat = Number(cc.center_lat);
      const cLng = Number(cc.center_lng);
      // Cheap bbox pre-filter (~1° ≈ 111km) so we don't haversine the world.
      const degDelta = nearbyRadiusKm / 111;
      if (Math.abs(cLat - lat) > degDelta || Math.abs(cLng - lng) > degDelta) continue;
      const km = haversineKm(lat, lng, cLat, cLng);
      if (km > nearbyRadiusKm) continue;
      nearby.push({
        city: cc.city_name,
        country: cc.country_code,
        lat: cLat,
        lng: cLng,
        article_count: Number(cc.article_count),
        source_count: Number(cc.source_count),
        distance_km: Math.round(km * 10) / 10,
      });
    }

    nearby.sort((a, b) => a.distance_km - b.distance_km);

    return {
      city: r.city_name,
      country: r.country_code,
      lat,
      lng,
      views_24h: Number(r.views_24h),
      users_24h: Number(r.unique_users_24h),
      trend_score: Number(r.trend_score),
      has_coverage: r.has_coverage,
      article_count: Number(r.article_count),
      source_count: Number(r.source_count),
      gap_score: Number(r.gap_score),
      nearby_covered: nearby.slice(0, nearbyLimit),
    };
  });

  return c.json({
    gaps,
    nearby_radius_km: nearbyRadiusKm,
  });
});

// ── GET /api/location-views/stats ────────────────────────────────────────
//
// Get overall location view statistics.
locationViewsRoute.get("/location-views/stats", async (c) => {
  const sql = getDb();

  const stats = await sql<any[]>`
    SELECT
      COUNT(*) as total_views,
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') as views_24h,
      COUNT(DISTINCT session_id) as total_users,
      COUNT(DISTINCT session_id) FILTER (WHERE created_at > now() - interval '24 hours') as users_24h,
      COUNT(DISTINCT city_name) FILTER (WHERE city_name IS NOT NULL) as cities_viewed,
      COUNT(DISTINCT country_code) FILTER (WHERE country_code IS NOT NULL) as countries_viewed
    FROM news_location_views
  `;

  const topCities = await sql<any[]>`
    SELECT city_name, country_code, COUNT(*) as views
    FROM news_location_views
    WHERE created_at > now() - interval '24 hours'
      AND city_name IS NOT NULL
    GROUP BY city_name, country_code
    ORDER BY views DESC
    LIMIT 10
  `;

  const s = stats[0];

  return c.json({
    total_views: Number(s.total_views),
    views_24h: Number(s.views_24h),
    total_users: Number(s.total_users),
    users_24h: Number(s.users_24h),
    cities_viewed: Number(s.cities_viewed),
    countries_viewed: Number(s.countries_viewed),
    top_cities: topCities.map(r => ({
      city: r.city_name,
      country: r.country_code,
      views: Number(r.views),
    })),
  });
});

// ── POST /api/location-views/calculate ───────────────────────────────────
//
// Trigger location rankings calculation (admin endpoint).
locationViewsRoute.post("/location-views/calculate", async (c) => {
  // Tier 1.6: gate — triggers an expensive SQL ranking. Repeat calls
  // are a DoS vector (CPU + DB pressure).
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const sql = getDb();
  await sql`SELECT calculate_location_rankings()`;
  return c.json({ ok: true, message: "Location rankings calculated" });
});
