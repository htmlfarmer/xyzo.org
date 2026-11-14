-- 2026-09-06-feedback-bug-reports.sql
-- Create the feedback_bug_reports table that backs POST /api/feedback/bug-report.
-- The endpoint is called from the main map UI (app.js:12087) and the /help admin
-- page (help/index.html:1547). Captures the bug_type, free-text description, and
-- an optional map_context JSON blob (viewport, user agent, session id, …) for
-- diagnostics. requester_ip + user_agent allow us to correlate with server logs.
--
-- Idempotent: skip if table already exists.

CREATE TABLE IF NOT EXISTS feedback_bug_reports (
  id            bigserial PRIMARY KEY,
  bug_type      text NOT NULL,
  description   text NOT NULL,
  map_context   jsonb,
  session_id    text,
  requester_ip  inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_bug_reports_time_idx
  ON feedback_bug_reports (created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_bug_reports_type_idx
  ON feedback_bug_reports (bug_type, created_at DESC);

-- Grant access to the app role (matches the standing constraint in HANDOFF §3.5).
GRANT SELECT, INSERT ON feedback_bug_reports TO xyzo_app;
GRANT USAGE, SELECT ON SEQUENCE feedback_bug_reports_id_seq TO xyzo_app;
