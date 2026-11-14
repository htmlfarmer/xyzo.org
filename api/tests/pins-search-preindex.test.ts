/**
 * /api/pins — the PRE-INDEX answers a popular query without running the
 * search again.
 *
 * WHY. Measured 2026-11-11 on the live site, a text search took 24–75 s
 * cold (before the index fixes of the same day) and 0.5–2 s after them.
 * That is still a database query per reader, over a corpus that grows
 * every minute — and under load (the box ran at load average 14) the
 * same query measured 0.5 s and 21.8 s on consecutive calls.
 *
 * The pre-index answers the most-searched queries from a stored answer
 * instead, and a background job (worker/search_preindex.py) keeps that
 * answer current. The reader gets it in ~100 ms; the answer says how old
 * it is, because a stored answer that does not say its age is
 * yesterday's news served as if it were this morning's.
 *
 * THE RULES THIS PINS:
 *
 *   * the pre-index answers ONLY a plain text search — a bbox, a cursor,
 *     a category, a tag or a source filter is a DIFFERENT answer, and
 *     the pre-index does not hold those;
 *   * the answer carries its age (`built_at`) and the response says
 *     where it came from (the `X-Search-Source` header);
 *   * an entry older than PREINDEX_MAX_AGE_MS is NOT served — the live
 *     query is right there;
 *   * a refresh request (the `X-Search-Fresh: 1` header the builder
 *     sends) bypasses BOTH the pre-index and the RAM cache, or the
 *     builder would copy the stored answer over itself and the store
 *     would never get fresher;
 *   * the KEY carries the time WINDOW, not the timestamp — the frontend
 *     asks for "24h" as `since=<now - 24h, snapped to the minute>`, so
 *     a key built from the timestamp would change every minute and the
 *     stored answer would never be found again.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { searchCache, pinsCache } from "../src/cache";
import { getDb } from "../src/db";
import { windowKeyFor, queryKeyFor, normaliseQuery } from "../src/lib/preindex";

const sql = getDb();
const app = new Hono();
app.route("/api", pinsRoute);

async function seed() {
  // A UNIQUE feed url per test: truncateAll() clears news_articles (and
  // cascades to the tables that reference it) but NOT news_sources, so a
  // fixed url would collide with the previous test's row.
  const feed = `https://preindex.test.invalid/${Math.random().toString(36).slice(2)}`;
  const [src] = await sql<{ id: number }[]>`
    INSERT INTO news_sources (name, feed_url, source_type, country, active)
    VALUES ('ZZ Preindex Test', ${feed}, 'rss', 'US', TRUE)
    RETURNING id
  `;
  const sid = Number(src.id);
  await sql`
    INSERT INTO news_articles (title, url, source_id, status, hidden_at,
                               extracted_lat, extracted_lng, fetched_at, published_at, event_type)
    VALUES ('Preindex probe article about Lisbon', 'https://preindex.test.invalid/lisbon',
            ${sid}, 'extracted', NULL, 38.72, -9.14, now(), now(), 'culture')
  `;
  searchCache.clear();
  pinsCache.clear();
  return sid;
}

async function storePreindex(query: string, window: string, limit: number, pins: any[]) {
  const key = queryKeyFor(query, window, null, limit);
  await sql`
    INSERT INTO search_preindex (query_key, query, time_window, tag, limit_n, payload, pin_count, built_at, expires_at)
    VALUES (${key}, ${query}, ${window}, '', ${limit}, ${sql.json({ pins, next_cursor: null, has_more: false })}::jsonb,
            ${pins.length}, now(), now() + interval '6 hours')
    ON CONFLICT (query_key, time_window, tag, limit_n) DO UPDATE
      SET payload = EXCLUDED.payload, pin_count = EXCLUDED.pin_count, built_at = now()
  `;
}

describe("the pre-index answers a popular query", () => {
  beforeEach(async () => {
    // A TARGETED cleanup, not truncateAll(): the full TRUNCATE cascades
    // to ~80 tables and measured 15 s on a loaded box — more than the
    // 5 s hook budget, and the failure looks like a broken test rather
    // than a busy machine. This test owns its rows, so it deletes
    // exactly those.
    await sql`DELETE FROM news_articles WHERE url LIKE 'https://preindex.test.invalid/%'`;
    await sql`DELETE FROM news_sources WHERE feed_url LIKE 'https://preindex.test.invalid/%'`;
    // The pre-index tables are not in truncateAll()'s list (they are not
    // part of the article graph), so they are cleared here.
    await sql`TRUNCATE search_preindex, search_query_stats`;
    await seed();
  });

  test("a stored answer is served instead of running the search", async () => {
    await storePreindex("lisbon", "all", 500, [
      { id: 999999, title: "A stored answer about Lisbon", lat: 38.72, lng: -9.14 },
    ]);
    const res = await app.request("/api/pins?q=lisbon&limit=500");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Search-Source")).toBe("preindex");
    // The age is in the answer, not only in a header.
    const body = await res.json();
    expect(body.source).toBe("preindex");
    expect(body.built_at).toBeTruthy();
    expect(body.pins[0].title).toContain("A stored answer");
  });

  test("a stored answer is NOT served for a bbox or a filtered search", async () => {
    await storePreindex("lisbon", "all", 500, [{ id: 1, title: "stored" }]);
    const bbox = await app.request("/api/pins?q=lisbon&limit=500&bbox=-9.2,38.7,-9.1,38.8");
    expect(bbox.headers.get("X-Search-Source")).toBe(null);
    const cat = await app.request("/api/pins?q=lisbon&limit=500&category=culture");
    expect(cat.headers.get("X-Search-Source")).toBe(null);
  });

  test("an EXPIRED answer is not served — the live query answers instead", async () => {
    const key = queryKeyFor("lisbon", "all", null, 500);
    await sql`
      INSERT INTO search_preindex (query_key, query, time_window, tag, limit_n, payload, pin_count, built_at, expires_at)
      VALUES (${key}, 'lisbon', 'all', '', 500, ${sql.json({ pins: [{ id: 1, title: "stale" }] })}::jsonb,
              1, now() - interval '7 hours', now() - interval '1 hour')
    `;
    const res = await app.request("/api/pins?q=lisbon&limit=500");
    expect(res.headers.get("X-Search-Source")).toBe(null);
  });

  test("a refresh request bypasses the pre-index AND the RAM cache", async () => {
    await storePreindex("lisbon", "all", 500, [{ id: 1, title: "stored answer" }]);
    const res = await app.request("/api/pins?q=lisbon&limit=500", {
      headers: { "X-Search-Fresh": "1" },
    });
    expect(res.status).toBe(200);
    // The builder must get the LIVE answer, or it would copy the stored
    // answer over itself and the store would never get fresher.
    expect(res.headers.get("X-Search-Source")).toBe(null);
    const body = await res.json();
    expect(body.pins[0].title).not.toContain("stored answer");
  });

  test("the key carries the WINDOW, not the timestamp", async () => {
    // The frontend asks for "24h" as a timestamp that changes every
    // minute; the key must be stable across those minutes.
    const a = windowKeyFor(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const b = windowKeyFor(new Date(Date.now() - 24 * 3600 * 1000 - 30 * 1000).toISOString());
    expect(a).toBe("24h");
    expect(b).toBe("24h");
    expect(windowKeyFor(undefined)).toBe("all");
    expect(windowKeyFor(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())).toBe("7d");
    expect(queryKeyFor("Lisbon", "24h", null, 500)).toBe("lisbon|24h||500");
    expect(normaliseQuery("São Paulo")).toBe("sao paulo");
  });

  test("a query is recorded, so the pre-index list is the real demand", async () => {
    await app.request("/api/pins?q=hamburg&limit=500");
    await new Promise((r) => setTimeout(r, 400));
    const rows = await sql<{ query: string; use_count: number }[]>`
      SELECT query, use_count FROM search_query_stats WHERE query = 'hamburg'
    `;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].use_count)).toBeGreaterThan(0);
  });

  test("a SMALLER limit is served by SLICING a bigger stored answer", async () => {
    // The stored answer is the RANKED list, and the ranking does not
    // depend on the limit — so the first N of a 1,000-pin answer is
    // exactly what the live query would have answered for N. Without
    // this, a reader who asked for 100 pins of a query stored at 1,000
    // pays the whole live query for an answer that is already on disk.
    const pins = Array.from({ length: 10 }, (_, i) => ({
      id: 1000 + i,
      title: `Stored Lisbon story ${i}`,
      created_at: new Date(Date.now() - i * 60000).toISOString(),
    }));
    await storePreindex("lisbon", "all", 1000, pins);

    const res = await app.request("/api/pins?q=lisbon&limit=4");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Search-Source")).toBe("preindex");
    const body = await res.json();
    // The first FOUR of the stored list, in the stored order.
    expect(body.pins.length).toBe(4);
    expect(body.pins[0].title).toBe("Stored Lisbon story 0");
    expect(body.pins[3].title).toBe("Stored Lisbon story 3");
    // And the pagination is recomputed — there ARE more stories, and the
    // cursor points at the last row that was kept.
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();
  });

  test("a limit BIGGER than anything stored falls through to the live query", async () => {
    // A stored answer can be sliced down, never up — the bigger list
    // does not exist yet, so the live query answers.
    await storePreindex("lisbon", "all", 500, [{ id: 1, title: "stored" }]);
    const res = await app.request("/api/pins?q=lisbon&limit=1000");
    expect(res.headers.get("X-Search-Source")).toBe(null);
  });
});
