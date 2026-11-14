-- How fast is the site, on whose machine, and why (2026-11-14).
--
-- Owner ask: *"we need someone on the server side to help us understand
-- how slow or how fast various situations are running on various
-- peoples browsers so we can log them and try and study them on what we
-- can do to speed it up for all users."*
--
-- Until now every performance number this project had came from lab
-- runs on one machine (scripts/map_speed_audit.py,
-- scripts/wind_perf_audit.py). Those found the wind's two defects — a
-- dt cap that halved the animation below 10 fps, and wide round-capped
-- strokes that cost 80 % of the layer's canvas time — but they cannot
-- answer the questions that decide what to build next: how many
-- readers are below 30 fps, whether Firefox really is slower on THEIR
-- machines, whether a fifteen-overlay shared link is the problem or an
-- old laptop is. `gpu` is the column that separates those: llvmpipe /
-- SwiftShader / Software means every pixel of every layer is painted by
-- the CPU, which is exactly the regime where one animated layer over a
-- deep overlay stack costs ~17 ms a frame (measured 2026-11-14).
--
-- TWO ROWS PER SESSION PER DAY: `settled` (the page at rest, 12 s
-- after the map appears) and `wind` (12 s after the wind switches on,
-- with the layer's own counts and how far the dots travelled). The
-- natural key makes the write idempotent, so a reader who opens two
-- tabs still counts once.
--
-- Nothing here identifies a person: browser and OS are PARSED from the
-- UA ("Firefox/153", "Linux") rather than stored raw, there is no IP
-- and no user-agent string, and `view` is the URL hash — the map the
-- reader built, which map_move already sends as a bbox.
-- `scripts/retention_prune.py` drops these with the other telemetry.
--
-- Applied 2026-11-14.

CREATE TABLE IF NOT EXISTS client_perf (
    id             BIGSERIAL   PRIMARY KEY,
    day            DATE        NOT NULL DEFAULT current_date,
    session_id     TEXT        NOT NULL,
    -- 'settled' = the page at rest; 'wind' = while the wind animates.
    phase          TEXT        NOT NULL,
    browser        TEXT,               -- 'Firefox/153' — parsed, never the raw UA
    os             TEXT,               -- Windows | macOS | Linux | Android | iOS | other
    device         TEXT,               -- phone | tablet | desktop
    hw_concurrency SMALLINT,
    dpr            NUMERIC(4, 2),
    viewport_w     INTEGER,
    viewport_h     INTEGER,
    -- How much map is being drawn: the overlay count is the lever a
    -- reader controls, the pane/canvas figures are what it turns into.
    overlay_count  SMALLINT,
    panes          SMALLINT,
    canvas_px      BIGINT,
    -- The renderer behind the canvas, or NULL where the browser will
    -- not say. This is the column that tells a CPU-rendered farm apart
    -- from a laptop with a GPU.
    gpu            TEXT,
    -- Our own fixed-shape canvas benchmark (ms per frame filling 120
    -- small circles), so canvas speed can be compared even where the
    -- browser exposes no renderer string.
    probe_ms       NUMERIC(7, 2),
    -- The page's frame cadence over an 8 s window.
    fps            NUMERIC(6, 1),
    frame_p50_ms   NUMERIC(7, 1),
    frame_p95_ms   NUMERIC(7, 1),
    frame_worst_ms NUMERIC(7, 1),
    long_tasks     INTEGER,            -- entries seen (0 where unsupported)
    long_busy_pct  NUMERIC(5, 1),      -- share of the window inside them
    -- The wind layer's own state, when it is on.
    wind           JSONB,
    -- Median on-screen speed of the live dot pool, px/s — the number
    -- behind "the wind dots don't move around very fast".
    dot_px_per_s   NUMERIC(7, 1),
    dcl_ms         INTEGER,
    load_ms        INTEGER,
    -- The map the reader had built (the URL hash, truncated).
    view           TEXT,
    reported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT client_perf_phase_check
        CHECK (phase IN ('settled', 'wind')),
    CONSTRAINT client_perf_device_check
        CHECK (device IS NULL OR device IN ('phone', 'tablet', 'desktop'))
);

-- THE NATURAL KEY: it is what makes the write idempotent — a retry, a
-- second tab or a reload within the same UTC day lands on the same row
-- instead of inflating the session count.
CREATE UNIQUE INDEX IF NOT EXISTS client_perf_natural_key
    ON client_perf (day, session_id, phase);

COMMENT ON TABLE client_perf IS
  'One row per session per day per phase: how fast the map actually ran
   in a real browser — frame cadence, long tasks, the renderer behind
   the canvas, how many overlays were on and how fast the wind dots
   moved. Grouped by browser/device/overlay-count by
   GET /api/analytics/perf.';

-- The report reads a window of days, grouped by a column.
CREATE INDEX IF NOT EXISTS client_perf_day ON client_perf (day);
CREATE INDEX IF NOT EXISTS client_perf_day_browser ON client_perf (day, browser);
CREATE INDEX IF NOT EXISTS client_perf_day_phase ON client_perf (day, phase);

-- THE APP USER, NOT JUST THE MIGRATION USER. Migrations run as a
-- superuser (peer auth), the API connects as `xyzo_app` — so without
-- this the very first write fails with "permission denied for
-- table client_perf", and because the route swallows write errors the
-- only trace is a line in the service log. Measured: 8 of 12 tests in
-- api/tests/client-perf.test.ts failed on it before the grant existed.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xyzo_app') THEN
        GRANT ALL ON client_perf TO xyzo_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xyzo_app;
    END IF;
END $$;
