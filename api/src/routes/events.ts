import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { EventListQuerySchema } from "../validate";
import { encodeCursor, decodeCursor } from "../cursors";

export const eventsRoute = new Hono();

eventsRoute.get("/events", zValidator("query", EventListQuerySchema), async (c) => {
  const q = c.req.valid("query");
  const sql = getDb();
  const limit = q.limit ?? 500;

  const where: any[] = [sql`e.status = 'active'`];
  if (q.bbox) {
    const [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
    where.push(sql`l.geom::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)`);
  }
  if (q.event_type) where.push(sql`e.event_type = ${q.event_type}`);
  if (q.since) where.push(sql`e.first_reported_at >= ${new Date(q.since)}`);
  if (q.q) where.push(sql`(e.headline ILIKE ${"%" + q.q + "%"} ESCAPE '\\' OR e.summary ILIKE ${"%" + q.q + "%"} ESCAPE '\\')`);
  if (q.before) {
    const cur = decodeCursor(q.before);
    if (cur) where.push(sql`(e.first_reported_at, e.id) < (${cur.timestamp}, ${cur.id})`);
  }

  const joins = [
    sql`LEFT JOIN news_locations l ON l.id = e.primary_location_id`,
    sql`LEFT JOIN LATERAL (
      SELECT a.url, a.image_url FROM news_event_sources es
      JOIN news_articles a ON a.id = es.article_id
      WHERE es.event_id = e.id
      ORDER BY a.published_at DESC NULLS LAST
      LIMIT 1
    ) first_source ON true`
  ];
  const whereSql = where.reduce((acc, w, i) =>
    i === 0 ? sql`${w}` : sql`${acc} AND ${w}`, sql`TRUE`);
  const joinSql = joins.reduce((acc, j) => sql`${acc} ${j}`, sql``);

  const rows = await sql<any[]>`
    SELECT e.id, e.event_type, e.headline, e.summary,
           e.occurred_at, e.first_reported_at, e.source_count, e.avg_confidence,
           e.relevance_days, e.expires_at,
           l.lat, l.lng, l.place_name, l.country, l.precision,
           first_source.url as event_url, first_source.image_url
    FROM news_events e
    ${joinSql}
    WHERE ${whereSql}
      AND (e.expires_at IS NULL OR e.expires_at > now())
    ORDER BY e.first_reported_at DESC, e.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor(new Date(last.first_reported_at), Number(last.id))
    : null;

  return c.json({
    events: trimmed.map((r) => ({
      id: Number(r.id),
      event_type: r.event_type,
      headline: r.headline,
      summary: r.summary,
      occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
      first_reported_at: new Date(r.first_reported_at).toISOString(),
      source_count: Number(r.source_count),
      avg_confidence: Number(r.avg_confidence),
      relevance_days: Number(r.relevance_days),
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      url: r.event_url || null,
      image_url: r.image_url || null,
      location: r.lat != null && r.lng != null
        ? { lat: Number(r.lat), lng: Number(r.lng), place_name: r.place_name, country: r.country, precision: r.precision }
        : null,
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
  });
});

eventsRoute.get("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT e.id, e.event_type, e.headline, e.summary,
           e.occurred_at, e.first_reported_at, e.source_count, e.avg_confidence, e.status,
           e.relevance_days, e.expires_at,
           l.lat, l.lng, l.place_name, l.country, l.precision, l.confidence AS location_confidence,
           u.undercover_score, u.signals
    FROM news_events e
    LEFT JOIN news_locations l ON l.id = e.primary_location_id
    LEFT JOIN news_undercovered u ON u.event_id = e.id
    WHERE e.id = ${id}
      AND (e.expires_at IS NULL OR e.expires_at > now())
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  const e = rows[0];

  const sources = await sql<any[]>`
    SELECT s.name AS source_name, a.id AS article_id, a.title, a.summary,
           a.url, a.image_url, a.published_at
    FROM news_event_sources es
    JOIN news_articles a ON a.id = es.article_id
    JOIN news_sources s ON s.id = a.source_id
    WHERE es.event_id = ${id}
      -- Tier 1.4: filter retired sources so the public event detail
      -- page doesn't surface a soft-deleted source byline.
      AND s.deleted_at IS NULL
    ORDER BY a.published_at DESC NULLS LAST
  `;

  const locations = await sql<any[]>`
    SELECT l.id, l.place_name, l.country, l.lat, l.lng, l.precision, el.role
    FROM news_event_locations el
    JOIN news_locations l ON l.id = el.location_id
    WHERE el.event_id = ${id}
    ORDER BY (el.role = 'primary') DESC, l.place_name ASC
  `;

  const entities = await sql<any[]>`
    SELECT en.id, en.name, en.type
    FROM news_event_entities ee
    JOIN news_entities en ON en.id = ee.entity_id
    WHERE ee.event_id = ${id}
    ORDER BY en.name
  `;

  const topics = await sql<any[]>`
    SELECT t.id, t.slug, t.label
    FROM news_event_topics et
    JOIN news_topics t ON t.id = et.topic_id
    WHERE et.event_id = ${id}
    ORDER BY t.label
  `;

  const eventUrl = sources.length > 0 ? sources[0].url : null;
  const eventImageUrl = sources.find(s => s.image_url)?.image_url || null;

  return c.json({
    id: Number(e.id),
    event_type: e.event_type,
    headline: e.headline,
    summary: e.summary,
    occurred_at: e.occurred_at ? new Date(e.occurred_at).toISOString() : null,
    first_reported_at: new Date(e.first_reported_at).toISOString(),
    source_count: Number(e.source_count),
    avg_confidence: Number(e.avg_confidence),
    status: e.status,
    relevance_days: Number(e.relevance_days),
    expires_at: e.expires_at ? new Date(e.expires_at).toISOString() : null,
    url: eventUrl,
    image_url: eventImageUrl,
    location: e.lat != null && e.lng != null
      ? {
          lat: Number(e.lat), lng: Number(e.lng),
          place_name: e.place_name, country: e.country,
          precision: e.precision, confidence: Number(e.location_confidence),
        }
      : null,
    sources: sources.map((s) => ({
      article_id: Number(s.article_id),
      source_name: s.source_name,
      title: s.title,
      summary: s.summary,
      url: s.url,
      image_url: s.image_url || null,
      published_at: s.published_at ? new Date(s.published_at).toISOString() : null,
    })),
    locations: locations.map((l) => ({
      id: Number(l.id), place_name: l.place_name, country: l.country,
      lat: Number(l.lat), lng: Number(l.lng),
      precision: l.precision, role: l.role,
    })),
    entities: entities.map((en) => ({ id: Number(en.id), name: en.name, type: en.type })),
    topics: topics.map((t) => ({ id: Number(t.id), slug: t.slug, label: t.label })),
    undercover_score: e.undercover_score != null ? Number(e.undercover_score) : null,
    undercover_signals: e.signals || null,
  });
});

eventsRoute.get("/events/:id/related", async (c) => {
  const id = Number(c.req.param("id"));
  const limit = Math.min(Number(c.req.query("limit")) || 10, 50);
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

  const sql = getDb();

  const eventRows = await sql<any[]>`
    SELECT e.id, e.headline, e.event_type, e.primary_location_id
    FROM news_events e
    WHERE e.id = ${id}
    LIMIT 1
  `;
  if (eventRows.length === 0) return c.json({ error: "not_found" }, 404);
  const event = eventRows[0];

  const relatedRows = await sql<any[]>`
    WITH source_entities AS (
      SELECT ee.entity_id FROM news_event_entities ee WHERE ee.event_id = ${id}
    ),
    source_topics AS (
      SELECT et.topic_id FROM news_event_topics et WHERE et.event_id = ${id}
    ),
    source_locations AS (
      SELECT el.location_id FROM news_event_locations el WHERE el.event_id = ${id}
    ),
    entity_matches AS (
      SELECT DISTINCT ee.event_id, 'entity' as mr
      FROM news_event_entities ee
      WHERE ee.entity_id IN (SELECT entity_id FROM source_entities)
        AND ee.event_id != ${id}
    ),
    topic_matches AS (
      SELECT DISTINCT et.event_id, 'topic' as mr
      FROM news_event_topics et
      WHERE et.topic_id IN (SELECT topic_id FROM source_topics)
        AND et.event_id != ${id}
    ),
    location_matches AS (
      SELECT DISTINCT el.event_id, 'geography' as mr
      FROM news_event_locations el
      WHERE el.location_id IN (SELECT location_id FROM source_locations)
        AND el.event_id != ${id}
    ),
    all_matches AS (
      SELECT event_id, mr FROM entity_matches
      UNION ALL
      SELECT event_id, mr FROM topic_matches
      UNION ALL
      SELECT event_id, mr FROM location_matches
    ),
    scored AS (
      SELECT event_id,
             COUNT(*) as score,
             ARRAY_AGG(DISTINCT mr) as reasons
      FROM all_matches
      GROUP BY event_id
    )
    SELECT s.event_id, s.score,
           e.headline, e.event_type,
           l.lat, l.lng, l.place_name, l.country,
           s.reasons
    FROM scored s
    JOIN news_events e ON e.id = s.event_id
    LEFT JOIN news_locations l ON l.id = e.primary_location_id
    WHERE e.status = 'active' AND (e.expires_at IS NULL OR e.expires_at > now())
    ORDER BY s.score DESC, e.first_reported_at DESC
    LIMIT ${limit}
  `;

  const related = relatedRows.map((r) => ({
    id: Number(r.event_id),
    headline: r.headline,
    event_type: r.event_type,
    location: r.lat != null ? { lat: Number(r.lat), lng: Number(r.lng), place_name: r.place_name, country: r.country } : null,
    match_reasons: r.reasons || [],
  }));

  return c.json({ related });
});
