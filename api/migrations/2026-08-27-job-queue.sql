-- Newsium worker job queue (Slice A)
-- Idempotent: safe to re-run.

DO $$ BEGIN
  CREATE TYPE job_kind AS ENUM (
    'explore_region', 'sources_audit', 'links_generate',
    'auto_categorize', 'analytics_inline', 'community_triage', 'feedback_suggest'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             job_kind NOT NULL,
  priority         smallint NOT NULL DEFAULT 0,
  payload          jsonb NOT NULL,
  status           job_status NOT NULL DEFAULT 'queued',
  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL DEFAULT 1,
  enqueued_by      text,
  result           jsonb,
  error            text,
  traceback        text,
  worker_id        text,
  heartbeat_at     timestamptz,
  scheduled_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  state            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS discovery_jobs_claim_idx
  ON discovery_jobs (priority DESC, scheduled_at ASC)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS discovery_jobs_status_idx
  ON discovery_jobs (status, heartbeat_at)
  WHERE status IN ('claimed', 'running');

-- NB: `result` (jsonb) and `state` (jsonb) intentionally NOT INCLUDEd here.
-- They can push index rows past the 8KB btree limit (especially `result`
-- for rich explore_region returns), causing UPDATEs to fail with:
--   "index row size NNNN exceeds btree version 4 maximum 8191"
-- The columns are tiny/small varchars and don't benefit from INCLUDE.
-- Both columns are read via full-row SELECT, so they don't need to be
-- in the index to satisfy any queue-path query.
CREATE INDEX IF NOT EXISTS discovery_jobs_id_status_idx
  ON discovery_jobs (id) INCLUDE (status, error, kind, attempts);
