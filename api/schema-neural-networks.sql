-- Xyzo Neural Network training layer. Additive, idempotent.
--
-- Closes the loop on every signal the classical learner (learn.py)
-- already produces and feeds them into PyTorch models. Adds:
--
--   1. nn_training_features
--      Wide-table snapshot of (entity_type, entity_id, features_jsonb, label,
--      label_source, snapshot_at). One row per training example per snapshot
--      cycle. Designed for offline Parquet export from worker/nn_features.py.
--
--   2. nn_model_registry
--      One row per trained model checkpoint. Stores hyperparameters,
--      metrics on validation split, file path, dataset hash, and an
--      `is_active` flag so inference always reads the latest known-good.
--
--   3. nn_prediction_cache
--      Online prediction cache. The API reads from here at request time.
--      Workers write here after each inference batch. Designed for fast
--      point lookups: (model_name, entity_type, entity_id, valid_until).
--
--   4. nn_feedback
--      Explicit user/admin feedback that overrides model predictions.
--      Used both as a label source for retraining and as a "ground truth"
--      override at inference time.
--
--   5. nn_training_runs
--      Audit log of every training cycle: which models, how many rows,
--      what metrics, what dataset hash. Lets us compare model versions.
--
--   6. nn_dataset_versions
--      Pointer table: every snapshot cycle writes one row here with a
--      dataset hash and row counts per entity_type. Training runs reference
--      this hash so we can reproduce a model from its dataset alone.


-- ── Entity types the NN layer reasons about ────────────────────────
-- Centralized so feature extractors, training, and inference all agree.
-- (matches the strings nn_features.py emits and the CHECKs below.)

CREATE TABLE IF NOT EXISTS nn_entity_types (
    slug           TEXT PRIMARY KEY,
    description    TEXT NOT NULL,
    primary_table  TEXT NOT NULL
);
INSERT INTO nn_entity_types (slug, description, primary_table) VALUES
    ('article',      'Raw fetched news article',                       'news_articles'),
    ('event',        'Clustered news event',                           'news_events'),
    ('source',       'News feed source',                               'news_sources'),
    ('location',     'Geocoded place',                                 'news_locations'),
    ('link',         'Canonical URL appearing in an article',          'news_articles'),
    ('user_session', 'Anonymous session fingerprint',                  'news_interactions'),
    ('country',      'Country-level aggregate (coverage gap etc.)',    'news_coverage_gaps'),
    ('city',         'City-level aggregate (city interest etc.)',      'news_user_locations')
ON CONFLICT (slug) DO NOTHING;


-- ── 1. nn_dataset_versions ─────────────────────────────────────────
-- One row per snapshot cycle. Written by worker/nn_features.py before
-- any feature rows are inserted, so every training_features row can
-- reference the snapshot it came from.

CREATE TABLE IF NOT EXISTS nn_dataset_versions (
    id              BIGSERIAL PRIMARY KEY,
    cycle_id        TEXT NOT NULL,
    dataset_hash    TEXT NOT NULL UNIQUE,      -- sha256 of feature row fingerprint
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    row_counts      JSONB NOT NULL DEFAULT '{}',  -- {"article": 1234, "source": 87, ...}
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS nn_dataset_versions_snapshot_idx
    ON nn_dataset_versions (snapshot_at DESC);


-- ── 2. nn_training_features ───────────────────────────────────────
-- Wide snapshot of all training examples. features_jsonb carries the
-- exact feature vector the model will see; label is the ground truth
-- (NULL until labels are resolved); label_source tells us how the
-- label was obtained (heuristic, user_feedback, gold, etc.).
--
-- Partitioning note: snapshot_at is the partition key. For now we use
-- a plain table; when row count crosses ~5M we'll convert to monthly
-- partitions. Indexes are built so that "latest snapshot for entity X"
-- is a single index seek.

CREATE TABLE IF NOT EXISTS nn_training_features (
    id              BIGSERIAL PRIMARY KEY,
    cycle_id        TEXT NOT NULL,
    dataset_hash    TEXT NOT NULL REFERENCES nn_dataset_versions(dataset_hash) ON DELETE CASCADE,
    model_name      TEXT NOT NULL,             -- 'location_verifier', 'source_quality', ...
    entity_type     TEXT NOT NULL REFERENCES nn_entity_types(slug),
    entity_id       BIGINT NOT NULL,
    -- Feature payload. Each model_name has a documented schema (see
    -- worker/nn_features.py docstrings). Stored as JSONB so we can
    -- train different models from the same wide table.
    features_jsonb  JSONB NOT NULL,
    -- Label: ground-truth outcome the model is trying to predict.
    -- NULL during snapshot; filled in later by labelers / feedback.
    label           FLOAT,
    label_source    TEXT,                     -- 'heuristic', 'user_feedback', 'gold', NULL
    -- Optional secondary label fields for multi-task models.
    label_aux       JSONB,
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nn_training_features_entity_idx
    ON nn_training_features (model_name, entity_type, entity_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS nn_training_features_dataset_idx
    ON nn_training_features (dataset_hash);
CREATE INDEX IF NOT EXISTS nn_training_features_label_idx
    ON nn_training_features (model_name, label)
    WHERE label IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_training_features_snapshot_idx
    ON nn_training_features (snapshot_at DESC);


-- ── 3. nn_model_registry ──────────────────────────────────────────
-- One row per trained checkpoint. inference reads WHERE is_active=TRUE
-- ORDER BY trained_at DESC LIMIT 1 per model_name.

CREATE TABLE IF NOT EXISTS nn_model_registry (
    id                BIGSERIAL PRIMARY KEY,
    model_name        TEXT NOT NULL,
    version           TEXT NOT NULL,          -- semver-like, e.g. '1.4.0'
    trained_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    dataset_hash      TEXT REFERENCES nn_dataset_versions(dataset_hash),
    -- Architecture
    architecture      TEXT NOT NULL,          -- 'mlp', 'transformer', 'cnn1d', ...
    hyperparameters   JSONB NOT NULL DEFAULT '{}',
    feature_schema    JSONB NOT NULL DEFAULT '{}',  -- expected features_jsonb layout
    -- Metrics on validation split
    metrics           JSONB NOT NULL DEFAULT '{}',  -- {accuracy, f1, auc, loss, ...}
    -- Artifact
    artifact_path     TEXT NOT NULL,          -- /data/nn_models/<name>/<version>.pt
    artifact_sha256   TEXT NOT NULL,
    artifact_bytes    BIGINT,
    -- Activation. Only one row per model_name can be active at a time
    -- (enforced by partial unique index).
    is_active         BOOLEAN NOT NULL DEFAULT FALSE,
    notes             TEXT,
    UNIQUE (model_name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS nn_model_registry_active_idx
    ON nn_model_registry (model_name)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS nn_model_registry_model_idx
    ON nn_model_registry (model_name, trained_at DESC);


-- ── 4. nn_prediction_cache ───────────────────────────────────────
-- Online prediction cache. The API reads from here; the worker writes.
-- Designed for fast point lookups. We keep predictions until valid_until
-- (TTL per row); the worker re-batches stale rows.
--
-- Models write here:
--   - location_verifier  → news_articles.location_id
--   - source_quality     → news_sources.id
--   - user_engagement    → news_interactions.session_id (+ entity)
--   - link_quality       → news_articles.id (per canonical URL)
--   - coverage_recommender → news_coverage_gaps.id
--   - trending_predictor → news_events.event_type per region
--   - event_deduplicator → news_event_sources (article_id, neighbor_id)
--   - paywall_detector   → news_articles.id

CREATE TABLE IF NOT EXISTS nn_prediction_cache (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL,
    model_version   TEXT NOT NULL,            -- version that produced this prediction
    entity_type     TEXT NOT NULL,
    entity_id       BIGINT NOT NULL,
    -- Primary score: probability / regression target.
    score           DOUBLE PRECISION NOT NULL,
    -- Secondary outputs (class label, regression aux, top-k list, ...).
    score_aux       JSONB NOT NULL DEFAULT '{}',
    -- Provenance
    predicted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until     TIMESTAMPTZ NOT NULL,
    features_hash   TEXT                      -- sha256 of input features for cache invalidation
);

-- "Latest non-stale prediction for (model, entity)" — the hot path.
CREATE INDEX IF NOT EXISTS nn_prediction_cache_lookup_idx
    ON nn_prediction_cache (model_name, entity_type, entity_id, valid_until DESC);
-- For bulk invalidation by version (e.g. when a new model is activated).
CREATE INDEX IF NOT EXISTS nn_prediction_cache_version_idx
    ON nn_prediction_cache (model_name, model_version);
-- For expiry sweeps ("delete all rows older than now()").
CREATE INDEX IF NOT EXISTS nn_prediction_cache_valid_idx
    ON nn_prediction_cache (valid_until);


-- ── 5. nn_feedback ────────────────────────────────────────────────
-- Explicit ground-truth signal from users, admins, or downstream
-- validation. Three kinds:
--
--   'positive' / 'negative' — user voted (location fix accepted/rejected,
--     source link good/bad, pin was helpful/not, etc.)
--   'override'             — admin forced a label (e.g. source relisted
--     with a different reliability class)
--   'observed'             — downstream outcome we observed (user did
--     click after seeing the pin, paywall confirmed by second fetch, etc.)
--
-- feedback_target_type maps to the entity the feedback applies to.
-- We don't FK to entity tables because feedback can reference any of
-- them and we want this table to outlive entity deletion.

CREATE TABLE IF NOT EXISTS nn_feedback (
    id                  BIGSERIAL PRIMARY KEY,
    model_name          TEXT NOT NULL,
    feedback_target_type TEXT NOT NULL,
    feedback_target_id  BIGINT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN
                            ('positive','negative','override','observed')),
    -- Numeric strength: +1.0 positive, -1.0 negative, +/- arbitrary
    -- for override and observed kinds.
    weight              DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    label               FLOAT,                -- if applicable
    label_aux           JSONB,
    reason              TEXT,
    session_id          TEXT,
    user_lat            DOUBLE PRECISION,
    user_lng            DOUBLE PRECISION,
    user_country        TEXT,
    ip_address          INET,
    user_agent          TEXT,
    metadata            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Used at inference: if a non-stale feedback exists for (model, target)
    -- and it's 'override', it wins over the model prediction.
    valid_until         TIMESTAMPTZ,
    -- Resolved at label-time: did this feedback make it into a training set?
    used_in_dataset_hash TEXT
);

CREATE INDEX IF NOT EXISTS nn_feedback_target_idx
    ON nn_feedback (model_name, feedback_target_type, feedback_target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS nn_feedback_session_idx
    ON nn_feedback (session_id, created_at DESC)
    WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_feedback_used_idx
    ON nn_feedback (used_in_dataset_hash)
    WHERE used_in_dataset_hash IS NOT NULL;


-- ── 6. nn_training_runs ──────────────────────────────────────────
-- Audit log: one row per training cycle. Worker/nn_train.py inserts
-- here when it starts and again when it finishes. Lets us see
-- "which models were retrained this week and what they scored".

CREATE TABLE IF NOT EXISTS nn_training_runs (
    id              BIGSERIAL PRIMARY KEY,
    cycle_id        TEXT NOT NULL,
    model_name      TEXT NOT NULL,
    dataset_hash    TEXT REFERENCES nn_dataset_versions(dataset_hash),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','completed','failed','skipped')),
    -- Stats
    rows_total      INT,
    rows_train      INT,
    rows_val        INT,
    epochs_run      INT,
    final_loss      DOUBLE PRECISION,
    final_metrics   JSONB,
    -- Output
    model_version   TEXT,
    model_id        BIGINT REFERENCES nn_model_registry(id) ON DELETE SET NULL,
    error_message   TEXT,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS nn_training_runs_cycle_idx
    ON nn_training_runs (cycle_id);
CREATE INDEX IF NOT EXISTS nn_training_runs_model_idx
    ON nn_training_runs (model_name, started_at DESC);
CREATE INDEX IF NOT EXISTS nn_training_runs_status_idx
    ON nn_training_runs (status, started_at DESC)
    WHERE status = 'running';


-- ── Retention defaults ───────────────────────────────────────────
-- Comments only — actual retention is enforced by worker/nn_features.py
-- and a cron'd cleanup. Defaults:
--   nn_training_features: keep 90 days (one full quarterly model cycle)
--   nn_prediction_cache:   keep 14 days (cache expiry)
--   nn_feedback:          keep 180 days (label reuse across model versions)
--   nn_training_runs:      keep 365 days (audit trail)


-- ── Permissions ──────────────────────────────────────────────────
-- xyzo_app needs SELECT on the new tables (the API only reads;
-- only the worker writes via its own connection). Idempotent.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO xyzo_app;
