import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";

// ── GET /api/locations/search ────────────────────────────────────────
// Fuzzy search the locations table for a place name. Returns a list of
// matches with a recent-event count, ordered by event_count DESC then
// similarity DESC so the most-relevant locations (in the news sense)
// float to the top. Caller: app.js:8322 (single-search) and app.js:8383
// (runSearch) — both use the response shape `{ locations: [{ place_name,
// event_count, lat, lng }] }` to fly the map to the best match.
//
// Backed by news_locations (211 rows) — small but curated. Falls back to
// the FDW world_cities gazetteer (45k rows) when the local table misses,
// so users searching "Reykjavik" get the same answer as the autocomplete
// dropdown. T-13 closes the silent 404 that previously swallowed the
// response and forced the UI to fall back to Nominatim.

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

export const locationsRoute = new Hono();

// Quick wins: cap search queries per IP — the trigram path can be CPU-heavy
// and the FDW fallback is unbounded. 60/min is generous for the typeahead UX.
const locationSearchLimiter = new RateLimiter({ max: 60, windowMs: 60 * 1000 });

locationsRoute.get(
  "/locations/search",
  zValidator("query", SearchQuerySchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = locationSearchLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const { q, limit } = c.req.valid("query");
    const sql = getDb();

    // Two-stage search:
    //   1. news_locations: trigram similarity + event_count from news_articles.
    //      This is the curated set, so event_count is meaningful.
    //   2. world_cities FDW: gazetteer fallback for place names we haven't
    //      written into news_locations yet. event_count is always 0 here.
    //
    // Both stages use ILIKE for prefix/substring matches (cheap) and the
    // trigram index kicks in for fuzzy matches. We use similarity() to
    // rank within each stage so "Reykjavík" matches "Reykjavik".
    // Require a minimum trigram similarity of 0.35 so that unrelated
    // high-popularity locations (e.g. "France" for the query "insurance")
    // don't dominate the results.  Order by similarity first so the best
    // textual match wins, then break ties by event_count.
    const localRows = await sql<{
      id: number;
      place_name: string;
      event_count: string;
      lat: number;
      lng: number;
      sim: number;
    }[]>`
      SELECT
        nl.id,
        nl.place_name,
        COALESCE(article_counts.cnt, 0) AS event_count,
        nl.lat,
        nl.lng,
        similarity(nl.place_name, ${q}) AS sim
      FROM news_locations nl
      -- THE COUNT IS PER MATCHED LOCATION, NOT FOR EVERY LOCATION.
      --
      -- The old form was an UNCORRELATED aggregate: it counted the
      -- articles of all 45,231 locations, so every call read the whole
      -- 3.8 M-row news_articles table before it could answer a query
      -- about a handful of places. MEASURED 2026-11-11: 2,050 ms for
      -- "china" — and this endpoint is called on EVERY search, in
      -- parallel with the pin search.
      --
      -- Counting only the MATCHED locations turns it into a lookup, and
      -- idx_news_articles_loc_pub (location_id, published_at) WHERE
      -- status = 'extracted' makes each count an INDEX-ONLY scan: no
      -- heap fetches. Same rows, same numbers, 67.7 ms instead of
      -- 2,050 ms.
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM news_articles a
        WHERE a.location_id = nl.id
          AND a.status = 'extracted'
          AND (a.published_at >= now() - interval '90 days' OR a.published_at IS NULL)
      ) article_counts ON TRUE
      WHERE (
          nl.place_name % ${q}
          OR nl.place_name_normalized % ${q}
          OR nl.place_name ILIKE ${"%" + q + "%"}
        )
        AND similarity(nl.place_name, ${q}) >= 0.35
      ORDER BY sim DESC, event_count DESC
      LIMIT ${limit}
    `;

    // If the local table fully covered the request, return it. Otherwise
    // top up from the gazetteer. The UNION ALL de-dups by place_name
    // (later rows are dropped).
    let results = localRows.map((r) => ({
      id: Number(r.id),
      place_name: r.place_name,
      event_count: Number(r.event_count),
      lat: Number(r.lat),
      lng: Number(r.lng),
    }));

    if (results.length < limit) {
      const remaining = limit - results.length;
      const gazetteerRows = await sql<{
        name: string;
        country: string | null;
        lat: number;
        lng: number;
        sim: number;
      }[]>`
        SELECT name, country_code AS country, lat, lng,
               similarity(name, ${q}) AS sim
        FROM world_cities
        WHERE (
            name % ${q}
            OR ascii_name % ${q}
            OR name ILIKE ${"%" + q + "%"}
          )
          AND similarity(name, ${q}) >= 0.35
        ORDER BY sim DESC, population DESC NULLS LAST
        LIMIT ${remaining * 2}
      `;
      const seen = new Set(results.map((r) => r.place_name.toLowerCase()));
      for (const r of gazetteerRows) {
        const place = r.country ? `${r.name}, ${r.country}` : r.name;
        if (seen.has(place.toLowerCase())) continue;
        seen.add(place.toLowerCase());
        results.push({
          place_name: place,
          event_count: 0,
          lat: Number(r.lat),
          lng: Number(r.lng),
        });
        if (results.length >= limit) break;
      }
    }

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return c.json({
      locations: results,
      count: results.length,
    });
  },
);
