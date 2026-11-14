-- Performance indexes for query optimization
-- These indexes support the most common query patterns in the XYZO platform

-- ── news_articles indexes ───────────────────────────────────────────────────

-- Composite index for pins.ts map queries (status + location)
-- Covers: WHERE status = 'extracted' AND location_id IS NOT NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_status_location
  ON news_articles (status, location_id)
  WHERE location_id IS NOT NULL;

-- Composite index for cluster.py unclustered article fetching
-- Covers: WHERE status = 'extracted' AND clustered_at IS NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_unclustered
  ON news_articles (status, clustered_at ASC NULLS FIRST)
  WHERE status = 'extracted' AND clustered_at IS NULL;

-- Partial index for saturation calculation in fetch.py
-- Note: Cannot use now() in partial index predicate (not immutable).
-- Use a regular index instead; the WHERE clause helps for status filtering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_source_7d
  ON news_articles (source_id)
  WHERE status = 'extracted';

-- Index for articles with native coordinates (bypass geocoding)
-- Covers: WHERE extracted_lat IS NOT NULL OR extracted_lng IS NOT NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_native_coords
  ON news_articles (extracted_lat, extracted_lng)
  WHERE extracted_lat IS NOT NULL OR extracted_lng IS NOT NULL;

-- Composite index for pins map with coordinates fallback
-- Covers the COALESCE(a.extracted_lat, l.lat) pattern in pins.ts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_extracted_coords
  ON news_articles (extracted_lat, extracted_lng)
  WHERE extracted_lat IS NOT NULL AND extracted_lng IS NOT NULL;

-- ── news_events indexes ────────────────────────────────────────────────────

-- Composite index for feed/live hot ranking query
-- Covers: WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
-- Note: Cannot use now() in partial index predicate. Use regular composite index instead.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_events_active_hot
  ON news_events (status, first_reported_at DESC, source_count DESC, id DESC)
  WHERE status = 'active';

-- Index for location-based event queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_events_primary_location
  ON news_events (primary_location_id, status, expires_at)
  WHERE status = 'active';

-- Index for event type filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_events_type_active
  ON news_events (event_type, status, first_reported_at DESC)
  WHERE status = 'active';

-- ── news_story_links indexes ───────────────────────────────────────────────

-- Index for feed/links edge queries by strength
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_story_links_strength
  ON news_story_links (link_strength DESC)
  WHERE link_strength >= 0.5;

-- Composite index for source article lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_story_links_source
  ON news_story_links (source_article_id, link_strength DESC);

-- ── news_event_sources indexes ─────────────────────────────────────────────

-- Index for event article lookups (used in cluster rollup)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_event_sources_event
  ON news_event_sources (event_id);

-- ── news_article_topics indexes ───────────────────────────────────────────

-- Index for article topic lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_article_topics_article
  ON news_article_topics (article_id);

-- ── Analyze tables after index creation ────────────────────────────────────
-- Note: CONCURRENTLY avoids locking but ANALYZE should be run manually after
-- Run: SELECT analyze_tables(); or manually ANALYZE each table
