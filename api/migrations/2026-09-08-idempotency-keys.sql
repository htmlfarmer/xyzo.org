-- Tier 1.2: idempotency keys on news_interactions + news_location_views
-- Audit 3: every retry currently doubles row counts → corrupts
-- interactions_24h, source rankings, and coverage analytics.
-- Client-generated UUID in the X-Idempotency-Key header dedups via
-- ON CONFLICT (idempotency_key) DO NOTHING.

-- Strategy: partial UNIQUE indexes, NOT a NOT-NULL column with a full
-- UNIQUE constraint. Rationale:
--   1. NULL values are excluded from unique indexes by default in
--      Postgres, so we DON'T need a backfill of legacy rows — they
--      simply don't participate in the index. New clients that send a
--      key get dedup behavior; legacy clients without a key keep
--      working unchanged.
--   2. CREATE UNIQUE INDEX CONCURRENTLY avoids an ACCESS EXCLUSIVE
--      lock on these tables (potentially millions of rows in prod).
--   3. No ALTER COLUMN ... SET NOT NULL — schema stays additive.

ALTER TABLE news_interactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS news_interactions_idem_uq
  ON news_interactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE news_location_views
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS news_location_views_idem_uq
  ON news_location_views (idempotency_key)
  WHERE idempotency_key IS NOT NULL;