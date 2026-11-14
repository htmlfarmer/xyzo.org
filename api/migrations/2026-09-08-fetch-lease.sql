-- ── 2026-09-08-fetch-lease.sql ─────────────────────────────────────────
--
-- Audit 4 finding (closed by Tier 1.5): fetch.py claims a row from
-- news_sources via UPDATE ... RETURNING + CTE, but the WHERE clause
-- only filters by tier-based politeness floor. For non-protected
-- tiers (commercial + community) that filter is always TRUE, so two
-- workers running the same claim query can both UPDATE the same row
-- before either commits. End result: duplicate fetch + duplicate INSERT
-- attempts on news_articles for the same source within the same cycle.
--
-- Fix: add explicit per-source "in-flight" lease state, separate from
-- ``last_polled_at`` (which remains the polite-floor timestamp).
--
-- | column            | type         | role                                      |
-- |-------------------|--------------|-------------------------------------------|
-- | fetch_in_progress | bool         | one row per claim; TRUE = being fetched   |
-- | lease_token       | text         | uuid string written by claimer            |
-- | lease_expires_at  | timestamptz  | now() + '5 min' on claim; lets another    |
-- |                   |              | worker pick up after a crashed worker's   |
-- |                   |              | lease auto-expires                        |
--
-- The claim CTE (in worker/fetch.py) gains:
--   AND (fetch_in_progress = FALSE OR lease_expires_at < now())
-- so crashed-worker leases self-heal after 5 min, AND
--   FOR UPDATE SKIP LOCKED
-- in the inner SELECT so two workers racing the same query see a
-- disjoint subset of claimable rows.
--
-- The release (worker/fetch.py, end of each fetch_one call) is:
--   UPDATE news_sources
--      SET fetch_in_progress=FALSE, lease_token=NULL, lease_expires_at=NULL
--    WHERE id = $1 AND lease_token = $2
-- The ``lease_token`` predicate is the CAS — if our lease was already
-- reassigned (token-rotated) by someone else, our release is a no-op
-- instead of stomping on the active claim.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- GRANT to xyzo_app (HANDOFF §3.5, AGENTS.md "Database Rules").

ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS fetch_in_progress BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Partial index for the claim CTE — sources that are due AND not
-- currently leased. Smaller than a full index; the claim query is
-- the only call site that filters on this shape.
CREATE INDEX IF NOT EXISTS news_sources_claim_idx
  ON news_sources (last_polled_at NULLS FIRST, id)
  WHERE active = TRUE
    AND deleted_at IS NULL
    AND fetch_in_progress = FALSE;

-- The release path filters by ``lease_token`` (a high-cardinality
-- string). Without this index a worker would table-scan news_sources
-- on every fetch completion.
CREATE INDEX IF NOT EXISTS news_sources_lease_token_idx
  ON news_sources (lease_token)
  WHERE lease_token IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON news_sources TO xyzo_app;
