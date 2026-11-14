-- FIX_NOTES 1.5 (2026-09-26): transient Nominatim failures (429/5xx/timeout)
-- no longer park articles in terminal status='unlocated'. They stay 'extracted'
-- with location_id NULL and are retried, bounded by geocode_attempts.
ALTER TABLE news_articles
    ADD COLUMN IF NOT EXISTS geocode_attempts integer NOT NULL DEFAULT 0;

-- The geocode work-queue query (partial, oldest-first, bounded attempts).
CREATE INDEX IF NOT EXISTS idx_news_articles_geocode_queue
    ON news_articles (extracted_at ASC NULLS FIRST)
    WHERE status = 'extracted'
      AND location_id IS NULL
      AND location_text IS NOT NULL
      AND location_text <> '';
