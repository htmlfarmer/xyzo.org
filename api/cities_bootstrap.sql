-- Xyzo Cities bootstrap for consumer databases.
--
-- Run this in any PostgreSQL database that wants to read from
-- xyzo_cities. Adjust the connection options before executing.
--
-- This creates:
--   * a postgres_fdw server pointing at xyzo_cities
--   * a user mapping for the current user
--   * foreign tables: cities, city_aliases, city_names, countries
--   * a wrapper search_cities() function for cross-DB consumers
--
-- After running, the local database has read-only access to all of
-- xyzo_cities without copying any rows.
--
-- IMPORTANT: adjust the OPTIONS below to match your environment. The
-- defaults assume xyzo_cities is on the same host under the
-- standard cities_reader account.

-- ── 1. Server connection ────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- Drop the server if it already exists, so this script is idempotent.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'xyzo_cities_server') THEN
        ALTER SERVER xyzo_cities_server OPTIONS (
            SET host 'localhost',
            SET port '5432',
            SET dbname 'xyzo_cities'
        );
    ELSE
        CREATE SERVER xyzo_cities_server
            FOREIGN DATA WRAPPER postgres_fdw
            OPTIONS (
                host 'localhost',
                port '5432',
                dbname 'xyzo_cities'
            );
    END IF;
END$$;

-- ── 2. User mapping for the current role ────────────────────────────
-- Replace these credentials with whatever your deployment uses.
-- `password_required 'false'` lets cities_owner connect without
-- prompting for a password — only safe on the same host with trust
-- auth, or when both databases share a pgpass entry. Remove this
-- option if you'd rather require explicit credentials.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname = 'xyzo_cities_server') THEN
        -- Update any existing mappings to use these credentials.
        ALTER USER MAPPING FOR PUBLIC SERVER xyzo_cities_server
            OPTIONS (SET user 'cities_reader',
                     SET password 'CHANGE_ME',
                     SET password_required 'false');
    ELSE
        CREATE USER MAPPING FOR PUBLIC SERVER xyzo_cities_server
            OPTIONS (user 'cities_reader',
                     password 'CHANGE_ME',
                     password_required 'false');
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    -- If we can't create a PUBLIC mapping, fall back to a role-scoped one.
    EXECUTE format(
        'CREATE USER MAPPING FOR %I SERVER xyzo_cities_server
         OPTIONS (user ''cities_reader'', password ''CHANGE_ME'',
                  password_required ''false'')',
        current_user
    );
END$$;

-- ── 3. Foreign schema import ────────────────────────────────────────
-- This is the cleanest path: one command pulls in all tables/views
-- from xyzo_cities.public. If you'd rather project only specific
-- columns (recommended for tighter contracts), use the explicit
-- CREATE FOREIGN TABLE statements below instead.
--
-- IMPORT FOREIGN SCHEMA public
--     LIMIT TO (cities, city_aliases, city_names, countries, v_cities)
--     FROM SERVER xyzo_cities_server
--     INTO public;

-- ── 4. Explicit foreign tables (column-projected) ──────────────────
-- More verbose but pins the contract — if xyzo_cities adds new
-- columns, consumer schemas don't pick them up automatically.
DROP FOREIGN TABLE IF EXISTS public.cities CASCADE;
CREATE FOREIGN TABLE public.cities (
    id              BIGINT        OPTIONS (column_name 'id'),
    geoname_id      INT           OPTIONS (column_name 'geoname_id'),
    name            TEXT          OPTIONS (column_name 'name'),
    ascii_name      TEXT          OPTIONS (column_name 'ascii_name'),
    country_code    CHAR(2)       OPTIONS (column_name 'country_code'),
    state_code      TEXT          OPTIONS (column_name 'state_code'),
    state_name      TEXT          OPTIONS (column_name 'state_name'),
    latitude        DOUBLE PRECISION OPTIONS (column_name 'latitude'),
    longitude       DOUBLE PRECISION OPTIONS (column_name 'longitude'),
    population      INT           OPTIONS (column_name 'population'),
    elevation_m     INT           OPTIONS (column_name 'elevation_m'),
    timezone        TEXT          OPTIONS (column_name 'timezone'),
    feature_code    TEXT          OPTIONS (column_name 'feature_code'),
    source          TEXT          OPTIONS (column_name 'source'),
    validation_score INT          OPTIONS (column_name 'validation_score'),
    validated_at    TIMESTAMPTZ   OPTIONS (column_name 'validated_at'),
    validated_by    TEXT          OPTIONS (column_name 'validated_by'),
    notes           TEXT          OPTIONS (column_name 'notes'),
    created_at      TIMESTAMPTZ   OPTIONS (column_name 'created_at'),
    updated_at      TIMESTAMPTZ   OPTIONS (column_name 'updated_at'),
    geom            GEOGRAPHY(POINT, 4326) OPTIONS (column_name 'geom')
) SERVER xyzo_cities_server
  OPTIONS (schema_name 'public', table_name 'cities');

DROP FOREIGN TABLE IF EXISTS public.city_aliases CASCADE;
CREATE FOREIGN TABLE public.city_aliases (
    id          BIGINT       OPTIONS (column_name 'id'),
    city_id     BIGINT       OPTIONS (column_name 'city_id'),
    alias       TEXT         OPTIONS (column_name 'alias'),
    language    CHAR(2)      OPTIONS (column_name 'language'),
    source      TEXT         OPTIONS (column_name 'source'),
    notes       TEXT         OPTIONS (column_name 'notes'),
    created_at  TIMESTAMPTZ  OPTIONS (column_name 'created_at')
) SERVER xyzo_cities_server
  OPTIONS (schema_name 'public', table_name 'city_aliases');

DROP FOREIGN TABLE IF EXISTS public.city_names CASCADE;
CREATE FOREIGN TABLE public.city_names (
    id           BIGINT       OPTIONS (column_name 'id'),
    city_id      BIGINT       OPTIONS (column_name 'city_id'),
    lang         TEXT         OPTIONS (column_name 'lang'),
    name         TEXT         OPTIONS (column_name 'name'),
    name_ascii   TEXT         OPTIONS (column_name 'name_ascii'),
    is_preferred BOOLEAN      OPTIONS (column_name 'is_preferred'),
    name_type    TEXT         OPTIONS (column_name 'name_type'),
    source       TEXT         OPTIONS (column_name 'source'),
    created_at   TIMESTAMPTZ  OPTIONS (column_name 'created_at')
) SERVER xyzo_cities_server
  OPTIONS (schema_name 'public', table_name 'city_names');

DROP FOREIGN TABLE IF EXISTS public.countries CASCADE;
CREATE FOREIGN TABLE public.countries (
    code            CHAR(2)         OPTIONS (column_name 'code'),
    alpha3          CHAR(3)         OPTIONS (column_name 'alpha3'),
    name            TEXT            OPTIONS (column_name 'name'),
    region          TEXT            OPTIONS (column_name 'region'),
    subregion       TEXT            OPTIONS (column_name 'subregion'),
    population_m    BIGINT          OPTIONS (column_name 'population_m'),
    bbox_min_lat    DOUBLE PRECISION OPTIONS (column_name 'bbox_min_lat'),
    bbox_max_lat    DOUBLE PRECISION OPTIONS (column_name 'bbox_max_lat'),
    bbox_min_lng    DOUBLE PRECISION OPTIONS (column_name 'bbox_min_lng'),
    bbox_max_lng    DOUBLE PRECISION OPTIONS (column_name 'bbox_max_lng'),
    capital_id      BIGINT          OPTIONS (column_name 'capital_id'),
    languages       TEXT[]          OPTIONS (column_name 'languages'),
    currency        TEXT            OPTIONS (column_name 'currency'),
    notes           TEXT            OPTIONS (column_name 'notes'),
    created_at      TIMESTAMPTZ     OPTIONS (column_name 'created_at'),
    updated_at      TIMESTAMPTZ     OPTIONS (column_name 'updated_at')
) SERVER xyzo_cities_server
  OPTIONS (schema_name 'public', table_name 'countries');

-- ── 5. Wrapper function (cross-DB convenience) ─────────────────────
-- Runs the same search as remote search_cities, but via FDW directly
-- (no dblink dependency). The query is sent to xyzo_cities and
-- executed there with the xyzo_cities planner/indexes.
--
-- NOTE: requires the FDW user mapping to allow connection without a
-- password (use `password_required 'false'` if xyzo_cities is on
-- the same host with trust auth, or supply a pgpass entry).

DROP FUNCTION IF EXISTS public.cities_search(TEXT, CHAR(2), INT, INT);
CREATE OR REPLACE FUNCTION public.cities_search(
    query_text TEXT,
    country_filter CHAR(2) DEFAULT NULL,
    min_population INT DEFAULT 0,
    max_results INT DEFAULT 25
)
RETURNS TABLE(
    id BIGINT, name TEXT, ascii_name TEXT, country_code CHAR(2),
    state_name TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
    population INT, match_kind TEXT
)
LANGUAGE plpgsql
STABLE
AS $fn$
BEGIN
    RETURN QUERY
        WITH matches AS (
            SELECT c.id AS cid, c.name AS cname, c.ascii_name AS cascii,
                   c.country_code::CHAR(2) AS ccode,
                   c.state_name AS sname, c.latitude AS clat, c.longitude AS clng,
                   c.population AS cpop,
                   'name'::TEXT AS mkind
            FROM public.cities c
            WHERE (lower(c.ascii_name) LIKE '%' || lower(query_text) || '%'
                OR lower(c.name) LIKE '%' || lower(query_text) || '%')
              AND c.population >= min_population
              AND (country_filter IS NULL OR c.country_code = country_filter)
            UNION ALL
            SELECT c.id, c.name, c.ascii_name, c.country_code::CHAR(2),
                   c.state_name, c.latitude, c.longitude, c.population,
                   'alias'::TEXT
            FROM public.city_aliases a
            JOIN public.cities c ON c.id = a.city_id
            WHERE lower(a.alias) = lower(query_text)
              AND c.population >= min_population
              AND (country_filter IS NULL OR c.country_code = country_filter)
        )
        SELECT DISTINCT ON (cid) cid, cname, cascii, ccode, sname,
                            clat, clng, cpop, mkind
        FROM matches
        ORDER BY cid, cpop DESC
        LIMIT max_results;
END;
$fn$;

-- ── 6. Convenience view with country info ──────────────────────────
DROP VIEW IF EXISTS public.v_cities;
CREATE OR REPLACE VIEW public.v_cities AS
SELECT
    c.id,
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
    c.source,
    c.validation_score,
    c.created_at,
    c.updated_at
FROM public.cities c
LEFT JOIN public.countries co ON co.code = c.country_code;

-- ── 7. Verify the setup ─────────────────────────────────────────────
-- If this query returns >0, you're wired up.
DO $$
DECLARE
    n INT;
BEGIN
    SELECT COUNT(*) INTO n FROM public.cities;
    RAISE NOTICE 'xyzo_cities FDW wired up: % cities reachable from this database', n;
END$$;
