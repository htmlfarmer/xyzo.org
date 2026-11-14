import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { getDb } from "../db";

export const undercoverRoute = new Hono();

const undercoverLimiter = new RateLimiter({ max: 30, windowMs: 60 * 1000 });

const UndercoverQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  country: z.string().max(50).optional(),
  min_score: z.coerce.number().min(0).max(100).default(40),
  signal: z.string().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().min(1).max(5000).default(300).optional(),
});

const UNDERCOVER_SELECT = sql => sql`
  u.undercover_score,
  u.signals,
  u.article_count::int AS article_count,
  u.source_count::int AS source_count,
  u.country_count::int AS country_count,
  u.language_count::int AS language_count,
  u.local_source_count::int AS local_source_count,
  u.mainstream_count::int AS mainstream_count,
  u.velocity_6h::int AS velocity_6h,
  u.first_covered_at,
  u.latest_article_at,
  u.event_country,
  e.id::int AS event_id,
  e.headline,
  e.event_type,
  e.first_reported_at,
  e.occurred_at,
  e.status AS event_status,
  l.lat,
  l.lng,
  l.place_name AS location_name
`;

// GET /api/undercover — list undercovered events
undercoverRoute.get("/undercover", zValidator("query", UndercoverQuerySchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = undercoverLimiter.check(ip);
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

  const geoJoin = hasGeo
    ? sql`LEFT JOIN news_locations l ON l.id = e.primary_location_id`
    : sql`LEFT JOIN news_locations l ON l.id = e.primary_location_id`;
  const geoFilter = hasGeo
    ? sql`AND l.lat BETWEEN ${lat - latDelta} AND ${lat + latDelta} AND l.lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}`
    : sql``;

  const countryFilter = q.country
    ? sql`AND u.event_country = ${q.country}`
    : sql``;

  const signalFilter = q.signal
    ? sql`AND ${q.signal} = ANY(u.signals)`
    : sql``;

  let rows: any[];
  let countResult: any[];

  [rows, countResult] = await Promise.all([
    sql`
      SELECT ${UNDERCOVER_SELECT(sql)}
      FROM news_undercovered u
      JOIN news_events e ON e.id = u.event_id
      ${geoJoin}
      WHERE u.undercover_score >= ${q.min_score}
        ${countryFilter}
        ${signalFilter}
        ${geoFilter}
      ORDER BY u.undercover_score DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `,
    sql`
      SELECT COUNT(*)::int AS count FROM news_undercovered u
      JOIN news_events e ON e.id = u.event_id
      ${geoJoin}
      WHERE u.undercover_score >= ${q.min_score}
        ${countryFilter}
        ${signalFilter}
        ${geoFilter}
    `,
  ]);

  const stats = await sql`
    SELECT
      COUNT(*)::int AS total,
      AVG(undercover_score) AS avg_score,
      MAX(undercover_score) AS max_score,
      COUNT(DISTINCT event_country)::int AS country_count
    FROM news_undercovered
  `;

  return c.json({
    items: rows.map(r => ({
      event_id: r.event_id,
      headline: r.headline,
      event_type: r.event_type,
      event_status: r.event_status,
      first_reported_at: r.first_reported_at,
      occurred_at: r.occurred_at,
      score: Number(r.undercover_score),
      signals: r.signals || [],
      article_count: Number(r.article_count),
      source_count: Number(r.source_count),
      country_count: Number(r.country_count),
      language_count: Number(r.language_count),
      local_source_count: Number(r.local_source_count),
      mainstream_count: Number(r.mainstream_count),
      velocity_6h: Number(r.velocity_6h),
      first_covered_at: r.first_covered_at,
      latest_article_at: r.latest_article_at,
      event_country: r.event_country,
      location_name: r.location_name,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
    })),
    count: Number(countResult[0]?.count ?? 0),
    stats: {
      total: Number(stats[0]?.total ?? 0),
      avg_score: Math.round((Number(stats[0]?.avg_score) || 0) * 10) / 10,
      max_score: Number(stats[0]?.max_score ?? 0),
      countries_covered: Number(stats[0]?.country_count ?? 0),
    },
  });
});

// GET /api/undercover/signals — list all signals with counts
undercoverRoute.get("/undercover/signals", async (c) => {
  const sql = getDb();

  const rows: any[] = await sql`
    SELECT unnest(signals) AS signal, COUNT(*) AS cnt
    FROM news_undercovered
    GROUP BY signal
    ORDER BY cnt DESC
  `;

  return c.json({
    items: rows.map(r => ({
      signal: r.signal,
      count: Number(r.cnt),
    })),
  });
});

// GET /api/undercover/countries — coverage by country
undercoverRoute.get("/undercover/countries", async (c) => {
  const sql = getDb();

  const rows: any[] = await sql`
    SELECT
      COALESCE(u.event_country, 'XX') AS country,
      COUNT(*) AS event_count,
      AVG(u.undercover_score) AS avg_score,
      SUM(u.article_count) AS total_articles,
      SUM(u.source_count) AS total_sources
    FROM news_undercovered u
    GROUP BY u.event_country
    ORDER BY event_count DESC
    LIMIT 50
  `;

  return c.json({
    items: rows.map(r => ({
      country: r.country,
      event_count: Number(r.event_count),
      avg_score: Math.round((Number(r.avg_score) || 0) * 10) / 10,
      total_articles: Number(r.total_articles),
      total_sources: Number(r.total_sources),
    })),
  });
});
