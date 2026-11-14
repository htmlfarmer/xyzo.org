-- Fix missing columns and add source profiling infrastructure
-- Idempotent - safe to re-run

-- 1. Add deleted_at column (referenced in API queries but missing)
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2. Add source_profile JSONB for rich metadata (spec: docs/superpowers/specs/2026-09-01-quality-engine.md)
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS source_profile JSONB;

-- 3. Add homepage_url if missing
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS homepage_url TEXT;

-- 4. Add base_domain for feed grouping
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS base_domain TEXT;

-- 5. Add language fields for multilingual tracking
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS language_primary TEXT;
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS language_secondary TEXT[];

-- ─── Source Geography Table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_source_geography (
    source_id          BIGINT PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
    top_cities         JSONB NOT NULL DEFAULT '[]',
    top_countries      JSONB NOT NULL DEFAULT '[]',
    primary_city_id    BIGINT,
    secondary_city_id  BIGINT,
    article_count_30d  INT DEFAULT 0,
    unique_countries_30d INT DEFAULT 0,
    unique_cities_30d  INT DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_source_geography_source_idx ON news_source_geography (source_id);

-- ─── Source Topics Table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_source_topics (
    source_id          BIGINT PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
    top_topics         JSONB NOT NULL DEFAULT '[]',
    topic_vector       REAL[],
    keyword_counts     JSONB DEFAULT '{}',
    article_count_30d  INT DEFAULT 0,
    primary_topic      TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_source_topics_source_idx ON news_source_topics (source_id);

-- ─── Source Language Table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_source_languages (
    source_id              BIGINT PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
    detected_languages     JSONB NOT NULL DEFAULT '[]',
    configured_languages   JSONB NOT NULL DEFAULT '[]',
    primary_language       TEXT,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Coverage Gaps Table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_source_coverage_gaps (
    id                  BIGSERIAL PRIMARY KEY,
    source_id           BIGINT NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
    detected_country    TEXT NOT NULL,
    article_count_30d   INT DEFAULT 0,
    is_surprise         BOOLEAN DEFAULT FALSE,
    gap_score           FLOAT DEFAULT 0.0,
    first_detected      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_detected       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source_id, detected_country)
);

CREATE INDEX IF NOT EXISTS news_source_coverage_gaps_source_idx ON news_source_coverage_gaps (source_id);
CREATE INDEX IF NOT EXISTS news_source_coverage_gaps_gap_idx ON news_source_coverage_gaps (gap_score DESC);

-- ─── Seed default news_topics ─────────────────────────────────────────────
INSERT INTO news_topics (slug, label) VALUES
    ('politics', 'Politics'),
    ('economy', 'Economy'),
    ('business', 'Business'),
    ('technology', 'Technology'),
    ('science', 'Science'),
    ('health', 'Health'),
    ('sports', 'Sports'),
    ('culture', 'Culture'),
    ('environment', 'Environment'),
    ('conflict', 'Conflict'),
    ('crime', 'Crime'),
    ('disaster', 'Disaster'),
    ('weather', 'Weather'),
    ('other', 'Other')
ON CONFLICT (slug) DO NOTHING;
