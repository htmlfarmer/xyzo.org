-- 2026-09-26: value-weighted fetch-backoff columns (worker/fetch.py CLAIM_SQL + update_source)
-- next_retry_at: don't re-poll a failing source until this time. Delay =
--   clamp(1d * 2^consecutive_failures, ≤8d) / reliability_boost, floor 4h.
-- consecutive_failures: reset to 0 on any success.
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

-- Claim gate benefits from a partial index (most rows have NULL next_retry_at,
-- so this stays tiny — only backed-off rows are indexed).
CREATE INDEX IF NOT EXISTS news_sources_next_retry_idx
    ON news_sources (next_retry_at) WHERE next_retry_at IS NOT NULL;

-- learn.update_source_keywords() was an idle-in-transaction DDL blocker;
-- its DELETE ... WHERE source_id = %s scans were quadratic without this.
CREATE INDEX IF NOT EXISTS news_source_keywords_source_idx
    ON news_source_keywords (source_id);
