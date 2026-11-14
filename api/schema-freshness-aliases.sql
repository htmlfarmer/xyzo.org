-- schema-freshness-aliases.sql
-- Freshness probes and admin tooling reference columns that the pipeline
-- tables spell differently:
--   news_event_stats          computed_at   -> probed as updated_at
--   news_location_terms       updated_at    -> probed as last_computed_at / computed_at
--   nn_training_runs          started_at    -> probed as created_at
--   nn_event_relationships    predicted_at  -> probed as created_at
--   admin_keys                revoked_at    -> probed as is_active
-- Rather than rewriting every consumer, expose the probe names as stored
-- generated aliases (single-table, immutable column refs; all tables <4MB).
-- Idempotent: re-running skips existing columns.

BEGIN;

DO $$
DECLARE
    need RECORD;
BEGIN
    FOR need IN
        SELECT * FROM (VALUES
            ('news_event_stats',       'updated_at',       'TIMESTAMPTZ GENERATED ALWAYS AS (computed_at) STORED'),
            ('news_location_terms',    'last_computed_at', 'TIMESTAMPTZ GENERATED ALWAYS AS (updated_at) STORED'),
            ('news_location_terms',    'computed_at',      'TIMESTAMPTZ GENERATED ALWAYS AS (updated_at) STORED'),
            ('nn_training_runs',       'created_at',       'TIMESTAMPTZ GENERATED ALWAYS AS (started_at) STORED'),
            ('nn_event_relationships', 'created_at',       'TIMESTAMPTZ GENERATED ALWAYS AS (predicted_at) STORED'),
            ('admin_keys',             'is_active',        'BOOLEAN GENERATED ALWAYS AS (revoked_at IS NULL) STORED')
        ) AS t(tbl, col, def)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = need.tbl
              AND column_name = need.col
        ) THEN
            EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s',
                           need.tbl, need.col, need.def);
            RAISE NOTICE 'added public.%.%', need.tbl, need.col;
        END IF;
    END LOOP;
END $$;

COMMIT;
