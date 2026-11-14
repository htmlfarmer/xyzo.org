-- ── 2026-09-06-events-pipeline.sql ────────────────────────────────────
--
-- New calendar-style events pipeline. The existing news_events table
-- clusters news articles into "stories" (politics, business, etc.) —
-- that's about NOW, with no future-dated items.
--
-- `upcoming_events` is a different concept: real-world events with a
-- venue, a start time, and an end time. Sources include:
--   - RSS feeds (Linux Foundation, PyCon, ApacheCon, university Localist)
--   - Eventbrite Discovery API (free tier, gated by XYZO_EVENTBRITE_TOKEN)
--   - Ticketmaster Discovery API (free, gated by XYZO_TICKETMASTER_TOKEN)
--   - User submissions (community) — `event_submissions`
--
-- `saved_searches` records successful search queries so the system can
-- later learn which keywords actually surface useful events. Combined
-- with click-through telemetry this becomes a discovery-improvement
-- loop.
--
-- All idempotent. Safe to run live; CREATE IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS upcoming_events (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL,            -- 'rss', 'eventbrite', 'ticketmaster', 'user'
    source_id       TEXT NOT NULL,            -- opaque per-source identifier (RSS guid, API event id, etc.)
    source_url      TEXT NOT NULL,            -- canonical event URL on the source platform
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL,            -- 'conference', 'concert', 'meetup', 'festival', 'sports', 'lecture', 'webinar', 'hackathon', 'community', 'other'
    venue_name      TEXT,
    venue_address   TEXT,
    city            TEXT,
    region          TEXT,
    country         TEXT,
    country_code    TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ,
    is_online       BOOLEAN NOT NULL DEFAULT FALSE,
    is_free         BOOLEAN,
    price_min       NUMERIC(10,2),
    price_max       NUMERIC(10,2),
    currency        TEXT,
    image_url       TEXT,
    organizer_name  TEXT,
    tags            TEXT[] DEFAULT '{}',
    language        TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,             -- past this point the event is stale; jobs skip it
    -- Politeness tier inherited from the source URL's host. The worker
    -- uses this to gate fetch cadence + retry behaviour:
    --   'gov'         — once per 24h, robots.txt mandatory, single retry max
    --   'university'  — once per 6h, robots.txt mandatory
    --   'community'   — once per 2h, robots.txt mandatory (.org/.net/.ngo)
    --   'commercial'  — once per 30m, robots.txt advisory
    --   'platform'    — once per 15m, paid-API cadence (Eventbrite/Ticketmaster)
    --   'user'        — never auto-fetched; only on demand
    politeness_tier TEXT NOT NULL DEFAULT 'commercial',
    fetcher_state   JSONB NOT NULL DEFAULT '{}'::jsonb, -- last status, last 304-ETag, last 429 timestamp
    CONSTRAINT upcoming_events_source_key UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS upcoming_events_starts_at_idx
    ON upcoming_events (starts_at ASC);

CREATE INDEX IF NOT EXISTS upcoming_events_city_idx
    ON upcoming_events (lower(city))
    WHERE city IS NOT NULL;

CREATE INDEX IF NOT EXISTS upcoming_events_country_idx
    ON upcoming_events (country_code)
    WHERE country_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS upcoming_events_category_idx
    ON upcoming_events (category)
    WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS upcoming_events_geo_idx
    ON upcoming_events (lat, lng)
    WHERE lat IS NOT NULL AND lng IS NOT NULL;

-- tsvector GIN index for full-text search across title/description/city
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'upcoming_events_fts_idx'
    ) THEN
        CREATE INDEX upcoming_events_fts_idx ON upcoming_events
            USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(city,'')));
    END IF;
END$do$;

-- ── User-submitted events ────────────────────────────────────────────
-- Anyone can submit a local event they know about. Goes through a light
-- moderation queue (`status='pending'`) before showing publicly.
CREATE TABLE IF NOT EXISTS event_submissions (
    id              BIGSERIAL PRIMARY KEY,
    submitter_email TEXT NOT NULL,
    submitter_name  TEXT,
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL DEFAULT 'community',
    venue_name      TEXT,
    venue_address   TEXT,
    city            TEXT,
    region          TEXT,
    country         TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ,
    is_online       BOOLEAN NOT NULL DEFAULT FALSE,
    is_free         BOOLEAN,
    url             TEXT,
    image_url       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ,
    reviewer_notes  TEXT
);

CREATE INDEX IF NOT EXISTS event_submissions_status_idx
    ON event_submissions (status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS event_submissions_starts_at_idx
    ON event_submissions (starts_at);

-- ── Saved searches ───────────────────────────────────────────────────
-- The frontend POSTs to /api/searches/save when the user finds a
-- search that produced useful results (typically: when a user clicks a
-- pin from a search result, OR manually bookmarks). Used for:
--   1. Personal: "your saved searches" sidebar
--   2. Discovery: aggregate click-through to learn which queries work
CREATE TABLE IF NOT EXISTS saved_searches (
    id              BIGSERIAL PRIMARY KEY,
    user_token      TEXT NOT NULL,            -- anonymous browser token (cookie / localStorage)
    kind            TEXT NOT NULL DEFAULT 'news', -- 'news' | 'events' | 'pins'
    query           TEXT NOT NULL,
    filters         JSONB NOT NULL DEFAULT '{}'::jsonb,
    label           TEXT,
    result_count    INTEGER,
    click_count     INTEGER NOT NULL DEFAULT 0,
    saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_searches_user_token_idx
    ON saved_searches (user_token, kind, last_used_at DESC);

-- Aggregate table: which saved searches get clicked most? Helps the
-- system surface "people who searched X also liked Y" type analytics.
CREATE TABLE IF NOT EXISTS search_query_stats (
    query           TEXT PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'news',
    use_count       BIGINT NOT NULL DEFAULT 1,
    click_count     BIGINT NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_query_stats_top_idx
    ON search_query_stats (use_count DESC, last_used_at DESC);
