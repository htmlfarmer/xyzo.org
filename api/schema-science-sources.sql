-- news_science_sources: curated science universe candidates
-- robots_status is checked DYNAMICALLY — never hardcoded as "allowed"
CREATE TABLE IF NOT EXISTS news_science_sources (
    id                  BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    domain              TEXT NOT NULL UNIQUE,
    url                 TEXT,

    -- Science taxonomy
    focus               TEXT NOT NULL,   -- e.g. 'astronomy', 'AI', 'quantum', 'robotics'
    subfocus            TEXT[],           -- e.g. ['exoplanets', 'JWST', 'cosmology']
    science_tier        SMALLINT NOT NULL DEFAULT 4,
    -- Tier 0: primary evidence (NASA, ESA, CERN, observatories, papers)
    -- Tier 1: expert journalism (SpaceNews, Ars, Quanta, Nature)
    -- Tier 2: great explainers (Universe Today, ScienceAlert, Phys.org)
    -- Tier 3: independent/quirky (research blogs, maker communities)
    -- Tier 4: raw firehose (arXiv, bioRxiv, institutional repos)

    -- Source metadata
    country             TEXT,
    language            TEXT DEFAULT 'en',
    alexa_rank          INTEGER,
    established_year    INTEGER,
    source_type         TEXT DEFAULT 'publication',  -- publication|institution|repository|blog|news

    -- robots.txt tracking (always dynamic — never hardcoded)
    robots_status       TEXT DEFAULT 'pending'
                        CHECK (robots_status IN ('pending', 'allowed', 'blocked', 'unreachable', 'error')),
    robots_checked_at   TIMESTAMPTZ,
    robots_content_hash TEXT,
    robots_http_status  INTEGER,
    robots_allowed_path TEXT,         -- most-specific allowed path
    robots_blocked_path TEXT,       -- most-specific blocked path
    robots_sitemaps     JSONB DEFAULT '[]',
    robots_crawl_delay_s INTEGER,   -- from Crawl-delay directive

    -- Discovery metadata
    seed_source         TEXT,         -- 'user_list', 'arXiv', 'discovered', etc.
    discovered_at      TIMESTAMPTZ DEFAULT NOW(),
    added_at           TIMESTAMPTZ DEFAULT NOW(),

    -- Last crawl result
    last_check_at       TIMESTAMPTZ,
    last_http_status    INTEGER,
    last_error          TEXT,

    -- Source quality signals
    has_rss              BOOLEAN DEFAULT FALSE,
    has_atom             BOOLEAN DEFAULT FALSE,
    has_sitemap          BOOLEAN DEFAULT FALSE,
    has_json_feed        BOOLEAN DEFAULT FALSE,
    article_depth_score  DOUBLE PRECISION,  -- 0-1: avg word count / 5000
    duplicate_rate       DOUBLE PRECISION,  -- 0-1: fraction of duplicate articles

    active              BOOLEAN DEFAULT TRUE,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sci_robots_status ON news_science_sources(robots_status);
CREATE INDEX IF NOT EXISTS idx_sci_focus ON news_science_sources(focus);
CREATE INDEX IF NOT EXISTS idx_sci_tier ON news_science_sources(science_tier);
CREATE INDEX IF NOT EXISTS idx_sci_domain ON news_science_sources(domain);

ALTER TABLE news_science_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY sci_sources_all ON news_science_sources FOR ALL TO xyzo_app USING (true) WITH CHECK (true);
GRANT SELECT ON news_science_sources TO xyzo_app;
GRANT INSERT, UPDATE, DELETE ON news_science_sources TO xyzo_app;
