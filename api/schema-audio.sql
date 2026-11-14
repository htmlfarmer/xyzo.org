-- XYZO Audio schema — podcast/audio news ingestion layer.
-- Additive to schema-events.sql. Idempotent (IF NOT EXISTS everywhere).
-- Run after schema-events.sql and all existing migrations.

-- ─── audio_shows: podcast/show registry ─────────────────────────────────
-- One row per podcast or radio show. Corresponds to a podcast's RSS feed
-- (or equivalent audio source). Distinct from news_sources: audio_shows
-- tracks show-level metadata (title, description, artwork, language)
-- while audio_episodes tracks per-episode content.
CREATE TABLE IF NOT EXISTS audio_shows (
    id                BIGSERIAL PRIMARY KEY,
    title             TEXT NOT NULL,
    feed_url          TEXT NOT NULL UNIQUE,
    homepage_url      TEXT,
    description       TEXT,
    author            TEXT,
    author_url        TEXT,
    image_url         TEXT,
    language          TEXT,
    country           TEXT,
    region            TEXT,
    categories        TEXT[] NOT NULL DEFAULT '{}',
    -- Lifecycle
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    last_success_at   TIMESTAMPTZ,
    last_failure_at   TIMESTAMPTZ,
    error_count       INT NOT NULL DEFAULT 0,
    etag              TEXT,
    last_modified     TEXT,
    -- Statistics
    episode_count     INT NOT NULL DEFAULT 0,
    avg_episode_duration_s INT,
    -- Rights / permissions
    robots_allowed    BOOLEAN,
    rss_available     BOOLEAN,
    transcript_available BOOLEAN,
    license           TEXT,
    attribution_required BOOLEAN,
    -- Timestamps
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_shows_active_idx ON audio_shows (active) WHERE active;
CREATE INDEX IF NOT EXISTS audio_shows_country_idx ON audio_shows (country);
CREATE INDEX IF NOT EXISTS audio_shows_language_idx ON audio_shows (language);
CREATE INDEX IF NOT EXISTS audio_shows_categories_idx ON audio_shows USING GIN (categories);

DROP TRIGGER IF EXISTS audio_shows_updated_at ON audio_shows;
CREATE TRIGGER audio_shows_updated_at BEFORE UPDATE ON audio_shows
    FOR EACH ROW EXECUTE FUNCTION xyzo_set_updated_at();

-- ─── audio_episodes: individual episodes ────────────────────────────────
-- One row per podcast episode. This is the "article" equivalent for audio.
-- Episodes become news objects that can be pinned, searched, and linked.
CREATE TABLE IF NOT EXISTS audio_episodes (
    id                BIGSERIAL PRIMARY KEY,
    show_id           BIGINT NOT NULL REFERENCES audio_shows(id) ON DELETE CASCADE,
    url               TEXT NOT NULL UNIQUE,
    guid              TEXT,
    title             TEXT NOT NULL,
    description       TEXT,
    summary           TEXT,
    published_at      TIMESTAMPTZ,
    duration_seconds  INT,
    audio_url         TEXT,
    audio_type        TEXT,
    -- Image (episode-specific override of show artwork)
    image_url         TEXT,
    -- Transcript
    transcript_available BOOLEAN NOT NULL DEFAULT FALSE,
    transcript_url    TEXT,
    transcript_text   TEXT,
    -- AI-extracted fields (filled by audio_extract.py)
    location_text     TEXT,
    event_type        TEXT,
    entities          TEXT[] NOT NULL DEFAULT '{}',
    topic_tags        TEXT[] NOT NULL DEFAULT '{}',
    -- Geocoded fields
    location_id       BIGINT,
    location_confidence FLOAT,
    extracted_lat     DOUBLE PRECISION,
    extracted_lng     DOUBLE PRECISION,
    extracted_location TEXT,
    extracted_event_type TEXT,
    -- Status
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','extracted','failed','unlocated','discovered')),
    auto_categorized_at TIMESTAMPTZ,
    auto_categorize_confidence TEXT,
    auto_categorize_status TEXT,
    auto_categorize_city_id BIGINT,
    auto_categorize_city_label TEXT,
    auto_categorize_event_type TEXT,
    auto_categorize_method TEXT,
    -- People (hosts, guests, journalists)
    hosts             TEXT[] NOT NULL DEFAULT '{}',
    guests            TEXT[] NOT NULL DEFAULT '{}',
    -- Timestamps
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    extracted_at      TIMESTAMPTZ,
    geocoded_at       TIMESTAMPTZ,
    clustered_at      TIMESTAMPTZ,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_episodes_show_idx ON audio_episodes (show_id);
CREATE INDEX IF NOT EXISTS audio_episodes_status_idx ON audio_episodes (status);
CREATE INDEX IF NOT EXISTS audio_episodes_published_idx ON audio_episodes (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS audio_episodes_location_idx ON audio_episodes (location_id);
CREATE INDEX IF NOT EXISTS audio_episodes_fetched_idx ON audio_episodes (fetched_at DESC);

DROP TRIGGER IF EXISTS audio_episodes_updated_at ON audio_episodes;
CREATE TRIGGER audio_episodes_updated_at BEFORE UPDATE ON audio_episodes
    FOR EACH ROW EXECUTE FUNCTION xyzo_set_updated_at();

-- FK from audio_episodes to audio_locations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audio_episodes_location_id_fkey'
    ) THEN
        ALTER TABLE audio_episodes
            ADD CONSTRAINT audio_episodes_location_id_fkey
            FOREIGN KEY (location_id) REFERENCES news_locations(id) ON DELETE SET NULL;
    END IF;
END$$;

-- ─── audio_people: hosts, guests, journalists, researchers ──────────────
-- One row per person discovered across audio episodes.
-- Enables "who is talking about this?" queries.
CREATE TABLE IF NOT EXISTS audio_people (
    id                BIGSERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    normalized_name   TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'guest'
        CHECK (role IN ('host','guest','journalist','researcher','official','community_member','other')),
    organization      TEXT,
    bio               TEXT,
    image_url         TEXT,
    episode_count     INT NOT NULL DEFAULT 0,
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audio_people_name_role_unique UNIQUE (normalized_name, role)
);
CREATE INDEX IF NOT EXISTS audio_people_role_idx ON audio_people (role);
CREATE INDEX IF NOT EXISTS audio_people_name_idx ON audio_people (normalized_name);

DROP TRIGGER IF EXISTS audio_people_updated_at ON audio_people;
CREATE TRIGGER audio_people_updated_at BEFORE UPDATE ON audio_people
    FOR EACH ROW EXECUTE FUNCTION xyzo_set_updated_at();

-- ─── audio_episode_people: many-to-many episode ↔ person ────────────────
CREATE TABLE IF NOT EXISTS audio_episode_people (
    episode_id  BIGINT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
    person_id   BIGINT NOT NULL REFERENCES audio_people(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'guest'
        CHECK (role IN ('host','guest','journalist','researcher','official','community_member','other')),
    PRIMARY KEY (episode_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS audio_episode_people_person_idx ON audio_episode_people (person_id);

-- ─── audio_episode_topics: many-to-many episode ↔ topic ─────────────────
CREATE TABLE IF NOT EXISTS audio_episode_topics (
    episode_id BIGINT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
    topic_id   BIGINT NOT NULL REFERENCES news_topics(id) ON DELETE CASCADE,
    PRIMARY KEY (episode_id, topic_id)
);

-- ─── audio_episode_entities: named entities per episode ─────────────────
CREATE TABLE IF NOT EXISTS audio_episode_entities (
    episode_id BIGINT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
    entity_id  BIGINT NOT NULL REFERENCES news_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (episode_id, entity_id)
);

-- ─── audio_claims: factual claims extracted from episodes ───────────────
-- Each claim is a verifiable statement from an episode.
CREATE TABLE IF NOT EXISTS audio_claims (
    id                BIGSERIAL PRIMARY KEY,
    episode_id        BIGINT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
    claim_text        TEXT NOT NULL,
    speaker           TEXT,
    confidence        FLOAT CHECK (confidence BETWEEN 0.0 AND 1.0),
    verified          BOOLEAN,
    verified_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_claims_episode_idx ON audio_claims (episode_id);

-- ─── audio_topics: topic taxonomy for audio ─────────────────────────────
-- Separate from news_topics to allow audio-specific topic tracking.
-- Audio might cover topics that text news doesn't (e.g., "ASMR",
-- "meditation", "interview", "call-in", "panel discussion").
CREATE TABLE IF NOT EXISTS audio_topics (
    id     BIGSERIAL PRIMARY KEY,
    slug   TEXT NOT NULL UNIQUE,
    label  TEXT NOT NULL
);

-- Seed audio-specific topics
INSERT INTO audio_topics (slug, label) VALUES
    ('news', 'News'),
    ('politics', 'Politics'),
    ('business', 'Business'),
    ('technology', 'Technology'),
    ('ai', 'AI'),
    ('science', 'Science'),
    ('health', 'Health'),
    ('environment', 'Environment'),
    ('culture', 'Culture'),
    ('sports', 'Sports'),
    ('crime', 'Crime'),
    ('conflict', 'Conflict'),
    ('disaster', 'Disaster'),
    ('humanitarian', 'Humanitarian'),
    ('education', 'Education'),
    ('religion', 'Religion'),
    ('spirituality', 'Spirituality'),
    ('philosophy', 'Philosophy'),
    ('history', 'History'),
    ('travel', 'Travel'),
    ('food', 'Food'),
    ('design', 'Design'),
    ('music', 'Music'),
    ('art', 'Art'),
    ('film', 'Film'),
    ('literature', 'Literature'),
    ('comedy', 'Comedy'),
    ('documentary', 'Documentary'),
    ('interview', 'Interview'),
    ('panel', 'Panel Discussion'),
    ('call_in', 'Call-in'),
    ('narrative', 'Narrative'),
    ('daily_brief', 'Daily Brief'),
    ('breaking', 'Breaking News'),
    ('analysis', 'Analysis'),
    ('investigation', 'Investigation'),
    ('space', 'Space'),
    ('astronomy', 'Astronomy'),
    ('cybersecurity', 'Cybersecurity'),
    ('energy', 'Energy'),
    ('climate', 'Climate'),
    ('ocean', 'Ocean'),
    ('marine', 'Marine'),
    ('indigenous', 'Indigenous'),
    ('local', 'Local'),
    ('regional', 'Regional'),
    ('hyperlocal', 'Hyperlocal'),
    ('other', 'Other')
ON CONFLICT (slug) DO NOTHING;

-- ─── audio_places: geographic references in audio ───────────────────────
-- Many-to-many: episodes can discuss multiple places.
CREATE TABLE IF NOT EXISTS audio_episode_locations (
    episode_id  BIGINT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
    location_id BIGINT NOT NULL REFERENCES news_locations(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'mentioned'
        CHECK (role IN ('primary','mentioned','origin','destination')),
    PRIMARY KEY (episode_id, location_id, role)
);
CREATE INDEX IF NOT EXISTS audio_episode_locations_loc_idx ON audio_episode_locations (location_id);

-- ─── Views for cross-modal queries ──────────────────────────────────────
-- This view joins audio_episodes with their shows for convenient queries.
CREATE OR REPLACE VIEW audio_episodes_enriched AS
SELECT
    e.id,
    e.show_id,
    e.url,
    e.title,
    e.description,
    e.summary,
    e.published_at,
    e.duration_seconds,
    e.audio_url,
    e.image_url,
    e.transcript_available,
    e.location_text,
    e.event_type,
    e.entities,
    e.topic_tags,
    e.location_id,
    e.location_confidence,
    e.extracted_lat,
    e.extracted_lng,
    e.extracted_location,
    e.status,
    e.hosts,
    e.guests,
    e.fetched_at,
    s.title AS show_title,
    s.author AS show_author,
    s.image_url AS show_image_url,
    s.language AS show_language,
    s.country AS show_country,
    s.categories AS show_categories,
    l.place_name,
    l.lat AS location_lat,
    l.lng AS location_lng,
    l.country AS location_country
FROM audio_episodes e
JOIN audio_shows s ON s.id = e.show_id
LEFT JOIN news_locations l ON l.id = e.location_id;

-- ─── Stats view for "Audio Around Here" ─────────────────────────────────
-- Aggregates episode topics by location for the map sidebar.
CREATE OR REPLACE VIEW audio_location_topics AS
SELECT
    l.id AS location_id,
    l.place_name,
    l.country,
    at.slug AS topic_slug,
    at.label AS topic_label,
    COUNT(DISTINCT e.id) AS episode_count,
    MAX(e.published_at) AS latest_episode_at
FROM audio_episodes e
JOIN news_locations l ON l.id = e.location_id
JOIN audio_episode_topics eat ON eat.episode_id = e.id
JOIN audio_topics at ON at.id = eat.topic_id
WHERE e.status != 'failed'
GROUP BY l.id, l.place_name, l.country, at.slug, at.label;

COMMENT ON TABLE audio_shows IS 'Podcast and radio show registry — one row per show/feed';
COMMENT ON TABLE audio_episodes IS 'Individual episodes — the audio equivalent of news_articles';
COMMENT ON TABLE audio_people IS 'People discovered in audio (hosts, guests, journalists)';
COMMENT ON TABLE audio_claims IS 'Factual claims extracted from episode transcripts';
COMMENT ON TABLE audio_topics IS 'Audio-specific topic taxonomy';
