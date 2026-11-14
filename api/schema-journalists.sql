-- Journalists: a people layer on top of XYZO's news map
CREATE TABLE IF NOT EXISTS news_journalists (
    id                      BIGSERIAL PRIMARY KEY,

    -- Identity
    canonical_name          TEXT NOT NULL,
    display_name            TEXT,
    bio                     TEXT,
    gender                  TEXT,
    language_primary        TEXT,
    languages              TEXT[],

    -- Location (estimated from bylines, profiles, article history)
    country                 TEXT,
    country_id              BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    city                    TEXT,
    city_id                 BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    location_confidence     DOUBLE PRECISION DEFAULT 0.5,  -- how confident we are about their location
    location_evidence       JSONB DEFAULT '[]',  -- [{type, source, article_id, date}]

    -- Professional
    journalist_type         TEXT NOT NULL DEFAULT 'unknown',
    -- freelance | staff | editor | correspondent | academic | blogger | contributor | unknown

    employment_status       TEXT,  -- active | inactive | unknown
    years_active            INTEGER,

    -- Organization
    organization_id         BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    organization_name       TEXT,
    organization_type       TEXT,  -- news_outlet | university | research_institute | NGO | government | blog | unknown

    -- Contact (public only)
    profile_url             TEXT,
    website_url             TEXT,
    twitter_handle          TEXT,
    linkedin_url            TEXT,
    email_public            TEXT,

    -- Identity resolution
    identity_confidence     DOUBLE PRECISION DEFAULT 0.5,  -- how confident we are this is one real person
    same_as                 BIGINT REFERENCES news_journalists(id) ON DELETE SET NULL,  -- merge chain
    merged_from_ids         BIGINT[] DEFAULT '{}',

    -- Counts
    article_count           INTEGER DEFAULT 0,
    topic_count             INTEGER DEFAULT 0,
    country_count           INTEGER DEFAULT 0,

    -- Signal scores
    author_page_score       DOUBLE PRECISION DEFAULT 0,   -- has dedicated author page
    byline_score            DOUBLE PRECISION DEFAULT 0,   -- appears in bylines regularly
    profile_page_score      DOUBLE PRECISION DEFAULT 0,   -- has profile page on publication
    social_score            DOUBLE PRECISION DEFAULT 0,   -- has social media presence

    -- Profile status
    profile_status          TEXT NOT NULL DEFAULT 'auto',
    -- auto | claimed | verified | suspended

    -- Topics (auto-inferred from article history)
    topics                  TEXT[] DEFAULT '{}',
    topic_scores            JSONB DEFAULT '{}',  -- {topic: score}

    -- Timestamps
    first_seen_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    article_count_updated_at TIMESTAMP WITH TIME ZONE,

    created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journalists_name      ON news_journalists USING GIN (canonical_name gin_trgm_ops);
CREATE INDEX idx_journalists_country   ON news_journalists(country);
CREATE INDEX idx_journalists_city      ON news_journalists(city);
CREATE INDEX idx_journalists_type      ON news_journalists(journalist_type);
CREATE INDEX idx_journalists_status    ON news_journalists(profile_status);
CREATE INDEX idx_journalists_org       ON news_journalists(organization_id);
CREATE INDEX idx_journalists_topics    ON news_journalists USING gin(topics);

-- Junction: article → journalist relationships
CREATE TABLE IF NOT EXISTS news_article_journalists (
    id                      BIGSERIAL PRIMARY KEY,
    article_id              BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    journalist_id           BIGINT NOT NULL REFERENCES news_journalists(id) ON DELETE CASCADE,

    -- How we found this relationship
    relationship            TEXT NOT NULL DEFAULT 'author',
    -- author | coauthor | contributor | editor | photographer | interviewer | quoted | mentioned | unknown

    -- Evidence for this assignment
    evidence_type           TEXT NOT NULL DEFAULT 'byline',
    -- byline | author_url | author_page | json_ld | signature | html_pattern | ai_inferred

    source_text             TEXT,  -- the actual byline / author string we matched
    author_url_found        TEXT,  -- /author/efosa-udinmwen/ if found
    profile_url_found       TEXT,  -- https://example.com/efosa if found
    bio_text               TEXT,  -- "Freelance journalist with 7+ years..."

    confidence              DOUBLE PRECISION DEFAULT 0.5,
    article_role            TEXT,  -- primary | secondary | mentioned

    discovered_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(article_id, journalist_id, relationship)
);

CREATE INDEX idx_aj_article    ON news_article_journalists(article_id);
CREATE INDEX idx_aj_journalist ON news_article_journalists(journalist_id);
CREATE INDEX idx_aj_rel       ON news_article_journalists(relationship);

-- Author page URLs discovered from articles (for author profile crawling)
CREATE TABLE IF NOT EXISTS news_author_urls (
    id                      BIGSERIAL PRIMARY KEY,
    journalist_id           BIGINT REFERENCES news_journalists(id) ON DELETE CASCADE,
    source_id               BIGINT REFERENCES news_sources(id) ON DELETE CASCADE,

    author_url              TEXT NOT NULL,
    author_name_text        TEXT,
    is_verified             BOOLEAN DEFAULT FALSE,
    is_active               BOOLEAN DEFAULT TRUE,
    last_checked_at         TIMESTAMP WITH TIME ZONE,
    last_article_at         TIMESTAMP WITH TIME ZONE,
    article_count           INTEGER DEFAULT 0,
    profile_response_code   INTEGER,
    profile_data_json       JSONB,

    created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(source_id, author_url)
);

CREATE INDEX idx_author_urls_journalist ON news_author_urls(journalist_id);
CREATE INDEX idx_author_urls_source     ON news_author_urls(source_id);

-- Journalist location evidence log
CREATE TABLE IF NOT EXISTS news_journalist_location_evidence (
    id                      BIGSERIAL PRIMARY KEY,
    journalist_id           BIGINT NOT NULL REFERENCES news_journalists(id) ON DELETE CASCADE,

    evidence_type           TEXT NOT NULL,
    -- byline_city | author_page | article_history | explicit_location | social | manual

    country                 TEXT,
    country_id              BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    city                    TEXT,
    city_id                 BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,

    lat                     DOUBLE PRECISION,
    lng                     DOUBLE PRECISION,

    source_article_id       BIGINT REFERENCES news_articles(id) ON DELETE CASCADE,
    source_url             TEXT,

    confidence              DOUBLE PRECISION DEFAULT 0.5,
    notes                  TEXT,
    created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_jle_journalist ON news_journalist_location_evidence(journalist_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON news_journalists                TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_article_journalists        TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_author_urls                TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_journalist_location_evidence TO xyzo_app;
