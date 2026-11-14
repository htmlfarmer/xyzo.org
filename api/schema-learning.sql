-- Newsium learning schema. Additive, idempotent.
--
-- Adds three tables that close the "search → observe → learn" loop:
--
--   1. news_fetch_decisions
--      Per (cycle, source) record of what the learner decided: tier,
--      score, interval, and the reasoning it used. This is the audit log.
--      Useful for "why did this source get fetched less often last week?"
--
--   2. news_coverage_gaps
--      Per-country gap score over time. Computed from population vs.
--      source count vs. recent event yield. The learner reads this to
--      bump underrepresented regions without hardcoded priority lists.
--
--   3. news_extraction_feedback
--      Per-article record of what the extractor produced vs. what made
--      it to a publishable event. Geocode failures, country-name
--      normalization misses, and re-evaluation outcomes land here so
--      the learner can flag recurring prompt issues.

CREATE TABLE IF NOT EXISTS news_fetch_decisions (
    id                BIGSERIAL PRIMARY KEY,
    cycle_id          TEXT NOT NULL,                 -- uuid of the run.sh cycle
    source_id         BIGINT REFERENCES news_sources(id) ON DELETE CASCADE,
    source_name       TEXT NOT NULL,
    country           TEXT,
    decision          TEXT NOT NULL CHECK (decision IN
                          ('priority','deprioritize','hold','promote','demote')),
    tier              TEXT NOT NULL CHECK (tier IN ('critical','high','medium','low','paused')),
    score             DOUBLE PRECISION NOT NULL,     -- composite 0..1
    poll_interval_s   INT NOT NULL,
    reliability       DOUBLE PRECISION NOT NULL,
    yield_24h         INT NOT NULL DEFAULT 0,        -- articles inserted in last 24h
    yield_events_24h  INT NOT NULL DEFAULT 0,        -- articles that became events
    error_count       INT NOT NULL DEFAULT 0,
    reasons           JSONB NOT NULL DEFAULT '[]',   -- list of contributing factor strings
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_fetch_decisions_source_idx
    ON news_fetch_decisions (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS news_fetch_decisions_cycle_idx
    ON news_fetch_decisions (cycle_id);
CREATE INDEX IF NOT EXISTS news_fetch_decisions_tier_idx
    ON news_fetch_decisions (tier, created_at DESC);


CREATE TABLE IF NOT EXISTS news_coverage_gaps (
    id                BIGSERIAL PRIMARY KEY,
    cycle_id          TEXT NOT NULL,
    country_code      TEXT NOT NULL,                 -- ISO-3166-1 alpha-2 or '?'
    country_name      TEXT,
    population        BIGINT,                        -- millions, from reference table
    source_count      INT NOT NULL DEFAULT 0,
    active_sources    INT NOT NULL DEFAULT 0,
    articles_24h      INT NOT NULL DEFAULT 0,
    events_24h        INT NOT NULL DEFAULT 0,
    events_per_million_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
    gap_score         DOUBLE PRECISION NOT NULL,     -- higher = more underrepresented
    priority_boost    DOUBLE PRECISION NOT NULL,     -- multiplier for next cycle
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, country_code)
);

CREATE INDEX IF NOT EXISTS news_coverage_gaps_score_idx
    ON news_coverage_gaps (gap_score DESC);
CREATE INDEX IF NOT EXISTS news_coverage_gaps_cycle_idx
    ON news_coverage_gaps (cycle_id);


CREATE TABLE IF NOT EXISTS news_extraction_feedback (
    id                BIGSERIAL PRIMARY KEY,
    cycle_id          TEXT NOT NULL,
    article_id        BIGINT REFERENCES news_articles(id) ON DELETE CASCADE,
    source_id         BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
    title             TEXT,
    extracted_country TEXT,                          -- what the AI returned
    normalized_country TEXT,                         -- post-learn normalization
    extracted_place   TEXT,
    geocoded          BOOLEAN,
    geocode_precision TEXT,
    cluster_merged    BOOLEAN,                       -- did it join an event?
    issues            JSONB NOT NULL DEFAULT '[]',   -- ['country_mismatch','no_place',...]
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_extraction_feedback_cycle_idx
    ON news_extraction_feedback (cycle_id);
CREATE INDEX IF NOT EXISTS news_extraction_feedback_source_idx
    ON news_extraction_feedback (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS news_extraction_feedback_issues_idx
    ON news_extraction_feedback USING GIN (issues);
