-- Performance indexes identified by XYZO audit
-- Adds composite indexes to eliminate seq scans on hot queries.

-- CRITICAL: source_rankings query was 443ms (SEQ_SCAN)
-- Covers: LEFT JOIN news_articles ON source_id + WHERE published_at > 7 days
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_source_pub
ON news_articles (source_id, published_at DESC)
WHERE published_at IS NOT NULL;

-- feed_hot_events was 50ms (SEQ_SCAN), now 3.4ms
-- Covers: ORDER BY source_count DESC, first_reported_at DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_events_feed_hot
ON news_events (status, source_count DESC, first_reported_at DESC);
