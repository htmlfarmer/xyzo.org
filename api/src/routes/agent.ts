/**
 * Agent-to-Agent API — Open endpoints for AI bots and news aggregators
 *
 * Designed for:
 * - Other news AI systems that want to query our event data
 * - News aggregators that want to contribute sources
 * - Collaborative intelligence between Xyzo and other platforms
 *
 * Design principles:
 * - Read endpoints are CHEAP (use cache, no joins, limited rows)
 * - Write endpoints are RATE-LIMITED (10/hour per IP)
 * - All responses are compact JSON (no unnecessary nesting)
 * - CORS headers allow browser-based bots
 * - No authentication required for reads (it's public data anyway)
 *
 * Rate limits:
 * - GET /api/agent/*: 60 requests/minute per IP
 * - POST /api/agent/*: 10 requests/hour per IP
 *
 * Usage:
 *   curl https://xyzo.org/api/agent/events?lat=40.7&lng=-74.0&radius=50&limit=10
 *   curl https://xyzo.org/api/agent/health
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter } from "../ratelimit";

export const agentRoute = new Hono();

// Rate limiters — generous for reads, tight for writes
const readLimiter = new RateLimiter({ max: 60, windowMs: 60_000 });
const writeLimiter = new RateLimiter({ max: 10, windowMs: 3_600_000 });

// CORS for browser-based bots
agentRoute.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, User-Agent");
  if (c.req.method === "OPTIONS") return c.text("", 204);
  await next();
});

// ── GET /api/agent/health ──────────────────────────────────────────
// Lightweight health check. Returns system status without DB hit.
agentRoute.get("agent/health", async (c) => {
  return c.json({
    status: "ok",
    service: "xyzo-agent-api",
    version: "1.0.0",
    endpoints: {
      health: "GET /api/agent/health",
      events: "GET /api/agent/events?lat=&lng=&radius=&limit=",
      search: "GET /api/agent/search?q=&limit=",
      contribute: "POST /api/agent/contribute",
    },
    docs: "https://xyzo.org/help/",
  });
});

// ── GET /api/agent/events ──────────────────────────────────────────
// Fetch events near a location. The bread-and-butter endpoint.
// Returns compact event data optimized for machine consumption.
const eventsQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().min(1).max(2000).default(100),
  limit: z.coerce.number().min(1).max(100).default(20),
  since: z.string().optional(),
  category: z.string().optional(),
});

agentRoute.get("agent/events", zValidator("query", eventsQuerySchema), async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!readLimiter.check(ip).allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: readLimiter.check(ip).retryAfterMs }, 429);
  }

  const q = c.req.valid("query");
  const sql = getDb();

  const rows = await sql`
    SELECT e.id, e.headline, e.event_type, e.source_count,
           e.first_reported_at, e.expires_at,
           l.lat, l.lng, l.place_name, l.country
    FROM news_events e
    JOIN news_locations l ON l.id = e.primary_location_id
    WHERE e.status = 'active'
      AND (e.expires_at IS NULL OR e.expires_at > now())
      AND l.geom IS NOT NULL
      AND ST_DWithin(
        l.geom,
        ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography,
        ${q.radius * 1000}
      )
      ${q.category ? sql`AND e.event_type = ${q.category}` : sql``}
      ${q.since ? sql`AND e.first_reported_at >= ${new Date(q.since)}` : sql``}
    ORDER BY e.source_count DESC, e.first_reported_at DESC
    LIMIT ${q.limit}
  `;

  return c.json({
    events: rows.map((r) => ({
      id: Number(r.id),
      headline: r.headline,
      category: r.event_type,
      sources: Number(r.source_count),
      location: {
        lat: Number(r.lat),
        lng: Number(r.lng),
        name: r.place_name,
        country: r.country,
      },
      published: r.first_reported_at?.toISOString() || null,
      expires: r.expires_at?.toISOString() || null,
    })),
    count: rows.length,
    query: { lat: q.lat, lng: q.lng, radius_km: q.radius },
  });
});

// ── GET /api/agent/search ──────────────────────────────────────────
// Full-text search across events. Good for topic-based queries.
const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().min(1).max(50).default(10),
  category: z.string().optional(),
});

agentRoute.get("agent/search", zValidator("query", searchQuerySchema), async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!readLimiter.check(ip).allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: readLimiter.check(ip).retryAfterMs }, 429);
  }

  const q = c.req.valid("query");
  const sql = getDb();

  const rows = await sql`
    SELECT e.id, e.headline, e.event_type, e.source_count,
           e.first_reported_at,
           l.lat, l.lng, l.place_name, l.country,
           ts_rank(e.headline_fts, plainto_tsquery('english', ${q.q})) AS rank
    FROM news_events e
    JOIN news_locations l ON l.id = e.primary_location_id
    WHERE e.status = 'active'
      AND (e.expires_at IS NULL OR e.expires_at > now())
      AND e.headline_fts @@ plainto_tsquery('english', ${q.q})
      ${q.category ? sql`AND e.event_type = ${q.category}` : sql``}
    ORDER BY rank DESC, e.source_count DESC
    LIMIT ${q.limit}
  `;

  return c.json({
    events: rows.map((r) => ({
      id: Number(r.id),
      headline: r.headline,
      category: r.event_type,
      sources: Number(r.source_count),
      location: {
        lat: Number(r.lat),
        lng: Number(r.lng),
        name: r.place_name,
        country: r.country,
      },
      published: r.first_reported_at?.toISOString() || null,
    })),
    count: rows.length,
    query: q.q,
  });
});

// ── GET /api/agent/stats ───────────────────────────────────────────
// Quick system stats. No auth, no heavy queries.
agentRoute.get("agent/stats", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!readLimiter.check(ip).allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const sql = getDb();
  const [events, articles, sources, countries] = await Promise.all([
    sql`SELECT COUNT(*) as n FROM news_events WHERE status = 'active'`,
    sql`SELECT COUNT(*) as n FROM news_articles WHERE status IN ('extracted', 'processed')`,
    sql`SELECT COUNT(*) as n FROM news_sources WHERE active = TRUE`,
    sql`SELECT COUNT(DISTINCT country) as n FROM news_locations WHERE country IS NOT NULL`,
  ]);

  return c.json({
    events: Number(events[0]?.n ?? 0),
    articles: Number(articles[0]?.n ?? 0),
    sources: Number(sources[0]?.n ?? 0),
    countries: Number(countries[0]?.n ?? 0),
    updated_at: new Date().toISOString(),
  });
});

// ── POST /api/agent/contribute ─────────────────────────────────────
// Submit a news source URL for consideration. Rate-limited.
// This is how other AIs can help us discover new sources.
const contributeSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(200).optional(),
  country: z.string().length(2).optional(),
  description: z.string().max(500).optional(),
});

agentRoute.post("agent/contribute", zValidator("json", contributeSchema), async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const gate = writeLimiter.check(ip);
  if (!gate.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: gate.retryAfterMs }, 429);
  }

  const data = c.req.valid("json");
  const ua = c.req.header("user-agent") || "unknown-bot";
  const sql = getDb();

  // Check if URL already exists
  const existing = await sql`
    SELECT id, active FROM news_sources WHERE feed_url = ${data.url} OR homepage_url = ${data.url}
  `;
  if (existing.length > 0) {
    return c.json({
      ok: true,
      status: "already_known",
      source_id: Number(existing[0].id),
      active: existing[0].active,
      message: "This source is already in our database.",
    });
  }

  // Queue for review (don't auto-add — let humans verify)
  await sql`
    INSERT INTO feedback_source_suggestions
      (source_url, source_name, country_code, description, session_id, requester_ip, user_agent)
    VALUES (
      ${data.url},
      ${data.name || null},
      ${data.country || null},
      ${data.description || null},
      ${`agent-${ua.slice(0, 50)}`},
      ${ip === "unknown" ? null : ip}::inet, -- FIX_NOTES 4.30: 'unknown'::inet threw without proxy headers
      ${ua}
    )
  `;

  return c.json({
    ok: true,
    status: "submitted",
    message: "Source submitted for review. Thank you for contributing!",
  });
});

// ── GET /api/agent/categories ──────────────────────────────────────
// List available event categories with counts. Useful for filtering.
agentRoute.get("agent/categories", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!readLimiter.check(ip).allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const sql = getDb();
  const rows = await sql`
    SELECT event_type, COUNT(*) as count
    FROM news_events
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
    GROUP BY event_type
    ORDER BY count DESC
  `;

  return c.json({
    categories: rows.map((r) => ({
      id: r.event_type,
      count: Number(r.count),
    })),
  });
});

// ── GET /api/agent/countries ───────────────────────────────────────
// List countries with event counts. Good for coverage analysis.
agentRoute.get("agent/countries", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!readLimiter.check(ip).allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const sql = getDb();
  const rows = await sql`
    SELECT l.country, COUNT(DISTINCT e.id) as events
    FROM news_events e
    JOIN news_locations l ON l.id = e.primary_location_id
    WHERE e.status = 'active'
      AND (e.expires_at IS NULL OR e.expires_at > now())
      AND l.country IS NOT NULL
    GROUP BY l.country
    ORDER BY events DESC
    LIMIT 50
  `;

  return c.json({
    countries: rows.map((r) => ({
      code: r.country,
      events: Number(r.events),
    })),
  });
});
