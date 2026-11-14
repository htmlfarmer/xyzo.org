-- newsium schema-feed-submissions.sql — track user-submitted news source URLs.
-- Idempotent: safe to re-run during development.
--
-- Submissions go through this table BEFORE any feeds.json entry is touched.
-- The API runs robots.txt + RSS fetch + Gemma-4 verdict and stores the
-- result here so an admin can review and approve.

CREATE TABLE IF NOT EXISTS feed_submissions (
    id                BIGSERIAL PRIMARY KEY,
    submitter_name    TEXT NOT NULL,
    submitter_email   TEXT NOT NULL,
    source_name       TEXT NOT NULL,
    feed_url          TEXT NOT NULL,
    robots_status     TEXT NOT NULL CHECK (robots_status IN (
                        'allow',          -- robots.txt explicitly allows
                        'absent',         -- no robots.txt found (we treat as allow)
                        'disallow',       -- robots.txt disallows us on the feed path
                        'unreachable',    -- could not fetch robots.txt
                        'unknown'         -- not yet checked (pending submission)
                      )),
    robots_crawl_delay_s  DOUBLE PRECISION,
    robots_blocked_path   TEXT,
    rss_status        TEXT NOT NULL CHECK (rss_status IN (
                        'ok',             -- feed fetched and parsed
                        'http_error',     -- non-2xx HTTP response
                        'parse_error',    -- response was not a feed
                        'empty',          -- feed parsed but had no entries
                        'fetch_error',    -- network error
                        'unknown'         -- not yet checked
                      )),
    rss_articles_parsed INT NOT NULL DEFAULT 0,
    rss_sample_chars  INT,                 -- chars of the longest sample body
    ai_verdict        TEXT CHECK (ai_verdict IN (
                        'full',           -- RSS body contains the article
                        'partial',        -- RSS is a partial subset
                        'truncated',      -- RSS is mid-sentence truncation
                        'summary',        -- RSS is a marketing blurb only
                        'no_web',         -- couldn't fetch sample webpage (often paywall)
                        'unsure'          -- AI didn't return a clear label
                      )),
    ai_reason         TEXT,                -- one-sentence justification from Gemma-4
    final_verdict     TEXT NOT NULL CHECK (final_verdict IN (
                        'pass',           -- robots OK + RSS has full text → ready for admin review
                        'warn',           -- some red flags; admin should look closer
                        'fail',           -- blocked or short; cannot accept
                        'pending',        -- validation not yet completed
                        'error'           -- pipeline errored
                      )),
    final_reason      TEXT,                -- human-readable summary for the admin
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending',        -- just submitted, awaiting validation result
                        'reviewed',       -- validation completed, awaiting admin decision
                        'approved',       -- admin approved; feeds.json updated
                        'rejected',       -- admin rejected
                        'duplicate'       -- already exists in news_sources / feeds.json
                      )),
    admin_notes       TEXT,
    approved_at       TIMESTAMPTZ,
    ip_address        TEXT,
    user_agent        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feed_url_unique UNIQUE (feed_url)
);

CREATE INDEX IF NOT EXISTS feed_submissions_status_idx ON feed_submissions (status);
CREATE INDEX IF NOT EXISTS feed_submissions_created_idx ON feed_submissions (created_at DESC);

DROP TRIGGER IF EXISTS feed_submissions_updated_at ON feed_submissions;
CREATE TRIGGER feed_submissions_updated_at BEFORE UPDATE ON feed_submissions
    FOR EACH ROW EXECUTE FUNCTION xyzo_set_updated_at();
