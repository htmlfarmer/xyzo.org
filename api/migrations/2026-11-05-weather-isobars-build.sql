-- What was BUILT, so a build with different parameters is a different
-- build.
--
-- The no-op guard in worker/isobars.py compares the published RUN_TIME
-- and the PRODUCT. Both are about the analysis; neither says anything
-- about HOW it was cut. On 2026-11-05 the contour interval moved from
-- 1 hPa to 0.5 hPa — the cycle and the product were unchanged, so the
-- guard declared "already published" and the finer set never shipped.
--
-- The interval is a build parameter, so it is recorded as one row per
-- source. Any future parameter (a different smoothing, a different
-- simplification) belongs here too.
--
-- Applied 2026-11-05.

CREATE TABLE IF NOT EXISTS weather_isobars_build (
    source       TEXT PRIMARY KEY,
    run_time     TIMESTAMPTZ NOT NULL,
    interval_hpa REAL NOT NULL,
    built        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE weather_isobars_build IS
  'The parameters each source was last built with, so the worker can
   tell "nothing has changed" from "the same cycle, cut differently".';

-- Seed both rows from what is published now, so the first tick after
-- this migration does not re-contour the world for no reason.
INSERT INTO weather_isobars_build (source, run_time, interval_hpa, built)
SELECT source, MAX(run_time), 1, now()
FROM weather_isobars
GROUP BY source
ON CONFLICT (source) DO NOTHING;
