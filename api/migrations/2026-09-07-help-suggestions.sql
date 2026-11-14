-- Help suggestions table for user feedback
CREATE TABLE IF NOT EXISTS help_suggestions (
  id BIGSERIAL PRIMARY KEY,
  suggestion TEXT NOT NULL,
  context JSONB,
  user_ip TEXT,
  user_agent TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'implemented', 'declined')),
  ai_analysis TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_help_suggestions_status ON help_suggestions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_help_suggestions_created ON help_suggestions (created_at DESC);

-- Grant permissions
GRANT SELECT, INSERT ON help_suggestions TO xyzo_app;
GRANT USAGE ON SEQUENCE help_suggestions_id_seq TO xyzo_app;
