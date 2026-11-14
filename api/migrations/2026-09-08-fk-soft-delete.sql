-- ── 2026-09-08-fk-soft-delete.sql ──────────────────────────────────────
--
-- Tier 1.4 of consolidated audit fix-order. Closes two related
-- referential-integrity problems Audit 3 surfaced:
--
--   (a) ORPHAN-ROW ACCUMULATION
--       news_interactions.{pin_id,article_id,source_id,event_id} had
--       ZERO FK constraints, so a DELETE on the parent table (pins,
--       news_articles, news_sources, news_events) silently stranded
--       interaction rows pointing at a now-nonexistent parent.
--       We add FKs with ON DELETE SET NULL (all four columns are
--       already nullable, so SET NULL is the safe choice) to keep
--       analytics rows even after the parent vanishes.
--
--   (b) HISTORY-EVAPORATION ON SOURCE DELETE
--       news_articles.source_id was NOT NULL ... ON DELETE CASCADE,
--       so removing a source nuked every article + every ranking
--       row + every interaction tied to that source. We replace
--       CASCADE with SET NULL (after making source_id nullable) so
--       articles survive a source retirement.
--
--   (c) SOFT-DELETE COLUMN
--       news_sources has no deleted_at column — sources can only be
--       deactivated (active=FALSE) or hard-deleted. We add
--       deleted_at TIMESTAMPTZ as the canonical "retired" marker.
--       Public queries that join news_sources should filter
--       WHERE deleted_at IS NULL so retired sources stop leaking
--       into rankings, the source leaderboard, and the explore UI.
--
-- All FK constraints are added NOT VALID so the table doesn't have
-- to be scanned (millions of rows already in news_interactions).
-- We VALIDATE in a separate statement that runs as a background
-- scan without taking an AccessExclusiveLock.
--
-- Idempotency: each step is wrapped in a NOT-EXISTS guard so the
-- file can be re-run if a previous attempt partially completed
-- (e.g. crashed between ADD CONSTRAINT and VALIDATE). The CASCADE
-- DROP in Step B is guarded by confdeltype='c' so re-runs after the
-- replacement is already in place are no-op (the FK replacement is
-- no-op if confdeltype is already 'n').
--
-- Verified against the live DB before writing this migration:
--
--   \d news_articles -> source_id NOT NULL REFERENCES news_sources(id)
--                     ON DELETE CASCADE
--                     constraint name: news_articles_source_id_fkey
--
--   \d news_interactions -> no FK constraints
--
--   \d news_sources -> no deleted_at column
--
--   table for pin_id -> pins (NOT news_pins); news_pins does not
--                       exist in this schema (verified by
--                       schema.sql:13 + schema-events.sql).
--
--   table for article_id -> news_articles (confirmed).
--   table for source_id  -> news_sources  (confirmed).
--   table for event_id   -> news_events   (confirmed).

-- ── 1. news_sources.deleted_at ─────────────────────────────────────────
-- Soft-delete column + partial index for the rare-but-not-never
-- retired-source case. The partial index keeps writes cheap
-- (only rows with deleted_at IS NOT NULL are indexed, so the
-- partial index stays tiny).
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS news_sources_deleted_at_idx
  ON news_sources (deleted_at)
  WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN news_sources.deleted_at IS
  'Soft-delete flag: when set, the source is retired and should be filtered out of public queries (WHERE deleted_at IS NULL). Distinct from active=FALSE which means "paused but still ingest-eligible".';

-- ── 2. news_interactions: 4 FKs with ON DELETE SET NULL ────────────────
-- All four target columns are already nullable, so SET NULL is safe
-- even when there are millions of historical rows pointing at a
-- now-deleted parent. Each constraint wrapped in a NOT-EXISTS guard
-- so re-running the migration is safe (partial state from a crashed
-- previous run already left the constraints in place).

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_pin_fk'
  ) THEN
    ALTER TABLE news_interactions
      ADD CONSTRAINT news_interactions_pin_fk
      FOREIGN KEY (pin_id) REFERENCES pins(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_article_fk'
  ) THEN
    ALTER TABLE news_interactions
      ADD CONSTRAINT news_interactions_article_fk
      FOREIGN KEY (article_id) REFERENCES news_articles(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_source_fk'
  ) THEN
    ALTER TABLE news_interactions
      ADD CONSTRAINT news_interactions_source_fk
      FOREIGN KEY (source_id) REFERENCES news_sources(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_event_fk'
  ) THEN
    ALTER TABLE news_interactions
      ADD CONSTRAINT news_interactions_event_fk
      FOREIGN KEY (event_id) REFERENCES news_events(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$do$;

-- ── 2a. Clean up existing orphan rows ──────────────────────────────────
-- Validate can only run if no rows violate the new constraint, so we
-- NULL out rows that point at now-deleted parents. Counts at the
-- time of writing (verified against live DB):
--   pin_id orphans:    3487 rows
--   article_id orphans:    0 rows
--   source_id orphans:    37 rows
--   event_id orphans:      0 rows
-- These are analytics rows stranded by past parent deletes; the
-- interaction_type + session_id + created_at metadata stays useful,
-- only the FK target is gone. Keeping the rest of the row matches
-- the SET NULL semantics of the new FKs.
UPDATE news_interactions
   SET pin_id = NULL
 WHERE pin_id IS NOT NULL
   AND pin_id NOT IN (SELECT id FROM pins);

UPDATE news_interactions
   SET source_id = NULL
 WHERE source_id IS NOT NULL
   AND source_id NOT IN (SELECT id FROM news_sources);

-- Validate (runs as a background scan, doesn't block writes).
-- The DO guards let this be re-run after a partial completion.
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_pin_fk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE news_interactions VALIDATE CONSTRAINT news_interactions_pin_fk;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_article_fk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE news_interactions VALIDATE CONSTRAINT news_interactions_article_fk;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_source_fk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE news_interactions VALIDATE CONSTRAINT news_interactions_source_fk;
  END IF;
END
$do$;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_interactions'::regclass
      AND conname = 'news_interactions_event_fk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE news_interactions VALIDATE CONSTRAINT news_interactions_event_fk;
  END IF;
END
$do$;

-- ── 3. news_articles.source_id: CASCADE -> SET NULL ────────────────────
-- Step A: make source_id nullable (it was NOT NULL).
--         Safe: we drop NOT NULL before re-adding the FK with the
--         weaker SET NULL semantics. Existing rows keep their
--         source_id value (none go null from this step).
ALTER TABLE news_articles
  ALTER COLUMN source_id DROP NOT NULL;

-- Step B: drop the CASCADE constraint ONLY if it's still CASCADE.
--         On a fresh install or a re-run after we've already replaced
--         CASCADE with SET NULL, this is a no-op. Only dropping when
--         confdeltype='c' means a brief window where orphan rows
--         could be created by an in-flight DELETE never opens — the
--         old CASCADE constraint stays in place until we know we're
--         about to swap it with SET NULL.
--         Constraint name verified against \d news_articles in the
--         live DB: news_articles_source_id_fkey (Postgres default
--         naming for `<table>_<col>_fkey`).
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_articles'::regclass
      AND conname = 'news_articles_source_id_fkey'
      AND confdeltype = 'c'  -- 'c' = CASCADE
  ) THEN
    ALTER TABLE news_articles DROP CONSTRAINT news_articles_source_id_fkey;
  END IF;
END
$do$;

-- Step C: re-add with SET NULL so deleting a source nullifies
--         source_id on the article instead of cascading. Skip if
--         already present (idempotent on re-run).
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_articles'::regclass
      AND conname = 'news_articles_source_id_fkey'
  ) THEN
    ALTER TABLE news_articles
      ADD CONSTRAINT news_articles_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES news_sources(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$do$;

-- Validate (background scan). Skip if already validated.
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'news_articles'::regclass
      AND conname = 'news_articles_source_id_fkey'
      AND NOT convalidated
  ) THEN
    ALTER TABLE news_articles VALIDATE CONSTRAINT news_articles_source_id_fkey;
  END IF;
END
$do$;

-- ── 4. Indexes on FK-referenced columns (article_id, event_id) ─────────
-- Postgres must scan every row in news_interactions when a parent is
-- deleted, to NULL out the matching FK (SET NULL propagation). The
-- pin and source FKs already have partial indexes from earlier work;
-- article_id and event_id do not, so a DELETE on news_articles or
-- news_events would do a full sequential scan of news_interactions.
-- Partial indexes (WHERE col IS NOT NULL) keep the indexes small and
-- writes cheap, mirroring the existing pin/source pattern.
CREATE INDEX IF NOT EXISTS news_interactions_article_idx
  ON news_interactions (article_id)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS news_interactions_event_idx
  ON news_interactions (event_id)
  WHERE event_id IS NOT NULL;
