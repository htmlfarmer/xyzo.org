-- Global shutdown system
-- Allows verified humans to temporarily shut down the site if >10% of
-- active users complain via the help page.
--
-- The shutdown_state table tracks:
--   - Whether the site is currently shut down
--   - How many complaints have been filed
--   - Estimated active users (from analytics)
--   - When shutdown happened and why
--
-- The complaints table logs individual complaints with timestamps
-- so we can calculate the 10% threshold over a rolling window.

CREATE TABLE IF NOT EXISTS shutdown_state (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    is_shutdown     BOOLEAN NOT NULL DEFAULT FALSE,
    complaint_count INTEGER NOT NULL DEFAULT 0,
    active_users_estimate INTEGER NOT NULL DEFAULT 0,
    shutdown_at     TIMESTAMPTZ,
    shutdown_reason TEXT,
    reset_at        TIMESTAMPTZ,
    reset_by        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Only one row allowed (enforced by CHECK constraint)
    CONSTRAINT single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS shutdown_complaints (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT,
    complaint_text  TEXT,
    user_agent      TEXT,
    ip_address      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for rolling window queries (last 24h complaints)
CREATE INDEX IF NOT EXISTS idx_shutdown_complaints_created
    ON shutdown_complaints (created_at);

-- Seed the single row
INSERT INTO shutdown_state (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;

-- ── Helper function: check if shutdown is active ──
CREATE OR REPLACE FUNCTION is_site_shutdown()
RETURNS BOOLEAN AS $$
    SELECT is_shutdown FROM shutdown_state WHERE id = 1;
$$ LANGUAGE sql STABLE;

-- ── Helper function: get complaint stats ──
CREATE OR REPLACE FUNCTION shutdown_stats()
RETURNS TABLE(
    is_shutdown BOOLEAN,
    complaints_24h BIGINT,
    active_users INTEGER,
    threshold_pct NUMERIC,
    should_shutdown BOOLEAN
) AS $$
    SELECT
        s.is_shutdown,
        (SELECT COUNT(*) FROM shutdown_complaints
         WHERE created_at > now() - INTERVAL '24 hours') AS complaints_24h,
        s.active_users_estimate AS active_users,
        CASE WHEN s.active_users_estimate > 0
            THEN ROUND((SELECT COUNT(*) FROM shutdown_complaints
                        WHERE created_at > now() - INTERVAL '24 hours')::NUMERIC
                       / s.active_users_estimate * 100, 1)
            ELSE 0
        END AS threshold_pct,
        CASE WHEN s.active_users_estimate > 0
            THEN (SELECT COUNT(*) FROM shutdown_complaints
                  WHERE created_at > now() - INTERVAL '24 hours')::NUMERIC
                 / s.active_users_estimate > 0.10
            ELSE FALSE
        END AS should_shutdown
    FROM shutdown_state s
    WHERE s.id = 1;
$$ LANGUAGE sql STABLE;
