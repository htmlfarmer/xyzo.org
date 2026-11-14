-- Schema for tracking mentioned cities in news articles.
-- Stores the cities detected in article text (title + body) so we can:
--   1. Query "all articles mentioning Mumbai" without re-parsing text
--   2. Show city coverage statistics
--   3. Build city-to-city relationship graphs
--   4. Improve search relevance by city mentions
--
-- Idempotent — safe to re-run.

-- Junction table: article ↔ city mentions
-- Note: city_id references world_cities which is a foreign table (FDW),
-- so we can't use a foreign key constraint. The application layer
-- ensures referential integrity.
CREATE TABLE IF NOT EXISTS news_article_cities (
    id              BIGSERIAL PRIMARY KEY,
    article_id      BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    city_id         BIGINT NOT NULL,
    mention_count   INT NOT NULL DEFAULT 1,       -- how many times mentioned
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE, -- is this the main city?
    confidence      TEXT,                           -- 'high', 'medium', 'low'
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (article_id, city_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS news_article_cities_article_idx
    ON news_article_cities (article_id);
CREATE INDEX IF NOT EXISTS news_article_cities_city_idx
    ON news_article_cities (city_id);
CREATE INDEX IF NOT EXISTS news_article_cities_primary_idx
    ON news_article_cities (is_primary)
    WHERE is_primary = TRUE;

-- View: city mention counts (for coverage stats)
CREATE OR REPLACE VIEW city_mention_stats AS
SELECT
    wc.id AS city_id,
    wc.name AS city_name,
    wc.country_code,
    wc.lat,
    wc.lng,
    wc.population,
    COUNT(DISTINCT ac.article_id) AS article_count,
    COUNT(DISTINCT ac.article_id) FILTER (WHERE ac.is_primary) AS primary_count,
    MAX(ac.detected_at) AS last_mentioned
FROM world_cities wc
LEFT JOIN news_article_cities ac ON ac.city_id = wc.id
WHERE wc.population >= 100000
GROUP BY wc.id, wc.name, wc.country_code, wc.lat, wc.lng, wc.population;

-- View: articles with their mentioned cities (for quick joins)
CREATE OR REPLACE VIEW articles_with_cities AS
SELECT
    a.id AS article_id,
    a.title,
    a.url,
    a.source_id,
    a.fetched_at,
    a.status,
    ac.city_id,
    ac.is_primary,
    ac.mention_count,
    wc.name AS city_name,
    wc.country_code,
    wc.lat AS city_lat,
    wc.lng AS city_lng,
    wc.population AS city_population
FROM news_articles a
JOIN news_article_cities ac ON ac.article_id = a.id
JOIN world_cities wc ON wc.id = ac.city_id;

-- Function: detect and store city mentions for an article
-- Called after article extraction to populate the junction table.
CREATE OR REPLACE FUNCTION detect_article_cities(
    p_article_id BIGINT,
    p_title TEXT,
    p_body TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
    v_count INT := 0;
    v_city RECORD;
    v_text TEXT;
    v_primary_id BIGINT;
BEGIN
    -- Combine title + first 500 chars of body for detection
    v_text := COALESCE(p_title, '') || ' ' || COALESCE(LEFT(p_body, 500), '');

    -- Clear existing mentions for this article
    DELETE FROM news_article_cities WHERE article_id = p_article_id;

    -- Find cities mentioned in the text
    -- Uses the world_cities table with case-insensitive matching
    FOR v_city IN
        SELECT DISTINCT ON (wc.id)
            wc.id,
            wc.name,
            wc.ascii_name,
            wc.country_code,
            wc.population,
            -- Count occurrences (case-insensitive)
            (LENGTH(v_text) - LENGTH(REPLACE(LOWER(v_text), LOWER(wc.name), ''))) / GREATEST(LENGTH(wc.name), 1) AS mentions
        FROM world_cities wc
        WHERE wc.population >= 100000
          AND LOWER(wc.name) NOT IN (
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
            'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
            'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no',
            'new', 'old', 'big', 'small', 'good', 'bad', 'first', 'last',
            'long', 'great', 'little', 'own', 'other', 'right', 'high',
            'different', 'large', 'next', 'early', 'young', 'important',
            'few', 'public', 'same', 'able', 'north', 'south', 'east', 'west',
            'report', 'news', 'story', 'article', 'today', 'yesterday',
            'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
            'saturday', 'sunday', 'january', 'february', 'march', 'april',
            'may', 'june', 'july', 'august', 'september', 'october', 'november',
            'december', 'us', 'usa', 'uk', 'eu', 'un',
            'man', 'men', 'most', 'reading', 'mobile', 'deal', 'nice', 'bath',
            'best', 'normal', 'union', 'central', 'general', 'van', 'sur',
            'split', 'splits', 'sale', 'sales', 'independence', 'surprise',
            'university', 'college', 'enterprise', 'marathon', 'liberty',
            'opportunity', 'heaven', 'paradise', 'freedom', 'prosperity',
            'concord', 'harmony', 'metro', 'overall', 'worth', 'vista', 'plano',
            'xinhua', 'sino', 'centro', 'san', 'los', 'las', 'dos', 'tres',
            'por', 'sin', 'mas', 'algo', 'nada', 'casa', 'como', 'viven',
            'vida', 'tierra', 'hijos', 'para', 'aba', 'toda', 'todo', 'todas',
            'todos', 'ise', 'lira', 'kisi', 'noma', 'koka', 'mura', 'mora',
            'tema', 'temas'
          )
          AND (
            LOWER(v_text) LIKE '% ' || LOWER(wc.name) || ' %'
            OR LOWER(v_text) LIKE LOWER(wc.name) || ' %'
            OR LOWER(v_text) LIKE '% ' || LOWER(wc.name)
            OR LOWER(v_text) = LOWER(wc.name)
            OR LOWER(v_text) LIKE '% ' || LOWER(wc.ascii_name) || ' %'
            OR LOWER(v_text) LIKE LOWER(wc.ascii_name) || ' %'
            OR LOWER(v_text) LIKE '% ' || LOWER(wc.ascii_name)
            OR LOWER(v_text) = LOWER(wc.ascii_name)
          )
        ORDER BY wc.id, wc.population DESC
    LOOP
        -- Determine confidence based on population
        DECLARE
            v_confidence TEXT;
            v_is_primary BOOLEAN;
        BEGIN
            IF v_city.population >= 1000000 THEN
                v_confidence := 'high';
            ELSIF v_city.population >= 250000 THEN
                v_confidence := 'medium';
            ELSE
                v_confidence := 'low';
            END IF;

            -- First high-confidence city is primary
            v_is_primary := (v_primary_id IS NULL AND v_confidence IN ('high', 'medium'));

            INSERT INTO news_article_cities (article_id, city_id, mention_count, is_primary, confidence)
            VALUES (p_article_id, v_city.id, GREATEST(v_city.mentions, 1), v_is_primary, v_confidence)
            ON CONFLICT (article_id, city_id) DO UPDATE
                SET mention_count = EXCLUDED.mention_count,
                    is_primary = EXCLUDED.is_primary,
                    confidence = EXCLUDED.confidence;

            IF v_is_primary THEN
                v_primary_id := v_city.id;
            END IF;

            v_count := v_count + 1;
        END;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Trigger: auto-detect cities when article is inserted/updated
-- This runs in the background after extraction completes.
CREATE OR REPLACE FUNCTION trigger_detect_article_cities()
RETURNS TRIGGER AS $$
BEGIN
    -- Only run if title changed or status moved to 'extracted'
    IF (TG_OP = 'INSERT') OR
       (TG_OP = 'UPDATE' AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.status IS DISTINCT FROM OLD.status)) THEN
        -- Run detection asynchronously (non-blocking)
        PERFORM detect_article_cities(NEW.id, NEW.title, NEW.body);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger (drop first if exists to avoid duplicates)
DROP TRIGGER IF EXISTS trg_detect_cities ON news_articles;
CREATE TRIGGER trg_detect_cities
    AFTER INSERT OR UPDATE OF title, status ON news_articles
    FOR EACH ROW
    WHEN (NEW.status = 'extracted')
    EXECUTE FUNCTION trigger_detect_article_cities();

COMMENT ON TABLE news_article_cities IS 'Cities mentioned in news articles, detected from title + body text';
COMMENT ON FUNCTION detect_article_cities IS 'Detects city mentions in article text and stores them in news_article_cities';
