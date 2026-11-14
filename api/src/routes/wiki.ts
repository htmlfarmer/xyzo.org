// Wikipedia "things near a location" proxy. Reads through to the live
// Wikipedia geosearch API (no DB; cached in process memory for 1h).
// Also provides text search against the local wikipedia database.

import { Hono } from "hono";
import { z } from "zod";
import { wikiNear } from "../wiki";
import { getWikiDb } from "../wiki-db";

export const wikiRoute = new Hono();

const WikiNearSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce.number().min(100).max(50_000).optional().default(5000),
  limit: z.coerce.number().int().min(1).max(200).optional().default(25),
  lang: z.string().min(2).max(8).optional().default("en"),
});

// GET /api/wiki/near?lat=...&lng=...&radius_m=...&limit=...
wikiRoute.get("/wiki/near", async (c) => {
  const parsed = WikiNearSchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: "bad_args", message: parsed.error.message }, 400);
  }
  try {
    const results = await wikiNear(parsed.data);
    c.header("Cache-Control", "public, max-age=300");   // edge cache
    return c.json({
      center: { lat: parsed.data.lat, lng: parsed.data.lng },
      radius_m: parsed.data.radius_m,
      lang: parsed.data.lang,
      count: results.length,
      results,
    });
  } catch (e) {
    console.warn("[wiki/near] error:", (e as Error).message);
    return c.json({ error: "upstream_error", message: "Wikipedia unavailable" }, 502);
  }
});

// ── Local Wikipedia text search ────────────────────────────────────────
const WikiSearchSchema = z.object({
  q: z.string().min(1).max(200).transform((s) => s.replace(/[\x00-\x1f\x7f]/g, " ").trim()),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

// GET /api/wiki/search?q=...&limit=...
wikiRoute.get("/wiki/search", async (c) => {
  const parsed = WikiSearchSchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: "bad_args", message: parsed.error.message }, 400);
  }
  const { q, limit } = parsed.data;
  try {
    const sql = getWikiDb();
    // Use PostgreSQL full-text search with tsvector for fast results.
    const tsQuery = q.split(/\s+/).filter(Boolean).map(w => w + ":*").join(" & ");
    const rows = await sql<{ wiki_id: bigint; title: string; url: string; article_length: number }[]>`
      SELECT wiki_id, title, url, article_length
      FROM wiki_articles
      WHERE search_vector @@ to_tsquery('english', ${tsQuery})
      ORDER BY ts_rank(search_vector, to_tsquery('english', ${tsQuery})) DESC
      LIMIT ${limit}
    `;

    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      query: q,
      count: rows.length,
      results: rows.map((r) => ({
        wiki_id: Number(r.wiki_id),
        title: r.title,
        url: r.url,
        article_length: r.article_length,
      })),
    });
  } catch (e) {
    // Wiki DB unavailable — return empty results gracefully instead of 502
    return c.json({ query: q, count: 0, results: [], unavailable: true }, 200);
  }
});
