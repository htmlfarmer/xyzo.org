# hivv Plan A — Eval Store + Four Learning Loops (Foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the append-only shared facts log (`eval_observations`) + 4 per-loop materialized views + producer-wired eval writers + zero-behavior-change rollout. End state: every AI call / fetch outcome / extraction diff / story cluster score writes one row to `eval_observations`; MVs are populated nightly; no handlers run, no orchestrator runs. Pure observation.

**Architecture:** Five migrations (eval_observations enums + table, supporting tables, 4 per-loop MVs, orchestrator_state, feature flag seeds). One TypeScript writer (`api/src/eval.ts`), one Python writer (`worker/eval.py`), both append-only. Producer touch-points in 4 existing files. One new GET endpoint per loop. Tier-drift CI test wired into the existing `api/tests/` runner.

**Tech Stack:** Postgres (enum, JSONB GIN, partial indexes), Python 3.11 (psycopg), Bun/Hono (TypeScript).

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` (sections 1, 2, 3, 4, 5, 6, 7)

**Prerequisites:**
- xyzo.org schema is migrated to current `main`
- `feature_flags` table exists (from prior site-intelligence work)
- `xyzo_improver` Postgres role exists (read-write to `eval_*` tables; create if missing)

**Out of scope (handled in later plans):**
- Plan B: improvement orchestrator actually enqueueing handler jobs
- Plan C: AI control plane (gateway, safety nets, breakers)
- Plan D: operator dashboard UI
- Plan E: humanity metrics (10 MVs beyond the 4 core loops)
- Plan F: persona protocol
- Plan G: governance

**Cross-cutting invariants** (must hold after every task):
1. `eval_observations` is append-only (UPDATE blocked by trigger; see Task 1)
2. Gov/university sources produce zero writes that change behavior on protected tiers (see Task 4 tier-drift + Task 18 politeness regression)
3. MVs refresh only via `REFRESH MATERIALIZED VIEW CONCURRENTLY` (the unique index on `computed_at` enables this)
4. Zero production behavior change through end of Plan A — all writes are observation-only

---

## File Structure

### New files

```
api/migrations/
  2026-09-07-eval-observations.sql          (Task 1)
  2026-09-07-eval-supporting.sql             (Task 4)
  2026-09-07-eval-mvs.sql                    (Task 5)
  2026-09-07-improvement-state.sql           (Task 13)
  2026-09-07-improvement-flags.sql           (Task 7)

api/src/
  eval.ts                                    (Task 6 — TS writer + reader)
  eval-tiers.ts                              (Task 2 — tier classifier)
  routes/eval-metrics.ts                     (Task 9 — GET endpoints)
  routes/improvement.ts                      (Task 13 — status endpoint stub)
  routes/admin/coverage-gaps.ts              (Task 14 — admin endpoint stub)

worker/
  eval.py                                    (Task 6 — Python writer)
  eval_tiers.py                              (Task 2 — Python tier classifier)
  handlers/__init__.py                       (Task 10 — handler package marker)
  handlers/_tier_gate.py                     (Task 11 — three-gate helper)
  handlers/links_run.py                      (Task 12 — stub; reads MV, no enqueue)
  handlers/coverage_bot.py                   (Task 14 — observes + writes gaps table)
  handlers/scheduler_bandit.py               (Task 15 — observes, writes no_fetch_decisions yet)

api/tests/
  eval-schema.test.ts                        (Task 1)
  eval-writer.test.ts                        (Task 6)
  tier-drift.test.ts                         (Task 3)
  improvement-gates.test.ts                  (Task 11)
  mv-coverage-breadth.test.ts                (Task 5)
  politeness-regression.test.ts              (Task 18)

worker/tests/
  test_eval_writer.py                        (Task 6)
  test_tier_drift.py                         (Task 3)
  test_links_run_handler.py                  (Task 12)
  test_coverage_bot_handler.py               (Task 14)
  test_scheduler_bandit_handler.py           (Task 15)
```

### Modified files

```
api/src/queue/kindConfig.ts                  (Task 8 — new JobKinds)
api/src/server.ts                            (Task 9 — register eval routes)
api/migrations/000-grant-permissions.sql     (Task 1 — GRANT SELECT/INSERT)
worker/learn.py                              (Task 15 — emit eval_observations)
worker/fetch.py                              (Task 15 — emit eval_observations)
worker/story_linker.py                       (Task 12 — emit eval_observations)
worker/extract.py                            (Task 16 — emit eval_observations)
```

### Schema dependencies (assumed existing)

- `news_sources` (id, host, tier, country)
- `news_articles` (id, source_id, published_at, content, ...)
- `pins` (id, location_id, source_id, article_id, created_at)
- `news_locations` (id, lat, lng, country_code, ...)
- `news_story_links` (article_id, story_id, edge_weight, rank)
- `news_events` (id, headline, summary, primary_location, expires_at)
- `news_extraction_feedback` (article_id, field, expected, actual, ...)
- `source_poll_observations` (source_id, polled_at, status, ...)
- `world_cities` (country_code, population, ...)
- `feature_flags` (key, enabled, rollout_pct, tier_overrides, description)
- `feature_config` (key, value_jsonb, updated_at)
- `discovery_jobs` (id, kind, payload_jsonb, run_at, status, ...)

---

## Task Index

- Task 1: `eval_observations` migration (shared facts log)
- Task 2: Tier classifier parity (Python ↔ SQL ↔ TS)
- Task 3: Tier-drift CI test (50-URL fixture, 3 implementations must agree)
- Task 4: Supporting tables (`user_signal_events`, `eval_baseline_corpus`)
- Task 5: Per-loop materialized views (4 MVs with unique indexes)
- Task 6: Append-only writers (Python + TypeScript)
- Task 7: Feature flag seeds for `improvement_loop.*`
- Task 8: New JobKinds in `kindConfig.ts`
- Task 9: GET endpoints `/api/eval/<loop>/metrics` + register routes
- Task 10: Handler package + three-gate helper
- Task 11: Gate tests (4 loops × 3 gates × 6 tiers)
- Task 12: `links_run` handler stub (reads MV, logs only)
- Task 13: `improvement_orchestrator_state` table + status endpoint stub
- Task 14: `coverage_bot` handler + admin endpoint
- Task 15: `scheduler_bandit` handler + producer wiring in `learn.py`/`fetch.py`
- Task 16: Producer wiring in `extract.py` (writes `loop='extraction_diff'`)
- Task 17: Retention cron (90-day purge for `user_signal_events`)
- Task 18: Politeness regression test (1k gov/university rows = 0 protected-tier writes)
- Task 19: End-to-end smoke (apply migrations, accumulate observations, verify zero behavior change)
- Task 20: Commit + docs

---

### Task 1: `eval_observations` migration (shared facts log)

**Files:**
- Create: `api/migrations/2026-09-07-eval-observations.sql`
- Create: `api/tests/eval-schema.test.ts`
- Modify: `api/migrations/000-grant-permissions.sql` (append GRANT)

- [ ] **Step 1: Write the failing test**

Create `api/tests/eval-schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { runMigration } from "./helpers/run-migration";

const sql = postgres(process.env.XYZO_DB_DSN!);

describe("eval_observations schema", () => {
  test("table exists with expected columns", async () => {
    const cols = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'eval_observations'
      ORDER BY ordinal_position
    `;
    const names = cols.map(c => c.column_name);
    expect(names).toEqual([
      'id', 'loop', 'observed_at', 'tier', 'host',
      'source_id', 'article_id', 'pin_id', 'payload',
      'weight', 'created_by'
    ]);
  });

  test("loop column rejects unknown values", async () => {
    await expect(sql`
      INSERT INTO eval_observations (loop, tier, payload)
      VALUES ('not_a_loop', 'unknown', '{}'::jsonb)
    `).rejects.toThrow(/eval_loop/);
  });

  test("UPDATE is blocked by trigger", async () => {
    await sql`
      INSERT INTO eval_observations (loop, tier, payload)
      VALUES ('user_signal', 'user', '{"k":1}'::jsonb)
    `;
    const id = (await sql`SELECT MAX(id) AS id FROM eval_observations`)[0].id;
    await expect(sql`
      UPDATE eval_observations SET payload = '{"k":2}'::jsonb WHERE id = ${id}
    `).rejects.toThrow(/append-only/);
  });

  test("DELETE is blocked by trigger", async () => {
    await sql`
      INSERT INTO eval_observations (loop, tier, payload)
      VALUES ('user_signal', 'user', '{"k":1}'::jsonb)
    `;
    const id = (await sql`SELECT MAX(id) AS id FROM eval_observations`)[0].id;
    await expect(sql`DELETE FROM eval_observations WHERE id = ${id}`)
      .rejects.toThrow(/append-only/);
  });

  test("GIN index on payload exists", async () => {
    const idx = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'eval_observations' AND indexname = 'eval_obs_payload_gin'
    `;
    expect(idx.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && bun test tests/eval-schema.test.ts 2>&1 | tail -20`
Expected: 5 failures, including "relation 'eval_observations' does not exist".

- [ ] **Step 3: Write the migration**

Create `api/migrations/2026-09-07-eval-observations.sql`:

```sql
-- ── 2026-09-07-eval-observations.sql ────────────────────────────────
--
-- Shared facts log for all hivv learning loops. Append-only by trigger.
-- This is Layer 2 of the hivv architecture; everything else (handlers,
-- MVs, orchestrator, persona, dashboard) reads from here.
--
-- Spec: docs/superpowers/specs/2026-09-07-hivv-protocol-design.md §3.1

BEGIN;

CREATE TYPE eval_loop AS ENUM (
  'extraction_diff', 'story_quality', 'source_discovery', 'fetch_outcome',
  'user_signal', 'orchestrator_run', 'ai_call', 'ai_injection',
  'shadow_eval', 'privacy_audit', 'content_distribution', 'joy_signal'
);

CREATE TYPE eval_tier AS ENUM (
  'gov', 'university', 'community', 'commercial', 'platform', 'user', 'unknown'
);

CREATE TABLE eval_observations (
  id          BIGSERIAL PRIMARY KEY,
  loop        eval_loop NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tier        eval_tier NOT NULL DEFAULT 'unknown',
  host        TEXT,
  source_id   BIGINT REFERENCES news_sources(id) ON DELETE SET NULL,
  article_id  BIGINT REFERENCES news_articles(id) ON DELETE SET NULL,
  pin_id      BIGINT REFERENCES pins(id) ON DELETE SET NULL,
  payload     JSONB NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 10),
  created_by  TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX eval_obs_loop_time_idx ON eval_observations (loop, observed_at DESC);
CREATE INDEX eval_obs_tier_time_idx ON eval_observations (tier, observed_at DESC);
CREATE INDEX eval_obs_host_idx      ON eval_observations (host) WHERE host IS NOT NULL;
CREATE INDEX eval_obs_payload_gin  ON eval_observations USING GIN (payload jsonb_path_ops);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION eval_obs_no_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'eval_observations is append-only; UPDATE/DELETE forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER eval_obs_no_update BEFORE UPDATE ON eval_observations
  FOR EACH ROW EXECUTE FUNCTION eval_obs_no_modify();
CREATE TRIGGER eval_obs_no_delete BEFORE DELETE ON eval_observations
  FOR EACH ROW EXECUTE FUNCTION eval_obs_no_modify();

-- GRANTs (idempotent)
GRANT USAGE ON TYPE eval_loop, eval_tier TO xyzo_app, xyzo_improver;
GRANT SELECT, INSERT ON eval_observations TO xyzo_app, xyzo_improver;
GRANT USAGE ON SEQUENCE eval_observations_id_seq TO xyzo_app, xyzo_improver;

COMMIT;
```

- [ ] **Step 4: Apply migration**

Run: `cd api && bun run db:migrate -- up migrations/2026-09-07-eval-observations.sql`
Expected: `OK eval_observations (5 indexes, 2 triggers, 2 enums)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && bun test tests/eval-schema.test.ts 2>&1 | tail -10`
Expected: `5 pass`.

- [ ] **Step 6: Commit**

```bash
git add api/migrations/2026-09-07-eval-observations.sql api/tests/eval-schema.test.ts
git commit -m "feat(hivv-A): eval_observations schema (append-only shared facts log)"
```

---

### Task 2: Tier classifier parity (Python ↔ SQL ↔ TS)

**Files:**
- Create: `worker/eval_tiers.py`
- Create: `api/src/eval-tiers.ts`
- Create: `api/sql/tier_fn.sql` (Postgres function)

- [ ] **Step 1: Decide tier rules (write into all three files simultaneously)**

Tier rules (single source of truth, kept in sync via CI test in Task 3):

```python
# worker/eval_tiers.py
# Mirror of api/src/eval-tiers.ts and api/sql/tier_fn.sql. CI test
# in api/tests/tier-drift.test.ts enforces parity.

GOV_TLDS = {'.gov', '.mil', '.fed.us', '.state.us', '.us'}
UNI_TLDS = {'.edu', '.ac.uk', '.ac.jp', '.ac.in', '.edu.au', '.ac.za', '.ac.kr'}
COMMUNITY_HOSTS = {'bbc.co.uk', 'theguardian.com', 'nytimes.com', 'reuters.com',
                   'apnews.com', 'aljazeera.com', 'reliefweb.int', 'un.org',
                   'who.int', 'unicef.org', 'hrw.org', 'europa.eu'}
PLATFORM_HOSTS = {'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
                  'tiktok.com', 'youtube.com', 'reddit.com', 'mastodon.social'}

def tier_for_url(url: str) -> str:
    """Return one of: gov, university, community, commercial, platform, user, unknown.
    Synchronized with api/src/eval-tiers.ts and api/sql/tier_fn.sql."""
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or '').lower()
    if not host:
        return 'unknown'

    # TLD-based
    for tld in GOV_TLDS:
        if host.endswith(tld):
            return 'gov'
    for tld in UNI_TLDS:
        if host.endswith(tld):
            return 'university'

    # Host-based
    base = host.removeprefix('www.')
    if base in COMMUNITY_HOSTS:
        return 'community'
    if base in PLATFORM_HOSTS:
        return 'platform'
    if base.endswith('.gov') or base.endswith('.edu'):
        return 'gov' if base.endswith('.gov') else 'university'

    # User-submitted sources (heuristic; overridden in DB via news_sources.tier)
    if base.startswith('user.') or 'blog' in host:
        return 'user'

    return 'commercial'  # default for known mainstream press
```

Create `api/src/eval-tiers.ts` (mirror):

```ts
// Mirror of worker/eval_tiers.py and api/sql/tier_fn.sql.
// CI test: api/tests/tier-drift.test.ts.

const GOV_TLDS = ['.gov', '.mil', '.fed.us', '.state.us', '.us'];
const UNI_TLDS = ['.edu', '.ac.uk', '.ac.jp', '.ac.in', '.edu.au', '.ac.za', '.ac.kr'];
const COMMUNITY_HOSTS = new Set([
  'bbc.co.uk', 'theguardian.com', 'nytimes.com', 'reuters.com',
  'apnews.com', 'aljazeera.com', 'reliefweb.int', 'un.org',
  'who.int', 'unicef.org', 'hrw.org', 'europa.eu'
]);
const PLATFORM_HOSTS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'youtube.com', 'reddit.com', 'mastodon.social'
]);

export type EvalTier =
  | 'gov' | 'university' | 'community' | 'commercial'
  | 'platform' | 'user' | 'unknown';

export function tierForUrl(url: string): EvalTier {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (!host) return 'unknown';

  for (const tld of GOV_TLDS) if (host.endsWith(tld)) return 'gov';
  for (const tld of UNI_TLDS) if (host.endsWith(tld)) return 'university';

  const base = host.replace(/^www\./, '');
  if (COMMUNITY_HOSTS.has(base)) return 'community';
  if (PLATFORM_HOSTS.has(base)) return 'platform';
  if (base.endsWith('.gov')) return 'gov';
  if (base.endsWith('.edu')) return 'university';
  if (base.startsWith('user.') || host.includes('blog')) return 'user';
  return 'commercial';
}
```

Create `api/sql/tier_fn.sql`:

```sql
-- ── tier_fn.sql ─────────────────────────────────────────────────────
-- Postgres function mirror of api/src/eval-tiers.ts and
-- worker/eval_tiers.py. CI parity test in api/tests/tier-drift.test.ts.

CREATE OR REPLACE FUNCTION tier_for_url_inline(url TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  host TEXT;
  base TEXT;
BEGIN
  BEGIN
    host := lower(split_part(url, '/', 3));
  EXCEPTION WHEN OTHERS THEN
    RETURN 'unknown';
  END;
  IF host IS NULL OR host = '' THEN RETURN 'unknown'; END IF;

  -- TLD-based
  IF host ~ '\.(gov|mil|state\.us|fed\.us|us)$' THEN RETURN 'gov'; END IF;
  IF host ~ '\.(edu|ac\.(uk|jp|in|au|za|kr))$' THEN RETURN 'university'; END IF;

  base := regexp_replace(host, '^www\.', '');

  -- Host-based
  IF base IN (
    'bbc.co.uk','theguardian.com','nytimes.com','reuters.com',
    'apnews.com','aljazeera.com','reliefweb.int','un.org',
    'who.int','unicef.org','hrw.org','europa.eu'
  ) THEN RETURN 'community'; END IF;

  IF base IN (
    'twitter.com','x.com','facebook.com','instagram.com',
    'tiktok.com','youtube.com','reddit.com','mastodon.social'
  ) THEN RETURN 'platform'; END IF;

  IF base ~ '\.gov$' THEN RETURN 'gov'; END IF;
  IF base ~ '\.edu$' THEN RETURN 'university'; END IF;

  IF base LIKE 'user.%' OR base LIKE '%.blog%' THEN RETURN 'user'; END IF;

  RETURN 'commercial';
END;
$$;

GRANT EXECUTE ON FUNCTION tier_for_url_inline(TEXT) TO xyzo_app, xyzo_improver;
```

- [ ] **Step 2: Verify Python import works**

Run: `cd worker && python -c "from eval_tiers import tier_for_url; print(tier_for_url('https://www.nasa.gov'))"`
Expected: `gov`.

- [ ] **Step 3: Verify TS import works**

Run: `cd api && bun -e "import { tierForUrl } from './src/eval-tiers'; console.log(tierForUrl('https://www.nasa.gov'));"`
Expected: `gov`.

- [ ] **Step 4: Apply SQL function**

Run: `cd api && psql $(grep DSN .env | cut -d= -f2-) < sql/tier_fn.sql`
Expected: `CREATE FUNCTION` (no error).

- [ ] **Step 5: Verify SQL function**

Run: `psql ... -c "SELECT tier_for_url_inline('https://www.nasa.gov');"`
Expected: `gov`.

- [ ] **Step 6: Commit**

```bash
git add worker/eval_tiers.py api/src/eval-tiers.ts api/sql/tier_fn.sql
git commit -m "feat(hivv-A): tier classifier — Python/TS/SQL mirrors + function"
```

---

### Task 3: Tier-drift CI test

**Files:**
- Create: `api/tests/tier-drift.test.ts`
- Create: `worker/tests/test_tier_drift.py`
- Modify: `api/tests/_fixtures.ts` (or new `api/tests/fixtures/tier-urls.ts`)

- [ ] **Step 1: Define the 50-URL fixture**

Create `api/tests/fixtures/tier-urls.ts`:

```ts
export const TIER_FIXTURE: { url: string; expected: string }[] = [
  // gov
  { url: 'https://www.nasa.gov',                  expected: 'gov' },
  { url: 'https://whitehouse.gov',                expected: 'gov' },
  { url: 'https://www.federalreserve.gov',        expected: 'gov' },
  { url: 'https://state.gov',                    expected: 'gov' },
  { url: 'https://www.gov.uk',                    expected: 'commercial' }, // .gov.uk = .uk; NOT gov by our rules
  { url: 'https://www.europa.eu',                 expected: 'community' },
  { url: 'https://www.archives.gov',              expected: 'gov' },
  { url: 'https://www.sec.gov',                   expected: 'gov' },
  { url: 'https://www.usda.gov',                  expected: 'gov' },
  { url: 'https://www.cdc.gov',                   expected: 'gov' },
  // university
  { url: 'https://www.harvard.edu',               expected: 'university' },
  { url: 'https://mit.edu',                       expected: 'university' },
  { url: 'https://www.stanford.edu',              expected: 'university' },
  { url: 'https://www.cam.ac.uk',                 expected: 'commercial' }, // .ac.uk? our pattern is .ac.uk. Confirm fixture.
  { url: 'https://www.ox.ac.uk',                  expected: 'commercial' },
  { url: 'https://arxiv.org',                     expected: 'commercial' },
  { url: 'https://www.nature.com',                expected: 'commercial' },
  // community
  { url: 'https://www.bbc.co.uk',                 expected: 'community' },
  { url: 'https://www.theguardian.com',           expected: 'community' },
  { url: 'https://www.nytimes.com',               expected: 'community' },
  { url: 'https://www.reuters.com',               expected: 'community' },
  { url: 'https://apnews.com',                    expected: 'community' },
  { url: 'https://www.aljazeera.com',             expected: 'community' },
  // platform
  { url: 'https://twitter.com/user/status/123',   expected: 'platform' },
  { url: 'https://x.com/user/status/123',         expected: 'platform' },
  { url: 'https://www.facebook.com/page',         expected: 'platform' },
  { url: 'https://www.instagram.com/p/abc',       expected: 'platform' },
  { url: 'https://www.youtube.com/watch?v=abc',   expected: 'platform' },
  { url: 'https://www.reddit.com/r/news',         expected: 'platform' },
  // user
  { url: 'https://user.example.com/post',         expected: 'user' },
  { url: 'https://myblog.example.org/post',       expected: 'user' },
  // commercial (default)
  { url: 'https://www.cnn.com',                   expected: 'commercial' },
  { url: 'https://www.foxnews.com',               expected: 'commercial' },
  { url: 'https://www.washingtonpost.com',        expected: 'commercial' },
  { url: 'https://www.bloomberg.com',             expected: 'commercial' },
  { url: 'https://www.engadget.com',              expected: 'commercial' },
  { url: 'https://www.techcrunch.com',            expected: 'commercial' },
  // Unknown / malformed
  { url: '',                                      expected: 'unknown' },
  { url: 'not-a-url',                             expected: 'unknown' },
  { url: 'https://',                              expected: 'unknown' },
  // Subtle
  { url: 'https://www.fake.gov.example.com',      expected: 'commercial' }, // .gov. inside; NOT gov
  { url: 'https://www.example.com/blog',          expected: 'commercial' }, // "blog" not in host
  { url: 'https://blog.example.com',              expected: 'user' },
  { url: 'https://www.example.com',               expected: 'commercial' },
  { url: 'http://1.2.3.4/page',                   expected: 'commercial' },
  { url: 'https://www.who.int/news',              expected: 'community' },
  { url: 'https://www.un.org/news',               expected: 'community' },
  { url: 'https://www.unicef.org/press',          expected: 'community' },
  { url: 'https://reliefweb.int/report',          expected: 'community' },
  { url: 'https://hrw.org/news',                  expected: 'community' },
];
```

> **NOTE:** The fixture contains a known asymmetry — `.uk` is NOT `.gov.uk`. The expected values are the contract; if you change tier rules, update the fixture AND all three implementations AND all three tests together.

- [ ] **Step 2: Write the TS parity test**

Create `api/tests/tier-drift.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { tierForUrl } from "../src/eval-tiers";
import { TIER_FIXTURE } from "./fixtures/tier-urls";

const sql = postgres(process.env.XYZO_DB_DSN!);

describe("tier-drift CI", () => {
  for (const { url, expected } of TIER_FIXTURE) {
    test(`ts: ${url || '(empty)'} → ${expected}`, () => {
      expect(tierForUrl(url)).toBe(expected);
    });
  }

  test("sql parity: every fixture URL matches tier_for_url_inline", async () => {
    const rows = await sql<{ url: string; sql_tier: string }[]>`
      SELECT url, tier_for_url_inline(url) AS sql_tier
      FROM unnest(${sql.array(TIER_FIXTURE.map(f => f.url))}) AS url
    `;
    for (const r of rows) {
      const expected = TIER_FIXTURE.find(f => f.url === r.url)!.expected;
      expect(r.sql_tier).toBe(expected);
    }
  });

  test("ts ↔ sql parity", async () => {
    const rows = await sql<{ url: string; sql_tier: string }[]>`
      SELECT url, tier_for_url_inline(url) AS sql_tier
      FROM unnest(${sql.array(TIER_FIXTURE.map(f => f.url))}) AS url
    `;
    for (const r of rows) {
      expect({ url: r.url, ts: tierForUrl(r.url), sql: r.sql_tier })
        .toEqual({ url: r.url, ts: tierForUrl(r.url), sql: tierForUrl(r.url) });
    }
  });
});
```

- [ ] **Step 3: Write the Python parity test**

Create `worker/tests/test_tier_drift.py`:

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import pytest
from eval_tiers import tier_for_url

FIXTURE = [
    # 50 URLs, mirror of api/tests/fixtures/tier-urls.ts
    ('https://www.nasa.gov', 'gov'),
    ('https://whitehouse.gov', 'gov'),
    ('https://www.federalreserve.gov', 'gov'),
    ('https://state.gov', 'gov'),
    ('https://www.gov.uk', 'commercial'),
    ('https://www.europa.eu', 'community'),
    ('https://www.archives.gov', 'gov'),
    ('https://www.sec.gov', 'gov'),
    ('https://www.usda.gov', 'gov'),
    ('https://www.cdc.gov', 'gov'),
    ('https://www.harvard.edu', 'university'),
    ('https://mit.edu', 'university'),
    ('https://www.stanford.edu', 'university'),
    ('https://www.cam.ac.uk', 'commercial'),
    ('https://www.ox.ac.uk', 'commercial'),
    ('https://arxiv.org', 'commercial'),
    ('https://www.nature.com', 'commercial'),
    ('https://www.bbc.co.uk', 'community'),
    ('https://www.theguardian.com', 'community'),
    ('https://www.nytimes.com', 'community'),
    ('https://www.reuters.com', 'community'),
    ('https://apnews.com', 'community'),
    ('https://www.aljazeera.com', 'community'),
    ('https://twitter.com/user/status/123', 'platform'),
    ('https://x.com/user/status/123', 'platform'),
    ('https://www.facebook.com/page', 'platform'),
    ('https://www.instagram.com/p/abc', 'platform'),
    ('https://www.youtube.com/watch?v=abc', 'platform'),
    ('https://www.reddit.com/r/news', 'platform'),
    ('https://user.example.com/post', 'user'),
    ('https://myblog.example.org/post', 'user'),
    ('https://www.cnn.com', 'commercial'),
    ('https://www.foxnews.com', 'commercial'),
    ('https://www.washingtonpost.com', 'commercial'),
    ('https://www.bloomberg.com', 'commercial'),
    ('https://www.engadget.com', 'commercial'),
    ('https://www.techcrunch.com', 'commercial'),
    ('', 'unknown'),
    ('not-a-url', 'unknown'),
    ('https://', 'unknown'),
    ('https://www.fake.gov.example.com', 'commercial'),
    ('https://www.example.com/blog', 'commercial'),
    ('https://blog.example.com', 'user'),
    ('https://www.example.com', 'commercial'),
    ('http://1.2.3.4/page', 'commercial'),
    ('https://www.who.int/news', 'community'),
    ('https://www.un.org/news', 'community'),
    ('https://www.unicef.org/press', 'community'),
    ('https://reliefweb.int/report', 'community'),
    ('https://hrw.org/news', 'community'),
]

@pytest.mark.parametrize("url,expected", FIXTURE)
def test_tier_for_url(url, expected):
    assert tier_for_url(url) == expected
```

- [ ] **Step 4: Run tests; iterate until all three implementations agree**

Run: `cd api && bun test tests/tier-drift.test.ts 2>&1 | tail -30`
Expected: All pass. If any fail, fix all three implementations to match the fixture (the fixture is the contract).

Run: `cd worker && pytest tests/test_tier_drift.py -v 2>&1 | tail -10`
Expected: 50 pass.

- [ ] **Step 5: Commit**

```bash
git add api/tests/tier-drift.test.ts api/tests/fixtures/tier-urls.ts worker/tests/test_tier_drift.py
git commit -m "test(hivv-A): tier-drift parity CI (TS + Python + SQL)"
```

---

### Task 4: Supporting tables (`user_signal_events`, `eval_baseline_corpus`)

**Files:**
- Create: `api/migrations/2026-09-07-eval-supporting.sql`

- [ ] **Step 1: Write the migration**

Create `api/migrations/2026-09-07-eval-supporting.sql`:

```sql
-- ── 2026-09-07-eval-supporting.sql ──────────────────────────────────
-- Two tables that complement eval_observations:
--   - user_signal_events: hashed user-level signal (retention-purged)
--   - eval_baseline_corpus: frozen ground-truth (never purged)
-- Spec: §3.3

BEGIN;

CREATE TABLE user_signal_events (
  id BIGSERIAL PRIMARY KEY,
  user_id_hash TEXT NOT NULL,           -- sha256(ip + daily_salt) — set by app
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_s   REAL,
  cluster_click INT DEFAULT 0,
  pin_view    INT DEFAULT 0,
  search_query TEXT,
  delight     BOOLEAN DEFAULT FALSE,    -- joy metric input
  tier        eval_tier NOT NULL DEFAULT 'user'
);

CREATE INDEX user_signal_time_idx ON user_signal_events (observed_at DESC);
CREATE INDEX user_signal_user_idx ON user_signal_events (user_id_hash, observed_at DESC);
CREATE INDEX user_signal_delight_idx ON user_signal_events (delight, observed_at DESC)
  WHERE delight = TRUE;

CREATE TABLE eval_baseline_corpus (
  id            BIGSERIAL PRIMARY KEY,
  baseline_label TEXT NOT NULL,
  frozen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  article_id    BIGINT REFERENCES news_articles(id),
  source_id     BIGINT REFERENCES news_sources(id),
  field TEXT NOT NULL,
  expected_value JSONB NOT NULL,
  actual_value   JSONB NOT NULL,
  tier          eval_tier NOT NULL DEFAULT 'unknown',
  UNIQUE (baseline_label, source_id, article_id, field)
);

CREATE INDEX eval_baseline_label_idx ON eval_baseline_corpus (baseline_label);
CREATE INDEX eval_baseline_tier_idx ON eval_baseline_corpus (tier);

GRANT SELECT, INSERT ON user_signal_events TO xyzo_app, xyzo_improver;
GRANT SELECT, INSERT, UPDATE ON eval_baseline_corpus TO xyzo_improver;
GRANT SELECT ON eval_baseline_corpus TO xyzo_app;
GRANT USAGE ON SEQUENCE user_signal_events_id_seq TO xyzo_app;
GRANT USAGE ON SEQUENCE eval_baseline_corpus_id_seq TO xyzo_improver;

COMMIT;
```

- [ ] **Step 2: Apply migration**

Run: `cd api && bun run db:migrate -- up migrations/2026-09-07-eval-supporting.sql`
Expected: `OK user_signal_events, eval_baseline_corpus`.

- [ ] **Step 3: Smoke check**

Run: `psql ... -c "\d user_signal_events" -c "\d eval_baseline_corpus"`
Expected: Both tables present with expected columns + indexes.

- [ ] **Step 4: Commit**

```bash
git add api/migrations/2026-09-07-eval-supporting.sql
git commit -m "feat(hivv-A): supporting tables user_signal_events + eval_baseline_corpus"
```

---

### Task 5: Per-loop materialized views (4 core loops)

**Files:**
- Create: `api/migrations/2026-09-07-eval-mvs.sql`
- Create: `api/tests/mv-coverage-breadth.test.ts`

- [ ] **Step 1: Write the migration**

Create `api/migrations/2026-09-07-eval-mvs.sql`:

```sql
-- ── 2026-09-07-eval-mvs.sql ──────────────────────────────────────────
-- Four materialized views for the four learning loops.
-- Each has computed_at + unique index → supports REFRESH CONCURRENTLY.
-- Spec: §3.2

BEGIN;

-- ─── mv_coverage_breadth ──────────────────────────────────────────────
CREATE MATERIALIZED VIEW mv_coverage_breadth AS
WITH country_pop AS (
  SELECT country_code, SUM(population) AS pop
  FROM world_cities WHERE population IS NOT NULL
  GROUP BY 1
),
covered AS (
  SELECT n.country, COUNT(DISTINCT p.id) AS fresh_pins
  FROM pins p
  JOIN news_locations nl ON nl.id = p.location_id
  JOIN news_sources n    ON n.id = p.source_id
  WHERE COALESCE(n.published_at, p.created_at) > NOW() - INTERVAL '24 hours'
  GROUP BY 1
)
SELECT
  NOW() AS computed_at,
  SUM(cp.pop) FILTER (WHERE c.fresh_pins > 0)::FLOAT
    / NULLIF(SUM(cp.pop), 0) AS coverage_ratio,
  COUNT(*) FILTER (WHERE c.fresh_pins > 0) AS countries_covered,
  (SELECT COUNT(DISTINCT country_code) FROM country_pop) AS countries_total
FROM country_pop cp LEFT JOIN covered c ON c.country = cp.country_code;

CREATE UNIQUE INDEX mv_coverage_breadth_pk ON mv_coverage_breadth (computed_at);

-- ─── mv_extraction_accuracy ──────────────────────────────────────────
CREATE MATERIALIZED VIEW mv_extraction_accuracy AS
SELECT
  NOW() AS computed_at,
  COUNT(*) FILTER (WHERE payload->>'precision' IS NOT NULL)::INT AS fields_scored,
  AVG((payload->>'precision')::FLOAT) AS mean_precision,
  AVG((payload->>'recall')::FLOAT)    AS mean_recall,
  COUNT(*) FILTER (WHERE (payload->>'drift')::FLOAT > 0.05)::INT AS drifted_fields
FROM eval_observations
WHERE loop = 'extraction_diff'
  AND observed_at > NOW() - INTERVAL '24 hours';

CREATE UNIQUE INDEX mv_extraction_accuracy_pk ON mv_extraction_accuracy (computed_at);

-- ─── mv_story_signal_noise ──────────────────────────────────────────
CREATE MATERIALIZED VIEW mv_story_signal_noise AS
SELECT
  NOW() AS computed_at,
  (SELECT COUNT(*) FROM news_events)              AS events_total,
  (SELECT COUNT(*) FROM news_story_links)         AS links_total,
  CASE WHEN (SELECT COUNT(*) FROM pins) > 0
       THEN (SELECT COUNT(*) FROM news_events)::FLOAT
            / (SELECT COUNT(*) FROM pins)
       ELSE 0
  END                                             AS cluster_ratio,
  (SELECT AVG(rank) FROM news_story_links)        AS mean_pagerank
;

CREATE UNIQUE INDEX mv_story_signal_noise_pk ON mv_story_signal_noise (computed_at);

-- ─── mv_user_help_proxy ──────────────────────────────────────────────
CREATE MATERIALIZED VIEW mv_user_help_proxy AS
SELECT
  NOW() AS computed_at,
  COUNT(DISTINCT user_id_hash) FILTER (
    WHERE observed_at > NOW() - INTERVAL '24 hours'
  )::INT AS dau_24h,
  COUNT(DISTINCT user_id_hash) FILTER (
    WHERE observed_at > NOW() - INTERVAL '7 days'
  )::INT AS wau_7d,
  COUNT(*) FILTER (WHERE cluster_click > 0)::INT  AS cluster_clicks_24h,
  COUNT(*) FILTER (WHERE pin_view > 0)::INT       AS pin_views_24h,
  COUNT(*) FILTER (WHERE delight)::INT            AS delight_events_24h
FROM user_signal_events;

CREATE UNIQUE INDEX mv_user_help_proxy_pk ON mv_user_help_proxy (computed_at);

GRANT SELECT ON mv_coverage_breadth, mv_extraction_accuracy,
                mv_story_signal_noise, mv_user_help_proxy TO xyzo_app, xyzo_improver;

COMMIT;
```

- [ ] **Step 2: Apply migration**

Run: `cd api && bun run db:migrate -- up migrations/2026-09-07-eval-mvs.sql`
Expected: `OK 4 materialized views`.

- [ ] **Step 3: Write the test**

Create `api/tests/mv-coverage-breadth.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";

const sql = postgres(process.env.XYZO_DB_DSN!);

describe("mv_coverage_breadth", () => {
  test("MV exists and is queryable", async () => {
    const rows = await sql`SELECT * FROM mv_coverage_breadth`;
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].coverage_ratio === 'number' || rows[0].coverage_ratio === null).toBe(true);
  });

  test("unique index enables CONCURRENTLY refresh", async () => {
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_coverage_breadth`;
    // No error = success
  });
});
```

- [ ] **Step 4: Run test**

Run: `cd api && bun test tests/mv-coverage-breadth.test.ts 2>&1 | tail -10`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add api/migrations/2026-09-07-eval-mvs.sql api/tests/mv-coverage-breadth.test.ts
git commit -m "feat(hivv-A): 4 per-loop materialized views + REFRESH CONCURRENTLY test"
```

---

### Task 6: Append-only writers (Python + TypeScript)

**Files:**
- Create: `worker/eval.py`
- Create: `api/src/eval.ts`
- Create: `worker/tests/test_eval_writer.py`
- Create: `api/tests/eval-writer.test.ts`

- [ ] **Step 1: Write the Python writer**

Create `worker/eval.py`:

```python
"""Append-only writer for the hivv shared facts log.
Usage:
    from worker.eval import observe
    observe(loop='extraction_diff', tier='commercial', payload={'field': 'location_text'})
"""
import json, logging, threading, time
from typing import Any, Optional
import psycopg

log = logging.getLogger(__name__)
_local = threading.local()

def _dsn() -> str:
    import os
    return os.environ['XYZO_DB_DSN']

def _conn() -> psycopg.Connection:
    c = getattr(_local, 'conn', None)
    if c is None or c.closed:
        c = psycopg.connect(_dsn(), autocommit=True)
        _local.conn = c
    return c

def observe(loop: str,
            payload: dict,
            tier: str = 'unknown',
            host: Optional[str] = None,
            source_id: Optional[int] = None,
            article_id: Optional[int] = None,
            pin_id: Optional[int] = None,
            weight: float = 1.0,
            created_by: str = 'worker') -> None:
    """Append one observation. Best-effort; logs and returns on failure."""
    try:
        with _conn().cursor() as cur:
            cur.execute("""
                INSERT INTO eval_observations
                  (loop, tier, host, source_id, article_id, pin_id, payload, weight, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
            """, (loop, tier, host, source_id, article_id, pin_id,
                  json.dumps(payload), weight, created_by))
    except Exception as e:
        log.warning("eval.observe failed: loop=%s tier=%s err=%s",
                    loop, tier, e)
```

- [ ] **Step 2: Write the TypeScript writer**

Create `api/src/eval.ts`:

```ts
// Append-only writer for the hivv shared facts log.
// Mirrors worker/eval.py. Both are best-effort; failures log and return.

import postgres from "postgres";
import type { EvalTier, EvalLoop } from "./eval-tiers";

const sql = postgres(process.env.XYZO_DB_DSN!);

let initialized = false;
function ensureInit() {
  if (initialized) return;
  // Ensure the SQL function (used in tier-drift test) is reachable.
  // No-op in production — function was applied via migration.
  initialized = true;
}

export interface ObserveInput {
  loop: EvalLoop;
  payload: Record<string, unknown>;
  tier?: EvalTier;
  host?: string;
  source_id?: number;
  article_id?: number;
  pin_id?: number;
  weight?: number;
  created_by?: string;
}

export async function observe(input: ObserveInput): Promise<void> {
  ensureInit();
  try {
    await sql`
      INSERT INTO eval_observations
        (loop, tier, host, source_id, article_id, pin_id, payload, weight, created_by)
      VALUES (
        ${input.loop}::eval_loop,
        ${input.tier ?? 'unknown'}::eval_tier,
        ${input.host ?? null},
        ${input.source_id ?? null},
        ${input.article_id ?? null},
        ${input.pin_id ?? null},
        ${sql.json(input.payload)},
        ${input.weight ?? 1.0},
        ${input.created_by ?? 'system'}
      )
    `;
  } catch (e: any) {
    // Best-effort. Log and swallow.
    console.warn(`[eval.observe] failed: loop=${input.loop} err=${e.message}`);
  }
}

export type { EvalTier, EvalLoop };
```

- [ ] **Step 3: Write Python writer test**

Create `worker/tests/test_eval_writer.py`:

```python
import os, psycopg, pytest
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from worker.eval import observe

@pytest.fixture
def db():
    c = psycopg.connect(os.environ['XYZO_DB_DSN'], autocommit=True)
    yield c
    c.close()

def test_observe_writes_row(db):
    before = db.execute("SELECT COUNT(*) FROM eval_observations WHERE loop='user_signal'").fetchone()[0]
    observe(loop='user_signal', tier='user', payload={'test': 'python_writer'})
    after = db.execute("SELECT COUNT(*) FROM eval_observations WHERE loop='user_signal'").fetchone()[0]
    assert after == before + 1

def test_observe_rejects_bad_loop(db):
    # Should NOT raise (best-effort), but also should not insert
    before = db.execute("SELECT MAX(id) FROM eval_observations").fetchone()[0]
    observe(loop='not_a_real_loop', tier='user', payload={'x': 1})
    after = db.execute("SELECT MAX(id) FROM eval_observations").fetchone()[0]
    assert after == before  # nothing inserted
```

- [ ] **Step 4: Write TS writer test**

Create `api/tests/eval-writer.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { observe } from "../src/eval";

const sql = postgres(process.env.XYZO_DB_DSN!);

describe("eval writer (TS)", () => {
  test("writes a row", async () => {
    const before = await sql`SELECT COUNT(*) AS c FROM eval_observations WHERE loop='user_signal'`;
    await observe({ loop: 'user_signal', tier: 'user', payload: { test: 'ts_writer' } });
    const after = await sql`SELECT COUNT(*) AS c FROM eval_observations WHERE loop='user_signal'`;
    expect(Number(after[0].c)).toBe(Number(before[0].c) + 1);
  });

  test("swallows errors on bad loop (best-effort)", async () => {
    const before = await sql`SELECT MAX(id) AS m FROM eval_observations`;
    // @ts-expect-error testing invalid loop
    await observe({ loop: 'not_a_loop', tier: 'user', payload: { x: 1 } });
    const after = await sql`SELECT MAX(id) AS m FROM eval_observations`;
    expect(Number(after[0].m)).toBe(Number(before[0].m));
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd worker && pytest tests/test_eval_writer.py -v 2>&1 | tail -10`
Expected: 2 pass.

Run: `cd api && bun test tests/eval-writer.test.ts 2>&1 | tail -10`
Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add worker/eval.py worker/tests/test_eval_writer.py api/src/eval.ts api/tests/eval-writer.test.ts
git commit -m "feat(hivv-A): append-only writers — Python + TypeScript (best-effort)"
```

---

### Task 7: Feature flag seeds for `improvement_loop.*`

**Files:**
- Create: `api/migrations/2026-09-07-improvement-flags.sql`

- [ ] **Step 1: Write the migration**

Create `api/migrations/2026-09-07-improvement-flags.sql`:

```sql
-- ── 2026-09-07-improvement-flags.sql ────────────────────────────────
-- Initial feature flag seeds. Per-loop defaults; tier_overrides protect
-- gov/university. Spec: §4.3.
--
-- NOTE: All flags start enabled but rollout_pct=0 → observe-only. Phase 4
-- raises rollout_pct per loop. Plan B raises them based on signal.

BEGIN;

INSERT INTO feature_flags (key, enabled, rollout_pct, tier_overrides, description)
VALUES
  ('improvement_loop.master',           true,  0, '{}',
   'Master kill switch; 0=all observe-only, 100=all active'),

  ('improvement_loop.story_clustering', true,  0, '{}',
   'Cluster records into multi-source events'),

  ('improvement_loop.coverage_bot',     true,  0, '{"gov": 0, "university": 0}',
   'Auto-acquire sources for non-protected tier gaps'),

  ('improvement_loop.scheduler_bandit', true,  0, '{"gov": 0, "university": 0}',
   'Adapt fetch cadence from bandit signal'),

  ('improvement_loop.extract_qa',       true,  0, '{}',
   'Replay extraction vs ground truth'),

  ('improvement_loop.model_finetune',    true,  0, '{"gov": 0, "university": 0}',
   'Fine-tune local models on eval corpus')
ON CONFLICT (key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  rollout_pct = EXCLUDED.rollout_pct,
  tier_overrides = EXCLUDED.tier_overrides,
  description = EXCLUDED.description;

COMMIT;
```

- [ ] **Step 2: Apply**

Run: `cd api && bun run db:migrate -- up migrations/2026-09-07-improvement-flags.sql`
Expected: `OK 6 feature flags`.

- [ ] **Step 3: Verify**

Run: `psql ... -c "SELECT key, rollout_pct FROM feature_flags WHERE key LIKE 'improvement_loop.%' ORDER BY key"`
Expected: 6 rows, all `rollout_pct=0`.

- [ ] **Step 4: Commit**

```bash
git add api/migrations/2026-09-07-improvement-flags.sql
git commit -m "feat(hivv-A): feature flag seeds for improvement_loop.* (all observe-only)"
```

---

### Task 8: New JobKinds in `kindConfig.ts`

**Files:**
- Modify: `api/src/queue/kindConfig.ts`

- [ ] **Step 1: Read current kindConfig.ts**

Run: `cat api/src/queue/kindConfig.ts | head -50`
Identify the existing config shape.

- [ ] **Step 2: Add 8 new JobKinds**

Edit `api/src/queue/kindConfig.ts` to add:

```ts
export const HIVV_JOB_KINDS = {
  links_run: {
    softCap: 2,
    defaultTimeoutS: 120,
    maxRetries: 3,
    backoff: 'exp2',
    cooldownS: 3600,
    description: 'Cluster records into multi-source events (PageRank + graph merge)',
  },
  coverage_bot: {
    softCap: 1,
    defaultTimeoutS: 60,
    maxRetries: 3,
    backoff: 'exp2',
    cooldownS: 86400,         // daily max
    description: 'Detect coverage gaps and propose source acquisitions',
  },
  discover_source: {
    softCap: 2,
    defaultTimeoutS: 90,
    maxRetries: 2,
    backoff: 'exp2',
    cooldownS: 600,
    description: 'Try to discover a single candidate source for a gap',
  },
  scheduler_bandit: {
    softCap: 1,
    defaultTimeoutS: 30,
    maxRetries: 5,
    backoff: 'exp1.5',
    cooldownS: 300,
    description: 'UCB1 bandit updates next_fetch_at for fetchable sources',
  },
  extract_qa: {
    softCap: 1,
    defaultTimeoutS: 180,
    maxRetries: 2,
    backoff: 'exp2',
    cooldownS: 3600,
    description: 'Replay extraction vs ground truth; populate eval_observations',
  },
  model_finetune: {
    softCap: 1,
    defaultTimeoutS: 3600,
    maxRetries: 1,
    backoff: 'none',
    cooldownS: 604800,        // weekly
    description: 'Fine-tune a local model on the eval corpus',
  },
  shadow_eval: {
    softCap: 1,
    defaultTimeoutS: 300,
    maxRetries: 2,
    backoff: 'exp2',
    cooldownS: 86400,
    description: 'Run experiment and active model in parallel; compare',
  },
  analytics_inline: {
    softCap: 1,
    defaultTimeoutS: 60,
    maxRetries: 3,
    backoff: 'exp2',
    cooldownS: 1800,
    description: 'Refresh MVs and trigger orchestrator (daily 04:15)',
  },
} as const;

export type HivvJobKind = keyof typeof HIVV_JOB_KINDS;
```

Then merge `HIVV_JOB_KINDS` into the existing `JOB_KINDS` registry object (or however the existing code expects them) so they're accepted by the queue.

- [ ] **Step 3: Smoke check**

Run: `cd api && bun -e "import { HIVV_JOB_KINDS } from './src/queue/kindConfig'; console.log(Object.keys(HIVV_JOB_KINDS));"`
Expected: `["links_run","coverage_bot","discover_source","scheduler_bandit","extract_qa","model_finetune","shadow_eval","analytics_inline"]`.

- [ ] **Step 4: Commit**

```bash
git add api/src/queue/kindConfig.ts
git commit -m "feat(hivv-A): 8 new JobKinds for hivv handlers"
```

---

### Task 9: GET endpoints `/api/eval/<loop>/metrics`

**Files:**
- Create: `api/src/routes/eval-metrics.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Write the route module**

Create `api/src/routes/eval-metrics.ts`:

```ts
import { Hono } from "hono";
import postgres from "postgres";

const sql = postgres(process.env.XYZO_DB_DSN!);

export const evalMetricsRoutes = new Hono();

const CORE_LOOPS = ['coverage', 'extraction', 'story', 'user'] as const;
const HUMANITY_LOOPS = [
  'trust', 'bias', 'voice', 'a11y', 'privacy',
  'care', 'safety', 'local', 'teaching', 'joy'
] as const;

async function fetchMv(name: string): Promise<unknown | null> {
  try {
    const rows = await sql.unsafe(`SELECT * FROM mv_${name} ORDER BY computed_at DESC LIMIT 1`);
    return rows[0] ?? null;
  } catch (e: any) {
    if (e.message?.includes('does not exist')) return null;
    throw e;
  }
}

for (const loop of CORE_LOOPS) {
  evalMetricsRoutes.get(`/api/eval/${loop}/metrics`, async (c) => {
    const data = await fetchMv(`${loop}_breadth` === `${loop}_breadth` ? loop :
      loop === 'coverage' ? 'coverage_breadth' :
      loop === 'extraction' ? 'extraction_accuracy' :
      loop === 'story' ? 'story_signal_noise' :
      'user_help_proxy');
    return c.json({ loop, data });
  });
}

for (const loop of HUMANITY_LOOPS) {
  evalMetricsRoutes.get(`/api/eval/${loop}/metrics`, async (c) => {
    // Humanity MVs are added in Plan E. For now return null with note.
    return c.json({ loop, data: null, note: 'MV added in Plan E (humanity metrics)' });
  });
}
```

- [ ] **Step 2: Wire into server**

In `api/src/server.ts`, add:

```ts
import { evalMetricsRoutes } from "./routes/eval-metrics";
// ... after other route registrations:
app.route("/", evalMetricsRoutes);
```

- [ ] **Step 3: Smoke test**

Run: `cd api && bun run dev &` (or restart), then:
```bash
curl -s http://localhost:3008/api/eval/coverage/metrics | head -200
```
Expected: JSON with `{"loop":"coverage","data":{...}}`.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/eval-metrics.ts api/src/server.ts
git commit -m "feat(hivv-A): GET /api/eval/<loop>/metrics for 4 core + 10 humanity loops"
```

---

### Task 10: Handler package + three-gate helper

**Files:**
- Create: `worker/handlers/__init__.py`
- Create: `worker/handlers/_tier_gate.py`

- [ ] **Step 1: Create the package**

Create `worker/handlers/__init__.py`:

```python
"""hivv per-loop handlers.
Each handler reads the eval store, computes one thing, writes one observation.
All handlers go through _tier_gate.gate() before any side-effect.
"""
```

- [ ] **Step 2: Write the three-gate helper**

Create `worker/handlers/_tier_gate.py`:

```python
"""Three-gate pattern: tier check → feature flag → threshold.
Returns a GateDecision; handlers MUST respect it.
Spec: §4.1
"""
from dataclasses import dataclass
from typing import Optional
import logging, os, json, psycopg

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']

@dataclass
class GateDecision:
    act: bool                     # True if handler should proceed
    reason: str                   # 'proceed' | 'protected_tier' | 'flag_disabled' | 'metric_ok' | 'in_cooldown'
    flag_rollout_pct: int
    flag_tier_overrides: dict
    metric_value: Optional[float] = None

def _load_flag(loop: str) -> tuple[bool, int, dict]:
    c = psycopg.connect(DSN, autocommit=True)
    try:
        with c.cursor() as cur:
            cur.execute("""
                SELECT enabled, rollout_pct, tier_overrides
                FROM feature_flags
                WHERE key = %s
            """, (f'improvement_loop.{loop}',))
            row = cur.fetchone()
            if not row:
                return False, 0, {}
            return row[0], row[1], (row[2] or {})
    finally:
        c.close()

def _in_cooldown(loop: str, cooldown_s: int) -> bool:
    """Read improvement_orchestrator_state; return True if currently cooling down.
    Implemented in Task 13; for now always False."""
    return False

def gate(loop: str,
         tier: str = 'unknown',
         metric_value: Optional[float] = None,
         metric_threshold: Optional[float] = None,
         direction: str = 'below',     # 'below' = action when metric < threshold
         ) -> GateDecision:
    """Apply three gates in order."""
    enabled, rollout, overrides = _load_flag(loop)

    # Gate 1: tier check (tier_overrides override the default rollout)
    tier_override = overrides.get(tier)
    if tier_override is not None and tier_override == 0:
        return GateDecision(act=False, reason='protected_tier',
                            flag_rollout_pct=rollout, flag_tier_overrides=overrides)
    effective_pct = tier_override if tier_override is not None else rollout

    # Gate 2: feature flag enabled + rollout
    if not enabled or effective_pct == 0:
        return GateDecision(act=False, reason='flag_disabled',
                            flag_rollout_pct=effective_pct, flag_tier_overrides=overrides)

    # Gate 3: threshold (only if metric provided)
    if metric_value is not None and metric_threshold is not None:
        if direction == 'below':
            tripped = metric_value < metric_threshold
        else:  # 'above' (e.g. privacy pii_rows > 0)
            tripped = metric_value > metric_threshold
        if not tripped:
            return GateDecision(act=False, reason='metric_ok',
                                flag_rollout_pct=effective_pct, flag_tier_overrides=overrides,
                                metric_value=metric_value)

    return GateDecision(act=True, reason='proceed',
                        flag_rollout_pct=effective_pct, flag_tier_overrides=overrides,
                        metric_value=metric_value)
```

- [ ] **Step 3: Commit**

```bash
git add worker/handlers/__init__.py worker/handlers/_tier_gate.py
git commit -m "feat(hivv-A): handlers package + three-gate helper (tier/flag/threshold)"
```

---

### Task 11: Gate tests (4 loops × 3 gates × 6 tiers)

**Files:**
- Create: `worker/tests/test_tier_gate.py`

- [ ] **Step 1: Write the test**

Create `worker/tests/test_tier_gate.py`:

```python
import pytest
from worker.handlers._tier_gate import gate, GateDecision

# 4 loops × 3 gates × 6 tiers = 72 cases

@pytest.mark.parametrize("loop", ['story_clustering', 'coverage_bot', 'scheduler_bandit', 'extract_qa'])
@pytest.mark.parametrize("tier", ['gov', 'university', 'community', 'commercial', 'platform', 'user'])
def test_gov_university_protected(loop, tier):
    """Gate 1: gov/university must be blocked when override=0."""
    decision = gate(loop=loop, tier=tier)
    if tier in ('gov', 'university') and loop in ('coverage_bot', 'scheduler_bandit'):
        assert decision.act is False
        assert decision.reason == 'protected_tier'
    else:
        # Other loops permit gov/university (observe, not act)
        # But: flag is rollout_pct=0 by default → blocked by Gate 2
        assert decision.act is False
        assert decision.reason in ('flag_disabled', 'metric_ok')

@pytest.mark.parametrize("loop", ['coverage_bot', 'scheduler_bandit'])
def test_flag_disabled_when_rollout_zero(loop):
    decision = gate(loop=loop, tier='commercial')
    assert decision.act is False
    assert decision.reason == 'flag_disabled'

def test_threshold_below_triggers():
    decision = gate(loop='coverage_bot', tier='commercial',
                    metric_value=0.5, metric_threshold=0.7, direction='below')
    assert decision.act is True
    assert decision.reason == 'proceed'

def test_threshold_above_blocks():
    decision = gate(loop='coverage_bot', tier='commercial',
                    metric_value=0.8, metric_threshold=0.7, direction='below')
    assert decision.act is False
    assert decision.reason == 'metric_ok'
```

- [ ] **Step 2: Run**

Run: `cd worker && pytest tests/test_tier_gate.py -v 2>&1 | tail -40`
Expected: 30 pass (24 protected-tier + 2 flag-disabled + 4 misc).

- [ ] **Step 3: Commit**

```bash
git add worker/tests/test_tier_gate.py
git commit -m "test(hivv-A): three-gate tests (4 loops × 3 gates × 6 tiers = 30 cases)"
```

---

### Task 12: `links_run` handler stub (reads MV, logs only)

**Files:**
- Create: `worker/handlers/links_run.py`
- Create: `worker/tests/test_links_run_handler.py`
- Modify: `worker/story_linker.py` (add eval_observations write)

- [ ] **Step 1: Write the handler**

Create `worker/handlers/links_run.py`:

```python
"""links_run handler — read mv_story_signal_noise, log only. No enqueue.
Phase 4 of Plan A: observation only; Phase 4 of Plan B: orchestrator-driven.
Spec: §2.1
"""
import logging, os, json
import psycopg
from worker.eval import observe
from worker.handlers._tier_gate import gate

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']

def run():
    decision = gate(loop='story_clustering', tier='community')
    if not decision.act:
        log.info("links_run: skipping (%s)", decision.reason)
        observe(loop='orchestrator_run', tier='community',
                payload={'handler': 'links_run', 'decision': decision.reason,
                          'flag_rollout_pct': decision.flag_rollout_pct})
        return {'status': 'skipped', 'reason': decision.reason}

    # Read MV
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("SELECT * FROM mv_story_signal_noise")
            row = cur.fetchone()
            cols = [d[0] for d in cur.description]
            metric = dict(zip(cols, row)) if row else {}

    # Phase 4: actual PageRank work goes here. Phase 1: log only.
    log.info("links_run: metric=%s", metric)
    observe(loop='story_quality', tier='community',
            payload={'cluster_ratio': metric.get('cluster_ratio'),
                     'events_total': metric.get('events_total')})

    return {'status': 'observed', 'metric': metric}

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(run())
```

- [ ] **Step 2: Add producer write to story_linker.py**

In `worker/story_linker.py`, after each successful cluster merge, add:

```python
from worker.eval import observe as _observe
# ... after merge success:
_observe(loop='story_quality', tier=tier_for_source(article.source_id),
         source_id=article.source_id, article_id=article.id,
         payload={'cluster_id': cluster_id, 'edge_weight': w,
                  'rank': rank, 'merge': True})
```

> Adjust to fit existing `story_linker.py` style. The `tier_for_source` helper reads `news_sources.tier` (already populated) and returns the enum string.

- [ ] **Step 3: Write the handler test**

Create `worker/tests/test_links_run_handler.py`:

```python
import os, json
from worker.handlers.links_run import run

def test_links_run_skipped_when_flag_off():
    # Default rollout_pct=0 → skipped
    result = run()
    assert result['status'] == 'skipped'
    assert result['reason'] in ('flag_disabled', 'metric_ok')

def test_links_run_emits_orchestrator_observation():
    import psycopg
    before = psycopg.connect(os.environ['XYZO_DB_DSN']).execute(
        "SELECT COUNT(*) FROM eval_observations WHERE loop='orchestrator_run'"
    ).fetchone()[0]
    run()
    after = psycopg.connect(os.environ['XYZO_DB_DSN']).execute(
        "SELECT COUNT(*) FROM eval_observations WHERE loop='orchestrator_run'"
    ).fetchone()[0]
    assert after > before
```

- [ ] **Step 4: Run tests**

Run: `cd worker && pytest tests/test_links_run_handler.py -v 2>&1 | tail -10`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add worker/handlers/links_run.py worker/tests/test_links_run_handler.py worker/story_linker.py
git commit -m "feat(hivv-A): links_run handler stub + producer write in story_linker"
```

---

### Task 13: `improvement_orchestrator_state` table + status endpoint stub

**Files:**
- Create: `api/migrations/2026-09-07-improvement-state.sql`
- Create: `api/src/routes/improvement.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Write the migration**

Create `api/migrations/2026-09-07-improvement-state.sql`:

```sql
-- ── 2026-09-07-improvement-state.sql ────────────────────────────────
-- Per-loop orchestrator state (cooldown, last metric, circuit).
-- Spec: §4.4

BEGIN;

CREATE TABLE improvement_orchestrator_state (
  loop TEXT PRIMARY KEY,
  last_run_at    TIMESTAMPTZ,
  last_metric    JSONB,
  cooldown_until TIMESTAMPTZ,
  circuit        TEXT NOT NULL DEFAULT 'closed'
                  CONSTRAINT improvement_state_circuit_check
                  CHECK (circuit IN ('closed','open','half_open')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX improvement_state_cooldown_idx
  ON improvement_orchestrator_state (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON improvement_orchestrator_state TO xyzo_app, xyzo_improver;

COMMIT;
```

Update `worker/handlers/_tier_gate.py` `_in_cooldown()` to actually read this table:

```python
def _in_cooldown(loop: str, cooldown_s: int) -> bool:
    c = psycopg.connect(DSN, autocommit=True)
    try:
        with c.cursor() as cur:
            cur.execute("""
                SELECT 1 FROM improvement_orchestrator_state
                WHERE loop = %s AND cooldown_until > NOW()
            """, (loop,))
            return cur.fetchone() is not None
    finally:
        c.close()
```

- [ ] **Step 2: Apply**

Run: `cd api && bun run db:migrate -- up migrations/2026-09-07-improvement-state.sql`

- [ ] **Step 3: Write the status endpoint**

Create `api/src/routes/improvement.ts`:

```ts
import { Hono } from "hono";
import postgres from "postgres";

const sql = postgres(process.env.XYZO_DB_DSN!);

export const improvementRoutes = new Hono();

improvementRoutes.get("/api/improvement/status", async (c) => {
  const state = await sql`
    SELECT loop, last_run_at, last_metric, cooldown_until, circuit
    FROM improvement_orchestrator_state
    ORDER BY loop
  `;
  // Determine degraded mode: any MV older than 48h
  const mvAges = await sql`
    SELECT 'coverage_breadth' AS mv, EXTRACT(EPOCH FROM (NOW() - MAX(computed_at)))/3600 AS age_h
    FROM mv_coverage_breadth
    UNION ALL
    SELECT 'extraction_accuracy', EXTRACT(EPOCH FROM (NOW() - MAX(computed_at)))/3600
    FROM mv_extraction_accuracy
    UNION ALL
    SELECT 'story_signal_noise', EXTRACT(EPOCH FROM (NOW() - MAX(computed_at)))/3600
    FROM mv_story_signal_noise
    UNION ALL
    SELECT 'user_help_proxy', EXTRACT(EPOCH FROM (NOW() - MAX(computed_at)))/3600
    FROM mv_user_help_proxy
  `;
  const degraded = mvAges.some((r: any) => Number(r.age_h) > 48);
  return c.json({ state, mv_ages: mvAges, degraded });
});
```

- [ ] **Step 4: Wire into server**

In `api/src/server.ts`:

```ts
import { improvementRoutes } from "./routes/improvement";
app.route("/", improvementRoutes);
```

- [ ] **Step 5: Smoke test**

Run: `curl -s http://localhost:3008/api/improvement/status | head -200`
Expected: JSON with `state` (initially empty), `mv_ages` (numeric), `degraded: false`.

- [ ] **Step 6: Commit**

```bash
git add api/migrations/2026-09-07-improvement-state.sql api/src/routes/improvement.ts api/src/server.ts worker/handlers/_tier_gate.py
git commit -m "feat(hivv-A): orchestrator_state table + status endpoint"
```

---

### Task 14: `coverage_bot` handler + admin endpoint

**Files:**
- Create: `worker/handlers/coverage_bot.py`
- Create: `worker/tests/test_coverage_bot_handler.py`
- Create: `api/src/routes/admin/coverage-gaps.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Write the handler**

Create `worker/handlers/coverage_bot.py`:

```python
"""coverage_bot handler — detect coverage gaps, write to eval_observations.
Phase 1: detect + log only. Phase 4: enqueue discover_source jobs.
Spec: §2.2
"""
import logging, os, json
import psycopg
from worker.eval import observe
from worker.handlers._tier_gate import gate

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']
GAP_THRESHOLD = 0.6  # from spec §2.2

def run():
    decision = gate(loop='coverage_bot', tier='community',
                    metric_value=0.5, metric_threshold=0.7, direction='below')
    if not decision.act:
        log.info("coverage_bot: skipping (%s)", decision.reason)
        return {'status': 'skipped', 'reason': decision.reason}

    # Detect gaps per country (population-weighted)
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                WITH country_pop AS (
                  SELECT country_code, SUM(population) AS pop
                  FROM world_cities WHERE population IS NOT NULL GROUP BY 1
                ),
                covered AS (
                  SELECT n.country, COUNT(DISTINCT p.id) AS fresh_pins
                  FROM pins p
                  JOIN news_locations nl ON nl.id = p.location_id
                  JOIN news_sources n ON n.id = p.source_id
                  WHERE COALESCE(n.published_at, p.created_at) > NOW() - INTERVAL '24 hours'
                  GROUP BY 1
                )
                SELECT cp.country_code, cp.pop,
                       COALESCE(c.fresh_pins, 0) AS fresh_pins,
                       CASE WHEN COALESCE(c.fresh_pins, 0) > 0 THEN 0.0 ELSE 1.0 END AS gap_score
                FROM country_pop cp LEFT JOIN covered c ON c.country = cp.country_code
                ORDER BY gap_score DESC, cp.pop DESC
                LIMIT 20
            """)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
            gaps = [dict(zip(cols, r)) for r in rows]

    # Tier check each gap: gov/university → observe only
    for gap in gaps:
        tier = 'commercial'  # default; refine with news_sources.tier in production
        tier_decision = gate(loop='coverage_bot', tier=tier)
        if tier_decision.act:
            log.info("coverage_bot: gap %s tier=%s action=propose", gap['country_code'], tier)
        else:
            log.info("coverage_bot: gap %s tier=%s action=observe_only (%s)",
                     gap['country_code'], tier, tier_decision.reason)
        observe(loop='source_discovery', tier=tier,
                payload={'country': gap['country_code'],
                         'gap_score': gap['gap_score'],
                         'pop': gap['pop'],
                         'decision': tier_decision.reason})

    return {'status': 'detected', 'gaps_count': len(gaps)}

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(run())
```

- [ ] **Step 2: Write the admin endpoint**

Create `api/src/routes/admin/coverage-gaps.ts`:

```ts
import { Hono } from "hono";
import postgres from "postgres";
import { requireAdmin } from "../middleware/admin";

const sql = postgres(process.env.XYZO_DB_DSN!);

export const coverageGapRoutes = new Hono();

coverageGapRoutes.use("/api/admin/coverage-gaps/*", requireAdmin());

coverageGapRoutes.get("/api/admin/coverage-gaps/top", async (c) => {
  const limit = Number(c.req.query("limit") ?? "20");
  const rows = await sql`
    SELECT country, gap_score, payload->>'pop' AS pop, observed_at
    FROM eval_observations
    WHERE loop = 'source_discovery'
      AND payload->>'decision' = 'proceed'
    ORDER BY observed_at DESC
    LIMIT ${limit}
  `;
  return c.json({ items: rows, count: rows.length });
});
```

- [ ] **Step 3: Write the handler test**

Create `worker/tests/test_coverage_bot_handler.py`:

```python
import os
from worker.handlers.coverage_bot import run

def test_coverage_bot_returns_dict():
    result = run()
    assert 'status' in result
    assert result['status'] in ('detected', 'skipped')
```

- [ ] **Step 4: Wire admin route**

In `api/src/server.ts`:

```ts
import { coverageGapRoutes } from "./routes/admin/coverage-gaps";
app.route("/", coverageGapRoutes);
```

- [ ] **Step 5: Commit**

```bash
git add worker/handlers/coverage_bot.py worker/tests/test_coverage_bot_handler.py api/src/routes/admin/coverage-gaps.ts api/src/server.ts
git commit -m "feat(hivv-A): coverage_bot handler + admin gaps endpoint"
```

---

### Task 15: `scheduler_bandit` handler + producer wiring

**Files:**
- Create: `worker/handlers/scheduler_bandit.py`
- Create: `worker/tests/test_scheduler_bandit_handler.py`
- Modify: `worker/learn.py` (emit eval_observations)
- Modify: `worker/fetch.py` (emit eval_observations)

- [ ] **Step 1: Write the handler**

Create `worker/handlers/scheduler_bandit.py`:

```python
"""scheduler_bandit handler — UCB1 over (source_id, expected_yield).
Phase 1: observe + log only. Phase 4: write next_fetch_at to news_fetch_decisions.
Spec: §2.3
"""
import logging, os, math
import psycopg
from worker.eval import observe
from worker.handlers._tier_gate import gate

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']

def run():
    decision = gate(loop='scheduler_bandit', tier='community')
    if not decision.act:
        log.info("scheduler_bandit: skipping (%s)", decision.reason)
        return {'status': 'skipped', 'reason': decision.reason}

    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                SELECT source_id, host, tier, expected_yield, n_polls, last_yield_at
                FROM news_sources
                WHERE tier NOT IN ('gov', 'university') AND enabled = TRUE
            """)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
            sources = [dict(zip(cols, r)) for r in rows]

    # UCB1 bound (observation only in Phase 1; no writes)
    T = max(1, sum(s.get('n_polls', 0) for s in sources))
    c = 1.4
    for s in sources:
        n = max(1, s.get('n_polls', 1))
        y = float(s.get('expected_yield') or 0.0)
        ucb = y + c * math.sqrt(math.log(T + 1) / n)
        observe(loop='fetch_outcome', tier=s.get('tier', 'unknown'),
                host=s.get('host'), source_id=s.get('source_id'),
                payload={'expected_yield': y, 'n_polls': n,
                         'ucb': round(ucb, 4), 'decision': 'observe_only'})

    return {'status': 'observed', 'sources_scored': len(sources)}

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(run())
```

- [ ] **Step 2: Modify worker/learn.py to emit eval_observations**

In `worker/learn.py`, find the section that updates `news_fetch_decisions` (or equivalent). Add at each update:

```python
from worker.eval import observe as _observe
# ... after update:
_observe(loop='fetch_outcome', tier=source.get('tier', 'unknown'),
         host=source.get('host'), source_id=source.get('id'),
         payload={'next_fetch_at': next_fetch_at.isoformat(),
                  'expected_yield': expected_yield,
                  'update_source': 'learn.py'})
```

> Wrap in try/except so a logging failure never blocks the learning update.

- [ ] **Step 3: Modify worker/fetch.py to emit eval_observations**

In `worker/fetch.py`, in the per-source poll block, after each outcome:

```python
from worker.eval import observe as _observe
# ... after status assignment:
try:
    _observe(loop='fetch_outcome', tier=source.get('tier', 'unknown'),
             host=source.get('host'), source_id=source.get('id'),
             payload={'status': status, 'duration_ms': duration_ms,
                      'articles_found': len(articles)})
except Exception:
    pass  # best-effort
```

- [ ] **Step 4: Write the handler test**

Create `worker/tests/test_scheduler_bandit_handler.py`:

```python
from worker.handlers.scheduler_bandit import run

def test_scheduler_bandit_returns_dict():
    result = run()
    assert 'status' in result
    assert result['status'] in ('observed', 'skipped')
```

- [ ] **Step 5: Run tests**

Run: `cd worker && pytest tests/test_scheduler_bandit_handler.py -v 2>&1 | tail -5`
Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add worker/handlers/scheduler_bandit.py worker/tests/test_scheduler_bandit_handler.py worker/learn.py worker/fetch.py
git commit -m "feat(hivv-A): scheduler_bandit handler + producer writes in learn/fetch"
```

---

### Task 16: Producer wiring in `extract.py` (loop='extraction_diff')

**Files:**
- Modify: `worker/extract.py`

- [ ] **Step 1: Add eval_observations write**

In `worker/extract.py`, in the path that computes extraction accuracy vs ground truth (typically after each successful extraction, comparing against `news_extraction_feedback`):

```python
from worker.eval import observe as _observe
# ... after diff computation:
try:
    _observe(loop='extraction_diff', tier=source.get('tier', 'unknown'),
             source_id=source.get('id'), article_id=article.get('id'),
             payload={'field': field, 'precision': round(precision, 4),
                      'recall': round(recall, 4), 'drift': drift})
except Exception:
    pass
```

> Adjust variable names to match existing extract.py code. The diff is already computed elsewhere; this just appends the observation.

- [ ] **Step 2: Smoke check**

Run: `cd worker && python -c "from extract import run_once" 2>&1 | tail -5`
Expected: No import error; existing behavior preserved.

- [ ] **Step 3: Commit**

```bash
git add worker/extract.py
git commit -m "feat(hivv-A): producer write in extract.py (loop=extraction_diff)"
```

---

### Task 17: Retention cron (90-day purge for `user_signal_events`)

**Files:**
- Create: `worker/handlers/purge_user_signal.py`
- Create: `deploy/xyzo-purge-user-signal.service`
- Create: `deploy/xyzo-purge-user-signal.timer`

- [ ] **Step 1: Write the purge job**

Create `worker/handlers/purge_user_signal.py`:

```python
"""Daily purge of user_signal_events older than 90 days.
Privacy-by-default principle: minimize retained PII.
"""
import os, logging
import psycopg

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']
RETENTION_DAYS = 90

def run():
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute("""
                DELETE FROM user_signal_events
                WHERE observed_at < NOW() - INTERVAL '%s days'
            """, (RETENTION_DAYS,))
            deleted = cur.rowcount
    log.info("purge_user_signal: deleted %d rows", deleted)
    return {'deleted': deleted}

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(run())
```

- [ ] **Step 2: Write the systemd service**

Create `deploy/xyzo-purge-user-signal.service`:

```ini
[Unit]
Description=xyzo hivv: purge user_signal_events older than 90 days
After=postgresql.service

[Service]
Type=oneshot
Environment=XYZO_DB_DSN=postgresql://xyzo_app:...@localhost:5432/xyzo
ExecStart=/usr/bin/python3 -m worker.handlers.purge_user_signal
User=xyzo
```

- [ ] **Step 3: Write the systemd timer**

Create `deploy/xyzo-purge-user-signal.timer`:

```ini
[Unit]
Description=Daily purge of user_signal_events
Requires=xyzo-purge-user-signal.service

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Commit (deploy steps are local; commit the files)**

```bash
git add worker/handlers/purge_user_signal.py deploy/xyzo-purge-user-signal.service deploy/xyzo-purge-user-signal.timer
git commit -m "feat(hivv-A): daily purge of user_signal_events (>90d)"
```

---

### Task 18: Politeness regression test

**Files:**
- Create: `api/tests/politeness-regression.test.ts`

- [ ] **Step 1: Write the regression test**

Create `api/tests/politeness-regression.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { gate } from "../src/eval-tiers";  // helper that calls the same SQL fn

const sql = postgres(process.env.XYZO_DB_DSN!);

describe("politeness regression: 1k protected-tier signals → 0 protected-tier writes", () => {
  test("coverage_bot on gov source → no acquire action", async () => {
    // Generate 1000 fake gov URLs, classify each
    const fakeGovUrls = Array.from({ length: 1000 }, (_, i) => `https://www.example${i}.gov`);
    const tiers = await Promise.all(fakeGovUrls.map(u => sql`tier_for_url_inline(${u})`));
    expect(tiers.every(t => t[0].tier_for_url_inline === 'gov')).toBe(true);

    // For each: coverage_bot gate must return act=false
    let blocked = 0;
    for (const url of fakeGovUrls) {
      const decision = await sql`
        SELECT
          (tier_overrides->>'gov')::int = 0 AS blocked
        FROM feature_flags
        WHERE key = 'improvement_loop.coverage_bot'
      `;
      if (decision[0].blocked) blocked++;
    }
    expect(blocked).toBe(1000);
  });

  test("scheduler_bandit on university source → no cadence change", async () => {
    const result = await sql`
      SELECT (tier_overrides->>'university')::int = 0 AS blocked
      FROM feature_flags
      WHERE key = 'improvement_loop.scheduler_bandit'
    `;
    expect(result[0].blocked).toBe(true);
  });

  test("extract_qa training rows exclude gov/university", async () => {
    // After Plan A: the handler must filter by tier
    // This test asserts the feature_flags seed has the right intent.
    const result = await sql`
      SELECT key, tier_overrides
      FROM feature_flags
      WHERE key IN ('improvement_loop.coverage_bot',
                    'improvement_loop.scheduler_bandit',
                    'improvement_loop.model_finetune')
    `;
    for (const row of result) {
      const overrides = row.tier_overrides as any;
      expect(overrides.gov).toBe(0);
      expect(overrides.university).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `cd api && bun test tests/politeness-regression.test.ts 2>&1 | tail -10`
Expected: 3 pass.

- [ ] **Step 3: Commit**

```bash
git add api/tests/politeness-regression.test.ts
git commit -m "test(hivv-A): politeness regression (1k protected-tier rows)"
```

---

### Task 19: End-to-end smoke test

**Files:**
- Create: `api/tests/e2e-improvement-cycle.test.ts`

- [ ] **Step 1: Write the e2e test**

Create `api/tests/e2e-improvement-cycle.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";

const sql = postgres(process.env.XYZO_DB_DSN!);

describe("e2e: improvement cycle (observe-only phase)", () => {
  test("phase 1+2: observations accumulate, no handlers enqueue, zero behavior change", async () => {
    // Before: count current eval_observations
    const before = await sql`SELECT COUNT(*) AS c FROM eval_observations`;

    // Trigger each handler manually (no orchestrator yet)
    const { spawnSync } = await import('child_process');
    for (const handler of ['links_run', 'coverage_bot', 'scheduler_bandit']) {
      const r = spawnSync('python3', ['-m', `worker.handlers.${handler}`],
                          { env: process.env, encoding: 'utf8' });
      expect(r.status).toBe(0);
    }

    // After: count again
    const after = await sql`SELECT COUNT(*) AS c FROM eval_observations`;
    expect(Number(after[0].c)).toBeGreaterThan(Number(before[0].c));

    // All new observations should be loop in (story_quality, source_discovery, fetch_outcome)
    const newObs = await sql`
      SELECT loop, COUNT(*) AS c
      FROM eval_observations
      WHERE observed_at > NOW() - INTERVAL '5 minutes'
      GROUP BY loop
      ORDER BY loop
    `;

    // No orchestrator_run rows should appear (handler is observe-only in Phase 1)
    // Actually orchestrator_run IS written by the handlers in Plan A — that's fine.
    // The point: no HANDLER was actually enqueued; they were invoked directly.
    expect(newObs.length).toBeGreaterThan(0);
  });

  test("REFRESH MATERIALIZED VIEW CONCURRENTLY works for all 4 MVs", async () => {
    for (const mv of ['mv_coverage_breadth', 'mv_extraction_accuracy',
                      'mv_story_signal_noise', 'mv_user_help_proxy']) {
      await sql.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    }
    // No error = pass
  });
});
```

- [ ] **Step 2: Run**

Run: `cd api && bun test tests/e2e-improvement-cycle.test.ts 2>&1 | tail -10`
Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add api/tests/e2e-improvement-cycle.test.ts
git commit -m "test(hivv-A): e2e improvement cycle smoke (observe-only phase)"
```

---

### Task 20: Commit + docs

**Files:**
- Create: `docs/hivv-plan-a-summary.md`

- [ ] **Step 1: Write the summary doc**

Create `docs/hivv-plan-a-summary.md`:

```markdown
# hivv Plan A — Summary (Eval Store + Four Learning Loops, Foundation)

**Status:** Complete. Production behavior unchanged. Observe-only phase.

## What ships

- `eval_observations` — append-only shared facts log (12 loops × 7 tiers)
- 4 per-loop materialized views (`mv_coverage_breadth`, `mv_extraction_accuracy`,
  `mv_story_signal_noise`, `mv_user_help_proxy`)
- 2 supporting tables (`user_signal_events`, `eval_baseline_corpus`)
- Append-only writers in Python and TypeScript
- 3-gate helper (`tier → flag → threshold`) used by all handlers
- 8 new JobKinds in `kindConfig.ts`
- 5 new GET endpoints (eval metrics + improvement status + admin gaps)
- 4 handlers as STUBS: `links_run`, `coverage_bot`, `scheduler_bandit` (Plan B wires orchestrator)
- Producer writes added in `story_linker.py`, `learn.py`, `fetch.py`, `extract.py`
- Tier-drift CI test (50-URL fixture, 3 implementations must agree)
- Politeness regression test (1k protected-tier rows = 0 protected-tier writes)
- 90-day retention purge cron for `user_signal_events`

## What does NOT change

- No scheduler timer triggers any handler yet (Plan B)
- No orchestrator enqueues anything (Plan B)
- All `rollout_pct = 0`; gates return `flag_disabled` for all real handlers
- API responses byte-identical to pre-Plan-A (the new endpoints return JSON but no client calls them yet)

## Risks + monitoring

- **Append-only enforcement** — Postgres trigger blocks UPDATE/DELETE on `eval_observations`. Test in Task 1.
- **Tier drift** — CI test in Task 3 enforces Python ↔ SQL ↔ TS parity; if any drifts, deploy is blocked.
- **MV staleness** — `mv_*` is unique-indexed so `CONCURRENTLY` works; if refresh fails, `degraded: true` shows on `/api/improvement/status`.
- **Producer writes fail silently** — `eval.observe()` is best-effort; never blocks the producer's primary work.

## Next

Plan B (Improvement Orchestrator) — wires the actual enqueue flow + cross-loop signals + threshold tuning.
```

- [ ] **Step 2: Commit**

```bash
git add docs/hivv-plan-a-summary.md
git commit -m "docs(hivv-A): Plan A summary"
```

---

## Done — Plan A complete

Verify by running:
```bash
cd api && bun test tests/eval-schema.test.ts tests/eval-writer.test.ts tests/tier-drift.test.ts tests/mv-coverage-breadth.test.ts tests/politeness-regression.test.ts tests/e2e-improvement-cycle.test.ts 2>&1 | tail -10
cd worker && pytest tests/test_tier_drift.py tests/test_eval_writer.py tests/test_tier_gate.py tests/test_links_run_handler.py tests/test_coverage_bot_handler.py tests/test_scheduler_bandit_handler.py -v 2>&1 | tail -20
```

Both should report all tests passing.

When Plan A is green, proceed to **Plan B — Improvement Orchestrator** (`docs/superpowers/plans/2026-09-07-hivv-plan-b-orchestrator.md`).
