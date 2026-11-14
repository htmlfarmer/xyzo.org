-- Xyzo Neural Network performance optimizations. Additive, idempotent.
--
-- Five groups:
--   1. Batch inference queue  — never miss an article that needs encoding
--   2. Fast interaction aggregates — pre-computed per-session features for ranking
--   3. Pre-materialized article leaderboard — avoids JOINs at read time
--   4. Model drift & quality tracking — catches distribution shift before it hurts
--   5. User-correction feedback loop — ground truth from overrides
--
-- All tables owned by xyzo_app; only the worker writes.

-- Note: PostgreSQL now() is STABLE not IMMUTABLE, so it cannot appear in
-- index predicate expressions. All partial indexes using now() or
-- now() ± interval use simple btree indexes on the base column instead.


-- ── 1. Batch inference queue ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nn_inference_queue (
    id              BIGSERIAL PRIMARY KEY,
    article_id      BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    event_id        BIGINT REFERENCES news_events(id) ON DELETE CASCADE,
    needs_embedding BOOLEAN NOT NULL DEFAULT TRUE,
    needs_geo       BOOLEAN NOT NULL DEFAULT FALSE,
    needs_entity    BOOLEAN NOT NULL DEFAULT FALSE,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','encoding','embedded','failed')),
    priority        INT NOT NULL DEFAULT 0,
    attempts        INT NOT NULL DEFAULT 0,
    error_message   TEXT,
    enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    UNIQUE (article_id)
);
CREATE INDEX IF NOT EXISTS nn_inference_queue_status_idx
    ON nn_inference_queue (status, priority DESC, enqueued_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS nn_inference_queue_article_idx
    ON nn_inference_queue (article_id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS nn_inference_queue_stale_idx
    ON nn_inference_queue (enqueued_at)
    WHERE status = 'pending';


-- ── 2. Fast interaction aggregates ────────────────────────────────────
--
-- nn_ranking_session_snapshot mirrors nn_session_features but is
-- denormalized for O(1) lookups at inference time.
-- Uses pgvector vector(n) type for HNSW approximate similarity search.

CREATE TABLE IF NOT EXISTS nn_ranking_session_snapshot (
    id                      BIGSERIAL PRIMARY KEY,
    session_id              TEXT NOT NULL UNIQUE,
    snapshot_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    home_country            TEXT,
    last_lat                DOUBLE PRECISION,
    last_lng                DOUBLE PRECISION,
    interactions_6h         INT NOT NULL DEFAULT 0,
    pin_clicks_6h           INT NOT NULL DEFAULT 0,
    searches_6h             INT NOT NULL DEFAULT 0,
    source_clicks_6h        INT NOT NULL DEFAULT 0,
    interactions_24h        INT NOT NULL DEFAULT 0,
    pin_views_24h           INT NOT NULL DEFAULT 0,
    pin_clicks_24h          INT NOT NULL DEFAULT 0,
    searches_24h            INT NOT NULL DEFAULT 0,
    topic_vector            vector(32),      -- SVD-projected topic interest
    country_vector          vector(16),      -- country interest
    category_vector         vector(16),      -- category interest
    source_vector           vector(64),      -- source interest
    avg_dwell_ms            INT,
    unique_pins_24h        INT NOT NULL DEFAULT 0,
    unique_sources_24h      INT NOT NULL DEFAULT 0,
    unique_countries_24h    INT NOT NULL DEFAULT 0,
    session_age_days        INT,
    interest_vector         vector(128),    -- combined interest embedding
    UNIQUE (session_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS nn_ranking_session_snapshot_session_idx
    ON nn_ranking_session_snapshot (session_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS nn_ranking_session_snapshot_home_idx
    ON nn_ranking_session_snapshot (home_country, snapshot_at DESC)
    WHERE home_country IS NOT NULL;
-- HNSW approximate similarity for "users like this"
CREATE INDEX IF NOT EXISTS nn_ranking_session_snapshot_hnsw_idx
    ON nn_ranking_session_snapshot USING hnsw (interest_vector vector_cosine_ops)
    WHERE interest_vector IS NOT NULL;


-- ── 3. Pre-materialized article leaderboard ────────────────────────────

CREATE TABLE IF NOT EXISTS nn_article_leaderboard_live (
    id                  BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL UNIQUE REFERENCES news_articles(id) ON DELETE CASCADE,
    nn_ranking_score    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    nn_bucket           TEXT NOT NULL DEFAULT 'normal'
        CHECK (nn_bucket IN ('hot','trending','rising','normal')),
    classical_engagement DOUBLE PRECISION NOT NULL DEFAULT 0,
    blended_score       DOUBLE PRECISION NOT NULL DEFAULT 0,
    trending_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
    local_relevance     DOUBLE PRECISION NOT NULL DEFAULT 0,
    source_quality      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    freshness           DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    velocity            DOUBLE PRECISION NOT NULL DEFAULT 0,
    audience_match      DOUBLE PRECISION NOT NULL DEFAULT 0,
    event_id            BIGINT REFERENCES news_events(id) ON DELETE SET NULL,
    event_type          TEXT,
    headline            TEXT,
    source_id           BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    source_name         TEXT,
    source_country      TEXT,
    published_at        TIMESTAMPTZ,
    fetched_at          TIMESTAMPTZ,
    event_lat           DOUBLE PRECISION,
    event_lng           DOUBLE PRECISION,
    event_country       TEXT,
    event_place_name    TEXT,
    article_vector      vector(16),
    model_version       TEXT,
    scored_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + interval '6 hours'
);
CREATE INDEX IF NOT EXISTS nn_article_leaderboard_live_score_idx
    ON nn_article_leaderboard_live (blended_score DESC, nn_bucket);
CREATE INDEX IF NOT EXISTS nn_article_leaderboard_live_event_idx
    ON nn_article_leaderboard_live (event_id, blended_score DESC)
    WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_article_leaderboard_live_vector_idx
    ON nn_article_leaderboard_live USING hnsw (article_vector vector_cosine_ops)
    WHERE article_vector IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_article_leaderboard_live_bucket_idx
    ON nn_article_leaderboard_live (nn_bucket, blended_score DESC);
CREATE INDEX IF NOT EXISTS nn_article_leaderboard_live_country_idx
    ON nn_article_leaderboard_live (event_country, blended_score DESC)
    WHERE event_country IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_article_leaderboard_live_expiry_idx
    ON nn_article_leaderboard_live (expires_at);


-- ── 4. Model drift & quality tracking ─────────────────────────────────

CREATE TABLE IF NOT EXISTS nn_score_history (
    id                  BIGSERIAL PRIMARY KEY,
    model_name          TEXT NOT NULL,
    model_version       TEXT NOT NULL,
    article_id          BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
    event_id            BIGINT REFERENCES news_events(id) ON DELETE SET NULL,
    entity_type         TEXT NOT NULL,
    entity_id           BIGINT NOT NULL,
    score               DOUBLE PRECISION NOT NULL,
    score_aux           JSONB NOT NULL DEFAULT '{}',
    score_delta         DOUBLE PRECISION,
    has_correction      BOOLEAN NOT NULL DEFAULT FALSE,
    correction_score    DOUBLE PRECISION,
    predicted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nn_score_history_entity_idx
    ON nn_score_history (model_name, entity_type, entity_id, predicted_at DESC);
CREATE INDEX IF NOT EXISTS nn_score_history_drift_idx
    ON nn_score_history (entity_id, predicted_at DESC)
    WHERE score_delta IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_score_history_article_idx
    ON nn_score_history (article_id, predicted_at DESC)
    WHERE article_id IS NOT NULL;


-- ── 5. User-correction feedback loop ─────────────────────────────────

CREATE TABLE IF NOT EXISTS nn_user_corrections (
    id                  BIGSERIAL PRIMARY KEY,
    model_name          TEXT NOT NULL,
    article_id          BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
    event_id            BIGINT REFERENCES news_events(id) ON DELETE SET NULL,
    entity_type         TEXT NOT NULL,
    entity_id           BIGINT NOT NULL,
    original_score       DOUBLE PRECISION,
    original_lat        DOUBLE PRECISION,
    original_lng        DOUBLE PRECISION,
    original_country    TEXT,
    original_precision  TEXT,
    corrected_score     DOUBLE PRECISION,
    corrected_lat      DOUBLE PRECISION,
    corrected_lng      DOUBLE PRECISION,
    corrected_country   TEXT,
    corrected_precision TEXT,
    correction_type     TEXT NOT NULL
        CHECK (correction_type IN (
            'location_confirm', 'location_move', 'location_reject',
            'event_merge', 'event_split', 'event_confirm',
            'ranking_up', 'ranking_down', 'entity_add', 'entity_remove'
        )),
    session_id          TEXT,
    user_lat            DOUBLE PRECISION,
    user_lng            DOUBLE PRECISION,
    user_country        TEXT,
    ip_address          INET,
    user_agent          TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_in_training    BOOLEAN NOT NULL DEFAULT FALSE,
    used_in_training_at TIMESTAMPTZ,
    dataset_hash        TEXT
);
CREATE INDEX IF NOT EXISTS nn_user_corrections_entity_idx
    ON nn_user_corrections (model_name, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS nn_user_corrections_session_idx
    ON nn_user_corrections (session_id, created_at DESC)
    WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_user_corrections_unused_idx
    ON nn_user_corrections (model_name, created_at DESC)
    WHERE used_in_training = FALSE;
CREATE INDEX IF NOT EXISTS nn_user_corrections_location_idx
    ON nn_user_corrections (corrected_country, correction_type, created_at DESC)
    WHERE correction_type IN ('location_confirm', 'location_move', 'location_reject');


-- ── 6. Entity embedding cache ─────────────────────────────────────────
--
-- Stores latest embedding + score per entity as PostgreSQL array.
-- Uses a btree index on (entity_type, entity_id) as the primary lookup path.

CREATE TABLE IF NOT EXISTS nn_entity_cache (
    entity_type         TEXT NOT NULL,
    entity_id           BIGINT NOT NULL,
    model_name          TEXT NOT NULL,
    model_version       TEXT NOT NULL,
    embedding           vector(16) NOT NULL,
    norm                REAL NOT NULL DEFAULT 1.0,
    top_scores         JSONB NOT NULL DEFAULT '[]',
    input_hash          TEXT NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_type, entity_id, model_name)
);
-- Fast lookup by entity
CREATE INDEX IF NOT EXISTS nn_entity_cache_primary_idx
    ON nn_entity_cache (entity_type, entity_id);


-- ── 7. Incremental event similarity graph ────────────────────────────

CREATE TABLE IF NOT EXISTS nn_event_similarity_graph (
    event_a             BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    event_b             BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    model_version       TEXT NOT NULL,
    score               DOUBLE PRECISION NOT NULL CHECK (score BETWEEN 0 AND 1),
    rank                INT NOT NULL CHECK (rank BETWEEN 1 AND 20),
    source              TEXT NOT NULL DEFAULT 'embedding'
        CHECK (source IN ('embedding', 'keyword', 'location', 'entity', 'hybrid')),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_a, event_b, model_version)
);
-- score threshold is enforced in WHERE at query time; simple btree is sufficient
CREATE INDEX IF NOT EXISTS nn_event_similarity_graph_a_rank_idx
    ON nn_event_similarity_graph (event_a, rank);
CREATE INDEX IF NOT EXISTS nn_event_similarity_graph_score_idx
    ON nn_event_similarity_graph (event_b, score DESC);


-- ── 8. Cross-language story tracking ─────────────────────────────────

CREATE TABLE IF NOT EXISTS nn_story_language_tracking (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    language_code       TEXT NOT NULL,
    article_count       INT NOT NULL DEFAULT 0,
    first_article_id   BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
    latest_article_id  BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
    countries           TEXT[] NOT NULL DEFAULT '{}',
    entities            TEXT[] NOT NULL DEFAULT '{}',
    nn_coverage_score   DOUBLE PRECISION,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, language_code)
);
CREATE INDEX IF NOT EXISTS nn_story_language_tracking_event_idx
    ON nn_story_language_tracking (event_id, article_count DESC);
CREATE INDEX IF NOT EXISTS nn_story_language_tracking_language_idx
    ON nn_story_language_tracking (language_code, nn_coverage_score DESC)
    WHERE nn_coverage_score IS NOT NULL;


-- ── 9. Streaming session interest vectors ─────────────────────────────
--
-- Real-time session interest updated on every interaction (not just hourly).
-- Uses PostgreSQL LISTEN/NOTIFY to push updates to the API layer.

CREATE TABLE IF NOT EXISTS nn_realtime_session (
    session_id          TEXT PRIMARY KEY,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    topic_interest      vector(32),
    country_interest    vector(16),
    source_interest     vector(64),
    category_interest   vector(16),
    interactions_30m    INT NOT NULL DEFAULT 0,
    pin_clicks_30m      INT NOT NULL DEFAULT 0,
    searches_30m        INT NOT NULL DEFAULT 0,
    home_country        TEXT,
    last_lat            DOUBLE PRECISION,
    last_lng            DOUBLE PRECISION,
    interest_dot        vector(128)
);
CREATE OR REPLACE FUNCTION nn_realtime_session_notify()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('nn_session_update', json_build_object(
        'session_id', NEW.session_id,
        'updated_at', NEW.updated_at
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nn_realtime_session_notify_trigger
    AFTER UPDATE ON nn_realtime_session
    FOR EACH ROW EXECUTE FUNCTION nn_realtime_session_notify();


-- ── 10. Article freshness & velocity tracking ─────────────────────────

CREATE TABLE IF NOT EXISTS nn_article_velocity (
    id                  BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL UNIQUE REFERENCES news_articles(id) ON DELETE CASCADE,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    views_1h            INT NOT NULL DEFAULT 0,
    views_6h            INT NOT NULL DEFAULT 0,
    views_24h           INT NOT NULL DEFAULT 0,
    clicks_1h           INT NOT NULL DEFAULT 0,
    clicks_6h           INT NOT NULL DEFAULT 0,
    clicks_24h          INT NOT NULL DEFAULT 0,
    velocity_views      DOUBLE PRECISION NOT NULL DEFAULT 0,
    velocity_clicks     DOUBLE PRECISION NOT NULL DEFAULT 0,
    accel_views         DOUBLE PRECISION NOT NULL DEFAULT 0,
    accel_clicks        DOUBLE PRECISION NOT NULL DEFAULT 0,
    click_through_rate  DOUBLE PRECISION NOT NULL DEFAULT 0,
    engagement_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
    UNIQUE (article_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS nn_article_velocity_article_idx
    ON nn_article_velocity (article_id, snapshot_at DESC);
-- Simple btree for velocity queries (expiry handled in WHERE clause)
CREATE INDEX IF NOT EXISTS nn_article_velocity_velocity_idx
    ON nn_article_velocity (velocity_clicks DESC, snapshot_at DESC);


-- ── 11. Coverage heatmap grid ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nn_coverage_grid (
    id                  BIGSERIAL PRIMARY KEY,
    lat_bucket          DOUBLE PRECISION NOT NULL,
    lng_bucket          DOUBLE PRECISION NOT NULL,
    resolution_deg      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    country             TEXT,
    region              TEXT,
    event_count_24h     INT NOT NULL DEFAULT 0,
    article_count_24h   INT NOT NULL DEFAULT 0,
    source_count_24h     INT NOT NULL DEFAULT 0,
    unique_locations_24h INT NOT NULL DEFAULT 0,
    gap_score           DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    coverage_score      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    heat_score          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    event_velocity      DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (lat_bucket, lng_bucket, resolution_deg)
);
CREATE INDEX IF NOT EXISTS nn_coverage_grid_country_idx
    ON nn_coverage_grid (country, heat_score DESC)
    WHERE country IS NOT NULL;
CREATE INDEX IF NOT EXISTS nn_coverage_grid_velocity_idx
    ON nn_coverage_grid (event_velocity DESC, updated_at);
CREATE INDEX IF NOT EXISTS nn_coverage_grid_heat_idx
    ON nn_coverage_grid (heat_score DESC, updated_at);


-- ── 12. Stale embedding invalidation ─────────────────────────────────

CREATE TABLE IF NOT EXISTS nn_embedding_invalidations (
    id                  BIGSERIAL PRIMARY KEY,
    model_name          TEXT NOT NULL,
    model_version       TEXT NOT NULL,
    entity_type         TEXT NOT NULL,
    entity_id           BIGINT NOT NULL,
    reason              TEXT NOT NULL
        CHECK (reason IN ('content_changed', 'model_updated', 'user_feedback', 'scheduled')),
    invalidated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reencoded_at        TIMESTAMPTZ,
    UNIQUE (model_name, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS nn_embedding_invalidations_pending_idx
    ON nn_embedding_invalidations (invalidated_at)
    WHERE reencoded_at IS NULL;


-- ── 13. Rapid geolocation candidate store ────────────────────────────

CREATE TABLE IF NOT EXISTS nn_geo_candidates (
    id                  BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL UNIQUE REFERENCES news_articles(id) ON DELETE CASCADE,
    model_name          TEXT NOT NULL DEFAULT 'fast_path',
    rank                INT NOT NULL CHECK (rank BETWEEN 1 AND 5),
    location_id         BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    place_name          TEXT,
    country             TEXT,
    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    precision           TEXT NOT NULL DEFAULT 'city',
    confidence          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    score               DOUBLE PRECISION NOT NULL DEFAULT 0,
    source              TEXT NOT NULL DEFAULT 'auto'
        CHECK (source IN ('auto', 'nn', 'user', 'override')),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (article_id, rank)
);
CREATE INDEX IF NOT EXISTS nn_geo_candidates_article_idx
    ON nn_geo_candidates (article_id, rank);


-- ── Permissions ────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO xyzo_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO xyzo_app;
GRANT EXECUTE ON FUNCTION nn_realtime_session_notify() TO xyzo_app;
