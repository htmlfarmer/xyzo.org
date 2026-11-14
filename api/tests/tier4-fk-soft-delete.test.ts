import { describe, expect, test, afterAll } from "bun:test";
import { randomUUID } from "crypto";
import { getDb, closeDb } from "../src/db";

// Tier 1.4 of the consolidated audit fix-order. Verifies that:
//   1. news_sources.deleted_at column exists and is nullable
//      (TIMESTAMPTZ).
//   2. All 4 FK constraints exist on news_interactions (NOT NULL or
//      nullable doesn't matter — these are constraints on columns
//      that already existed nullable).
//   3. news_articles.source_id is nullable (we drop NOT NULL as
//      part of the Tier 1.4 migration so SET NULL has a target).
//   4. news_articles.source_id_fkey is SET NULL (not CASCADE).
//      'confdeltype' values: 'a'=NO ACTION, 'r'=RESTRICT, 'c'=CASCADE,
//      'n'=SET NULL, 'd'=SET DEFAULT.
//   5. Soft-delete: setting deleted_at hides a source from a
//      "WHERE deleted_at IS NULL" filter, but the row stays in the
//      table so rankings / leaderboard / history survive.
//
// Migration: 2026-09-08-fk-soft-delete.sql applies all of the above
// in production.

const SQL = () => getDb();

async function cleanupTestRows(): Promise<void> {
  const sql = SQL();
  await sql`DELETE FROM news_sources WHERE feed_url LIKE 'test-soft-del-%'`;
}

afterAll(async () => {
  await cleanupTestRows();
  await closeDb();
});

describe("Tier 1.4: FK constraints + soft-delete on news_sources", () => {
  test("news_sources.deleted_at column exists and is nullable TIMESTAMPTZ", async () => {
    const sql = SQL();
    const rows = await sql<Array<{ column_name: string; is_nullable: string; data_type: string }>>`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'news_sources' AND column_name = 'deleted_at'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe("YES");
    expect(rows[0].data_type).toBe("timestamp with time zone");
  });

  test("FK constraints exist on news_interactions (pin/article/source/event)", async () => {
    const sql = SQL();
    const rows = await sql<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'news_interactions'::regclass
        AND contype = 'f'
        AND conname IN (
          'news_interactions_pin_fk',
          'news_interactions_article_fk',
          'news_interactions_source_fk',
          'news_interactions_event_fk'
        )
    `;
    expect(rows.length).toBe(4);
    const names = rows.map((r) => r.conname).sort();
    expect(names).toEqual([
      "news_interactions_article_fk",
      "news_interactions_event_fk",
      "news_interactions_pin_fk",
      "news_interactions_source_fk",
    ]);
  });

  test("news_articles.source_id is nullable (dropped NOT NULL)", async () => {
    const sql = SQL();
    const rows = await sql<Array<{ is_nullable: string }>>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'news_articles' AND column_name = 'source_id'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe("YES");
  });

  test("FK on news_articles.source_id is SET NULL (not CASCADE)", async () => {
    const sql = SQL();
    const rows = await sql<Array<{ confdeltype: string }>>`
      SELECT confdeltype FROM pg_constraint
      WHERE conname = 'news_articles_source_id_fkey'
    `;
    expect(rows.length).toBe(1);
    // 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL, 'd' = SET DEFAULT
    expect(rows[0].confdeltype).toBe("n");
  });

  test("Soft-delete: setting deleted_at hides source from public WHERE filter, row remains", async () => {
    const sql = SQL();
    const unique = randomUUID();
    const feedUrl = `test-soft-del-${unique}.example`;

    // Insert a temporary source. The feed_url UNIQUE constraint means
    // we need a unique value per test run, hence the randomUUID().
    const inserted = await sql<Array<{ id: string | number }>>`
      INSERT INTO news_sources (name, feed_url, source_type)
      VALUES (${"test-soft-del-" + unique}, ${feedUrl}, 'rss')
      RETURNING id
    `;
    expect(inserted.length).toBe(1);
    const sourceId = inserted[0].id;

    // Before soft-delete: visible under both queries.
    const visibleBefore = await sql`
      SELECT id FROM news_sources WHERE id = ${sourceId} AND deleted_at IS NULL
    `;
    expect(visibleBefore.length).toBe(1);

    // Soft-delete.
    await sql`UPDATE news_sources SET deleted_at = now() WHERE id = ${sourceId}`;

    // After soft-delete: NOT visible under the public filter.
    const visibleAfter = await sql`
      SELECT id FROM news_sources WHERE id = ${sourceId} AND deleted_at IS NULL
    `;
    expect(visibleAfter.length).toBe(0);

    // But still in the table — the row, its rankings, its articles
    // all survive. The FK on news_articles.source_id is SET NULL,
    // not CASCADE, so articles also survive.
    const totalAfter = await sql`
      SELECT id FROM news_sources WHERE id = ${sourceId}
    `;
    expect(totalAfter.length).toBe(1);

    // Cleanup.
    await sql`DELETE FROM news_sources WHERE id = ${sourceId}`;
  });
});
