-- Isobars: pressure contour lines for the map's "⛅ Pressure lines" layer.
--
-- Source: NOAA NCEP GFS mean sea-level pressure (PRMSL) analysis, 1° global.
-- The worker (worker/isobars.py) contours the MSLP field with marching
-- squares at 1 hPa intervals (the finest set it publishes — the API
-- thins it to the detail step the reader picked) and replaces the whole
-- table inside a single transaction, so a reader always sees one
-- consistent analysis.
--
-- One row per contour polyline. `level_hpa` is the isobar value (1012)
-- and `geom` is the line itself. `run_time` is the GFS analysis cycle the
-- lines were derived from — the API returns it so the map can say which
-- forecast run it is drawing.

CREATE TABLE IF NOT EXISTS weather_isobars (
    id          BIGSERIAL PRIMARY KEY,
    level_hpa   INTEGER NOT NULL,
    geom        GEOMETRY(LINESTRING, 4326) NOT NULL,
    run_time    TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GEOMETRY, not GEOGRAPHY: these lines are only ever bbox-tested and
-- drawn, and PostGIS's geography `&&` operator computes a *geodesic*
-- bounding box. For a viewport wider than the globe it raises
-- "Antipodal (180 degrees long) edge detected!" or silently returns a
-- handful of rows instead of the whole world. Plain geometry has no such
-- edge case, and the GIST index below can serve it.
CREATE INDEX IF NOT EXISTS idx_weather_isobars_geom
    ON weather_isobars USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_weather_isobars_level
    ON weather_isobars (level_hpa);
CREATE INDEX IF NOT EXISTS idx_weather_isobars_run
    ON weather_isobars (run_time DESC);

ALTER TABLE weather_isobars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_isobars_all ON weather_isobars;
CREATE POLICY weather_isobars_all ON weather_isobars
    FOR ALL TO xyzo_app USING (true) WITH CHECK (true);

GRANT SELECT ON weather_isobars TO xyzo_app;
