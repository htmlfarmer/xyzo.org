-- ── 2026-09-07-site-intelligence.sql ────────────────────────────────
--
-- Per-host AI-generated site intelligence record. Stores the AI scan
-- output, operational metrics, lifecycle, and usage stats. One row
-- per host. The intelligence JSONB shape is versioned via
-- `format_version`; readers MUST use the adapter in
-- worker/readers/site_intel/v{N}.py.
--
-- All additions are non-breaking. Empty = current behavior.

BEGIN;

CREATE TABLE IF NOT EXISTS site_intelligence (
    id                  BIGSERIAL PRIMARY KEY,
    host                TEXT NOT NULL UNIQUE,
    tier                TEXT NOT NULL DEFAULT 'commercial',
                        CONSTRAINT site_intelligence_tier_check
                            CHECK (tier IN ('gov','university','community','commercial','platform','user')),

    -- ── Versioning ──────────────────────────────────────────────────
    format_version      INTEGER NOT NULL DEFAULT 1,
    producer            TEXT NOT NULL,           -- 'xyzo-ai-scan@<git-sha>'
    producer_version    TEXT NOT NULL,           -- '0.5.2'
    experiment_tag      TEXT,                    -- 'baseline' | 'prompt-v2'

    -- ── Payload ─────────────────────────────────────────────────────
    intelligence        JSONB NOT NULL,
    summary             TEXT,

    -- ── Operational metrics ─────────────────────────────────────────
    scan_tokens_in      INTEGER NOT NULL DEFAULT 0,
    scan_tokens_out     INTEGER NOT NULL DEFAULT 0,
    scan_cost_usd       NUMERIC(10,6) NOT NULL DEFAULT 0,
    scan_model          TEXT,
    pages_sampled       INTEGER NOT NULL DEFAULT 0,
    scan_duration_ms    INTEGER,

    -- ── Lifecycle ───────────────────────────────────────────────────
    refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error          TEXT,
    consecutive_errors  INTEGER NOT NULL DEFAULT 0,

    -- ── Usage stats ─────────────────────────────────────────────────
    scan_count          INTEGER NOT NULL DEFAULT 1,
    crawl_count         INTEGER NOT NULL DEFAULT 0,
    events_extracted    BIGINT NOT NULL DEFAULT 0,
    duplicates_caught   BIGINT NOT NULL DEFAULT 0,
    last_used_at        TIMESTAMPTZ,

    -- ── Staleness signals ───────────────────────────────────────────
    confidence          REAL NOT NULL DEFAULT 0.9,
    drift_signals       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS site_intelligence_refreshed_idx
    ON site_intelligence (refreshed_at)
    WHERE last_error IS NULL;
CREATE INDEX IF NOT EXISTS site_intelligence_format_idx
    ON site_intelligence (format_version);
CREATE INDEX IF NOT EXISTS site_intelligence_drift_idx
    ON site_intelligence USING gin (drift_signals);

COMMIT;
