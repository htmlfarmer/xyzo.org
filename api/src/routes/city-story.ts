import { Hono } from "hono";
import { getDb } from "../db";

export const cityStoryRoute = new Hono();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── GET /api/stories/:storyId/cities ─────────────────────────────────
// Returns city relationships for a story
cityStoryRoute.get("/stories/:storyId/cities", async (c) => {
  const sql = getDb();
  const storyId = Number(c.req.param("storyId"));
  const limit = Math.min(Number(c.req.query("limit")) || DEFAULT_LIMIT, MAX_LIMIT);

  if (!storyId || isNaN(storyId)) {
    return c.json({ error: "invalid_story_id" }, 400);
  }

  const rows = await sql`
    SELECT
      csr.city_id::float AS city_id,
      csr.place_presence,
      csr.place_relevance,
      csr.relationship_type,
      csr.confidence,
      csr.primary_evidence,
      csr.is_primary_city,
      csr.is_related_city,
      csr.display_level,
      csr.geographic_score,
      csr.embedding_score,
      csr.created_at
    FROM city_story_relationships csr
    WHERE csr.story_id = ${storyId}
      AND csr.is_related_city = TRUE
    ORDER BY csr.confidence DESC, csr.place_presence DESC
    LIMIT ${limit}
  `;

  return c.json({
    items: rows,
    count: rows.length,
    story_id: storyId,
  });
});

// ── GET /api/cities/:cityId/stories ────────────────────────────────────
// Returns stories associated with a city
cityStoryRoute.get("/cities/:cityId/stories", async (c) => {
  const sql = getDb();
  const cityId = Number(c.req.param("cityId"));
  const limit = Math.min(Number(c.req.query("limit")) || DEFAULT_LIMIT, MAX_LIMIT);
  const displayLevel = c.req.query("display_level");

  if (!cityId || isNaN(cityId)) {
    return c.json({ error: "invalid_city_id" }, 400);
  }

  let query = sql`
    SELECT
      csr.story_id::float AS story_id,
      csr.place_presence,
      csr.place_relevance,
      csr.relationship_type,
      csr.confidence,
      csr.primary_evidence,
      csr.is_primary_city,
      csr.display_level,
      na.title,
      na.url,
      na.published_at,
      na.summary
    FROM city_story_relationships csr
    JOIN news_articles na ON na.id = csr.story_id
    WHERE csr.city_id = ${cityId}
      AND csr.is_related_city = TRUE
  `;

  if (displayLevel) {
    query = sql`${query} AND csr.display_level = ${displayLevel}`;
  }

  query = sql`${query}
    ORDER BY csr.confidence DESC, na.published_at DESC
    LIMIT ${limit}
  `;

  const rows = await query;

  return c.json({
    items: rows,
    count: rows.length,
    city_id: cityId,
  });
});

// ── GET /api/stories/:storyId/cities/quadrants ─────────────────────────
// Returns quadrant classification for story's city relationships
cityStoryRoute.get("/stories/:storyId/cities/quadrants", async (c) => {
  const sql = getDb();
  const storyId = Number(c.req.param("storyId"));

  if (!storyId || isNaN(storyId)) {
    return c.json({ error: "invalid_story_id" }, 400);
  }

  const rows = await sql`
    SELECT
      csq.city_id::float AS city_id,
      csq.place_presence,
      csq.place_relevance,
      csq.quadrant,
      csq.relationship_type,
      csq.confidence
    FROM city_story_quadrants csq
    WHERE csq.story_id = ${storyId}
    ORDER BY csq.confidence DESC
  `;

  return c.json({
    items: rows,
    count: rows.length,
    story_id: storyId,
  });
});

// ── GET /api/cities/:cityId/stats ─────────────────────────────────────
// Returns statistics about city-story relationships
cityStoryRoute.get("/cities/:cityId/stats", async (c) => {
  const sql = getDb();
  const cityId = Number(c.req.param("cityId"));

  if (!cityId || isNaN(cityId)) {
    return c.json({ error: "invalid_city_id" }, 400);
  }

  const [stats] = await sql`
    SELECT
      COUNT(*)::float AS total_relationships,
      COUNT(*) FILTER (WHERE csr.is_primary_city = TRUE)::float AS primary_count,
      COUNT(*) FILTER (WHERE csr.display_level = 'related')::float AS related_count,
      COUNT(*) FILTER (WHERE csr.display_level = 'regional')::float AS regional_count,
      AVG(csr.confidence) FILTER (WHERE csr.is_related_city = TRUE)::float AS avg_confidence,
      AVG(csr.place_presence) FILTER (WHERE csr.is_related_city = TRUE)::float AS avg_presence,
      AVG(csr.place_relevance) FILTER (WHERE csr.is_related_city = TRUE)::float AS avg_relevance
    FROM city_story_relationships csr
    WHERE csr.city_id = ${cityId}
  `;

  const quadrantCounts = await sql`
    SELECT quadrant, COUNT(*)::float AS count
    FROM city_story_quadrants
    WHERE city_id = ${cityId}
    GROUP BY quadrant
  `;

  return c.json({
    city_id: cityId,
    total_relationships: Math.round(Number(stats?.total_relationships ?? 0)),
    primary_count: Math.round(Number(stats?.primary_count ?? 0)),
    related_count: Math.round(Number(stats?.related_count ?? 0)),
    regional_count: Math.round(Number(stats?.regional_count ?? 0)),
    avg_confidence: stats?.avg_confidence != null ? Math.round(Number(stats.avg_confidence) * 1000) / 1000 : null,
    avg_presence: stats?.avg_presence != null ? Math.round(Number(stats.avg_presence) * 1000) / 1000 : null,
    avg_relevance: stats?.avg_relevance != null ? Math.round(Number(stats.avg_relevance) * 1000) / 1000 : null,
    quadrant_counts: quadrantCounts.map((q: any) => ({
      quadrant: q.quadrant,
      count: Math.round(Number(q.count)),
    })),
  });
});
