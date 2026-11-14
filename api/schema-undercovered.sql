-- news_undercovered: events that are heavily covered locally but barely by international media
CREATE TABLE IF NOT EXISTS news_undercovered (
    id              BIGSERIAL PRIMARY KEY,
    event_id        BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Scoring components (all 0-1 normalized)
    local_coverage_score   DOUBLE PRECISION NOT NULL DEFAULT 0,  -- fraction of sources that are local to event country
    source_diversity_score DOUBLE PRECISION NOT NULL DEFAULT 0,  -- entropy across countries/languages
    velocity_score        DOUBLE PRECISION NOT NULL DEFAULT 0,  -- coverage growth rate (articles/hour)
    population_score      DOUBLE PRECISION NOT NULL DEFAULT 0,  -- log-scale population in affected area
    mainstream_neg_score  DOUBLE PRECISION NOT NULL DEFAULT 0,  -- inverse of mainstream (US/GB/INT) coverage

    -- Composite score (0-100)
    undercover_score      DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Context
    article_count         INTEGER NOT NULL DEFAULT 0,
    source_count          INTEGER NOT NULL DEFAULT 0,
    country_count         INTEGER NOT NULL DEFAULT 0,
    language_count        INTEGER NOT NULL DEFAULT 0,
    local_source_count    INTEGER NOT NULL DEFAULT 0,
    mainstream_count      INTEGER NOT NULL DEFAULT 0,
    first_covered_at      TIMESTAMPTZ,
    latest_article_at     TIMESTAMPTZ,
    velocity_6h           INTEGER NOT NULL DEFAULT 0,
    event_country         TEXT,
    population_estimate   BIGINT,

    -- Human-readable signal labels
    signals               TEXT[] NOT NULL DEFAULT '{}',

    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(event_id)
);

CREATE INDEX IF NOT EXISTS idx_undercovered_score ON news_undercovered(undercover_score DESC);
CREATE INDEX IF NOT EXISTS idx_undercovered_event ON news_undercovered(event_id);
CREATE INDEX IF NOT EXISTS idx_undercovered_discovered ON news_undercovered(discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_undercovered_country ON news_undercovered(event_country);

ALTER TABLE news_undercovered ENABLE ROW LEVEL SECURITY;

-- xyzo_app can read
GRANT SELECT ON news_undercovered TO xyzo_app;
GRANT INSERT, UPDATE, DELETE ON news_undercovered TO xyzo_app;
