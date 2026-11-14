-- Newsium Cities Database — comprehensive reference schema.
-- Owned by cities_owner, writable by cities_writer, readable by cities_reader.
--
-- This is the canonical cities reference for the newsium project and
-- any other PostgreSQL database that wants to consume it via
-- postgres_fdw. See api/cities_bootstrap.sql for the consumer-side
-- setup script.
--
-- Schema layout:
--   public               - main cities + aliases + country reference
--   cities_admin         - history, validation_log, sources, manifest

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- ── Schemas ──────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS cities_admin;

-- ── Enums ────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE cities_admin.source_kind AS ENUM (
        'geonames',          -- GeoNames cities15000 / cities5000 dump
        'user_csv',          -- user-curated CSV (>=100k population)
        'manual',            -- hand-added via cities CLI
        'osm',               -- OpenStreetMap (future)
        'wikipedia',         -- Wikipedia-derived (future)
        'merge',             -- result of a manual merge of two rows
        'unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE cities_admin.action_kind AS ENUM (
        'create', 'update', 'delete', 'alias_add', 'alias_remove',
        'merge', 'validate', 'unvalidate'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Sources registry ─────────────────────────────────────────────────
-- Tracks which upstream contributed data. Useful for attribution
-- and for re-imports.
CREATE TABLE IF NOT EXISTS cities_admin.sources (
    code          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    license       TEXT,
    homepage_url  TEXT,
    last_loaded   TIMESTAMPTZ,
    row_count     INT DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cities_admin.sources (code, name, description, license) VALUES
    ('geonames',   'GeoNames',   'Free gazetteer data, cities15000 dump', 'CC BY 4.0'),
    ('user_csv',   'User CSV',   'User-curated cities CSV (population >= 100,000)', 'Internal'),
    ('manual',     'Manual',     'Hand-curated via the cities CLI', 'Internal'),
    ('merge',      'Merge',      'Result of a manual merge of two cities', 'Internal')
ON CONFLICT (code) DO NOTHING;

-- ── Countries reference ──────────────────────────────────────────────
-- ISO 3166-1 alpha-2 reference with population + bounding box for
-- anomaly detection. Other databases can join through this to get
-- country metadata.
CREATE TABLE IF NOT EXISTS public.countries (
    code            CHAR(2) PRIMARY KEY,
    alpha3          CHAR(3) UNIQUE,
    name            TEXT NOT NULL,
    region          TEXT,                              -- continent/region
    subregion       TEXT,
    population_m    BIGINT,                            -- millions, for gap math
    bbox_min_lat    DOUBLE PRECISION,
    bbox_max_lat    DOUBLE PRECISION,
    bbox_min_lng    DOUBLE PRECISION,
    bbox_max_lng    DOUBLE PRECISION,
    capital_id      BIGINT,                            -- FK added after cities load
    languages       TEXT[],
    currency        TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Cities (the main table) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cities (
    id              BIGSERIAL PRIMARY KEY,
    geoname_id      INT UNIQUE,                        -- GeoNames cross-reference
    name            TEXT NOT NULL,
    ascii_name      TEXT NOT NULL,                     -- name with diacritics stripped
    country_code    CHAR(2) NOT NULL REFERENCES public.countries(code),
    state_code      TEXT,
    state_name      TEXT,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    population      INT NOT NULL DEFAULT 0,
    elevation_m     INT,
    timezone        TEXT,
    feature_code    TEXT,                              -- GeoNames feature class
    search_text     TEXT NOT NULL,                     -- pre-normalized haystack
    source          cities_admin.source_kind NOT NULL DEFAULT 'unknown',
    validation_score INT NOT NULL DEFAULT 50,          -- 0..100, higher = more confident
    validated_at    TIMESTAMPTZ,                       -- last human/auto validation pass
    validated_by    TEXT,                              -- 'cli:asher', 'load_cities.py', 'auto'
    notes           TEXT,
    geom            GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS
                    (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cities_lat_range  CHECK (latitude  BETWEEN -90  AND 90),
    CONSTRAINT cities_lng_range  CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT cities_pop_nneg   CHECK (population >= 0),
    CONSTRAINT cities_score_rng  CHECK (validation_score BETWEEN 0 AND 100)
);

-- ── Aliases ──────────────────────────────────────────────────────────
-- Many-to-one: one city has many aliases (NYC → New York City,
-- Bombay → Mumbai, etc.).
CREATE TABLE IF NOT EXISTS public.city_aliases (
    id          BIGSERIAL PRIMARY KEY,
    city_id     BIGINT NOT NULL REFERENCES public.cities(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL,
    language    CHAR(2) NOT NULL DEFAULT 'en',
    source      cities_admin.source_kind NOT NULL DEFAULT 'manual',
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Functional unique via index (not constraint) so it parses cleanly
-- across PG versions.
CREATE UNIQUE INDEX IF NOT EXISTS city_aliases_alias_lang_uniq_idx
    ON public.city_aliases (lower(alias), language);

-- ── History (audit trail) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cities_admin.history (
    id          BIGSERIAL PRIMARY KEY,
    city_id     BIGINT,
    action      cities_admin.action_kind NOT NULL,
    field       TEXT,                                  -- column changed
    old_value   TEXT,
    new_value   TEXT,
    source      TEXT,                                  -- CSV path, CLI command, etc.
    changed_by  TEXT,                                  -- user, 'load_cities.py', 'auto'
    note        TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cities_history_city_idx
    ON cities_admin.history (city_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS cities_history_action_idx
    ON cities_admin.history (action, changed_at DESC);

-- ── Validation log (one row per CSV/JSON load) ──────────────────────
CREATE TABLE IF NOT EXISTS cities_admin.validation_log (
    id          BIGSERIAL PRIMARY KEY,
    batch_id    TEXT NOT NULL,
    source      TEXT,                                  -- CSV path, URL, etc.
    row_count   INT NOT NULL DEFAULT 0,
    accepted    INT NOT NULL DEFAULT 0,
    flagged     INT NOT NULL DEFAULT 0,
    rejected    INT NOT NULL DEFAULT 0,
    duration_s  DOUBLE PRECISION,
    anomalies   JSONB,                                 -- top anomaly categories
    loaded_by   TEXT,
    loaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Manifest (one row, updated each load) ────────────────────────────
CREATE TABLE IF NOT EXISTS cities_admin.manifest (
    id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    schema_version      INT NOT NULL DEFAULT 1,
    total_cities        INT,
    total_countries     INT,
    total_aliases       INT,
    last_load_at        TIMESTAMPTZ,
    last_load_batch     TEXT,
    last_load_source    TEXT,
    last_load_row_count INT,
    last_invalid_count  INT,
    js_bundle_bytes     BIGINT,
    js_bundle_path      TEXT,
    notes               TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO cities_admin.manifest (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── Indexes ──────────────────────────────────────────────────────────
-- Primary lookup: name + country.
CREATE INDEX IF NOT EXISTS cities_name_idx
    ON public.cities (lower(ascii_name));
CREATE INDEX IF NOT EXISTS cities_name_country_idx
    ON public.cities (country_code, lower(ascii_name));

-- Fuzzy search via trigram (used by /api/cities/search).
CREATE INDEX IF NOT EXISTS cities_search_trgm_idx
    ON public.cities USING GIN (search_text gin_trgm_ops);

-- Population-ranked browse.
CREATE INDEX IF NOT EXISTS cities_pop_idx
    ON public.cities (population DESC);

-- Country distribution.
CREATE INDEX IF NOT EXISTS cities_country_idx
    ON public.cities (country_code);

-- Geo radius search.
CREATE INDEX IF NOT EXISTS cities_geom_idx
    ON public.cities USING GIST (geom);

-- Source attribution.
CREATE INDEX IF NOT EXISTS cities_source_idx
    ON public.cities (source);

-- Aliases.
CREATE INDEX IF NOT EXISTS city_aliases_alias_lower_idx
    ON public.city_aliases (lower(alias));
CREATE INDEX IF NOT EXISTS city_aliases_city_idx
    ON public.city_aliases (city_id);

-- History.
CREATE INDEX IF NOT EXISTS cities_history_changed_at_idx
    ON cities_admin.history (changed_at DESC);

-- ── FK: countries.capital_id → cities.id ─────────────────────────────
DO $$ BEGIN
    ALTER TABLE public.countries
        ADD CONSTRAINT countries_capital_fk
        FOREIGN KEY (capital_id) REFERENCES public.cities(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── updated_at trigger ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cities_updated_at ON public.cities;
CREATE TRIGGER cities_updated_at BEFORE UPDATE ON public.cities
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS countries_updated_at ON public.countries;
CREATE TRIGGER countries_updated_at BEFORE UPDATE ON public.countries
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Helper: log every change to history ──────────────────────────────
CREATE OR REPLACE FUNCTION public.log_city_change() RETURNS TRIGGER AS $$
DECLARE
    changed_fields TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO cities_admin.history (city_id, action, source, changed_by, note)
        VALUES (NEW.id, 'create', NEW.source::text,
                COALESCE(NEW.validated_by, 'auto'),
                'new row from ' || NEW.source::text);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO cities_admin.history (city_id, action, source, changed_by, note)
        VALUES (OLD.id, 'delete', OLD.source::text, 'auto', 'row deleted');
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        changed_fields := '';
        IF NEW.name IS DISTINCT FROM OLD.name THEN
            changed_fields := changed_fields || ' name=' || NEW.name;
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'name', OLD.name, NEW.name);
        END IF;
        IF NEW.latitude IS DISTINCT FROM OLD.latitude THEN
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'latitude', OLD.latitude::text, NEW.latitude::text);
        END IF;
        IF NEW.longitude IS DISTINCT FROM OLD.longitude THEN
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'longitude', OLD.longitude::text, NEW.longitude::text);
        END IF;
        IF NEW.population IS DISTINCT FROM OLD.population THEN
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'population', OLD.population::text, NEW.population::text);
        END IF;
        IF NEW.country_code IS DISTINCT FROM OLD.country_code THEN
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'country_code', OLD.country_code, NEW.country_code);
        END IF;
        IF NEW.source IS DISTINCT FROM OLD.source THEN
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'source', OLD.source::text, NEW.source::text);
        END IF;
        IF NEW.validation_score IS DISTINCT FROM OLD.validation_score THEN
            INSERT INTO cities_admin.history (city_id, action, field, old_value, new_value)
            VALUES (NEW.id, 'update', 'validation_score', OLD.validation_score::text, NEW.validation_score::text);
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cities_log_changes ON public.cities;
CREATE TRIGGER cities_log_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.cities
    FOR EACH ROW EXECUTE FUNCTION public.log_city_change();

-- ── View: cities with full country info (consumer convenience) ───────
CREATE OR REPLACE VIEW public.v_cities AS
SELECT
    c.id,
    c.geoname_id,
    c.name,
    c.ascii_name,
    c.country_code,
    co.name AS country_name,
    co.alpha3 AS country_alpha3,
    co.region AS country_region,
    c.state_code,
    c.state_name,
    c.latitude,
    c.longitude,
    c.population,
    c.elevation_m,
    c.timezone,
    c.feature_code,
    c.source,
    c.validation_score,
    c.validated_at,
    c.validated_by,
    c.notes,
    c.created_at,
    c.updated_at
FROM public.cities c
LEFT JOIN public.countries co ON co.code = c.country_code;

-- ── Convenience function for cross-DB consumers ─────────────────────
-- Other DBs can `SELECT * FROM xyzo_cities.cities` directly, but
-- having a function wrapper lets them call one symbol regardless of
-- schema evolution.
CREATE OR REPLACE FUNCTION public.search_cities(
    query_text TEXT,
    country_filter CHAR(2) DEFAULT NULL,
    min_population INT DEFAULT 0,
    max_results INT DEFAULT 25
)
RETURNS TABLE(
    id BIGINT, name TEXT, ascii_name TEXT, country_code CHAR(2),
    state_name TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
    population INT, match_kind TEXT
) AS $$
    WITH matches AS (
        SELECT c.id, c.name, c.ascii_name, c.country_code, c.state_name,
               c.latitude, c.longitude, c.population,
               'name'::TEXT AS match_kind,
               POSITION(lower(query_text) IN lower(c.ascii_name)) AS pos
        FROM public.cities c
        WHERE (lower(c.ascii_name) LIKE '%' || lower(query_text) || '%'
            OR lower(c.name) LIKE '%' || lower(query_text) || '%')
          AND c.population >= min_population
          AND (country_filter IS NULL OR c.country_code = country_filter)
        UNION ALL
        SELECT c.id, c.name, c.ascii_name, c.country_code, c.state_name,
               c.latitude, c.longitude, c.population,
               'alias'::TEXT AS match_kind,
               0 AS pos
        FROM public.city_aliases a
        JOIN public.cities c ON c.id = a.city_id
        WHERE lower(a.alias) = lower(query_text)
          AND c.population >= min_population
          AND (country_filter IS NULL OR c.country_code = country_filter)
    )
    SELECT DISTINCT ON (id) * FROM matches
    ORDER BY id, population DESC
    LIMIT max_results;
$$ LANGUAGE SQL STABLE;

-- ── Privileges ───────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO cities_reader, cities_writer;
GRANT USAGE ON SCHEMA cities_admin TO cities_reader, cities_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO cities_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA cities_admin TO cities_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cities_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cities_admin TO cities_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO cities_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA cities_admin TO cities_writer;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cities_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA cities_admin GRANT SELECT ON TABLES TO cities_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cities_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA cities_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cities_writer;
