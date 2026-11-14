-- ── 2026-09-06-events-relational.sql ──────────────────────────────────
--
-- Per the user's graph sketch (2026-09-06):
--
--   EVENT → VENUE  → CITY  → COUNTRY
--   EVENT → ORGANIZER → WEBSITE
--   EVENT → PERSON  → COMPANY
--   EVENT → TOPIC   → OTHER EVENTS
--
-- And the URL-pattern discovery list (also 2026-09-06):
--
--   site:example.com/events | /event | /calendar | /conference
--   site:example.com/festival | /meetup | /workshop | /seminar
--   site:example.com/lecture | /program | /whats-on | /upcoming
--
-- The previous migration extended upcoming_events with the flat fields
-- the user listed (event_id, title, description, event_type, category,
-- subcategory, start_datetime, end_datetime, timezone, …). This one
-- adds the relationship graph as separate, normalised tables so the
-- system can answer questions like:
--
--   * "Show me every event at the same venue as X"
--   * "What other events has this organizer hosted in any city?"
--   * "Every event where Alice was a speaker"
--   * "Every event tagged 'climate' in any country"
--   * "Given a host we just discovered, which of the 12 standard URL
--      patterns should we probe first?"
--
-- upcoming_events keeps its denormalised columns (city, country_code,
-- lat, lng, organizer_name, …) for query speed and resilience. The
-- new normalised rows are best-effort enrichment, populated when we
-- can identify a record by name/url.
--
-- Idempotent. Safe to run live.

BEGIN;

-- ── venues ──────────────────────────────────────────────────────────
-- One row per physical venue (a building, a park, a stadium). Distinct
-- from a city; the same venue can host events in different cities if
-- we get the geo wrong, and the same city has many venues.
CREATE TABLE IF NOT EXISTS venues (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL,            -- 'madison-square-garden'
    address      TEXT,
    city_id      BIGINT,                   -- FK → cities (added later if table exists)
    city_name    TEXT,                     -- denormalised for fast list views
    region       TEXT,
    country      TEXT,
    country_code TEXT,
    postal_code  TEXT,
    lat          DOUBLE PRECISION,
    lng          DOUBLE PRECISION,
    geog         GEOGRAPHY(Point, 4326),
    website_url  TEXT,
    phone        TEXT,
    capacity     INTEGER,
    source       TEXT NOT NULL DEFAULT 'user', -- 'rss' | 'eventbrite' | 'user' | 'osm'
    source_id    TEXT,                     -- opaque per-source id
    source_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT venues_slug_unique UNIQUE (slug),
    CONSTRAINT venues_source_key UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS venues_city_name_idx
    ON venues (lower(city_name));

CREATE INDEX IF NOT EXISTS venues_geo_idx
    ON venues USING gist (geog)
    WHERE geog IS NOT NULL;

CREATE INDEX IF NOT EXISTS venues_country_idx
    ON venues (country_code)
    WHERE country_code IS NOT NULL;

-- ── organizers ─────────────────────────────────────────────────────
-- An organization (or individual) that hosts events. Distinct from a
-- venue: the organizer runs events; the venue hosts them.
CREATE TABLE IF NOT EXISTS organizers (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL,
    website_url  TEXT,
    domain       TEXT,                     -- extracted from website_url, used for grouping
    kind         TEXT NOT NULL DEFAULT 'organization', -- 'organization' | 'individual' | 'government' | 'university' | 'community'
    description  TEXT,
    logo_url     TEXT,
    contact_email TEXT,
    country_code TEXT,
    source       TEXT NOT NULL DEFAULT 'user',
    source_id    TEXT,
    source_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT organizers_slug_unique UNIQUE (slug),
    CONSTRAINT organizers_source_key UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS organizers_domain_idx
    ON organizers (domain)
    WHERE domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS organizers_kind_idx
    ON organizers (kind)
    WHERE kind IS NOT NULL;

-- ── people ─────────────────────────────────────────────────────────
-- Speakers, artists, performers. Linked to events through link tables
-- (event_speakers, event_artists, event_performers).
CREATE TABLE IF NOT EXISTS people (
    id           BIGSERIAL PRIMARY KEY,
    full_name    TEXT NOT NULL,
    slug         TEXT NOT NULL,
    bio          TEXT,
    company_id   BIGINT,                   -- FK → companies
    website_url  TEXT,
    avatar_url   TEXT,
    twitter      TEXT,
    linkedin     TEXT,
    wikipedia_url TEXT,
    source       TEXT NOT NULL DEFAULT 'user',
    source_id    TEXT,
    source_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT people_slug_unique UNIQUE (slug),
    CONSTRAINT people_source_key UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS people_company_idx
    ON people (company_id)
    WHERE company_id IS NOT NULL;

-- ── companies ──────────────────────────────────────────────────────
-- A company/organisation that a person is affiliated with. Distinct
-- from `organizers` (which is event-host-centric).
CREATE TABLE IF NOT EXISTS companies (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL,
    website_url  TEXT,
    domain       TEXT,
    industry     TEXT,
    size         TEXT,                     -- 'startup' | 'mid' | 'large'
    logo_url     TEXT,
    country_code TEXT,
    source       TEXT NOT NULL DEFAULT 'user',
    source_id    TEXT,
    source_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT companies_slug_unique UNIQUE (slug),
    CONSTRAINT companies_source_key UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS companies_domain_idx
    ON companies (domain)
    WHERE domain IS NOT NULL;

-- ── topics ─────────────────────────────────────────────────────────
-- Hierarchical tags. `parent_id` lets us build a tree (e.g. "Music" >
-- "Rock" > "Indie Rock"). Many-to-many to events via event_topics.
CREATE TABLE IF NOT EXISTS topics (
    id           BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL,
    name         TEXT NOT NULL,
    parent_id    BIGINT,                   -- FK → topics (self)
    description  TEXT,
    icon_url     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT topics_slug_unique UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS topics_parent_idx
    ON topics (parent_id)
    WHERE parent_id IS NOT NULL;

-- ── event_url_patterns ─────────────────────────────────────────────
-- The user's list of standard discovery paths. Given a host we just
-- learned about, the worker probes each of these in order to discover
-- its event listings.
--
--   /events          /event          /calendar
--   /conference      /festival       /meetup
--   /workshop        /seminar        /lecture
--   /program         /whats-on       /upcoming
--
-- `priority` controls probe order within a host (lower = first).
-- `kind` is the URL-pattern kind ('listing', 'feed', 'api') — 'feed'
-- is for RSS/Atom endpoints, 'api' is for JSON endpoints we know how
-- to call, 'listing' is a generic HTML page we'll need to crawl.
CREATE TABLE IF NOT EXISTS event_url_patterns (
    id           BIGSERIAL PRIMARY KEY,
    pattern      TEXT NOT NULL,            -- '/events', '/event/{slug}', '/calendar.ics'
    kind         TEXT NOT NULL DEFAULT 'listing',  -- 'listing' | 'feed' | 'api'
    priority     SMALLINT NOT NULL DEFAULT 100,
    description  TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_url_patterns_unique UNIQUE (pattern, kind)
);

-- Seed with the user's standard pattern set. ON CONFLICT keeps it
-- idempotent if we re-run.
INSERT INTO event_url_patterns (pattern, kind, priority, description) VALUES
    ('/events',        'listing', 10, 'Most common generic listing'),
    ('/event',         'listing', 11, 'Singular variant'),
    ('/events/upcoming','listing', 12, 'Subpath for future events'),
    ('/calendar',      'listing', 20, 'Calendar-style index'),
    ('/calendar.ics',  'feed',    21, 'iCal feed'),
    ('/feed',          'feed',    22, 'Generic Atom/RSS feed'),
    ('/events.ics',    'feed',    23, 'iCal feed'),
    ('/events.xml',    'feed',    24, 'RSS feed'),
    ('/rss',           'feed',    25, 'Generic RSS root'),
    ('/conference',    'listing', 30, 'Conference listings'),
    ('/conferences',   'listing', 31, 'Plural variant'),
    ('/festival',      'listing', 40, 'Festival listings'),
    ('/festivals',     'listing', 41, 'Plural variant'),
    ('/meetup',        'listing', 50, 'Meetup-style listings'),
    ('/meetups',       'listing', 51, 'Plural variant'),
    ('/workshop',      'listing', 60, 'Workshop listings'),
    ('/workshops',     'listing', 61, 'Plural variant'),
    ('/seminar',       'listing', 70, 'Seminar listings'),
    ('/seminars',      'listing', 71, 'Plural variant'),
    ('/lecture',       'listing', 80, 'Lecture series'),
    ('/lectures',      'listing', 81, 'Plural variant'),
    ('/program',       'listing', 90, 'Program/schedule'),
    ('/programs',      'listing', 91, 'Plural variant'),
    ('/whats-on',      'listing', 95, 'British-style what''s on'),
    ('/upcoming',      'listing', 100, 'Generic upcoming events'),
    ('/agenda',        'listing', 110, 'Agenda page')
ON CONFLICT (pattern, kind) DO NOTHING;

-- ── event_sources: explicit per-source config ─────────────────────
-- One row per source (e.g. one per RSS feed, one per city council).
-- Tracks politeness tier, fetch state, last status. This is the table
-- the worker walks to decide what to poll next.
CREATE TABLE IF NOT EXISTS event_sources (
    id                  BIGSERIAL PRIMARY KEY,
    source              TEXT NOT NULL,            -- 'rss' | 'eventbrite' | 'ticketmaster' | 'meetup' | 'ical' | 'user'
    name                TEXT NOT NULL,            -- 'SFMOMA Events'
    host                TEXT,                     -- 'sfmoma.org'
    feed_url            TEXT,                     -- canonical feed URL (for rss/ical/api)
    website_url         TEXT,                     -- human-facing homepage
    country_code        TEXT,
    region              TEXT,
    city                TEXT,
    default_category    TEXT NOT NULL DEFAULT 'other',
    default_subcategory TEXT,
    source_priority     SMALLINT NOT NULL DEFAULT 50,    -- 1=highest
    politeness_tier     TEXT NOT NULL DEFAULT 'commercial',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_fetched_at     TIMESTAMPTZ,
    last_status         INTEGER,                  -- HTTP status from last fetch
    last_etag           TEXT,
    last_modified       TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    backoff_until       TIMESTAMPTZ,              -- when to retry after a 429
    items_last_fetch    INTEGER,                  -- events found on last fetch
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_sources_source_host_key UNIQUE (source, host),
    CONSTRAINT event_sources_source_priority_tier
        CHECK (source_priority BETWEEN 1 AND 100),
    CONSTRAINT event_sources_politeness_tier
        CHECK (politeness_tier IN ('gov','university','community','commercial','platform','user'))
);

CREATE INDEX IF NOT EXISTS event_sources_active_priority_idx
    ON event_sources (source_priority, id)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS event_sources_country_idx
    ON event_sources (country_code)
    WHERE country_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_sources_tier_idx
    ON event_sources (politeness_tier)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS event_sources_backoff_idx
    ON event_sources (backoff_until)
    WHERE backoff_until IS NOT NULL;

-- ── link tables ────────────────────────────────────────────────────
-- Many-to-many between events and the relational entities.
CREATE TABLE IF NOT EXISTS event_venues (
    event_id   BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    venue_id   BIGINT NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
    is_primary BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, venue_id)
);

CREATE INDEX IF NOT EXISTS event_venues_venue_idx
    ON event_venues (venue_id);

CREATE TABLE IF NOT EXISTS event_organizers (
    event_id     BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    organizer_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE RESTRICT,
    is_primary   BOOLEAN NOT NULL DEFAULT TRUE,
    role         TEXT NOT NULL DEFAULT 'host', -- 'host' | 'sponsor' | 'partner'
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, organizer_id, role)
);

CREATE INDEX IF NOT EXISTS event_organizers_organizer_idx
    ON event_organizers (organizer_id);

CREATE TABLE IF NOT EXISTS event_topics (
    event_id   BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    topic_id   BIGINT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
    relevance  REAL NOT NULL DEFAULT 1.0,    -- 0..1, used for ranking
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, topic_id)
);

CREATE INDEX IF NOT EXISTS event_topics_topic_idx
    ON event_topics (topic_id);

-- People ↔ events, three link tables for clarity (search vs analytics).
CREATE TABLE IF NOT EXISTS event_speakers (
    event_id   BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    person_id  BIGINT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
    role       TEXT NOT NULL DEFAULT 'speaker',  -- 'keynote' | 'speaker' | 'panelist' | 'moderator'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, person_id, role)
);

CREATE TABLE IF NOT EXISTS event_artists (
    event_id   BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    person_id  BIGINT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
    billing    TEXT NOT NULL DEFAULT 'support',  -- 'headliner' | 'support' | 'opener'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, person_id, billing)
);

CREATE TABLE IF NOT EXISTS event_performers (
    event_id   BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    person_id  BIGINT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
    role       TEXT NOT NULL DEFAULT 'performer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS event_speakers_person_idx ON event_speakers (person_id);
CREATE INDEX IF NOT EXISTS event_artists_person_idx  ON event_artists  (person_id);
CREATE INDEX IF NOT EXISTS event_performers_person_idx ON event_performers (person_id);

-- ── topic_relation: TOPIC → OTHER EVENTS ───────────────────────────
-- The user's fourth edge ("EVENT → TOPIC → OTHER EVENTS") is mostly
-- covered by event_topics. But sometimes a source tells us two events
-- are explicitly related ("part of the Festival X", "satellite event
-- of Y"). We capture those explicit edges here.
CREATE TABLE IF NOT EXISTS event_relations (
    event_id    BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    related_id  BIGINT NOT NULL REFERENCES upcoming_events(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'related', -- 'related' | 'parent' | 'child' | 'series' | 'satellite'
    weight      REAL NOT NULL DEFAULT 1.0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, related_id, kind),
    CHECK (event_id <> related_id)
);

CREATE INDEX IF NOT EXISTS event_relations_related_idx
    ON event_relations (related_id);

-- ── event_discoveries: "given a host, which patterns probed what?" ─
-- Audit table so we know which URL pattern actually surfaced events
-- for which hosts. Lets us tune `priority` over time.
CREATE TABLE IF NOT EXISTS event_discoveries (
    id              BIGSERIAL PRIMARY KEY,
    host            TEXT NOT NULL,
    pattern_id      BIGINT REFERENCES event_url_patterns(id) ON DELETE SET NULL,
    url             TEXT NOT NULL,
    status          INTEGER,
    found_links     INTEGER NOT NULL DEFAULT 0,
    found_events    INTEGER NOT NULL DEFAULT 0,
    probed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_discoveries_host_idx
    ON event_discoveries (host, probed_at DESC);

CREATE INDEX IF NOT EXISTS event_discoveries_pattern_idx
    ON event_discoveries (pattern_id, status)
    WHERE pattern_id IS NOT NULL;

-- ── FK from upcoming_events to venues/organizers (nullable, soft) ─
-- The flat columns (venue_name, organizer_name) remain the source of
-- truth for fast reads. venue_id / organizer_id are enrichment links
-- populated by an async matcher.
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS venue_id     BIGINT,
    ADD COLUMN IF NOT EXISTS organizer_id BIGINT;

CREATE INDEX IF NOT EXISTS upcoming_events_venue_idx
    ON upcoming_events (venue_id)
    WHERE venue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS upcoming_events_organizer_idx
    ON upcoming_events (organizer_id)
    WHERE organizer_id IS NOT NULL;

COMMIT;

-- ── A view that surfaces the relationship graph ────────────────────
-- The API can `SELECT * FROM events_with_graph` to get a denormalized
-- row with all the joins pre-flattened. Cheaper than doing it in the
-- hot path on every request.
CREATE OR REPLACE VIEW events_with_graph AS
SELECT
    e.*,
    v.name         AS venue_name_join,
    v.address      AS venue_address_join,
    v.lat          AS venue_lat,
    v.lng          AS venue_lng,
    v.website_url  AS venue_website_url,
    o.name         AS organizer_name_join,
    o.website_url  AS organizer_website_join,
    o.kind         AS organizer_kind
FROM upcoming_events e
LEFT JOIN event_venues     ev ON ev.event_id = e.id AND ev.is_primary
LEFT JOIN venues           v  ON v.id       = ev.venue_id
LEFT JOIN event_organizers eo ON eo.event_id = e.id AND eo.is_primary
LEFT JOIN organizers       o  ON o.id       = eo.organizer_id;
