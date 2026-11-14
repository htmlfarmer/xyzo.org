-- 2026-09-06-cadence-runs.sql
-- Create cadence_runs: a log of every attempt to run worker/source_cadence.
-- T-22 found that the cadence worker had been silently crashing on every
-- systemd timer run because api/.env exports XYZO_DB_URL but the worker
-- only accepted XYZO_DB_DSN. The crash was only visible in the journal;
-- nothing in the database flagged "this column hasn't been updated in
-- 30 days". This table makes a worker run (success or failure) visible
-- in SQL so the next env-var / DSN / SQL regression surfaces immediately.
--
-- Idempotent: skip if table already exists.

CREATE TABLE IF NOT EXISTS cadence_runs (
  id              bigserial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running',  -- running | success | failed
  sources_analyzed integer,
  tier_counts     jsonb,
  error_message   text,
  trigger         text,  -- e.g. 'cli', 'systemd', 'cron' — set by caller
  duration_ms     integer GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000
  ) STORED
);

CREATE INDEX IF NOT EXISTS cadence_runs_started_idx
  ON cadence_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS cadence_runs_status_idx
  ON cadence_runs (status, started_at DESC);

-- Grant access to the app role (matches HANDOFF §3.5).
GRANT SELECT, INSERT ON cadence_runs TO xyzo_app;
GRANT USAGE, SELECT ON SEQUENCE cadence_runs_id_seq TO xyzo_app;
