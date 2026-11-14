import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { CitiesSearchSchema } from "../validate";

export const citiesRoute = new Hono();

// ── GET /api/cities/search ───────────────────────────────────────────
//
// Fast city lookup by name. Used by:
//   - the frontend search bar (typeahead)
//   - the worker city-extractor short-circuit (worker/cities_lookup.py)
//   - admin tooling for "what's the canonical record for this place?"
//
// Matches against the merged world_cities table (GeoNames + user CSV)
// and the city_aliases table. Returns ranked by population descending
// with a tie-breaker on how early the query appears in the name.
citiesRoute.get(
  "/cities/search",
  zValidator("query", CitiesSearchSchema),
  async (c) => {
    const { q, country, lang, min_population, limit } = c.req.valid("query");
    const sql = getDb();

    // Escape LIKE wildcards so users can search for literal % and _.
    const like = q
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");

    const rows = await sql<Array<{
      id: number | bigint;
      name: string;
      ascii_name: string;
      country_code: string;
      state_name: string | null;
      lat: number;
      lng: number;
      population: number;
      match_type: string;
    }>>`
      WITH matches AS (
        -- Direct name match (word boundary matching: starts with, or preceded by space).
        SELECT id, name, ascii_name, country_code, state_name,
               lat, lng, population, 'name' AS match_type,
               POSITION(${like.toLowerCase()} IN lower(ascii_name)) AS pos
        FROM world_cities
        WHERE (lower(ascii_name) LIKE ${like.toLowerCase() + "%"} ESCAPE '\\'
            OR lower(name)       LIKE ${like.toLowerCase() + "%"} ESCAPE '\\'
            OR lower(ascii_name) LIKE ${"%" + like.toLowerCase() + " %"} ESCAPE '\\'
            OR lower(name)       LIKE ${"%" + like.toLowerCase() + " %"} ESCAPE '\\'
            OR lower(ascii_name) LIKE ${"%" + like.toLowerCase() + ",%"} ESCAPE '\\'
            OR lower(name)       LIKE ${"%" + like.toLowerCase() + ",%"} ESCAPE '\\'
            OR lower(ascii_name) LIKE ${"%" + like.toLowerCase() + ")%"} ESCAPE '\\'
            OR lower(name)       LIKE ${"%" + like.toLowerCase() + ")%"} ESCAPE '\\'
            OR lower(ascii_name) = ${like.toLowerCase()}
            OR lower(name)       = ${like.toLowerCase()})
          AND population >= ${min_population}
          ${country ? sql`AND country_code = ${country.toUpperCase()}` : sql``}

        UNION ALL

        -- Multilingual name match (city_names from xyzo_cities).
        SELECT wc.id, wc.name, wc.ascii_name, wc.country_code, wc.state_name,
               wc.lat, wc.lng, wc.population,
               CASE WHEN cn.lang = ${lang || ''} THEN 'lang_exact' ELSE 'multilingual' END AS match_type,
               0 AS pos
        FROM city_names cn
        JOIN world_cities wc ON wc.id = cn.city_id
        WHERE (lower(cn.name) LIKE ${like.toLowerCase() + "%"} ESCAPE '\\'
            OR lower(cn.name_ascii) LIKE ${like.toLowerCase() + "%"} ESCAPE '\\'
            OR lower(cn.name) LIKE ${"%" + like.toLowerCase() + " %"} ESCAPE '\\'
            OR lower(cn.name_ascii) LIKE ${"%" + like.toLowerCase() + " %"} ESCAPE '\\'
            OR lower(cn.name) = ${like.toLowerCase()}
            OR lower(cn.name_ascii) = ${like.toLowerCase()})
          AND wc.population >= ${min_population}
          ${country ? sql`AND wc.country_code = ${country.toUpperCase()}` : sql``}

        UNION ALL

        -- Alias match.
        SELECT wc.id, wc.name, wc.ascii_name, wc.country_code, wc.state_name,
               wc.lat, wc.lng, wc.population, 'alias' AS match_type,
               0 AS pos
        FROM city_aliases ca
        JOIN world_cities wc ON wc.id = ca.city_id
        WHERE lower(ca.alias) = ${like.toLowerCase()}
          AND wc.population >= ${min_population}
          ${country ? sql`AND wc.country_code = ${country.toUpperCase()}` : sql``}
      )
      SELECT DISTINCT ON (id) *
      FROM matches
      ORDER BY id, population DESC
      LIMIT ${limit * 3}
    `;

    // Rank: lang-exact matches first, then alias, then multilingual, then by population.
    const matchRank: Record<string, number> = {
      lang_exact: 0, alias: 1, multilingual: 2, name: 3,
    };
    const ranked = rows
      .map((r) => ({
        id: Number(r.id),
        name: r.name,
        ascii_name: r.ascii_name,
        country_code: r.country_code,
        state: r.state_name,
        lat: Number(r.lat),
        lng: Number(r.lng),
        population: Number(r.population),
        match: r.match_type,
      }))
      .sort((a, b) => {
        const ra = matchRank[a.match] ?? 4;
        const rb = matchRank[b.match] ?? 4;
        if (ra !== rb) return ra - rb;
        return b.population - a.population;
      })
      .slice(0, limit);

    return c.json({
      query: q,
      country: country ?? null,
      count: ranked.length,
      cities: ranked,
    });
  },
);

// ── GET /api/cities/near ─────────────────────────────────────────────
// PostGIS lookup for the radius-based "news near me" feature. Returns
// the closest world_cities row within `radius_km`.
citiesRoute.get("/cities/near", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  const radius_km = Math.min(Number(c.req.query("radius_km") ?? 50), 500);
  const limit = Math.min(Number(c.req.query("limit") ?? 10), 50);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: "lat,lng required" }, 400);
  }

  const sql = getDb();
  const rows = await sql<Array<{
    id: number | bigint;
    name: string;
    country_code: string;
    state_name: string | null;
    lat: number;
    lng: number;
    population: number;
    distance_km: number;
  }>>`
    SELECT id, name, country_code, state_name,
           lat, lng, population,
           ST_Distance(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) / 1000 AS distance_km
    FROM world_cities
    WHERE ST_DWithin(
        geom,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${radius_km * 1000}
      )
      AND population >= 50000
    ORDER BY distance_km ASC
    LIMIT ${limit}
  `;

  return c.json({
    lat, lng, radius_km,
    count: rows.length,
    cities: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      country_code: r.country_code,
      state: r.state_name,
      lat: Number(r.lat),
      lng: Number(r.lng),
      population: Number(r.population),
      distance_km: Math.round(Number(r.distance_km) * 10) / 10,
    })),
  });
});

// ── GET /api/sources/:id/coverage ──────────────────────────────────
//
// Top cities (by article count) covered by a single RSS source.
// Used by the Source Coverage Map UI and the source-detail page.
//
// Joins: news_articles → news_locations → news_event_sources → events
// We aggregate on the location_id stored on the article (most accurate
// signal of where the source's coverage is geographically).
citiesRoute.get("/sources/:id/coverage", async (c) => {
  const sourceId = Number(c.req.param("id"));
  if (!Number.isFinite(sourceId)) {
    return c.json({ error: "invalid_source_id" }, 400);
  }
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  const since = c.req.query("since"); // ISO timestamp, optional

  const sql = getDb();
  // Look up the source so we can return its name in the response.
  const srcRows = await sql<Array<{ id: number; name: string; country: string }>>`
    SELECT id, name, country FROM news_sources WHERE id = ${sourceId}
  `;
  if (srcRows.length === 0) {
    return c.json({ error: "source_not_found" }, 404);
  }
  const source = srcRows[0];

  // Aggregate articles per city. Articles without a location_id are
  // skipped — they don't contribute to geography.
  const rows = await sql<Array<{
    city_id: number | null;
    place_name: string;
    country: string | null;
    lat: number;
    lng: number;
    precision: string;
    article_count: number;
    last_article_at: Date;
  }>>`
    WITH loc_counts AS (
      SELECT a.location_id AS city_id,
             COUNT(*)::int AS article_count,
             MAX(a.fetched_at) AS last_article_at
      FROM news_articles a
      WHERE a.source_id = ${sourceId}
        AND a.location_id IS NOT NULL
        ${since ? sql`AND a.fetched_at >= ${since}::timestamptz` : sql``}
      GROUP BY a.location_id
      ORDER BY COUNT(*) DESC
      LIMIT ${limit * 2}
    )
    SELECT l.id AS city_id, l.place_name, l.country, l.lat, l.lng,
           l.precision, lc.article_count, lc.last_article_at
    FROM loc_counts lc
    JOIN news_locations l ON l.id = lc.city_id
    ORDER BY lc.article_count DESC
    LIMIT ${limit}
  `;

  // Summary statistics.
  const totalArticles = rows.reduce((s, r) => s + r.article_count, 0);
  const countries = new Set(
    rows.map((r) => r.country).filter(Boolean) as string[],
  );

  return c.json({
    source: {
      id: Number(source.id),
      name: source.name,
      country: source.country,
    },
    window: since ? { since } : null,
    summary: {
      cities_count: rows.length,
      countries_count: countries.size,
      total_articles: totalArticles,
      is_national: countries.size > 1,
      coverage_concentration:
        totalArticles > 0 ? rows[0].article_count / totalArticles : 0,
    },
    cities: rows.map((r) => ({
      location_id: Number(r.city_id),
      place_name: r.place_name,
      country: r.country,
      lat: Number(r.lat),
      lng: Number(r.lng),
      precision: r.precision,
      article_count: Number(r.article_count),
      last_article_at: r.last_article_at instanceof Date
        ? r.last_article_at.toISOString()
        : r.last_article_at,
    })),
  });
});

// ── GET /api/cities/events ──────────────────────────────────────────
//
// Events/pins that match a specific city (by name + country). Used by
// the Cities tab in pin detail and the source coverage map.
citiesRoute.get("/cities/events", async (c) => {
  const name = c.req.query("name");
  const country = c.req.query("country");
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 200);

  if (!name || !country) {
    return c.json({ error: "name_and_country_required" }, 400);
  }

  const sql = getDb();
  const rows = await sql<Array<{
    id: number;
    event_type: string;
    headline: string;
    summary: string | null;
    first_reported_at: Date;
    source_count: number;
    lat: number;
    lng: number;
    precision: string;
  }>>`
    SELECT e.id, e.event_type, e.headline, e.summary, e.first_reported_at,
           e.source_count, l.lat, l.lng, l.precision
    FROM news_events e
    JOIN news_locations l ON l.id = e.primary_location_id
    WHERE l.place_name_normalized = lower(${name})
      AND l.country = ${country.toUpperCase()}
      AND (e.expires_at IS NULL OR e.expires_at > now())
    ORDER BY e.first_reported_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    city: { name, country: country.toUpperCase() },
    count: rows.length,
    events: rows.map((r) => ({
      id: Number(r.id),
      event_type: r.event_type,
      headline: r.headline,
      summary: r.summary,
      first_reported_at: r.first_reported_at,
      source_count: Number(r.source_count),
      location: {
        lat: Number(r.lat),
        lng: Number(r.lng),
        precision: r.precision,
      },
    })),
  });
});

// ── GET /api/cities/trending ──────────────────────────────────────────
//
// Cities whose event volume accelerated in the last N hours. We
// compare recent event count to a same-length baseline window
// immediately preceding it. Cities with >2x acceleration surface.
//
// Powers a "What's heating up" widget on the homepage.
citiesRoute.get("/cities/trending", async (c) => {
  const sql = getDb();
  const url = new URL(c.req.url);
  const windowHours = Math.max(1, Math.min(48,
    Number(url.searchParams.get("hours") ?? 6)));
  const limit = Math.max(1, Math.min(50,
    Number(url.searchParams.get("limit") ?? 20)));
  const minBaseline = Math.max(1, Number(url.searchParams.get("min_baseline") ?? 1));

  const rows = await sql<Array<{
    location_id: number;
    place_name: string;
    country: string | null;
    lat: number;
    lng: number;
    recent_count: number;
    baseline_count: number;
    acceleration: number;
    trending_score: number;
  }>>`
    WITH recent AS (
      SELECT a.location_id, COUNT(*) AS n
      FROM news_articles a
      WHERE a.fetched_at >= now() - (${windowHours} || ' hours')::interval
        AND a.location_id IS NOT NULL
      GROUP BY a.location_id
    ),
    baseline AS (
      SELECT a.location_id, COUNT(*) AS n
      FROM news_articles a
      WHERE a.fetched_at >= now() - (${windowHours * 2} || ' hours')::interval
        AND a.fetched_at <  now() - (${windowHours} || ' hours')::interval
        AND a.location_id IS NOT NULL
      GROUP BY a.location_id
    )
    SELECT l.id AS location_id, l.place_name, l.country, l.lat, l.lng,
           COALESCE(r.n, 0) AS recent_count,
           COALESCE(b.n, 0) AS baseline_count,
           CASE WHEN COALESCE(b.n, 0) = 0
                THEN 999.0
                ELSE (COALESCE(r.n, 0)::float / b.n)
           END AS acceleration,
           (COALESCE(r.n, 0)::float *
            CASE WHEN COALESCE(b.n, 0) = 0
                 THEN 5.0
                 ELSE LEAST(5.0, r.n::float / b.n)
            END
           ) AS trending_score
    FROM recent r
    LEFT JOIN baseline b ON b.location_id = r.location_id
    JOIN news_locations l ON l.id = r.location_id
    WHERE COALESCE(r.n, 0) >= 2
      AND (COALESCE(b.n, 0) >= ${minBaseline} OR COALESCE(b.n, 0) = 0)
    ORDER BY trending_score DESC
    LIMIT ${limit}
  `;

  return c.json({
    window_hours: windowHours,
    count: rows.length,
    cities: rows.map((r) => ({
      location_id: Number(r.location_id),
      place_name: r.place_name,
      country: r.country,
      lat: Number(r.lat),
      lng: Number(r.lng),
      recent_count: Number(r.recent_count),
      baseline_count: Number(r.baseline_count),
      acceleration: Math.round(Number(r.acceleration) * 10) / 10,
      trending_score: Math.round(Number(r.trending_score) * 10) / 10,
    })),
  });
});

// ── GET /api/sources/:id/coverage/gaps ──────────────────────────────
//
// For a given source, identify countries where it has zero
// coverage in the last N days but where the global xyzo
// dataset has substantial activity. Use case: "your source
// covers India, UK, US — but you have nothing from Brazil,
// Indonesia, or Nigeria, which together account for 14% of
// recent news. Consider adding a source there."
//
// Returns: { source, has_coverage: [{cc, n}], gap_suggestions:
// [{cc, country_name, recent_events_global, gap_score}] }
citiesRoute.get("/sources/:id/coverage/gaps", async (c) => {
  const sourceId = Number(c.req.param("id"));
  if (!Number.isFinite(sourceId)) {
    return c.json({ error: "invalid_source_id" }, 400);
  }
  const sql = getDb();
  const url = new URL(c.req.url);
  const windowDays = Math.max(1, Math.min(90,
    Number(url.searchParams.get("days") ?? 30)));
  const topN = Math.max(1, Math.min(50,
    Number(url.searchParams.get("top") ?? 10)));

  // Source meta.
  const srcRows = await sql<Array<{
    id: number; name: string; country: string;
  }>>`
    SELECT id, name, country FROM news_sources WHERE id = ${sourceId}
  `;
  if (srcRows.length === 0) {
    return c.json({ error: "source_not_found" }, 404);
  }
  const source = srcRows[0];

  // Countries this source covers (last N days, geolocated articles only).
  const sourceCountries = await sql<Array<{
    country: string; articles: number;
  }>>`
    SELECT COALESCE(l.country, '?') AS country, COUNT(*)::int AS articles
    FROM news_articles a
    JOIN news_locations l ON l.id = a.location_id
    WHERE a.source_id = ${sourceId}
      AND a.fetched_at >= now() - (${windowDays} || ' days')::interval
    GROUP BY 1
    ORDER BY articles DESC
  `;
  const coveredSet = new Set(
    sourceCountries.map((r) => r.country).filter(Boolean),
  );

  // Global event activity per country in same window.
  const globalCountry = await sql<Array<{
    country: string; events: number; articles: number;
  }>>`
    SELECT COALESCE(l.country, '?') AS country,
           COUNT(DISTINCT e.id)::int AS events,
           COUNT(*)::int AS articles
    FROM news_events e
    LEFT JOIN news_locations l ON l.id = e.primary_location_id
    WHERE e.first_reported_at >= now() - (${windowDays} || ' days')::interval
      AND e.status = 'active'
      AND l.country IS NOT NULL
    GROUP BY 1
  `;

  // Compose gap suggestions: countries with substantial global activity
  // but zero coverage from this source.
  const gaps = [];
  for (const r of globalCountry) {
    if (coveredSet.has(r.country)) continue;
    if (r.country === '?' || r.country === source.country) continue;
    // Gap score: how much "news hole" this represents for the source.
    // Higher global activity → higher priority.
    const gapScore = Math.log10(Math.max(1, r.events)) * 10;
    gaps.push({
      country: r.country,
      events_global: Number(r.events),
      articles_global: Number(r.articles),
      gap_score: Math.round(gapScore * 10) / 10,
    });
  }
  gaps.sort((a, b) => b.gap_score - a.gap_score);

  return c.json({
    source: { id: Number(source.id), name: source.name, country: source.country },
    window_days: windowDays,
    covered: sourceCountries.slice(0, 20).map((r) => ({
      country: r.country,
      articles: Number(r.articles),
    })),
    suggestions: gaps.slice(0, topN),
    summary: {
      countries_covered: coveredSet.size,
      countries_gap: gaps.length,
      top_suggestion: gaps[0] || null,
    },
  });
});

// ── GET /api/sources/local ──────────────────────────────────────────
//
// Returns news sources geographically near the given lat/lng.
// Used by the "Local" tab in the live news panel so users can
// discover regional sources without searching.
//
// Sources are sorted by distance from the query point. Each source
// includes its recent article count (last 24h) so the frontend can
// show which sources are actively publishing.
citiesRoute.get("/sources/local", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  const radiusKm = Math.min(Number(c.req.query("radius_km") ?? 2000), 10000);
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: "lat,lng required" }, 400);
  }

  const sql = getDb();

  // Haversine distance in SQL — fast enough for ~170 sources.
  const rows = await sql<Array<{
    id: number;
    name: string;
    country: string;
    region: string;
    language: string;
    feed_url: string;
    lat: number;
    lng: number;
    distance_km: number;
    articles_24h: number;
    articles_7d: number;
    last_article_at: Date | null;
  }>>`
    SELECT
      s.id, s.name, s.country, s.region, s.language, s.feed_url,
      s.lat, s.lng,
      (6371 * acos(
        cos(radians(${lat})) * cos(radians(s.lat)) *
        cos(radians(s.lng) - radians(${lng})) +
        sin(radians(${lat})) * sin(radians(s.lat))
      )) AS distance_km,
      COALESCE(a24.n, 0) AS articles_24h,
      COALESCE(a7.n, 0)  AS articles_7d,
      a24.last_at AS last_article_at
    FROM news_sources s
    LEFT JOIN (
      SELECT source_id, COUNT(*) AS n, MAX(fetched_at) AS last_at
      FROM news_articles
      WHERE fetched_at > now() - interval '24 hours'
      GROUP BY source_id
    ) a24 ON a24.source_id = s.id
    LEFT JOIN (
      SELECT source_id, COUNT(*) AS n
      FROM news_articles
      WHERE fetched_at > now() - interval '7 days'
      GROUP BY source_id
    ) a7 ON a7.source_id = s.id
    WHERE s.active = TRUE
      AND s.lat IS NOT NULL AND s.lng IS NOT NULL
      -- Tier 1.4: filter retired sources so they don't leak into public listings.
      AND s.deleted_at IS NULL
    ORDER BY distance_km ASC
    LIMIT ${limit}
  `;

  return c.json({
    lat, lng, radius_km: radiusKm,
    count: rows.length,
    sources: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      country: r.country,
      region: r.region,
      language: r.language,
      feed_url: r.feed_url,
      lat: Number(r.lat),
      lng: Number(r.lng),
      distance_km: Math.round(Number(r.distance_km)),
      articles_24h: Number(r.articles_24h),
      articles_7d: Number(r.articles_7d),
      last_article_at: r.last_article_at instanceof Date
        ? r.last_article_at.toISOString() : r.last_article_at,
    })),
  });
});
