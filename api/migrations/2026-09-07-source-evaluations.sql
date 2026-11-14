-- Source pre-flight evaluation table
-- Stores heuristic and AI-based quality assessments for news sources
-- before they produce any article data.

CREATE TABLE IF NOT EXISTS source_evaluations (
    source_id           BIGINT PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
    
    -- Layer 1: Fast heuristics (no AI, ~2s per source)
    heuristic_score     DOUBLE PRECISION,           -- 0-1 composite heuristic score
    rss_quality         DOUBLE PRECISION,           -- Feed structure, item count, dates
    website_quality     DOUBLE PRECISION,           -- HTTPS, about page, response time
    content_quality     DOUBLE PRECISION,           -- Article length, bylines, dates
    authority_signals   DOUBLE PRECISION,           -- Domain age, directory listings
    technical_quality   DOUBLE PRECISION,           -- Mobile, speed, meta tags
    heuristic_details   JSONB,                      -- Detailed breakdown
    
    -- Layer 2: AI-assisted evaluation (~20s per source)
    ai_score            DOUBLE PRECISION,           -- 0-1 AI assessment score
    ai_legitimacy       DOUBLE PRECISION,           -- Is it a real news org?
    ai_standards        DOUBLE PRECISION,           -- Journalistic standards?
    ai_originality      DOUBLE PRECISION,           -- Original reporting?
    ai_tone             DOUBLE PRECISION,           -- Factual vs sensational?
    ai_reasoning        TEXT,                       -- AI's explanation
    ai_details          JSONB,                      -- Full AI response
    
    -- Layer 3: NN integration
    nn_initial_score    DOUBLE PRECISION,           -- Score fed into NN as initial reliability
    nn_confidence       DOUBLE PRECISION,           -- How confident we are (0-1)
    
    -- Final composite
    final_score         DOUBLE PRECISION,           -- Combined score applied to source
    final_tier          TEXT,                       -- critical/high/medium/low/paused
    
    -- Metadata
    evaluation_mode     TEXT NOT NULL DEFAULT 'fast', -- fast | ai | full
    evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,                -- When to re-evaluate
    error_message       TEXT,                       -- If evaluation failed
    
    CONSTRAINT source_evaluations_score_range CHECK (
        heuristic_score IS NULL OR (heuristic_score >= 0 AND heuristic_score <= 1)
    ),
    CONSTRAINT source_evaluations_ai_score_range CHECK (
        ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 1)
    ),
    CONSTRAINT source_evaluations_final_score_range CHECK (
        final_score IS NULL OR (final_score >= 0 AND final_score <= 1)
    )
);

CREATE INDEX IF NOT EXISTS idx_source_evaluations_score 
    ON source_evaluations(final_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_source_evaluations_expires 
    ON source_evaluations(expires_at) 
    WHERE expires_at IS NOT NULL AND expires_at < NOW() + INTERVAL '7 days';

COMMENT ON TABLE source_evaluations IS 
    'Pre-flight quality evaluations for news sources. Stores heuristic and AI-based '
    'assessments that set initial reliability_score before the learning loop takes over.';

COMMENT ON COLUMN source_evaluations.heuristic_score IS 
    'Fast heuristic score (0-1) based on RSS quality, website signals, content patterns, '
    'authority indicators, and technical quality. No AI required.';

COMMENT ON COLUMN source_evaluations.ai_score IS 
    'AI-assisted score (0-1) based on analysis of about page, sample articles, '
    'journalistic standards, and reputation signals.';

COMMENT ON COLUMN source_evaluations.final_score IS 
    'Composite score applied to news_sources.reliability_score. '
    'Formula: heuristic * 0.6 + ai * 0.4 (if AI available), else heuristic * 1.0';
