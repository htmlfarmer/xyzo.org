-- ── 2026-09-21-missing-columns-fix.sql ──────────────────────────────
--
-- Adds all columns referenced by API code that were never created.
-- Without these, any query hitting a non-empty table crashes with
-- "column X does not exist" → unhandled Bun error → 502 for ALL
-- in-flight requests.
--
-- Idempotent — safe to re-run.

-- ── news_articles ───────────────────────────────────────────────────

DO $$
BEGIN
    -- Geolocation columns (used by /pins, /pins/map, /feed)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='extracted_lat') THEN
        ALTER TABLE news_articles ADD COLUMN extracted_lat double precision;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='extracted_lng') THEN
        ALTER TABLE news_articles ADD COLUMN extracted_lng double precision;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='extracted_location') THEN
        ALTER TABLE news_articles ADD COLUMN extracted_location text;
    END IF;

    -- Source classification (used by /pins map queries)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='source_kind') THEN
        ALTER TABLE news_articles ADD COLUMN source_kind text;
    END IF;

    -- Word frequency (used by /pins, /pins/:id/enriched)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='word_freq') THEN
        ALTER TABLE news_articles ADD COLUMN word_freq jsonb;
    END IF;

    -- Auto-categorization (used by /articles/:id/categorization-status)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorized_at') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorized_at timestamptz;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorize_status') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorize_status text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorize_confidence') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorize_confidence double precision;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorize_city_id') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorize_city_id bigint;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorize_city_label') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorize_city_label text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorize_event_type') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorize_event_type text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='auto_categorize_method') THEN
        ALTER TABLE news_articles ADD COLUMN auto_categorize_method text;
    END IF;

    -- Discovery (used by /pins search)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='discovery_query') THEN
        ALTER TABLE news_articles ADD COLUMN discovery_query text;
    END IF;

    -- Reporting & moderation (used by /analytics, /pins/:id/enriched)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='report_count') THEN
        ALTER TABLE news_articles ADD COLUMN report_count integer NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='quality_score') THEN
        ALTER TABLE news_articles ADD COLUMN quality_score double precision;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='credibility_signals') THEN
        ALTER TABLE news_articles ADD COLUMN credibility_signals jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='hidden_at') THEN
        ALTER TABLE news_articles ADD COLUMN hidden_at timestamptz;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='hidden_reason') THEN
        ALTER TABLE news_articles ADD COLUMN hidden_reason text;
    END IF;

    -- PageRank (used by story linker)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='news_articles' AND column_name='pagerank_score') THEN
        ALTER TABLE news_articles ADD COLUMN pagerank_score double precision;
    END IF;
END$$;

-- Status check constraint: add 'discovered' and 'processed' if missing
DO $$
BEGIN
    -- Drop old constraint and re-add with all statuses
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_articles_status_check') THEN
        ALTER TABLE news_articles DROP CONSTRAINT news_articles_status_check;
    END IF;
    ALTER TABLE news_articles ADD CONSTRAINT news_articles_status_check
        CHECK (status = ANY (ARRAY['pending','extracted','failed','unlocated','discovered','processed']));
END$$;

-- Spatial index for extracted_lat/lng
CREATE INDEX CONCURRENTLY IF NOT EXISTS news_articles_extracted_coords_idx
    ON news_articles (extracted_lng, extracted_lat)
    WHERE extracted_lat IS NOT NULL AND extracted_lng IS NOT NULL;

-- Index for report_count
CREATE INDEX CONCURRENTLY IF NOT EXISTS news_articles_report_count_idx
    ON news_articles (report_count DESC)
    WHERE report_count >= 1;

-- ── pins ────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pins' AND column_name='spread_position') THEN
        ALTER TABLE pins ADD COLUMN spread_position integer;
    END IF;
END$$;
