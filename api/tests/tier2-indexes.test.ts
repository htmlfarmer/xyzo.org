import { describe, expect, test, afterAll } from "bun:test";
import { getDb, closeDb } from "../src/db";

// Tier 2 of the consolidated audit fix-order. Audit 2 found several
// /api/analytics/* queries doing Seq Scans. After EXPLAIN ANALYZE on
// the live DB, the only gap that actually needed a new index was
// /api/analytics/heatmap — its `WHERE window_start > now() - X hours`
// filter had no leftmost index because the existing UNIQUE
// constraint puts (grid_lat, grid_lng) before window_start. This
// test verifies:
//
//   1. The new index actually exists in pg_indexes.
//   2. The 24h heatmap query now uses an Index Scan (not Seq Scan),
//      since the default 24h window is the access pattern the
//      analytics endpoint actually exercises.
//
// The other audit candidates (news_interactions.{session_id,
// interaction_type, created_at} and news_location_views.{created_at})
// were already efficiently indexed — the planner picks
// news_interactions_session_idx, news_interactions_type_idx,
// news_interactions_time_idx, and news_location_views_time_idx
// respectively. No new indexes are needed for those, so no tests
// are added here for them (the migrations header documents each
// one's EXPLAIN verdict).

const SQL = () => getDb();

afterAll(async () => {
  await closeDb();
});

describe("Tier 2: analytics indexes migration", () => {
  test("news_geo_interest_window_start_idx exists", async () => {
    const sql = SQL();
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'news_geo_interest'
        AND indexname = 'news_geo_interest_window_start_idx'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].indexname).toBe("news_geo_interest_window_start_idx");
  });

  test("heatmap 24h query uses Index Scan, not Seq Scan", async () => {
    const sql = SQL();
    // Use FORMAT JSON so the plan is a parseable structure. The
    // default TEXT format already says "Seq Scan" / "Index Scan" /
    // "Bitmap Heap Scan" verbatim, but JSON makes it easier to assert
    // on Node names without substring matching the surrounding text.
    const rows = await sql<{ "QUERY PLAN": any }[]>`
      EXPLAIN (FORMAT JSON)
      SELECT grid_lat, grid_lng, SUM(interest_score) as score
      FROM news_geo_interest
      WHERE window_start > now() - interval '24 hours'
      GROUP BY grid_lat, grid_lng
      ORDER BY score DESC
      LIMIT 500
    `;
    const planJson = JSON.stringify(rows[0]["QUERY PLAN"]);
    // Either "Index Scan" or "Bitmap Heap Scan" indicates index use
    // (Bitmap Heap Scan means the index was used to build a bitmap
    // and the heap was read from there).
    expect(planJson).toMatch(/Index Scan|Bitmap Heap Scan/);
    // Should NOT contain a top-level "Seq Scan" — only the inner
    // subnodes like "Sort" or "HashAggregate" should appear, not a
    // raw scan over the whole table.
    expect(planJson).not.toMatch(/"Seq Scan"/);
  });

  test("heatmap 24h query touches the new index", async () => {
    const sql = SQL();
    const rows = await sql<{ "QUERY PLAN": any }[]>`
      EXPLAIN (FORMAT JSON)
      SELECT grid_lat, grid_lng, SUM(interest_score) as score
      FROM news_geo_interest
      WHERE window_start > now() - interval '24 hours'
      GROUP BY grid_lat, grid_lng
      ORDER BY score DESC
      LIMIT 500
    `;
    const planJson = JSON.stringify(rows[0]["QUERY PLAN"]);
    // Verify the specific new index is named in the plan, not just
    // any index. This guards against the index being silently
    // dropped or never picked.
    expect(planJson).toContain("news_geo_interest_window_start_idx");
  });
});