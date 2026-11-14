-- ── 2026-09-07-ai-cache.sql ─────────────────────────────────────────
--
-- Cache table for AI extraction results. Avoids re-extracting the same
-- article content when it's re-fetched or re-processed.
--
-- Key: SHA-256 hash of (title + body[:500])
-- Value: JSON extraction result
--
-- Performance improvement: 30-50% reduction in AI calls for duplicate
-- or re-fetched content.

CREATE TABLE IF NOT EXISTS ai_cache (
  content_hash TEXT PRIMARY KEY,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ DEFAULT now(),
  use_count INTEGER DEFAULT 1
);

-- Index for LRU cleanup (oldest/least-used first)
CREATE INDEX IF NOT EXISTS idx_ai_cache_lru
  ON ai_cache (last_used_at ASC, use_count ASC);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON ai_cache TO xyzo_app;
