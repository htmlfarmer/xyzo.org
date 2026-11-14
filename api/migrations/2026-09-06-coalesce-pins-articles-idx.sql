-- ── 2026-09-06-coalesce-pins-articles-idx.sql ────────────────────────
--
-- Hot-path COALESCE order-by indexes for /api/pins/map and /api/pins/near.
--
-- Bottleneck #3 in docs/xyzo-org-audit-2026-09-06.md: the pin queries
-- in api/src/routes/pins.ts (lines 165-547) sort with
--   ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
-- for news_articles and
--   ORDER BY COALESCE(published_at, created_at) DESC, id DESC
-- for pins. Postgres can't use a plain published_at index for that wrap,
-- so each map pan triggered a top-N heapsort over the full tables
-- (200k+ news_articles, 50k+ pins). Cold-path measured 200-660 ms;
-- after these indexes the planner does an index scan on the COALESCE
-- expression and the same fetches return in 30-60 ms.
--
-- We pair the full COALESCE expression index with a partial index that
-- catches the "tail" (rows where published_at IS NULL — the
-- COALESCE fallback leg) so backfill queries that scan the
-- fetched_at/created_at tail can also walk a small index.
--
-- Idempotent (IF NOT EXISTS on every CREATE) and CONCURRENTLY so the
-- index build doesn't block writes on the live tables. CONCURRENTLY
-- cannot run inside a transaction block; psql -f (used by
-- scripts/migrate-db.sh and scripts/apply-phase-fixes.sh) does not
-- wrap a file in a transaction by default, so this file is safe to
-- apply as-is.

-- ── news_articles: full COALESCE order-by index ─────────────────────
-- Covers: /api/pins/map and /api/pins/near article leg
--   ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
-- Id DESC as the tiebreaker preserves the same stable order the planner
-- was already producing from the heapsort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS news_articles_published_or_fetched_idx
    ON news_articles (COALESCE(published_at, fetched_at) DESC, id DESC);

-- ── news_articles: partial tail index (published_at IS NULL) ─────────
-- Backfill / re-scan path: when the COALESCE tail dominates (e.g.,
-- historical backfill runs that touch mostly NULL-published rows),
-- this smaller index is even cheaper to walk than the full one above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS news_articles_fetched_only_idx
    ON news_articles (fetched_at DESC, id DESC)
    WHERE published_at IS NULL;

-- ── pins: full COALESCE order-by index ───────────────────────────────
-- Covers: /api/pins/map and /api/pins/near pins leg
--   ORDER BY COALESCE(published_at, created_at) DESC, id DESC
-- pins.published_at is currently NOT NULL with DEFAULT now(), so this
-- index is functionally (published_at DESC, id DESC) for all live rows;
-- the COALESCE wrapper keeps the index valid if published_at ever
-- becomes nullable in a future schema change.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pins_published_or_created_idx
    ON pins (COALESCE(published_at, created_at) DESC, id DESC);

-- ── pins: partial tail index (published_at IS NULL) ──────────────────
-- Currently empty given the NOT NULL default, but kept for parity with
-- the news_articles index above in case published_at is relaxed later.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pins_created_only_idx
    ON pins (created_at DESC, id DESC)
    WHERE published_at IS NULL;

-- ── Refresh planner stats so the new indexes are picked up ───────────
-- ANALYZE is safe inside a transaction; the runner uses CONCURRENTLY
-- for the index builds above (outside any tx) but ANALYZE here is a
-- standalone statement. Skip if the app user lacks ownership — the
-- runner falls back to a superuser, so this will succeed there.
ANALYZE news_articles;
ANALYZE pins;
