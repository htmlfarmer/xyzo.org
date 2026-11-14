-- 2026-09-07-source-poll-observations.sql
--
-- Per-poll observation log.
--
-- Records one row for every feed fetch attempted by worker/fetch.py so we
-- can (a) measure true discovery lag (newest_published_at vs polled_at),
-- (b) detect right-censoring (hit_item_cap = true means the feed returned
--     >= limit_per_source and we may have missed older items), and
-- (c) build a rate-estimator predictor in a follow-up session once we
--     have >= 2 weeks of independent observations.
--
-- This table is APPENDED by the worker, NEVER read by the fetch hot path.
-- A failure to insert MUST NOT block the fetch. Wrap the INSERT in a
-- try/except in fetch.py and log to stderr on failure.
--
-- Idempotent: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS source_poll_observations (
  id                  bigserial PRIMARY KEY,
  source_id           bigint NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  polled_at           timestamptz NOT NULL DEFAULT now(),
  http_status         integer,           -- HTTP code (200, 304, 4xx, 5xx); NULL on transport error
  items_returned      integer NOT NULL DEFAULT 0,  -- count BEFORE cap truncation (censor flag)
  items_new           integer NOT NULL DEFAULT 0,  -- count AFTER insert dedup (true increment)
  hit_item_cap        boolean NOT NULL DEFAULT false, -- true if len(articles) >= limit_per_source
  newest_published_at timestamptz,       -- publication time of newest item in the returned page
  oldest_published_at timestamptz,       -- publication time of oldest item in the returned page
  tier                text,              -- tier_for_url(feed_url) at time of poll ('gov'|'university'|'community'|'commercial'|'platform')
  outcome             text NOT NULL      -- 'ok' | 'not_modified' | 'error' | 'robots_block'
);
CREATE INDEX IF NOT EXISTS spo_source_polled_idx
  ON source_poll_observations (source_id, polled_at DESC);
CREATE INDEX IF NOT EXISTS spo_outcome_idx
  ON source_poll_observations (outcome, polled_at DESC);

-- GRANT to app role (HANDOFF §3.5, AGENTS.md "Database Rules").
GRANT SELECT, INSERT ON source_poll_observations TO xyzo_app;
GRANT USAGE, SELECT ON SEQUENCE source_poll_observations_id_seq TO xyzo_app;
