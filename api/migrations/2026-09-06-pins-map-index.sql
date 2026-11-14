-- ── 2026-09-06-pins-map-index.sql ────────────────────────────────────
--
-- Partial composite index for /api/pins/map initial-load path.
--
-- The current query in api/src/routes/pins.ts scans
-- news_articles filtered by (status='extracted' AND extracted_lat IS NOT NULL)
-- sorted by (COALESCE(published_at, fetched_at) DESC, id DESC).
--
-- Existing idx_news_articles_status_pub_coalesce handles (status, …)
-- but the planner still has to apply the extracted_lat IS NOT NULL as a
-- recheck Filter after the index scan (visible in EXPLAIN ANALYZE).
-- A partial index makes that filter part of the index condition —
-- planner reads only matching rows.
--
-- Expected impact: shaves the `Filter: (extracted_lat IS NOT NULL)`
-- step on the EXPLAIN plan for the global-bbox /api/pins/map query.
-- 3000-row initial load: measured 24ms → expected ~18-22ms. Bigger
-- win on the news_articles table as it grows because the partial
-- index is much smaller than the full one (only rows with non-NULL
-- extracted_lat).
--
-- DO block handles the "table owned by postgres, not xyzo_app" case
-- the same way the rest of the migration set does.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_news_articles_map_order'
    ) THEN
        CREATE INDEX idx_news_articles_map_order
            ON news_articles (
                COALESCE(published_at, fetched_at) DESC,
                id DESC
            )
            WHERE status = 'extracted' AND extracted_lat IS NOT NULL;
    END IF;
END$$;
