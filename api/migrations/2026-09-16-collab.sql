-- Migration: collab system (PR-1)
-- Idempotent. Safe to re-run.
--
-- Adds three tables for the `collab` node network — a system that lets
-- external collaborators run their computers as workers for xyzo/hivv/blnq
-- via a one-line `curl | bash` install.
--
-- Tables:
--   collab_nodes   — registered collaborator machines (one row per install)
--   collab_jobs    — work units available to scripts mode
--   collab_activity — append-only audit log per node (heartbeats, job runs)
--
-- PR-1 only wires `scripts` mode. PR-2 adds `gateway`/`model_serve`.
-- PR-3 adds `content` (blnq). PR-4 adds `discovery` + `self_improve`.

CREATE TABLE IF NOT EXISTS collab_nodes (
    id                  BIGSERIAL PRIMARY KEY,
    node_id             TEXT NOT NULL UNIQUE,         -- public, 12-char base32
    name                TEXT,                          -- user-chosen display name
    public_key          TEXT NOT NULL,                 -- RSA pubkey PEM (for future signed requests)
    roles               TEXT[] NOT NULL DEFAULT ARRAY['scripts']::TEXT[],
    os                  TEXT,                          -- 'macos' | 'linux' | 'wsl' | ...
    arch                TEXT,                          -- 'arm64' | 'x86_64'
    python_version      TEXT,
    collabd_version     TEXT,
    status              TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'disabled'
    registered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at   TIMESTAMPTZ,
    last_heartbeat_meta JSONB,                          -- {jobs_done, errors, uptime_s, ...}
    dashboard_token     TEXT NOT NULL                  -- bearer token for /api/collab/* writes
);

CREATE INDEX IF NOT EXISTS collab_nodes_status_idx ON collab_nodes (status, last_heartbeat_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS collab_nodes_node_id_idx ON collab_nodes (node_id);

-- Jobs: a unit of work for the `scripts` mode. PR-1 only supports kind='shell'.
-- payload is opaque JSON (interpreted by the runner). result is JSONB returned
-- from the worker. timeout_seconds caps execution; runner kills the process
-- group if it overruns.
CREATE TABLE IF NOT EXISTS collab_jobs (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'shell',     -- 'shell' | future: 'ai_extract' | 'classify'
    payload         JSONB NOT NULL,                    -- {command, env, cwd, ...}
    priority        INT NOT NULL DEFAULT 100,          -- lower = sooner
    status          TEXT NOT NULL DEFAULT 'queued',    -- 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'timeout'
    claimed_by      TEXT,                                -- node_id
    claimed_at      TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    timeout_seconds INT NOT NULL DEFAULT 300,
    result          JSONB,                              -- {stdout, stderr, exit_code, duration_ms}
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    source          TEXT                                -- 'blnq' | 'xyzo' | 'hivv' | 'manual'
);

CREATE INDEX IF NOT EXISTS collab_jobs_queued_idx
    ON collab_jobs (status, priority, created_at)
    WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS collab_jobs_claimed_by_idx ON collab_jobs (claimed_by, status);
CREATE INDEX IF NOT EXISTS collab_jobs_status_idx ON collab_jobs (status, created_at DESC);

-- Activity log: append-only. Lets the dashboard render a timeline for each
-- node ("heartbeat at 14:32, job done at 14:35, ..."). Trimmed server-side
-- after 30d.
CREATE TABLE IF NOT EXISTS collab_activity (
    id          BIGSERIAL PRIMARY KEY,
    node_id     TEXT NOT NULL,
    action      TEXT NOT NULL,         -- 'register' | 'heartbeat' | 'job_claim' | 'job_done' | 'job_failed' | 'mode_change'
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_activity_node_idx ON collab_activity (node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collab_activity_created_idx ON collab_activity (created_at);
