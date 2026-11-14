-- ── 2026-09-06-strip-cdata-from-titles.sql ─────────────────────────────
--
-- One-time cleanup: 671 titles + 570 summaries in news_articles still
-- carry raw "<![CDATA[ ... ]]>" markers. Some feeds (commonly PT/ES/EL)
-- wrap their <title>/<description> in CDATA. feedparser does not strip
-- these markers — they pass through into the DB and surface in the UI.
--
-- The matching ingest-side fix landed in worker/fetch.py:_strip_cdata,
-- so this migration is just a backfill for legacy rows.
--
-- Idempotent: only touches rows that still contain the marker. Repeating
-- the migration on a clean DB is a no-op. Safe to run live — UPDATE
-- takes a brief exclusive lock per row but doesn't rewrite the table.
--
-- Runs with session_replication_role = 'replica' so the
-- trigger_detect_article_cities BEFORE-UPDATE trigger is skipped. That
-- trigger queries world_cities via FDW, which requires a user mapping
-- the migration user may not have. After this migration, city labels
-- will be re-derived by auto_categorize.py on the next cycle.

BEGIN;
SET LOCAL session_replication_role = 'replica';

DO $$
DECLARE
    titles_updated   INT;
    summaries_updated INT;
BEGIN
    UPDATE news_articles
    SET title = TRIM(v.new_title)
    FROM (
        SELECT id, REGEXP_REPLACE(title, '<!\[CDATA\[\s*(.*?)\s*\]\]>', '\1', 'g') AS new_title
        FROM news_articles
        WHERE title LIKE '%<![CDATA[%'
    ) v
    WHERE news_articles.id = v.id;

    GET DIAGNOSTICS titles_updated = ROW_COUNT;

    UPDATE news_articles
    SET summary = TRIM(v.new_summary)
    FROM (
        SELECT id, REGEXP_REPLACE(summary, '<!\[CDATA\[\s*(.*?)\s*\]\]>', '\1', 'g') AS new_summary
        FROM news_articles
        WHERE summary LIKE '%<![CDATA[%'
    ) v
    WHERE news_articles.id = v.id;

    GET DIAGNOSTICS summaries_updated = ROW_COUNT;

    RAISE NOTICE 'CDATA cleanup: % titles, % summaries cleaned', titles_updated, summaries_updated;
END$$;

COMMIT;
