-- Story evolution stages + mutation tracking
CREATE TABLE IF NOT EXISTS news_event_mutation (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    stage               TEXT NOT NULL,   -- reported|confirmed|expanded|disputed|response|consequence|resolved|escalated
    evidence            TEXT,           -- JSON array of supporting claims
    gemma_summary       TEXT,           -- AI summary of this mutation
    confidence          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    occurred_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    detected_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, stage, occurred_at)
);

CREATE INDEX idx_mut_event ON news_event_mutation(event_id);
CREATE INDEX idx_mut_stage ON news_event_mutation(stage);

-- Knowledge gap detection: deterministic checklist per event
CREATE TABLE IF NOT EXISTS news_event_knowledge_gaps (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    dimension           TEXT NOT NULL,  -- who|what|when|where|why|how|impact|casualties|response|next|evidence
    status              TEXT NOT NULL,  -- missing|partial|confirmed|disputed
    confidence          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    claim               TEXT,           -- the claim if confirmed
    source_ids          BIGINT[],       -- supporting article IDs
    contradicted_by     BIGINT[],       -- contradicting article IDs
    filled_at           TIMESTAMP WITH TIME ZONE,
    detected_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, dimension)
);

CREATE INDEX idx_kg_event   ON news_event_knowledge_gaps(event_id);
CREATE INDEX idx_kg_dim    ON news_event_knowledge_gaps(dimension);
CREATE INDEX idx_kg_status ON news_event_knowledge_gaps(status);

-- Event velocity: temporal acceleration metrics
CREATE TABLE IF NOT EXISTS news_event_velocity (
    event_id            BIGINT PRIMARY KEY REFERENCES news_events(id) ON DELETE CASCADE,
    articles_1h         INTEGER NOT NULL DEFAULT 0,
    articles_6h         INTEGER NOT NULL DEFAULT 0,
    articles_24h        INTEGER NOT NULL DEFAULT 0,
    sources_1h          INTEGER NOT NULL DEFAULT 0,
    sources_6h          INTEGER NOT NULL DEFAULT 0,
    sources_24h         INTEGER NOT NULL DEFAULT 0,
    countries_1h        INTEGER NOT NULL DEFAULT 0,
    countries_6h        INTEGER NOT NULL DEFAULT 0,
    countries_24h      INTEGER NOT NULL DEFAULT 0,
    cities_24h          INTEGER NOT NULL DEFAULT 0,
    acceleration_1h    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- ratio: current_1h / previous_1h
    acceleration_6h    DOUBLE PRECISION NOT NULL DEFAULT 0,
    acceleration_24h  DOUBLE PRECISION NOT NULL DEFAULT 0,
    velocity_score     DOUBLE PRECISION NOT NULL DEFAULT 0,   -- composite: articles*sources*countries / time
    emerging_score     DOUBLE PRECISION NOT NULL DEFAULT 0,   -- novelty-adjusted: velocity * (1 - similarity_to_known)
    unique_sources     INTEGER NOT NULL DEFAULT 0,
    original_sources   INTEGER NOT NULL DEFAULT 0,
    syndicated_copies  INTEGER NOT NULL DEFAULT 0,
    first_article_at   TIMESTAMP WITH TIME ZONE,
    last_article_at   TIMESTAMP WITH TIME ZONE,
    geographic_spread_km DOUBLE PRECISION,   -- max distance between reporting cities
    propagation_velocity_km_h DOUBLE PRECISION,  -- km/hour spread speed
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vel_event ON news_event_velocity(event_id);

-- Claim extraction: store individual claims per event
CREATE TABLE IF NOT EXISTS news_event_claims (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    claim_type          TEXT NOT NULL,   -- casualty|location|date|finding|response|impact|denial|revision
    claim_text          TEXT NOT NULL,
    numeric_value       DOUBLE PRECISION,
    unit                TEXT,
    confidence          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    source_id           BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    article_id          BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'unverified',  -- unverified|confirmed|disputed|revised
    contradicted_by     BIGINT[],       -- claim_ids that contradict this
    supported_by        BIGINT[],       -- claim_ids that support this
    contradicted_sources BIGINT[],      -- source_ids that contradict
    supported_sources   BIGINT[],       -- source_ids that support
    extracted_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_cl_event  ON news_event_claims(event_id);
CREATE INDEX idx_cl_type  ON news_event_claims(claim_type);
CREATE INDEX idx_cl_status ON news_event_claims(status);

-- Consequence tracking: predicted vs observed
CREATE TABLE IF NOT EXISTS news_event_consequences (
    id                  BIGSERIAL PRIMARY KEY,
    event_id            BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    consequence_type    TEXT NOT NULL,   -- economic|political|social|environmental|health|security
    predicted_outcome   TEXT NOT NULL,
    predicted_confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    observed_outcome    TEXT,
    observed_at         TIMESTAMP WITH TIME ZONE,
    observation_status  TEXT NOT NULL DEFAULT 'pending',  -- pending|observed|not_observed|partial
    observation_confidence DOUBLE PRECISION,
    evidence_article_ids BIGINT[],
    predicted_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_cons_event ON news_event_consequences(event_id);
CREATE INDEX idx_cons_status ON news_event_consequences(observation_status);

GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_mutation        TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_knowledge_gaps  TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_velocity       TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_claims         TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_event_consequences    TO xyzo_app;
