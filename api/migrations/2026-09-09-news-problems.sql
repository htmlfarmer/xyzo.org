-- 2026-09-09-news-problems.sql
-- Problem tracking for the Action Engine
-- Tracks recurring and emerging problems detected from event patterns

BEGIN;

CREATE TABLE IF NOT EXISTS news_problems (
    id              BIGSERIAL PRIMARY KEY,
    problem_key     VARCHAR(100) NOT NULL,  -- 'prob_{location_id}_{event_type}'
    event_type      VARCHAR(50) NOT NULL,
    headline        VARCHAR(500) NOT NULL,
    description     TEXT,
    location_id     BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    country_code   VARCHAR(50),
    problem_type    VARCHAR(20) NOT NULL DEFAULT 'recurring',  -- recurring|emerging|worsening
    severity        FLOAT NOT NULL DEFAULT 0.5,  -- 0-1
    urgency         FLOAT NOT NULL DEFAULT 0.5,  -- 0-1
    occurrence_count INT NOT NULL DEFAULT 1,
    first_detected  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_occurrence TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_days     INT NOT NULL DEFAULT 30,
    status          VARCHAR(20) NOT NULL DEFAULT 'active',  -- active|monitoring|resolved|dismissed
    confidence      FLOAT NOT NULL DEFAULT 0.5,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(problem_key)
);

CREATE INDEX IF NOT EXISTS idx_problems_status ON news_problems(status);
CREATE INDEX IF NOT EXISTS idx_problems_type ON news_problems(event_type);
CREATE INDEX IF NOT EXISTS idx_problems_severity ON news_problems(severity DESC);
CREATE INDEX IF NOT EXISTS idx_problems_country ON news_problems(country_code);
CREATE INDEX IF NOT EXISTS idx_problems_key ON news_problems(problem_key);

-- Track evidence: which events support this problem
CREATE TABLE IF NOT EXISTS news_problem_events (
    id              BIGSERIAL PRIMARY KEY,
    problem_id      BIGINT NOT NULL REFERENCES news_problems(id) ON DELETE CASCADE,
    event_id        BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(problem_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_problem_events_problem ON news_problem_events(problem_id);
CREATE INDEX IF NOT EXISTS idx_problem_events_event ON news_problem_events(event_id);

-- Action recommendations for each problem
CREATE TABLE IF NOT EXISTS news_problem_actions (
    id              BIGSERIAL PRIMARY KEY,
    problem_id      BIGINT NOT NULL REFERENCES news_problems(id) ON DELETE CASCADE,
    action_key      VARCHAR(50) NOT NULL,  -- INFORMATION|FINANCIAL|VOLUNTEER|ADVOCACY|PREPARATION|LEARN
    headline        VARCHAR(500) NOT NULL,
    description     TEXT,
    who_can_do      VARCHAR(50)[] NOT NULL DEFAULT '{}',
    expected_benefit TEXT,
    risks           TEXT,
    confidence      FLOAT NOT NULL DEFAULT 0.5,
    time_horizon    VARCHAR(20) NOT NULL DEFAULT 'short_term',  -- immediate|short_term|long_term
    requires_human_approval BOOLEAN NOT NULL DEFAULT TRUE,
    approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
    approved_by     VARCHAR(100),
    approved_at     TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|active|completed|dismissed
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_problem_actions_problem ON news_problem_actions(problem_id);
CREATE INDEX IF NOT EXISTS idx_problem_actions_status ON news_problem_actions(status);
CREATE INDEX IF NOT EXISTS idx_problem_actions_key ON news_problem_actions(action_key);

-- Outcome tracking: did recommended actions help?
CREATE TABLE IF NOT EXISTS news_problem_outcomes (
    id              BIGSERIAL PRIMARY KEY,
    problem_id      BIGINT NOT NULL REFERENCES news_problems(id) ON DELETE CASCADE,
    action_id       BIGINT REFERENCES news_problem_actions(id) ON DELETE SET NULL,
    predicted_outcome TEXT NOT NULL,
    actual_outcome    TEXT,
    prediction_accuracy FLOAT,  -- 0-1
    lessons_learned   TEXT,
    evaluated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_problem_outcomes_problem ON news_problem_outcomes(problem_id);

-- Grant select to app user
GRANT SELECT ON ALL TABLES IN SCHEMA public TO xyzo_app;

COMMIT;
