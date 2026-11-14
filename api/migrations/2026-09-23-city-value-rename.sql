-- City Value Engine Migration: Rename from "coolness" to "value" + enrich
-- Adds: primary_mention_ratio, avg_confidence, high_confidence_ratio,
--        user_trend_score, discovery_priority, views_24h, views_7d

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 1: Rename existing tables
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS city_coolness RENAME TO city_value;
ALTER TABLE IF EXISTS city_coolness_tag RENAME TO city_value_tag;
ALTER TABLE IF EXISTS city_coolness_history RENAME TO city_value_history;
ALTER TABLE IF EXISTS coolness_factor_config RENAME TO value_factor_config;

-- Rename indexes
ALTER INDEX IF EXISTS idx_city_coolness_score RENAME TO idx_city_value_score;
ALTER INDEX IF EXISTS idx_city_coolness_rank RENAME TO idx_city_value_rank;
ALTER INDEX IF EXISTS idx_city_coolness_country RENAME TO idx_city_value_country;
ALTER INDEX IF EXISTS idx_city_coolness_region RENAME TO idx_city_value_region;
ALTER INDEX IF EXISTS idx_city_coolness_tier RENAME TO idx_city_value_tier;
ALTER INDEX IF EXISTS idx_city_coolness_surging RENAME TO idx_city_value_surging;
ALTER INDEX IF EXISTS idx_city_coolness_tag_city RENAME TO idx_city_value_tag_city;
ALTER INDEX IF EXISTS idx_city_coolness_tag_type RENAME TO idx_city_value_tag_type;
ALTER INDEX IF EXISTS idx_city_coolness_tag_name RENAME TO idx_city_value_tag_name;
ALTER INDEX IF EXISTS idx_coolness_history_city RENAME TO idx_city_value_history_city;
ALTER INDEX IF EXISTS idx_coolness_history_time RENAME TO idx_city_value_history_time;

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 2: Add new columns to city_value
-- ══════════════════════════════════════════════════════════════════════════════

-- User engagement metrics (from news_location_rankings)
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS user_trend_score FLOAT DEFAULT 0;
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS discovery_priority FLOAT DEFAULT 0;
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS views_24h INT DEFAULT 0;
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS views_7d INT DEFAULT 0;

-- Geocoding quality metrics (from news_article_cities)
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS primary_mention_ratio FLOAT DEFAULT 0;
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS avg_confidence FLOAT DEFAULT 0;
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS high_confidence_ratio FLOAT DEFAULT 0;

-- Rename freshness_score_ct → freshness_score for clarity (column order matters)
ALTER TABLE city_value ADD COLUMN IF NOT EXISTS freshness_score FLOAT DEFAULT 0;

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 3: Create new computed_at column if missing, copy from existing
-- (freshness_score_ct was the old column, now we have freshness_score as well)
-- ══════════════════════════════════════════════════════════════════════════════

-- Copy freshness_score_ct values to freshness_score for backward compatibility
UPDATE city_value SET freshness_score = COALESCE(freshness_score_ct, 0);

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 4: Rename factor config references
-- ══════════════════════════════════════════════════════════════════════════════

-- Update factor config table name reference (it was already renamed above)
-- But we need to update the factor_name values if they reference "coolness"
UPDATE value_factor_config
SET factor_name = REPLACE(factor_name, 'coolness', 'value'),
    description = REPLACE(description, 'coolness', 'value')
WHERE factor_name LIKE '%coolness%' OR description LIKE '%coolness%';

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 5: Backfill new columns from news_article_cities
-- confidence is TEXT with values 'high', 'medium', 'low' — map to numeric
-- ══════════════════════════════════════════════════════════════════════════════

UPDATE city_value cv SET
    primary_mention_ratio = COALESCE(stats.primary_ratio, 0),
    avg_confidence = COALESCE(stats.avg_conf, 0),
    high_confidence_ratio = COALESCE(stats.high_ratio, 0)
FROM (
    SELECT
        ac.city_id,
        COUNT(*) FILTER (WHERE ac.is_primary = true)::float /
            NULLIF(COUNT(*), 0) AS primary_ratio,
        AVG(CASE ac.confidence
            WHEN 'high' THEN 0.9
            WHEN 'medium' THEN 0.6
            WHEN 'low' THEN 0.3
            ELSE 0.5 END) AS avg_conf,
        COUNT(*) FILTER (WHERE ac.confidence = 'high')::float /
            NULLIF(COUNT(*), 0) AS high_ratio
    FROM news_article_cities ac
    WHERE ac.city_id IS NOT NULL
    GROUP BY ac.city_id
) stats
WHERE stats.city_id = cv.city_id;

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 6: Backfill new columns from news_location_rankings
-- ══════════════════════════════════════════════════════════════════════════════

UPDATE city_value cv SET
    user_trend_score = COALESCE(nlr.trend_score, 0),
    discovery_priority = COALESCE(nlr.discovery_priority, 0),
    views_24h = COALESCE(nlr.views_24h, 0),
    views_7d = COALESCE(nlr.views_7d, 0)
FROM news_location_rankings nlr
WHERE nlr.city_name = (
    SELECT name FROM world_cities WHERE id = cv.city_id
)
AND nlr.country_code = cv.country_code;

-- ══════════════════════════════════════════════════════════════════════════════
-- Step 7: Rename cool_city_500 → city_value_curated (keep compatibility)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS cool_city_500 RENAME TO city_value_curated;
ALTER INDEX IF EXISTS idx_cool_city_500_region RENAME TO idx_city_value_curated_region;
ALTER INDEX IF EXISTS idx_cool_city_500_priority RENAME TO idx_city_value_curated_priority;

COMMENT ON TABLE city_value IS 'City news value scores — aggregates volume, diversity, trend, quality, and user engagement signals';
COMMENT ON TABLE city_value_tag IS 'Human editorial tags for city value scoring';
COMMENT ON TABLE city_value_history IS 'Historical city value scores for trend analysis';
COMMENT ON TABLE value_factor_config IS 'Configurable weights for city value factor computation';
COMMENT ON TABLE city_value_curated IS 'Curated list of 500 notable cities for enhanced coverage';
