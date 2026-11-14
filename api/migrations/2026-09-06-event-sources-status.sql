-- ── 2026-09-06-event-sources-status.sql ────────────────────────────
--
-- Add crawl_status + robots_allowed to event_sources so the worker
-- can record per-source health independent of the per-event rows.
-- These columns already exist on upcoming_events from the schema-
-- extend migration.

BEGIN;

ALTER TABLE event_sources
    ADD COLUMN IF NOT EXISTS crawl_status TEXT NOT NULL DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS robots_allowed BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS event_sources_crawl_status_idx
    ON event_sources (crawl_status, last_fetched_at DESC)
    WHERE crawl_status <> 'ok';

COMMIT;
