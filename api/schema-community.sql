-- Newsium community validation migration. Additive, idempotent.
--
-- Adds:
--   - news_request_votes: community votes on location correction requests
--   - news_request_replies: admin/AI replies to requests
--   - Extended news_re_evaluate_requests with community fields

-- Community votes on location correction requests
CREATE TABLE IF NOT EXISTS news_request_votes (
    id              BIGSERIAL PRIMARY KEY,
    request_id      BIGINT NOT NULL REFERENCES news_re_evaluate_requests(id) ON DELETE CASCADE,
    voter_ip        INET NOT NULL,
    vote            TEXT NOT NULL CHECK (vote IN ('confirm', 'reject', 'needs_info')),
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One vote per IP per request
    CONSTRAINT news_request_votes_unique UNIQUE (request_id, voter_ip)
);
CREATE INDEX IF NOT EXISTS news_request_votes_request_idx ON news_request_votes (request_id);
CREATE INDEX IF NOT EXISTS news_request_votes_vote_idx ON news_request_votes (vote);

-- Admin/AI replies to requests
CREATE TABLE IF NOT EXISTS news_request_replies (
    id              BIGSERIAL PRIMARY KEY,
    request_id      BIGINT NOT NULL REFERENCES news_re_evaluate_requests(id) ON DELETE CASCADE,
    reply_type      TEXT NOT NULL CHECK (reply_type IN ('admin', 'ai', 'system')),
    reply_text      TEXT NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_request_replies_request_idx ON news_request_replies (request_id);

-- Add community validation fields to news_re_evaluate_requests
ALTER TABLE news_re_evaluate_requests
    ADD COLUMN IF NOT EXISTS community_status TEXT DEFAULT 'open'
        CHECK (community_status IN ('open', 'validated', 'rejected', 'needs_info', 'auto_applied')),
    ADD COLUMN IF NOT EXISTS confirm_votes INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reject_votes INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS community_validated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS public_visible BOOLEAN NOT NULL DEFAULT TRUE;

-- Index for public requests page
CREATE INDEX IF NOT EXISTS news_re_evaluate_requests_public_idx
    ON news_re_evaluate_requests (public_visible, community_status, requested_at DESC);

-- View for public requests with vote counts
CREATE OR REPLACE VIEW public_requests AS
SELECT
    r.id,
    r.pin_id,
    r.article_id,
    r.kind,
    r.user_place,
    r.status,
    r.result,
    r.requested_at,
    r.completed_at,
    r.community_status,
    r.confirm_votes,
    r.reject_votes,
    a.title AS article_title,
    a.url AS article_url,
    a.location_text AS original_location,
    l.place_name AS original_place_name,
    l.country AS original_country,
    l.lat AS original_lat,
    l.lng AS original_lng,
    (r.result->>'lat')::double precision AS suggested_lat,
    (r.result->>'lng')::double precision AS suggested_lng,
    (r.result->>'place_name') AS suggested_place_name,
    (r.result->>'precision') AS suggested_precision,
    (r.result->>'confidence')::float AS suggested_confidence,
    (r.result->>'applied')::boolean AS was_applied
FROM news_re_evaluate_requests r
LEFT JOIN news_articles a ON a.id = r.article_id
LEFT JOIN news_locations l ON l.id = a.location_id
WHERE r.public_visible = TRUE
  AND r.kind = 'suggest_location'
ORDER BY r.requested_at DESC;
