-- 2026-09-07-tier-fn.sql
--
-- Tier classifier as a SQL function (Step 3 of Smart Publish-Time Predictor plan).
--
-- Mirrors worker/robots.py:tier_for_url() and worker/robots.py:_GOV_TLDS /
-- _EDU_TLDS / _COMMUNITY_TLDS. The two implementations MUST stay in sync —
-- if you change one, change the other and add a CI check (see plan TODO).
--
-- IMMUTABLE + PARALLEL SAFE: pure function over its input, no I/O,
-- no DB access. Postgres can call this in parallel workers.
--
-- Used by:
--   - worker/fetch.py:446 gate CTE (claim with politeness floor)
--   - any future SQL dashboard that wants to slice
--     source_poll_observations by politeness tier

CREATE OR REPLACE FUNCTION tier_for_url_inline(url text) RETURNS text AS $$
  SELECT CASE
    WHEN url ~* '\.(gov|mil|gc\.ca|gov\.[a-z]{2}|gouv\.[a-z]{2}|go\.jp|gob\.es|gov\.au|govt\.nz)(/|$)'
      THEN 'gov'
    WHEN url ~* '\.(edu|ac\.[a-z]{2})(/|$)'
      THEN 'university'
    WHEN url ~* '\.(org|ngo|museum|foundation)(/|$)'
      THEN 'community'
    ELSE 'commercial'
  END;
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

GRANT EXECUTE ON FUNCTION tier_for_url_inline(text) TO xyzo_app;
