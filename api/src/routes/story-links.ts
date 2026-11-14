import { Hono } from "hono";
import { getDb } from "../db";

export const storyLinksRoute = new Hono();

// GET /api/story-links/stats — summary of cross-language linking
// Must be registered BEFORE /:articleId so "stats" isn't treated as an ID
storyLinksRoute.get("/stats", async (c) => {
  const sql = getDb();

  const stats = await sql<Array<{
    total_links: number;
    cross_language_links: number;
    language_pairs: number;
  }>>`
    SELECT
      count(*) AS total_links,
      count(*) FILTER (
        WHERE a1.detected_lang IS NOT NULL
          AND a2.detected_lang IS NOT NULL
          AND a1.detected_lang != a2.detected_lang
      ) AS cross_language_links,
      count(DISTINCT LEAST(
        a1.detected_lang, a2.detected_lang
      ) || '|' || GREATEST(
        a1.detected_lang, a2.detected_lang
      )) AS language_pairs
    FROM news_story_links sl
    JOIN news_articles a1 ON a1.id = sl.source_article_id
    JOIN news_articles a2 ON a2.id = sl.target_article_id
    WHERE sl.link_strength >= 0.5
  `;

  const topPairs = await sql<Array<{
    lang_1: string;
    lang_2: string;
    cnt: number;
  }>>`
    SELECT
      LEAST(a1.detected_lang, a2.detected_lang) AS lang_1,
      GREATEST(a1.detected_lang, a2.detected_lang) AS lang_2,
      count(*) AS cnt
    FROM news_story_links sl
    JOIN news_articles a1 ON a1.id = sl.source_article_id
    JOIN news_articles a2 ON a2.id = sl.target_article_id
    WHERE a1.detected_lang IS NOT NULL
      AND a2.detected_lang IS NOT NULL
      AND a1.detected_lang != a2.detected_lang
      AND sl.link_strength >= 0.5
    GROUP BY LEAST(a1.detected_lang, a2.detected_lang),
             GREATEST(a1.detected_lang, a2.detected_lang)
    ORDER BY cnt DESC
    LIMIT 10
  `;

  const byType = await sql<Array<{
    link_type: string;
    cnt: number;
  }>>`
    SELECT link_type, count(*) AS cnt
    FROM news_story_links
    WHERE link_strength >= 0.5
    GROUP BY link_type
    ORDER BY cnt DESC
  `;

  return c.json({
    total_links: Number(stats[0]?.total_links || 0),
    cross_language_links: Number(stats[0]?.cross_language_links || 0),
    language_pairs: Number(stats[0]?.language_pairs || 0),
    by_type: byType.map((r) => ({
      type: r.link_type,
      count: Number(r.cnt),
    })),
    top_pairs: topPairs.map((r) => ({
      pair: `${r.lang_1} ↔ ${r.lang_2}`,
      count: Number(r.cnt),
    })),
  });
});

// GET /api/story-links/:articleId — get cross-language versions of an article
storyLinksRoute.get("/:articleId{[0-9]+}", async (c) => {
  const articleId = Number(c.req.param("articleId"));
  if (!articleId || !Number.isFinite(articleId)) {
    return c.json({ error: "invalid_article_id" }, 400);
  }

  const sql = getDb();

  const rows = await sql<Array<{
    linked_id: number;
    linked_title: string;
    linked_lang: string;
    linked_source: string;
    link_type: string;
    link_strength: number;
    link_reason: string;
  }>>`
    SELECT
      CASE WHEN sl.source_article_id = ${articleId} THEN sl.target_article_id
           ELSE sl.source_article_id END AS linked_id,
      a.title AS linked_title,
      a.detected_lang AS linked_lang,
      s.name AS linked_source,
      sl.link_type,
      sl.link_strength,
      sl.link_reason
    FROM news_story_links sl
    JOIN news_articles a ON a.id = CASE
      WHEN sl.source_article_id = ${articleId} THEN sl.target_article_id
      ELSE sl.source_article_id
    END
    LEFT JOIN news_sources s ON s.id = a.source_id
    WHERE (sl.source_article_id = ${articleId} OR sl.target_article_id = ${articleId})
      AND sl.link_strength >= 0.5
      -- Tier 1.4: filter retired sources so the public story-links panel
      -- on the article detail page never surfaces a soft-deleted source.
      AND s.deleted_at IS NULL
    ORDER BY sl.link_strength DESC
    LIMIT 20
  `;

  const byLanguage: Record<string, Array<{
    article_id: number;
    title: string;
    source: string;
    link_type: string;
    confidence: number;
  }>> = {};

  for (const row of rows) {
    const lang = row.linked_lang || "unknown";
    if (!byLanguage[lang]) byLanguage[lang] = [];
    byLanguage[lang].push({
      article_id: Number(row.linked_id),
      title: row.linked_title,
      source: row.linked_source,
      link_type: row.link_type,
      confidence: Number(row.link_strength),
    });
  }

  const languages = Object.keys(byLanguage).map((lang) => ({
    code: lang,
    count: byLanguage[lang].length,
  }));

  return c.json({
    article_id: articleId,
    languages,
    linked_articles: rows.map((r) => ({
      article_id: Number(r.linked_id),
      title: r.linked_title,
      language: r.linked_lang || "unknown",
      source: r.linked_source,
      link_type: r.link_type,
      confidence: Number(r.link_strength),
      reason: r.link_reason,
    })),
  });
});
