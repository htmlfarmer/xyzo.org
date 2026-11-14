import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter } from "../ratelimit";

export const videoRoute = new Hono();

const videoSearchLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

// ── Schemas ─────────────────────────────────────────────────────────────

const VideoListQuerySchema = z.object({
  q: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  video_type: z.string().optional(),
  topic: z.string().optional(),
  channel_id: z.coerce.number().optional(),
  status: z.enum(["pending", "transcribed", "extracted", "failed", "all"]).optional(),
  bbox: z.string().optional(), // minLng,minLat,maxLng,maxLat
  since: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).optional(),
  offset: z.coerce.number().min(0).optional(),
});

const VideoChannelQuerySchema = z.object({
  q: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  platform: z.string().optional(),
  source_type: z.string().optional(),
  active: z.coerce.boolean().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ── GET /api/video/channels ─────────────────────────────────────────────

videoRoute.get("/video/channels", zValidator("query", VideoChannelQuerySchema), async (c) => {
  const q = c.req.valid("query");
  const sql = getDb();
  const limit = Math.min(q.limit ?? 50, 200);
  const offset = q.offset ?? 0;

  const conditions: string[] = ["1=1"];
  const params: any[] = [];

  if (q.q) {
    params.push(`%${q.q}%`);
    conditions.push(`(c.name ILIKE $${params.length} OR c.description ILIKE $${params.length})`);
  }
  if (q.country) {
    params.push(q.country.toUpperCase());
    conditions.push(`c.country = $${params.length}`);
  }
  if (q.region) {
    params.push(`%${q.region}%`);
    conditions.push(`c.region ILIKE $${params.length}`);
  }
  if (q.platform) {
    params.push(q.platform);
    conditions.push(`c.platform = $${params.length}`);
  }
  if (q.source_type) {
    params.push(q.source_type);
    conditions.push(`c.source_type = $${params.length}`);
  }
  if (q.active !== undefined) {
    params.push(q.active);
    conditions.push(`c.active = $${params.length}`);
  }

  const where = conditions.join(" AND ");
  params.push(limit, offset);

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) as count FROM video_channels c WHERE ${where}`,
    params.slice(0, -2),
  );
  const total = Number(countResult[0]?.count ?? 0);

  const rows = await sql.unsafe(
    `SELECT c.id, c.name, c.platform, c.channel_id, c.channel_url,
            c.country, c.region, c.languages, c.categories, c.source_type,
            c.subscriber_count, c.video_count, c.active,
            c.last_success_at, c.last_failure_at, c.error_count,
            (SELECT COUNT(*) FROM video_items v WHERE v.channel_id = c.id) AS total_videos,
            (SELECT COUNT(*) FROM video_items v WHERE v.channel_id = c.id AND v.status = 'extracted') AS extracted_videos
     FROM video_channels c
     WHERE ${where}
     ORDER BY c.name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return c.json({
    items: rows.map((r: any) => ({
      id: Number(r.id),
      name: r.name,
      platform: r.platform,
      channel_id: r.channel_id,
      channel_url: r.channel_url,
      country: r.country,
      region: r.region,
      languages: r.languages,
      categories: r.categories,
      source_type: r.source_type,
      subscriber_count: r.subscriber_count ? Number(r.subscriber_count) : null,
      video_count: r.video_count ? Number(r.video_count) : null,
      active: r.active,
      total_videos: Number(r.total_videos),
      extracted_videos: Number(r.extracted_videos),
      last_success_at: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
      last_failure_at: r.last_failure_at ? new Date(r.last_failure_at).toISOString() : null,
      error_count: r.error_count,
    })),
    count: total,
  });
});

// ── GET /api/video/channels/:id ─────────────────────────────────────────

videoRoute.get("/video/channels/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const sql = getDb();

  const [channel] = await sql`
    SELECT * FROM video_channels WHERE id = ${id}
  `;

  if (!channel) {
    return c.json({ error: "not_found" }, 404);
  }

  // Get recent videos for this channel
  const videos = await sql`
    SELECT v.id, v.video_id, v.platform, v.url, v.title, v.summary,
           v.published_at, v.duration_seconds, v.thumbnail_url,
           v.video_type, v.status, v.view_count,
           v.location_text, v.event_type, v.topic_tags, v.speakers
    FROM video_items v
    WHERE v.channel_id = ${id}
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT 50
  `;

  return c.json({
    channel: {
      id: Number(channel.id),
      name: channel.name,
      platform: channel.platform,
      channel_id: channel.channel_id,
      channel_url: channel.channel_url,
      website_url: channel.website_url,
      feed_url: channel.feed_url,
      description: channel.description,
      country: channel.country,
      region: channel.region,
      languages: channel.languages,
      categories: channel.categories,
      source_type: channel.source_type,
      subscriber_count: channel.subscriber_count ? Number(channel.subscriber_count) : null,
      video_count: channel.video_count ? Number(channel.video_count) : null,
      active: channel.active,
      last_success_at: channel.last_success_at ? new Date(channel.last_success_at).toISOString() : null,
      last_failure_at: channel.last_failure_at ? new Date(channel.last_failure_at).toISOString() : null,
      error_count: channel.error_count,
    },
    videos: videos.map((v: any) => ({
      id: Number(v.id),
      video_id: v.video_id,
      platform: v.platform,
      url: v.url,
      title: v.title,
      summary: v.summary,
      published_at: v.published_at ? new Date(v.published_at).toISOString() : null,
      duration_seconds: v.duration_seconds,
      thumbnail_url: v.thumbnail_url,
      video_type: v.video_type,
      status: v.status,
      view_count: v.view_count ? Number(v.view_count) : null,
      location_text: v.location_text,
      event_type: v.event_type,
      topic_tags: v.topic_tags,
      speakers: v.speakers,
    })),
  });
});

// ── GET /api/video/videos ───────────────────────────────────────────────

videoRoute.get("/video/videos", zValidator("query", VideoListQuerySchema), async (c) => {
  const q = c.req.valid("query");
  const sql = getDb();
  const limit = Math.min(q.limit ?? 50, 500);
  const offset = q.offset ?? 0;

  const conditions: string[] = ["1=1"];
  const params: any[] = [];

  if (q.q) {
    params.push(`%${q.q}%`);
    conditions.push(`(v.title ILIKE $${params.length} OR v.summary ILIKE $${params.length} OR v.description ILIKE $${params.length})`);
  }
  if (q.country) {
    params.push(q.country.toUpperCase());
    conditions.push(`c.country = $${params.length}`);
  }
  if (q.region) {
    params.push(`%${q.region}%`);
    conditions.push(`c.region ILIKE $${params.length}`);
  }
  if (q.video_type) {
    params.push(q.video_type);
    conditions.push(`v.video_type = $${params.length}`);
  }
  if (q.topic) {
    params.push(q.topic);
    conditions.push(`$${params.length} = ANY(v.topic_tags)`);
  }
  if (q.channel_id) {
    params.push(q.channel_id);
    conditions.push(`v.channel_id = $${params.length}`);
  }
  if (q.status && q.status !== "all") {
    params.push(q.status);
    conditions.push(`v.status = $${params.length}`);
  }
  if (q.since) {
    params.push(q.since);
    conditions.push(`v.published_at >= $${params.length}`);
  }
  if (q.bbox) {
    const [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
    conditions.push(`l.geom::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)`);
  }

  const where = conditions.join(" AND ");
  params.push(limit, offset);

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) as count
     FROM video_items v
     JOIN video_channels c ON c.id = v.channel_id
     LEFT JOIN news_locations l ON l.id = v.location_id
     WHERE ${where}`,
    params.slice(0, -2),
  );
  const total = Number(countResult[0]?.count ?? 0);

  const rows = await sql.unsafe(
    `SELECT v.id, v.video_id, v.platform, v.url, v.title, v.summary,
            v.published_at, v.duration_seconds, v.thumbnail_url, v.embed_url,
            v.video_type, v.status, v.view_count, v.like_count,
            v.transcript_available, v.speakers,
            v.location_text, v.event_type, v.topic_tags, v.entities,
            v.extracted_lat, v.extracted_lng,
            c.name AS channel_name, c.country AS channel_country,
            l.place_name, l.lat, l.lng, l.country AS location_country
     FROM video_items v
     JOIN video_channels c ON c.id = v.channel_id
     LEFT JOIN news_locations l ON l.id = v.location_id
     WHERE ${where}
     ORDER BY v.published_at DESC NULLS LAST, v.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return c.json({
    items: rows.map((r: any) => ({
      id: Number(r.id),
      video_id: r.video_id,
      platform: r.platform,
      url: r.url,
      title: r.title,
      summary: r.summary,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      duration_seconds: r.duration_seconds,
      thumbnail_url: r.thumbnail_url,
      embed_url: r.embed_url,
      video_type: r.video_type,
      status: r.status,
      view_count: r.view_count ? Number(r.view_count) : null,
      like_count: r.like_count ? Number(r.like_count) : null,
      transcript_available: r.transcript_available,
      speakers: r.speakers,
      location_text: r.location_text,
      event_type: r.event_type,
      topic_tags: r.topic_tags,
      entities: r.entities,
      channel_name: r.channel_name,
      channel_country: r.channel_country,
      location: (r.lat != null && r.lng != null)
        ? { lat: Number(r.lat), lng: Number(r.lng), place_name: r.place_name, country: r.location_country }
        : (r.extracted_lat != null && r.extracted_lng != null)
        ? { lat: Number(r.extracted_lat), lng: Number(r.extracted_lng), place_name: r.location_text, country: r.channel_country }
        : (r.location_text ? { place_name: r.location_text, country: r.channel_country } : null),
    })),
    count: total,
  });
});

// ── GET /api/video/videos/:id ───────────────────────────────────────────

videoRoute.get("/video/videos/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const sql = getDb();

  const [video] = await sql`
    SELECT v.*, c.name AS channel_name, c.platform AS channel_platform,
           c.country AS channel_country, c.channel_url,
           l.place_name, l.lat, l.lng, l.country AS location_country
    FROM video_items v
    JOIN video_channels c ON c.id = v.channel_id
    LEFT JOIN news_locations l ON l.id = v.location_id
    WHERE v.id = ${id}
  `;

  if (!video) {
    return c.json({ error: "not_found" }, 404);
  }

  // Get matched articles
  const matchedArticles = await sql`
    SELECT a.id, a.title, a.url, a.published_at,
           m.similarity, m.same_event, m.same_location
    FROM video_article_matches m
    JOIN news_articles a ON a.id = m.article_id
    WHERE m.video_id = ${id}
    ORDER BY m.similarity DESC
    LIMIT 20
  `;

  // Get claims
  const claims = await sql`
    SELECT id, claim_text, speaker, timestamp_seconds, confidence, verified
    FROM video_claims
    WHERE video_id = ${id}
    ORDER BY timestamp_seconds NULLS LAST
  `;

  return c.json({
    video: {
      id: Number(video.id),
      video_id: video.video_id,
      platform: video.platform,
      url: video.url,
      title: video.title,
      description: video.description,
      summary: video.summary,
      published_at: video.published_at ? new Date(video.published_at).toISOString() : null,
      duration_seconds: video.duration_seconds,
      thumbnail_url: video.thumbnail_url,
      embed_url: video.embed_url,
      video_type: video.video_type,
      status: video.status,
      view_count: video.view_count ? Number(video.view_count) : null,
      like_count: video.like_count ? Number(video.like_count) : null,
      comment_count: video.comment_count ? Number(video.comment_count) : null,
      transcript_available: video.transcript_available,
      transcript_text: video.transcript_text,
      speakers: video.speakers,
      location_text: video.location_text,
      event_type: video.event_type,
      topic_tags: video.topic_tags,
      entities: video.entities,
      event_id: video.event_id ? Number(video.event_id) : null,
      channel: {
        id: Number(video.channel_id),
        name: video.channel_name,
        platform: video.channel_platform,
        country: video.channel_country,
        channel_url: video.channel_url,
      },
      location: video.lat != null && video.lng != null
        ? { lat: Number(video.lat), lng: Number(video.lng), place_name: video.place_name, country: video.location_country }
        : null,
    },
    matched_articles: matchedArticles.map((a: any) => ({
      id: Number(a.id),
      title: a.title,
      url: a.url,
      published_at: a.published_at ? new Date(a.published_at).toISOString() : null,
      similarity: Number(a.similarity),
      same_event: a.same_event,
      same_location: a.same_location,
    })),
    claims: claims.map((cl: any) => ({
      id: Number(cl.id),
      claim_text: cl.claim_text,
      speaker: cl.speaker,
      timestamp_seconds: cl.timestamp_seconds,
      confidence: cl.confidence ? Number(cl.confidence) : null,
      verified: cl.verified,
    })),
  });
});

// ── GET /api/video/map ──────────────────────────────────────────────────
// Map pins for videos — returns videos with geocoded locations.

videoRoute.get("/video/map", async (c) => {
  const sql = getDb();
  const bbox = c.req.query("bbox");
  const limit = Math.min(Number(c.req.query("limit") ?? 500), 2000);
  const videoType = c.req.query("video_type");
  const topic = c.req.query("topic");

  if (!bbox) {
    return c.json({ error: "bbox_required", message: "Provide bbox=minLng,minLat,maxLng,maxLat" }, 400);
  }

  const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);

  const conditions = [
    sql`v.extracted_lat IS NOT NULL AND v.extracted_lng IS NOT NULL`,
    sql`v.extracted_lng BETWEEN ${minLng} AND ${maxLng}`,
    sql`v.extracted_lat BETWEEN ${minLat} AND ${maxLat}`,
    sql`v.status != 'failed'`,
  ];

  if (videoType) {
    conditions.push(sql`v.video_type = ${videoType}`);
  }
  if (topic) {
    conditions.push(sql`${topic} = ANY(v.topic_tags)`);
  }

  const whereSql = conditions.reduce((acc, w, i) =>
    i === 0 ? sql`${w}` : sql`${acc} AND ${w}`, sql`TRUE`);

  const rows = await sql`
    SELECT v.id, v.video_id, v.url, v.title, v.summary, v.published_at,
           v.duration_seconds, v.thumbnail_url, v.video_type,
           v.view_count, v.speakers, v.topic_tags,
           v.extracted_lat, v.extracted_lng, v.location_text,
           c.name AS channel_name, c.country AS channel_country
    FROM video_items v
    JOIN video_channels c ON c.id = v.channel_id
    WHERE ${whereSql}
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;

  return c.json({
    pins: rows.map((r: any) => ({
      id: Number(r.id),
      url: r.url,
      title: r.title,
      summary: r.summary,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      duration_seconds: r.duration_seconds,
      thumbnail_url: r.thumbnail_url,
      video_type: r.video_type,
      view_count: r.view_count ? Number(r.view_count) : null,
      speakers: r.speakers,
      topic_tags: r.topic_tags,
      location: {
        lat: Number(r.extracted_lat),
        lng: Number(r.extracted_lng),
        place_name: r.location_text,
        country: r.channel_country,
      },
      channel_name: r.channel_name,
    })),
    count: rows.length,
  });
});

// ── GET /api/video/stats ────────────────────────────────────────────────

videoRoute.get("/video/stats", async (c) => {
  const sql = getDb();

  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*) FROM video_channels WHERE active = TRUE) AS active_channels,
      (SELECT COUNT(*) FROM video_channels) AS total_channels,
      (SELECT COUNT(*) FROM video_items) AS total_videos,
      (SELECT COUNT(*) FROM video_items WHERE status = 'extracted') AS extracted_videos,
      (SELECT COUNT(*) FROM video_items WHERE status = 'pending') AS pending_videos,
      (SELECT COUNT(*) FROM video_items WHERE status = 'failed') AS failed_videos,
      (SELECT COUNT(*) FROM video_items WHERE published_at > now() - INTERVAL '7 days') AS videos_last_7d,
      (SELECT COUNT(*) FROM video_items WHERE transcript_available = TRUE) AS with_transcripts,
      (SELECT COUNT(*) FROM video_items WHERE extracted_lat IS NOT NULL) AS geocoded_videos,
      (SELECT COUNT(*) FROM video_article_matches) AS article_matches,
      (SELECT COUNT(*) FROM video_people) AS people_tracked
  `;

  // Topic distribution (all videos, not just extracted)
  const topics = await sql`
    SELECT topic, COUNT(*) as count
    FROM video_items,
         unnest(topic_tags) AS topic
    WHERE topic_tags IS NOT NULL AND array_length(topic_tags, 1) > 0
    GROUP BY topic
    ORDER BY count DESC
    LIMIT 20
  `;

  // Video type distribution (all videos)
  const types = await sql`
    SELECT video_type, COUNT(*) as count
    FROM video_items
    WHERE video_type IS NOT NULL
    GROUP BY video_type
    ORDER BY count DESC
  `;

  // Country distribution (top 20)
  const countries = await sql`
    SELECT c.country, COUNT(*) as count
    FROM video_items v
    JOIN video_channels c ON c.id = v.channel_id
    WHERE c.country IS NOT NULL
    GROUP BY c.country
    ORDER BY count DESC
    LIMIT 20
  `;

  return c.json({
    stats: stats ? {
      active_channels: Number(stats.active_channels),
      total_channels: Number(stats.total_channels),
      total_videos: Number(stats.total_videos),
      extracted_videos: Number(stats.extracted_videos),
      pending_videos: Number(stats.pending_videos),
      failed_videos: Number(stats.failed_videos),
      videos_last_7d: Number(stats.videos_last_7d),
      with_transcripts: Number(stats.with_transcripts),
      geocoded_videos: Number(stats.geocoded_videos),
      article_matches: Number(stats.article_matches),
      people_tracked: Number(stats.people_tracked),
    } : null,
    topics: topics.map((t: any) => ({ topic: t.topic, count: Number(t.count) })),
    types: types.map((t: any) => ({ video_type: t.video_type, count: Number(t.count) })),
    countries: countries.map((c: any) => ({ country: c.country, count: Number(c.count) })),
  });
});

// ── GET /api/video/people ───────────────────────────────────────────────

videoRoute.get("/video/people", async (c) => {
  const sql = getDb();
  const q = c.req.query("q") || "";
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  const conditions = ["1=1"];
  const params: any[] = [];

  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.normalized_name ILIKE $${params.length})`);
  }

  const where = conditions.join(" AND ");
  params.push(limit);

  const rows = await sql.unsafe(
    `SELECT p.id, p.name, p.role, p.organization, p.video_count, p.last_seen_at
     FROM video_people p
     WHERE ${where}
     ORDER BY p.video_count DESC NULLS LAST, p.name
     LIMIT $${params.length}`,
    params,
  );

  return c.json({
    items: rows.map((r: any) => ({
      id: Number(r.id),
      name: r.name,
      role: r.role,
      organization: r.organization,
      video_count: Number(r.video_count),
      last_seen_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    })),
    count: rows.length,
  });
});
