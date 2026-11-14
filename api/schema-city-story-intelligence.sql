-- City-Story Relationship Intelligence Schema
-- Designed for: Small ML city-story classification + embedding similarity + graph analysis
--
-- Architecture:
--   story_id → candidate cities (via geographic proximity, explicit mentions, source location)
--            → feature extraction (~30 features per pair)
--            → small ML classifier (LogisticRegression/LightGBM)
--            → embedding similarity (semantic relevance)
--            → graph analysis (Wikidata neighborhoods)
--            → final relationship with explainable scores
--
-- Layer cooperation:
--   Level 0:    SQL/PostGIS geographic truth
--   Level 0.5:  Explicit textual signals (names, aliases, Wikidata entities)
--   Level 1:    Small ML classifier (place_presence)
--   Level 2:    Embedding semantic similarity (place_relevance)
--   Level 3:    Graph/Wikidata (entity neighborhoods)
--   Level 4:    Gemma (ambiguous cases only)

-- ─── Relationship Types ───────────────────────────────────────────────────────
CREATE TYPE city_story_relation_type AS ENUM (
    'DIRECT_LOCAL',
    'DIRECT_CITY',
    'ADMINISTRATIVE',
    'SOURCE_LOCATION',
    'ENTITY_ASSOCIATED',
    'REGIONAL',
    'COUNTRY',
    'ECONOMIC',
    'CULTURAL',
    'SCIENTIFIC',
    'SEMANTIC',
    'HISTORICAL',
    'INCIDENTAL',
    'NONE'
);

-- ─── City Story Features ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS city_story_features (
    id                      BIGSERIAL PRIMARY KEY,
    story_id                BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    city_id                 BIGINT NOT NULL,
    extraction_run_id        BIGINT,

    -- LEVEL 0: GEOGRAPHIC SIGNALS (PostGIS)
    geographic_distance_m   DOUBLE PRECISION,
    geographic_contained    BOOLEAN,
    same_country            BOOLEAN,
    same_admin1             BOOLEAN,
    city_population         BIGINT,

    -- LEVEL 0.5: EXPLICIT TEXTUAL SIGNALS
    direct_city_name        BOOLEAN DEFAULT FALSE,
    city_alias_match        BOOLEAN DEFAULT FALSE,
    country_name            BOOLEAN DEFAULT FALSE,
    region_name             BOOLEAN DEFAULT FALSE,
    capital_indicator       BOOLEAN DEFAULT FALSE,
    landmark_entity         BOOLEAN DEFAULT FALSE,
    org_entity             BOOLEAN DEFAULT FALSE,
    person_in_city         BOOLEAN DEFAULT FALSE,

    -- SOURCE SIGNALS
    source_in_city          BOOLEAN DEFAULT FALSE,
    source_country_match    BOOLEAN DEFAULT FALSE,
    source_region_match     BOOLEAN DEFAULT FALSE,

    -- ENTITY SIGNALS (Wikidata-backed)
    wikidata_entity_count   INT DEFAULT 0,
    entity_match_score      DOUBLE PRECISION DEFAULT 0,
    institution_match       BOOLEAN DEFAULT FALSE,
    landmark_match          BOOLEAN DEFAULT FALSE,

    -- TOPIC/TEXT SIGNALS
    topic_city_relevance    DOUBLE PRECISION DEFAULT 0,
    body_length             INT DEFAULT 0,

    -- EMBEDDING SIGNALS (Level 2) - stored as JSONB arrays since pgvector not available
    embedding_similarity    DOUBLE PRECISION DEFAULT 0,
    embedding_general       DOUBLE PRECISION DEFAULT 0,
    embedding_economy       DOUBLE PRECISION DEFAULT 0,
    embedding_science       DOUBLE PRECISION DEFAULT 0,
    embedding_politics      DOUBLE PRECISION DEFAULT 0,
    embedding_culture       DOUBLE PRECISION DEFAULT 0,
    embedding_transport     DOUBLE PRECISION DEFAULT 0,
    embedding_environment   DOUBLE PRECISION DEFAULT 0,

    -- TEMPORAL SIGNALS
    published_hour_local    INT DEFAULT 12,
    weekend_published       BOOLEAN DEFAULT FALSE,

    -- AGGREGATE SCORES
    presence_score          DOUBLE PRECISION DEFAULT 0,
    relevance_score         DOUBLE PRECISION DEFAULT 0,

    -- Provenance
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    feature_version        TEXT NOT NULL DEFAULT 'v1',

    UNIQUE (story_id, city_id, extraction_run_id)
);

CREATE INDEX IF NOT EXISTS csf_story_idx       ON city_story_features (story_id);
CREATE INDEX IF NOT EXISTS csf_city_idx        ON city_story_features (city_id);
CREATE INDEX IF NOT EXISTS csf_story_city_idx  ON city_story_features (story_id, city_id);
CREATE INDEX IF NOT EXISTS csf_presence_idx   ON city_story_features (presence_score DESC);
CREATE INDEX IF NOT EXISTS csf_relevance_idx  ON city_story_features (relevance_score DESC);
CREATE INDEX IF NOT EXISTS csf_extraction_idx ON city_story_features (extraction_run_id);

-- ================================================================
-- CITY STORY RELATIONSHIPS
-- ================================================================
CREATE TABLE IF NOT EXISTS city_story_relationships (
    id                      BIGSERIAL PRIMARY KEY,
    story_id                BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    city_id                 BIGINT NOT NULL,

    place_presence          DOUBLE PRECISION NOT NULL DEFAULT 0,
    place_relevance         DOUBLE PRECISION NOT NULL DEFAULT 0,

    relationship_type       city_story_relation_type NOT NULL DEFAULT 'NONE',

    primary_evidence        TEXT[],
    all_signals_json        JSONB,

    geographic_score        DOUBLE PRECISION,
    textual_score           DOUBLE PRECISION,
    entity_score            DOUBLE PRECISION,
    source_score            DOUBLE PRECISION,
    embedding_score         DOUBLE PRECISION,

    confidence              DOUBLE PRECISION NOT NULL DEFAULT 0,

    is_primary_city         BOOLEAN NOT NULL DEFAULT FALSE,
    is_related_city         BOOLEAN NOT NULL DEFAULT FALSE,
    display_level           TEXT NOT NULL DEFAULT 'hidden',

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (story_id, city_id)
);

CREATE INDEX IF NOT EXISTS csr_story_idx        ON city_story_relationships (story_id);
CREATE INDEX IF NOT EXISTS csr_city_idx         ON city_story_relationships (city_id);
CREATE INDEX IF NOT EXISTS csr_primary_idx      ON city_story_relationships (is_primary_city) WHERE is_primary_city;
CREATE INDEX IF NOT EXISTS csr_related_idx      ON city_story_relationships (is_related_city) WHERE is_related_city;
CREATE INDEX IF NOT EXISTS csr_type_idx         ON city_story_relationships (relationship_type);
CREATE INDEX IF NOT EXISTS csr_presence_idx     ON city_story_relationships (place_presence DESC);
CREATE INDEX IF NOT EXISTS csr_relevance_idx    ON city_story_relationships (place_relevance DESC);
CREATE INDEX IF NOT EXISTS csr_confidence_idx   ON city_story_relationships (confidence DESC);

-- ================================================================
-- EXTRACTION RUNS
-- ================================================================
CREATE TABLE IF NOT EXISTS city_story_extraction_runs (
    id                      BIGSERIAL PRIMARY KEY,
    run_type                TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running','completed','failed')),
    stories_processed       INT NOT NULL DEFAULT 0,
    stories_with_matches    INT NOT NULL DEFAULT 0,
    candidates_generated    INT NOT NULL DEFAULT 0,
    processing_time_ms      INT,
    error_message           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ
);

-- ================================================================
-- CITY ENTITY NEIGHBORHOODS (Wikidata-backed)
-- ================================================================
CREATE TABLE IF NOT EXISTS city_entity_neighborhoods (
    id                      BIGSERIAL PRIMARY KEY,
    city_id                 BIGINT NOT NULL,

    universities            TEXT[] NOT NULL DEFAULT '{}',
    hospitals               TEXT[] NOT NULL DEFAULT '{}',
    research_institutions   TEXT[] NOT NULL DEFAULT '{}',
    landmarks               TEXT[] NOT NULL DEFAULT '{}',
    organizations           TEXT[] NOT NULL DEFAULT '{}',
    airports                TEXT[] NOT NULL DEFAULT '{}',
    sports_teams            TEXT[] NOT NULL DEFAULT '{}',
    museums                 TEXT[] NOT NULL DEFAULT '{}',
    parks                   TEXT[] NOT NULL DEFAULT '{}',
    hospitals_wikidata      TEXT[] NOT NULL DEFAULT '{}',
    universities_wikidata   TEXT[] NOT NULL DEFAULT '{}',
    institutions_wikidata   TEXT[] NOT NULL DEFAULT '{}',

    embedding_general       DOUBLE PRECISION DEFAULT 0,
    embedding_economy       DOUBLE PRECISION DEFAULT 0,
    embedding_science       DOUBLE PRECISION DEFAULT 0,
    embedding_politics      DOUBLE PRECISION DEFAULT 0,
    embedding_culture       DOUBLE PRECISION DEFAULT 0,
    embedding_transport    DOUBLE PRECISION DEFAULT 0,
    embedding_environment   DOUBLE PRECISION DEFAULT 0,

    source_wikidata         BOOLEAN NOT NULL DEFAULT FALSE,
    source_wikipedia        BOOLEAN NOT NULL DEFAULT FALSE,
    source_manual           BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated            TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (city_id)
);

CREATE INDEX IF NOT EXISTS cen_city_idx        ON city_entity_neighborhoods (city_id);
CREATE INDEX IF NOT EXISTS cen_universities_idx ON city_entity_neighborhoods USING GIN (universities);
CREATE INDEX IF NOT EXISTS cen_orgs_idx        ON city_entity_neighborhoods USING GIN (organizations);
CREATE INDEX IF NOT EXISTS cen_landmarks_idx   ON city_entity_neighborhoods USING GIN (landmarks);

-- ================================================================
-- TRAINING LABELS
-- ================================================================
CREATE TABLE IF NOT EXISTS city_story_labels (
    id                      BIGSERIAL PRIMARY KEY,
    story_id                BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    city_id                 BIGINT NOT NULL,
    label                   SMALLINT NOT NULL CHECK (label IN (0, 1)),
    label_source            TEXT NOT NULL DEFAULT 'auto'
                                CHECK (label_source IN ('auto', 'manual', 'implied')),
    implied_reason          TEXT,
    label_confidence        DOUBLE PRECISION DEFAULT 1.0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (story_id, city_id, label_source)
);

CREATE INDEX IF NOT EXISTS csl_story_idx      ON city_story_labels (story_id);
CREATE INDEX IF NOT EXISTS csl_city_idx       ON city_story_labels (city_id);
CREATE INDEX IF NOT EXISTS csl_label_idx      ON city_story_labels (label);
CREATE INDEX IF NOT EXISTS csl_source_idx     ON city_story_labels (label_source);

-- ================================================================
-- MODEL REGISTRY
-- ================================================================
CREATE TABLE IF NOT EXISTS city_story_models (
    id                      BIGSERIAL PRIMARY KEY,
    model_type              TEXT NOT NULL,
    model_version           TEXT NOT NULL,
    feature_version         TEXT NOT NULL DEFAULT 'v1',

    training_samples         INT,
    accuracy                DOUBLE PRECISION,
    precision               DOUBLE PRECISION,
    recall                  DOUBLE PRECISION,
    f1_score                DOUBLE PRECISION,

    model_path              TEXT,
    model_hash              TEXT,

    is_active               BOOLEAN NOT NULL DEFAULT FALSE,
    trained_at              TIMESTAMPTZ,
    deployed_at             TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (model_type, model_version)
);

-- ================================================================
-- GRAPH RELATIONSHIPS
-- ================================================================
CREATE TABLE IF NOT EXISTS city_graph_connections (
    id                      BIGSERIAL PRIMARY KEY,
    city_id                 BIGINT NOT NULL,
    connected_city_id       BIGINT NOT NULL,
    connection_type         TEXT NOT NULL,
    connection_strength     DOUBLE PRECISION DEFAULT 0.5,
    source                  TEXT DEFAULT 'wikidata',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (city_id, connected_city_id, connection_type)
);

CREATE INDEX IF NOT EXISTS cgc_city_idx       ON city_graph_connections (city_id);
CREATE INDEX IF NOT EXISTS cgc_connected_idx  ON city_graph_connections (connected_city_id);
CREATE INDEX IF NOT EXISTS cgc_type_idx      ON city_graph_connections (connection_type);

-- ================================================================
-- PERMISSIONS
-- ================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON city_story_features TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON city_story_relationships TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON city_story_extraction_runs TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON city_entity_neighborhoods TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON city_story_labels TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON city_story_models TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON city_graph_connections TO xyzo_app;

-- ================================================================
-- VIEWS
-- ================================================================

CREATE OR REPLACE VIEW city_story_primary AS
SELECT
    r.story_id,
    r.city_id,
    r.place_presence,
    r.place_relevance,
    r.relationship_type,
    r.confidence,
    r.primary_evidence
FROM city_story_relationships r
WHERE r.is_primary_city = TRUE;

CREATE OR REPLACE VIEW city_story_related AS
SELECT
    r.story_id,
    r.city_id,
    r.place_presence,
    r.place_relevance,
    r.relationship_type,
    r.confidence,
    r.display_level
FROM city_story_relationships r
WHERE r.is_related_city = TRUE;

CREATE OR REPLACE VIEW city_story_quadrants AS
SELECT
    r.story_id,
    r.city_id,
    r.place_presence,
    r.place_relevance,
    CASE
        WHEN r.place_presence >= 0.7 AND r.place_relevance >= 0.7 THEN 'ABOUT'
        WHEN r.place_presence >= 0.7 AND r.place_relevance < 0.7 THEN 'LOCAL'
        WHEN r.place_presence < 0.7 AND r.place_relevance >= 0.7 THEN 'RELATED'
        ELSE 'INCIDENTAL'
    END AS quadrant,
    r.relationship_type,
    r.confidence
FROM city_story_relationships r
WHERE r.is_related_city = TRUE;

GRANT SELECT ON city_story_primary TO xyzo_app;
GRANT SELECT ON city_story_related TO xyzo_app;
GRANT SELECT ON city_story_quadrants TO xyzo_app;
