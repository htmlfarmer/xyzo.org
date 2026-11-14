import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { z } from "zod";

export const journalistsRoute = new Hono();

// ── Query Schema ─────────────────────────────────────────────────────────

const JournalistListSchema = z.object({
  q: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  topic: z.string().optional(),
  journalist_type: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const JournalistArticleSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

// ── GET /api/journalists ────────────────────────────────────────────────

journalistsRoute.get(
  "/journalists",
  zValidator("query", JournalistListSchema),
  async (c) => {
    const { q, country, city, topic, journalist_type, limit, offset } =
      c.req.valid("query");
    const sql = getDb();

    const conditions: any[] = [sql`j.profile_status != 'suspended'`];
    const args: any[] = [];

    if (q) {
      conditions.push(
        sql`(j.canonical_name ILIKE ${"%" + q + "%"} ESCAPE '\\' OR j.bio ILIKE ${"%" + q + "%"} ESCAPE '\\')`
      );
    }
    if (country) {
      conditions.push(sql`j.country ILIKE ${"%" + country + "%"}`);
    }
    if (city) {
      conditions.push(sql`j.city ILIKE ${"%" + city + "%"}`);
    }
    if (topic) {
      conditions.push(sql`${topic} = ANY(j.topics)`);
    }
    if (journalist_type) {
      conditions.push(sql`j.journalist_type = ${journalist_type}`);
    }

    const whereSql = conditions.reduce(
      (acc, w, i) => (i === 0 ? sql`${w}` : sql`${acc} AND ${w}`),
      sql`TRUE`
    );

    const [rows, countRow] = await Promise.all([
      sql<Array<{
        id: number;
        canonical_name: string;
        display_name: string | null;
        bio: string | null;
        journalist_type: string;
        country: string | null;
        city: string | null;
        organization_name: string | null;
        article_count: number;
        topics: string[];
        profile_status: string;
        location_confidence: number;
        identity_confidence: number;
        first_seen_at: Date;
        last_seen_at: Date;
      }>>`
        SELECT
          j.id,
          j.canonical_name,
          j.display_name,
          j.bio,
          j.journalist_type,
          j.country,
          j.city,
          j.organization_name,
          j.article_count,
          j.topics,
          j.profile_status,
          j.location_confidence,
          j.identity_confidence,
          j.first_seen_at,
          j.last_seen_at,
          l.lat,
          l.lng,
          l.place_name as location_name
        FROM news_journalists j
        LEFT JOIN news_locations l ON l.id = j.city_id
        WHERE ${whereSql}
        ORDER BY j.article_count DESC, j.last_seen_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      sql<[{ count: bigint }]>`
        SELECT COUNT(*) as count FROM news_journalists j WHERE ${whereSql}
      `,
    ]);

    return c.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        name: r.display_name || r.canonical_name,
        canonical_name: r.canonical_name,
        bio: r.bio,
        journalist_type: r.journalist_type,
        country: r.country,
        city: r.city,
        location: r.location_name
          ? { name: r.location_name, lat: r.lat, lng: r.lng }
          : null,
        organization: r.organization_name,
        article_count: Number(r.article_count),
        topics: r.topics,
        profile_status: r.profile_status,
        location_confidence: r.location_confidence,
        identity_confidence: r.identity_confidence,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
      })),
      count: Number(countRow[0]?.count ?? 0),
    });
  }
);

// ── GET /api/journalists/:id ─────────────────────────────────────────────

journalistsRoute.get("/journalists/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const sql = getDb();

  const [row] = await sql<Array<{
    id: number;
    canonical_name: string;
    display_name: string | null;
    bio: string | null;
    gender: string | null;
    languages: string[];
    journalist_type: string;
    employment_status: string | null;
    country: string | null;
    city: string | null;
    location_confidence: number;
    organization_name: string | null;
    organization_type: string | null;
    profile_url: string | null;
    website_url: string | null;
    twitter_handle: string | null;
    linkedin_url: string | null;
    email_public: string | null;
    article_count: number;
    topics: string[];
    topic_scores: Record<string, number>;
    profile_status: string;
    identity_confidence: number;
    location_evidence: any[];
    first_seen_at: Date;
    last_seen_at: Date;
  }>>`
    SELECT
      j.id,
      j.canonical_name,
      j.display_name,
      j.bio,
      j.gender,
      j.languages,
      j.journalist_type,
      j.employment_status,
      j.country,
      j.city,
      j.location_confidence,
      j.organization_name,
      j.organization_type,
      j.profile_url,
      j.website_url,
      j.twitter_handle,
      j.linkedin_url,
      j.email_public,
      j.article_count,
      j.topics,
      j.topic_scores,
      j.profile_status,
      j.identity_confidence,
      j.location_evidence,
      j.first_seen_at,
      j.last_seen_at,
      l.lat,
      l.lng,
      l.place_name as location_name,
      l.country as location_country
    FROM news_journalists j
    LEFT JOIN news_locations l ON l.id = j.city_id
    WHERE j.id = ${id}
  `;

  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json({
    id: Number(row.id),
    name: row.display_name || row.canonical_name,
    canonical_name: row.canonical_name,
    bio: row.bio,
    gender: row.gender,
    languages: row.languages,
    journalist_type: row.journalist_type,
    employment_status: row.employment_status,
    location: {
      country: row.country,
      city: row.city,
      name: row.location_name,
      lat: row.lat,
      lng: row.lng,
      confidence: row.location_confidence,
    },
    organization: row.organization_name
      ? {
          name: row.organization_name,
          type: row.organization_type,
        }
      : null,
    contact: {
      profile_url: row.profile_url,
      website_url: row.website_url,
      twitter: row.twitter_handle,
      linkedin: row.linkedin_url,
      email: row.email_public,
    },
    article_count: Number(row.article_count),
    topics: row.topics,
    topic_scores: row.topic_scores || {},
    profile_status: row.profile_status,
    identity_confidence: row.identity_confidence,
    location_evidence: row.location_evidence || [],
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  });
});

// ── GET /api/journalists/:id/articles ───────────────────────────────────

journalistsRoute.get(
  "/journalists/:id/articles",
  zValidator("query", JournalistArticleSchema),
  async (c) => {
    const id = Number(c.req.param("id"));
    const { limit, offset } = c.req.valid("query");
    const sql = getDb();

    const [articles, countRow] = await Promise.all([
      sql<Array<{
        article_id: number;
        url: string;
        title: string;
        published_at: Date | null;
        source_name: string;
        source_country: string | null;
        extracted_location: string | null;
        extracted_lat: number | null;
        extracted_lng: number | null;
        body_length: number;
        quality_score: number | null;
        relationship: string;
        evidence_type: string;
      }>>`
        SELECT
          a.id as article_id,
          a.url,
          a.title,
          a.published_at,
          s.name as source_name,
          s.country as source_country,
          a.extracted_location,
          a.extracted_lat,
          a.extracted_lng,
          LENGTH(a.body) as body_length,
          a.quality_score,
          aj.relationship,
          aj.evidence_type
        FROM news_article_journalists aj
        JOIN news_articles a ON a.id = aj.article_id
        LEFT JOIN news_sources s ON s.id = a.source_id
        WHERE aj.journalist_id = ${id}
          AND aj.relationship IN ('author', 'coauthor', 'contributor')
        ORDER BY a.published_at DESC NULLS LAST
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      sql<[{ count: bigint }]>`
        SELECT COUNT(*) as count
        FROM news_article_journalists aj
        WHERE aj.journalist_id = ${id}
          AND aj.relationship IN ('author', 'coauthor', 'contributor')
      `,
    ]);

    return c.json({
      items: articles.map((a) => ({
        id: Number(a.article_id),
        url: a.url,
        title: a.title,
        published_at: a.published_at,
        source: {
          name: a.source_name,
          country: a.source_country,
        },
        location: a.extracted_location
          ? {
              name: a.extracted_location,
              lat: a.extracted_lat,
              lng: a.extracted_lng,
            }
          : null,
        body_length: Number(a.body_length),
        quality_score: a.quality_score,
        relationship: a.relationship,
        evidence: a.evidence_type,
      })),
      count: Number(countRow[0]?.count ?? 0),
    });
  }
);

// ── GET /api/journalists/by-location ────────────────────────────────────
// Journalists associated with a specific location (country or city)

journalistsRoute.get("/journalists/by-location", async (c) => {
  const sql = getDb();
  const country = c.req.query("country");
  const city = c.req.query("city");

  if (!country && !city) {
    return c.json({ error: "country or city required" }, 400);
  }

  const conditions: any[] = [sql`j.profile_status != 'suspended'`];
  if (country) conditions.push(sql`j.country ILIKE ${"%" + country + "%"}`);
  if (city) conditions.push(sql`j.city ILIKE ${"%" + city + "%"}`);

  const whereSql = conditions.reduce(
    (acc, w, i) => (i === 0 ? sql`${w}` : sql`${acc} AND ${w}`),
    sql`TRUE`
  );

  const rows = await sql<Array<{
    id: number;
    canonical_name: string;
    display_name: string | null;
    journalist_type: string;
    organization_name: string | null;
    article_count: number;
    topics: string[];
    last_seen_at: Date;
  }>>`
    SELECT
      j.id,
      j.canonical_name,
      j.display_name,
      j.journalist_type,
      j.organization_name,
      j.article_count,
      j.topics,
      j.last_seen_at
    FROM news_journalists j
    WHERE ${whereSql}
    ORDER BY j.article_count DESC
    LIMIT 50
  `;

  return c.json({
    items: rows.map((r) => ({
      id: Number(r.id),
      name: r.display_name || r.canonical_name,
      journalist_type: r.journalist_type,
      organization: r.organization_name,
      article_count: Number(r.article_count),
      topics: r.topics,
      last_seen_at: r.last_seen_at,
    })),
    count: rows.length,
  });
});
