-- Syndication detection: track article ancestry, detect copies vs. original reporting
CREATE TABLE IF NOT EXISTS news_article_syndication (
    id                        BIGSERIAL PRIMARY KEY,
    article_id                BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    original_article_id       BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
    syndication_chain_depth   SMALLINT NOT NULL DEFAULT 0,
    is_original               BOOLEAN NOT NULL DEFAULT FALSE,
    is_syndicated_copy        BOOLEAN NOT NULL DEFAULT FALSE,
    syndication_confidence    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    content_similarity        DOUBLE PRECISION,
    structural_similarity     DOUBLE PRECISION,
    same_boilerplate          BOOLEAN DEFAULT FALSE,
    same_headline_template   BOOLEAN DEFAULT FALSE,
    same_byline               BOOLEAN DEFAULT FALSE,
    temporal_offset_seconds   BIGINT,
    detected_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(article_id)
);

CREATE INDEX idx_syn_article_id       ON news_article_syndication(article_id);
CREATE INDEX idx_syn_original_id       ON news_article_syndication(original_article_id);
CREATE INDEX idx_syn_is_original      ON news_article_syndication(is_original) WHERE is_original = TRUE;
CREATE INDEX idx_syn_is_syndicated    ON news_article_syndication(is_syndicated_copy) WHERE is_syndicated_copy = TRUE;
CREATE INDEX idx_syn_chain_depth       ON news_article_syndication(syndication_chain_depth);

-- Source family table: track which sources commonly syndicate from which
CREATE TABLE IF NOT EXISTS news_source_families (
    id                  BIGSERIAL PRIMARY KEY,
    parent_source_id    BIGINT REFERENCES news_sources(id) ON DELETE CASCADE,
    child_source_id     BIGINT REFERENCES news_sources(id) ON DELETE CASCADE,
    syndication_count   INTEGER NOT NULL DEFAULT 0,
    avg_confidence      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    is_common           BOOLEAN NOT NULL DEFAULT FALSE,
    discovered_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(parent_source_id, child_source_id)
);

CREATE INDEX idx_sf_parent ON news_source_families(parent_source_id);
CREATE INDEX idx_sf_child  ON news_source_families(child_source_id);

-- Article content fingerprint for fast near-duplicate detection
-- Uses MinHash LSH: 128 permutations, 256-bit fingerprint
CREATE TABLE IF NOT EXISTS news_article_fingerprints (
    id                  BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL UNIQUE REFERENCES news_articles(id) ON DELETE CASCADE,
    fingerprint         BYTEA NOT NULL,
    content_hash        TEXT NOT NULL,        -- SHA-256 of normalized body
    title_hash          TEXT NOT NULL,        -- SHA-256 of normalized title
    body_length         INTEGER NOT NULL,
    published_at        TIMESTAMP WITH TIME ZONE,
    source_id           BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    computed_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_af_article ON news_article_fingerprints(article_id);
CREATE INDEX idx_af_source  ON news_article_fingerprints(source_id);
CREATE INDEX idx_af_published ON news_article_fingerprints(published_at);

-- Event syndication summary: roll up syndication stats per event
CREATE TABLE IF NOT EXISTS news_event_syndication (
    event_id                    BIGINT PRIMARY KEY REFERENCES news_events(id) ON DELETE CASCADE,
    total_articles              INTEGER NOT NULL DEFAULT 0,
    original_reporting_sources  INTEGER NOT NULL DEFAULT 0,
    syndicated_copies           INTEGER NOT NULL DEFAULT 0,
    source_families_represented INTEGER NOT NULL DEFAULT 0,
    independent_sources        INTEGER NOT NULL DEFAULT 0,
    syndication_ratio          DOUBLE PRECISION NOT NULL DEFAULT 0,  -- copies / total
    avg_syndication_depth      DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_syndication_depth      INTEGER NOT NULL DEFAULT 0,
    corroborated_claims         INTEGER NOT NULL DEFAULT 0,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Syndication propagation: track how a story spreads geographically
CREATE TABLE IF NOT EXISTS news_event_propagation (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    source_id           BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    city_id             BIGINT,
    country_code        TEXT,
    lat                 DOUBLE PRECISION,
    lng                 DOUBLE PRECISION,
    propagation_order   INTEGER NOT NULL,   -- 1=first, 2=second, etc.
    time_offset_seconds BIGINT,            -- seconds since first report
    is_original_report  BOOLEAN NOT NULL DEFAULT FALSE,
    detected_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, source_id, city_id)
);

CREATE INDEX idx_ep_event     ON news_event_propagation(event_id);
CREATE INDEX idx_ep_propagation ON news_event_propagation(event_id, propagation_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON news_article_syndication TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_source_families   TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_article_fingerprints TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_syndication    TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_propagation   TO xyzo_app;
