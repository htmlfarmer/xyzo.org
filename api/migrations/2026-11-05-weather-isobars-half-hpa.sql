-- The isobar detail goes down to 0.5 hPa.
--
-- `level_hpa` was INTEGER, so 1000.5 could not be stored and the
-- finest set was 1 hPa. The isobars are the field's own contours, and
-- a finer interval is the SAME chart with more lines in it — measured
-- on the 2026-11-05 00Z GFS analysis, the share of lines shorter than
-- 20° is 54.8 % at 1 hPa and 55.0 % at 0.5 hPa (under 5°: 20.0 %
-- against 19.5 %). The noise lives in the field, not in the interval,
-- and now it is proven at half a hPa too.
--
-- REAL holds 1000.5 exactly (it is 2001/2, within float4's 24-bit
-- mantissa) and keeps the existing index on (source, level_hpa)
-- working. The ~2,200 existing rows are integers and convert without
-- a value change.
--
-- Applied 2026-11-05. Run:
--   psql "$XYZO_DB_DSN" -f api/migrations/2026-11-05-weather-isobars-half-hpa.sql

ALTER TABLE weather_isobars ALTER COLUMN level_hpa TYPE REAL USING level_hpa::real;

COMMENT ON COLUMN weather_isobars.level_hpa IS
  'The isobar value in hPa. REAL rather than INTEGER: the finest set
   published is 0.5 hPa (see worker/isobars.py ISO_INTERVAL_HPA).';
