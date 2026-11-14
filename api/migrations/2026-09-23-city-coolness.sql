-- City Coolness Engine Schema (FK-safe version for foreign tables)
-- Tracks 100+ scoring factors for every city to build a "coolness score"
-- that surfaces buzzing locations worldwide

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- Core coolness scores — one row per city_id (references world_cities.id)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS city_coolness (
    city_id              BIGINT NOT NULL,  -- FK to world_cities(id) via application logic

    -- ── Composite Scores (pre-computed for fast ranking) ──────────────────
    coolness_score       FLOAT NOT NULL DEFAULT 0,
    coolness_rank        BIGINT,
    tier                 TEXT DEFAULT 'unknown',

    -- ── Volume Factors (raw news activity) ────────────────────────────────
    articles_1d          INT NOT NULL DEFAULT 0,
    articles_7d          INT NOT NULL DEFAULT 0,
    articles_30d         INT NOT NULL DEFAULT 0,
    article_velocity      FLOAT DEFAULT 0,
    articles_per_source  FLOAT DEFAULT 0,

    -- ── Event Factors ─────────────────────────────────────────────────────
    events_7d            INT NOT NULL DEFAULT 0,
    events_30d           INT NOT NULL DEFAULT 0,
    event_velocity       FLOAT DEFAULT 0,
    major_events_7d     INT NOT NULL DEFAULT 0,
    ongoing_events       INT NOT NULL DEFAULT 0,

    -- ── Diversity Factors ──────────────────────────────────────────────────
    unique_sources       INT NOT NULL DEFAULT 0,
    unique_countries     INT NOT NULL DEFAULT 0,
    unique_languages     INT NOT NULL DEFAULT 0,
    source_diversity_idx FLOAT DEFAULT 0,
    new_sources_7d       INT NOT NULL DEFAULT 0,

    -- ── Freshness Factors ─────────────────────────────────────────────────
    last_article_at      TIMESTAMPTZ,
    minutes_since_article INT,
    freshness_score      FLOAT DEFAULT 0,
    continuous_coverage_hours INT DEFAULT 0,

    -- ── Quality Factors ───────────────────────────────────────────────────
    avg_article_length   FLOAT DEFAULT 0,
    has_images_ratio     FLOAT DEFAULT 0,
    verified_ratio       FLOAT DEFAULT 0,
    avg_source_reliability FLOAT DEFAULT 0,

    -- ── Trend Factors ─────────────────────────────────────────────────────
    week_change_pct      FLOAT DEFAULT 0,
    month_change_pct     FLOAT DEFAULT 0,
    velocity_acceleration FLOAT DEFAULT 0,
    is_surging           BOOLEAN DEFAULT false,
    surge_velocity       FLOAT DEFAULT 0,

    -- ── Population & Geography ─────────────────────────────────────────────
    population           BIGINT,
    is_capital           BOOLEAN DEFAULT false,
    is_coastal           BOOLEAN DEFAULT false,
    lat                  FLOAT,
    lng                  FLOAT,
    timezone_offset      FLOAT,

    -- ── Strategic Factors ──────────────────────────────────────────────────
    is_conflict_zone     BOOLEAN DEFAULT false,
    is_economic_center   BOOLEAN DEFAULT false,
    is_diplomatic_hub    BOOLEAN DEFAULT false,
    is_sports_center     BOOLEAN DEFAULT false,
    is_cultural_heritage BOOLEAN DEFAULT false,
    is_tourist_destination BOOLEAN DEFAULT false,
    is_tech_hub          BOOLEAN DEFAULT false,
    is_financial_center  BOOLEAN DEFAULT false,

    -- ── Regional Factors ───────────────────────────────────────────────────
    region               TEXT,
    country_code         TEXT,
    regional_rank        BIGINT,

    -- ── Editorial (human-defined coolness) ────────────────────────────────
    editorial_coolness  FLOAT DEFAULT 0,
    is_curated           BOOLEAN DEFAULT false,
    curated_tier         TEXT,

    -- ── Composite Breakdown ────────────────────────────────────────────────
    volume_score         FLOAT DEFAULT 0,
    diversity_score      FLOAT DEFAULT 0,
    trend_score          FLOAT DEFAULT 0,
    freshness_score_ct   FLOAT DEFAULT 0,
    editorial_score      FLOAT DEFAULT 0,

    -- ── Metadata ──────────────────────────────────────────────────────────
    computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (city_id)
);

CREATE INDEX IF NOT EXISTS idx_city_coolness_score ON city_coolness(coolness_score DESC);
CREATE INDEX IF NOT EXISTS idx_city_coolness_rank ON city_coolness(coolness_rank);
CREATE INDEX IF NOT EXISTS idx_city_coolness_country ON city_coolness(country_code);
CREATE INDEX IF NOT EXISTS idx_city_coolness_region ON city_coolness(region);
CREATE INDEX IF NOT EXISTS idx_city_coolness_tier ON city_coolness(tier);
CREATE INDEX IF NOT EXISTS idx_city_coolness_surging ON city_coolness(is_surging) WHERE is_surging = true;

-- ══════════════════════════════════════════════════════════════════════════════
-- Human editorial coolness tags
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS city_coolness_tag (
    id              BIGSERIAL PRIMARY KEY,
    city_id         BIGINT NOT NULL,  -- world_cities FK via app
    tag             TEXT NOT NULL,
    tag_type        TEXT NOT NULL DEFAULT 'editorial',
    weight          FLOAT NOT NULL DEFAULT 1.0,
    note            TEXT,
    created_by      TEXT DEFAULT 'system',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (city_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_city_coolness_tag_city ON city_coolness_tag(city_id);
CREATE INDEX IF NOT EXISTS idx_city_coolness_tag_type ON city_coolness_tag(tag_type);
CREATE INDEX IF NOT EXISTS idx_city_coolness_tag_name ON city_coolness_tag(tag);

-- ══════════════════════════════════════════════════════════════════════════════
-- Coolness factor definitions (for configuring weights)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS coolness_factor_config (
    factor_name     TEXT PRIMARY KEY,
    category        TEXT NOT NULL,
    weight          FLOAT NOT NULL DEFAULT 1.0,
    min_val         FLOAT DEFAULT 0,
    max_val         FLOAT,
    enabled         BOOLEAN DEFAULT true,
    description     TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════════════════════
-- Coolness score history (for trend analysis)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS city_coolness_history (
    id              BIGSERIAL PRIMARY KEY,
    city_id         BIGINT NOT NULL,
    coolness_score  FLOAT NOT NULL,
    articles_7d     INT NOT NULL,
    events_7d       INT NOT NULL,
    unique_sources  INT NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (city_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_coolness_history_city ON city_coolness_history(city_id);
CREATE INDEX IF NOT EXISTS idx_coolness_history_time ON city_coolness_history(recorded_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 500 Cool Cities curated list
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cool_city_500 (
    id              BIGSERIAL PRIMARY KEY,
    city_id         BIGINT,  -- world_cities FK via app (nullable for unmapped)
    city_name       TEXT NOT NULL,
    country_code    TEXT NOT NULL,
    region          TEXT NOT NULL,
    priority        INT DEFAULT 50,
    discovery_notes TEXT,
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    last_checked_at TIMESTAMPTZ,
    sources_found   INT DEFAULT 0,
    sources_added   INT DEFAULT 0,

    UNIQUE (city_name, country_code)
);

CREATE INDEX IF NOT EXISTS idx_cool_city_500_region ON cool_city_500(region);
CREATE INDEX IF NOT EXISTS idx_cool_city_500_priority ON cool_city_500(priority DESC);

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- Populate default factor config
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO coolness_factor_config (factor_name, category, weight, description) VALUES
    ('articles_7d', 'volume', 2.0, 'Article count in last 7 days'),
    ('articles_30d', 'volume', 1.5, 'Article count in last 30 days'),
    ('article_velocity', 'volume', 1.0, 'Week-over-week velocity change'),
    ('articles_per_source', 'volume', 0.5, 'Average articles per source'),
    ('events_7d', 'event', 2.0, 'Clustered events in last 7 days'),
    ('events_30d', 'event', 1.5, 'Clustered events in last 30 days'),
    ('major_events_7d', 'event', 2.5, 'Major events (5+ sources) in 7 days'),
    ('ongoing_events', 'event', 1.0, 'Events still ongoing'),
    ('unique_sources', 'diversity', 2.0, 'Number of unique news sources'),
    ('unique_countries', 'diversity', 1.5, 'Countries covering this city'),
    ('unique_languages', 'diversity', 1.0, 'Languages of sources'),
    ('source_diversity_idx', 'diversity', 1.0, 'Shannon entropy of sources'),
    ('new_sources_7d', 'diversity', 1.5, 'New sources in last 7 days'),
    ('freshness_score', 'freshness', 2.0, 'Recency of latest article'),
    ('continuous_coverage_hours', 'freshness', 1.0, 'Hours with unbroken coverage'),
    ('avg_article_length', 'quality', 0.5, 'Average article character count'),
    ('has_images_ratio', 'quality', 0.5, 'Ratio of articles with images'),
    ('verified_ratio', 'quality', 1.0, 'Ratio from verified sources'),
    ('avg_source_reliability', 'quality', 1.0, 'Average reliability of sources'),
    ('week_change_pct', 'trend', 2.0, 'Week-over-week % change'),
    ('month_change_pct', 'trend', 1.5, 'Month-over-month % change'),
    ('velocity_acceleration', 'trend', 1.5, 'Acceleration of velocity'),
    ('is_surging', 'trend', 2.5, 'City is in a surge'),
    ('is_capital', 'strategic', 1.0, 'Is a national capital'),
    ('is_conflict_zone', 'strategic', 2.0, 'Conflict/war zone'),
    ('is_economic_center', 'strategic', 1.0, 'Major economic hub'),
    ('is_diplomatic_hub', 'strategic', 1.5, 'Diplomatic activity'),
    ('is_sports_center', 'strategic', 0.5, 'Sports significance'),
    ('is_cultural_heritage', 'strategic', 0.5, 'UNESCO heritage site'),
    ('is_tourist_destination', 'strategic', 0.5, 'Major tourist destination'),
    ('is_tech_hub', 'strategic', 1.0, 'Technology/innovation center'),
    ('is_financial_center', 'strategic', 1.0, 'Financial markets significance'),
    ('editorial_coolness', 'editorial', 3.0, 'Human-set coolness score'),
    ('is_curated', 'editorial', 2.0, 'In curated 500-cool-cities list')
ON CONFLICT (factor_name) DO NOTHING;
