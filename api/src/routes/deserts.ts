import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { getDb } from "../db";

export const desertsRoute = new Hono();

const desertsLimiter = new RateLimiter({ max: 30, windowMs: 60 * 1000 });

const DesertsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  country: z.string().max(50).optional(),
  min_score: z.coerce.number().min(0).max(1).default(0.5),
  has_mainstream: z.enum(["true", "false"]).optional().transform(v => v === "true" ? true : v === "false" ? false : undefined),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().min(1).max(5000).default(300).optional(),
});

// GET /api/deserts — list news deserts
desertsRoute.get("/deserts", zValidator("query", DesertsQuerySchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = desertsLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const q = c.req.valid("query");
  const sql = getDb();

  const hasGeo = Number.isFinite(q.lat) && Number.isFinite(q.lng);
  const lat = q.lat ?? 0;
  const lng = q.lng ?? 0;
  const radiusKm = q.radius ?? 300;
  const latDelta = radiusKm / 111.0;
  const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

  const geoFilter = hasGeo
    ? sql`AND d.lat BETWEEN ${lat - latDelta} AND ${lat + latDelta} AND d.lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}`
    : sql``;

  const countryFilter = q.country
    ? sql`AND d.country_code = ${q.country}`
    : sql``;

  const mainstreamFilter = q.has_mainstream !== undefined
    ? sql`AND d.mainstream_present = ${q.has_mainstream}`
    : sql``;

  let rows: any[];
  let countResult: any[];

  [rows, countResult] = await Promise.all([
    sql`
      SELECT
        d.city_id, d.city_name, d.country_code, d.lat, d.lng, d.population,
        d.source_count, d.mainstream_present,
        d.article_24h, d.article_7d, d.dominant_language,
        d.nearest_source_km, d.coverage_ratio, d.desert_score, d.velocity_score,
        d.last_article_at
      FROM news_deserts d
      WHERE d.desert_score >= ${q.min_score}
        ${countryFilter}
        ${mainstreamFilter}
        ${geoFilter}
      ORDER BY d.desert_score DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM news_deserts d
      WHERE d.desert_score >= ${q.min_score}
        ${countryFilter}
        ${mainstreamFilter}
        ${geoFilter}
    `,
  ]);

  const stats = await sql`
    SELECT
      COUNT(*)::int AS total,
      AVG(d.desert_score)::float AS avg_score,
      MAX(d.desert_score)::float AS max_score,
      COUNT(DISTINCT d.country_code)::int AS country_count,
      AVG(d.population)::int AS avg_population,
      SUM(d.source_count)::int AS total_sources
    FROM news_deserts d
    WHERE d.desert_score >= ${q.min_score}
  `;

  const byCountry: any[] = await sql`
    SELECT
      d.country_code,
      COUNT(*)::int AS city_count,
      AVG(d.desert_score)::float AS avg_score,
      SUM(d.population)::bigint AS total_population
    FROM news_deserts d
    WHERE d.desert_score >= ${q.min_score}
    GROUP BY d.country_code
    ORDER BY city_count DESC
    LIMIT 20
  `;

  return c.json({
    items: rows.map(r => ({
      city_id: Number(r.city_id),
      city_name: r.city_name,
      country_code: r.country_code,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      population: Number(r.population),
      source_count: Number(r.source_count),
      mainstream_present: r.mainstream_present,
      article_24h: Number(r.article_24h),
      article_7d: Number(r.article_7d),
      dominant_language: r.dominant_language,
      nearest_source_km: r.nearest_source_km != null ? Math.round(Number(r.nearest_source_km)) : null,
      coverage_ratio: Number(r.coverage_ratio),
      desert_score: Number(r.desert_score),
      velocity_score: Number(r.velocity_score),
      last_article_at: r.last_article_at,
    })),
    count: Number(countResult[0]?.count ?? 0),
    stats: {
      total: Number(stats[0]?.total ?? 0),
      avg_score: Math.round((Number(stats[0]?.avg_score) || 0) * 1000) / 1000,
      max_score: Number(stats[0]?.max_score ?? 0),
      countries_covered: Number(stats[0]?.country_count ?? 0),
      avg_population: Number(stats[0]?.avg_population ?? 0),
      total_sources: Number(stats[0]?.total_sources ?? 0),
    },
    by_country: byCountry.map(r => ({
      country_code: r.country_code,
      city_count: Number(r.city_count),
      avg_score: Math.round((Number(r.avg_score) || 0) * 1000) / 1000,
      total_population: Number(r.total_population),
    })),
  });
});

// GET /api/deserts/stats — global desert statistics
desertsRoute.get("/deserts/stats", async (c) => {
  const sql = getDb();

  const [global, byType] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS total_deserts,
        AVG(desert_score)::float AS avg_score,
        MAX(desert_score)::float AS max_score,
        COUNT(DISTINCT country_code)::int AS country_count,
        AVG(population)::int AS avg_population,
        SUM(CASE WHEN mainstream_present THEN 1 ELSE 0 END)::int AS with_mainstream,
        SUM(CASE WHEN source_count = 0 THEN 1 ELSE 0 END)::int AS zero_coverage,
        AVG(coverage_ratio)::float AS avg_coverage_ratio,
        AVG(nearest_source_km)::float AS avg_nearest_km
      FROM news_deserts
    `,
    sql`
      SELECT country_code, COUNT(*)::int AS city_count,
        AVG(desert_score)::float AS avg_score,
        AVG(population)::int AS avg_population
      FROM news_deserts
      GROUP BY country_code
      ORDER BY city_count DESC
      LIMIT 20
    `,
  ]);

  return c.json({
    total_deserts: Number(global[0]?.total_deserts ?? 0),
    avg_score: Math.round((Number(global[0]?.avg_score) || 0) * 1000) / 1000,
    max_score: Number(global[0]?.max_score ?? 0),
    country_count: Number(global[0]?.country_count ?? 0),
    avg_population: Number(global[0]?.avg_population ?? 0),
    with_mainstream: Number(global[0]?.with_mainstream ?? 0),
    zero_coverage: Number(global[0]?.zero_coverage ?? 0),
    avg_coverage_ratio: Math.round((Number(global[0]?.avg_coverage_ratio) || 0) * 1000) / 1000,
    avg_nearest_km: Math.round(Number(global[0]?.avg_nearest_km ?? 0)),
    top_countries: byType.map(r => ({
      country_code: r.country_code,
      city_count: Number(r.city_count),
      avg_score: Math.round((Number(r.avg_score) || 0) * 1000) / 1000,
      avg_population: Number(r.avg_population),
    })),
  });
});
