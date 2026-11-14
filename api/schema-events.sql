-- Newsium event-centric schema. Additive to schema.sql. Idempotent.
-- Designed for idempotent re-runs during development.

-- ─── news_sources: feed registry ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_sources (
    id                BIGSERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    feed_url          TEXT NOT NULL UNIQUE,
    country           TEXT,
    language          TEXT,
    region            TEXT,
    source_type       TEXT NOT NULL DEFAULT 'rss'
        CHECK (source_type IN ('rss','atom','geojson','scrape')),
    poll_interval_s   INT NOT NULL DEFAULT 900,
    etag              TEXT,
    last_modified     TEXT,
    last_success_at   TIMESTAMPTZ,
    last_failure_at   TIMESTAMPTZ,
    error_count       INT NOT NULL DEFAULT 0,
    reliability_score FLOAT NOT NULL DEFAULT 1.0
        CHECK (reliability_score BETWEEN 0.0 AND 1.0),
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    robots_blocked_at TIMESTAMPTZ,
    robots_block_path TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_sources_active_idx ON news_sources (active) WHERE active;
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS robots_blocked_at TIMESTAMPTZ;
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS robots_block_path TEXT;

DROP TRIGGER IF EXISTS news_sources_updated_at ON news_sources;
CREATE TRIGGER news_sources_updated_at BEFORE UPDATE ON news_sources
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ─── news_articles: raw fetched items ────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_articles (
    id              BIGSERIAL PRIMARY KEY,
    source_id       BIGINT NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    guid            TEXT,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    summary         TEXT,
    published_at    TIMESTAMPTZ,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','extracted','failed','unlocated')),
    -- AI-extracted fields (filled by extract.py)
    location_text   TEXT,
    event_type      TEXT,
    entities        TEXT[] NOT NULL DEFAULT '{}',
    topic_tags      TEXT[] NOT NULL DEFAULT '{}',
    -- Geocoded fields (filled by geocode.py)
    location_id     BIGINT,
    location_confidence FLOAT,
    error_message   TEXT,
    extracted_at    TIMESTAMPTZ,
    geocoded_at     TIMESTAMPTZ,
    clustered_at    TIMESTAMPTZ,
    CONSTRAINT news_articles_url_source_unique UNIQUE (url, source_id)
);
CREATE INDEX IF NOT EXISTS news_articles_source_idx     ON news_articles (source_id);
CREATE INDEX IF NOT EXISTS news_articles_status_idx     ON news_articles (status);
CREATE INDEX IF NOT EXISTS news_articles_published_idx  ON news_articles (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS news_articles_location_idx   ON news_articles (location_id);

-- ─── news_locations: geocoded places ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_locations (
    id                      BIGSERIAL PRIMARY KEY,
    place_name              TEXT NOT NULL,
    place_name_normalized   TEXT NOT NULL,
    country                 TEXT,
    lat                     DOUBLE PRECISION NOT NULL,
    lng                     DOUBLE PRECISION NOT NULL,
    precision               TEXT NOT NULL DEFAULT 'city'
        CHECK (precision IN ('exact','city','region','country')),
    confidence              FLOAT NOT NULL DEFAULT 1.0
        CHECK (confidence BETWEEN 0.0 AND 1.0),
    osm_id                  BIGINT,
    osm_type                TEXT,
    geom                    GEOGRAPHY(POINT, 4326) NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT news_locations_lng_range CHECK (lng BETWEEN -180 AND 180),
    CONSTRAINT news_locations_lat_range CHECK (lat BETWEEN -90 AND 90)
);
CREATE INDEX IF NOT EXISTS news_locations_geom_idx   ON news_locations USING GIST (geom);
CREATE INDEX IF NOT EXISTS news_locations_norm_idx   ON news_locations (place_name_normalized);
CREATE INDEX IF NOT EXISTS news_locations_country_idx ON news_locations (country);

-- Lat/lng rounded to 3 decimals (~110m) for dedup; same place reuses same row.
CREATE UNIQUE INDEX IF NOT EXISTS news_locations_dedup
    ON news_locations (place_name_normalized, ROUND(lat::numeric, 3), ROUND(lng::numeric, 3));

-- ─── news_topics: taxonomy tags ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_topics (
    id     BIGSERIAL PRIMARY KEY,
    slug   TEXT NOT NULL UNIQUE,
    label  TEXT NOT NULL
);

-- ─── news_entities: named entities (people, orgs) ────────────────────────
CREATE TABLE IF NOT EXISTS news_entities (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL
        CHECK (type IN ('person','organization','place','event','other')),
    wikidata_id   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT news_entities_unique UNIQUE (name, type)
);
CREATE INDEX IF NOT EXISTS news_entities_type_idx ON news_entities (type);

-- ─── news_events: clustered events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_events (
    id                  BIGSERIAL PRIMARY KEY,
    primary_location_id BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    event_type          TEXT NOT NULL DEFAULT 'other',
    headline            TEXT NOT NULL,
    summary             TEXT,
    occurred_at         TIMESTAMPTZ,
    first_reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_count        INT NOT NULL DEFAULT 0,
    avg_confidence      FLOAT NOT NULL DEFAULT 0.0,
    status              TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','superseded','hidden')),
    -- Relevance decay: when should this event stop showing on the map?
    -- Defaults set per event_type by the clusterer; AI may override later.
    relevance_days      INT NOT NULL DEFAULT 7,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent column adds for migrations on existing tables
ALTER TABLE news_events ADD COLUMN IF NOT EXISTS relevance_days INT NOT NULL DEFAULT 7;
ALTER TABLE news_events ADD COLUMN IF NOT EXISTS expires_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS news_events_location_idx    ON news_events (primary_location_id);
CREATE INDEX IF NOT EXISTS news_events_occurred_idx    ON news_events (occurred_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS news_events_first_reported  ON news_events (first_reported_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS news_events_type_idx        ON news_events (event_type);
CREATE INDEX IF NOT EXISTS news_events_status_idx      ON news_events (status) WHERE status = 'active';

DROP TRIGGER IF EXISTS news_events_updated_at ON news_events;
CREATE TRIGGER news_events_updated_at BEFORE UPDATE ON news_events
    FOR EACH ROW EXECUTE FUNCTION newsium_set_updated_at();

-- ─── news_event_sources: many-to-many event ↔ article ───────────────────
CREATE TABLE IF NOT EXISTS news_event_sources (
    event_id     BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    article_id   BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, article_id)
);
CREATE INDEX IF NOT EXISTS news_event_sources_article_idx ON news_event_sources (article_id);

-- ─── news_event_locations: places tied to an event ───────────────────────
CREATE TABLE IF NOT EXISTS news_event_locations (
    event_id     BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    location_id  BIGINT NOT NULL REFERENCES news_locations(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'mentioned'
        CHECK (role IN ('primary','mentioned','origin','destination')),
    PRIMARY KEY (event_id, location_id, role)
);
CREATE INDEX IF NOT EXISTS news_event_locations_loc_idx ON news_event_locations (location_id);

-- ─── news_event_entities: entities tied to an event ──────────────────────
CREATE TABLE IF NOT EXISTS news_event_entities (
    event_id   BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    entity_id  BIGINT NOT NULL REFERENCES news_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, entity_id)
);

-- ─── news_event_topics: topics tied to an event ──────────────────────────
CREATE TABLE IF NOT EXISTS news_event_topics (
    event_id  BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    topic_id  BIGINT NOT NULL REFERENCES news_topics(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, topic_id)
);

CREATE TABLE IF NOT EXISTS news_article_topics (
    article_id BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    topic_id   BIGINT NOT NULL REFERENCES news_topics(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, topic_id)
);

-- ─── seed default topics ─────────────────────────────────────────────────
INSERT INTO news_topics (slug, label) VALUES
    ('politics',   'Politics'),
    ('business',   'Business'),
    ('crime',      'Crime'),
    ('weather',    'Weather'),
    ('science',    'Science'),
    ('technology', 'Technology'),
    ('sports',     'Sports'),
    ('culture',    'Culture'),
    ('environment','Environment'),
    ('conflict',   'Conflict'),
    ('health',     'Health'),
    ('disaster',   'Disaster'),
    ('humanitarian','Humanitarian'),
    ('other',      'Other')
ON CONFLICT (slug) DO NOTHING;

-- FK constraint from news_articles.location_id → news_locations (added after both tables exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'news_articles_location_id_fkey'
    ) THEN
        ALTER TABLE news_articles
            ADD CONSTRAINT news_articles_location_id_fkey
            FOREIGN KEY (location_id) REFERENCES news_locations(id) ON DELETE SET NULL;
    END IF;
END$$;
