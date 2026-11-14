-- Newsium non-AI auto-categorization columns.
--
-- Idempotent — safe to run multiple times. Adds four columns to
-- news_articles that record what the cities_text + classify fast-path
-- worker found in title+body before the LLM ever saw the article.
--
-- The fast path runs first in worker/run.py and skips the AI entirely
-- for any row with auto_categorized_at IS NOT NULL. Rows the fast path
-- couldn't confidently resolve stay status='pending' and get a
-- auto_categorize_status of 'no_match' or 'low' so the AI study queue
-- (see /api/articles/needs-ai) can pick them up.

ALTER TABLE news_articles
    ADD COLUMN IF NOT EXISTS auto_categorized_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_categorize_confidence    TEXT,
    ADD COLUMN IF NOT EXISTS auto_categorize_status        TEXT,
    ADD COLUMN IF NOT EXISTS auto_categorize_city_id       BIGINT,
    ADD COLUMN IF NOT EXISTS auto_categorize_city_label    TEXT,
    ADD COLUMN IF NOT EXISTS auto_categorize_event_type    TEXT,
    ADD COLUMN IF NOT EXISTS auto_categorize_method        TEXT;

-- Cheap btree index for the worker query:
--   WHERE status='pending' AND auto_categorized_at IS NULL
-- and the inverse "already done" check inside extract.py.
CREATE INDEX IF NOT EXISTS news_articles_auto_cat_pending_idx
    ON news_articles (auto_categorized_at)
    WHERE auto_categorized_at IS NULL;

-- Index for the AI-study queue (rows the fast path couldn't resolve).
CREATE INDEX IF NOT EXISTS news_articles_auto_cat_status_idx
    ON news_articles (auto_categorize_status, fetched_at DESC)
    WHERE auto_categorize_status IN ('no_match', 'low');

-- Pin the allowed values so a typo in the worker doesn't silently
-- pollute the column. Add as a CHECK constraint rather than an enum
-- so we can extend it without an ALTER TYPE dance.
-- Drop old constraint if it exists, then re-create with the extended set.
-- source_based: location derived from the news_source's geocoded position.
DO $$ BEGIN
    ALTER TABLE news_articles DROP CONSTRAINT IF EXISTS news_articles_auto_cat_status_chk;
    ALTER TABLE news_articles
        ADD CONSTRAINT news_articles_auto_cat_status_chk
        CHECK (auto_categorize_status IS NULL
            OR auto_categorize_status IN ('high', 'medium', 'low', 'no_match', 'source_based'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Drop old constraint if it exists, then re-create with the extended set.
-- source_based: confidence level for source-derived locations.
DO $$ BEGIN
    ALTER TABLE news_articles DROP CONSTRAINT IF EXISTS news_articles_auto_cat_conf_chk;
    ALTER TABLE news_articles
        ADD CONSTRAINT news_articles_auto_cat_conf_chk
        CHECK (auto_categorize_confidence IS NULL
            OR auto_categorize_confidence IN ('high', 'medium', 'low', 'source_based'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Drop old constraint if it exists, then re-create with the extended set.
-- source_fallback: lat/lng derived from the news_source's geocoded position
-- when the article text doesn't mention a city name.
DO $$ BEGIN
    ALTER TABLE news_articles DROP CONSTRAINT IF EXISTS news_articles_auto_cat_method_chk;
    ALTER TABLE news_articles
        ADD CONSTRAINT news_articles_auto_cat_method_chk
        CHECK (auto_categorize_method IS NULL
            OR auto_categorize_method IN ('fast_path', 'client_apply', 'ai_fallback', 'source_fallback'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
