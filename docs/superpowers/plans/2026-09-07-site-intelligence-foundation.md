# Site Intelligence Subsystem — Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the schema, feature-flag infrastructure, and runtime reader that all subsequent site-intelligence work depends on. Everything in this phase ships disabled — production behavior is byte-identical to today.

**Architecture:** Four additive migrations: `site_intelligence` table (per-host intelligence record), `feature_flags` + `feature_config` (runtime-mutable rollout knobs), `pgvector` extension + embedding columns on existing event tables, `classifier_runs` (training history). One Python module (`xyzo_features.py`) that Python worker subprocesses use to read flags and config from DB.

**Tech Stack:** Postgres + pgvector, Python 3.11 (psycopg), Bun/Hono (TypeScript).

**Spec:** `docs/superpowers/specs/2026-09-06-site-intelligence-design.md` (sections 2, 4)

**Prerequisites:** Phase 0 (already done): `worker/site_study.py`, `worker/site_crawl.py`, `worker/ai_extract.py`, `worker/legal_scan.py`, `worker/page_priority.py` committed.

---

## Phase 1 Task Index

- Task 1: `site_intelligence` table migration
- Task 2: `feature_flags` + `feature_config` migration with seeds
- Task 3: pgvector extension + embedding columns
- Task 4: `classifier_runs` table
- Task 5: Flag/config reader module (`xyzo_features.py`)
- Task 6: Apply migrations + smoke test

---

### Task 1: `site_intelligence` table migration

**Files:**
- Create: `api/migrations/2026-09-07-site-intelligence.sql`

- [ ] **Step 1: Write the migration**

Create `api/migrations/2026-09-07-site-intelligence.sql`:

```sql
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
                            CHECK (tier IN ('gov','university','community',
                                            'commercial','platform','user')),

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

-- Note: no explicit host index — the UNIQUE constraint on `host`
-- (line 52) creates a btree index `site_intelligence_host_key` automatically.
CREATE INDEX IF NOT EXISTS site_intelligence_refreshed_idx
    ON site_intelligence (refreshed_at)
    WHERE last_error IS NULL;
CREATE INDEX IF NOT EXISTS site_intelligence_format_idx
    ON site_intelligence (format_version);
CREATE INDEX IF NOT EXISTS site_intelligence_drift_idx
    ON site_intelligence USING gin (drift_signals);

COMMIT;
```

- [ ] **Step 2: Apply migration**

Run from project root:
```bash
cd /var/www/vhosts/xyzo.org
psql -U asher -d xyzo -f api/migrations/2026-09-07-site-intelligence.sql
```
Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX` (x3 named + auto-created `site_intelligence_host_key` from UNIQUE), `COMMIT`. No errors.

- [ ] **Step 3: Verify table**

```bash
psql -U asher -d xyzo -c "\d site_intelligence"
```
Expected: table listed with all columns from migration.

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/migrations/2026-09-07-site-intelligence.sql
git commit -m "feat(schema): add site_intelligence table for per-host AI records"
```

---

### Task 2: `feature_flags` + `feature_config` migration

**Files:**
- Create: `api/migrations/2026-09-07-feature-flags.sql`

- [ ] **Step 1: Write the migration**

```sql
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

COMMIT;
```

- [ ] **Step 2: Apply migration**

```bash
cd /var/www/vhosts/xyzo.org
psql -U asher -d xyzo -f api/migrations/2026-09-07-feature-flags.sql
```
Expected: `BEGIN`, `CREATE TABLE` (x2), `INSERT` (x6 flags + 6 config), `COMMIT`. No errors.

- [ ] **Step 3: Verify seeds**

```bash
psql -U asher -d xyzo -c "SELECT key, enabled, rollout_pct FROM feature_flags ORDER BY key;"
```
Expected: 6 rows. All `enabled=f` except `jsonld_wins_conflict=t`.

```bash
psql -U asher -d xyzo -c "SELECT key, value FROM feature_config ORDER BY key;"
```
Expected: 6 rows with the seeded values.

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/migrations/2026-09-07-feature-flags.sql
git commit -m "feat(schema): add feature_flags + feature_config tables with seeds"
```

---

### Task 3: pgvector extension + embedding columns

**Files:**
- Create: `api/migrations/2026-09-07-embeddings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ── 2026-09-07-embeddings.sql ──────────────────────────────────────
--
-- Enable pgvector for semantic event dedup. Adds a 384-dim embedding
-- column (matches sentence-transformers/all-MiniLM-L6-v2) to:
--   crawl_events  — events extracted from site_crawl runs
--   upcoming_events — unified events table (cross-source dedup target)
--
-- Empty embedding = no semantic dedup runs for that row. Existing
-- rows are unaffected.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Add embedding columns (idempotent) ─────────────────────────────
ALTER TABLE crawl_events
    ADD COLUMN IF NOT EXISTS embedding vector(384),
    ADD COLUMN IF NOT EXISTS embedding_text TEXT;

ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS embedding vector(384);

-- ── Indexes for cosine similarity ──────────────────────────────────
-- ivfflat with lists=100 is good up to ~1M rows. Recreate with more
-- lists if the table grows past that.

CREATE INDEX IF NOT EXISTS crawl_events_embedding_idx
    ON crawl_events USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
    WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS upcoming_events_embedding_idx
    ON upcoming_events USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
    WHERE embedding IS NOT NULL;

COMMIT;
```

- [ ] **Step 2: Apply migration**

```bash
cd /var/www/vhosts/xyzo.org
psql -U asher -d xyzo -f api/migrations/2026-09-07-embeddings.sql
```
Expected: `BEGIN`, `CREATE EXTENSION`, `ALTER TABLE` (x2), `CREATE INDEX` (x2 hnsw), `COMMIT`. No errors.

**If `CREATE EXTENSION` fails** with "permission denied to create extension", run as superuser:
```bash
psql -U postgres -d xyzo -f api/migrations/2026-09-07-embeddings.sql
```
Then re-grant to the app role:
```sql
GRANT USAGE ON SCHEMA public TO xyzo_app;
```

- [ ] **Step 3: Verify**

```bash
psql -U asher -d xyzo -c "\dx" | grep vector
```
Expected: `vector` listed.

```bash
psql -U asher -d xyzo -c "\d crawl_events" | grep embedding
```
Expected: `embedding        | vector(384)` and `embedding_text | text`

- [ ] **Step 4: Smoke-test pgvector**

```bash
psql -U asher -d xyzo -c "SELECT '[1,2,3]'::vector(3) <=> '[4,5,6]'::vector(3) AS cosine_dist;"
```
Expected: a number around 0.025 (cosine distance between these vectors).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/migrations/2026-09-07-embeddings.sql
git commit -m "feat(schema): enable pgvector + add embedding columns to event tables"
```

---

### Task 4: `classifier_runs` table

**Files:**
- Create: `api/migrations/2026-09-07-classifier-runs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ── 2026-09-07-classifier-runs.sql ─────────────────────────────────
--
-- History of classifier training runs. Each row = one model training
-- cycle. We keep the model binary on disk and point `model_path` at it.
--
-- The classifier has two heads (re-ranker + event type). Metrics:
--   auc     — ROC AUC for the re-ranker
--   rmse    — root-mean-square error of the re-ranker
--   f1      — macro F1 for the event-type head
--   status  — 'ok' (deployed) | 'rejected' (quality regressed)
--
-- Newer ok rows are loaded on demand; rejected runs are kept for audit.

BEGIN;

CREATE TABLE IF NOT EXISTS classifier_runs (
    id              BIGSERIAL PRIMARY KEY,
    trained_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sample_count    INTEGER NOT NULL,
    new_samples     INTEGER NOT NULL,
    auc             REAL,
    rmse            REAL,
    f1              REAL,
    status          TEXT NOT NULL,
    model_path      TEXT,
    notes           TEXT,
    CONSTRAINT classifier_runs_status_check
        CHECK (status IN ('ok', 'rejected', 'training'))
);

CREATE INDEX IF NOT EXISTS classifier_runs_status_idx
    ON classifier_runs (status, trained_at DESC)
    WHERE status = 'ok';

CREATE INDEX IF NOT EXISTS classifier_runs_trained_idx
    ON classifier_runs (trained_at DESC);

COMMIT;
```

- [ ] **Step 2: Apply migration**

```bash
cd /var/www/vhosts/xyzo.org
psql -U asher -d xyzo -f api/migrations/2026-09-07-classifier-runs.sql
```
Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX` (x2), `COMMIT`. No errors.

- [ ] **Step 3: Verify**

```bash
psql -U asher -d xyzo -c "\d classifier_runs"
```
Expected: 11 columns including `auc`, `f1`, `status`, `model_path`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/migrations/2026-09-07-classifier-runs.sql
git commit -m "feat(schema): add classifier_runs table for training history"
```

---

### Task 5: Flag/config reader module (`xyzo_features.py`)

**Files:**
- Create: `api/src/xyzo_features.py`
- Create: `tests/test_xyzo_features.py`

This module is used by every Python worker subprocess to read feature flags and config. It must be safe to call repeatedly (cheap), tolerate missing rows, and never raise.

- [ ] **Step 1: Write the failing test**

Create `tests/test_xyzo_features.py`:

```python
"""Tests for x yzo_features: flag + config reader used by worker subprocesses."""
import json
import pytest
from unittest.mock import patch, MagicMock

from api.src.xyzo_features import (
    is_enabled, get_config, get_all_flags,
    _stable_hash, _resolve_pct,
)


class TestStableHash:
    def test_deterministic(self):
        assert _stable_hash("foo:bar.com") == _stable_hash("foo:bar.com")

    def test_different_inputs_differ(self):
        assert _stable_hash("a:x") != _stable_hash("b:x")
        assert _stable_hash("a:x") != _stable_hash("a:y")

    def test_range_zero_to_99(self):
        for i in range(20):
            assert 0 <= _stable_hash(f"k:{i}") < 2**31


class TestResolvePct:
    def test_host_override_takes_precedence(self):
        flag = {
            "rollout_pct": 100, "tier_overrides": {},
            "host_overrides": {"bad.com": False}
        }
        assert _resolve_pct(flag, "bad.com", "commercial") is False
        assert _resolve_pct(flag, "good.com", "commercial") is True

    def test_tier_override_beats_rollout(self):
        flag = {
            "rollout_pct": 100, "tier_overrides": {"gov": 0},
            "host_overrides": {}
        }
        assert _resolve_pct(flag, "whitehouse.gov", "gov") is False
        assert _resolve_pct(flag, "eventbrite.com", "commercial") is True

    def test_falls_back_to_rollout(self):
        flag = {
            "rollout_pct": 0, "tier_overrides": {},
            "host_overrides": {}
        }
        assert _resolve_pct(flag, "anything.com", "anything") is False


class TestIsEnabled:
    def test_emergency_kill_switch_overrides_everything(self):
        flags = {
            "emergency_disable_intelligence": {"enabled": True},
            "ai_intelligence_scan": {"enabled": True, "rollout_pct": 100,
                                     "tier_overrides": {}, "host_overrides": {}},
        }
        assert is_enabled("ai_intelligence_scan", "x.com", "commercial",
                          flags=flags) is False

    def test_disabled_flag_returns_false(self):
        flags = {"ai_intelligence_scan": {"enabled": False, "rollout_pct": 0,
                                          "tier_overrides": {}, "host_overrides": {}},
                 "emergency_disable_intelligence": {"enabled": False}}
        assert is_enabled("ai_intelligence_scan", "x.com", "commercial",
                          flags=flags) is False

    def test_enabled_with_full_rollout(self):
        flags = {"ai_intelligence_scan": {"enabled": True, "rollout_pct": 100,
                                          "tier_overrides": {}, "host_overrides": {}},
                 "emergency_disable_intelligence": {"enabled": False}}
        assert is_enabled("ai_intelligence_scan", "x.com", "commercial",
                          flags=flags) is True


class TestGetConfig:
    def test_returns_value_when_present(self):
        with patch("api.src.xyzo_features._fetch_config") as m:
            m.return_value = {"classifier.weight": "0.4"}
            assert get_config("classifier.weight") == "0.4"

    def test_returns_default_when_missing(self):
        with patch("api.src.xyzo_features._fetch_config") as m:
            m.return_value = {}
            assert get_config("classifier.weight", default="0.5") == "0.5"

    def test_handles_db_failure(self):
        with patch("api.src.xyzo_features._fetch_config") as m:
            m.side_effect = Exception("db down")
            assert get_config("classifier.weight", default="0.5") == "0.5"


class TestGetAllFlags:
    def test_returns_dict_from_db(self):
        with patch("api.src.xyzo_features._fetch_all_flags") as m:
            m.return_value = {"foo": {"enabled": True, "rollout_pct": 0,
                                       "tier_overrides": {}, "host_overrides": {}}}
            result = get_all_flags()
            assert "foo" in result
            assert result["foo"]["enabled"] is True
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_xyzo_features.py -v 2>&1 | tail -20
```
Expected: all tests FAIL with `ModuleNotFoundError: No module named 'api.src.xyzo_features'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/xyzo_features.py`:

```python
"""xyzo_features — runtime feature flag + config reader.

Used by every Python worker subprocess (called via `python3 -c` from
Hono routes). Reads from Postgres feature_flags + feature_config tables.

Design goals:
- Never raise. Falls back to defaults if DB is unreachable.
- Cheap to call repeatedly (in-memory cache, invalidated on demand).
- Stable hash for percentage-based rollout.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

log = logging.getLogger("xyzo.features")

_CACHE_TTL_S = 30.0
_cache: dict[str, tuple[float, Any]] = {}


def _stable_hash(s: str) -> int:
    """Deterministic 32-bit hash. Stable across processes."""
    digest = hashlib.sha256(s.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big", signed=False)


def _resolve_pct(flag: dict, host: str, tier: str) -> bool:
    """Resolve a flag to a boolean for a given host+tier.

    Precedence: host_overrides > tier_overrides > rollout_pct."""
    overrides = flag.get("host_overrides") or {}
    if host in overrides:
        return bool(overrides[host])
    tier_overrides = flag.get("tier_overrides") or {}
    pct = tier_overrides.get(tier, flag.get("rollout_pct", 0))
    return _stable_hash(f"{host}") % 100 < int(pct)


def _connect():
    """Lazy import to keep this module importable without DB env."""
    from db import connect  # type: ignore
    return connect()


def _fetch_all_flags() -> dict[str, dict]:
    """Read all flags from DB. Returned dict is keyed by flag key."""
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT key, enabled, rollout_pct, tier_overrides, "
                "host_overrides FROM feature_flags"
            )
            rows = cur.fetchall()
        out: dict[str, dict] = {}
        for r in rows:
            out[r["key"]] = {
                "enabled": r["enabled"],
                "rollout_pct": r["rollout_pct"],
                "tier_overrides": r["tier_overrides"] or {},
                "host_overrides": r["host_overrides"] or {},
            }
        return out
    except Exception as e:
        log.warning("failed to fetch flags: %s", e)
        return {}


def _fetch_config() -> dict[str, Any]:
    """Read all feature_config rows."""
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT key, value FROM feature_config")
            rows = cur.fetchall()
        return {r["key"]: r["value"] for r in rows}
    except Exception as e:
        log.warning("failed to fetch config: %s", e)
        return {}


def _maybe_refresh(key: str) -> bool:
    """Return True if cache is fresh."""
    if key not in _cache:
        return False
    ts, _ = _cache[key]
    import time
    return (time.time() - ts) < _CACHE_TTL_S


def get_all_flags() -> dict[str, dict]:
    """Return all flags as a dict. Cached for _CACHE_TTL_S seconds."""
    if _maybe_refresh("flags"):
        return _cache["flags"][1]
    flags = _fetch_all_flags()
    import time
    _cache["flags"] = (time.time(), flags)
    return flags


def get_config(key: str, default: Any = None) -> Any:
    """Return the value of a feature_config key. Falls back to default."""
    if not _maybe_refresh("config"):
        cfg = _fetch_config()
        import time
        _cache["config"] = (time.time(), cfg)
    else:
        cfg = _cache["config"][1]
    return cfg.get(key, default)


def is_enabled(flag_key: str, host: str, tier: str,
               flags: dict | None = None) -> bool:
    """Check if a feature flag is enabled for a given host + tier.

    Honors the `emergency_disable_intelligence` kill switch first.
    `flags` parameter is injectable for testing.
    """
    if flags is None:
        flags = get_all_flags()

    # 1. Kill switch
    emergency = flags.get("emergency_disable_intelligence", {})
    if emergency.get("enabled"):
        return False

    flag = flags.get(flag_key)
    if not flag:
        return False
    if not flag.get("enabled"):
        return False

    return _resolve_pct(flag, host, tier)


def invalidate_cache() -> None:
    """Force-refresh on next call. Useful after flag updates."""
    _cache.clear()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_xyzo_features.py -v 2>&1 | tail -30
```
Expected: all 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/src/xyzo_features.py tests/test_xyzo_features.py
git commit -m "feat(features): runtime flag + config reader with stable-hash rollout"
```

---

### Task 6: Apply all migrations + smoke test

- [ ] **Step 1: Run all migrations in order**

```bash
cd /var/www/vhosts/xyzo.org
for m in api/migrations/2026-09-07-*.sql; do
    echo "=== Applying $m ==="
    psql -U asher -d xyzo -f "$m" || exit 1
done
```
Expected: each prints `BEGIN`/`COMMIT`. No errors.

- [ ] **Step 2: Verify all tables exist**

```bash
psql -U asher -d xyzo -c "\dt" | grep -E 'site_intelligence|feature_flags|feature_config|classifier_runs'
```
Expected: all four tables listed.

- [ ] **Step 3: Verify flag seed**

```bash
psql -U asher -d xyzo -c "SELECT key, enabled FROM feature_flags ORDER BY key;"
```
Expected: 6 rows, only `jsonld_wins_conflict` has `enabled=t`.

- [ ] **Step 4: Smoke test the reader end-to-end**

Create `/tmp/smoke.py`:
```python
import sys
sys.path.insert(0, "/var/www/vhosts/xyzo.org")
from api.src.xyzo_features import is_enabled, get_config

# Without DB: defaults kick in
print("JSON-LD-wins (should be True):",
      is_enabled("jsonld_wins_conflict", "example.com", "commercial"))
print("AI scan (should be False):",
      is_enabled("ai_intelligence_scan", "example.com", "commercial"))
print("Classifier weight:",
      get_config("classifier.weight", default="0.4"))
```

Run:
```bash
python3 /tmp/smoke.py
```
Expected: prints 3 lines with the expected values. No exceptions.

- [ ] **Step 5: Verify emergency kill switch**

```bash
psql -U asher -d xyzo -c \
  "UPDATE feature_flags SET enabled=true WHERE key='emergency_disable_intelligence';"
python3 /tmp/smoke.py
```
Expected: `AI scan` now `False` (because kill switch is on). `JSON-LD-wins` also `False` because kill switch wins.

Reset:
```bash
psql -U asher -d xyzo -c \
  "UPDATE feature_flags SET enabled=false WHERE key='emergency_disable_intelligence';"
```

- [ ] **Step 6: Final commit (if any pending changes)**

```bash
cd /var/www/vhosts/xyzo.org
git status
```
Expected: nothing to commit (all four migrations + reader already committed in prior tasks).

---

## Phase 1 Complete ✅

What ships (all disabled by default — production behavior unchanged):
- 4 new tables: `site_intelligence`, `feature_flags`, `feature_config`, `classifier_runs`
- pgvector extension enabled, embedding columns added to `crawl_events` and `upcoming_events`
- `xyzo_features.py` reader module with stable-hash rollout + kill switch
- 6 seed flags + 6 seed config values
- 11 passing unit tests

**Next:** Phase 2 plan — AI scan module + algorithm consumer + crawl integration.
