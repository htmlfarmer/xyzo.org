-- Isobars: add a `source` column so two pressure analyses can be stored
-- side by side.
--
-- Why: ECMWF publishes its IFS control forecast at 0.1° (9 km) under
-- CC BY 4.0 with no key, while NOAA's GFS analysis at 0.25° (25 km) is
-- public domain but lands ~5 h earlier. Both are kept, each tagged, and
-- the API serves whichever analysis is actually newer for the viewport —
-- so the layer is never stuck on a stale cycle just because the finer
-- source publishes late.
--
-- The values are:
--   'ecmwf'  ECMWF IFS open data, MSL pressure, 0.1° global
--   'gfs'    NOAA NCEP GFS PRMSL analysis, 0.25° global
--
-- The DELETE in worker/isobars.py is scoped to the source, so one
-- source's refresh never wipes the other's lines.

ALTER TABLE weather_isobars
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'gfs';

-- The API filters on (source, level_hpa) and bbox-tests the geometry.
CREATE INDEX IF NOT EXISTS idx_weather_isobars_source_level
    ON weather_isobars (source, level_hpa);

GRANT SELECT ON weather_isobars TO xyzo_app;
