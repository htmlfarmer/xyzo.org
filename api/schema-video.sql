-- XYZO Video schema — video news ingestion layer.
-- Additive to schema-events.sql and schema-audio.sql. Idempotent (IF NOT EXISTS everywhere).
-- Run after schema-events.sql, schema-audio.sql, and all existing migrations.
--
-- Architecture mirrors audio_shows/audio_episodes but adapted for video:
--   video_channels  ↔ audio_shows   (source/channel registry)
--   video_items     ↔ audio_episodes (individual videos)
--   video_people    ↔ audio_people  (speakers, journalists, officials)
--   Plus cross-modal: video ↔ articles, video ↔ audio, video ↔ events

-- ─── video_channels: channel/publisher registry ────────────────────────
-- One row per video channel (YouTube, broadcaster, creator, etc).
-- Corresponds to a YouTube channel, broadcaster page, or video source.
CREATE TABLE IF NOT EXISTS video_channels (
    id                BIGSERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    platform          TEXT NOT NULL DEFAULT 'youtube'
        CHECK (platform IN ('youtube','vimeo','website','rss','tiktok','dailymotion','rumble')),
    channel_id        TEXT,                   -- YouTube channel ID (UC...)
    channel_url       TEXT NOT NULL,
    website_url       TEXT,
    feed_url          TEXT,                   -- RSS feed URL if available
    description       TEXT,
    country           TEXT,
    region            TEXT NOT NULL DEFAULT 'global',
    languages         TEXT[] NOT NULL DEFAULT '{}',
    categories        TEXT[] NOT NULL DEFAULT '{}',
    source_type       TEXT NOT NULL DEFAULT 'broadcaster'
        CHECK (source_type IN (
            'broadcaster','newspaper','creator','government',
            'university','agency','NGO','local_tv','independent',
            'documentary','science','corporate','community'
        )),
    -- YouTube-specific
    subscriber_count  INT,
    video_count       INT,
    -- Permissions / indexing
    transcript_available BOOLEAN,
    captions_available   BOOLEAN,
    shorts_available     BOOLEAN,
    livestream_available BOOLEAN,
    embed_allowed        BOOLEAN NOT NULL DEFAULT TRUE,
    indexing_allowed     BOOLEAN,
    -- Content flags
    local_news       BOOLEAN NOT NULL DEFAULT FALSE,
    investigative    BOOLEAN NOT NULL DEFAULT FALSE,
    documentary      BOOLEAN NOT NULL DEFAULT FALSE,
    science          BOOLEAN NOT NULL DEFAULT FALSE,
    business         BOOLEAN NOT NULL DEFAULT FALSE,
    politics         BOOLEAN NOT NULL DEFAULT FALSE,
    culture          BOOLEAN NOT NULL DEFAULT FALSE,
    sports           BOOLEAN NOT NULL DEFAULT FALSE,
    tech             BOOLEAN NOT NULL DEFAULT FALSE,
    climate          BOOLEAN NOT NULL DEFAULT FALSE,
    -- Quality
    language_score   FLOAT,                  -- 0.0-1.0 quality rating
    reliability_score FLOAT,
    geographic_coverage TEXT,                 -- 'local','regional','national','global'
    -- Lifecycle
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_checked_at  TIMESTAMPTZ,
    last_video_at    TIMESTAMPTZ,
    robots_status    TEXT,
    terms_status     TEXT,
    -- Lease system (same pattern as news_sources/audio_shows)
    fetch_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
    lease_token       TEXT,
    lease_expires_at  TIMESTAMPTZ,
    etag              TEXT,
    last_modified     TEXT,
    last_success_at   TIMESTAMPTZ,
    last_failure_at   TIMESTAMPTZ,
    error_count       INT NOT NULL DEFAULT 0,
    -- Timestamps
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_channels_active_idx ON video_channels (active) WHERE active;
CREATE INDEX IF NOT EXISTS video_channels_country_idx ON video_channels (country);
CREATE INDEX IF NOT EXISTS video_channels_region_idx ON video_channels (region);
CREATE INDEX IF NOT EXISTS video_channels_platform_idx ON video_channels (platform);
CREATE INDEX IF NOT EXISTS video_channels_categories_idx ON video_channels USING GIN (categories);
CREATE INDEX IF NOT EXISTS video_channels_languages_idx ON video_channels USING GIN (languages);
CREATE UNIQUE INDEX IF NOT EXISTS video_channels_channel_id_key ON video_channels (channel_id, platform)
    WHERE channel_id IS NOT NULL;

DROP TRIGGER IF EXISTS video_channels_updated_at ON video_channels;
CREATE TRIGGER video_channels_updated_at BEFORE UPDATE ON video_channels
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ─── video_items: individual videos ────────────────────────────────────
-- One row per video. This is the "article" equivalent for video.
-- Videos become news objects that can be pinned, searched, and linked.
CREATE TABLE IF NOT EXISTS video_items (
    id                BIGSERIAL PRIMARY KEY,
    channel_id        BIGINT NOT NULL REFERENCES video_channels(id) ON DELETE CASCADE,
    video_id          TEXT NOT NULL,           -- YouTube video ID, or platform-specific ID
    platform          TEXT NOT NULL DEFAULT 'youtube',
    url               TEXT NOT NULL UNIQUE,
    title             TEXT NOT NULL,
    description       TEXT,
    summary           TEXT,                   -- AI-generated summary
    published_at      TIMESTAMPTZ,
    duration_seconds  INT,
    -- Video media
    thumbnail_url     TEXT,
    embed_url         TEXT,                   -- embeddable player URL
    hq_url            TEXT,                   -- high quality URL
    -- Content classification
    video_type        TEXT NOT NULL DEFAULT 'news_report'
        CHECK (video_type IN (
            'news_report','live_news','interview','press_conference',
            'documentary','explainer','investigation','field_report',
            'eyewitness','citizen_video','video_podcast','lecture',
            'conference','government_video','science_video',
            'weather','disaster','sports_news','culture',
            'travel','food','tech','business','religion','community',
            'other'
        )),
    -- Transcript
    transcript_available BOOLEAN NOT NULL DEFAULT FALSE,
    transcript_url    TEXT,                   -- auto-sub URL from YouTube
    transcript_text   TEXT,                   -- full transcript text
    -- AI-extracted fields
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
    -- Video-specific AI fields
    speakers          TEXT[] NOT NULL DEFAULT '{}',  -- people speaking in video
    keyframes         JSONB,                  -- [{timestamp_s, description, ocr_text}]
    scene_changes     JSONB,                  -- [{timestamp_s, confidence}]
    claims            JSONB,                  -- [{text, speaker, confidence}]
    -- YouTube-specific engagement metrics
    view_count        BIGINT,
    like_count        BIGINT,
    comment_count     INT,
    -- Status
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','transcribed','extracted','failed','unlocated','discovered')),
    auto_categorized_at TIMESTAMPTZ,
    auto_categorize_confidence TEXT,
    auto_categorize_status TEXT,
    auto_categorize_city_id BIGINT,
    auto_categorize_city_label TEXT,
    auto_categorize_event_type TEXT,
    auto_categorize_method TEXT,
    -- Timestamps
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    transcribed_at    TIMESTAMPTZ,
    extracted_at      TIMESTAMPTZ,
    geocoded_at       TIMESTAMPTZ,
    clustered_at      TIMESTAMPTZ,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_items_channel_idx ON video_items (channel_id);
CREATE INDEX IF NOT EXISTS video_items_status_idx ON video_items (status);
CREATE INDEX IF NOT EXISTS video_items_published_idx ON video_items (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS video_items_location_idx ON video_items (location_id);
CREATE INDEX IF NOT EXISTS video_items_fetched_idx ON video_items (fetched_at DESC);
CREATE INDEX IF NOT EXISTS video_items_video_id_idx ON video_items (video_id, platform);
CREATE INDEX IF NOT EXISTS video_items_video_type_idx ON video_items (video_type);

DROP TRIGGER IF EXISTS video_items_updated_at ON video_items;
CREATE TRIGGER video_items_updated_at BEFORE UPDATE ON video_items
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- FK from video_items to news_locations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'video_items_location_id_fkey'
    ) THEN
        ALTER TABLE video_items
            ADD CONSTRAINT video_items_location_id_fkey
            FOREIGN KEY (location_id) REFERENCES news_locations(id) ON DELETE SET NULL;
    END IF;
END$$;

-- ─── video_people: speakers, journalists, officials ────────────────────
-- One row per person discovered across videos.
-- Enables "who is talking about this?" queries.
CREATE TABLE IF NOT EXISTS video_people (
    id                BIGSERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    normalized_name   TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'speaker'
        CHECK (role IN ('speaker','journalist','official','researcher',
                        'interviewee','host','analyst','activist','other')),
    organization      TEXT,
    bio               TEXT,
    image_url         TEXT,
    video_count       INT NOT NULL DEFAULT 0,
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT video_people_name_role_unique UNIQUE (normalized_name, role)
);
CREATE INDEX IF NOT EXISTS video_people_role_idx ON video_people (role);
CREATE INDEX IF NOT EXISTS video_people_name_idx ON video_people (normalized_name);

DROP TRIGGER IF EXISTS video_people_updated_at ON video_people;
CREATE TRIGGER video_people_updated_at BEFORE UPDATE ON video_people
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ─── video_item_people: many-to-many video ↔ person ────────────────────
CREATE TABLE IF NOT EXISTS video_item_people (
    video_id    BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    person_id   BIGINT NOT NULL REFERENCES video_people(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'speaker'
        CHECK (role IN ('speaker','journalist','official','researcher',
                        'interviewee','host','analyst','activist','other')),
    PRIMARY KEY (video_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS video_item_people_person_idx ON video_item_people (person_id);

-- ─── video_item_topics: many-to-many video ↔ topic ─────────────────────
CREATE TABLE IF NOT EXISTS video_item_topics (
    video_id BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    topic_id BIGINT NOT NULL REFERENCES news_topics(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, topic_id)
);

-- ─── video_item_entities: named entities per video ─────────────────────
CREATE TABLE IF NOT EXISTS video_item_entities (
    video_id  BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    entity_id BIGINT NOT NULL REFERENCES news_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, entity_id)
);

-- ─── video_item_locations: geographic references in videos ──────────────
CREATE TABLE IF NOT EXISTS video_item_locations (
    video_id    BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    location_id BIGINT NOT NULL REFERENCES news_locations(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'mentioned'
        CHECK (role IN ('primary','mentioned','origin','destination')),
    PRIMARY KEY (video_id, location_id, role)
);
CREATE INDEX IF NOT EXISTS video_item_locations_loc_idx ON video_item_locations (location_id);

-- ─── video_claims: factual claims extracted from videos ────────────────
-- Each claim is a verifiable statement from a video.
CREATE TABLE IF NOT EXISTS video_claims (
    id                BIGSERIAL PRIMARY KEY,
    video_id          BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    claim_text        TEXT NOT NULL,
    speaker           TEXT,
    timestamp_seconds INT,                   -- when in the video the claim occurs
    confidence        FLOAT CHECK (confidence BETWEEN 0.0 AND 1.0),
    verified          BOOLEAN,
    verified_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_claims_video_idx ON video_claims (video_id);

-- ─── video_topics: topic taxonomy for video ────────────────────────────
CREATE TABLE IF NOT EXISTS video_topics (
    id     BIGSERIAL PRIMARY KEY,
    slug   TEXT NOT NULL UNIQUE,
    label  TEXT NOT NULL
);

-- Seed video-specific topics
INSERT INTO video_topics (slug, label) VALUES
    ('news', 'News'),
    ('breaking', 'Breaking News'),
    ('politics', 'Politics'),
    ('business', 'Business'),
    ('technology', 'Technology'),
    ('ai', 'AI'),
    ('science', 'Science'),
    ('health', 'Health'),
    ('environment', 'Environment'),
    ('climate', 'Climate'),
    ('culture', 'Culture'),
    ('sports', 'Sports'),
    ('crime', 'Crime'),
    ('conflict', 'Conflict'),
    ('disaster', 'Disaster'),
    ('humanitarian', 'Humanitarian'),
    ('education', 'Education'),
    ('religion', 'Religion'),
    ('travel', 'Travel'),
    ('food', 'Food'),
    ('design', 'Design'),
    ('music', 'Music'),
    ('art', 'Art'),
    ('film', 'Film'),
    ('literature', 'Literature'),
    ('documentary', 'Documentary'),
    ('interview', 'Interview'),
    ('investigation', 'Investigation'),
    ('explainer', 'Explainer'),
    ('press_conference', 'Press Conference'),
    ('government', 'Government'),
    ('parliament', 'Parliament'),
    ('debate', 'Debate'),
    ('lecture', 'Lecture'),
    ('conference', 'Conference'),
    ('space', 'Space'),
    ('astronomy', 'Astronomy'),
    ('cybersecurity', 'Cybersecurity'),
    ('energy', 'Energy'),
    ('ocean', 'Ocean'),
    ('agriculture', 'Agriculture'),
    ('indigenous', 'Indigenous'),
    ('local', 'Local'),
    ('regional', 'Regional'),
    ('eyewitness', 'Eyewitness'),
    ('citizen', 'Citizen Video'),
    ('weather', 'Weather'),
    ('earthquake', 'Earthquake'),
    ('volcano', 'Volcano'),
    ('hurricane', 'Hurricane'),
    ('flood', 'Flood'),
    ('fire', 'Fire'),
    ('drought', 'Drought'),
    ('other', 'Other')
ON CONFLICT (slug) DO NOTHING;

-- ─── Cross-modal: video ↔ article matching ─────────────────────────────
-- When a video covers the same story as an article, record the match.
CREATE TABLE IF NOT EXISTS video_article_matches (
    video_id      BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    article_id    BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    similarity    FLOAT NOT NULL,            -- 0.0-1.0 embedding similarity
    same_event    BOOLEAN NOT NULL DEFAULT FALSE,
    same_location BOOLEAN NOT NULL DEFAULT FALSE,
    same_people   BOOLEAN NOT NULL DEFAULT FALSE,
    same_orgs     BOOLEAN NOT NULL DEFAULT FALSE,
    matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, article_id)
);
CREATE INDEX IF NOT EXISTS video_article_matches_article_idx ON video_article_matches (article_id);
CREATE INDEX IF NOT EXISTS video_article_matches_similarity_idx ON video_article_matches (similarity DESC);

-- ─── Cross-modal: video ↔ audio matching ───────────────────────────────
CREATE TABLE IF NOT EXISTS video_audio_matches (
    video_id    BIGINT NOT NULL REFERENCES video_items(id) ON DELETE CASCADE,
    audio_id    BIGINT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
    similarity  FLOAT NOT NULL,
    matched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, audio_id)
);

-- ─── Cross-modal: video ↔ event linking ────────────────────────────────
-- Videos linked to clustered news events (via event_id).
-- This is populated by the clustering step, same as articles.
ALTER TABLE video_items ADD COLUMN IF NOT EXISTS event_id BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'video_items_event_id_fkey'
    ) THEN
        ALTER TABLE video_items
            ADD CONSTRAINT video_items_event_id_fkey
            FOREIGN KEY (event_id) REFERENCES news_events(id) ON DELETE SET NULL;
    END IF;
END$$;

-- ─── Views for cross-modal queries ──────────────────────────────────────
-- Enriched view: video_items + channel metadata + location
CREATE OR REPLACE VIEW video_items_enriched AS
SELECT
    v.id,
    v.channel_id,
    v.video_id,
    v.platform,
    v.url,
    v.title,
    v.description,
    v.summary,
    v.published_at,
    v.duration_seconds,
    v.thumbnail_url,
    v.embed_url,
    v.video_type,
    v.transcript_available,
    v.transcript_text,
    v.location_text,
    v.event_type,
    v.entities,
    v.topic_tags,
    v.location_id,
    v.location_confidence,
    v.extracted_lat,
    v.extracted_lng,
    v.extracted_location,
    v.speakers,
    v.view_count,
    v.like_count,
    v.status,
    v.event_id,
    c.name AS channel_name,
    c.platform AS channel_platform,
    c.country AS channel_country,
    c.region AS channel_region,
    c.languages AS channel_languages,
    c.source_type AS channel_source_type,
    c.categories AS channel_categories,
    l.place_name,
    l.lat AS location_lat,
    l.lng AS location_lng,
    l.country AS location_country
FROM video_items v
JOIN video_channels c ON c.id = v.channel_id
LEFT JOIN news_locations l ON l.id = v.location_id;

-- Stats view: video topics by location (for "Video Around Here" map)
CREATE OR REPLACE VIEW video_location_topics AS
SELECT
    l.id AS location_id,
    l.place_name,
    l.country,
    vt.slug AS topic_slug,
    vt.label AS topic_label,
    COUNT(DISTINCT v.id) AS video_count,
    MAX(v.published_at) AS latest_video_at
FROM video_items v
JOIN news_locations l ON l.id = v.location_id
JOIN video_item_topics vit ON vit.video_id = v.id
JOIN video_topics vt ON vt.id = vit.topic_id
WHERE v.status != 'failed'
GROUP BY l.id, l.place_name, l.country, vt.slug, vt.label;

-- Channel stats view: per-channel ingestion health
CREATE OR REPLACE VIEW video_channel_stats AS
SELECT
    c.id,
    c.name,
    c.platform,
    c.country,
    c.region,
    c.active,
    COUNT(v.id) AS total_videos,
    COUNT(v.id) FILTER (WHERE v.status = 'extracted') AS extracted_videos,
    COUNT(v.id) FILTER (WHERE v.status = 'failed') AS failed_videos,
    COUNT(v.id) FILTER (WHERE v.published_at > now() - INTERVAL '7 days') AS videos_last_7d,
    MAX(v.published_at) AS latest_video_at,
    c.last_success_at,
    c.last_failure_at,
    c.error_count
FROM video_channels c
LEFT JOIN video_items v ON v.channel_id = c.id
GROUP BY c.id, c.name, c.platform, c.country, c.region,
         c.active, c.last_success_at, c.last_failure_at, c.error_count;

-- ─── Comments ──────────────────────────────────────────────────────────
COMMENT ON TABLE video_channels IS 'Video channel/publisher registry — one row per channel';
COMMENT ON TABLE video_items IS 'Individual videos — the video equivalent of news_articles';
COMMENT ON TABLE video_people IS 'People discovered in videos (speakers, journalists, officials)';
COMMENT ON TABLE video_claims IS 'Factual claims extracted from video transcripts';
COMMENT ON TABLE video_topics IS 'Video-specific topic taxonomy';
COMMENT ON TABLE video_article_matches IS 'Cross-modal: video ↔ article similarity matches';
COMMENT ON TABLE video_audio_matches IS 'Cross-modal: video ↔ audio similarity matches';
