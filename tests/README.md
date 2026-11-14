# XYZO Test Suite

## Quick Start

```bash
# Pre-deploy gate (~30s) — run before EVERY deploy
./tests/run_tests.sh quick

# Browser regression (Chrome + Firefox, ~20s)
./tests/run_tests.sh browser

# Full suite
./tests/run_tests.sh all

# Individual suites
./tests/run_tests.sh api        # API routes (bun test)
./tests/run_tests.sh python     # Python unit tests (pytest)
./tests/run_tests.sh worker     # Worker pipeline tests (pytest)
./tests/run_tests.sh browser    # Playwright first-load (Chrome+Firefox)
```

## Test Inventory

| Suite | Runner | Tests | Time | Purpose |
|-------|--------|-------|------|---------|
| `quick` | bun + pytest | ~235 | ~30s | Pre-deploy gate |
| `browser` | Playwright | 10 | ~20s | First-load regression |
| `api` | bun test | 331 | ~60s | All API routes |
| `python` | pytest | ~30 | varies | Python unit tests |
| `worker` | pytest | 26 | ~1s | Worker pipeline (needs DB) |

## Test Files

```
tests/
├── run_tests.sh              # Unified runner
├── test_first_load.js        # Browser: first-load regression (Chrome+Firefox)
├── canvas-race-condition.test.js  # Browser: canvas race condition
├── test_viz.py               # viz.js pure logic
├── test_article_validation.py
├── test_boot_fetch_coordinator.py  # Playwright: boot race (slow, needs browser)
├── test_time_dropdown_wiring.py    # Playwright: time dropdown (slow)
├── test_place_disambiguation.py    # 215 tests, fast
├── ... (30+ more pytest files)

api/tests/
├── *.test.ts                 # 31 bun test files
├── queue/*.test.ts           # Queue system tests

worker/tests/
├── test_*.py                 # 26 worker pipeline tests
```

---

## Known Failures (91 total — all pre-existing)

### Category 1: Admin Auth Test Pollution (49 failures)

**Files:** `tier1-admin-auth.test.ts` (27), `tier2-idempotency.test.ts` (10), `admin.test.ts` (9), `debug-auth.test.ts` (3)

**Root cause:** One test in the chain fails to clean up (truncateAll doesn't work properly with the test DB), leaving stale admin_keys or other data. Every subsequent test that expects a clean DB fails.

**Fix:** Each test file passes when run alone (`bun --env-file=.env.test test tier1-admin-auth.test.ts` → 36 pass, 0 fail). The issue is test isolation. Options:
- Add `--isolate` flag to bun test (runs each file in fresh process)
- Fix `truncateAll()` to be more aggressive (truncate ALL tables, not just 8)
- Add `afterEach` cleanup to the polluting test

### Category 2: Queue Tests — sql.listen (14 failures)

**Files:** `queue/listen.test.ts` (4), `queue/jobQueue.test.ts` (3), `queue/staleClaimSweeper.test.ts` (4), `queue/enqueueOrSpawn.test.ts` (2), `queue/statusWriter.test.ts` (1), `queue/integration.test.ts` (2)

**Root cause:** `sql.listen()` is not a function in postgres.js. The queue system uses PostgreSQL LISTEN/NOTIFY which requires the `pg` module's `client.on('notification')` API. postgres.js doesn't expose this.

**Fix:** Either:
- Switch queue tests to use `pg` module directly for LISTEN/NOTIFY
- Add a postgres.js compatibility shim for `sql.listen()`
- Skip queue tests until the queue system is migrated to a compatible library

### Category 3: Feed Bbox SQL Syntax (5 failures)

**Files:** `feed-bbox.test.ts`

**Root cause:** `sql.unsafe()` used inside a tagged template doesn't interpolate correctly. Line 118 of `feed.ts`:
```typescript
const distCol = distExpr
  ? sql`, ${sql.unsafe(distExpr)} AS distance_km`
  : sql`, NULL::bigint AS distance_km`;
```
Produces `syntax error at or near "AS"` because `sql.unsafe()` returns a Query object that doesn't stringify properly inside another tagged template.

**Fix:** Build the distance column as raw SQL string, not nested tagged templates:
```typescript
const distCol = distExpr
  ? sql`, ${sql.unsafe(distExpr + ' AS distance_km')}`
  : sql`, NULL::bigint AS distance_km`;
```

### Category 4: Missing Columns in Test DB (6 failures)

**Files:** `tier2-indexes.test.ts` (3), `tier25-articles-indexes.test.ts` (3)

**Root cause:** EXPLAIN queries reference columns added by the 5 AIs but never migrated to the test DB. Error: `rows[0]["QUERY PLAN"]` is undefined because the query fails.

**Fix:** Run the missing-columns migration on `xyzo_test`:
```bash
psql "postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo_test" \
  -f api/migrations/2026-09-21-missing-columns-fix.sql
```
Already done for the main DB — just needs to be applied to test DB too.

### Category 5: Community Reeval Missing Columns (4 failures)

**Files:** `community.reeval-map-view.test.ts`

**Root cause:** Same as Category 4 — test DB missing columns that the API code references.

**Fix:** Same migration as above.

### Category 6: Pins Enriched (2 failures)

**Files:** `pins-enriched.test.ts`

**Root cause:** The enriched endpoint now SELECTs `credibility_signals` from `news_articles` (added in tonight's fix). Tests seed articles without this column, and the test DB has the column (migration applied) but the test's `seedArticle()` doesn't include it in INSERT.

**Fix:** Update `seedArticle()` in `pins-enriched.test.ts` to include `credibility_signals` in the INSERT, or add a default value.

---

## Schema Drift Problem

The 5 AIs added code referencing columns that don't exist:
- `news_articles`: 19 columns added by migration `2026-09-21-missing-columns-fix.sql`
- `pins`: `spread_position` column
- `news_events`: `image_url` (via JOIN to articles)

**Rule:** Before adding a column reference in API code, verify the column exists:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='TABLE' AND column_name='COLUMN';
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `XYZO_DB_URL` | from api/.env | DB connection (use `xyzo_test` for tests) |
| `NODE_ENV` | — | Must be `test` for truncateAll to work |

## bunfig.toml

Located at `api/bunfig.toml` — loads `.env.test` during `bun test` so tests hit the isolated `xyzo_test` database instead of production.

---

## Session Notes — Sep 21, 2026

### What We Fixed Tonight

1. **pins.ts:825** — `SELECT image_url FROM pins` → LEFT JOIN editorial_details
2. **pins.ts:888** — Added `url` to enriched article fallback SELECT + `canonical_url` to response
3. **leaflet-heat.js** — Guarded `draw()` and `_reset()` against 0-size canvas
4. **app.js:5521** — Added `canvasRenderer.enable()` before `setPins()` in viewport fetch
5. **app.js:7537** — Title click fallback when no canonical_url (opens details panel)
6. **app.js:7189** — Event headline click fallback when no URL
7. **api/migrations/2026-09-21-missing-columns-fix.sql** — 17 missing columns + status constraint
8. **tests/test_first_load.js** — Browser regression test (Chrome + Firefox)
9. **tests/run_tests.sh** — Unified test runner

### What Needs Doing Next

1. Fix the 91 pre-existing API test failures (see categories above)
2. Add `--isolate` to bun test or fix truncateAll to prevent test pollution
3. Migrate queue tests off `sql.listen()` 
4. Fix feed-bbox `sql.unsafe()` interpolation
5. Ensure `xyzo_test` DB stays in sync with migrations
6. Set up CI to run `quick` + `browser` tests on every push
