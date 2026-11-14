-- 2026-09-17-feedback-source-suggestions.sql
-- Create the feedback_source_suggestions table that backs POST /api/feedback/source-suggestion.
-- Users can submit news source URLs they want added to the map, along with optional
-- context (source name, country, description).

CREATE TABLE IF NOT EXISTS feedback_source_suggestions (
  id            bigserial PRIMARY KEY,
  source_url    text NOT NULL,
  source_name   text,
  country_code  text,
  description   text,
  session_id    text,
  requester_ip  inet,
  user_agent    text,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'reviewed', 'approved', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_source_suggestions_time_idx
  ON feedback_source_suggestions (created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_source_suggestions_status_idx
  ON feedback_source_suggestions (status, created_at DESC);

GRANT SELECT, INSERT ON feedback_source_suggestions TO xyzo_app;
GRANT USAGE, SELECT ON SEQUENCE feedback_source_suggestions_id_seq TO xyzo_app;
