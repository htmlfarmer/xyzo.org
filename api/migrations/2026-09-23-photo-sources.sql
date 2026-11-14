-- Migration: photo_sources table
-- Photography & photojournalism source registry.
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS photo_sources (
    id                  BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    domain              TEXT NOT NULL UNIQUE,
    url                 TEXT,
    source_type         TEXT NOT NULL DEFAULT 'photojournalism'
        CHECK (source_type IN (
            'photojournalism','documentary','street','nature','wildlife',
            'travel','science','astronomy','culture','indigenous',
            'fashion','art','local_news','agency','archive',
            'collective','festival'
        )),
    category            TEXT NOT NULL DEFAULT 'global_photo'
        CHECK (category IN (
            'global_photo','africa','latin_america','europe','asia',
            'southeast_asia_pacific','nature_wildlife','street',
            'science_space','museums_festivals'
        )),
    country             TEXT,
    language            TEXT DEFAULT 'en',
    region              TEXT,
    -- Robots/crawl intelligence (auto-populated by checker)
    robots_status       TEXT DEFAULT 'pending'
        CHECK (robots_status IN ('pending','allowed','partial','blocked','error')),
    robots_checked_at   TIMESTAMPTZ,
    robots_content_hash TEXT,
    robots_http_status  INTEGER,
    robots_sitemaps     JSONB DEFAULT '[]',
    robots_crawl_delay_s INTEGER,
    -- Feed discovery (auto-populated)
    has_rss             BOOLEAN DEFAULT FALSE,
    has_atom            BOOLEAN DEFAULT FALSE,
    has_sitemap         BOOLEAN DEFAULT FALSE,
    has_json_feed       BOOLEAN DEFAULT FALSE,
    rss_url             TEXT,
    -- Photo-specific signals
    has_photo_page      BOOLEAN DEFAULT FALSE,
    has_embed_policy    BOOLEAN,
    image_license_known BOOLEAN DEFAULT FALSE,
    -- Audio cross-posting (for future use)
    audio_feed_url      TEXT,
    -- Quality scores (0-100, auto-populated by evaluator)
    visual_score        SMALLINT CHECK (visual_score BETWEEN 0 AND 100),
    uniqueness_score    SMALLINT CHECK (uniqueness_score BETWEEN 0 AND 100),
    locality_score      SMALLINT CHECK (locality_score BETWEEN 0 AND 100),
    -- Lifecycle
    active              BOOLEAN DEFAULT TRUE,
    seed_source         TEXT,
    discovered_at       TIMESTAMPTZ DEFAULT NOW(),
    added_at            TIMESTAMPTZ DEFAULT NOW(),
    last_check_at       TIMESTAMPTZ,
    last_error          TEXT,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS photo_sources_domain_idx ON photo_sources (domain);
CREATE INDEX IF NOT EXISTS photo_sources_category_idx ON photo_sources (category);
CREATE INDEX IF NOT EXISTS photo_sources_country_idx ON photo_sources (country);
CREATE INDEX IF NOT EXISTS photo_sources_source_type_idx ON photo_sources (source_type);
CREATE INDEX IF NOT EXISTS photo_sources_robots_idx ON photo_sources (robots_status);
CREATE INDEX IF NOT EXISTS photo_sources_active_idx ON photo_sources (active) WHERE active;

DROP TRIGGER IF EXISTS photo_sources_updated_at ON photo_sources;
CREATE TRIGGER photo_sources_updated_at BEFORE UPDATE ON photo_sources
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON photo_sources TO xyzo_app;
GRANT USAGE ON SEQUENCE photo_sources_id_seq TO xyzo_app;

-- Aggregate view
CREATE OR REPLACE VIEW photo_sources_by_category AS
SELECT
    category,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE robots_status = 'allowed')::int AS allowed,
    COUNT(*) FILTER (WHERE robots_status = 'blocked')::int AS blocked,
    COUNT(*) FILTER (WHERE robots_status = 'pending')::int AS pending,
    COUNT(DISTINCT country)::int AS country_count
FROM photo_sources
WHERE active = TRUE
GROUP BY category
ORDER BY total DESC;
