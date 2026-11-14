-- Newsium "Recommend News" feature migration.
-- Allows users to request AI-powered news discovery for a geographic area.

CREATE TABLE IF NOT EXISTS news_area_requests (
    id              BIGSERIAL PRIMARY KEY,
    -- Geographic bounds (bbox from map view)
    bbox_min_lat    DOUBLE PRECISION NOT NULL,
    bbox_min_lng    DOUBLE PRECISION NOT NULL,
    bbox_max_lat    DOUBLE PRECISION NOT NULL,
    bbox_max_lng    DOUBLE PRECISION NOT NULL,
    -- Center point (for quick distance queries)
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    -- Map context at time of request
    map_zoom        INT,
    -- User context
    session_id      TEXT,
    requester_ip    INET,
    -- Optional user message
    message         TEXT,
    -- Request metadata
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Processing status
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dismissed')),
    -- AI processing results
    processed_at    TIMESTAMPTZ,
    result          JSONB,
    error_message   TEXT
);

-- Index for processing queue
CREATE INDEX IF NOT EXISTS news_area_requests_status_idx
    ON news_area_requests (status, requested_at)
    WHERE status IN ('pending', 'processing');

-- Index for geographic queries (center point)
CREATE INDEX IF NOT EXISTS news_area_requests_geo_idx
    ON news_area_requests (center_lat, center_lng);

-- Index for session lookups
CREATE INDEX IF NOT EXISTS news_area_requests_session_idx
    ON news_area_requests (session_id, requested_at DESC);
