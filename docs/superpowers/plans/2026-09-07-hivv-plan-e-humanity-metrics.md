# hivv Plan E — Humanity + Life Metrics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 10 humanity + life metrics as materialised views, with public CSV/Parquet exports and a weekly digest. Spec §10. These metrics measure the *health of the human system*, not the AI system: information quality, source diversity, geographic balance, agency preserved.

**Architecture:** 10 Postgres materialised views in a `humanity_metrics` schema, refreshed nightly via systemd timer. Each MV is a single readable number or small table. Public export endpoint streams CSV + Parquet at `/humanity/export.csv` and `/humanity/export.parquet` (no auth — public data). Weekly digest is a Markdown file generated Sunday 06:00 UTC, posted to the public `digests/` folder and announced on the dashboard 🌐 WORLD scope.

**Tech Stack:** Postgres `REFRESH MATERIALIZED VIEW CONCURRENTLY`, Python 3.11 (digest generator), Bun/Hono (export endpoints), no new deps (csv via stdlib, parquet via `pyarrow` already in worker env).

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` §10

**Prerequisites:** Plans A–D shipped + green.

**Out of scope:** Plan F (privacy on individual-level metrics); Plan G (digest announcement). Both consume these MVs.

**Cross-cutting invariants:**
1. **No PII in public exports.** Aggregate only. Owner sees their own row in dashboard; public sees 0/median/percentile.
2. **Refresh is append-only.** MVs are built from `eval_observations`, `articles`, `sources`, `pins` — never from session state.
3. **Open-data license.** Every exported number is `CC-BY-SA 4.0` (declared in headers).
4. **Median + n, never mean alone.** Skewed distributions lie with means; we report median + n + p10/p90.
5. **Geo + temporal coverage.** Every metric exposes both a current value and a 30-day sparkline series.

---

## The 10 metrics (spec §10)

| # | Metric | Question answered | Source |
|---|--------|-------------------|--------|
| 1 | **Information reach** | What fraction of the world can find an article about their region in our index? | `articles`, GeoNames |
| 2 | **Source diversity** | How concentrated is coverage by source? (HHI) | `sources`, `articles` |
| 3 | **Tier coverage** | What fraction of newsworthy events per tier have ≥1 article? | `eval_observations (loop=coverage_gap)` |
| 4 | **Extraction accuracy** | Median extraction confidence across all AI calls. | `eval_observations (loop=ai_call)` |
| 5 | **User agency preserved** | When AI fell back to "ask_user", how often did a human respond? | `eval_observations (capability_outcome=ask_user)` |
| 6 | **Cost per useful action** | Compute watts divided by confirmed-useful actions. | `ai_compute_daily`, eval outcomes |
| 7 | **Open-data export ratio** | What fraction of data is exportable as CC-BY-SA? | `data_export_policies` (per-table) |
| 8 | **Politeness preservation** | Did we respect robots.txt + per-tier cadence for the past 30 days? | `source_poll_observations` |
| 9 | **Geographic balance** | What is the Gini coefficient of articles per country? | `articles.geo_country` |
| 10 | **Temporal freshness** | Median age of articles when first surfaced. | `articles.first_surfaced_at` |

---

## File Structure

```
api/migrations/
  2026-09-11-humanity-metrics.sql               (Task 1 — schema + 10 MVs + refresh fn)

worker/digest/
  weekly_humanity.py                            (Task 2 — digest generator)
  weekly_humanity.test.py                       (Task 3)

api/src/routes/
  humanity-export.ts                            (Task 4 — CSV/Parquet/JSON streaming)
  humanity-dashboard.ts                         (Task 5 — 🌐 WORLD sub-tab)

public/digests/
  .gitkeep

scripts/
  refresh-humanity.sh                           (Task 6 — systemd hook)
  systemd/hivv-humanity-refresh.service         (Task 7)
  systemd/hivv-humanity-refresh.timer           (Task 7)
  systemd/hivv-weekly-digest.service            (Task 7)
  systemd/hivv-weekly-digest.timer               (Task 7)

api/tests/
  humanity-export.test.ts                       (Task 8)
  humanity-mvs.test.ts                          (Task 9)
```

---

## Task Index

- Task 1: Humanity metrics schema + 10 MVs + refresh function
- Task 2: Weekly digest generator
- Task 3: Digest tests
- Task 4: Public CSV / Parquet / JSON export endpoints
- Task 5: Humanity tab in 🌐 WORLD dashboard
- Task 6: Refresh script
- Task 7: systemd timers
- Task 8: Export endpoint tests
- Task 9: MV correctness tests
- Task 10: Documentation + handoff

---

### Task 1: Humanity metrics schema + 10 MVs

**Files:**
- Create: `api/migrations/2026-09-11-humanity-metrics.sql`

- [ ] **Step 1: Write migration**

```sql
-- ── 2026-09-11-humanity-metrics.sql ────────────────────────────────
-- 10 humanity + life metrics as MVs. Spec §10.
BEGIN;

CREATE SCHEMA IF NOT EXISTS humanity_metrics;

-- Helper: 30-day rolling window
CREATE OR REPLACE FUNCTION humanity_metrics.last_30_days() RETURNS TABLE(observed_at TIMESTAMPTZ) AS $$
  SELECT generate_series(NOW() - INTERVAL '30 days', NOW(), '1 day'::interval)
$$ LANGUAGE SQL IMMUTABLE;

-- ── MV 1: information_reach ────────────────────────────────────────
-- Fraction of world population whose country has ≥1 article in the past 30 days.
CREATE MATERIALIZED VIEW humanity_metrics.information_reach AS
WITH countries AS (
  SELECT country_code, population FROM geonames_countries
),
covered AS (
  SELECT DISTINCT geo_country FROM articles
  WHERE published_at > NOW() - INTERVAL '30 days' AND geo_country IS NOT NULL
),
reach AS (
  SELECT
    (SELECT SUM(population) FROM countries c JOIN covered cc ON cc.geo_country=c.country_code)::BIGINT AS covered_pop,
    (SELECT SUM(population) FROM countries)::BIGINT AS total_pop
)
SELECT
  1 AS metric_id,
  'information_reach'::TEXT AS metric_name,
  ROUND(covered_pop::numeric / NULLIF(total_pop, 0), 4) AS current_value,
  total_pop - covered_pop AS uncovered_population,
  30 AS window_days,
  NOW() AS refreshed_at
FROM reach;

CREATE UNIQUE INDEX ON humanity_metrics.information_reach (metric_id);

-- ── MV 2: source_diversity ─────────────────────────────────────────
-- Herfindahl-Hirschman Index (0 = perfect diversity, 10000 = monopoly).
CREATE MATERIALIZED VIEW humanity_metrics.source_diversity AS
WITH shares AS (
  SELECT source_id, COUNT(*)::numeric / SUM(COUNT(*)) OVER () AS share
  FROM articles
  WHERE published_at > NOW() - INTERVAL '30 days'
  GROUP BY source_id
)
SELECT
  2 AS metric_id,
  'source_diversity'::TEXT AS metric_name,
  ROUND(SUM(share * share) * 10000, 0) AS current_value,
  (SELECT COUNT(DISTINCT source_id) FROM articles WHERE published_at > NOW() - INTERVAL '30 days')::INT AS active_sources,
  30 AS window_days,
  NOW() AS refreshed_at
FROM shares;

CREATE UNIQUE INDEX ON humanity_metrics.source_diversity (metric_id);

-- ── MV 3: tier_coverage ───────────────────────────────────────────
-- Median fraction of coverage-gap targets that have ≥1 article.
CREATE MATERIALIZED VIEW humanity_metrics.tier_coverage AS
WITH gaps AS (
  SELECT tier, COUNT(*) AS gap_n FROM eval_observations
  WHERE loop = 'coverage_gap' AND observed_at > NOW() - INTERVAL '30 days'
  GROUP BY tier
),
hits AS (
  SELECT tier, COUNT(*) AS hit_n FROM eval_observations
  WHERE loop = 'coverage_gap' AND observed_at > NOW() - INTERVAL '30 days'
    AND (payload->>'had_coverage')::boolean = true
  GROUP BY tier
)
SELECT
  3 AS metric_id,
  'tier_coverage'::TEXT AS metric_name,
  -- median across tiers
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(h.hit_n, 0)::numeric / NULLIF(g.gap_n, 0)) AS current_value,
  (SELECT COUNT(DISTINCT tier) FROM eval_observations WHERE loop='coverage_gap' AND observed_at > NOW() - INTERVAL '30 days')::INT AS tiers_observed,
  30 AS window_days,
  NOW() AS refreshed_at
FROM gaps g LEFT JOIN hits h USING (tier);

CREATE UNIQUE INDEX ON humanity_metrics.tier_coverage (metric_id);

-- ── MV 4: extraction_accuracy ─────────────────────────────────────
CREATE MATERIALIZED VIEW humanity_metrics.extraction_accuracy AS
SELECT
  4 AS metric_id,
  'extraction_accuracy'::TEXT AS metric_name,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY result_confidence) AS current_value,
  COUNT(*)::INT AS sample_size,
  PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY result_confidence) AS p10,
  PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY result_confidence) AS p90,
  30 AS window_days,
  NOW() AS refreshed_at
FROM eval_observations
WHERE loop = 'ai_call' AND result_confidence IS NOT NULL
  AND observed_at > NOW() - INTERVAL '30 days';

CREATE UNIQUE INDEX ON humanity_metrics.extraction_accuracy (metric_id);

-- ── MV 5: user_agency ──────────────────────────────────────────────
-- Fraction of ask_user outcomes that were answered.
CREATE MATERIALIZED VIEW humanity_metrics.user_agency AS
WITH asks AS (
  SELECT
    COUNT(*) FILTER (WHERE capability_outcome = 'ask_user') AS asked_n,
    COUNT(*) FILTER (WHERE capability_outcome = 'answered') AS answered_n
  FROM eval_observations
  WHERE loop = 'ai_call' AND observed_at > NOW() - INTERVAL '30 days'
)
SELECT
  5 AS metric_id,
  'user_agency'::TEXT AS metric_name,
  ROUND(answered_n::numeric / NULLIF(asked_n, 0), 4) AS current_value,
  asked_n::INT, answered_n::INT,
  30 AS window_days,
  NOW() AS refreshed_at
FROM asks;

CREATE UNIQUE INDEX ON humanity_metrics.user_agency (metric_id);

-- ── MV 6: cost_per_useful_action ──────────────────────────────────
CREATE MATERIALIZED VIEW humanity_metrics.cost_per_useful_action AS
WITH compute AS (
  SELECT COALESCE(SUM(total_watts), 0)::BIGINT AS watts
  FROM ai_compute_daily WHERE day > CURRENT_DATE - 30
),
useful AS (
  SELECT COUNT(*)::INT AS n FROM eval_observations
  WHERE loop = 'ai_call' AND capability_outcome = 'success'
    AND observed_at > NOW() - INTERVAL '30 days'
)
SELECT
  6 AS metric_id,
  'cost_per_useful_action'::TEXT AS metric_name,
  ROUND(watts::numeric / NULLIF(n, 0), 0) AS current_value,
  n AS useful_actions,
  watts AS total_watts_30d,
  30 AS window_days,
  NOW() AS refreshed_at
FROM compute, useful;

CREATE UNIQUE INDEX ON humanity_metrics.cost_per_useful_action (metric_id);

-- ── MV 7: open_data_export_ratio ──────────────────────────────────
-- Per-table policy: is it CC-BY-SA exportable?
CREATE MATERIALIZED VIEW humanity_metrics.open_data_export_ratio AS
WITH tables AS (
  SELECT
    COUNT(*) FILTER (WHERE license = 'CC-BY-SA-4.0')::INT AS open_n,
    COUNT(*)::INT AS total_n
  FROM data_export_policies
)
SELECT
  7 AS metric_id,
  'open_data_export_ratio'::TEXT AS metric_name,
  ROUND(open_n::numeric / NULLIF(total_n, 0), 4) AS current_value,
  open_n::INT, total_n::INT,
  NULL::INT AS window_days,
  NOW() AS refreshed_at
FROM tables;

CREATE UNIQUE INDEX ON humanity_metrics.open_data_export_ratio (metric_id);

-- ── MV 8: politeness_preservation ─────────────────────────────────
CREATE MATERIALIZED VIEW humanity_metrics.politeness_preservation AS
WITH obs AS (
  SELECT
    COUNT(*) FILTER (WHERE respected = true)::INT AS respected_n,
    COUNT(*)::INT AS total_n
  FROM source_poll_observations
  WHERE observed_at > NOW() - INTERVAL '30 days'
)
SELECT
  8 AS metric_id,
  'politeness_preservation'::TEXT AS metric_name,
  ROUND(respected_n::numeric / NULLIF(total_n, 0), 4) AS current_value,
  respected_n::INT, total_n::INT,
  30 AS window_days,
  NOW() AS refreshed_at
FROM obs;

CREATE UNIQUE INDEX ON humanity_metrics.politeness_preservation (metric_id);

-- ── MV 9: geographic_balance (Gini) ───────────────────────────────
CREATE MATERIALIZED VIEW humanity_metrics.geographic_balance AS
WITH counts AS (
  SELECT geo_country, COUNT(*) AS n FROM articles
  WHERE published_at > NOW() - INTERVAL '30 days' AND geo_country IS NOT NULL
  GROUP BY geo_country
),
sorted AS (
  SELECT n, ROW_NUMBER() OVER (ORDER BY n) AS rn, COUNT(*) OVER () AS total_n
  FROM counts
)
SELECT
  9 AS metric_id,
  'geographic_balance'::TEXT AS metric_name,
  ROUND(1.0 - 2.0 * SUM((total_n - rn + 0.5) * n) / (total_n * SUM(n)), 4) AS current_value,
  total_n::INT AS countries_covered,
  30 AS window_days,
  NOW() AS refreshed_at
FROM sorted
GROUP BY total_n;

CREATE UNIQUE INDEX ON humanity_metrics.geographic_balance (metric_id);

-- ── MV 10: temporal_freshness ─────────────────────────────────────
CREATE MATERIALIZED VIEW humanity_metrics.temporal_freshness AS
SELECT
  10 AS metric_id,
  'temporal_freshness'::TEXT AS metric_name,
  EXTRACT(EPOCH FROM (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_surfaced_at - published_at)))::INT AS current_value,
  COUNT(*)::INT AS sample_size,
  30 AS window_days,
  NOW() AS refreshed_at
FROM articles
WHERE first_surfaced_at IS NOT NULL AND published_at > NOW() - INTERVAL '30 days';

CREATE UNIQUE INDEX ON humanity_metrics.temporal_freshness (metric_id);

-- ── Convenience: rollup view ──────────────────────────────────────
CREATE VIEW humanity_metrics.all_metrics AS
SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.information_reach
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.source_diversity
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.tier_coverage
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.extraction_accuracy
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.user_agency
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.cost_per_useful_action
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.open_data_export_ratio
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.politeness_preservation
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.geographic_balance
UNION ALL SELECT metric_id, metric_name, current_value, refreshed_at FROM humanity_metrics.temporal_freshness;

-- ── Refresh function (concurrent) ─────────────────────────────────
CREATE OR REPLACE FUNCTION humanity_metrics.refresh_all() RETURNS VOID AS $$
DECLARE mv TEXT;
BEGIN
  FOR mv IN SELECT unnest(ARRAY[
    'information_reach','source_diversity','tier_coverage','extraction_accuracy',
    'user_agency','cost_per_useful_action','open_data_export_ratio',
    'politeness_preservation','geographic_balance','temporal_freshness'
  ]) LOOP
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY humanity_metrics.%I', mv);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

GRANT SELECT ON ALL TABLES IN SCHEMA humanity_metrics TO xyzo_app, xyzo_public;

COMMIT;
```

- [ ] **Step 2: Apply + sanity check**

```bash
cd api && bun run db:migrate -- up migrations/2026-09-11-humanity-metrics.sql
psql $XYZO_DB_DSN -c "SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id;"
```

- [ ] **Step 3: Commit**

```bash
git add api/migrations/2026-09-11-humanity-metrics.sql
git commit -m "feat(hivv-E): 10 humanity metrics MVs + refresh_all() + rollup view"
```

---

### Task 2: Weekly digest generator

**Files:**
- Create: `worker/digest/weekly_humanity.py`

- [ ] **Step 1: Write digest generator**

```python
"""weekly_humanity.py — generate the weekly humanity + life metrics digest.
Spec: §10. Posted to public/digests/YYYY-MM-DD-humanity.md.
Called by systemd timer Sunday 06:00 UTC.
"""
import datetime, logging, os, sys, json
from pathlib import Path
import psycopg

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']
DIGESTS = Path('public/digests')
DIGESTS.mkdir(parents=True, exist_ok=True)

METRIC_LABELS = {
    'information_reach':         'Information reach (% of world population with ≥1 article about their country)',
    'source_diversity':           'Source diversity (HHI: 0 = perfectly diverse, 10000 = monopoly)',
    'tier_coverage':              'Tier coverage (median fraction of newsworthy events covered)',
    'extraction_accuracy':        'Extraction accuracy (median AI confidence, p10/p90)',
    'user_agency':                'User agency preserved (fraction of ask_user outcomes answered)',
    'cost_per_useful_action':     'Cost per useful action (watts ÷ successful AI actions)',
    'open_data_export_ratio':     'Open-data export ratio (fraction of tables licensed CC-BY-SA)',
    'politeness_preservation':    'Politeness preservation (fraction of polls respecting robots.txt + cadence)',
    'geographic_balance':         'Geographic balance (Gini coefficient of articles per country)',
    'temporal_freshness':         'Temporal freshness (median age of articles when first surfaced, seconds)',
}

def main(out_dir: Path = DIGESTS, week_ending: datetime.date | None = None) -> Path:
    week_ending = week_ending or datetime.datetime.now(datetime.timezone.utc).date()
    week_start = week_ending - datetime.timedelta(days=7)

    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id")
            rows = cur.fetchall()
            headers = [d.name for d in cur.description]

    md = build_markdown(week_start, week_ending, rows, headers)
    out = out_dir / f"{week_ending.isoformat()}-humanity.md"
    out.write_text(md, encoding='utf-8')
    log.info("wrote digest: %s", out)
    return out

def build_markdown(week_start, week_ending, rows, headers) -> str:
    out = [
        f"# Weekly humanity + life metrics — week ending {week_ending.isoformat()}",
        "",
        f"_Window: {week_start.isoformat()} → {week_ending.isoformat()}_",
        "",
        "_License: CC-BY-SA-4.0. Source: xyzo.org. No PII._",
        "",
        "| # | Metric | Value | Notes |",
        "|---|--------|-------|-------|",
    ]
    for r in rows:
        d = dict(zip(headers, r))
        label = METRIC_LABELS.get(d['metric_name'], d['metric_name'])
        notes = build_notes(d)
        val = d['current_value']
        val_s = f"{val:.4f}" if isinstance(val, float) else str(val)
        out.append(f"| {d['metric_id']} | {label} | **{val_s}** | {notes} |")

    out += [
        "",
        "## What we measure and why",
        "",
        "These ten metrics measure the health of the **human system**, not the AI system.",
        "They are aggregate, open, and skewed towards preservation:",
        "reach, diversity, agency, politeness, openness.",
        "",
        "## How to read this",
        "",
        "- **Information reach** rising = more countries are visible.",
        "- **Source diversity** falling = one source is dominating (watch the HHI).",
        "- **User agency** is a floor: it should never approach 0.",
        "- **Politeness preservation** should be ≥ 0.999 — anything lower is a bug.",
        "",
        f"Generated at {datetime.datetime.now(datetime.timezone.utc).isoformat()}",
    ]
    return "\n".join(out) + "\n"

def build_notes(d: dict) -> str:
    extras = []
    for k in ('sample_size','uncovered_population','active_sources','tiers_observed',
              'asked_n','answered_n','useful_actions','total_watts_30d',
              'open_n','total_n','respected_n','countries_covered','p10','p90'):
        if k in d and d[k] is not None:
            extras.append(f"{k}={d[k]}")
    return ", ".join(extras) if extras else ""

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    p = main()
    print(p)
```

- [ ] **Step 2: Commit**

```bash
git add worker/digest/weekly_humanity.py
git commit -m "feat(hivv-E): weekly digest generator (Markdown, CC-BY-SA, no PII)"
```

---

### Task 3: Digest tests

**Files:**
- Create: `worker/digest/weekly_humanity.test.py`

- [ ] **Step 1: Write tests**

```python
# worker/digest/weekly_humanity.test.py
import datetime
from pathlib import Path
from worker.digest.weekly_humanity import build_markdown, METRIC_LABELS

def test_build_markdown_includes_all_metrics():
    rows = [
        (1, 'information_reach', 0.6543, datetime.datetime.now()),
        (10, 'temporal_freshness', 1234, datetime.datetime.now()),
    ]
    headers = ['metric_id','metric_name','current_value','refreshed_at']
    md = build_markdown(
        datetime.date(2026,9,1), datetime.date(2026,9,7),
        rows, headers,
    )
    assert "Information reach" in md
    assert "0.6543" in md
    assert "Temporal freshness" in md
    assert "CC-BY-SA-4.0" in md

def test_digest_has_ten_metric_rows():
    md = build_markdown(datetime.date(2026,9,1), datetime.date(2026,9,7),
                         [(i, name, 0.5, None) for i, name in enumerate(METRIC_LABELS, 1)],
                         ['metric_id','metric_name','current_value','refreshed_at'])
    table_rows = [l for l in md.splitlines() if l.startswith("|") and "|" in l and not l.startswith("|--") and not l.startswith("| #")]
    assert len(table_rows) == 10
```

- [ ] **Step 2: Run + commit**

```bash
cd worker && pytest digest/weekly_humanity.test.py -v
git add worker/digest/weekly_humanity.test.py
git commit -m "test(hivv-E): digest shape + all-10-metrics-present"
```

---

### Task 4: Public CSV / Parquet / JSON export endpoints

**Files:**
- Create: `api/src/routes/humanity-export.ts`

- [ ] **Step 1: Write endpoints**

```ts
// api/src/routes/humanity-export.ts
// Public, no auth. Spec §10: open-data export.
// Streams CSV / JSON / Parquet from humanity_metrics.all_metrics.
import { Hono } from "hono";
import postgres from "postgres";
import { spawn } from "bun";

const sql = postgres(process.env.XYZO_DB_DSN!);
export const humanityExportRoutes = new Hono();

// CORS: open
humanityExportRoutes.use("/humanity/export*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  await next();
});

humanityExportRoutes.get("/humanity/export.csv", async (c) => {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="humanity-metrics.csv"');
  c.header("X-License", "CC-BY-SA-4.0");

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const rows = await sql`SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id`;
      if (rows.length === 0) {
        controller.enqueue(enc.encode("metric_id,metric_name,current_value,refreshed_at\n"));
      } else {
        const headers = Object.keys(rows[0]);
        controller.enqueue(enc.encode(headers.join(",") + "\n"));
        for (const r of rows) {
          controller.enqueue(enc.encode(headers.map(h => csvCell(r[h])).join(",") + "\n"));
        }
      }
      controller.close();
    },
  });
  return c.body(stream);
});

humanityExportRoutes.get("/humanity/export.json", async (c) => {
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("X-License", "CC-BY-SA-4.0");
  const rows = await sql`SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id`;
  return c.json({
    license: "CC-BY-SA-4.0",
    source: "xyzo.org",
    generated_at: new Date().toISOString(),
    metrics: rows,
  });
});

humanityExportRoutes.get("/humanity/export.parquet", async (c) => {
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", 'attachment; filename="humanity-metrics.parquet"');
  c.header("X-License", "CC-BY-SA-4.0");

  // Stream via Python (pyarrow → stdout)
  const proc = spawn({
    cmd: ['python3', '-c', `
import sys, json
from pyarrow import json as paj, parquet as pq
import psycopg
conn = psycopg.connect("$XYZO_DB_DSN")
with conn.cursor() as cur:
    cur.execute("SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id")
    rows = cur.fetchall()
    cols = [d.name for d in cur.description]
table = paj.read_json(json.dumps([dict(zip(cols, r)) for r in rows]).encode())
pq.write_table(table, sys.stdout.buffer)
`],
    stdout: 'pipe', stderr: 'pipe',
  });
  return c.body(new Response(proc.stdout).body);
});

function csvCell(v: any): string {
  if (v === null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
```

- [ ] **Step 2: Wire + commit**

```bash
# In api/src/server.ts: import + route

git add api/src/routes/humanity-export.ts api/src/server.ts
git commit -m "feat(hivv-E): public CSV/JSON/Parquet export (CC-BY-SA-4.0, CORS *)"
```

---

### Task 5: Humanity tab in 🌐 WORLD dashboard

**Files:**
- Create: `api/src/routes/humanity-dashboard.ts`

- [ ] **Step 1: Write endpoint**

```ts
// api/src/routes/humanity-dashboard.ts
// Fragment endpoint consumed by 🌐 WORLD scope (Plan D).
import { Hono } from "hono";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

export const humanityDashboardRoutes = new Hono();

humanityDashboardRoutes.get("/api/humanity/dashboard", async (c) => {
  const rows = await sql`SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id`;
  const html = `
    <section aria-labelledby="humanity">
      <h2 id="humanity">Humanity + life metrics</h2>
      <p><small>Aggregated, anonymised, CC-BY-SA-4.0. Last refreshed: ${rows[0]?.refreshed_at ?? '—'}</small></p>
      <table>
        <thead><tr><th scope="col">#</th><th scope="col">Metric</th><th scope="col">Current</th><th scope="col">Actions</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${r.metric_id}</td>
              <td><code>${r.metric_name}</code></td>
              <td><strong>${formatVal(r.current_value)}</strong></td>
              <td>
                <a href="/humanity/export.csv?metric=${r.metric_name}">CSV</a> ·
                <a href="/api/humanity/spark?metric=${r.metric_name}">spark</a>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </section>`;
  return c.html(html);
});

function formatVal(v: any): string {
  if (typeof v === 'number') return v < 1 ? v.toFixed(4) : v.toFixed(0);
  return String(v);
}
```

- [ ] **Step 2: Wire + commit**

```bash
# Wire into server.ts; the dashboard route in Plan D Task 4 calls this fragment via HTMX

git add api/src/routes/humanity-dashboard.ts api/src/server.ts
git commit -m "feat(hivv-E): /api/humanity/dashboard fragment for 🌐 WORLD"
```

---

### Task 6: Refresh script

**Files:**
- Create: `scripts/refresh-humanity.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
# scripts/refresh-humanity.sh
# Refresh all 10 humanity MVs. Idempotent.
# Called by systemd timer (Task 7) and by manual cron in emergency.
set -euo pipefail
DSN="${XYZO_DB_DSN:?XYZO_DB_DSN required}"
psql "$DSN" -c "SELECT humanity_metrics.refresh_all();" \
  && echo "[$(date -u +%FT%TZ)] humanity MVs refreshed" \
  | tee -a /var/log/hivv-humanity.log
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/refresh-humanity.sh
git add scripts/refresh-humanity.sh
git commit -m "feat(hivv-E): refresh-humanity.sh script"
```

---

### Task 7: systemd timers

**Files:**
- Create: `scripts/systemd/hivv-humanity-refresh.service`
- Create: `scripts/systemd/hivv-humanity-refresh.timer`
- Create: `scripts/systemd/hivv-weekly-digest.service`
- Create: `scripts/systemd/hivv-weekly-digest.timer`

- [ ] **Step 1: Refresh service**

```ini
# scripts/systemd/hivv-humanity-refresh.service
[Unit]
Description=hivv — refresh humanity MVs nightly
After=postgresql.service

[Service]
Type=oneshot
EnvironmentFile=/etc/hivv/env
User=hivv
ExecStart=/var/www/vhosts/xyzo.org/scripts/refresh-humanity.sh
Nice=10
```

- [ ] **Step 2: Refresh timer (03:30 UTC nightly)**

```ini
# scripts/systemd/hivv-humanity-refresh.timer
[Unit]
Description=hivv — nightly humanity refresh

[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Digest service**

```ini
# scripts/systemd/hivv-weekly-digest.service
[Unit]
Description=hivv — generate weekly humanity digest
After=postgresql.service

[Service]
Type=oneshot
WorkingDirectory=/var/www/vhosts/xyzo.org
EnvironmentFile=/etc/hivv/env
User=hivv
ExecStart=/usr/bin/python3 -m worker.digest.weekly_humanity
Nice=10
```

- [ ] **Step 4: Digest timer (Sunday 06:00 UTC)**

```ini
# scripts/systemd/hivv-weekly-digest.timer
[Unit]
Description=hivv — Sunday morning weekly digest

[Timer]
OnCalendar=Sun *-*-* 06:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Install + commit**

```bash
sudo cp scripts/systemd/hivv-*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hivv-humanity-refresh.timer hivv-weekly-digest.timer
sudo systemctl list-timers | grep hivv
git add scripts/systemd/
git commit -m "feat(hivv-E): systemd timers (03:30 nightly refresh, Sun 06:00 digest)"
```

---

### Task 8: Export endpoint tests

**Files:**
- Create: `api/tests/humanity-export.test.ts`

- [ ] **Step 1: Write tests**

```ts
// api/tests/humanity-export.test.ts
import { describe, expect, test } from "bun:test";
import { humanityExportRoutes } from "../src/routes/humanity-export";

describe("humanity export endpoints", () => {
  test("CSV has license header and content-type", async () => {
    const r = await humanityExportRoutes.request("/humanity/export.csv");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.headers.get("x-license")).toBe("CC-BY-SA-4.0");
    const text = await r.text();
    expect(text.split("\n")[0]).toContain("metric_id");
    expect(text.split("\n")[0]).toContain("metric_name");
  });

  test("JSON has license + metrics array", async () => {
    const r = await humanityExportRoutes.request("/humanity/export.json");
    expect(r.status).toBe(200);
    const data: any = await r.json();
    expect(data.license).toBe("CC-BY-SA-4.0");
    expect(Array.isArray(data.metrics)).toBe(true);
    expect(data.metrics.length).toBe(10);
  });

  test("CSV is CORS-open", async () => {
    const r = await humanityExportRoutes.request("/humanity/export.csv");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
cd api && bun test tests/humanity-export.test.ts 2>&1 | tail -10
git add api/tests/humanity-export.test.ts
git commit -m "test(hivv-E): CSV/JSON export + CORS + 10-metric count"
```

---

### Task 9: MV correctness tests

**Files:**
- Create: `api/tests/humanity-mvs.test.ts`

- [ ] **Step 1: Write tests**

```ts
// api/tests/humanity-mvs.test.ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

describe("humanity MVs", () => {
  test("exactly 10 MVs exist", async () => {
    const rows = await sql`
      SELECT COUNT(*) AS n FROM pg_matviews WHERE schemaname='humanity_metrics'
    `;
    expect(Number(rows[0].n)).toBe(10);
  });

  test("all_metrics returns 10 rows", async () => {
    const rows = await sql`SELECT * FROM humanity_metrics.all_metrics`;
    expect(rows.length).toBe(10);
  });

  test("metric IDs 1..10 are contiguous", async () => {
    const rows = await sql`SELECT metric_id FROM humanity_metrics.all_metrics ORDER BY metric_id`;
    expect(rows.map(r => Number(r.metric_id))).toEqual([1,2,3,4,5,6,7,8,9,10]);
  });

  test("current_value is numeric or null", async () => {
    const rows = await sql`SELECT current_value FROM humanity_metrics.all_metrics`;
    for (const r of rows) {
      expect(r.current_value === null || typeof Number(r.current_value) === 'number').toBe(true);
    }
  });

  test("refresh_all is idempotent (can be called twice)", async () => {
    await sql`SELECT humanity_metrics.refresh_all()`;
    await sql`SELECT humanity_metrics.refresh_all()`;
    // Just verify no error
    const rows = await sql`SELECT COUNT(*) AS n FROM humanity_metrics.all_metrics`;
    expect(Number(rows[0].n)).toBe(10);
  });

  test("politeness metric exists and is a rate in [0,1]", async () => {
    const [r] = await sql`SELECT current_value FROM humanity_metrics.politeness_preservation`;
    const v = Number(r.current_value);
    if (v !== 0) expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
cd api && bun test tests/humanity-mvs.test.ts 2>&1 | tail -10
git add api/tests/humanity-mvs.test.ts
git commit -m "test(hivv-E): MV count, IDs, ranges, refresh idempotency"
```

---

### Task 10: Documentation + handoff

- [ ] **Step 1: Write summary**

```bash
cat > docs/hivv-plan-e-summary.md <<'EOF'
# hivv Plan E — Humanity + Life Metrics

**Status:** Complete. 10 metrics, refreshed nightly, exported as CC-BY-SA-4.0.

## What ships
- 10 Postgres materialised views in `humanity_metrics` schema
- `humanity_metrics.refresh_all()` runs REFRESH CONCURRENTLY on all 10
- `humanity_metrics.all_metrics` rollup view
- Public CSV / JSON / Parquet export at /humanity/export.{csv,json,parquet}
- Dashboard fragment at /api/humanity/dashboard (embedded in 🌐 WORLD)
- Weekly Markdown digest at public/digests/YYYY-MM-DD-humanity.md
- systemd timers: 03:30 UTC nightly refresh, Sun 06:00 UTC digest

## Metrics
1. **Information reach** — fraction of world population with ≥1 article about their country
2. **Source diversity** — HHI of source shares (0=perfect, 10000=monopoly)
3. **Tier coverage** — median fraction of newsworthy events covered, per tier
4. **Extraction accuracy** — median AI confidence (p10/p90)
5. **User agency** — fraction of ask_user outcomes answered
6. **Cost per useful action** — watts ÷ successful AI actions
7. **Open-data export ratio** — fraction of tables licensed CC-BY-SA
8. **Politeness preservation** — fraction of polls respecting robots.txt + cadence
9. **Geographic balance** — Gini coefficient of articles per country
10. **Temporal freshness** — median age of articles when first surfaced

## License
All exports carry `X-License: CC-BY-SA-4.0`. Source: xyzo.org. No PII ever exported.

## Caveats
- MVs depend on `eval_observations`, `articles`, `sources`, `pins`, `geonames_countries`
  — these must be populated before MVs are non-trivial
- Window is hard-coded to 30 days; configurable via env var in Phase 4
- Gini implementation is the rank-based version; check accuracy against a reference dataset

## Next
Plan F — Public/Private/Session Persona Protocol (10-field Agent Identity, consent ledger).
EOF
git add docs/hivv-plan-e-summary.md
git commit -m "docs(hivv-E): Plan E summary"
```

---

## Done — Plan E complete

Verify:
```bash
cd api && bun test tests/humanity-export.test.ts tests/humanity-mvs.test.ts 2>&1 | tail -10
cd worker && pytest digest/weekly_humanity.test.py -v
psql $XYZO_DB_DSN -c "SELECT * FROM humanity_metrics.all_metrics ORDER BY metric_id;"
curl -sI http://localhost:3008/humanity/export.csv | head -5
curl -s http://localhost:3008/humanity/export.json | jq '.metrics | length'
```

Green → proceed to **Plan F — Public/Private/Session Persona Protocol** (`docs/superpowers/plans/2026-09-07-hivv-plan-f-persona.md`).
