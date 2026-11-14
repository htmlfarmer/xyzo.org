import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";

export const tagsRoute = new Hono();

/**
 * Structural ARTEFACTS, not topics — they must never reach the chip bar.
 *
 * The extractor's system prompt used to show the model this shape:
 *
 *     "topic_tags": ["3-6", "short", "topic", "tags"]
 *
 * and a great many models copied it VERBATIM: those four words are
 * literal tags on 5,000+ articles ("3-6" 2,741 · "short" 1,482 · "tags"
 * 1,395 · "topic" 1,265). A chip labelled "topic" is not a topic, and a
 * reader who clicked it got a map of articles about nothing in
 * particular — which is exactly what it looks like.
 *
 * The prompt is fixed (worker/extract.py now asks for the tags in prose
 * and shows an empty list), but the rows already written stay in the
 * table, so they are filtered HERE — the chip bar is the reader's door
 * into the vocabulary and it must not offer a word that names nothing.
 */
const STRUCTURAL_TAGS = ["3-6", "short", "tags", "topic"];

/**
 * Dynamic topic-tag taxonomy.
 *
 * Tag names come from news_articles.topic_tags (a text[] populated by the
 * AI extractor in worker/extract.py) — they are NOT a hardcoded enum.
 * "politics", "Germany", "Hurricane Melissa", "AI regulation" all live
 * here. As the news changes, the tags change. Today the database holds
 * 533 distinct tags drawn from 439 extracted+located articles.
 *
 * Case-normalization: the extractor occasionally emits mixed casing
 * ("Germany" vs "germany"). We group by LOWER(t.tag) so the chip bar
 * shows each concept once; the display name uses the most-common
 * original casing so a list of 200 tags reads naturally.
 *
 * Endpoints:
 *   GET /api/tags/top     — ranked list with pin counts (drives chip bar)
 *   GET /api/tags/stats   — aggregate counts (total tags, total tagged
 *                            articles, etc.) for the debug panel
 */

const TopQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
  // Optional spatial filter so the chip bar can adapt to the current map
  // bbox — same bbox string shape as /api/pins.
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  // When set, return tag counts for a specific category only. Useful for
  // "show me the dominant topics within conflict news".
  category: z.string().min(1).max(40).optional(),
  // Optional time filter — ISO timestamp. When set, only count articles
  // published/fetched after this date. Matches the pin fetch's `since`
  // parameter so chip counts and pin counts are apples-to-apples.
  since: z.string().datetime().optional(),
});

tagsRoute.get(
  "/tags/top",
  zValidator("query", TopQuery),
  async (c) => {
    const q = c.req.valid("query");
    const sql = getDb();

    // Build the inner FROM/WHERE clause once. We unnest + group by lowercased
    // tag so case duplicates collapse.
    let innerFrom: any = sql`
      FROM news_articles a, unnest(a.topic_tags) AS t(tag)
      WHERE a.status = 'extracted'
        AND a.location_id IS NOT NULL
        AND array_length(a.topic_tags, 1) > 0
    `;
    if (q.bbox) {
      const [minLng, minLat, maxLng, maxLat] = q.bbox.split(",").map(Number);
      innerFrom = sql`
        FROM news_articles a
        JOIN news_locations l ON l.id = a.location_id,
             unnest(a.topic_tags) AS t(tag)
        WHERE a.status = 'extracted'
          AND a.location_id IS NOT NULL
          AND array_length(a.topic_tags, 1) > 0
          AND l.geom::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
      `;
    }
    if (q.category) {
      innerFrom = sql`${innerFrom} AND COALESCE(a.event_type, 'other') = ${q.category}`;
    }
    if (q.since) {
      innerFrom = sql`${innerFrom} AND COALESCE(a.published_at, a.fetched_at) >= ${new Date(q.since)}`;
    }

    // CTE pipeline:
    //   per_casing  — count per (lowercased-tag, raw-casing) pair
    //   ranked      — pick the most-common casing per lowercased key
    //   totals      — collapse case-duplicates
    //   final       — join display name + total count, ranked by count desc
    const rows = await sql<{ tag: string; count: number }[]>`
      WITH per_casing AS (
        SELECT LOWER(t.tag) AS ltag, t.tag AS raw_tag, COUNT(*)::int AS casing_count
        ${innerFrom}
        AND LOWER(t.tag) <> ALL(${STRUCTURAL_TAGS})
        GROUP BY LOWER(t.tag), t.tag
      ),
      ranked AS (
        SELECT DISTINCT ON (ltag) ltag, raw_tag, casing_count
        FROM per_casing
        ORDER BY ltag, casing_count DESC, raw_tag ASC
      ),
      totals AS (
        SELECT ltag, SUM(casing_count)::int AS total
        FROM per_casing
        GROUP BY ltag
      )
      SELECT ranked.raw_tag AS tag, totals.total AS count
      FROM totals
      JOIN ranked ON ranked.ltag = totals.ltag
      ORDER BY totals.total DESC, totals.ltag ASC
      LIMIT ${q.limit}
    `;

    return c.json({
      tags: rows.map((r) => ({ name: r.tag, count: Number(r.count) })),
      count: rows.length,
      generated_at: new Date().toISOString(),
    });
  }
);

tagsRoute.get("/tags/stats", async (c) => {
  const sql = getDb();
  // Two-pass aggregation so the unnest() join doesn't multiply article
  // counts by #tags per article. Pass 1: per-article metrics. Pass 2:
  // distinct tag vocabulary across those articles (case-collapsed).
  const [perArticle] = await sql<{
    total: number;
    tagged: number;
    avg_tags: number;
  }[]>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE array_length(topic_tags, 1) > 0)::int AS tagged,
      COALESCE(AVG(array_length(topic_tags, 1)) FILTER (WHERE array_length(topic_tags, 1) > 0), 0)::float AS avg_tags
    FROM news_articles
    WHERE status = 'extracted' AND location_id IS NOT NULL
  `;
  const [{ distinct }] = await sql<{ distinct: number }[]>`
    SELECT COUNT(DISTINCT LOWER(t.tag))::int AS distinct
    FROM news_articles a, unnest(a.topic_tags) AS t(tag)
    WHERE a.status = 'extracted' AND a.location_id IS NOT NULL
      AND array_length(a.topic_tags, 1) > 0
  `;
  return c.json({
    total_articles: Number(perArticle?.total ?? 0),
    tagged_articles: Number(perArticle?.tagged ?? 0),
    distinct_tags: Number(distinct ?? 0),
    avg_tags_per_article: Number(perArticle?.avg_tags ?? 0),
    generated_at: new Date().toISOString(),
  });
});
