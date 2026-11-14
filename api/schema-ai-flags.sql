-- Schema for AI-assisted flag reports
-- Tracks AI analysis and auto-fix actions from the Quick Flag dialog

CREATE TABLE IF NOT EXISTS ai_flag_reports (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What the user reported
  report_type   TEXT NOT NULL,           -- wrong_location, misleading, etc.
  user_reason   TEXT,                    -- User's optional description
  session_id    TEXT,

  -- Article context (null if user reported area without specific pin)
  article_id    BIGINT,                  -- NULL if viewport-only report
  article_title TEXT,
  article_url   TEXT,

  -- Viewport context when no specific pin
  viewport_lat  DOUBLE PRECISION,
  viewport_lng  DOUBLE PRECISION,
  viewport_zoom INTEGER,

  -- AI analysis result
  ai_response   TEXT NOT NULL,          -- What the AI said
  ai_action     TEXT NOT NULL,          -- 'auto_fixed', 'replied', 'needs_review'
  ai_confidence DOUBLE PRECISION,       -- 0-1 confidence score

  -- What the AI changed (if auto_fixed)
  fix_type      TEXT,                   -- 'location', 'hidden', 'replaced', etc.
  fix_old_value JSONB,                  -- Previous value(s)
  fix_new_value JSONB,                  -- New value(s)

  ip_address    INET
);

CREATE INDEX IF NOT EXISTS idx_ai_flag_reports_created_at ON ai_flag_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_flag_reports_article_id ON ai_flag_reports (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_flag_reports_report_type ON ai_flag_reports (report_type);
CREATE INDEX IF NOT EXISTS idx_ai_flag_reports_ai_action ON ai_flag_reports (ai_action);
