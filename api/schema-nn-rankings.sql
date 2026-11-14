-- Xyzo Neural Network ranking features. Additive, idempotent.
--
-- The Ranking Model needs to know about each user's recent interaction
-- history to produce personalized (well, location-personalized) scores.
-- These are aggregated features computed from news_interactions:
--
--   nn_session_features       — per-session aggregate over the last N hours
--   nn_session_topic_interest — per-session per-topic affinity (for cross-feature)
--   nn_session_country_interest — per-session per-country affinity
--   nn_hot_topics             — global trending topics, computed hourly
--   nn_event_velocity         — clicks/views per hour per event (input to Ranking)
--
-- The Ranking Model itself is in nn_prediction_cache (model_name='ranking')
-- and is materialized as nn_v_ranking / nn_v_article_leaderboard in
-- schema-nn-predictions.sql. This file is just the input-side feature
-- aggregation.

-- ── nn_session_features ─────────────────────────────────────────
-- One row per active session, refreshed hourly. Used as input to
-- the Ranking Model when scoring an article (we cross the article's
-- embedding with this session's interest vector).
CREATE TABLE IF NOT EXISTS nn_session_features (
    id                  BIGSERIAL PRIMARY KEY,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot_window_h   INT  NOT NULL DEFAULT 24,
    session_id          TEXT NOT NULL,
    -- Counts in the window
    session_age_days    INT,
    total_interactions  INT  NOT NULL DEFAULT 0,
    pin_views           INT  NOT NULL DEFAULT 0,
    pin_clicks          INT  NOT NULL DEFAULT 0,
    searches            INT  NOT NULL DEFAULT 0,
    source_clicks       INT  NOT NULL DEFAULT 0,
    location_fixes      INT  NOT NULL DEFAULT 0,
    votes_cast          INT  NOT NULL DEFAULT 0,
    -- Latent
    avg_dwell_ms        INT,
    unique_pins_viewed  INT NOT NULL DEFAULT 0,
    unique_sources      INT NOT NULL DEFAULT 0,
    unique_countries    INT NOT NULL DEFAULT 0,
    unique_categories   INT NOT NULL DEFAULT 0,
    -- Geography
    home_country        TEXT,
    last_seen_lat       DOUBLE PRECISION,
    last_seen_lng       DOUBLE PRECISION,
    last_seen_country   TEXT,
    -- Active model inputs (jsonb because they're high-dim sparse)
    topic_interest      JSONB NOT NULL DEFAULT '{}',    -- {'politics': 0.8, 'sports': 0.2, ...}
    country_interest    JSONB NOT NULL DEFAULT '{}',    -- {'US': 0.7, 'GB': 0.3, ...}
    category_interest   JSONB NOT NULL DEFAULT '{}',    -- {'business': 0.6, ...}
    source_interest     JSONB NOT NULL DEFAULT '{}',    -- {'bbc.co.uk': 0.9, ...}
    UNIQUE (snapshot_at, session_id)
);
CREATE INDEX IF NOT EXISTS nn_session_features_session_idx
    ON nn_session_features (session_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS nn_session_features_snapshot_idx
    ON nn_session_features (snapshot_at DESC);


-- ── nn_hot_topics ────────────────────────────────────────────────
-- Global trending topics, refreshed hourly. Used as input to the
-- Ranking Model's `trending_score` component (so a brand-new article
-- on a hot topic gets a fast boost) and surfaced via /api/trending.
CREATE TABLE IF NOT EXISTS nn_hot_topics (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    window_hours    INT  NOT NULL DEFAULT 24,
    region          TEXT NOT NULL DEFAULT 'global',     -- 'global' | ISO-3166-1 alpha-2
    topic           TEXT NOT NULL,                      -- event_type or extracted topic
    rank            INT  NOT NULL,
    -- Velocity metrics
    article_count   INT  NOT NULL DEFAULT 0,
    view_count      INT  NOT NULL DEFAULT 0,
    click_count     INT  NOT NULL DEFAULT 0,
    unique_users    INT  NOT NULL DEFAULT 0,
    -- Acceleration: rate of change in click_count over the last 6h.
    velocity        DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- Predicted next-24h score (NN ranking model's trending_score field).
    predicted_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    UNIQUE (snapshot_at, region, topic)
);
CREATE INDEX IF NOT EXISTS nn_hot_topics_region_idx
    ON nn_hot_topics (region, rank);
CREATE INDEX IF NOT EXISTS nn_hot_topics_snapshot_idx
    ON nn_hot_topics (snapshot_at DESC);


-- ── nn_event_velocity ───────────────────────────────────────────
-- Per-event click/view rate over time. The Ranking Model uses this
-- as the velocity feature for ranking: an event whose click rate is
-- accelerating rises in the leaderboard.
CREATE TABLE IF NOT EXISTS nn_event_velocity (
    id              BIGSERIAL PRIMARY KEY,
    event_id        BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    window_hours    INT  NOT NULL DEFAULT 6,
    views           INT  NOT NULL DEFAULT 0,
    clicks          INT  NOT NULL DEFAULT 0,
    searches        INT  NOT NULL DEFAULT 0,
    unique_users    INT  NOT NULL DEFAULT 0,
    velocity_views  DOUBLE PRECISION NOT NULL DEFAULT 0,  -- views/hour
    velocity_clicks DOUBLE PRECISION NOT NULL DEFAULT 0,  -- clicks/hour
    -- Acceleration (Δvelocity over previous window).
    accel_views     DOUBLE PRECISION NOT NULL DEFAULT 0,
    accel_clicks    DOUBLE PRECISION NOT NULL DEFAULT 0,
    UNIQUE (event_id, snapshot_at, window_hours)
);
CREATE INDEX IF NOT EXISTS nn_event_velocity_event_idx
    ON nn_event_velocity (event_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS nn_event_velocity_snapshot_idx
    ON nn_event_velocity (snapshot_at DESC);


-- ── Materialized view: latest session feature per session ───────
CREATE OR REPLACE VIEW nn_v_session_features_latest AS
SELECT DISTINCT ON (session_id)
    session_id,
    snapshot_at,
    snapshot_window_h,
    session_age_days,
    total_interactions,
    pin_views,
    pin_clicks,
    searches,
    source_clicks,
    location_fixes,
    votes_cast,
    avg_dwell_ms,
    unique_pins_viewed,
    unique_sources,
    unique_countries,
    unique_categories,
    home_country,
    last_seen_lat,
    last_seen_lng,
    last_seen_country,
    topic_interest,
    country_interest,
    category_interest,
    source_interest,
    high_zoom_views,
    avg_zoom_depth,
    zoom_view_duration_ms,
    unique_cities_viewed
FROM nn_session_features
ORDER BY session_id, snapshot_at DESC;


-- ── Materialized view: latest hot topics ────────────────────────
CREATE OR REPLACE VIEW nn_v_hot_topics_latest AS
SELECT DISTINCT ON (region, topic)
    region, topic, snapshot_at, window_hours, rank,
    article_count, view_count, click_count, unique_users,
    velocity, predicted_score
FROM nn_hot_topics
ORDER BY region, topic, snapshot_at DESC;


-- ── Refresh function: hourly aggregate ─────────────────────────
-- Called by worker/learn.py at the hourly cadence. Idempotent —
-- replaces the latest snapshot for each session/topic.
CREATE OR REPLACE FUNCTION refresh_nn_session_features(window_h INT DEFAULT 24)
RETURNS void AS $$
BEGIN
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
        searches            = EXCLUDED.searches,
        source_clicks       = EXCLUDED.source_clicks,
        location_fixes      = EXCLUDED.location_fixes,
        votes_cast          = EXCLUDED.votes_cast,
        avg_dwell_ms        = EXCLUDED.avg_dwell_ms,
        unique_pins_viewed  = EXCLUDED.unique_pins_viewed,
        unique_sources      = EXCLUDED.unique_sources,
        unique_countries    = EXCLUDED.unique_countries,
        unique_categories   = EXCLUDED.unique_categories,
        home_country        = EXCLUDED.home_country,
        last_seen_lat       = EXCLUDED.last_seen_lat,
        last_seen_lng       = EXCLUDED.last_seen_lng,
        last_seen_country   = EXCLUDED.last_seen_country;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION refresh_nn_hot_topics(window_h INT DEFAULT 24)
RETURNS void AS $$
BEGIN
    -- Per-event-type velocity
    INSERT INTO nn_hot_topics (
        snapshot_at, window_hours, region, topic, rank,
        article_count, view_count, click_count, unique_users,
        velocity, predicted_score
    )
    SELECT
        now(), window_h,
        COALESCE(l.country, 'global') AS region,
        e.event_type                   AS topic,
        ROW_NUMBER() OVER (
            PARTITION BY COALESCE(l.country, 'global')
            ORDER BY COUNT(DISTINCT i.session_id) DESC
        )::INT                         AS rank,
        COUNT(DISTINCT a.id),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_view'),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_click'),
        COUNT(DISTINCT i.session_id),
        COUNT(*) FILTER (WHERE i.interaction_type = 'pin_click')::FLOAT
          / GREATEST(window_h, 1)      AS velocity,
        -- Simple predicted_score = velocity × log10(unique_users + 1)
        (COUNT(*) FILTER (WHERE i.interaction_type = 'pin_click')::FLOAT
          / GREATEST(window_h, 1)) * LN(GREATEST(COUNT(DISTINCT i.session_id), 1) + 1)
                                    AS predicted_score
    FROM news_events e
    LEFT JOIN news_locations l ON l.id = e.primary_location_id
    LEFT JOIN news_event_sources es ON es.event_id = e.id
    LEFT JOIN news_articles a ON a.id = es.article_id
    LEFT JOIN news_interactions i
           ON i.event_id = e.id
          AND i.created_at > now() - (window_h || ' hours')::interval
    WHERE e.first_reported_at > now() - (window_h || ' hours')::interval
    GROUP BY COALESCE(l.country, 'global'), e.event_type
    ON CONFLICT (snapshot_at, region, topic) DO UPDATE SET
        rank            = EXCLUDED.rank,
        article_count   = EXCLUDED.article_count,
        view_count      = EXCLUDED.view_count,
        click_count     = EXCLUDED.click_count,
        unique_users    = EXCLUDED.unique_users,
        velocity        = EXCLUDED.velocity,
        predicted_score = EXCLUDED.predicted_score;
END;
$$ LANGUAGE plpgsql;


-- ── Permissions ──────────────────────────────────────────────────
GRANT SELECT ON nn_session_features,
                nn_hot_topics,
                nn_event_velocity,
                nn_v_session_features_latest,
                nn_v_hot_topics_latest
    TO xyzo_app;
GRANT EXECUTE ON FUNCTION refresh_nn_session_features(INT),
                            refresh_nn_hot_topics(INT)
    TO xyzo_app;
