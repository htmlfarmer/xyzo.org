-- 2026-09-07-last-polled-at.sql
--
-- Per-source "last polled" timestamp + partial index (Step 3).
--
-- Enforces the standing politeness rule (HANDOFF §3.1, README §9.6,
-- memory/government-site-politeness.md): .gov hosts are not polled more
-- than once every 24h, .edu (ac.*) hosts not more than once every 6h.
-- The gate lives in SQL — that's the only place the constraint can hold
-- against the two overlapping fetcher timers (xyzo-fetcher at
-- :0/15/30/45, xyzo-fast-fetcher every 5 min).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- GRANT to app role (HANDOFF §3.5, AGENTS.md "Database Rules") —
-- the UPDATE on news_sources is needed by the lease claim CTE.

ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

-- Partial index — only active sources (the gate's WHERE active = TRUE
-- clause). Smaller than a full index; the gate query benefits without
-- bloating the planner's choice set on other queries.
CREATE INDEX IF NOT EXISTS news_sources_active_last_polled_idx
  ON news_sources (last_polled_at) WHERE active = TRUE;

GRANT SELECT, INSERT, UPDATE ON news_sources TO xyzo_app;
