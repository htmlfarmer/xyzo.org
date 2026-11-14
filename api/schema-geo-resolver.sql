-- Geographic resolution audit trail: log every geolocation decision with evidence
CREATE TABLE IF NOT EXISTS news_geo_resolution_log (
    id                      BIGSERIAL PRIMARY KEY,
    article_id              BIGINT REFERENCES news_articles(id) ON DELETE CASCADE,

    -- Raw extracted signals
    raw_location_text       TEXT,          -- what was extracted: "Springfield"
    raw_context            TEXT,          -- surrounding text: "researchers at MIT in Cambridge"
    extraction_method      TEXT,          -- regex|ai|nlp|dateline|org_pattern

    -- Candidate evaluation
    candidate_id           BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    candidate_name         TEXT,          -- "Cambridge, Massachusetts"
    candidate_country      TEXT,
    candidate_admin1      TEXT,          -- state/province
    candidate_lat         DOUBLE PRECISION,
    candidate_lng         DOUBLE PRECISION,

    -- Signal scores
    explicit_city_signal   DOUBLE PRECISION DEFAULT 0,
    explicit_state_signal  DOUBLE PRECISION DEFAULT 0,
    explicit_country_signal DOUBLE PRECISION DEFAULT 0,
    org_anchor_signal    DOUBLE PRECISION DEFAULT 0,
    source_country_signal DOUBLE PRECISION DEFAULT 0,
    population_prior      DOUBLE PRECISION DEFAULT 0,
    url_signal            DOUBLE PRECISION DEFAULT 0,
    dateline_signal       DOUBLE PRECISION DEFAULT 0,
    adjacent_sentence_signal DOUBLE PRECISION DEFAULT 0,

    -- Final decision
    final_location_id     BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    final_score          DOUBLE PRECISION,
    final_confidence      TEXT,          -- VERY_HIGH|HIGH|MEDIUM|LOW|AMBIGUOUS|UNKNOWN
    confidence_numeric    DOUBLE PRECISION,

    -- Alternatives considered
    alternatives_json    JSONB,         -- [{candidate_id, score, reason}]

    -- Metadata
    resolver_version      TEXT DEFAULT 'v1',
    model_version         TEXT,
    resolver_used         TEXT,          -- geonames|nominatim|xyzo_db|org_anchor|composite
    resolved_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Human correction
    human_corrected       BOOLEAN DEFAULT FALSE,
    corrected_at          TIMESTAMP WITH TIME ZONE,
    correction_note       TEXT
);

CREATE INDEX idx_grl_article       ON news_geo_resolution_log(article_id);
CREATE INDEX idx_grl_candidate    ON news_geo_resolution_log(candidate_id);
CREATE INDEX idx_grl_final       ON news_geo_resolution_log(final_location_id);
CREATE INDEX idx_grl_confidence   ON news_geo_resolution_log(final_confidence);
CREATE INDEX idx_grl_resolved     ON news_geo_resolution_log(resolved_at);

-- Organization → Location anchor table
CREATE TABLE IF NOT EXISTS news_org_location_anchors (
    id                  BIGSERIAL PRIMARY KEY,
    org_name            TEXT NOT NULL,
    org_name_normalized TEXT NOT NULL,
    location_id         BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    city_name          TEXT,
    state_region       TEXT,
    country            TEXT,
    country_code       TEXT,
    lat                DOUBLE PRECISION,
    lng                DOUBLE PRECISION,
    anchor_type        TEXT NOT NULL DEFAULT 'headquarters',  -- headquarters|campus|division|launch_site|field_office
    confidence         DOUBLE PRECISION DEFAULT 0.9,
    source             TEXT DEFAULT 'manual',   -- manual|geocoder|inferred
    wikidata_id        TEXT,
    notes              TEXT,
    created_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_name_normalized, anchor_type)
);

CREATE INDEX idx_ola_org        ON news_org_location_anchors(org_name_normalized);
CREATE INDEX idx_ola_loc        ON news_org_location_anchors(location_id);
CREATE INDEX idx_ola_country   ON news_org_location_anchors(country);

-- Article geographic context: extracted signals per article
CREATE TABLE IF NOT EXISTS news_article_geo_signals (
    article_id          BIGINT PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,

    -- Explicit location signals from text
    cities_mentioned    TEXT[],
    states_mentioned   TEXT[],
    countries_mentioned TEXT[],
    orgs_mentioned     TEXT[],

    -- Structured context
    dateline_city       TEXT,
    dateline_country    TEXT,

    -- Organization anchors found
    org_anchor_names   TEXT[],
    org_anchor_ids     BIGINT[],

    -- Source context
    source_country      TEXT,
    source_language    TEXT,

    -- URL context
    url_path_tokens     TEXT[],
    url_country_hint   TEXT,

    -- Confidence at extraction time
    signal_confidence   TEXT,   -- HIGH|MEDIUM|LOW
    extraction_method   TEXT,   -- ai|nlp|heuristic

    -- All candidates (not just winner)
    candidates_json     JSONB,  -- [{id, name, country, score}]

    -- Final selection
    selected_location_id BIGINT REFERENCES news_locations(id) ON DELETE SET NULL,
    selected_confidence  TEXT,
    selected_score       DOUBLE PRECISION,

    -- Whether the article's stated country matches candidate country
    country_validated    BOOLEAN,
    country_mismatch     TEXT,  -- if validated=FALSE, what was claimed vs what matched

    extracted_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON news_geo_resolution_log     TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_org_location_anchors  TO xyzo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON news_article_geo_signals  TO xyzo_app;
