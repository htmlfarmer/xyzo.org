-- Add columns for tracking unsatisfied searches and auto-discovery.
-- When a search returns few results, the system logs it and can
-- trigger DuckDuckGo news search + source discovery in the background.
ALTER TABLE news_search_log
  ADD COLUMN IF NOT EXISTS unsatisfied BOOLEAN GENERATED ALWAYS AS (
    result_count IS NOT NULL AND result_count < 5
  ) STORED,
  ADD COLUMN IF NOT EXISTS discovery_triggered BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS discovery_results JSONB;

CREATE INDEX IF NOT EXISTS idx_search_log_unsatisfied
  ON news_search_log (created_at DESC)
  WHERE unsatisfied = TRUE AND discovery_triggered = FALSE;
