-- Speed up GET /api/pins/stats.
--
-- The endpoint counted the whole news_articles table with a
-- COUNT(*) FILTER over a UNION of pins + articles. The existing index
-- (status, COALESCE(published_at, fetched_at)) cannot be used because the
-- query also filters on location_id IS NOT NULL — the planner had to
-- fetch every heap row to check it, so the count took 1.2 s idle and
-- >8 s under load.
--
-- That timeout is what the api_watchdog was reacting to: it restarted
-- xyzo-api every couple of minutes, and because the unit runs
-- validate-api.sh in ExecStartPre, every restart was a ~40 s outage in
-- which Caddy answered 502 (the browser console showed
-- /api/feed/live/stream and /api/feed/links failing).
--
-- This partial index covers exactly the rows the counter needs, so the
-- time-window counts become index-only range scans.

CREATE INDEX IF NOT EXISTS idx_articles_pub_loc
    ON news_articles (COALESCE(published_at, fetched_at) DESC)
    WHERE status = 'extracted' AND location_id IS NOT NULL;

ANALYZE news_articles;
