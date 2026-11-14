import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";

export const audioRoute = new Hono();

const audioSearchLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

/** Recursively convert BigInt values to Number for JSON serialization. */
function safeJson(obj: any): any {
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map(safeJson);
  if (obj && typeof obj === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = safeJson(v);
    return out;
  }
  return obj;
}

// ── GET /api/audio/shows ─────────────────────────────────────────────
// List audio shows with optional filters.
audioRoute.get("/audio/shows", async (c) => {
  const q = c.req.query("q") || "";
  const country = c.req.query("country") || "";
  const language = c.req.query("language") || "";
  const category = c.req.query("category") || "";
  const active = c.req.query("active");
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const sql = getDb();

  const conditions: string[] = [];
  const params: any[] = [];

  if (q) {
    conditions.push(`(s.title ILIKE $${params.length + 1} OR s.author ILIKE $${params.length + 1})`);
    params.push(`%${q}%`);
  }
  if (country) {
    conditions.push(`s.country = $${params.length + 1}`);
    params.push(country.toUpperCase());
  }
  if (language) {
    conditions.push(`s.language = $${params.length + 1}`);
    params.push(language.toLowerCase());
  }
  if (category) {
    conditions.push(`$${params.length + 1} = ANY(s.categories)`);
    params.push(category);
  }
  if (active === "true") {
    conditions.push("s.active = TRUE");
  } else if (active === "false") {
    conditions.push("s.active = FALSE");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = await sql.unsafe(`
    SELECT s.id::int, s.title, s.feed_url, s.homepage_url, s.author,
           s.image_url, s.language, s.country, s.region, s.categories,
           s.active, s.episode_count, s.last_success_at, s.last_failure_at,
           s.error_count, s.transcript_available, s.license
    FROM audio_shows s
    ${where}
    ORDER BY s.episode_count DESC NULLS LAST, s.title
    LIMIT $${params.length}
  `, params);

  const countParams = params.slice(0, -1);
  const countWhere = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRow = await sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*) as count FROM audio_shows s ${countWhere}`,
    countParams,
  );

  return c.json(safeJson({
    items: rows,
    count: Number(countRow[0]?.count || 0),
  }));
});

// ── GET /api/audio/shows/:id ─────────────────────────────────────────
// Get a single show with its episodes.
audioRoute.get("/audio/shows/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "invalid_id" }, 400);

  const sql = getDb();

  const [show] = await sql.unsafe<any[]>(
    `SELECT id::int, title, feed_url, homepage_url, description, author,
            author_url, image_url, language, country, region, categories,
            active, episode_count, last_success_at, last_failure_at,
            error_count, transcript_available, license
     FROM audio_shows WHERE id = $1`,
    [id],
  );
  if (!show) return c.json({ error: "not_found" }, 404);

  const episodes = await sql.unsafe(`
    SELECT e.id::int, e.url, e.title, e.description, e.summary, e.published_at,
           e.duration_seconds, e.audio_url, e.image_url, e.status,
           e.location_text, e.event_type, e.entities, e.topic_tags,
           e.hosts, e.guests, e.transcript_available
    FROM audio_episodes e
    WHERE e.show_id = $1
    ORDER BY e.published_at DESC NULLS LAST
    LIMIT 100
  `, [id]);

  return c.json(safeJson({ show, episodes }));
});

// ── GET /api/audio/episodes ──────────────────────────────────────────
// List episodes with optional filters (bbox, category, location, q).
audioRoute.get("/audio/episodes", async (c) => {
  const q = c.req.query("q") || "";
  const showId = c.req.query("show_id");
  const status = c.req.query("status") || "all";
  const category = c.req.query("category") || "";
  const event_type = c.req.query("event_type") || "";
  const country = c.req.query("country") || "";
  const limit = Math.min(Number(c.req.query("limit") || 50), 500);
  const offset = Number(c.req.query("offset") || 0);
  const sql = getDb();

  const conditions: string[] = [];
  const params: any[] = [];

  if (q) {
    conditions.push(`(e.title ILIKE $${params.length + 1} OR e.description ILIKE $${params.length + 1} OR e.summary ILIKE $${params.length + 1})`);
    params.push(`%${q}%`);
  }
  if (showId) {
    conditions.push(`e.show_id = $${params.length + 1}`);
    params.push(Number(showId));
  }
  if (status !== "all") {
    conditions.push(`e.status = $${params.length + 1}`);
    params.push(status);
  }
  if (event_type) {
    conditions.push(`e.event_type = $${params.length + 1}`);
    params.push(event_type);
  }
  if (country) {
    conditions.push(`s.country = $${params.length + 1}`);
    params.push(country.toUpperCase());
  }
  if (category) {
    conditions.push(`$${params.length + 1} = ANY(s.categories)`);
    params.push(category);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit, offset);

  const rows = await sql.unsafe(`
    SELECT e.id::int, e.url, e.title, e.description, e.summary,
           e.published_at, e.duration_seconds, e.audio_url, e.image_url,
           e.status, e.location_text, e.event_type, e.entities, e.topic_tags,
           e.hosts, e.guests, e.transcript_available,
           s.title AS show_title, s.author AS show_author,
           s.image_url AS show_image_url, s.language AS show_language,
           s.country AS show_country, s.categories AS show_categories,
           l.place_name, l.lat AS location_lat, l.lng AS location_lng,
           l.country AS location_country
    FROM audio_episodes e
    JOIN audio_shows s ON s.id = e.show_id
    LEFT JOIN news_locations l ON l.id = e.location_id
    ${where}
    ORDER BY e.published_at DESC NULLS LAST
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  // Count query
  const countParams = params.slice(0, -2);
  const countRow = await sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*) as count
     FROM audio_episodes e
     JOIN audio_shows s ON s.id = e.show_id
     ${where}`,
    countParams,
  );

  return c.json(safeJson({
    items: rows,
    count: Number(countRow[0]?.count || 0),
    limit,
    offset,
  }));
});

// ── GET /api/audio/episodes/:id ──────────────────────────────────────
// Get a single episode with full details.
audioRoute.get("/audio/episodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "invalid_id" }, 400);

  const sql = getDb();

  const [episode] = await sql.unsafe<any[]>(
    `SELECT e.id::int, e.url, e.title, e.description, e.summary,
            e.published_at, e.duration_seconds, e.audio_url, e.image_url,
            e.status, e.location_text, e.event_type, e.entities, e.topic_tags,
            e.hosts, e.guests, e.transcript_available, e.extracted_lat, e.extracted_lng,
            s.title AS show_title, s.author AS show_author,
            s.image_url AS show_image_url, s.language AS show_language,
            s.country AS show_country, s.categories AS show_categories,
            s.homepage_url AS show_homepage_url,
            l.place_name, l.lat AS location_lat, l.lng AS location_lng,
            l.country AS location_country, l.precision AS location_precision
     FROM audio_episodes e
     JOIN audio_shows s ON s.id = e.show_id
     LEFT JOIN news_locations l ON l.id = e.location_id
     WHERE e.id = $1`,
    [id],
  );
  if (!episode) return c.json({ error: "not_found" }, 404);

  // Get people
  const people = await sql.unsafe(`
    SELECT p.name, p.role, p.organization, ep.role AS episode_role
    FROM audio_episode_people ep
    JOIN audio_people p ON p.id = ep.person_id
    WHERE ep.episode_id = $1
  `, [id]);

  // Get claims
  const claims = await sql.unsafe(`
    SELECT id::int, claim_text, speaker, confidence, verified
    FROM audio_claims
    WHERE episode_id = $1
  `, [id]);

  // Get topics
  const topics = await sql.unsafe(`
    SELECT t.slug, t.label
    FROM audio_episode_topics et
    JOIN audio_topics t ON t.id = et.topic_id
    WHERE et.episode_id = $1
  `, [id]);

  return c.json(safeJson({ episode, people, claims, topics }));
});

// ── GET /api/audio/map ───────────────────────────────────────────────
// Map viewport query: episodes within a bounding box.
audioRoute.get("/audio/map", async (c) => {
  const bbox = c.req.query("bbox") || "";
  const category = c.req.query("category") || "";
  const event_type = c.req.query("event_type") || "";
  const limit = Math.min(Number(c.req.query("limit") || 500), 5000);
  const sql = getDb();

  if (!bbox) return c.json({ error: "bbox_required" }, 400);

  const [west, south, east, north] = bbox.split(",").map(Number);
  if ([west, south, east, north].some(isNaN)) {
    return c.json({ error: "invalid_bbox" }, 400);
  }

  const conditions: string[] = [
    `e.extracted_lat BETWEEN $1 AND $3`,
    `e.extracted_lng BETWEEN $2 AND $4`,
    `e.extracted_lat IS NOT NULL`,
    `e.extracted_lng IS NOT NULL`,
    `e.status != 'failed'`,
  ];
  const params: any[] = [south, west, north, east];

  if (event_type) {
    conditions.push(`e.event_type = $${params.length + 1}`);
    params.push(event_type);
  }
  if (category) {
    conditions.push(`$${params.length + 1} = ANY(s.categories)`);
    params.push(category);
  }

  params.push(limit);

  const rows = await sql.unsafe(`
    SELECT e.id::int, e.url, e.title, e.summary, e.published_at,
           e.duration_seconds, e.image_url, e.event_type,
           e.topic_tags, e.hosts, e.guests,
           e.extracted_lat AS lat, e.extracted_lng AS lng,
           e.location_text, e.extracted_location,
           s.title AS show_title, s.author AS show_author,
           s.image_url AS show_image_url, s.language AS show_language,
           s.country AS show_country
    FROM audio_episodes e
    JOIN audio_shows s ON s.id = e.show_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.published_at DESC NULLS LAST
    LIMIT $${params.length}
  `, params);

  return c.json(safeJson({ items: rows, count: rows.length }));
});

// ── GET /api/audio/location/:placeName ───────────────────────────────
// "Audio Around Here" — topics and episodes for a location.
audioRoute.get("/audio/location/:placeName", async (c) => {
  const placeName = c.req.param("placeName");
  const limit = Math.min(Number(c.req.query("limit") || 20), 100);
  const sql = getDb();

  // Find location
  const [loc] = await sql.unsafe<any[]>(
    `SELECT id::int, place_name, country, lat, lng
     FROM news_locations
     WHERE place_name ILIKE $1
        OR place_name_normalized ILIKE $2
     ORDER BY confidence DESC NULLS LAST
     LIMIT 1`,
    [placeName, placeName.toLowerCase().trim()],
  );
  if (!loc) return c.json({ error: "location_not_found" }, 404);

  // Get topic counts
  const topics = await sql.unsafe(`
    SELECT t.slug, t.label, COUNT(DISTINCT e.id) AS episode_count,
           MAX(e.published_at) AS latest_episode_at
    FROM audio_episodes e
    JOIN audio_episode_topics et ON et.episode_id = e.id
    JOIN audio_topics t ON t.id = et.topic_id
    WHERE e.location_id = $1
      AND e.status != 'failed'
    GROUP BY t.slug, t.label
    ORDER BY episode_count DESC
    LIMIT $2
  `, [loc.id, limit]);

  // Get recent episodes
  const episodes = await sql.unsafe(`
    SELECT e.id::int, e.url, e.title, e.summary, e.published_at,
           e.duration_seconds, e.image_url, e.event_type,
           s.title AS show_title, s.author AS show_author,
           s.image_url AS show_image_url
    FROM audio_episodes e
    JOIN audio_shows s ON s.id = e.show_id
    WHERE e.location_id = $1
      AND e.status != 'failed'
    ORDER BY e.published_at DESC NULLS LAST
    LIMIT $2
  `, [loc.id, limit]);

  // Total count
  const [countRow] = await sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*) as count FROM audio_episodes
     WHERE location_id = $1 AND status != 'failed'`,
    [loc.id],
  );

  return c.json(safeJson({
    location: loc,
    episode_count: Number(countRow?.count || 0),
    topics,
    episodes,
  }));
});

// ── GET /api/audio/stats ─────────────────────────────────────────────
// Aggregate statistics about the audio collection.
audioRoute.get("/audio/stats", async (c) => {
  const sql = getDb();

  const [showCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM audio_shows
  `;
  const [activeShowCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM audio_shows WHERE active = TRUE
  `;
  const [episodeCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM audio_episodes
  `;
  const [extractedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM audio_episodes WHERE status = 'extracted'
  `;
  const [pendingCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM audio_episodes WHERE status = 'pending'
  `;
  const [failedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM audio_episodes WHERE status = 'failed'
  `;

  // By language
  const byLanguage = await sql<{ language: string; count: string }[]>`
    SELECT s.language, COUNT(*) as count
    FROM audio_shows s
    WHERE s.language IS NOT NULL AND s.active = TRUE
    GROUP BY s.language
    ORDER BY count DESC
    LIMIT 20
  `;

  // By country
  const byCountry = await sql<{ country: string; count: string }[]>`
    SELECT s.country, COUNT(*) as count
    FROM audio_shows s
    WHERE s.country IS NOT NULL AND s.active = TRUE
    GROUP BY s.country
    ORDER BY count DESC
    LIMIT 30
  `;

  // By category
  const byCategory = await sql<{ category: string; count: string }[]>`
    SELECT cat AS category, COUNT(*) as count
    FROM audio_shows s, unnest(s.categories) AS cat
    WHERE s.active = TRUE
    GROUP BY cat
    ORDER BY count DESC
    LIMIT 20
  `;

  return c.json(safeJson({
    shows: {
      total: Number(showCount?.count || 0),
      active: Number(activeShowCount?.count || 0),
    },
    episodes: {
      total: Number(episodeCount?.count || 0),
      extracted: Number(extractedCount?.count || 0),
      pending: Number(pendingCount?.count || 0),
      failed: Number(failedCount?.count || 0),
    },
    by_language: byLanguage.map(r => ({ language: r.language, count: Number(r.count) })),
    by_country: byCountry.map(r => ({ country: r.country, count: Number(r.count) })),
    by_category: byCategory.map(r => ({ category: r.category, count: Number(r.count) })),
  }));
});

// ── GET /api/audio/people ────────────────────────────────────────────
// List people discovered in audio episodes.
audioRoute.get("/audio/people", async (c) => {
  const q = c.req.query("q") || "";
  const role = c.req.query("role") || "";
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const sql = getDb();

  const conditions: string[] = [];
  const params: any[] = [];

  if (q) {
    conditions.push(`(p.name ILIKE $${params.length + 1} OR p.normalized_name ILIKE $${params.length + 1})`);
    params.push(`%${q}%`);
  }
  if (role) {
    conditions.push(`p.role = $${params.length + 1}`);
    params.push(role);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = await sql.unsafe(`
    SELECT p.id::int, p.name, p.role, p.organization, p.episode_count, p.last_seen_at
    FROM audio_people p
    ${where}
    ORDER BY p.episode_count DESC NULLS LAST, p.name
    LIMIT $${params.length}
  `, params);

  return c.json(safeJson({ items: rows, count: rows.length }));
});

// ── GET /api/audio/topics ────────────────────────────────────────────
// List audio topics with episode counts.
audioRoute.get("/audio/topics", async (c) => {
  const sql = getDb();

  const rows = await sql<{ slug: string; label: string; count: string }[]>`
    SELECT t.slug, t.label, COUNT(et.episode_id) as count
    FROM audio_topics t
    LEFT JOIN audio_episode_topics et ON et.topic_id = t.id
    GROUP BY t.slug, t.label
    ORDER BY count DESC, t.label
  `;

  return c.json(safeJson({
    items: rows.map(r => ({ slug: r.slug, label: r.label, count: Number(r.count) })),
  }));
});

// ── POST /api/audio/fetch ────────────────────────────────────────────
// Trigger an audio fetch cycle (admin only).
audioRoute.post("/audio/fetch", async (c) => {
  const sql = getDb();

  // Simple admin check (could use adminAuth middleware)
  const key = c.req.header("X-Admin-Key");
  if (!key) return c.json({ error: "admin_required" }, 401);

  const [adminRow] = await sql<{ id: number }[]>`
    SELECT id FROM admin_keys WHERE key_hash = md5(${key}) AND role IN ('admin', 'super') LIMIT 1
  `;
  if (!adminRow) return c.json({ error: "invalid_key" }, 401);

  // Enqueue audio fetch job
  const { enqueueOrSpawn } = await import("../queue/enqueueOrSpawn");
  const job = await enqueueOrSpawn("audio_fetch", {});
  return c.json({ ok: true, job_id: job.id });
});

// ── GET /api/audio/search ────────────────────────────────────────────
// Full-text search across shows and episodes.
audioRoute.get("/audio/search", async (c) => {
  const q = c.req.query("q") || "";
  const limit = Math.min(Number(c.req.query("limit") || 20), 100);
  const sql = getDb();

  // Rate limit check
  const rl = audioSearchLimiter.check(getClientIp(c.req.raw));
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  if (!q.trim()) return c.json({ shows: [], episodes: [] });

  const shows = await sql.unsafe(`
    SELECT id::int, title, author, image_url, country, language, categories, episode_count
    FROM audio_shows
    WHERE title ILIKE $1 OR author ILIKE $1 OR description ILIKE $1
    ORDER BY episode_count DESC NULLS LAST
    LIMIT $2
  `, [`%${q}%`, limit]);

  const episodes = await sql.unsafe(`
    SELECT e.id::int, e.url, e.title, e.summary, e.published_at, e.image_url,
           e.event_type, e.topic_tags,
           s.title AS show_title, s.image_url AS show_image_url,
           s.country AS show_country
    FROM audio_episodes e
    JOIN audio_shows s ON s.id = e.show_id
    WHERE e.title ILIKE $1 OR e.description ILIKE $1 OR e.summary ILIKE $1
       OR $3 = ANY(e.topic_tags) OR $3 = ANY(e.entities)
    ORDER BY e.published_at DESC NULLS LAST
    LIMIT $2
  `, [`%${q}%`, limit, q]);

  return c.json(safeJson({ shows, episodes }));
});
