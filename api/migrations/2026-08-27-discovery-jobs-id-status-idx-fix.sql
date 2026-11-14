-- api/migrations/2026-08-27-discovery-jobs-id-status-idx-fix.sql
--
-- Fix index overflow on discovery_jobs. The original index included the jsonb
-- `result` column, which can exceed btree's 8KB row limit for non-trivial
-- explore_region results (rich discovered_sources, existing_news.articles,
-- existing_news.events). Drop and recreate without the offending columns.
-- Both columns are read via full-row SELECT, not index-only scans, so removing
-- them from INCLUDE has no query-path downside.

BEGIN;

DROP INDEX IF EXISTS discovery_jobs_id_status_idx;

CREATE INDEX IF NOT EXISTS discovery_jobs_id_status_idx
  ON discovery_jobs (id) INCLUDE (status, error, kind, attempts);

COMMIT;
