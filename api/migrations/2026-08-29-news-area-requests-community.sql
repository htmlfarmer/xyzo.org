-- Newsium: community voting for area coverage requests.
--
-- Phase 1 of the coverage-requests feature. Adds:
--   - request_source discriminator: 'recommend-news' (voteable) vs
--     'auto-discover' (legacy spawn, not voteable).
--   - community_status + confirm/reject vote counters + applied_at/job_id
--     (mirrors news_re_evaluate_requests community columns).
--   - news_area_request_votes (parallel to news_request_votes; FK intact).
--   - news_area_request_replies (parallel to news_request_replies; used in Phase 2).
--
-- All changes are additive + idempotent. Existing auto-discover rows are
-- backfilled via the request_source pattern match.

BEGIN;

-- Discriminator column.
ALTER TABLE news_area_requests
  ADD COLUMN IF NOT EXISTS request_source TEXT NOT NULL DEFAULT 'recommend-news'
    CHECK (request_source IN ('recommend-news', 'auto-discover'));

-- Backfill: existing auto-discover rows get tagged.
UPDATE news_area_requests
  SET request_source = 'auto-discover'
  WHERE message LIKE 'Auto-discovery triggered%'
    AND request_source = 'recommend-news';

-- Community columns (mirror news_re_evaluate_requests).
ALTER TABLE news_area_requests
  ADD COLUMN IF NOT EXISTS community_status TEXT DEFAULT 'open'
    CHECK (community_status IN ('open', 'validated', 'rejected', 'needs_info')),
  ADD COLUMN IF NOT EXISTS confirm_votes INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reject_votes INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS community_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_visible BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS applied_job_id UUID;

-- Votes table (parallel to news_request_votes).
CREATE TABLE IF NOT EXISTS news_area_request_votes (
    id          BIGSERIAL PRIMARY KEY,
    request_id  BIGINT NOT NULL REFERENCES news_area_requests(id) ON DELETE CASCADE,
    voter_ip    INET NOT NULL,
    vote        TEXT NOT NULL CHECK (vote IN ('confirm', 'reject', 'needs_info')),
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT news_area_request_votes_unique UNIQUE (request_id, voter_ip)
);
CREATE INDEX IF NOT EXISTS news_area_request_votes_request_idx
  ON news_area_request_votes (request_id);

-- Replies table (Phase 2 reads/writes it; created now to avoid later migration).
CREATE TABLE IF NOT EXISTS news_area_request_replies (
    id          BIGSERIAL PRIMARY KEY,
    request_id  BIGINT NOT NULL REFERENCES news_area_requests(id) ON DELETE CASCADE,
    reply_type  TEXT NOT NULL CHECK (reply_type IN ('admin', 'ai', 'system')),
    reply_text  TEXT NOT NULL,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_area_request_replies_request_idx
  ON news_area_request_replies (request_id);

-- Public-list index (voteable rows only).
CREATE INDEX IF NOT EXISTS news_area_requests_community_idx
  ON news_area_requests (public_visible, community_status, requested_at DESC)
  WHERE request_source = 'recommend-news';

COMMIT;