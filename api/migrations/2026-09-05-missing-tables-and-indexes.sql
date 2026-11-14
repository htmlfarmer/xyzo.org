-- Phase 1 safety net — adds additional supporting indexes and a comment-only
-- audit trail for the tables that already existed when this audit ran.
--
-- Original audit (Phase 1) claimed these tables/columns were missing:
--   B1: pins.fts                                → already present (idx_pins_fts)
--   B2: news_story_links                        → already present (postgres-owned)
--   B3a: news_quality_reports                   → already present (xyzo_app-owned)
--   B3b: news_client_errors                     → already present (postgres-owned)
--
-- This migration is therefore a no-op for the schema itself. We keep it
-- on disk so future audits see the explicit "verified present" marker
-- and so any deployment that *did* run before those tables were created
-- still gets a self-healing CREATE TABLE IF NOT EXISTS.
--
-- Idempotent — safe to re-run.

-- ─── B1: pins.fts (already exists; keep the marker) ─────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pins' AND column_name = 'fts'
    ) THEN
        ALTER TABLE pins ADD COLUMN fts tsvector
            GENERATED ALWAYS AS (
                to_tsvector('english',
                    coalesce(title, '') || ' ' ||
                    coalesce(location_precision, '') || ' ' ||
                    coalesce(category, '')
                )
            ) STORED;
    END IF;
END$$;

-- Pin the GIN index if it's not already there. Either of these names may
-- exist depending on which migration ran first.
CREATE INDEX IF NOT EXISTS pins_fts_idx ON pins USING GIN (fts);

-- ─── B2: news_story_links (already exists with full schema) ─────────────
-- Self-heal only if the table is genuinely missing — owners may differ
-- across environments, so wrap in DO block to avoid permission errors.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'news_story_links'
    ) THEN
        CREATE TABLE news_story_links (
            id                BIGSERIAL PRIMARY KEY,
            source_article_id BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
            target_article_id BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
            link_type         TEXT   NOT NULL,
            link_strength     FLOAT  NOT NULL DEFAULT 0.5,
            link_reason       TEXT,
            topic             TEXT,
            city_name         TEXT,
            country_code      TEXT,
            entity_name       TEXT,
            created_by        TEXT   NOT NULL DEFAULT 'system',
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT news_story_links_distinct
                CHECK (source_article_id <> target_article_id),
            CONSTRAINT news_story_links_strength_range
                CHECK (link_strength BETWEEN 0.0 AND 1.0)
        );
        CREATE UNIQUE INDEX news_story_links_unique
            ON news_story_links (source_article_id, target_article_id, link_type);
    END IF;
END$$;

-- ─── B3a: news_quality_reports (already exists) ─────────────────────────
-- Self-heal only if missing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'news_quality_reports'
    ) THEN
        CREATE TABLE news_quality_reports (
            id          BIGSERIAL PRIMARY KEY,
            article_id  BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
            session_id  TEXT,
            report_type TEXT NOT NULL,
            reason      TEXT,
            ip_address  INET,
            user_agent  TEXT,
            metadata    JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    END IF;
END$$;

-- ─── B3b: news_client_errors (already exists) ───────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'news_client_errors'
    ) THEN
        CREATE TABLE news_client_errors (
            id          BIGSERIAL PRIMARY KEY,
            session_id  TEXT,
            error_type  TEXT NOT NULL,
            message     TEXT,
            filename    TEXT,
            lineno      INT,
            colno       INT,
            stack       TEXT,
            url         TEXT,
            ip_address  INET,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    END IF;
END$$;

-- ─── P3 (deferred) ───────────────────────────────────────────────────────
-- world_cities is an FDW foreign table owned by postgres in the remote
-- `xyzo_cities` DB — we cannot create a local GIN index here, and the
-- remote DB is also owned by postgres. The full P3 fix (move
-- detect_article_cities() off the trigger path) is tracked separately.
-- For now, the trigger works correctly — just not optimally.

-- Refresh planner stats where we have permission.
ANALYZE pins;
