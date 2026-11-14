-- ── 2026-09-07-feature-flags.sql ────────────────────────────────────
--
-- Runtime-mutable feature flags. NO REDEPLOY needed to flip a flag.
-- Used by every site-intelligence subsystem to gate new behavior.
--
-- `enabled` is the master switch.
-- `rollout_pct` is the percent of hosts that get the feature
--   (stable_hash(key:host) % 100 < rollout_pct).
-- `tier_overrides` is per-tier pct override (e.g. {"gov": 0}).
-- `host_overrides` is per-host explicit on/off (e.g. {"bad.com": false}).

BEGIN;

CREATE TABLE IF NOT EXISTS feature_flags (
    key             TEXT PRIMARY KEY,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    rollout_pct     SMALLINT NOT NULL DEFAULT 0
                    CHECK (rollout_pct BETWEEN 0 AND 100),
    tier_overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
    host_overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    description     TEXT
);

CREATE TABLE IF NOT EXISTS feature_config (
    key     TEXT PRIMARY KEY,
    value   JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Seed flags (all OFF except jsonld_wins_conflict) ───────────────

INSERT INTO feature_flags (key, enabled, rollout_pct, description) VALUES
    ('ai_intelligence_scan',         FALSE, 0,
     'Run AI scan to build site_intelligence record'),
    ('intelligence_driven_crawl',    FALSE, 0,
     'Use site_intelligence to re-rank BFS + pick extractor'),
    ('embedding_dedup',              FALSE, 0,
     'Compute event embeddings + cosine dedup'),
    ('classifier_reranker',          FALSE, 0,
     'Apply trained classifier to BFS frontier score'),
    ('jsonld_wins_conflict',         TRUE,  100,
     'JSON-LD wins over AI for conflicting fields'),
    ('emergency_disable_intelligence', FALSE, 0,
     'Kill switch: revert all sites to legacy crawler behavior')
ON CONFLICT (key) DO NOTHING;

-- ── Seed config defaults ───────────────────────────────────────────

INSERT INTO feature_config (key, value) VALUES
    ('classifier.weight',            '0.4'),
    ('page_priority.weight',         '0.3'),
    ('intelligence_hint.weight',     '0.3'),
    ('embedding.dedup_threshold',    '0.92'),
    ('classifier.retrain_min_samples', '500'),
    ('classifier.retrain_cron',      '"0 3 * * 0"')
ON CONFLICT (key) DO NOTHING;

-- ── Auto-bump updated_at on UPDATE ─────────────────────────────────
-- Matches codebase convention (schema.sql defines xyzo_set_updated_at).
-- Without these triggers, the audit trail silently lies when flags
-- or config rows are flipped via UPDATE.

DROP TRIGGER IF EXISTS feature_flags_set_updated_at ON feature_flags;
CREATE TRIGGER feature_flags_set_updated_at
    BEFORE UPDATE ON feature_flags
    FOR EACH ROW EXECUTE FUNCTION xyzo_set_updated_at();

DROP TRIGGER IF EXISTS feature_config_set_updated_at ON feature_config;
CREATE TRIGGER feature_config_set_updated_at
    BEFORE UPDATE ON feature_config
    FOR EACH ROW EXECUTE FUNCTION xyzo_set_updated_at();

COMMIT;
