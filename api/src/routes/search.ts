import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { PlaceSearchSchema } from "../validate";
import { RateLimiter, getClientIp } from "../ratelimit";
import { wordBoundaryPattern } from "../lib/wordmatch";

export const searchRoute = new Hono();

const placeSearchLimiter = new RateLimiter({ max: 60, windowMs: 60 * 1000 });

// ── DuckDuckGo News Search ──────────────────────────────────────────
// Fires a lightweight request to DuckDuckGo's instant answer API for
// news results. Returns article URLs + titles that can be fed into the
// existing RSS ingestion pipeline. No API key required.
async function searchDuckDuckGoNews(
  query: string,
  limit = 10,
): Promise<Array<{ title: string; url: string; source: string; snippet: string }>> {
  try {
    const params = new URLSearchParams({
      q: `${query} news`,
      format: "json",
      no_html: "1",
      skip_disambig: "1",
    });
    const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
      headers: { "User-Agent": "XyzoBot/1.0 (news aggregator)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as Record<string, any>;

    const results: Array<{ title: string; url: string; source: string; snippet: string }> = [];

    // DuckDuckGo instant answer API returns RelatedTopics
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics) {
        if (results.length >= limit) break;
        if (topic.FirstURL && topic.Text) {
          results.push({
            title: topic.Text.split(" - ")[0] || topic.Text.slice(0, 100),
            url: topic.FirstURL,
            source: new URL(topic.FirstURL).hostname.replace("www.", ""),
            snippet: topic.Text,
          });
        }
        // DuckDuckGo nests sub-results
        if (Array.isArray(topic.Topics)) {
          for (const sub of topic.Topics) {
            if (results.length >= limit) break;
            if (sub.FirstURL && sub.Text) {
              results.push({
                title: sub.Text.split(" - ")[0] || sub.Text.slice(0, 100),
                url: sub.FirstURL,
                source: new URL(sub.FirstURL).hostname.replace("www.", ""),
                snippet: sub.Text,
              });
            }
          }
        }
      }
    }

    // Also try the news-specific endpoint
    if (results.length < limit) {
      try {
        const newsRes = await fetch(
          `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (newsRes.ok) {
          const xml = await newsRes.text();
          // Simple regex extraction from RSS — no XML parser needed
          const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
          for (const match of itemMatches) {
            if (results.length >= limit) break;
            const item = match[1];
            const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
              || item.match(/<title>(.*?)<\/title>/)?.[1] || "";
            const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
            const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "";
            if (title && link) {
              results.push({
                title: title.slice(0, 200),
                url: link,
                source: source || new URL(link).hostname.replace("www.", ""),
                snippet: "",
              });
            }
          }
        }
      } catch (_) {}
    }

    return results.slice(0, limit);
  } catch (_) {
    return [];
  }
}

// ── Background discovery for unsatisfied searches ───────────────────
// When a search returns < 5 results, fire DuckDuckGo in the background,
// log what was found, and (future) enqueue new sources for RSS ingestion.
async function triggerSearchDiscovery(query: string, sessionId: string | null) {
  const sql = getDb();
  try {
    // Deduplicate: don't re-discover the same query within 1 hour
    const recent = await sql<{ id: number }[]>`
      SELECT id FROM news_search_log
      WHERE query = ${query}
        AND discovery_triggered = TRUE
        AND created_at > now() - interval '1 hour'
      LIMIT 1
    `;
    if (recent.length > 0) return;

    const ddgResults = await searchDuckDuckGoNews(query, 10);

    // Mark the most recent unsatisfied search as discovered
    await sql`
      UPDATE news_search_log
      SET discovery_triggered = TRUE,
          discovery_results = ${sql.json({
            ddg_count: ddgResults.length,
            results: ddgResults.slice(0, 5),
            triggered_at: new Date().toISOString(),
          })}
      WHERE id = (
        SELECT id FROM news_search_log
        WHERE query = ${query} AND unsatisfied = TRUE
        ORDER BY created_at DESC LIMIT 1
      )
    `;

    if (ddgResults.length > 0) {
      console.log(
        `[search-discovery] "${query}" → ${ddgResults.length} DuckDuckGo results`,
      );

      // Extract potential RSS feed URLs from the discovered domains
      const domains = [...new Set(ddgResults.map((r) => {
        try { return new URL(r.url).hostname; } catch (_) { return null; }
      }).filter(Boolean))] as string[];

      // Log discovered domains for future RSS ingestion
      if (domains.length > 0) {
        await sql`
          INSERT INTO news_search_log
            (session_id, query, result_count, discovery_results)
          VALUES (
            COALESCE(${sessionId}, 'system'),
            ${`__discovered_sources__:${query}`},
            ${ddgResults.length},
            ${sql.json({ domains, original_query: query })}
          )
        `;
      }
    }
  } catch (e) {
    console.error("[search-discovery] failed:", (e as Error).message);
  }
}

// ── POST /api/events/search ──────────────────────────────────────────
// Direct SQL search against news_events + news_locations.
// When results are few (< 5), triggers background DuckDuckGo discovery.
searchRoute.post(
  "/events/search",
  zValidator("json", PlaceSearchSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = placeSearchLimiter.check(ip);
    if (!rl.allowed) {
      const sec = Math.ceil(rl.retryAfterMs / 1000);
      return c.json({ error: "rate_limited", retry_after_s: sec }, 429);
    }

    const { q, limit } = c.req.valid("json");
    const t0 = Date.now();
    const sql = getDb();

    // Word-boundary-aware matching: prevents "gpu" matching "nagpur" or "rangpur"
    // \m = word start, \M = word end in PostgreSQL regex.
    // The pattern lives in api/src/lib/wordmatch.ts — ONE implementation,
    // shared with the pin search, which used to match bare substrings
    // while this route matched whole words (so the same query could
    // answer with two different sets of stories).
    const terms = q.trim().split(/\s+/);
    const wbPattern = (t: string) => wordBoundaryPattern(t);
    const eventMatchCondition = terms.flatMap(term => {
      const pat = wbPattern(term);
      return [
        sql`headline ~* ${pat}`,
        sql`summary ~* ${pat}`,
      ];
    }).reduce(
      (acc: any, cond: any, i: number) => i === 0 ? sql`${cond}` : sql`${acc} OR ${cond}`,
      sql`FALSE`
    );
    const locMatchCondition = sql`place_name ~* ${wbPattern(q)}`;

    const rows = await sql<{
      id: number;
      event_type: string;
      headline: string;
      summary: string | null;
      first_reported_at: string | null;
      source_count: number;
      relevance_days: number;
      expires_at: string | null;
      lat: number | null;
      lng: number | null;
      place_name: string | null;
      country: string | null;
      precision: string | null;
      url: string | null;
    }[]>`
      WITH event_matches AS (
        SELECT id FROM news_events
        WHERE ${eventMatchCondition}
      ),
      location_matches AS (
        SELECT id FROM news_locations
        WHERE ${locMatchCondition}
      ),
      all_event_ids AS (
        SELECT id FROM event_matches
        UNION
        SELECT id FROM location_matches
      )
      SELECT e.id, e.event_type, e.headline, e.summary,
             e.first_reported_at, e.source_count, e.relevance_days, e.expires_at,
             l.lat, l.lng, l.place_name, l.country, l.precision,
             first_source.url
      FROM news_events e
      LEFT JOIN news_locations l ON l.id = e.primary_location_id
      LEFT JOIN LATERAL (
        SELECT a.url FROM news_event_sources es
        JOIN news_articles a ON a.id = es.article_id
        WHERE es.event_id = e.id
        ORDER BY a.published_at DESC NULLS LAST
        LIMIT 1
      ) first_source ON true
      WHERE e.id IN (SELECT id FROM all_event_ids)
        AND (e.expires_at IS NULL OR e.expires_at > now())
      ORDER BY e.first_reported_at DESC, e.id DESC
      LIMIT ${limit}
    `;

    const durationMs = Date.now() - t0;
    console.log(`[search] "${q}" (limit ${limit}) → ${rows.length} results in ${durationMs}ms`);

    const events = rows.map((r) => ({
      id: Number(r.id),
      event_type: r.event_type,
      headline: r.headline,
      summary: r.summary,
      first_reported_at: r.first_reported_at,
      source_count: r.source_count,
      relevance_days: r.relevance_days,
      expires_at: r.expires_at,
      url: r.url || null,
      location: r.lat != null && r.lng != null
        ? { lat: Number(r.lat), lng: Number(r.lng), place_name: r.place_name, country: r.country, precision: r.precision }
        : null,
    }));

    // Log the search and trigger discovery if results are few
    const sessionId = c.req.header("X-Session-Id") || "anonymous";
    try {
      await sql`
        INSERT INTO news_search_log (session_id, query, result_count)
        VALUES (${sessionId}, ${q}, ${events.length})
      `;
    } catch (_) {}

    // Fire-and-forget: if few results, search DuckDuckGo for more sources
    if (events.length < 5) {
      triggerSearchDiscovery(q, sessionId).catch(() => {});
    }

    return c.json({
      query: q,
      duration_s: durationMs / 1000,
      count: events.length,
      events,
      discovery: events.length < 5 ? "searching" : undefined,
    });
  },
);

// ── POST /api/search/log ────────────────────────────────────────────
// Persist a user-typed search query for analytics.
const SearchLogSchema = z.object({
  q: z.string().min(1).max(500).optional(),
  query: z.string().min(1).max(500).optional(),
  result_count: z.number().int().min(0).optional(),
  session_id: z.string().max(200).optional(),
  user_lat: z.number().min(-90).max(90).optional(),
  user_lng: z.number().min(-180).max(180).optional(),
  user_country: z.string().max(8).optional(),
  top_results: z.array(z.unknown()).max(50).optional(),
});

searchRoute.post(
  "/search/log",
  zValidator("json", SearchLogSchema),
  async (c) => {
    const body = c.req.valid("json");
    const queryStr = body.q ?? body.query;
    if (!queryStr) return c.json({ error: "missing_query" }, 400);

    const sql = getDb();
    try {
      await sql`
        INSERT INTO news_search_log
          (session_id, query, result_count, user_lat, user_lng, user_country, top_results)
        VALUES
          (${body.session_id ?? null}, ${queryStr},
           ${body.result_count ?? null}, ${body.user_lat ?? null},
           ${body.user_lng ?? null}, ${body.user_country ?? null},
           ${body.top_results ? sql.json(body.top_results) : null})
      `;
    } catch (e) {
      console.error("[search/log] insert failed:", (e as Error).message);
    }
    return c.json({ ok: true });
  },
);

// ── GET /api/search/discovery ────────────────────────────────────────
// Polls for discovery results from background DuckDuckGo search.
// The frontend polls this after a search triggers discovery.
searchRoute.get("/search/discovery", async (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "missing_query" }, 400);

  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT discovery_results, discovery_triggered
    FROM news_search_log
    WHERE query = ${query}
      AND discovery_triggered = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ status: "not_found", results: [] });
  }

  const row = rows[0];
  if (row.discovery_results) {
    return c.json({ status: "ready", results: row.discovery_results });
  }

  return c.json({ status: "searching", results: [] });
});
