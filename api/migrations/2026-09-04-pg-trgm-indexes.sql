-- pg_trgm indexes for ILIKE query performance
-- These GIN indexes enable trigram-based pattern matching, turning
-- sequential scans on ILIKE '%term%' into index scans.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- news_events.headline — used by /api/events?q=... (events.ts:21)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_events_headline_trgm
  ON news_events USING GIN (headline gin_trgm_ops);

-- news_events.summary — used by /api/events?q=... (events.ts:21)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_events_summary_trgm
  ON news_events USING GIN (summary gin_trgm_ops);

-- news_locations.place_name — used by /api/locations/search (events.ts:185)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_locations_place_name_trgm
  ON news_locations USING GIN (place_name gin_trgm_ops);

-- news_sources.name — used by /api/sources/search (sources.ts)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_sources_name_trgm
  ON news_sources USING GIN (name gin_trgm_ops);

-- news_sources.feed_url — used by /api/sources/search (sources.ts)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_sources_feed_url_trgm
  ON news_sources USING GIN (feed_url gin_trgm_ops);

-- news_articles.title — used by /api/pins?q=... (pins.ts:84)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_title_trgm
  ON news_articles USING GIN (title gin_trgm_ops);

-- news_articles.summary — used by /api/pins?q=... (pins.ts:85)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_summary_trgm
  ON news_articles USING GIN (summary gin_trgm_ops);
