-- Newsium Location Views Tracking Schema
-- Tracks which cities/areas users are viewing on the map
-- Used to prioritize news source discovery and show trending locations

-- ── Location Views Log ──────────────────────────────────────────────────
-- Raw log of every map view with location context
CREATE TABLE IF NOT EXISTS news_location_views (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    -- View context
    view_type       TEXT NOT NULL CHECK (view_type IN (
        'map_view',           -- User viewed a map area
        'pin_click',          -- User clicked a pin
        'search',             -- User searched for a location
        'explore',            -- User explored a region
        'auto_discover'       -- System auto-discovered area
    )),
    -- Location data (the area being viewed)
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    zoom_level      INT NOT NULL,
    bbox            TEXT,                     -- Viewport bbox as "minLng,minLat,maxLng,maxLat"
    -- Resolved location (filled by reverse geocoding or city lookup)
    city_name       TEXT,
    country_code    TEXT,
    region_name     TEXT,
    -- User context
    user_lat        DOUBLE PRECISION,
    user_lng        DOUBLE PRECISION,
    user_country    TEXT,
    ip_address      INET,
    -- Engagement metrics
    duration_ms     INT,                      -- How long user stayed in this view
    pin_count       INT,                      -- Number of pins visible in this view
    -- Metadata
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for location view queries
CREATE INDEX IF NOT EXISTS news_location_views_session_idx ON news_location_views (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS news_location_views_location_idx ON news_location_views (center_lat, center_lng);
CREATE INDEX IF NOT EXISTS news_location_views_city_idx ON news_location_views (city_name, created_at DESC) WHERE city_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_location_views_country_idx ON news_location_views (country_code, created_at DESC);
CREATE INDEX IF NOT EXISTS news_location_views_time_idx ON news_location_views (created_at DESC);
CREATE INDEX IF NOT EXISTS news_location_views_type_idx ON news_location_views (view_type, created_at DESC);

-- ── Location Rankings (Aggregated) ──────────────────────────────────────
-- Aggregated view counts and engagement metrics for locations
CREATE TABLE IF NOT EXISTS news_location_rankings (
    id              BIGSERIAL PRIMARY KEY,
    -- Location identification
    city_name       TEXT NOT NULL,
    country_code    TEXT NOT NULL,
    region_name     TEXT,
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    -- View metrics (rolling windows)
    views_1h        INT NOT NULL DEFAULT 0,
    views_24h       INT NOT NULL DEFAULT 0,
    views_7d        INT NOT NULL DEFAULT 0,
    views_30d       INT NOT NULL DEFAULT 0,
    -- Engagement metrics
    unique_users_24h INT NOT NULL DEFAULT 0,
    unique_users_7d  INT NOT NULL DEFAULT 0,
    avg_duration_ms  INT,
    avg_pin_count    FLOAT,
    -- Click metrics
    pin_clicks_24h   INT NOT NULL DEFAULT 0,
    pin_clicks_7d    INT NOT NULL DEFAULT 0,
    -- Search metrics
    searches_24h     INT NOT NULL DEFAULT 0,
    -- Trending score (calculated)
    trend_score      FLOAT DEFAULT 0,
    -- Coverage status
    has_coverage     BOOLEAN DEFAULT FALSE,
    article_count    INT DEFAULT 0,
    source_count     INT DEFAULT 0,
    -- Priority for news discovery
    discovery_priority FLOAT DEFAULT 0,
    last_discovery_at  TIMESTAMPTZ,
    -- Metadata
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    calculated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(city_name, country_code)
);

-- Indexes for location rankings
CREATE INDEX IF NOT EXISTS news_location_rankings_trend_idx ON news_location_rankings (trend_score DESC);
CREATE INDEX IF NOT EXISTS news_location_rankings_views_idx ON news_location_rankings (views_24h DESC);
CREATE INDEX IF NOT EXISTS news_location_rankings_priority_idx ON news_location_rankings (discovery_priority DESC);
CREATE INDEX IF NOT EXISTS news_location_rankings_coverage_idx ON news_location_rankings (has_coverage, views_24h DESC);

-- ── City Coverage Gaps ──────────────────────────────────────────────────
-- Tracks cities that users are viewing but have no news coverage
CREATE TABLE IF NOT EXISTS news_coverage_gaps (
    id              BIGSERIAL PRIMARY KEY,
    city_name       TEXT NOT NULL,
    country_code    TEXT NOT NULL,
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    -- Demand metrics
    view_count_24h  INT NOT NULL DEFAULT 0,
    view_count_7d   INT NOT NULL DEFAULT 0,
    unique_users    INT NOT NULL DEFAULT 0,
    -- Coverage status
    article_count   INT DEFAULT 0,
    source_count    INT DEFAULT 0,
    -- Gap score (higher = more demand, less coverage)
    gap_score       FLOAT DEFAULT 0,
    -- Status
    status          TEXT DEFAULT 'open' CHECK (status IN ('open', 'discovering', 'covered', 'ignored')),
    discovered_at   TIMESTAMPTZ,
    covered_at      TIMESTAMPTZ,
    -- Metadata
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(city_name, country_code)
);

-- Indexes for coverage gaps
CREATE INDEX IF NOT EXISTS news_coverage_gaps_score_idx ON news_coverage_gaps (gap_score DESC);
CREATE INDEX IF NOT EXISTS news_coverage_gaps_status_idx ON news_coverage_gaps (status, gap_score DESC);

-- ── Function: Calculate Location Rankings ────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_location_rankings()
RETURNS void AS $$
BEGIN
    -- Upsert location rankings from view data
    INSERT INTO news_location_rankings (
        city_name, country_code, region_name, center_lat, center_lng,
        views_1h, views_24h, views_7d, views_30d,
        unique_users_24h, unique_users_7d,
        avg_duration_ms, avg_pin_count,
        pin_clicks_24h, pin_clicks_7d,
        searches_24h,
        trend_score,
        has_coverage, article_count, source_count,
        discovery_priority,
        updated_at, calculated_at
    )
    SELECT
        COALESCE(lv.city_name, 'Unknown') as city_name,
        COALESCE(lv.country_code, 'XX') as country_code,
        lv.region_name,
        ROUND(lv.center_lat::numeric, 2) as center_lat,
        ROUND(lv.center_lng::numeric, 2) as center_lng,
        -- View counts
        COUNT(*) FILTER (WHERE lv.created_at > now() - interval '1 hour') as views_1h,
        COUNT(*) FILTER (WHERE lv.created_at > now() - interval '24 hours') as views_24h,
        COUNT(*) FILTER (WHERE lv.created_at > now() - interval '7 days') as views_7d,
        COUNT(*) FILTER (WHERE lv.created_at > now() - interval '30 days') as views_30d,
        -- Unique users
        COUNT(DISTINCT lv.session_id) FILTER (WHERE lv.created_at > now() - interval '24 hours') as unique_users_24h,
        COUNT(DISTINCT lv.session_id) FILTER (WHERE lv.created_at > now() - interval '7 days') as unique_users_7d,
        -- Engagement
        AVG(lv.duration_ms) FILTER (WHERE lv.duration_ms IS NOT NULL) as avg_duration_ms,
        AVG(lv.pin_count) FILTER (WHERE lv.pin_count IS NOT NULL) as avg_pin_count,
        -- Clicks
        COUNT(*) FILTER (WHERE lv.view_type = 'pin_click' AND lv.created_at > now() - interval '24 hours') as pin_clicks_24h,
        COUNT(*) FILTER (WHERE lv.view_type = 'pin_click' AND lv.created_at > now() - interval '7 days') as pin_clicks_7d,
        -- Searches
        COUNT(*) FILTER (WHERE lv.view_type = 'search' AND lv.created_at > now() - interval '24 hours') as searches_24h,
        -- Trending score (views * engagement * recency)
        (
            COUNT(*) FILTER (WHERE lv.created_at > now() - interval '24 hours') * 2 +
            COUNT(*) FILTER (WHERE lv.created_at > now() - interval '7 days') * 0.5 +
            COUNT(DISTINCT lv.session_id) FILTER (WHERE lv.created_at > now() - interval '24 hours') * 5
        )::float as trend_score,
        -- Coverage (will be updated separately)
        FALSE as has_coverage,
        0 as article_count,
        0 as source_count,
        -- Discovery priority (will be calculated)
        0 as discovery_priority,
        now(),
        now()
    FROM news_location_views lv
    WHERE lv.city_name IS NOT NULL
      AND lv.created_at > now() - interval '30 days'
    GROUP BY lv.city_name, lv.country_code, lv.region_name, 
             ROUND(lv.center_lat::numeric, 2), ROUND(lv.center_lng::numeric, 2)
    ON CONFLICT (city_name, country_code) DO UPDATE SET
        views_1h = EXCLUDED.views_1h,
        views_24h = EXCLUDED.views_24h,
        views_7d = EXCLUDED.views_7d,
        views_30d = EXCLUDED.views_30d,
        unique_users_24h = EXCLUDED.unique_users_24h,
        unique_users_7d = EXCLUDED.unique_users_7d,
        avg_duration_ms = EXCLUDED.avg_duration_ms,
        avg_pin_count = EXCLUDED.avg_pin_count,
        pin_clicks_24h = EXCLUDED.pin_clicks_24h,
        pin_clicks_7d = EXCLUDED.pin_clicks_7d,
        searches_24h = EXCLUDED.searches_24h,
        trend_score = EXCLUDED.trend_score,
        updated_at = now(),
        calculated_at = now();

    -- Update coverage status
    UPDATE news_location_rankings lr
    SET 
        has_coverage = EXISTS (
            SELECT 1 FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE l.country = lr.country_code
              AND a.status = 'extracted'
              AND a.fetched_at > now() - interval '7 days'
        ),
        article_count = (
            SELECT COUNT(*) FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE l.country = lr.country_code
              AND a.status = 'extracted'
        ),
        source_count = (
            SELECT COUNT(DISTINCT a.source_id) FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE l.country = lr.country_code
              AND a.status = 'extracted'
        ),
        discovery_priority = 
            CASE 
                WHEN NOT EXISTS (
                    SELECT 1 FROM news_articles a
                    JOIN news_locations l ON l.id = a.location_id
                    WHERE l.country = lr.country_code
                      AND a.status = 'extracted'
                      AND a.fetched_at > now() - interval '7 days'
                ) THEN lr.trend_score * 2  -- No coverage = high priority
                ELSE lr.trend_score * 0.5  -- Has coverage = lower priority
            END;

    -- Update coverage gaps
    INSERT INTO news_coverage_gaps (
        city_name, country_code, center_lat, center_lng,
        view_count_24h, view_count_7d, unique_users,
        article_count, source_count, gap_score, status
    )
    SELECT
        lr.city_name,
        lr.country_code,
        lr.center_lat,
        lr.center_lng,
        lr.views_24h,
        lr.views_7d,
        lr.unique_users_24h,
        lr.article_count,
        lr.source_count,
        lr.discovery_priority as gap_score,
        CASE 
            WHEN lr.has_coverage THEN 'covered'
            ELSE 'open'
        END as status
    FROM news_location_rankings lr
    WHERE lr.views_24h > 0
    ON CONFLICT (city_name, country_code) DO UPDATE SET
        view_count_24h = EXCLUDED.view_count_24h,
        view_count_7d = EXCLUDED.view_count_7d,
        unique_users = EXCLUDED.unique_users,
        article_count = EXCLUDED.article_count,
        source_count = EXCLUDED.source_count,
        gap_score = EXCLUDED.gap_score,
        status = EXCLUDED.status,
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

-- ── Function: Get Top Trending Locations ─────────────────────────────────
CREATE OR REPLACE FUNCTION get_trending_locations(limit_count INT DEFAULT 20)
RETURNS TABLE (
    city_name TEXT,
    country_code TEXT,
    center_lat DOUBLE PRECISION,
    center_lng DOUBLE PRECISION,
    views_24h INT,
    unique_users_24h INT,
    trend_score FLOAT,
    has_coverage BOOLEAN,
    article_count INT,
    gap_score FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        lr.city_name,
        lr.country_code,
        lr.center_lat,
        lr.center_lng,
        lr.views_24h,
        lr.unique_users_24h,
        lr.trend_score,
        lr.has_coverage,
        lr.article_count,
        lr.discovery_priority as gap_score
    FROM news_location_rankings lr
    WHERE lr.views_24h > 0
    ORDER BY lr.trend_score DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;
