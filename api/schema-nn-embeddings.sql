-- Xyzo Neural Network embedding & graph caches. Additive, idempotent.
--
-- Article Understanding is the foundation model — its output (a fixed-
-- dim vector per article/event) is consumed by Geolocation, Event
-- Matching, Relationship, and Ranking. Materializing those embeddings
-- in Postgres means:
--   • Inference is O(1) point reads, not O(N) recomputation.
--   • Event Matching only needs to encode new articles and compare
--     against cached neighbors (a few thousand pairs/sec).
--   • Relationship can score candidate edges with cheap cosine.
--   • Coverage / Ranking can use embeddings as features without
--     re-running the encoder.
--
-- All embedding tables share the same shape (entity_id, dim, vector,
-- model_version, created_at) and are 16-dim by default; the worker
-- can grow to 64/128/256 once we have enough training data.
--
-- Graph edges:
--   • nn_event_pair_predictions — sparse cache of Event Matching scores
--     above a threshold. NOT every pair — only the candidates.
--   • nn_event_relationships   — Relationship Model edge scores
--     (event×event, event×location).
--   • nn_coverage_recommendations — Coverage Model output: ranked list
--     of "next sources to try" for each gap area.

CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector for cosine similarity

-- ── Default dimensionality ────────────────────────────────────────
-- 16 is plenty for cold-start. Bump to 64 once we have ≥10k labels.
-- nn_infer.py writes the actual dim; this is just the cache's default.
CREATE TABLE IF NOT EXISTS nn_embedding_dim (
    model_name      TEXT PRIMARY KEY,
    dim             INT  NOT NULL CHECK (dim IN (16, 32, 64, 128, 256)),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO nn_embedding_dim (model_name, dim) VALUES
    ('article_understanding', 16),
    ('coverage',              16)
ON CONFLICT (model_name) DO NOTHING;


-- ── Article Understanding embeddings ──────────────────────────────
-- One row per (model_version, article_id). When a new model version
-- is activated, the worker backfills new rows and old ones expire.
CREATE TABLE IF NOT EXISTS nn_article_embeddings (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL DEFAULT 'article_understanding',
    model_version   TEXT NOT NULL,
    article_id      BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    -- pgvector type. dim must match nn_embedding_dim.
    vector          vector(16) NOT NULL,
    -- Optional projection to lower-dim space for fast ANN search.
    -- Not populated until we have ≥5k articles.
    vector_proj     vector(16),
    -- Provenance
    encoded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Hash of input (title + body[:512]). Used to skip re-encoding
    -- when the article hasn't changed.
    input_hash      TEXT NOT NULL,
    UNIQUE (model_name, model_version, article_id)
);
CREATE INDEX IF NOT EXISTS nn_article_embeddings_article_idx
    ON nn_article_embeddings (article_id);
-- HNSW index for approximate nearest neighbor queries.
CREATE INDEX IF NOT EXISTS nn_article_embeddings_hnsw_idx
    ON nn_article_embeddings USING hnsw (vector vector_cosine_ops);


-- ── Event-level embeddings (averaged/pooled from articles) ────────
-- nn_infer.py aggregates per-event from article embeddings. Used by
-- Event Matching, Relationship, and as input to Ranking.
CREATE TABLE IF NOT EXISTS nn_event_embeddings (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL DEFAULT 'event_matching',
    model_version   TEXT NOT NULL,
    event_id        BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    vector          vector(16) NOT NULL,
    source_article_count INT NOT NULL DEFAULT 0,
    encoded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_name, model_version, event_id)
);
CREATE INDEX IF NOT EXISTS nn_event_embeddings_event_idx
    ON nn_event_embeddings (event_id);
CREATE INDEX IF NOT EXISTS nn_event_embeddings_hnsw_idx
    ON nn_event_embeddings USING hnsw (vector vector_cosine_ops);


-- ── Country embeddings (Coverage Model) ──────────────────────────
-- Learned from news history. Used to score "is this country similar
-- to other countries that turned out to be well-covered?" — feeds the
-- Coverage Model's gap_score.
CREATE TABLE IF NOT EXISTS nn_country_embeddings (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL DEFAULT 'coverage',
    model_version   TEXT NOT NULL,
    country_code    TEXT NOT NULL,        -- ISO-3166-1 alpha-2
    vector          vector(16) NOT NULL,
    encoded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_name, model_version, country_code)
);
CREATE INDEX IF NOT EXISTS nn_country_embeddings_country_idx
    ON nn_country_embeddings (country_code);


-- ── City embeddings (Coverage Model, fine-grained) ───────────────
CREATE TABLE IF NOT EXISTS nn_city_embeddings (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL DEFAULT 'coverage',
    model_version   TEXT NOT NULL,
    city_id         BIGINT NOT NULL,     -- world_cities.id (no FK — that table is owned by cities_owner)
    city_name       TEXT NOT NULL,
    country_code    TEXT NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    population      BIGINT,
    vector          vector(16) NOT NULL,
    encoded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_name, model_version, city_id)
);
CREATE INDEX IF NOT EXISTS nn_city_embeddings_city_idx
    ON nn_city_embeddings (city_id);
CREATE INDEX IF NOT EXISTS nn_city_embeddings_country_idx
    ON nn_city_embeddings (country_code);


-- ── Event Matching: cached pair predictions ──────────────────────
-- Event Matching is O(N²) in the worst case, so we don't store every
-- pair. Instead we store the top-K candidates per event (by score)
-- above a threshold, plus any pair that nn_train labeled as positive
-- (used as gold for retraining).
--
-- Composite PK on (event_a, event_b, model_version) lets us upsert
-- when a new model rolls out.
CREATE TABLE IF NOT EXISTS nn_event_pair_predictions (
    event_a         BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    event_b         BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    model_name      TEXT NOT NULL DEFAULT 'event_matching',
    model_version   TEXT NOT NULL,
    score           DOUBLE PRECISION NOT NULL CHECK (score BETWEEN 0 AND 1),
    -- Was this pair a positive example in training?
    is_gold         BOOLEAN NOT NULL DEFAULT FALSE,
    -- Source of the score (siamese forward, label propagation, manual)
    source          TEXT NOT NULL DEFAULT 'siamese',
    predicted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- CHECK: smaller id first so order is canonical
    CHECK (event_a < event_b),
    PRIMARY KEY (event_a, event_b, model_version)
);
CREATE INDEX IF NOT EXISTS nn_event_pair_predictions_a_idx
    ON nn_event_pair_predictions (event_a, score DESC);
CREATE INDEX IF NOT EXISTS nn_event_pair_predictions_b_idx
    ON nn_event_pair_predictions (event_b, score DESC);
CREATE INDEX IF NOT EXISTS nn_event_pair_predictions_score_idx
    ON nn_event_pair_predictions (model_version, score DESC);


-- ── Event Matching view: pairs above "consider duplicate" threshold ─
-- Default threshold 0.75 is conservative; lower it after more labels.
CREATE OR REPLACE VIEW nn_v_event_match_candidates AS
SELECT
    p.event_a,
    p.event_b,
    p.score,
    p.model_version,
    p.predicted_at,
    ea.headline AS headline_a,
    ea.event_type AS type_a,
    ea.first_reported_at AS reported_a,
    eb.headline AS headline_b,
    eb.event_type AS type_b,
    eb.first_reported_at AS reported_b
FROM nn_event_pair_predictions p
JOIN news_events ea ON ea.id = p.event_a
JOIN news_events eb ON eb.id = p.event_b
WHERE p.score >= 0.75
  AND p.model_version = (SELECT version FROM nn_model_registry
                          WHERE model_name = 'event_matching' AND is_active)
ORDER BY p.score DESC;


-- ── Relationship Model: graph edges ──────────────────────────────
-- event×event (same story, related story, follow-up) and event×location
-- (mentions but not primary, origin vs destination). Each row is a
-- scored, typed edge. The worker writes; the API reads via
-- nn_v_event_relationships view.
CREATE TABLE IF NOT EXISTS nn_event_relationships (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL DEFAULT 'relationship',
    model_version   TEXT NOT NULL,
    src_event_id    BIGINT REFERENCES news_events(id) ON DELETE CASCADE,
    dst_event_id    BIGINT REFERENCES news_events(id) ON DELETE CASCADE,
    dst_location_id BIGINT REFERENCES news_locations(id) ON DELETE CASCADE,
    -- Type of relationship. 'event' = event×event; 'location' = event×location.
    edge_type       TEXT NOT NULL CHECK (edge_type IN ('event','location')),
    -- Sub-relation for event×event:
    --   same_story      — direct continuation of the same event
    --   related         — same actor/topic but distinct event
    --   follow_up       — consequence of src_event
    --   response        — public/political response to src_event
    --   background      — context for src_event (older story)
    -- For event×location:
    --   primary         — primary location of dst_event (would be a no-op; kept for completeness)
    --   origin          — origin point (e.g. departure airport)
    --   destination     — destination point
    --   mentioned       — mentioned but not primary
    relation        TEXT NOT NULL,
    score           DOUBLE PRECISION NOT NULL CHECK (score BETWEEN 0 AND 1),
    predicted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Direction is meaningful: src_event → dst_event/location.
    -- We never store both (a,b) and (b,a).
    UNIQUE (model_version, src_event_id, dst_event_id, edge_type, relation)
);
CREATE INDEX IF NOT EXISTS nn_event_relationships_src_idx
    ON nn_event_relationships (src_event_id, score DESC);
CREATE INDEX IF NOT EXISTS nn_event_relationships_dst_idx
    ON nn_event_relationships (dst_event_id, score DESC);


CREATE OR REPLACE VIEW nn_v_event_relationships AS
SELECT
    r.src_event_id,
    ea.headline                                        AS src_headline,
    r.dst_event_id,
    eb.headline                                        AS dst_headline,
    r.dst_location_id,
    l.place_name                                       AS dst_place_name,
    l.country                                          AS dst_country,
    r.edge_type,
    r.relation,
    r.score,
    r.model_version,
    r.predicted_at
FROM nn_event_relationships r
LEFT JOIN news_events ea ON ea.id = r.src_event_id
LEFT JOIN news_events eb ON eb.id = r.dst_event_id
LEFT JOIN news_locations l ON l.id = r.dst_location_id
WHERE r.model_version = (SELECT version FROM nn_model_registry
                          WHERE model_name = 'relationship' AND is_active);


-- ── Coverage Model: ranked list of "next sources to try" ─────────
-- Per (country, language, slot), a list of recommended source URLs or
-- hostname patterns to attempt in immediate_discover.py.
CREATE TABLE IF NOT EXISTS nn_coverage_recommendations (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL DEFAULT 'coverage',
    model_version   TEXT NOT NULL,
    country_code    TEXT NOT NULL,
    language        TEXT,
    rank            INT  NOT NULL,
    -- Either a concrete URL (highest confidence) or a hostname pattern.
    recommended_url TEXT,
    hostname_pattern TEXT,
    -- Confidence the candidate will produce a working feed (0..1).
    confidence      DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    -- Reasoning the model emitted (for the admin UI).
    reasoning       TEXT,
    -- Lifecycle: 'queued' (worker hasn't tried yet) → 'attempted' →
    -- 'succeeded' / 'failed' / 'rejected'.
    status          TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','attempted','succeeded','failed','rejected')),
    attempted_at    TIMESTAMPTZ,
    result_feed_id  BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    predicted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_version, country_code, language, rank)
);
CREATE INDEX IF NOT EXISTS nn_coverage_recommendations_country_idx
    ON nn_coverage_recommendations (country_code, language, rank);


-- ── Backfill: body_hash column for fast dedup of article content ──
-- Used by Article Understanding to skip re-encoding unchanged articles.
ALTER TABLE news_articles
    ADD COLUMN IF NOT EXISTS body_hash TEXT;
CREATE INDEX IF NOT EXISTS news_articles_body_hash_idx
    ON news_articles (body_hash)
    WHERE body_hash IS NOT NULL;


-- ── Permissions ──────────────────────────────────────────────────
GRANT SELECT ON nn_article_embeddings,
                nn_event_embeddings,
                nn_country_embeddings,
                nn_city_embeddings,
                nn_event_pair_predictions,
                nn_event_relationships,
                nn_coverage_recommendations,
                nn_v_event_match_candidates,
                nn_v_event_relationships
    TO xyzo_app;
