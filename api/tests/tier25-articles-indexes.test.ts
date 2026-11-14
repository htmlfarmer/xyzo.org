import { describe, expect, test, afterAll } from "bun:test";
import { getDb, closeDb } from "../src/db";

// Tier 2.5 of the consolidated audit fix-order. Tier 2 verification
// surfaced 3 /api/analytics/* endpoints that Seq Scan on
// news_articles. After EXPLAIN ANALYZE on each against the live DB
// (79,035 rows), only ONE index actually flipped a Seq Scan into an
// Index Scan — /api/analytics/reported-articles (45.4 ms → 0.04 ms).
//
// The other two audit candidates were intentionally NOT indexed:
//
//   • /api/analytics/trending   (event_type, fetched_at 24h filter)
//     30% selectivity → Parallel Seq Scan (22.8 ms) is already
//     optimal. Forcing the new partial index makes it 36.4 ms.
//
//   • /api/analytics/stats top_articles subquery
//     (status = 'extracted' filter)
//     79% selectivity → Seq Scan is optimal; the existing
//     idx_news_articles_source_7d ON (source_id) WHERE status=
//     'extracted' already handles the JOIN-side filter.
//
// This test verifies the migration:
//   1. news_articles_report_count_idx actually exists.
//   2. The reported-articles query now uses an Index Scan, not a
//      Seq Scan.
//   3. The two rejected indexes are NOT present (negative tests —
//      guards against someone recreating them in a future change
//      without re-running the EXPLAIN ANALYZE).

const SQL = () => getDb();

afterAll(async () => {
  await closeDb();
});

describe("Tier 2.5: news_articles indexes migration", () => {
  test("news_articles_report_count_idx exists", async () => {
    const sql = SQL();
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'news_articles'
        AND indexname = 'news_articles_report_count_idx'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].indexname).toBe("news_articles_report_count_idx");
  });

  test("reported-articles query uses Index Scan, not Seq Scan", async () => {
    const sql = SQL();
    const rows = await sql<{ "QUERY PLAN": any }[]>`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM news_articles WHERE report_count >= 1
    `;
    const planJson = JSON.stringify(rows[0]["QUERY PLAN"]);
    expect(planJson).toMatch(/Index Scan|Bitmap Heap Scan/);
    expect(planJson).not.toMatch(/"Seq Scan"/);
  });

  test("reported-articles query touches the new index", async () => {
    const sql = SQL();
    const rows = await sql<{ "QUERY PLAN": any }[]>`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM news_articles WHERE report_count >= 1
    `;
    const planJson = JSON.stringify(rows[0]["QUERY PLAN"]);
    expect(planJson).toContain("news_articles_report_count_idx");
  });

  // Negative tests — guard against recreating the two indexes the
  // planner rejected. If a future change re-adds them, this test will
  // fail and force the implementer to re-run EXPLAIN ANALYZE first.
  test("news_articles_event_type_fetched_idx NOT created (trending)", async () => {
    const sql = SQL();
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'news_articles'
        AND indexname = 'news_articles_event_type_fetched_idx'
    `;
    expect(rows.length).toBe(0);
  });

  test("news_articles_status_source_idx NOT created (stats top_articles)", async () => {
    const sql = SQL();
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'news_articles'
        AND indexname = 'news_articles_status_source_idx'
    `;
    expect(rows.length).toBe(0);
  });
});
