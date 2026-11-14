-- news_deserts: places with high population but low news coverage
CREATE TABLE IF NOT EXISTS news_deserts (
    id              BIGSERIAL PRIMARY KEY,
    city_id         BIGINT,
    city_name       TEXT NOT NULL,
    country_code    TEXT NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,

    -- Population
    population      INTEGER NOT NULL DEFAULT 0,

    -- Coverage metrics (from news_sources within 0.35 degrees ~40km)
    source_count    INTEGER NOT NULL DEFAULT 0,
    article_24h     INTEGER NOT NULL DEFAULT 0,
    article_7d      INTEGER NOT NULL DEFAULT 0,

    -- Scores (0-1, higher = more underserved)
    desert_score    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- 0 = well-covered, 1 = desert
    coverage_ratio  DOUBLE PRECISION NOT NULL DEFAULT 0,  -- sources per 100k population
    velocity_score  DOUBLE PRECISION NOT NULL DEFAULT 0,  -- recent vs historical coverage

    -- Context
    nearest_source_km   DOUBLE PRECISION,
    dominant_language   TEXT,
    mainstream_present  BOOLEAN NOT NULL DEFAULT FALSE,
    last_article_at    TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(city_id)
);

CREATE INDEX IF NOT EXISTS idx_deserts_score ON news_deserts(desert_score DESC);
CREATE INDEX IF NOT EXISTS idx_deserts_country ON news_deserts(country_code);
CREATE INDEX IF NOT EXISTS idx_deserts_pop ON news_deserts(population DESC);

ALTER TABLE news_deserts ENABLE ROW LEVEL SECURITY;

CREATE POLICY news_deserts_all ON news_deserts
    FOR ALL TO xyzo_app USING (true) WITH CHECK (true);

GRANT SELECT ON news_deserts TO xyzo_app;
GRANT INSERT, UPDATE, DELETE ON news_deserts TO xyzo_app;
