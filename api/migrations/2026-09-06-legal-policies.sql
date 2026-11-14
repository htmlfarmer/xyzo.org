-- ── 2026-09-06-legal-policies.sql ───────────────────────────────────
--
-- Adds the legal_policies table for the legal-scan subsystem
-- (worker/legal_scan.py). Stores per-host verdicts on whether the
-- host's Terms of Service / AUP / Privacy Policy permit scraping,
-- with cached clause excerpts.
--
-- Workers write to this table; /api/sites/study reads from it to
-- surface a "this site's ToS prohibits scraping" warning before the
-- user enables a source.

BEGIN;

CREATE TABLE IF NOT EXISTS legal_policies (
    id              BIGSERIAL PRIMARY KEY,
    host            TEXT NOT NULL,
    status          TEXT NOT NULL,           -- 'prohibited' | 'restricted' | 'unrestricted' | 'unknown'
    confidence      REAL NOT NULL DEFAULT 0.0,
    summary         TEXT,
    clauses         JSONB NOT NULL DEFAULT '[]'::jsonb,
    sources_checked TEXT[] NOT NULL DEFAULT '{}',
    method          TEXT NOT NULL DEFAULT 'local',  -- 'local' | 'claude' | 'mixed'
    doc_hash        TEXT,
    scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT legal_policies_host_unique UNIQUE (host)
);

CREATE INDEX IF NOT EXISTS legal_policies_status_idx
    ON legal_policies (status, confidence DESC)
    WHERE status IN ('prohibited', 'restricted');

CREATE INDEX IF NOT EXISTS legal_policies_scanned_idx
    ON legal_policies (scanned_at DESC);

COMMIT;
