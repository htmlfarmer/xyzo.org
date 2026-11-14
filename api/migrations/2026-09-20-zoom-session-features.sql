-- ── 2026-09-20-zoom-session-features.sql ──────────────────────────────────
--
-- Zoom-level tracking: wire location_views into session features + ranking.
--
-- What this adds:
--   1. New columns on nn_session_features for zoom-level signals
--   2. Updated refresh_nn_session_features() to pull from news_location_views
--   3. New nn_zoom_city_interest table for per-session per-city zoom affinity
--
-- Why: zoom >= 10 means "I want news about THIS specific city" — the strongest
--       user intent signal for source discovery and ranking personalization.

BEGIN;

-- ── 1. New columns on nn_session_features ────────────────────────────────
ALTER TABLE nn_session_features
    ADD COLUMN IF NOT EXISTS high_zoom_views     INT NOT NULL DEFAULT 0,  -- views at zoom >= 10 (city-level)
    ADD COLUMN IF NOT EXISTS avg_zoom_depth       FLOAT NOT NULL DEFAULT 0, -- avg zoom level (0-20)
    ADD COLUMN IF NOT EXISTS zoom_view_duration_ms INT,                       -- avg duration at high zoom
    ADD COLUMN IF NOT EXISTS unique_cities_viewed INT NOT NULL DEFAULT 0;     -- distinct cities at zoom >= 10

-- ── 2. City-level interest table ──────────────────────────────────────
-- Per-session affinity for specific cities weighted by zoom depth.
-- zoom >= 10 = city-level intent. Higher zoom = stronger signal.
-- This feeds ranking model's city_match_score feature.
CREATE TABLE IF NOT EXISTS nn_zoom_city_interest (
    id                  BIGSERIAL PRIMARY KEY,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    session_id          TEXT NOT NULL,
    city_name           TEXT NOT NULL,
    country_code        TEXT,
    center_lat          DOUBLE PRECISION NOT NULL,
    center_lng          DOUBLE PRECISION NOT NULL,
    view_count          INT NOT NULL DEFAULT 0,       -- raw view count at zoom >= 10
    zoom_weighted_score  FLOAT NOT NULL DEFAULT 0,    -- view_count * avg_zoom
    avg_duration_ms     INT,                          -- avg dwell time at this city
    last_seen_at        TIMESTAMPTZ,
    UNIQUE (snapshot_at, session_id, city_name)
);

CREATE INDEX IF NOT EXISTS nn_zoom_city_session_idx
    ON nn_zoom_city_interest (session_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS nn_zoom_city_score_idx
    ON nn_zoom_city_interest (zoom_weighted_score DESC);
CREATE INDEX IF NOT EXISTS nn_zoom_city_city_idx
    ON nn_zoom_city_interest (city_name, country_code, snapshot_at DESC);

-- ── 3. Updated refresh_nn_session_features ────────────────────────────
-- Adds zoom metrics from news_location_views
CREATE OR REPLACE FUNCTION refresh_nn_session_features(window_h INT DEFAULT 24)
RETURNS void AS $$
BEGIN
    -- Upsert base session features (existing logic)
    INSERT INTO nn_session_features (
        snapshot_at, snapshot_window_h, session_id,
        session_age_days, total_interactions, pin_views, pin_clicks,
        searches, source_clicks, location_fixes, votes_cast,
        avg_dwell_ms, unique_pins_viewed, unique_sources,
        unique_countries, unique_categories,
        home_country, last_seen_lat, last_seen_lng, last_seen_country
    )
    SELECT
        now(), window_h, i.session_id,
        EXTRACT(DAY FROM (now() - min(i.created_at)))::INT,
        COUNT(*),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_view'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_click'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'search'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'source_click'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'fix_location'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'vote'),
        AVG((i.metadata->>'dwell_ms')::INT) FILTER (WHERE i.metadata ? 'dwell_ms'),
        COUNT(DISTINCT i.pin_id),
        COUNT(DISTINCT i.source_id),
        COUNT(DISTINCT i.user_country) FILTER (WHERE i.user_country IS NOT NULL),
        COUNT(DISTINCT i.metadata->>'category') FILTER (WHERE i.metadata ? 'category'),
        MAX(ul.home_country),
        AVG(i.user_lat) FILTER (WHERE i.user_lat IS NOT NULL),
        AVG(i.user_lng) FILTER (WHERE i.user_lng IS NOT NULL),
        (ARRAY_AGG(i.user_country ORDER BY i.created_at DESC))[1]
    FROM news_interactions i
    LEFT JOIN news_user_locations ul ON ul.session_id = i.session_id
    WHERE i.created_at > now() - (window_h || ' hours')::interval
    GROUP BY i.session_id
    ON CONFLICT (snapshot_at, session_id) DO UPDATE SET
        session_age_days    = EXCLUDED.session_age_days,
        total_interactions  = EXCLUDED.total_interactions,
        pin_views           = EXCLUDED.pin_views,
        pin_clicks          = EXCLUDED.pin_clicks,
        searches           = EXCLUDED.searches,
        source_clicks      = EXCLUDED.source_clicks,
        location_fixes     = EXCLUDED.location_fixes,
        votes_cast         = EXCLUDED.votes_cast,
        avg_dwell_ms       = EXCLUDED.avg_dwell_ms,
        unique_pins_viewed = EXCLUDED.unique_pins_viewed,
        unique_sources     = EXCLUDED.unique_sources,
        unique_countries   = EXCLUDED.unique_countries,
        unique_categories  = EXCLUDED.unique_categories,
        home_country       = EXCLUDED.home_country,
        last_seen_lat      = EXCLUDED.last_seen_lat,
        last_seen_lng      = EXCLUDED.last_seen_lng,
        last_seen_country  = EXCLUDED.last_seen_country;

    -- Update zoom-level columns from news_location_views
    -- Join on session_id and time window, aggregate zoom metrics
    UPDATE nn_session_features sf
    SET
        high_zoom_views = z.high_zoom_views,
        avg_zoom_depth = z.avg_zoom_depth,
        zoom_view_duration_ms = z.avg_duration_ms,
        unique_cities_viewed = z.unique_cities
    FROM (
        SELECT
            lv.session_id,
            COUNT(*) FILTER (WHERE lv.zoom_level >= 10) AS high_zoom_views,
            AVG(lv.zoom_level) FILTER (WHERE lv.zoom_level >= 1) AS avg_zoom_depth,
            AVG(lv.duration_ms) FILTER (WHERE lv.zoom_level >= 10 AND lv.duration_ms IS NOT NULL) AS avg_duration_ms,
            COUNT(DISTINCT lv.city_name) FILTER (WHERE lv.zoom_level >= 10 AND lv.city_name IS NOT NULL) AS unique_cities
        FROM news_location_views lv
        WHERE lv.created_at > now() - (window_h || ' hours')::interval
          AND lv.session_id IS NOT NULL
        GROUP BY lv.session_id
    ) z
    WHERE sf.session_id = z.session_id
      AND sf.snapshot_at = now();

    -- Also handle sessions that have no location_views yet (insert zeros)
    INSERT INTO nn_session_features (
        snapshot_at, snapshot_window_h, session_id,
        session_age_days, total_interactions, pin_views, pin_clicks,
        searches, source_clicks, location_fixes, votes_cast,
        avg_dwell_ms, unique_pins_viewed, unique_sources,
        unique_countries, unique_categories,
        home_country, last_seen_lat, last_seen_lng, last_seen_country,
        high_zoom_views, avg_zoom_depth, zoom_view_duration_ms, unique_cities_viewed
    )
    SELECT
        now(), window_h, i.session_id,
        EXTRACT(DAY FROM (now() - min(i.created_at)))::INT,
        COUNT(*),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_view'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_click'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'search'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'source_click'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'fix_location'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'vote'),
        AVG((i.metadata->>'dwell_ms')::INT) FILTER (WHERE i.metadata ? 'dwell_ms'),
        COUNT(DISTINCT i.pin_id),
        COUNT(DISTINCT i.source_id),
        COUNT(DISTINCT i.user_country) FILTER (WHERE i.user_country IS NOT NULL),
        COUNT(DISTINCT i.metadata->>'category') FILTER (WHERE i.metadata ? 'category'),
        MAX(ul.home_country),
        AVG(i.user_lat) FILTER (WHERE i.user_lat IS NOT NULL),
        AVG(i.user_lng) FILTER (WHERE i.user_lng IS NOT NULL),
        (ARRAY_AGG(i.user_country ORDER BY i.created_at DESC))[1],
        0, 0, NULL, 0
    FROM news_interactions i
    LEFT JOIN news_user_locations ul ON ul.session_id = i.session_id
    WHERE i.created_at > now() - (window_h || ' hours')::interval
      AND i.session_id NOT IN (
          SELECT session_id FROM nn_session_features
          WHERE snapshot_at = now()
      )
    GROUP BY i.session_id
    ON CONFLICT (snapshot_at, session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Populate nn_zoom_city_interest ────────────────────────────────
-- Per-session city affinity from zoom >= 10 views
CREATE OR REPLACE FUNCTION refresh_zoom_city_interest(window_h INT DEFAULT 24)
RETURNS void AS $$
BEGIN
    INSERT INTO nn_zoom_city_interest (
        snapshot_at, session_id, city_name, country_code,
        center_lat, center_lng, view_count, zoom_weighted_score,
        avg_duration_ms, last_seen_at
    )
    SELECT
        now(),
        lv.session_id,
        lv.city_name,
        lv.country_code,
        ROUND(lv.center_lat::numeric, 2)::double precision,
        ROUND(lv.center_lng::numeric, 2)::double precision,
        COUNT(*) AS view_count,
        COUNT(*)::float * AVG(lv.zoom_level) AS zoom_weighted_score,
        AVG(lv.duration_ms)::int AS avg_duration_ms,
        MAX(lv.created_at) AS last_seen_at
    FROM news_location_views lv
    WHERE lv.created_at > now() - (window_h || ' hours')::interval
      AND lv.session_id IS NOT NULL
      AND lv.zoom_level >= 10
      AND lv.city_name IS NOT NULL
    GROUP BY
        lv.session_id, lv.city_name, lv.country_code,
        ROUND(lv.center_lat::numeric, 2),
        ROUND(lv.center_lng::numeric, 2)
    ON CONFLICT (snapshot_at, session_id, city_name) DO UPDATE SET
        view_count = EXCLUDED.view_count,
        zoom_weighted_score = EXCLUDED.zoom_weighted_score,
        avg_duration_ms = EXCLUDED.avg_duration_ms,
        last_seen_at = EXCLUDED.last_seen_at;
END;
$$ LANGUAGE plpgsql;

-- ── 5. Grant permissions ──────────────────────────────────────────────
GRANT SELECT, INSERT ON nn_zoom_city_interest TO xyzo_app;
GRANT USAGE ON SEQUENCE nn_zoom_city_interest_id_seq TO xyzo_app;
GRANT EXECUTE ON FUNCTION refresh_zoom_city_interest(INT) TO xyzo_app;

COMMIT;
