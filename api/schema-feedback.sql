-- Newsium geocoding-feedback migration. Additive, idempotent.
--
-- Adds:
--   - news_articles.suggested_lat / suggested_lng / suggested_* /
--     re_evaluated_at / re_evaluation_reasoning
--   - news_locations.learned_from_user_count (so future runs can pick the
--     user-confirmed ones first)
--   - news_re_evaluate_requests: lightweight queue of geocoding tasks
--     triggered by either 're-evaluate' (open-ended) or 'suggest-location'
--     (with a user-supplied place). Run by the worker asynchronously.

ALTER TABLE news_articles
    ADD COLUMN IF NOT EXISTS suggested_lat             DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS suggested_lng             DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS suggested_place_name      TEXT,
    ADD COLUMN IF NOT EXISTS suggested_confidence      FLOAT,
    ADD COLUMN IF NOT EXISTS suggested_country         TEXT,
    ADD COLUMN IF NOT EXISTS suggested_precision        TEXT,
    ADD COLUMN IF NOT EXISTS suggested_reasoning       TEXT,
    ADD COLUMN IF NOT EXISTS re_evaluated_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS re_evaluation_reasoning   TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'news_articles_suggested_precision_check'
    ) THEN
        ALTER TABLE news_articles
            ADD CONSTRAINT news_articles_suggested_precision_check
            CHECK (suggested_precision IS NULL
                   OR suggested_precision IN ('exact','city','region','country'));
    END IF;
END$$;

ALTER TABLE news_locations
    ADD COLUMN IF NOT EXISTS learned_from_user_count  INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS news_re_evaluate_requests (
    id              BIGSERIAL PRIMARY KEY,
    pin_id          BIGINT NOT NULL,
    article_id      BIGINT,
    kind            TEXT NOT NULL CHECK (kind IN ('re_evaluate','suggest_location')),
    user_place      TEXT,                          -- only set for kind='suggest_location'
    requester_ip    INET,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','failed','skipped')),
    result          JSONB,
    error_message   TEXT,
    -- Run at most once per (article_id, kind, user_place). Repeated identical
    -- submissions from one client collapse into a single worker call.
    dedup_key       TEXT GENERATED ALWAYS AS (
        COALESCE(article_id::text, 'p:' || pin_id::text) || ':' || kind ||
        COALESCE(':' || lower(user_place), '')
    ) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS news_re_evaluate_requests_dedup_key
    ON news_re_evaluate_requests (dedup_key)
    WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS news_re_evaluate_requests_status_idx
    ON news_re_evaluate_requests (status, requested_at)
    WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS news_re_evaluate_requests_pin_idx
    ON news_re_evaluate_requests (pin_id);

-- ── Link feedback ──────────────────────────────────────────────────────
-- Stores user feedback on story connections (edges) and user-created links.
-- kind: 'remove' (user says link is wrong), 'add' (user created a manual link)
-- link_type: 'story' (story-to-story), 'location' (story-to-location)

CREATE TABLE IF NOT EXISTS news_link_feedback (
    id              BIGSERIAL PRIMARY KEY,
    event_a         BIGINT NOT NULL,
    event_b         BIGINT,                          -- NULL for story-to-location links
    location_id     BIGINT,                          -- set for story-to-location links
    kind            TEXT NOT NULL CHECK (kind IN ('remove', 'add')),
    link_type       TEXT NOT NULL CHECK (link_type IN ('story', 'location')),
    reason          TEXT,                            -- optional user explanation
    requester_ip    INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'dismissed', 'applied'))
);
CREATE INDEX IF NOT EXISTS news_link_feedback_events_idx
    ON news_link_feedback (event_a, event_b);
CREATE INDEX IF NOT EXISTS news_link_feedback_status_idx
    ON news_link_feedback (status, created_at);
