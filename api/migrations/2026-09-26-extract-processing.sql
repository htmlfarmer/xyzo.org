-- FIX_NOTES 6.5 (2026-09-26): AI extraction had no claim step — the 15-min
-- fetcher and the 03:00 nightly both SELECT the same pending rows and pay
-- twice for the same GPU work. Add a 'processing' claim status.
ALTER TABLE news_articles DROP CONSTRAINT IF EXISTS news_articles_status_check;
ALTER TABLE news_articles ADD CONSTRAINT news_articles_status_check
    CHECK (status IN ('pending','processing','extracted','failed','unlocated','discovered'));

-- Claim queue index
CREATE INDEX IF NOT EXISTS idx_news_articles_extract_queue
    ON news_articles (fetched_at DESC)
    WHERE status = 'pending';

-- Claim timestamp: crashed workers must not strand rows in 'processing'
-- forever — anything claimed >2h ago is re-queued at the start of every
-- extract run (worker/extract.py::_requeue_stale_processing).
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS processing_at timestamptz;

GRANT SELECT, UPDATE ON news_articles TO xyzo_app;
