-- Search Intelligence Schema — Phase 1
-- Build on existing news_search_log table

-- ── search_journey_events ──────────────────────────────────────────────────
-- Every atomic interaction within a search session:
-- initial search → result renders → user clicks/ignores → reformulates → etc.
CREATE TABLE IF NOT EXISTS search_journey_events (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  search_event_id BIGINT REFERENCES news_search_log(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'search', 'result_render', 'pin_click', 'popup_open', 'popup_dwell',
    'reformulate', 'clear', 'discovery_shown', 'discovery_click',
    'zoom_in', 'filter_apply', 'time_filter_change'
  )),
  query           TEXT,                    -- current query at this step
  result_count    INTEGER,
  clicked_pin_id   BIGINT,
  clicked_event_id BIGINT,
  dwell_ms         INTEGER,                -- milliseconds spent on pin
  latency_ms       INTEGER,                 -- search render time
  recovery_type    TEXT,                    -- 'external_discovery' | 'entity_expand' | 'semantic' | null
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journey_session ON search_journey_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_journey_search  ON search_journey_events(search_event_id) WHERE search_event_id IS NOT NULL;

-- ── search_failures ────────────────────────────────────────────────────────
-- Classified failure modes per search session
CREATE TABLE IF NOT EXISTS search_failures (
  id                  BIGSERIAL PRIMARY KEY,
  search_event_id     BIGINT REFERENCES news_search_log(id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  query               TEXT NOT NULL,
  failure_type        TEXT NOT NULL CHECK (failure_type IN (
    'zero_results',           -- hard zero
    'wrong_location',         -- results exist but wrong geography
    'wrong_topic',            -- results exist but off-topic
    'stale_results',          -- old, irrelevant
    'low_diversity',          -- all same source/viewpoint
    'ranking_failure',        -- good results buried
    'missing_entity',         -- known entity not found
    'missing_topic',          -- topic gap (user asked about something we don't cover)
    'source_gap',             -- known source not indexed
    'true_unknown'            -- database genuinely doesn't cover it
  )),
  confidence          FLOAT DEFAULT 0.5,    -- 0-1 how confident we are in this classification
  -- Per-axis failure signals
  query_parsed        JSONB,                -- {entity, domain, intent, time} from query understanding
  matched_pins       INTEGER DEFAULT 0,
  avg_dwell_ms       INTEGER,
  reformulated       BOOLEAN,
  discovery_count    INTEGER DEFAULT 0,
  discovery_relevant INTEGER DEFAULT 0,
  -- Recovery
  recovery_method    TEXT,                  -- 'duckduckgo' | 'entity_geocode' | 'semantic_search' | 'query_expand'
  recovery_success   BOOLEAN,
  -- Gemma AI diagnosis (when used)
  ai_diagnosis      TEXT,
  ai_suggestions    TEXT[],
  -- Counts for soft-failure detection
  pin_views          INTEGER DEFAULT 0,
  pin_clicks         INTEGER DEFAULT 0,
  unique_sources_shown INTEGER DEFAULT 0,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failures_session ON search_failures(session_id);
CREATE INDEX IF NOT EXISTS idx_failures_type   ON search_failures(failure_type);
CREATE INDEX IF NOT EXISTS idx_failures_query  ON search_failures USING gin(query gin_trgm_ops);

-- ── xyzo_search_gaps ──────────────────────────────────────────────────────
-- Aggregated gap intelligence: what is the world asking that we can't answer well?
CREATE TABLE IF NOT EXISTS xyzo_search_gaps (
  gap_id             BIGSERIAL PRIMARY KEY,
  query_cluster      TEXT NOT NULL,         -- normalized representative query
  query_fingerprint  TEXT NOT NULL,         -- hashed core terms for dedup
  language           TEXT,
  country            TEXT,
  domain             TEXT,                  -- 'AI', 'astronomy', 'finance', etc.
  intent             TEXT,                   -- 'news', 'explain', 'discover', 'track'
  entity_type        TEXT,                   -- 'company', 'person', 'place', 'technology'
  -- Volume metrics
  search_count       INTEGER DEFAULT 0,
  unique_sessions    INTEGER DEFAULT 0,
  zero_result_count  INTEGER DEFAULT 0,
  soft_fail_count    INTEGER DEFAULT 0,
  -- Growth
  searches_7d        INTEGER DEFAULT 0,
  searches_30d       INTEGER DEFAULT 0,
  growth_rate        FLOAT DEFAULT 0,        -- (searches_7d / NULLIF(searches_30d/4, 0)) - 1
  -- Gap characteristics
  related_entities   TEXT[],                -- detected entities in these queries
  related_topics     TEXT[],
  likely_missing_source_country TEXT,
  likely_missing_source_lang  TEXT,
  -- Failure breakdown
  failure_breakdown  JSONB DEFAULT '{}',   -- {zero_results: 12, wrong_topic: 5, ...}
  avg_result_count   FLOAT DEFAULT 0,
  recovery_rate      FLOAT DEFAULT 0,        -- fraction successfully recovered
  -- Timestamps
  first_seen         TIMESTAMPTZ DEFAULT NOW(),
  last_seen          TIMESTAMPTZ DEFAULT NOW(),
  last_updated       TIMESTAMPTZ DEFAULT NOW(),
  -- Importance scoring
  importance_score   FLOAT DEFAULT 0,
  CONSTRAINT unique_gap_query_fingerprint UNIQUE (query_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_gaps_domain     ON xyzo_search_gaps(domain);
CREATE INDEX IF NOT EXISTS idx_gaps_intent     ON xyzo_search_gaps(intent);
CREATE INDEX IF NOT EXISTS idx_gaps_importance ON xyzo_search_gaps (importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_gaps_growth     ON xyzo_search_gaps (growth_rate DESC);

-- ── search_embeddings_cache ─────────────────────────────────────────────────
-- Pre-computed query expansion embeddings for fast semantic matching
-- Regenerated nightly or on gap detection
CREATE TABLE IF NOT EXISTS search_embeddings_cache (
  id              BIGSERIAL PRIMARY KEY,
  query_text      TEXT NOT NULL,
  query_lang      TEXT,
  embedding       VECTOR(384),              -- match your embedding dimension
  entity_candidates TEXT[],                  -- extracted company/person/location names
  domain_candidates TEXT[],
  intent          TEXT,
  time_signal     TEXT,                      -- 'recent', 'historical', 'ongoing'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_query_text_lang UNIQUE (query_text, query_lang)
);

CREATE INDEX IF NOT EXISTS idx_search_emb_cache ON search_embeddings_cache USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE xyzo_search_gaps IS 'Aggregated search gap intelligence: emerging topics the database doesnt cover well';
COMMENT ON TABLE search_failures IS 'Per-session failure classification for learning-to-rank and gap analysis';
COMMENT ON TABLE search_journey_events IS 'Full search session journey: every click, dwell, reformulation event';
