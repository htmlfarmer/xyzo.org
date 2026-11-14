-- Migration: news_event_graph_features
-- Computed graph interconnectivity signals per event from news_story_links.
-- Refreshed hourly by compute_event_graph_features.py

BEGIN;

CREATE TABLE IF NOT EXISTS news_event_graph_features (
    event_id                BIGINT PRIMARY KEY REFERENCES news_events(id) ON DELETE CASCADE,

    -- Connectivity counts
    articles_in_event       INTEGER NOT NULL DEFAULT 0,

    -- Link counts
    total_links             INTEGER NOT NULL DEFAULT 0,
    incoming_links          INTEGER NOT NULL DEFAULT 0,
    outgoing_links          INTEGER NOT NULL DEFAULT 0,
    same_event_links        INTEGER NOT NULL DEFAULT 0,
    ai_detected_links      INTEGER NOT NULL DEFAULT 0,
    same_city_links        INTEGER NOT NULL DEFAULT 0,
    same_topic_links        INTEGER NOT NULL DEFAULT 0,
    same_country_links     INTEGER NOT NULL DEFAULT 0,

    -- Link quality
    total_link_strength     REAL NOT NULL DEFAULT 0,
    avg_link_strength       REAL NOT NULL DEFAULT 0,
    max_link_strength       REAL NOT NULL DEFAULT 0,

    -- Graph diversity
    unique_linked_events    INTEGER NOT NULL DEFAULT 0,
    link_type_count        INTEGER NOT NULL DEFAULT 0,

    -- Same-event consensus
    same_event_avg_strength REAL NOT NULL DEFAULT 0,

    -- Composite connectivity score
    connectivity_score      REAL NOT NULL DEFAULT 0,

    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_graph_feats_event ON news_event_graph_features(event_id);
CREATE INDEX idx_graph_feats_connectivity ON news_event_graph_features(connectivity_score DESC);
CREATE INDEX idx_graph_feats_total_links ON news_event_graph_features(total_links DESC);

-- Populate initial data using a two-pass approach:
-- 1. Article→event mapping + link aggregation per article
-- 2. Roll up to event level

INSERT INTO news_event_graph_features
WITH
-- Step 1: Per-article link stats grouped by the article's event
article_link_stats AS (
    SELECT
        ses.event_id,
        ses.article_id,

        -- Outgoing from this article
        COUNT(l.id) AS outgoing,
        COALESCE(SUM(l.link_strength), 0) AS outgoing_strength,

        -- Count by link type
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_event') AS same_event_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'ai_detected') AS ai_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_city') AS city_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_topic') AS topic_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_country') AS country_out,

        -- Max strength outgoing
        COALESCE(MAX(l.link_strength), 0) AS max_out_strength,

        -- Unique target events reachable from this article's outgoing links
        COUNT(DISTINCT tes.event_id) AS unique_target_events_out
    FROM news_event_sources ses
    LEFT JOIN news_story_links l ON l.source_article_id = ses.article_id
    LEFT JOIN news_event_sources tes ON tes.article_id = l.target_article_id
    GROUP BY ses.event_id, ses.article_id
),

-- Step 2: Incoming link stats per article (links TARGETING this article)
article_incoming_stats AS (
    SELECT
        ses.event_id,
        ses.article_id,

        -- Incoming to this article
        COUNT(l.id) AS incoming,
        COALESCE(SUM(l.link_strength), 0) AS incoming_strength
    FROM news_event_sources ses
    LEFT JOIN news_story_links l ON l.target_article_id = ses.article_id
    GROUP BY ses.event_id, ses.article_id
),

-- Step 3: Same-event internal links (both articles in same event)
same_event_internal AS (
    SELECT
        ses.event_id,
        COUNT(l.id) AS internal_same_event,
        COALESCE(SUM(l.link_strength), 0) AS internal_strength
    FROM news_event_sources ses
    JOIN news_story_links l ON l.source_article_id = ses.article_id
    JOIN news_event_sources tes ON tes.article_id = l.target_article_id AND tes.event_id = ses.event_id
    GROUP BY ses.event_id
),

-- Step 4: Unique linked EVENTS (distinct event_ids on the other side of links)
event_linked_events AS (
    SELECT
        ses.event_id,
        COUNT(DISTINCT tes.event_id) FILTER (WHERE tes.event_id != ses.event_id) AS unique_other_events
    FROM news_event_sources ses
    JOIN news_story_links l ON l.source_article_id = ses.article_id
    JOIN news_event_sources tes ON tes.article_id = l.target_article_id
    WHERE tes.event_id != ses.event_id
    GROUP BY ses.event_id
),

-- Step 5: Article count per event
event_article_counts AS (
    SELECT event_id, COUNT(DISTINCT article_id) AS article_count
    FROM news_event_sources
    GROUP BY event_id
),

-- Step 6: Aggregate to event level
event_stats AS (
    SELECT
        als.event_id,

        -- Article count
        COALESCE(eac.article_count, 0) AS articles_in_event,

        -- Total links (incoming + outgoing per article, count each link once via outgoing)
        SUM(als.outgoing) AS total_links,
        COALESCE(SUM(ais.incoming), 0) AS incoming_links,
        SUM(als.outgoing) AS outgoing_links,

        -- By type
        SUM(als.same_event_out) AS same_event_links,
        SUM(als.ai_out) AS ai_detected_links,
        SUM(als.city_out) AS same_city_links,
        SUM(als.topic_out) AS same_topic_links,
        SUM(als.country_out) AS same_country_links,

        -- Strength
        SUM(als.outgoing_strength + COALESCE(ais.incoming_strength, 0)) AS total_link_strength,
        GREATEST(MAX(als.max_out_strength), 0) AS max_link_strength,

        -- Unique linked events
        COALESCE(MAX(elu.unique_other_events), 0) AS unique_linked_events,

        -- Same-event internal links
        COALESCE(MAX(sei.internal_same_event), 0) AS same_event_internal_links,
        COALESCE(MAX(sei.internal_strength), 0) AS same_event_internal_strength,

        -- Link type diversity (count distinct link types across all links)
        0 AS link_type_count  -- placeholder; computed below
    FROM article_link_stats als
    LEFT JOIN article_incoming_stats ais ON ais.event_id = als.event_id AND ais.article_id = als.article_id
    LEFT JOIN event_article_counts eac ON eac.event_id = als.event_id
    LEFT JOIN event_linked_events elu ON elu.event_id = als.event_id
    LEFT JOIN same_event_internal sei ON sei.event_id = als.event_id
    GROUP BY als.event_id, eac.article_count
)

-- Final compute
SELECT
    es.event_id,
    es.articles_in_event,
    es.total_links,
    es.incoming_links,
    es.outgoing_links,
    es.same_event_links,
    es.ai_detected_links,
    es.same_city_links,
    es.same_topic_links,
    es.same_country_links,
    es.total_link_strength::REAL,
    CASE WHEN es.total_links > 0
         THEN (es.total_link_strength / es.total_links)::REAL
         ELSE 0 END AS avg_link_strength,
    es.max_link_strength,
    es.unique_linked_events,
    -- link_type_count: count non-zero link type columns
    (CASE WHEN es.same_event_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.ai_detected_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.same_city_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.same_topic_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.same_country_links > 0 THEN 1 ELSE 0 END) AS link_type_count,
    -- Same-event consensus: internal same_event links / same_event_links
    CASE WHEN es.same_event_links > 0
         THEN (es.same_event_internal_strength / NULLIF(es.same_event_links, 0))::REAL
         ELSE 0 END AS same_event_avg_strength,
    -- Composite connectivity score
    CASE
        WHEN es.total_links = 0 THEN 0
        ELSE LEAST(
            -- Normalized link density (links per article, capped at 10)
            LEAST((es.total_links::REAL / GREATEST(es.articles_in_event, 1)), 10.0) * 0.25
            -- Total link mass
            + LEAST(es.total_link_strength::REAL / 100.0, 10.0) * 0.25
            -- Unique event reach
            + LEAST(es.unique_linked_events::REAL / 10.0, 5.0) * 0.20
            -- Same-event consensus
            + (CASE WHEN es.same_event_links > 0
                    THEN (es.same_event_internal_strength::REAL / es.same_event_links) * 0.15
                    ELSE 0 END)
            -- Link type diversity bonus
            + (CASE WHEN es.same_event_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.ai_detected_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.same_city_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.same_topic_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.same_country_links > 0 THEN 1 ELSE 0 END)::REAL * 0.15,
            10.0
        )
    END AS connectivity_score
FROM event_stats es
ON CONFLICT (event_id) DO UPDATE SET
    articles_in_event       = EXCLUDED.articles_in_event,
    total_links            = EXCLUDED.total_links,
    incoming_links         = EXCLUDED.incoming_links,
    outgoing_links         = EXCLUDED.outgoing_links,
    same_event_links       = EXCLUDED.same_event_links,
    ai_detected_links      = EXCLUDED.ai_detected_links,
    same_city_links        = EXCLUDED.same_city_links,
    same_topic_links       = EXCLUDED.same_topic_links,
    same_country_links     = EXCLUDED.same_country_links,
    total_link_strength    = EXCLUDED.total_link_strength,
    avg_link_strength      = EXCLUDED.avg_link_strength,
    max_link_strength      = EXCLUDED.max_link_strength,
    unique_linked_events   = EXCLUDED.unique_linked_events,
    link_type_count        = EXCLUDED.link_type_count,
    same_event_avg_strength= EXCLUDED.same_event_avg_strength,
    connectivity_score     = EXCLUDED.connectivity_score,
    updated_at             = NOW();

COMMIT;
