-- Newsium Analytics & Ranking Schema
-- Tracks user interactions, source rankings, and geographic interest

-- ── User Interactions Log ──────────────────────────────────────────────
-- Every meaningful user action gets logged here for analytics
CREATE TABLE IF NOT EXISTS news_interactions (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,           -- Anonymous session fingerprint
    interaction_type TEXT NOT NULL CHECK (interaction_type IN (
        'pin_click',          -- User clicked a pin on the map
        'pin_view',           -- Pin popup was opened
        'source_click',       -- User clicked a source link
        'map_move',           -- User panned/zoomed the map
        'search',             -- User performed a search
        'fix_location',       -- User submitted a location correction
        'vote',               -- User voted on a correction
        'explore_region',     -- User explored a region
        'set_home',           -- User set their home location
        'page_view',          -- General page view
        'ui_click',           -- Generic UI control click (buttons, tabs, toggles)
        'performance'         -- Client perf timing marks (load/map/first-pin)
    )),
    -- What was interacted with
    pin_id          BIGINT,
    article_id      BIGINT,
    source_id       BIGINT,
    event_id        BIGINT,
    -- Geographic context
    map_lat         DOUBLE PRECISION,        -- Map center when interaction happened
    map_lng         DOUBLE PRECISION,
    map_zoom        INT,
    bbox            TEXT,                     -- Viewport bbox as "minLng,minLat,maxLng,maxLat"
    -- User context
    user_lat        DOUBLE PRECISION,        -- User's detected/set location
    user_lng        DOUBLE PRECISION,
    user_country    TEXT,
    user_city       TEXT,
    ip_address      INET,
    user_agent      TEXT,
    -- Metadata
    metadata        JSONB,                   -- Extra data (search query, etc.)
    client_ts       TIMESTAMPTZ,             -- When it happened on the client (batched flush => created_at later)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS news_interactions_session_idx ON news_interactions (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS news_interactions_type_idx ON news_interactions (interaction_type, created_at DESC);
CREATE INDEX IF NOT EXISTS news_interactions_client_ts_idx ON news_interactions (client_ts DESC);
CREATE INDEX IF NOT EXISTS news_interactions_pin_idx ON news_interactions (pin_id) WHERE pin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_interactions_source_idx ON news_interactions (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_interactions_geo_idx ON news_interactions (user_country, created_at DESC);
CREATE INDEX IF NOT EXISTS news_interactions_time_idx ON news_interactions (created_at DESC);

-- ── Source Rankings ────────────────────────────────────────────────────
-- Aggregated ranking scores for news sources, updated periodically
CREATE TABLE IF NOT EXISTS news_source_rankings (
    source_id       BIGINT PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
    -- Engagement metrics (rolling 7-day window)
    clicks_7d       INT NOT NULL DEFAULT 0,
    views_7d        INT NOT NULL DEFAULT 0,
    unique_users_7d INT NOT NULL DEFAULT 0,
    -- Engagement metrics (rolling 30-day window)
    clicks_30d      INT NOT NULL DEFAULT 0,
    views_30d       INT NOT NULL DEFAULT 0,
    unique_users_30d INT NOT NULL DEFAULT 0,
    -- Quality signals
    avg_view_duration_ms INT,                -- How long users spend reading
    click_through_rate   FLOAT,              -- views → clicks ratio
    return_rate          FLOAT,              -- Users who come back
    -- Geographic reach
    countries_reached    INT DEFAULT 0,
    -- Composite score (0-100)
    engagement_score     FLOAT DEFAULT 0,
    quality_score        FLOAT DEFAULT 0,
    reach_score          FLOAT DEFAULT 0,
    overall_score        FLOAT DEFAULT 0,
    -- Metadata
    last_calculated      TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_source_rankings_score_idx ON news_source_rankings (overall_score DESC);

-- ── Geographic Interest Heatmap ────────────────────────────────────────
-- Aggregated data about which map areas get the most attention
CREATE TABLE IF NOT EXISTS news_geo_interest (
    id              BIGSERIAL PRIMARY KEY,
    -- Grid cell (rounded to ~1km precision)
    grid_lat        DOUBLE PRECISION NOT NULL,
    grid_lng        DOUBLE PRECISION NOT NULL,
    -- Metrics
    click_count     INT NOT NULL DEFAULT 0,
    view_count      INT NOT NULL DEFAULT 0,
    search_count    INT NOT NULL DEFAULT 0,
    unique_users    INT NOT NULL DEFAULT 0,
    -- Time window
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    -- Composite
    interest_score  FLOAT DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(grid_lat, grid_lng, window_start)
);

CREATE INDEX IF NOT EXISTS news_geo_interest_score_idx ON news_geo_interest (interest_score DESC);
CREATE INDEX IF NOT EXISTS news_geo_interest_grid_idx ON news_geo_interest (grid_lat, grid_lng);

-- ── User Locations ─────────────────────────────────────────────────────
-- Stores user home locations (set by user or detected via IP)
CREATE TABLE IF NOT EXISTS news_user_locations (
    session_id      TEXT PRIMARY KEY,
    -- Set location (user explicitly set their home)
    home_lat        DOUBLE PRECISION,
    home_lng        DOUBLE PRECISION,
    home_city       TEXT,
    home_country    TEXT,
    home_set_at     TIMESTAMPTZ,
    -- Detected location (from IP geolocation)
    detected_lat    DOUBLE PRECISION,
    detected_lng    DOUBLE PRECISION,
    detected_city   TEXT,
    detected_country TEXT,
    detected_at     TIMESTAMPTZ,
    -- Active location (whichever is most recent/reliable)
    active_lat      DOUBLE PRECISION,
    active_lng      DOUBLE PRECISION,
    active_source   TEXT CHECK (active_source IN ('home', 'detected', 'browser')),
    -- Metadata
    visit_count     INT NOT NULL DEFAULT 1,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_user_locations_country_idx ON news_user_locations (home_country);
CREATE INDEX IF NOT EXISTS news_user_locations_coords_idx ON news_user_locations (active_lat, active_lng);

-- ── Search Analytics ───────────────────────────────────────────────────
-- Tracks what people are searching for
CREATE TABLE IF NOT EXISTS news_search_log (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    query           TEXT NOT NULL,
    result_count    INT,
    -- Where they were looking from
    user_lat        DOUBLE PRECISION,
    user_lng        DOUBLE PRECISION,
    user_country    TEXT,
    -- What they got
    top_results     JSONB,                   -- Array of {pin_id, title, relevance}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_search_log_query_idx ON news_search_log (query, created_at DESC);
CREATE INDEX IF NOT EXISTS news_search_log_time_idx ON news_search_log (created_at DESC);

-- ── Trending Topics ────────────────────────────────────────────────────
-- Aggregated trending topics by region
CREATE TABLE IF NOT EXISTS news_trending (
    id              BIGSERIAL PRIMARY KEY,
    region          TEXT NOT NULL,            -- Country code or 'global'
    topic           TEXT NOT NULL,            -- event_type or topic_tag
    article_count   INT NOT NULL DEFAULT 0,
    view_count      INT NOT NULL DEFAULT 0,
    click_count     INT NOT NULL DEFAULT 0,
    trend_score     FLOAT DEFAULT 0,
    window_hours    INT NOT NULL DEFAULT 24,
    calculated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(region, topic, window_hours, calculated_at)
);

CREATE INDEX IF NOT EXISTS news_trending_region_idx ON news_trending (region, trend_score DESC);
CREATE INDEX IF NOT EXISTS news_trending_time_idx ON news_trending (calculated_at DESC);

-- ── Materialized View: Source Leaderboard ───────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS source_leaderboard AS
SELECT
    ns.id,
    ns.name,
    ns.country,
    ns.region,
    ns.active,
    ns.reliability_score,
    COALESCE(sr.overall_score, 0) as ranking_score,
    COALESCE(sr.clicks_7d, 0) as clicks_7d,
    COALESCE(sr.views_7d, 0) as views_7d,
    COALESCE(sr.unique_users_7d, 0) as unique_users_7d,
    COALESCE(sr.countries_reached, 0) as countries_reached,
    (SELECT COUNT(*) FROM news_articles na WHERE na.source_id = ns.id) as article_count,
    (SELECT COUNT(*) FROM news_articles na WHERE na.source_id = ns.id AND na.status = 'extracted') as extracted_count
FROM news_sources ns
LEFT JOIN news_source_rankings sr ON sr.source_id = ns.id
WHERE ns.active = TRUE
ORDER BY ranking_score DESC, article_count DESC;

CREATE UNIQUE INDEX IF NOT EXISTS source_leaderboard_id_idx ON source_leaderboard (id);

-- ── Function: Calculate Source Rankings ─────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_source_rankings()
RETURNS void AS $$
BEGIN
    -- Upsert rankings from interaction data
    INSERT INTO news_source_rankings (
        source_id, clicks_7d, views_7d, unique_users_7d,
        clicks_30d, views_30d, unique_users_30d,
        countries_reached, engagement_score, overall_score,
        last_calculated, updated_at
    )
    SELECT
        ni.source_id,
        COUNT(*) FILTER (WHERE ni.interaction_type = 'source_click'
                         AND ni.created_at > now() - interval '7 days') as clicks_7d,
        COUNT(*) FILTER (WHERE ni.interaction_type = 'pin_view'
                         AND ni.created_at > now() - interval '7 days') as views_7d,
        COUNT(DISTINCT ni.session_id) FILTER (WHERE ni.created_at > now() - interval '7 days') as unique_users_7d,
        COUNT(*) FILTER (WHERE ni.interaction_type = 'source_click'
                         AND ni.created_at > now() - interval '30 days') as clicks_30d,
        COUNT(*) FILTER (WHERE ni.interaction_type = 'pin_view'
                         AND ni.created_at > now() - interval '30 days') as views_30d,
        COUNT(DISTINCT ni.session_id) FILTER (WHERE ni.created_at > now() - interval '30 days') as unique_users_30d,
        COUNT(DISTINCT ni.user_country) FILTER (WHERE ni.user_country IS NOT NULL) as countries_reached,
        -- Engagement score: clicks + views weighted
        (COUNT(*) FILTER (WHERE ni.interaction_type = 'source_click') * 3 +
         COUNT(*) FILTER (WHERE ni.interaction_type = 'pin_view'))::float /
         GREATEST(COUNT(DISTINCT ni.session_id), 1) as engagement_score,
        -- Overall score (will be refined)
        0 as overall_score,
        now(),
        now()
    FROM news_interactions ni
    WHERE ni.source_id IS NOT NULL
      AND ni.created_at > now() - interval '30 days'
    GROUP BY ni.source_id
    ON CONFLICT (source_id) DO UPDATE SET
        clicks_7d = EXCLUDED.clicks_7d,
        views_7d = EXCLUDED.views_7d,
        unique_users_7d = EXCLUDED.unique_users_7d,
        clicks_30d = EXCLUDED.clicks_30d,
        views_30d = EXCLUDED.views_30d,
        unique_users_30d = EXCLUDED.unique_users_30d,
        countries_reached = EXCLUDED.countries_reached,
        engagement_score = EXCLUDED.engagement_score,
        overall_score = EXCLUDED.engagement_score * 0.7 +
                       (SELECT ns.reliability_score FROM news_sources ns WHERE ns.id = news_source_rankings.source_id) * 30,
        last_calculated = now(),
        updated_at = now();

    -- Refresh materialized view
    REFRESH MATERIALIZED VIEW CONCURRENTLY source_leaderboard;
END;
$$ LANGUAGE plpgsql;

-- ── Function: Calculate Geographic Interest ─────────────────────────────
CREATE OR REPLACE FUNCTION calculate_geo_interest(window_hours INT DEFAULT 24)
RETURNS void AS $$
BEGIN
    INSERT INTO news_geo_interest (
        grid_lat, grid_lng, click_count, view_count, search_count,
        unique_users, window_start, window_end, interest_score, updated_at
    )
    SELECT
        ROUND(map_lat::numeric, 1) as grid_lat,
        ROUND(map_lng::numeric, 1) as grid_lng,
        COUNT(*) FILTER (WHERE interaction_type = 'pin_click') as click_count,
        COUNT(*) FILTER (WHERE interaction_type = 'pin_view') as view_count,
        COUNT(*) FILTER (WHERE interaction_type = 'search') as search_count,
        COUNT(DISTINCT session_id) as unique_users,
        now() - (window_hours || ' hours')::interval as window_start,
        now() as window_end,
        -- Interest score: weighted combination
        (COUNT(*) FILTER (WHERE interaction_type = 'pin_click') * 3 +
         COUNT(*) FILTER (WHERE interaction_type = 'pin_view') * 1 +
         COUNT(*) FILTER (WHERE interaction_type = 'search') * 2 +
         COUNT(DISTINCT session_id) * 5)::float as interest_score,
        now()
    FROM news_interactions
    WHERE map_lat IS NOT NULL
      AND map_lng IS NOT NULL
      AND created_at > now() - (window_hours || ' hours')::interval
    GROUP BY ROUND(map_lat::numeric, 1), ROUND(map_lng::numeric, 1)
    ON CONFLICT (grid_lat, grid_lng, window_start) DO UPDATE SET
        click_count = EXCLUDED.click_count,
        view_count = EXCLUDED.view_count,
        search_count = EXCLUDED.search_count,
        unique_users = EXCLUDED.unique_users,
        interest_score = EXCLUDED.interest_score,
        updated_at = now();
END;
$$ LANGUAGE plpgsql;
