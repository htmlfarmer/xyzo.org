-- Newsium cities schema. Additive, idempotent.
--
-- Merges the curated user-supplied CSV (>= 100k population) into the
-- existing world_cities table without losing GeoNames rows. Adds:
--   * world_cities.source           — provenance: 'geonames' | 'user_csv' | 'merged'
--   * world_cities.validated_at     — last validation pass
--   * world_cities.notes            — anomaly notes from the loader
--   * world_cities.search_text      — pre-normalized haystack for fast LIKE
--   * city_aliases                  — abbreviation table (NYC -> New York, etc.)

-- 1. Add provenance + search columns to world_cities.
ALTER TABLE world_cities
    ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'geonames',
    ADD COLUMN IF NOT EXISTS validated_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notes        TEXT,
    ADD COLUMN IF NOT EXISTS search_text  TEXT;

-- 2. Helpful indexes that the loader + extraction pipeline need.
-- (pg_trgm GIN index is the fast option if the extension is available;
-- otherwise a plain lower(text) btree handles the simple LIKE lookups
-- the loader + geocode short-circuit actually do.)
DO $$
BEGIN
    BEGIN
        EXECUTE 'CREATE INDEX IF NOT EXISTS world_cities_search_trgm_idx
                 ON world_cities USING GIN (search_text gin_trgm_ops)';
    EXCEPTION WHEN undefined_object OR feature_not_supported THEN
        NULL;  -- pg_trgm not installed — fall through to the btree below.
    END;
END$$;
CREATE INDEX IF NOT EXISTS world_cities_search_btree_idx
    ON world_cities (lower(search_text));

CREATE INDEX IF NOT EXISTS world_cities_source_idx
    ON world_cities (source);
CREATE INDEX IF NOT EXISTS world_cities_validated_idx
    ON world_cities (validated_at DESC);

-- 3. Alias table. Many-to-one: one city can have many aliases
--    (NYC, New York, Big Apple -> id=5128581).
CREATE TABLE IF NOT EXISTS city_aliases (
    id          BIGSERIAL PRIMARY KEY,
    city_id     BIGINT NOT NULL REFERENCES world_cities(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'en',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (alias, language)
);
CREATE INDEX IF NOT EXISTS city_aliases_alias_idx
    ON city_aliases (lower(alias));
CREATE INDEX IF NOT EXISTS city_aliases_city_idx
    ON city_aliases (city_id);
