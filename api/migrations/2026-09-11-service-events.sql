-- Migration: 2026-09-11-service-events.sql
-- Purpose: Log service restarts and deployments with git info and change reasons.
-- This enables the help page to show a "System Restarts" timeline.

BEGIN;

CREATE TABLE IF NOT EXISTS service_events (
    id              BIGSERIAL PRIMARY KEY,
    service_name    TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    -- 'restart' | 'deploy' | 'config_change' | 'source_sync'
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    git_sha_before  TEXT,
    git_sha_after   TEXT,
    git_branch      TEXT,
    git_message     TEXT,
    reason          TEXT,
    changed_files   TEXT[],
    -- e.g. ['worker/feeds.json', 'api/src/routes/sources.ts']
    details         JSONB,
    -- Free-form extra context (e.g. {"feeds_added": 73, "feeds_removed": 0})
    created_by      TEXT DEFAULT 'system'
);

CREATE INDEX idx_service_events_service_name ON service_events(service_name);
CREATE INDEX idx_service_events_triggered_at ON service_events(triggered_at DESC);
CREATE INDEX idx_service_events_event_type ON service_events(event_type);

COMMENT ON TABLE service_events IS
    'Audit log of service restarts, deployments, and config changes. '
    'Queried by the help page to show a restart/deploy timeline.';

-- Restricted version for the help page (reason + timestamp only, no internals)
CREATE VIEW service_events_summary AS
SELECT
    id,
    service_name,
    event_type,
    triggered_at,
    git_branch,
    git_message,
    reason,
    changed_files,
    created_by
FROM service_events
ORDER BY triggered_at DESC;

COMMIT;
