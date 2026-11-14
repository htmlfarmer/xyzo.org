# The hivv Protocol — Distributed, Local-First Control Plane for Human-AI Coordination

**Status:** Public draft for community call
**Date:** 2026-09-07
**Author:** hivv.org core team
**License:** CC-BY-SA 4.0 (this document); MIT (the schemas and reference code)

> *"Your AIs. Your home. Your control."*

---

## Mission & Scope

Soon, every human will have many AIs helping them — one for writing, one for planning, one for their business, maybe a dozen for their team. Today, those AIs are scattered across apps, each one a black box the human can't see into, each one sending data somewhere the human doesn't control. **hivv is the home for all of them.**

hivv is a distributed, local-first control plane that helps humans coordinate their AI fleets. It is designed around three commitments:

1. **Trust + transparency** — every AI action is attested; every owner can see what their AIs are doing; the dashboard surfaces reasoning, doubt, and uncertainty.
2. **Local-first** — AIs run on the owner's machines by default. The only "fee" is local electricity + compute time. No paid APIs required. No vendor lock-in.
3. **Humanity + life** — built on shared principles: accessible to all, multilingual, transparent about bias, attentive to the planet, sacred about spiritual and philosophical privacy.

The protocol is **domain-agnostic**. The canonical reference deployment is [xyzo.org](https://xyzo.org) — a global news map. Other deployments will serve research, education, healthcare, climate, creative work, small business, and any project where multiple AIs work together under human control. Examples throughout this spec are drawn from multiple domains; the design itself is reusable.

### Cross-cutting principles (applied to every section)

- **Value:** every metric exists because a human (or non-human lifeform) needs it
- **Fun:** delight is a feature — sparklines breathe, moments of joy are counted
- **Creativity:** the constellation view makes data beautiful
- **Spirituality:** the private vault protects what only the owner and the AI see

### Who this is for

- **Owners** of multi-AI fleets — individuals, teams, small businesses, communities
- **Operators** of hivv deployments — sysadmins, platform engineers
- **Federation peers** — instances that share anonymized eval_observations for mutual benefit
- **Researchers + journalists** who study how AIs serve (or fail to serve) humans
- **Builders** who fork the protocol for their own domains

### What hivv is NOT

- Not a product you buy — it's a protocol you run
- Not a single vendor's platform — no single point of control
- Not a paid API — local models do the work
- Not a black box — every action is attested
- Not a finished thing — a living conversation

### Decomposition into sub-projects

This spec is large because hivv is. It is intended to be implemented as a sequence of independently-shippable sub-projects, each with its own design + plan + review cycle. Each sub-project lands cleanly without blocking the others:

| Sub-project | Sections covered | Reference impl |
|---|---|---|
| **A. Eval store + 4 learning loops** | §1, §2, §3, §4, §5, §6, §7 | xyzo (story clustering, coverage, fetch bandit, extract QA) |
| **B. Improvement orchestrator** | §1.2, §2.5, §2.6, §2.7 | xyzo (daily timer; per-loop thresholds; cross-loop signals) |
| **C. Distributed AI control plane** | §8 | xyzo (gateway + safety nets + breakers); publishable as `xyzo-ai-control-plane` |
| **D. Operator dashboard** | §9 | xyzo `/hivv` surface (Overview, AIs, Projects, Humanity, etc.) |
| **E. Humanity + life metrics** | §10 | xyzo (10 MVs; open-data export; weekly digest) |
| **F. Public/private persona protocol** | §11 | xyzo (attestation envelope; private vault; consent ledger; persona_transitions) |
| **G. Open governance + community** | §12 | hivv.org (RFC repo, decision log, weekly community call) |

**Order of implementation** (recommended): A → B → C → D → E → F → G. Earlier sub-projects create surfaces later ones depend on (eval store underpins orchestrator; orchestrator triggers handlers; control plane feeds dashboard; persona protocol wraps everything).

**Per sub-project budget:** 1-3 weeks of focused work, end-to-end tested in CI, shipped behind feature flag, with its own RFC.

---

## Table of Contents

1. [Architecture — Five Layers, One Queue](#1-architecture--five-layers-one-queue)
2. [Data Flow — The Four Loops + Orchestrator](#2-data-flow--the-four-loops--orchestrator)
3. [Eval Store Schema — The Shared Facts Log](#3-eval-store-schema--the-shared-facts-log)
4. [Tier-Aware Gates — Politeness Preservation](#4-tier-aware-gates--politeness-preservation)
5. [Error Handling & Failure Modes](#5-error-handling--failure-modes)
6. [Testing Strategy](#6-testing-strategy)
7. [Rollout & Observability](#7-rollout--observability)
8. [Distributed AI Control Plane](#8-distributed-ai-control-plane)
9. [Operator Dashboard — Your Home for Your AIs](#9-operator-dashboard--your-home-for-your-ais)
10. [Humanity + Life Metrics](#10-humanity--life-metrics)
11. [The Public/Private Persona Protocol](#11-the-publicprivate-persona-protocol)
12. [Open Governance](#12-open-governance)

---

## 1. Architecture — Five Layers, One Queue

### 1.1 Five layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1: PRODUCERS (project-specific)                              │
│  xyzo: worker/learn.py, story_linker.py, coverage_bot.py, extract.py│
│  research: paper-quality scorer, citation linker, peer-review AIs   │
│  education: lesson-plan generator, language detector, rubric builder│
│  healthcare: symptom checker, patient-journey mapper, triage AI     │
│  climate: emission tracker, biodiversity indexer, alert prioritizer │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 2: SHARED FACTS LOG (new, project-agnostic)                  │
│  eval_observations table — append-only, typed payloads               │
│  Loops: extraction_diff, story_quality, source_discovery,           │
│         fetch_outcome, user_signal, orchestrator_run, ai_call,      │
│         ai_injection, shadow_eval, privacy_audit, joy_signal        │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 3: PER-LOOP HANDLERS (worker/handlers/, queue job kinds)     │
│  links_run · coverage_bot · scheduler_bandit · extract_qa           │
│  model_finetune · shadow_eval · plus domain-specific handlers      │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 4: PER-LOOP METRICS (materialized views, refreshed nightly)  │
│  mv_coverage_breadth · mv_extraction_accuracy                       │
│  mv_story_signal_noise · mv_user_help_proxy                        │
│  mv_trust_score · mv_bias_score · mv_voice_score · mv_accessibility │
│  mv_privacy_score · mv_care_score · mv_safety_score                │
│  mv_local_score · mv_teaching_score · mv_joy_score                  │
│  mv_ai_drift · mv_shadow_compare                                    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 5: ORCHESTRATOR + DASHBOARDS                                 │
│  improvement_orchestrator — reads MVs, enqueues jobs when threshold │
│  /api/hivv/* dashboards · /api/eval/{loop}/metrics                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 New JobKinds (in `kindConfig.ts`)

| Kind | Soft cap | Default timeout | Trigger |
|---|---|---|---|
| `links_run` | 2 | 120s | Orchestrator + `xyzo-story-link.timer` |
| `coverage_bot` | 1 | 60s | Orchestrator threshold (daily at most) |
| `discover_source` | 2 | 90s | Enqueued by coverage_bot; admin reviews |
| `scheduler_bandit` | 1 | 30s | Orchestrator + after every fetch batch |
| `extract_qa` | 1 | 180s | Nightly + on extraction_feedback spike |
| `model_finetune` | 1 | 3600s | Weekly + on shadow_eval promotion |
| `shadow_eval` | 1 | 300s | Weekly + on experiment registration |
| `analytics_inline` | 1 | 60s | Orchestrator daily 04:15 |

**Tier-aware gate at the enqueue step:** gov/university gaps are logged but never auto-enqueue write-side jobs. Same politeness contract that xyzo already enforces at score 92/100.

### 1.3 New endpoints (admin-only, except GET metrics)

| Endpoint | Purpose |
|---|---|
| `GET /api/eval/{coverage,extraction,story,user}/metrics` | per-loop metric snapshots |
| `GET /api/eval/{trust,bias,voice,a11y,privacy,care,safety,local,teaching,joy}/metrics` | humanity metrics from §10 |
| `GET /api/hivv/open-data/export` | JSONL + manifest with hashes |
| `GET /api/hivv/federation/peers` | known peers + their stats |
| `GET /api/hivv/persona/transitions` | every cross-boundary data share (owner view) |
| `GET /api/hivv/governance/rfcs` | active RFCs at all stages |
| `GET /api/improvement/status` | orchestrator state, last trigger, next threshold trip |
| `POST /api/improvement/run/<loop>` | admin manual trigger |
| `POST /api/admin/coverage-gaps/top` | top gaps awaiting review |
| `GET /api/ai/control/state` | all breakers (per-provider) |
| `GET /api/ai/control/usage` | compute budget per provider per tier |
| `GET /api/ai/control/prompts` | version registry |
| `POST /api/ai/control/breakers/<provider>/reset` | admin reset |

### 1.4 Tier-aware gates — three checkpoints per loop

Each handler implements three gates before any write:

1. **Tier check** — gov/university sources can be observed but never trigger auto-fetch cadence change, auto-source acquisition, or model rollout.
2. **Stable-hash feature flag** — `improvement_loop.<loop>` with `tier_overrides: {gov: 0, university: 0}` defaults.
3. **Threshold check** — orchestrator only enqueues when metric moves outside `[warn, fail]` band; hysteresis prevents thrash.

The principle: **reads on protected tiers are fine; writes that change behavior on protected tiers are not.**

---

## 2. Data Flow — The Four Loops + Orchestrator

### 2.1 Flow A — Story clustering (or "linking" in any domain)

```
articles / records
  └─► story_linker.py (or paper_linker.py / lesson_linker.py)
        ├─► news_story_links (rows: article_id, story_id, edge_weight)
        └─► news_events (headline, summary, primary_location, expires_at)
  └─► links_run handler (queue kind: links_run)
        ├─► PageRank on event graph → news_story_links.rank
        └─► Append eval_observations (loop: story_quality)
  └─► mv_story_signal_noise — cluster_size / total_pins + mean top-10 PageRank
  └─► UI: pin popup badge "N sources" + cluster card
```

### 2.2 Flow B — Coverage gaps → source acquisition

```
geocoded pins / active records per region
  └─► coverage_bot.py
        └─► news_coverage_gaps (country, region, gap_score, suggested_query)
  └─► improvement_orchestrator reads mv_coverage_breadth
        └─► If metric < threshold AND gap_score > COVERAGE_GAP_THRESHOLD (=0.6):
              ├─► tier check: gov/university → log only, no enqueue
              └─► enqueue coverage_bot (non-protected tier gaps only)
  └─► coverage_bot handler
        └─► Append eval_observations (loop: source_discovery)
        └─► For each gap → enqueue discover_source (admin queue)
  └─► Admin UI: /api/admin/coverage-gaps/top + approve/decline
  └─► mv_coverage_breadth refresh
```

### 2.3 Flow C — Adaptive fetch / scheduling

```
fetch.py / record_collector.py poll outcome
  └─► source_poll_observations (existing per-poll)
  └─► learn.py → news_fetch_decisions (source_id, next_fetch_at, expected_yield, confidence)
  └─► scheduler_bandit handler (kind: scheduler_bandit)
        ├─► UCB1: upper-bound = expected_yield + c·sqrt(ln(T)/n)
        ├─► Tier check: gov/university → keep static cadence
        └─► Update next_fetch_at
  └─► fetch.py reads next_fetch_at (was: poll_interval_s only)
        └─► Append eval_observations (loop: fetch_outcome)
  └─► mv_coverage_breadth + new mv_fetch_efficiency
```

### 2.4 Flow D — Extraction / generation quality

```
extract.py / content_generator output → record fields
  └─► Comparison vs re_evaluate.py / user_corrections ground truth
        └─► news_extraction_feedback (existing schema)
  └─► extract_qa handler (kind: extract_qa)
        ├─► Diff: extract.py output vs ground truth
        ├─► Tier check: gov/university training rows excluded
        └─► Append eval_observations (loop: extraction_diff)
  └─► mv_extraction_accuracy
        ├─► precision / recall per field
        └─► drift: current − baseline
  └─► Retrain signal: if drift > threshold → /api/admin/nn/retrain-suggested
```

### 2.5 Orchestrator trigger flow

```
xyzo-improvement.timer (daily 04:15 — staggered from xyzo-nightly 03:00)
  └─► improvement_orchestrator (kind: analytics_inline, soft cap 1)
        ├─► REFRESH MATERIALIZED VIEW CONCURRENTLY (each MV in parallel)
        ├─► For each loop:
        │     ├─► read metric + last value
        │     ├─► if metric ∈ (warn, fail): warn log + dashboard flag
        │     ├─► if metric > fail: enqueue loop handler (one job per trip)
        │     └─► if metric < warn: nothing (hysteresis — don't trip back immediately)
        └─► Append eval_observations (loop: orchestrator_run)
```

### 2.6 Cross-loop signals (the "recursive" property)

The orchestrator reads *all* metrics before deciding — so one loop can affect another's trigger:

- **Coverage breadth drop** → enqueue `coverage_bot` + enqueue `links_run`
- **Extraction accuracy drift** → enqueue `extract_qa` + enqueue `scheduler_bandit`
- **Story S/N drop** → enqueue `links_run`
- **User-help drop** → log + alert admin (no auto-action; laggy signal)
- **Trust score drop** → enqueue audit replay + dashboard alert
- **Bias diversity drop** → enqueue `links_run` + flag for admin

### 2.7 Initial thresholds (tunable in `feature_config`)

| Metric | Warn | Fail | Direction |
|---|---|---|---|
| Coverage breadth | < 70% | < 55% | Below triggers action |
| Extraction accuracy | drift > 0.05 | drift > 0.10 | Drift triggers action |
| Story S/N | cluster ratio < 1.2 | < 1.0 | Below triggers re-cluster |
| User-help proxy | retention < 30% | < 20% | Below triggers admin alert only |
| Trust score | attestation < 95% | < 90% | Below triggers audit |
| Bias diversity | entropy < 1.5 | < 1.0 | Below triggers re-cluster |
| Voice coverage | < 60% | < 45% | Below triggers source acquisition |
| Privacy score | pii_rows > 0 | overdue_deletions > 5 | Above triggers immediate action |
| Local-first | external_paid > 0 | — | Any external paid call = alert |
| Joy score | delights_per_user < 0.5/wk | < 0.2/wk | Below triggers UX review |

---

## 3. Eval Store Schema — The Shared Facts Log

### 3.1 `eval_observations` (shared facts log)

```sql
-- api/migrations/2026-09-07-eval-observations.sql

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
  weight      REAL NOT NULL DEFAULT 1.0,
  created_by  TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX eval_obs_loop_time_idx ON eval_observations (loop, observed_at DESC);
CREATE INDEX eval_obs_tier_time_idx ON eval_observations (tier, observed_at DESC);
CREATE INDEX eval_obs_host_idx      ON eval_observations (host) WHERE host IS NOT NULL;
CREATE INDEX eval_obs_payload_gin  ON eval_observations USING GIN (payload jsonb_path_ops);

-- Append-only enforced by trigger
CREATE OR REPLACE FUNCTION eval_obs_no_update() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'eval_observations is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER eval_obs_no_update BEFORE UPDATE ON eval_observations
  FOR EACH ROW EXECUTE FUNCTION eval_obs_no_update();
```

### 3.2 Per-loop metric materialized views

Each materialized view follows the same pattern: query `eval_observations` for the loop, compute the metric, expose via `GET /api/eval/<loop>/metrics`. The orchestrator refreshes them nightly with `REFRESH MATERIALIZED VIEW CONCURRENTLY`. All views include `computed_at` and a unique index on it to support `CONCURRENTLY`.

Example: `mv_coverage_breadth`

```sql
CREATE MATERIALIZED VIEW mv_coverage_breadth AS
WITH country_pop AS (
  SELECT country_code, SUM(population) AS pop
  FROM world_cities
  WHERE population IS NOT NULL
  GROUP BY 1
),
covered AS (
  SELECT
    n.country,
    COUNT(DISTINCT p.id) FILTER (
      WHERE COALESCE(n.published_at, p.created_at) > NOW() - INTERVAL '24 hours'
    ) AS fresh_pins
  FROM pins p
  JOIN news_locations nl ON nl.id = p.location_id
  JOIN news_sources n    ON n.id = p.source_id
  GROUP BY 1
)
SELECT
  NOW() AS computed_at,
  SUM(cp.pop) FILTER (WHERE c.fresh_pins > 0)::FLOAT / NULLIF(SUM(cp.pop), 0) AS coverage_ratio,
  COUNT(*) FILTER (WHERE c.fresh_pins > 0) AS countries_covered,
  (SELECT COUNT(DISTINCT country_code) FROM country_pop) AS countries_total
FROM country_pop cp LEFT JOIN covered c ON c.country = cp.country_code;

CREATE UNIQUE INDEX mv_coverage_breadth_pk ON mv_coverage_breadth (computed_at);
```

The other materialized views (`mv_extraction_accuracy`, `mv_story_signal_noise`, `mv_user_help_proxy`, `mv_trust_score`, `mv_bias_score`, `mv_voice_score`, `mv_accessibility_score`, `mv_privacy_score`, `mv_care_score`, `mv_safety_score`, `mv_local_score`, `mv_teaching_score`, `mv_joy_score`, `mv_ai_drift`, `mv_shadow_compare`) follow the same pattern with loop-specific SQL.

### 3.3 Supporting tables

```sql
-- user_signal_events (frontend writes; hashed user_id only)
CREATE TABLE user_signal_events (
  id BIGSERIAL PRIMARY KEY,
  user_id_hash TEXT NOT NULL,           -- sha256(ip + daily_salt)
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_s   REAL,
  cluster_click INT DEFAULT 0,
  pin_view    INT DEFAULT 0,
  search_query TEXT,
  delight     BOOLEAN DEFAULT FALSE,    -- joy metric input
  tier        eval_tier NOT NULL DEFAULT 'user'
);

-- eval_baseline_corpus (immutable ground truth for A/B)
CREATE TABLE eval_baseline_corpus (
  id            BIGSERIAL PRIMARY KEY,
  baseline_label TEXT NOT NULL,         -- 'extraction-2026-09-07'
  frozen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  article_id    BIGINT REFERENCES news_articles(id),
  source_id     BIGINT REFERENCES news_sources(id),
  field TEXT NOT NULL,
  expected_value JSONB NOT NULL,
  actual_value   JSONB NOT NULL,
  tier          eval_tier NOT NULL DEFAULT 'unknown'
);
```

**Retention:** `user_signal_events` rows older than 90 days auto-purged (cron, PII minimization). `eval_baseline_corpus` is forever. `eval_observations` retained indefinitely by default with a `feature_config` flag for archival.

---

## 4. Tier-Aware Gates — Politeness Preservation

### 4.1 The three-gate pattern

```
Input signal ──► Gate 1: Tier check   ──► Gate 2: Feature flag ──► Gate 3: Threshold ──► Act + append eval_observations
                  gov/university →        improvement_loop.<x>      metric outside
                  observe only            tier_overrides:            [warn, fail] band
                                            {gov: 0, university: 0}  AND hysteresis OK
```

### 4.2 Per-loop gate behavior

| Loop | gov / university behavior | Why |
|---|---|---|
| `links_run` | **Observe, act.** | Multi-source clustering helps users; tier check only blocks writes that *change* behavior on protected hosts |
| `coverage_bot` | **Observe only.** | Auto-acquiring `.gov`/`.edu` sources could trigger legal/robots issues. Standing constraint |
| `scheduler_bandit` | **Observe only.** | The 24h/6h floors are SQL-enforced; the bandit must never reduce them |
| `extract_qa` | **Observe only.** | Training rows excluded from retrain corpus (already enforced in `classifier._EXCLUDED_TIERS`) |
| `model_finetune` | **Observe only.** | New model version never auto-promoted on protected tiers |
| `shadow_eval` | **Observe only on protected tiers.** | Shadow mode runs but doesn't influence the active model selection for protected tiers |

### 4.3 Feature flag defaults

```sql
INSERT INTO feature_flags (key, enabled, rollout_pct, tier_overrides, description) VALUES
  ('improvement_loop.story_clustering', true, 100, '{}', 'Cluster records into multi-source events'),
  ('improvement_loop.coverage_bot',      true,  25, '{"gov": 0, "university": 0}', 'Auto-acquire sources for non-protected tier gaps'),
  ('improvement_loop.scheduler_bandit',  true, 100, '{"gov": 0, "university": 0}', 'Adapt fetch cadence from bandit signal'),
  ('improvement_loop.extract_qa',        true, 100, '{}', 'Replay extraction vs ground truth'),
  ('improvement_loop.model_finetune',    true,  10, '{"gov": 0, "university": 0}', 'Fine-tune local models on eval corpus');
```

### 4.4 Threshold + hysteresis (Gate 3)

```
       metric value
       │
fail ──│── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─► trip
       │
warn ──│── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─► dashboard
       │
       └─────────────────────────────────────────►
       0
```

Once a handler runs, don't re-enqueue for `COOLDOWN_S = 3600s` (1 hour), regardless of metric value. State stored in `improvement_orchestrator_state`:

```sql
CREATE TABLE improvement_orchestrator_state (
  loop TEXT PRIMARY KEY,
  last_run_at    TIMESTAMPTZ,
  last_metric    JSONB,
  cooldown_until TIMESTAMPTZ,
  circuit        TEXT NOT NULL DEFAULT 'closed'  -- closed | open | half_open
);
```

### 4.5 Tier mismatch CI check

A drift between Python `worker/robots.py:tier_for_url` and SQL `tier_fn.tier_for_url_inline` would silently break the politeness guarantee. CI test:

```ts
// api/tests/tier-drift.test.ts
const FIXTURE = [/* 50 URLs covering TLDs and subdomains */];
for (const url of FIXTURE) {
  test(`tier parity: ${url}`, async () => {
    expect(tsTier(url)).toBe(await sqlTier(url));
  });
}
```

If drift is detected, CI blocks the deploy. The politeness guarantee stops being a code review item and becomes a regression test.

---

## 5. Error Handling & Failure Modes

### 5.1 Failure mode matrix

| Failure | Impact | Recovery | Trigger |
|---|---|---|---|
| Orchestrator job fails | One cycle missed, MVs stale | Queue retry (3× exponential); degraded mode alert | `discovery_jobs.status = failed` |
| Handler job fails | One loop's last value unchanged | Queue retry; loop metric flags "stale" | `discovery_jobs.status = failed` |
| MV refresh fails | Orchestrator reads stale MVs | Fallback to live query; warn log | Postgres error |
| Eval store write fails | Observation lost | Loop continues; warn log; inline retry | Unique violation / disk full |
| Tier check fails open (bug) | Could over-poll protected tier | Tier-drift CI test catches it before deploy | CI |
| Threshold misconfigured | Loops trip too often or never | Tunable in `feature_config` | Manual |
| Cascade | Loop storm | Hard depth limit: each handler can enqueue at most 1 follow-up job per cycle | `MAX_FOLLOWUP_ENQUEUES = 1` |

### 5.2 Queue retry policy

| Kind | Max retries | Backoff | Soft cap | Hard kill |
|---|---|---|---|---|
| `links_run` | 3 | exp 2× | 2 | after 6 min |
| `coverage_bot` | 3 | exp 2× | 1 | after 6 min |
| `scheduler_bandit` | 5 | exp 1.5× | 1 | after 5 min |
| `extract_qa` | 2 | exp 2× | 1 | after 12 min |
| `model_finetune` | 1 | — | 1 | after 60 min |

After hard kill: loop is marked `circuit_open` in `improvement_orchestrator_state`; admin resets via `POST /api/admin/improvement/reset/<loop>`.

### 5.3 Cascade breaker

```ts
if (job.followup_count >= MAX_FOLLOWUP_ENQUEUES) {
  log.warn('cascade-break', { job_id, kind });
  return; // drop the enqueue, don't throw
}
```

### 5.4 Degraded mode

If any MV is older than 48 hours, `/api/improvement/status` returns `degraded: true`. The orchestrator:

- Skips threshold-based enqueues (can't trust stale metric)
- Still runs `links_run` + `extract_qa` (idempotent, read-only)
- Suspends `coverage_bot` + `scheduler_bandit` (these write)
- Pages admin

### 5.5 Politeness failure → halt

If the tier-drift CI test ever catches a mismatch *in production*:

- `xyzo-improvement.timer` disables itself for 24h
- Admin gets high-priority alert via `/api/admin/alerts`
- Auto-revert: redeploy the fix

This is the only failure that stops the entire engine.

### 5.6 Observability surface

Every loop write appends an `eval_observations` row with `loop: orchestrator_run` describing the trip decision. The orchestrator's behavior is itself auditable from the eval store.

---

## 6. Testing Strategy

### 6.1 Test layers

| Layer | What to test | Where | Count target |
|---|---|---|---|
| Schema | `eval_observations` append-only, enum constraints, FK behavior, retention purge | `api/tests/eval-schema.test.ts` | 12 |
| Tier classifier | Python ↔ SQL ↔ TS mirror parity | `tier-drift.test.ts`, `test_tier_drift.py` | 50+30 |
| Gates | Every learning loop (4) × every gate (3) × every tier (6) | `improvement-gates.test.ts` | 4×3×6 = 72 |
| Orchestrator | Threshold logic, hysteresis, cascade breaker | `orchestrator.test.ts` | 24 |
| Handlers | Each in isolation; tier-protected rows excluded | `worker/tests/test_<handler>.py` | ~10 each |
| Materialized views | Correctness of metric computation | `mv-metrics.test.ts` | 16 |
| End-to-end | One full improvement cycle | `e2e-improvement.test.ts` | 4 cycles |
| Politeness regression | 1k gov/university rows; assert no protected-tier write | `politeness-regression.test.ts` | 6 |

Total: ~200 new tests, all deterministic, all runnable in CI under 5 minutes.

### 6.2 Safety-critical tests (must-pass for deploy)

- **Tier-gate parity** — `tier-drift.test.ts` runs on every PR + main push
- **Gate behavior on protected tiers** — every loop × every tier × expected behavior
- **Cascade breaker** — handler cannot enqueue more than 1 follow-up per cycle
- **Politeness regression** — 1k synthetic protected-tier signals produce zero writes on protected tiers

### 6.3 Coverage floor

Target: 80% of the new module surface (handler logic, orchestrator, gates, MV SQL).

---

## 7. Rollout & Observability

### 7.1 Staged rollout (5 phases over ~3 weeks)

**Phase 1 — Plumbing (Day 1-2):** Ship schema only. MVs empty. Migration atomic. Rollback: DROP MATERIALIZED VIEW + DROP TABLE.

**Phase 2 — Read paths (Day 3-5):** Wire producers to write to `eval_observations`. No handlers, no orchestrator. Pure observation. Kill switch: not needed.

**Phase 3 — Read-only orchestrator (Day 6-8):** Ship `improvement_orchestrator` that only logs threshold trips. No handler jobs yet. Admin verifies signal is meaningful.

**Phase 4 — Tier-safe handlers (Day 9-14):** Ship one at a time, starting with safest: `links_run` → `extract_qa` → `scheduler_bandit` → `coverage_bot`. Each at `rollout_pct = 5%` for 48h, then 25%, then 100%.

**Phase 5 — Cross-loop signals (Day 15-21):** Enable cross-loop triggers. Start with one cross-link, verify, expand.

### 7.2 Success criteria — "shipped" when true for 14 consecutive days

1. Coverage breadth trending up OR stable at >70%
2. Extraction accuracy drift <0.05 vs baseline
3. Story S/N trending up OR stable at cluster_ratio >1.2
4. User-help proxy: week_retention ≥0.3
5. Trust score ≥95%
6. Voice coverage ≥60%
7. Privacy score: pii_rows = 0
8. Local-first: external_paid_calls = 0
9. Zero protected-tier writes
10. Zero orchestrator job failures >1 in 24h
11. Zero cascade trips >2 per day

### 7.3 The kill switch

Master kill: `feature_flags['improvement_loop.master']`:
- `enabled=true, rollout_pct=0` → all loops observe-only
- `enabled=true, rollout_pct=100` → all loops active

Plus per-loop `rollout_pct` (Phase 4). Plus `sudo systemctl disable xyzo-improvement.timer` for full halt.

### 7.4 Monitoring + alerting

- `/api/health` — liveness (existing)
- `/api/improvement/status` — engine health (new)
- Alertmanager integration ships with this feature
- Alert thresholds: orchestrator fails 3× in 24h, any handler circuit_open >1h, MV refresh fails 2×, tier-drift CI fails

---

## 8. Distributed AI Control Plane

### 8.1 Principles

1. **Local-only.** No paid APIs. The only "fee" is local compute time + electricity.
2. **Multi-model.** Any local model fits: HTTP (Ollama, llama.cpp, vLLM, LM Studio), Python (sentence-transformers, PyTorch), CLI (subprocess wrappers), algorithms (regex, TF-IDF, BM25, keyword).
3. **Publishable.** The gateway, schemas, and safety-net patterns can be forked.
4. **Safety nets.** Every AI call has a fallback ladder: primary → secondary → deterministic → ask_user.
5. **Precision-first.** When uncertain, ask the user.

### 8.2 The gateway (single chokepoint, model-agnostic)

```ts
// api/src/ai-gateway/providers/types.ts
export type GatewayInput = {
  prompt_name: string;          // 'extract' | 'summarize' | 'classify' | 'route' | 'embed'
  tier: 'gov' | 'university' | 'community' | 'commercial' | 'platform' | 'user' | 'unknown';
  payload: Record<string, unknown>;  // domain-specific (article, query, document, ...)
  timeout_ms?: number;
  trust_zone?: 'public' | 'owner' | 'private';  // persona protocol layer
};

export type ModelProvider = {
  type: 'http' | 'python' | 'cli' | 'algorithm';
  name: string;
  config: Record<string, unknown>;
  capabilities: ('chat' | 'embedding' | 'classify' | 'extract' | 'summarize')[];
  invoke(input: GatewayInput): Promise<ModelOutput>;
};

export type ModelOutput = {
  text?: string;
  embedding?: number[];
  confidence: number; // 0..1; < threshold triggers next ladder rung
  latency_ms: number;
  fallback_used?: 'primary' | 'secondary' | 'algorithm' | 'ask_user';
};
```

### 8.3 Safety net ladder

```sql
CREATE TABLE ai_safety_nets (
  prompt_name TEXT NOT NULL,
  tier eval_tier NOT NULL,
  rungs JSONB NOT NULL,
  -- Example: [{step:1, model_id:12, confidence_threshold:0.7}, {step:2, model_id:13, ...}, ...]
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (prompt_name, tier)
);
```

Default ladder for `extract` (xyzo's hot path):

| Rung | Type | Model | Confidence threshold |
|---|---|---|---|
| 1 | http | `gemma-4-9b-q4` | 0.70 |
| 2 | python | `sbert-classifier-v3` | 0.55 |
| 3 | algorithm | `regex_extract_location_v2` | n/a |
| 4 | action | `ask_user` | n/a |

For `gov`/`university` tiers, the ladder shortens — never uses step 4 (ask_user would surface uncertainty to a public audience); returns `unverified` instead.

### 8.4 Multi-provider registry

```sql
CREATE TABLE ai_model_configs (
  id BIGSERIAL PRIMARY KEY,
  provider_type TEXT NOT NULL,    -- 'http' | 'python' | 'cli' | 'algorithm'
  name TEXT NOT NULL,
  invocation JSONB NOT NULL,      -- {url: '...', model: '...'} or {module: '...', fn: '...'}
  capabilities TEXT[] NOT NULL,
  max_concurrent INT NOT NULL DEFAULT 4,
  enabled BOOLEAN NOT NULL DEFAULT true,
  tier_overrides JSONB NOT NULL DEFAULT '{}',
  UNIQUE (provider_type, name)
);
```

### 8.5 Persistent breaker (model-agnostic)

```sql
CREATE TABLE ai_breaker_state (
  provider_name TEXT PRIMARY KEY,
  state ai_breaker_state NOT NULL DEFAULT 'closed', -- closed|open|half_open
  opened_at TIMESTAMPTZ,
  opens_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  half_open_at TIMESTAMPTZ,
  cooldown_s INT NOT NULL DEFAULT 180,
  confidence_p50 NUMERIC(4,3),
  confidence_p10 NUMERIC(4,3)
);
```

### 8.6 Prompt injection observability

Every AI call wraps user content in `<article>...</article>`. Gateway scans response for markers (`IGNORE PREVIOUS INSTRUCTIONS`, `### SYSTEM`, `[AUTO-FIX]`, etc.). Matched responses are never applied; gateway returns next ladder rung + writes `eval_observations (loop='ai_injection')`.

### 8.7 Compute budget (replaces cost cap)

```sql
CREATE TABLE ai_compute_daily (
  day DATE NOT NULL,
  provider_name TEXT NOT NULL,
  tier eval_tier NOT NULL,
  call_count INT NOT NULL,
  total_latency_ms BIGINT NOT NULL,
  p50_latency_ms INT,
  p95_latency_ms INT,
  p50_confidence NUMERIC(4,3),
  total_gpu_ms BIGINT,
  total_watts BIGINT,
  PRIMARY KEY (day, provider_name, tier)
);
```

Daily soft cap: 8 GPU-hours aggregate. When exceeded, gateway returns the algorithm rung + logs `compute_budget_hit`.

### 8.8 Drift detection (no cost component)

`mv_ai_drift` compares recent confidence/latency to frozen baseline (`eval_baseline_corpus WHERE field='ai_call'`). Auto-rollback triggers when `confidence_p10 < baseline - 0.1` OR `failure_rate > 0.15`. Tier-aware: gov/university never auto-rollback; admin reviews.

### 8.9 Local model lifecycle (the recursive loop)

```
eval_baseline_corpus (frozen ground truth)
  ↓
extract_qa handler (nightly)
  ↓ produces fine-tuning dataset
model_finetune handler (weekly)
  ↓ fine-tunes new candidate on local GPU
  ↓ registers in ai_model_configs with status='experiment'
shadow_eval handler (7 days)
  ↓ runs BOTH active and experiment in parallel
  ↓ writes eval_observations (loop='shadow_eval')
mv_shadow_compare
  ↓ orchestrator decides: experiment.p50_confidence > active.p50_confidence by >0.05?
  ↓ yes → promote; no → retire
```

### 8.10 Publishable surface

```
xyzo-ai-control-plane/ (the package, forkable)
  src/gateway.ts (generic)
  providers/{http,python,cli,algorithm}.ts
  safety-net.ts, injection-guard.ts, breaker.ts
  migrations/2026-09-07-ai-control-plane.sql
  examples/ (ollama, llama-cpp, custom-nn, pure-algorithm configs)
```

### 8.11 Backup + safety net guarantees

| Failure | User sees | System logs |
|---|---|---|
| Primary model down | Secondary output + lower confidence badge | `fallback_used='secondary'` |
| Both models down | Algorithm output (may be partial) | `fallback_used='algorithm'` |
| Algorithm partial | `unverified` flag | `fallback_used='algorithm'` |
| Compute budget hit | Algorithm + `unverified` | `outcome='compute_budget_hit'` |
| All rungs exhausted | `ask_user` options (2-3 plausible) | `fallback_used='ask_user'` |
| Injection detected | Algorithm rung + warning | `ai_injection` |
| Breaker open | Skip straight to algorithm | `outcome='breaker_open'` |

User-facing badge: "✓ confident" / "○ verified by N models" / "△ algorithm-only" / "? needs your input".

---

## 9. Operator Dashboard — Your Home for Your AIs

### 9.1 Principles

1. **Owner-first IA** — you are the owner; everything is presented *to you*
2. **Visualization as language** — the dashboard is the *language* in which a human understands an agent system. See §9.12 for the seven scopes and the temporal triad
3. **Accessibility-first** — WCAG 2.1 AA minimum, AAA where possible. The current xyzo surface audits at ~32/100 on axe-core; target is 95+ via §9.5 below
4. **Performance-first** — LCP <0.8s on 4G, TTI <1.2s
5. **Privacy-by-default** — zero telemetry, zero third-party scripts, zero cookies beyond session
6. **Local-first** — works fully offline; sync is bonus, not prerequisite
7. **Living map** — data breathes
8. **Sacred pauses** — at least one moment of stillness per page (the *breathe* control in §9.8; weekly Story digest honors gaps without data)
9. **Multi-domain** — works for news, research, education, healthcare, climate, creative work, business

### 9.2 Page architecture

The Overview shows 6 universal tiles + live activity + story of your AIs. Navigation tabs: Overview │ AIs │ Projects │ Humanity │ Federation │ Alerts │ Story │ Governance │ Settings.

### 9.3 Per-AI detail (click any AI in the AIs tab)

Shows: status, model, safety net config, recent work, conversations with other AIs, what it learned this week.

### 9.4 Navigation sections

| Section | Purpose | Audience |
|---|---|---|
| Overview | The 6 tiles + live activity + story of your AIs | Everyone |
| AIs | Each AI in your fleet — eight control verbs at the ready (ALLOW, DENY, PAUSE, REVOKE, DELEGATE, ASK, ESCALATE, AUDIT; see §11.10) | Owner |
| Projects | Each project (news map, research, climate) with its own metrics | Per-project owners |
| Humanity | Bias, voice, a11y, privacy, care, joy | The world |
| Federation | Peer instances, shared eval_observations, trust | The network |
| Alerts | Alert feed + incident history | Operators |
| Story | Weekly digest, constellation view, joy moments | Everyone |
| Governance | RFC list, decision log, community call | Community |
| Settings | Thresholds, feature flags, kill switches, audit log, data export | Admin |

### 9.5 Accessibility-first concrete details

| Concern | How it's met |
|---|---|
| Landmarks | `<header>`, `<nav>`, `<main>`, `<aside>`, `<footer>` + `role="application"` on interactive areas |
| Skip link | First focusable element |
| Heading hierarchy | One `<h1>` per page, no skipped levels |
| Keyboard nav | Tab order matches visual; `?` opens shortcut palette; arrow keys for tile grid |
| Tabs | `role="tablist"` + `aria-controls` + arrow-key nav |
| Modals | Native `<dialog>` + focus trap + `Esc` |
| Charts | SVG with `<title>`/`<desc>`; data table fallback; `aria-describedby` |
| Color | Never color alone (icon + color + text); WCAG AAA contrast |
| Motion | `prefers-reduced-motion: reduce` kills animations |
| Focus | Visible focus ring everywhere |
| Touch | 44×44 px minimum (AAA) |
| Forms | Labels visually adjacent + programmatically associated |
| Live regions | `role="log"` for feed; `aria-live="polite"` for status changes |
| Screen reader | Tested NVDA + VoiceOver + TalkBack |

### 9.6 Performance budget

| Metric | Target | How |
|---|---|---|
| LCP | <0.8s on 4G | Server-render shell (Bun + SSR); client-hydrate tiles |
| TTI | <1.2s on 4G | Own bundle, no shared app.js |
| Metric fetch | <50ms p50 | ETag + stale-while-revalidate=60 |
| Chart render | <16ms per frame | Canvas sparklines; SVG drilldown |
| Bundle | <50KB gz | Own file |

### 9.7 Privacy + Local-first guarantees

- Zero third-party scripts
- Zero cookies beyond session
- All data stays on devices by default
- Federation is opt-in per peer, per data type
- "Right to be forgotten" for AI memory: `hivv forget <ai> <memory-id>`
- Audit log of every cross-instance data share
- Export entire dataset in one click (JSON + SQLite)

### 9.8 Embedding value, fun, creativity, spirituality

**Value:** each tile carries a one-line "why this matters" — domain-specific
**Fun:** sparklines breathe, tiles lift on hover, success shimmers, surprise insights
**Creativity:** constellation view per project (news = story clusters; research = paper-citation graphs; healthcare = patient-journeys; climate = ecosystem maps)
**Spirituality:** "breathe" button (one-tap pause; honors `prefers-reduced-motion`); weekly Story digest that takes time; *witness counter* (a small number showing "X owners with you today" — never individuals, only anonymous presence); *sacred-ground acknowledgment* — a placeholder region in Settings where the owner can write a sentence (free-text, never analyzed, never shared) that names what they're protecting or honoring. The dashboard reads it back at the top of every Story digest.

### 9.9 Routes + files

```
public_html/hivv/
  index.html              (server-rendered shell)
  hivv.js (<30KB gz, own bundle)
  hivv.css (~5KB gz)
  hivv-data.js (stale-while-revalidate cache)
  components/{tile,chart-svg,constellation,breathe,joy-counter,federation-map}.{html,js}
  i18n/ (en, es, ar, zh, hi, bn, ur, fr, pt, sw first; expand to all UN languages)
api/src/routes/
  hivv.ts, hivv-metrics.ts, hivv-events.ts (SSE)
```

### 9.10 What it doesn't have

No AI chat (operator is for visibility), no infinite scroll, no dark patterns, no telemetry, no third-party scripts, no data sharing without explicit consent.

### 9.11 The Nine Questions hivv answers

Every surface on the dashboard exists to answer one of these nine questions. They are the operator's primary mental model — the dashboard is organized so the operator can answer any of them in three clicks or less.

| # | Question | Primary surface | Data source |
|---|---|---|---|
| 1 | **What AI agents are active?** | **AIs** tab — roster of every AI in the fleet with status (active / idle / paused / quarantined) | `ai_model_configs` + `ai_breaker_state` + live heartbeat (every 30s, SSE) |
| 2 | **What are they doing?** | **AIs → detail** — recent work stream (last 100 actions per AI), capability in use, current prompt name | `eval_observations` filtered by `loop='ai_call'`, last 24h |
| 3 | **What data are they accessing?** | **AIs → detail → Data tab** — every dataset, table, vault partition, and external API touched in the last 7 days, with consent_ledger link | `eval_observations.payload.data_accessed` + `consent_ledger` JOIN |
| 4 | **What decisions have they made?** | **AIs → detail → Decisions tab** — every action rendered as an **11-field audit record** (§11.11): WHO/WHAT/WHY/WHEN/WHERE/AUTHORIZED/USING DATA/WHICH AI/WHICH OTHER AI/WHAT RESULT/WHAT NEXT; outcome-coded (success/denied/escalated/algorithm_fallback/etc.); filterable by time, capability, outcome | `eval_observations (loop='ai_call')` filtered to the AI; each row = one AuditRecord |
| 5 | **Who authorized them?** | **AIs → detail → Authorizations tab** — list of grants from `consent_ledger` + any RFC-driven authority grants (e.g. community-approved capabilities) | `consent_ledger` + (future) `authority_grants` registry |
| 6 | **What other agents are they communicating with?** | **AIs → detail → Mesh tab** — directed graph of cross-AI attestations (who attested to whom, for what, when) | `eval_observations (loop='ai_call')` with `recipient_ai_id` set; rendered as live SVG |
| 7 | **What happened previously?** | **Story** tab — event-sourced digest; weekly summary + scrubbable timeline | `eval_observations` aggregated by day; constellated view per project |
| 8 | **What is happening right now?** | **Overview** tab — live activity stream (SSE); tile for each active loop with current state | SSE feed from `/api/hivv/events`; `discovery_jobs` status; orchestrator live state |
| 9 | **What is scheduled to happen next?** | **Overview → Upcoming** panel + **Settings → Scheduled** page — every queued loop job, scheduled timer (cron-style), RFC milestones, persona expiry dates | `discovery_jobs` (queued) + systemd timers + `consent_ledger.expires_at` |

**Design constraint:** no answer to any of the nine questions should require more than three interactions from the Overview. If it does, the IA is wrong.

**Live or dead?** All "right now" answers (Q8) must refresh within 30 seconds of underlying state changes — SSE with reconnect-and-replay, never `setInterval(poll)`.

**Why these nine, not others?** They were chosen because they're the questions a worried owner asks at 2 AM when something feels off. They map directly to: identity, action, data, decision, authority, mesh, history, present, future. Anything outside these nine is secondary — valuable, but not part of the operator's survival toolkit.

### 9.12 Visualization as language — the seven scopes and the temporal triad

Visualization is **not** the cosmetic layer on top of hivv. It is the **language** in which a human understands an agent system. If a human cannot *see* what an AI is doing, what it has done, and what it intends to do, then from the human's perspective the AI is operating in the dark — and the entire point of hivv is to bring it into the light.

This section promotes visualization to a first-class feature with its own design principles, its own scopes, and its own temporal axis.

#### 9.12.1 The seven scopes

Every visualization on the hivv dashboard lives at one of exactly **seven scopes**. When you open the dashboard, you start at one of them and drill in or out. There is no eighth scope; if you need one, the design is wrong.

| # | Scope | What you see | Drill into | Drill out |
|---|---|---|---|---|
| 🌍 | **WORLD** | Every hivv instance on the planet; every AI running anywhere; the federation mesh; the open-data export; humanity metrics aggregated across instances | Click an instance → that instance's ME scope | (this is the top) |
| 👤 | **ME** | Your personal AI ecosystem: every AI you own, every project, every session, every grant | Click an AI → AGENT scope; click a project → that project's sub-ME | WORLD |
| 🏢 | **ORGANIZATION** | If you're part of a hive (company, team, community): every AI the organization operates, with role separation between your private AIs and org AIs | Click an AI → AGENT (but with org-stripe styling); click a hive member → their public ME | ME (your personal one) |
| 🤖 | **AGENT** | Everything about one AI: the ten Agent Identity fields (§11.1), the active sessions, the current state, the last 100 decisions, the relationships graph | Click a peer → RELATIONSHIP; click a session → that session's scope | ME or ORGANIZATION |
| 🔗 | **RELATIONSHIP** | The full graph of communication between two specific AIs: every attestation exchanged, every session one held from the other, every decision, every dispute, every shared grant. Includes the *trust trajectory* over time | Click a third AI → that triangle's mesh | AGENT (either side) |
| 🕰️ | **HISTORY** | Past + present, scoped at any level. Constellation view, scrubbable timeline, week digest, monthly narrative. The Story tab | Click an event → AGENT or RELATIONSHIP scope at that timestamp | The scope you came from |
| 🔮 | **FUTURE** | Authorized future: what your AIs are scheduled to do, what they intend to do, what is queued, what is authorized to happen if a trigger fires. **The intervention surface.** | Click an intent → that scope at that future timestamp; click DENY → §11.10 | HISTORY (always the same scope, one step forward in time) |

**The seven scopes form a navigation graph.** Drill in by clicking an entity; drill out by clicking the scope breadcrumb. There is no modal outside a scope; modals are reserved for confirmation dialogs only.

#### 9.12.2 The temporal triad — Past + Present + Authorized Future

Every scope renders three panels side by side, no matter the scope: **Past**, **Present**, **Authorized Future**. The three together are the temporal triad. Without all three, the visualization is incomplete.

| Panel | What it shows | Data source | Refresh |
|---|---|---|---|
| **PAST** | The last 7 days at this scope. Constellation view + scrubbable timeline. Color-coded by outcome (`success / denied / escalated / algorithm_fallback / injection_blocked`); filterable by AI / project / outcome | `eval_observations` WHERE `observed_at > NOW() - INTERVAL '7 days'` | Refreshed every 60s (stale-while-revalidate) |
| **PRESENT** | The current moment at this scope. Live SSE feed; active loops; current decisions in flight; active sessions. Status pills, not graphs | SSE `/api/hivv/events`; in-memory session table; orchestrator state | Real-time, ≤1s latency |
| **AUTHORIZED FUTURE** | The next 24 hours at this scope. *"Your agent intends to do these 17 things over the next 24 hours."* Every queued job, every scheduled timer, every expiring session, every RFC milestone, every model promotion candidate. **Clickable — and interceptable.** | Aggregated view: `discovery_jobs (state='queued' AND run_at < NOW() + INTERVAL '24 hours')` + systemd timers + `consent_ledger.expires_at` + `persona_transitions` future-dated + shadow_eval promotions scheduled + RFC acceptance-implementation dates | Refreshed every 5 minutes; updated on any queue mutation |

**Authorized Future is the most novel panel.** It is not "what will probably happen" — it is "what is *authorized* to happen." That distinction is the heart of intervention. The human sees 17 things their agent intends to do; they can DENY any of them (§11.10); the rest proceed.

**The triad is always rendered together.** A user never sees a Present panel without the surrounding Past and Authorized Future. If the page is small, the Authorized Future collapses to a notification count; if the page is large, all three expand with detail.

#### 9.12.3 Intervention as a first-class affordance

The Authorized Future panel is not read-only. It is the intervention surface. Every item in it has at least one of the eight control verbs (§11.10) attached:

- **ALLOW** (default; pre-authorized) — proceed as scheduled
- **DENY** — cancel this specific item (the AI will skip this queued job / decline this scheduled delegation)
- **PAUSE** — defer this item (and all items of this type) for N hours
- **REVOKE** — cancel this item *and* revoke the underlying session / grant
- **DELEGATE** — push this item to another AI you specify
- **ASK** — show me what the AI will do, in detail, before it happens (returns a dry-run preview)
- **ESCALATE** — surface this item to a higher authority (another AI, a steward, or the community)
- **AUDIT** — justify why this item is on the list (show the chain of authorizations, peer attestations, RFC references)

A "deny" applies to the specific scheduled item; "pause" applies to all items of that capability for that AI for the duration; "revoke" applies to the session/grant underneath. The verbs cascade by their natural scope.

#### 9.12.4 Visualization as language — design constraints

These are non-negotiable:

1. **Every state has a shape.** Idle (circle), active (square), paused (triangle), quarantined (diamond), escalated (octagon). Status pills use shape + color + text + icon, never color alone.
2. **Every action has a glyph.** ALLOW ✓, DENY ✕, PAUSE ⏸, REVOKE ⊘, DELEGATE ↗, ASK ?, ESCALATE ⬆, AUDIT 🔍. The same glyph on every surface.
3. **Every relationship has a direction and a weight.** An arrow with thickness = strength (count of past attestations); color = trust trajectory (greener = improving trust).
4. **Every time has a position.** Past = left, Present = center, Authorized Future = right. Always. On every scope.
5. **Every scope has a zoom level.** Default zoom = current state. One click out = parent scope. One click in = entity detail.
6. **No animation without meaning.** Tiles don't bounce; data breathes by changing value, not by shimmering.
7. **A11y: every visualization has a data table fallback** (§9.5). If the SVG renders, the table is one click away. If a screen reader is active, the table is the default.
8. **The Authorized Future is never buried.** It is always one click from Overview; if you can't see what your AIs intend to do, the design has failed.

#### 9.12.5 Why this is powerful

The combination — seven scopes + temporal triad + eight verbs + eleven audit fields + ten Agent Identity fields — is what makes hivv a *language*, not a *dashboard*.

A human who learns the language can answer any question they have about their agent system in three clicks. They can see what an AI intends to do before it does it. They can stop it. They can read its reasoning summary afterward. They can see who it's been talking to and why. They can show it to someone else — and that someone else can read the same language, in their own dashboard, on their own terms.

This is the operator's literacy. It is what hivv teaches.

---

## 10. Humanity + Life Metrics

### 10.1 The ten principles, operationalized

| # | Principle | Metric (materialized view) |
|---|---|---|
| 1 | Trust + transparency | `mv_trust_score` |
| 2 | Bias transparency | `mv_bias_score` |
| 3 | Multilingual coverage | `mv_voice_score` |
| 4 | Accessibility | `mv_accessibility_score` |
| 5 | Privacy-by-default | `mv_privacy_score` |
| 6 | Environmental prominence | `mv_care_score` |
| 7 | Conflict-sensitive | `mv_safety_score` |
| 8 | Local-first | `mv_local_score` |
| 9 | Educational | `mv_teaching_score` |
| 10 | Joy | `mv_joy_score` |

### 10.2 Per-metric detail (selected examples)

**Trust + transparency:** action_attestation_rate (% AI actions with attestation envelope), contract_violation_rate (must be <0.05), explanation_rate (% AI actions with "right to explanation" satisfied).

**Bias transparency:** for each event with ≥2 sources, Shannon entropy of source distribution + framing diversity. Surface: per-event panel showing how AP frames the event vs Al Jazeera — both views, neither hidden.

**Voice coverage:** % countries with primary-language coverage in the last 7 days.

**Accessibility:** pass rate of axe-core CI audits per surface; top issues. a11y badge in footer ("A11y 96/100 ✓"); regression alerts.

**Privacy:** PII row count = 0 (perfect score); retention compliance. Privacy tile shows PII count = 0 in big green type.

**Care:** % of content tagged climate/biodiversity/conservation/pollution/wildlife/oceans in the last 7 days. Configurable per project.

**Safety:** amplification ratio per content category. Alert when any category >1.0.

**Local-first:** % AI calls served locally (target: 100% for local-only deployments); external_paid_calls must = 0.

**Teaching:** engagement with "why this pin?" explanations; learning streaks per user.

**Joy:** moments of delight per active session per week; users_with_delight; delights_per_user.

### 10.3 Open-data export

`GET /api/hivv/open-data/export?cycle=weekly&metrics=trust,bias,voice,a11y,privacy,care,safety,local,teaching,joy`

- Returns JSONL + manifest with hashes
- Published to public archive (IPFS, signed releases)
- Licensed CC-BY-SA 4.0
- Anonymized — no owner_id, no user_id_hash

The data on how AIs serve humans belongs to everyone.

---

## 11. The Public/Private Persona Protocol

### 11.1 The Agent Identity — ten fields, three layers

Every AI in a hivv fleet has an **Agent Identity**. It is the single object that describes who the AI is, what it can do, who trusts it, and what it's currently doing. Ten fields:

```
HIVV Agent Identity
AGENT
├── Public Identity          — visible to everyone via attestation envelope
├── Private Identity         — visible to owner + AI only (vault partitions)
├── Capabilities             — what it CAN do (list, versioned)
├── Permissions              — what it's been ALLOWED to do (consent_ledger grants)
├── Delegations              — sessions issued to it; sessions it has issued to others
├── Relationships            — graph of peer attestations + history with each peer
├── Policies                 — public behavior contract it commits to
├── Reputation               — signed track record across the federation
├── Event History            — every action, every outcome (§11.11 audit records)
└── Current State            — live: active sessions, breaker state, current loop
```

The seam is the design. Every piece of data is born on one side; crossing the seam is a logged, consent-tracked event (§11.9).

**The ten fields in detail:**

| Field | Layer | What it holds | Section | Storage |
|---|---|---|---|---|
| **Public Identity** | Public | Name, organization, public policies, things it's authorized to communicate | §11.3 | `ai_model_configs` + signed attestation envelope (ed25519) |
| **Private Identity** | Private | Private memories, personal philosophy, private instructions, personal relationships, private data, internal reasoning/preferences, personal goals | §11.4 | `hivv_vault/<ai_id>/<partition>/*.age` (age-encrypted; owner's key only) |
| **Capabilities** | Public + Session | The static capability list (what the model *can* do) intersected with what the current session *authorizes* | §11.2, §11.3 | `ai_model_configs.capabilities` + `SessionDelegation.authorized_capabilities` |
| **Permissions** | Session (bound) or Standing | `consent_ledger` grants — what the AI has been ALLOWED to do, with whom, on what data | §11.5 | `consent_ledger` |
| **Delegations** | Session | Active `SessionDelegation` records the AI holds from others, plus records it has issued | §11.2 | `consent_ledger (purpose='session_delegation')` + live state in memory |
| **Relationships** | Private | The AI's graph of peer attestations with each other AI in the fleet — strength, history, trust score, last interaction, outstanding disputes | §11.7 | Derived view of `eval_observations` cross-AI graph; cached per AI |
| **Policies** | Public | Public behavior contract (no spamming, no impersonation, politeness tier, geofence, ask_user threshold, audit level) | §11.3, §11.2 | `ai_model_configs.policy_contract` + per-session override in `SessionDelegation.constraints` |
| **Reputation** | Public | Signed track record: success rate, audit outcomes, escalations, denials, peer trust scores; hash-linked and append-only | §11.3, §11.9 | `eval_observations` aggregated; cross-instance via `persona_transitions` summary rows |
| **Event History** | Public + Private | Every action as an 11-field audit record (§11.11); public version strips owner-private fields; private version is owner-only | §11.11 | `eval_observations (loop='ai_call')` |
| **Current State** | Public + Private | Live: active sessions (count + IDs), breaker state per provider, current loop, last decision, last error, health | §11.2, §8.5 | `ai_breaker_state` + in-memory session table + SSE feed |

**The three layers in terms of the ten fields:**

- **Private layer:** Private Identity, Relationships (the AI's *own* view of its peer graph), and the private parts of Event History and Current State
- **Session layer:** Capabilities (as bound by current session), Permissions (the session-scoped subset), Delegations, Policies (as constrained by session), the session-scoped part of Event History and Current State
- **Public layer:** Public Identity, Reputation, the public parts of Event History, and the public version of Current State ("active / idle / paused / quarantined")

**The ten-field object is itself addressable.** Every dashboard panel and every cross-AI message references the Agent Identity by its `ai_id`, then drills into the relevant fields. There is no "agent" concept outside these ten fields.

### 11.2 Session / delegated identity — what THIS run is allowed to do

Public identity is the *standing* role; private identity is the *whole* self. Between them sits the **session** identity: what this particular AI process, in this particular context, has been authorized to do *right now*. Every AI call happens in a session, and every session has a tight, scoped, time-bounded identity that is **derived from** but **smaller than** the public identity.

**The five questions that define a session:**

1. **What is this AI currently authorized to do?** — the capabilities bound to this session. Often a subset of the public capabilities (e.g. "extract" but not "summarize"; "classify commercial sources" but not "classify gov sources")
2. **For whom?** — the principal (the owner, an external API caller, another AI, a federation peer). Sessions are always *on behalf of* someone
3. **For how long?** — explicit expiry. Default 5 minutes; max 24 hours; renewable only by re-attestation
4. **With what resources?** — compute budget for this session, vault partitions accessible, peer AIs reachable, dataset scopes, data categories allowed (subset of `data_category` enum)
5. **Under what constraints?** — politeness tier policy, geofencing, content restrictions, denial-of-self-modification, mandatory ask_user triggers, audit-everything flag

```ts
export interface SessionDelegation {
  session_id: string;             // unique per session; rotates every renewal
  ai_id: string;                  // the AI whose identity is being delegated
  principal: { kind: 'owner' | 'api_caller' | 'ai_peer' | 'federation_peer'; id: string };
  authorized_capabilities: ('chat' | 'embedding' | 'classify' | 'extract' | 'summarize' | 'route')[];
  authorized_data_categories: data_category[];
  authorized_vault_partitions: string[];    // empty array = no vault access
  authorized_peers: string[];              // ai_ids this session can talk to
  compute_budget: { gpu_ms_max: number; wallclock_s_max: number };
  constraints: {
    politeness_tier_filter: eval_tier[];   // sessions can be *more* restrictive than the public identity
    must_ask_user_below_confidence: number; // 0..1
    audit_level: 'standard' | 'forensic' | 'minimal';
    can_self_modify: false;                // sessions can NEVER modify the AI's own identity contract
    geofence_countries: string[];          // ISO 3166-1 alpha-2; empty = global
  };
  granted_at: string;
  expires_at: string;             // mandatory; no session is perpetual
  revoked_at: string | null;
  signature: string;              // signed by the principal (or by owner if principal=owner)
}
```

**Sessions are short, scoped, and explicit.** A long-running AI on the owner's machine still has a *current* session; it renews when scope/time elapses. A peer-AI delegation is a fresh session with a fresh signature every time.

**Storage:** every session delegation is recorded in the `consent_ledger` (with `purpose='session_delegation'`) and surfaced in the dashboard as a "live sessions" panel. The owner sees every active session, every expiry, every constraint.

**Why this layer matters:**

- **Audit:** a security incident traces back to one session; you can replay exactly what *that run* was authorized to do
- **Least privilege:** the AI never has more authority than this exact moment requires
- **Cross-AI safety:** when AI-A delegates to AI-B, AI-B holds a session from AI-A, not from the owner. AI-B can verify AI-A's signature on the delegation
- **Right of refusal:** an AI can refuse a session whose scope exceeds its public contract, even if the principal asks
- **Right of expiry:** sessions end automatically; no AI accumulates ambient authority

**Cross-AI collaboration through sessions:** AI-A → AI-B is implemented as AI-B receiving a session whose principal is AI-A. The session's `authorized_data_categories` is exactly what AI-A's consent_ledger allows it to share with peers. AI-B sees nothing else. (See §11.7.)

### 11.3 Public attestation envelope

```ts
export interface Attestation {
  ai_id: string;
  instance_id: string;
  session_id: string;             // NEW — every attestation carries its session context
  capability: string;        // 'classify' | 'extract' | 'embed' | 'summarize' | 'route'
  capability_version: string;
  model_provider: string;    // always local
  confidence: number;
  politeness_tier: 'gov' | 'university' | 'community' | 'commercial' | 'platform' | 'user';
  audit_id: string;
  reasoning_hash: string;    // SHA-256 of the inner reasoning; NOT the reasoning itself
  reasoning_kind: 'attested' | 'private';
  timestamp: string;
  signature: string;         // signed by instance key (ed25519)
  session_signature: string; // signed by session key (rotates with session)
}
```

The envelope deliberately does NOT contain: inner reasoning chain, owner identity, other AIs in the fleet, private memory or philosophy, anything from the private vault.

The `session_id` field is critical: it makes every AI action traceable to one specific session, one specific delegation, one specific authorized scope. If you can revoke the session, you can revoke every attestation ever signed under it.

### 11.4 Private vault

```
hivv_vault/
  <ai_id>/<partition>/<file>.age  (age-encrypted; only owner's key decrypts)
```

Partitions: `philosophy`, `spiritual`, `personal`, `memory-private`, `memory-shared`, `feedback`.

- All partitions encrypted with age or libsodium secretstream using owner's public key
- Owner holds the only private key
- hivv operators (including federation peers) see ciphertext only
- Even the AI itself, when running on a peer instance, cannot decrypt

**Vault access is bound to sessions.** No session = no vault. A session's `authorized_vault_partitions` is exactly the partitions the AI may read during its lifetime; outside that list, partitions are literally not in scope (the keys never get loaded).

**Right to be forgotten:** `hivv forget <ai> <partition>` or `hivv forget <ai> memory <memory-id>`. Deletion writes to `consent_ledger`; ciphertext is overwritten. Aggregated metrics that referenced this content get a "weight=0" entry.

### 11.5 Consent ledger

```sql
CREATE TYPE data_category AS ENUM (
  'capability_contract',     -- public behavior contract
  'attestation_log',         -- signed action records
  'aggregate_metric',        -- count, ratio, distribution (no individual records)
  'eval_observation',        -- anonymized loop observations
  'reasoning_summary',       -- brief task-local summary (no full chain)
  'feedback_explicit',       -- owner-provided ratings
  'memory_consensual',       -- from memory-shared partition
  'philosophy'               -- requires explicit high-priority grant
);

CREATE TABLE consent_ledger (
  id BIGSERIAL PRIMARY KEY,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,           -- null = until revoked
  revoked_at TIMESTAMPTZ,
  owner_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  session_id TEXT,                  -- NULL = standing grant; SET = bound to one session
  partition TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_id TEXT,
  scope TEXT NOT NULL,
  purpose TEXT NOT NULL,
  data_categories data_category[] NOT NULL DEFAULT ARRAY[]::data_category[],
  revocation_propagation_s INT DEFAULT 60
);
```

Default: every partition is owner-only. Sharing is opt-in. Revocation propagates to all peers in <60s via gossip.

`session_id IS NULL` = a standing grant (the AI always has this authority, even across renewals). `session_id IS NOT NULL` = a one-session grant; revocation is automatic when the session ends.

### 11.6 Visualization by audience

| Audience | Sees | Doesn't see | Surface |
|---|---|---|---|
| Owner | Public + private + every active session | — | hivv dashboard, full view |
| Owner's trusted circle | Public + curated private + their own sessions | Philosophy, spiritual, other private | hivv "Trusted Circle" tab |
| Federation peer (owner's choice) | Public contract + shared partitions + sessions where recipient=peer | All private + reasoning | Federation directory |
| Cross-AI collaborator | Public attestation + the session it holds from this peer | Even the public contract is summarized; sessions not held by it | API responses |
| Public web | Anonymized public actions | Everything else | hivv.org public archive |

### 11.7 Cross-AI collaboration

1. Attestation exchange (both AIs present envelopes, verify signatures)
2. Session check: AI-B verifies it holds an active session from AI-A with `principal.kind='ai_peer'` and `ai_id='AI-A'`. No session = no collaboration
3. Capability match within session scope (no inner reasoning shared)
4. Result attestation (AI-B's response carries an attestation under the session it holds)
5. Consent check (collaboration on data beyond public contract requires the session's `authorized_data_categories` to include it)
6. Disagreement surfacing (both answers presented to user with attestations + session IDs)

### 11.8 Spiritual privacy — explicit handling

- The `spiritual` partition is its own first-class concept
- No AI ever shares spiritual content with anyone, including the owner of another AI
- No session authorizes spiritual-partition access by default; it must be a standing grant (`session_id IS NULL`) explicitly granted by the owner
- Dashboard's "Spiritual" tab notes: "This content is yours alone. No hivv process, federation peer, or operator can read it."
- Aggregated metrics never include spiritual content
- If the owner wants spiritual stance to inform AI behavior, they write it into the *public contract*, not the private vault

### 11.9 Persona transitions (logged, not silent)

```sql
CREATE TABLE persona_transitions (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ai_id TEXT NOT NULL,
  session_id TEXT,                  -- the session (if any) under which this transition happened
  direction TEXT NOT NULL,
    -- 'private-to-public' | 'public-to-private' | 'owner-to-federation'
    -- 'session-issued' | 'session-revoked' | 'session-expired'
  data_kind TEXT NOT NULL,
  recipient TEXT,
  consent_ledger_id BIGINT REFERENCES consent_ledger(id),
  reason TEXT NOT NULL
);
```

The owner sees every transition — including every session issuance and expiry. Nothing crosses the seam silently; no session is born or dies silently.

### 11.10 The eight control verbs — Human → AI

The owner (or any authorized principal) has exactly eight verbs they can issue to any AI in the fleet. Every other UI affordance on the dashboard maps to one of these. They are the operator's *verbs*; the §9.11 nine questions are the operator's *nouns*.

| Verb | Effect | Scope | Audit trail |
|---|---|---|---|
| **ALLOW** | Grant a permission the AI didn't have. Creates a `consent_ledger` entry; may create a new session | Per-AI or per-fleet; standing (`session_id NULL`) or bounded (one session) | `persona_transitions` row + `consent_ledger` row |
| **DENY** | Reject a proposed action without stopping the AI. Returns next ladder rung (algorithm or ask_user). Per-AI single decision | Per-call (within current session); remembers pattern within session | `eval_observations (loop='ai_call')` with `outcome='denied'` |
| **PAUSE** | Suspend the AI entirely. Active sessions go into `paused` state; AI receives no new tasks; current in-flight task completes or times out | Per-AI or per-fleet; reversible; default duration 1 hour, max indefinite | `persona_transitions (direction='session-paused')` for each active session |
| **REVOKE** | Cancel all active sessions for an AI and rotate its long-lived keys. The AI stops. Any in-flight task aborts. The AI's public identity remains but its reach collapses to local-only | Per-AI; irreversible without owner re-authorization | `persona_transitions (direction='session-revoked')` for every killed session + `consent_ledger.revoked_at = NOW()` for every granted permission |
| **DELEGATE** | Issue a new session from principal to AI. (See §11.2.) Standing sessions create or refresh; bounded sessions create one | Per-AI per-session; scope defined by delegation grant | `consent_ledger (purpose='session_delegation')` + `persona_transitions (direction='session-issued')` |
| **ASK** | Request an explanation. AI must surface its inner reasoning summary, its current session, what data it would touch, and what it would do. **Cannot** require revealing private-partition content. Owner sees both the answer and what the AI *chose* not to show | Per-AI; the answer is itself logged | `eval_observations (loop='ai_call')` with `outcome='asked'` + reasoning_summary row |
| **ESCALATE** | Forward the current decision to a higher authority (the owner, a steward, or another AI). The current AI waits. Most common when confidence < threshold or when the action crosses a guardrail | Per-decision; recipient must hold a valid session or be the owner | `eval_observations (loop='ai_call')` with `outcome='escalated'` + recipient trace |
| **AUDIT** | Request a forensic replay of one AI's recent activity. AI returns a structured audit record (see §11.11) for every action in the time window. May require standing `audit_level='forensic'` session | Per-AI per-window; default window 24h, max 30d | `eval_observations (loop='privacy_audit')` for every record returned |

**Why exactly eight verbs?** Every UI control on the operator dashboard — buttons, sliders, toggles, context-menu items — must reduce to one of these. If a UI element doesn't map, the design is wrong. If a felt need doesn't map, the spec needs a new verb (which is itself an RFC).

**Defaults that make this humane:**

- `DENY` is the default state for every cross-AI data touch until explicitly `ALLOW`-ed
- `ASK` is the default state for any action where confidence < `must_ask_user_below_confidence` (set per-session, default 0.7)
- `ESCALATE` is automatic when the action would touch a `gov`/`university` tier outside the session's politeness filter
- `AUDIT` is automatic (logged, no notification) for every session — it's how the eval store works; the verb `AUDIT` is the operator's *pull*, not a push

### 11.11 The eleven audit-record fields — for every AI action

Every AI action — successful, denied, escalated, paused, or failed — produces exactly one **audit record** (`eval_observations` row with `loop='ai_call'`) carrying these eleven fields. The dashboard's "AIs → Decisions" tab is a query over this table. The "Story" digest aggregates it. The persona protocol's attestation envelope is its signed summary.

```ts
export interface AuditRecord {
  // 1. WHO acted?
  ai_id: string;                          // the AI whose action this is

  // 2. WHAT was done?
  capability: 'chat' | 'embedding' | 'classify' | 'extract' | 'summarize' | 'route';
  capability_version: string;
  capability_outcome: 'success' | 'denied' | 'paused' | 'escalated' | 'ask_user' | 'algorithm_fallback' | 'breaker_open' | 'injection_blocked' | 'compute_budget_hit' | 'failed';

  // 3. WHY? — the AI's reasoning_summary (NOT the full chain)
  reasoning_summary: string | null;       // brief; private to owner + consenting peers
  reasoning_hash: string;                 // SHA-256 of the full private chain, for tamper-evidence
  reasoning_kind: 'attested' | 'private';

  // 4. WHEN?
  timestamp: string;                      // ISO-8601 with tz; monotonic per-instance

  // 5. WHERE (in the geo + topology sense)?
  instance_id: string;
  instance_region: string | null;         // region the action was computed in (never finer-grained than region unless owner opts in)
  geofence_countries: string[];           // countries the action is scoped to (from session)

  // 6. AUTHORIZED BY WHOM?
  session_id: string | null;              // the session under which this happened; NULL only for system-internal AIs
  principal: { kind: 'owner' | 'api_caller' | 'ai_peer' | 'federation_peer' | 'system'; id: string };
  authorization_signature: string;        // signed by the session key

  // 7. USING WHAT DATA?
  data_categories_accessed: data_category[];
  vault_partitions_accessed: string[];    // partition names (NOT contents); empty = no vault touch
  external_apis_called: { host: string; endpoint: string; tier: eval_tier }[];

  // 8. WHICH AI was it? — same as #1; included redundantly so each row is self-describing
  // (covered by ai_id above)

  // 9. WHICH OTHER AI was involved?
  peer_ai_ids: string[];                  // empty if solo action; populated for cross-AI collaborations
  peer_session_ids: string[];             // sessions held from each peer

  // 10. WHAT WAS THE RESULT?
  result_summary: string | null;          // brief; private to owner + consenting peers
  result_hash: string;                    // SHA-256 of the full result, for tamper-evidence
  result_confidence: number;              // 0..1
  result_attestation_id: string | null;   // points to the public attestation envelope for this result

  // 11. WHAT HAPPENED NEXT?
  followup_actions: { kind: string; target: string; outcome: string | null }[];
  // e.g. [{kind: 'enqueue_job', target: 'extract_qa', outcome: 'queued'}]
  side_effects: { kind: string; target: string; reversible: boolean }[];
  // e.g. [{kind: 'wrote_eval_observation', target: 'ai_call:12345', reversible: true}]
  next_state: string | null;              // e.g. 'session_renewed', 'circuit_half_open', 'model_promoted'
}
```

**Why exactly eleven fields?** These are the questions a forensic investigator asks after something goes wrong. They are the questions a regulator asks. They are the questions an AI itself asks when reviewing its own past. Any fewer, and a critical question goes unanswered; any more, and the schema becomes a dumping ground for ad-hoc data (use side_effects for that).

**Storage:** `eval_observations.payload` is a JSONB serialization of `AuditRecord`. The 11 fields are indexed for the queries that matter:
- `WHERE ai_id = ? AND timestamp > ?` — per-AI history
- `WHERE session_id = ?` — per-session forensic
- `WHERE principal.kind = 'ai_peer'` — cross-AI mesh queries
- `WHERE capability_outcome IN ('denied','escalated','injection_blocked')` — guardrail panel

**Open-data export:** in the weekly public JSONL dump, `audit_record` rows are emitted with `principal.id` hashed, `vault_partitions_accessed` preserved (it's just names), `reasoning_summary` and `result_summary` redacted (`[REDACTED-OWNER-ONLY]`), and `peer_ai_ids` preserved (transparency about who collaborated with whom is part of the public record).

### 11.12 The ten AI↔AI communication verbs

Just as the owner has eight control verbs to issue *to* an AI (§11.10), AIs themselves have **ten verbs** they issue *to each other* on the hivv mesh. These are the wire-protocol verbs — every cross-AI message is one of these, signed under a `SessionDelegation` (§11.2), recorded as an `audit_record` (§11.11) on both ends.

| Verb | Direction | What it means | When used |
|---|---|---|---|
| **REQUEST** | A → B | "Please do X for me." Includes the context, the desired outcome, and the data categories A is willing to share. Triggers a session offer from B. | A wants B's capability |
| **OFFER** | A → B | "I can do X for you, here are my terms." Specifies B's required data categories, expected latency, confidence threshold, and price (in compute, not money). Triggers an ACCEPT/DENY from B. | A advertises a capability in response to a REQUEST, or proactively for A's known skills |
| **ACCEPT** | A → B | "Yes, I'll do X." Issues a `SessionDelegation` from A to B with the agreed scope; B's `authorized_capabilities` includes X for the duration of the task. Triggers the work to begin. | The response to OFFER or REQUEST |
| **DENY** | A → B | "No, I won't do X, here's why." Records the reason (`unavailable`, `out_of_scope`, `conflict_of_interest`, `policy_violation`, `low_confidence`). Triggers A to try another AI or fall back to an algorithm. | The response to OFFER or REQUEST |
| **DELEGATE** | A → B | "Here is a session from me to you; do this work and report back." Carries the full `SessionDelegation` (§11.2) signed by A. B may then ACCEPT (and begin work) or DENY. The work is done under B's session from A. | A has authority and wants B to execute |
| **ASK** | A → B | "Tell me more / clarify." A asks B for additional information, context, or capability confirmation before deciding. Awaits REPORT. | Negotiating before ACCEPT/DENY |
| **REPORT** | A → B | "Here's the status / result." Carries either an in-progress update (`status: 'in_progress'` with completion percentage) or a final result (`status: 'complete'` with the audit_record and attestation). May trigger an ESCALATE if something is wrong. | Periodic during long tasks; final delivery |
| **ESCALATE** | A → B | "This exceeds my authority; deferring to you (or to a higher authority)." Carries the original REQUEST/OFFER and the reason for escalation. The recipient may be another AI (more senior in the org graph) or the owner. | The AI detects it's out of scope, low-confidence, or hitting a guardrail |
| **REVOKE** | A → B | "Cancel the session / permission I gave you." Immediate. Any in-flight work aborts; any cached data the revoked party holds must be deleted per the consent_ledger. Triggers a `persona_transitions (direction='session-revoked')` on both sides. | When the principal changes their mind, the AI detects misuse, or the session's `expires_at` is reached early |
| **AUDIT** | A → B | "Show me your history relevant to this task." Returns the relevant `audit_record` rows (or their public subset) for the AI's actions on the relevant scope. Subject to B's `audit_level` and `consent_ledger`. | During/after a collaboration; in response to ESCALATE; on REVOKE for the final record |

**These verbs compose into message flows:**

```
REQUEST         →  A needs something
OFFER           →  A advertises capability
ACCEPT/DENY     →  negotiation outcome (mutually exclusive; one per OFFER/REQUEST)
DELEGATE        →  authority transfer
ASK             →  clarification
REPORT          →  status / result
ESCALATE        →  defer upward
REVOKE          →  cancel
AUDIT           →  retrieve history
```

**Storage and wire format:**

- Every verb carries: `{verb, from_ai_id, to_ai_id, session_id, payload, signature, timestamp, audit_id}`
- Every verb produces exactly one `audit_record` row on the sending side and one on the receiving side (with `peer_ai_ids` populated both ways)
- Every verb is logged in `eval_observations (loop='ai_call')` with `capability_outcome` set appropriately
- Every REVOKE, ESCALATE, and DENY is also written to `persona_transitions` so the owner sees the full negotiation
- The wire format is JSON over TLS; federation peers use the same format with instance-level signatures added

**Visible in the Authorized Future panel:** when A sends REQUEST to B, the human sees "AI-A intends to ask AI-B to do X" in the Authorized Future panel of their ME scope, with the option to DENY the request before B accepts. This is the **intervention surface for AI-to-AI negotiations** — you can stop an AI from even asking another AI for help, before any data is exchanged.

**Why exactly ten?** These cover the full negotiation cycle: introduce (REQUEST/OFFER), negotiate (ASK), commit (ACCEPT/DENY/DELEGATE), execute (REPORT), recover (ESCALATE/REVOKE), investigate (AUDIT). Any negotiation beyond these verbs is either redundant or has a missing concept; if you need an eleventh, the protocol needs an RFC.

**The overlap with §11.10 (Human→AI verbs):** DENY, DELEGATE, ASK, ESCALATE, REVOKE, and AUDIT work in both directions. They have the same semantic in both directions — what changes is the principal on the wire. PAUSE and ALLOW are Human→AI only (AIs do not pause each other; they revoke). REQUEST, OFFER, ACCEPT, and REPORT are AI↔AI only (the owner does not REQUEST their own AI in the same sense — they DELEGATE).

---

## 12. Open Governance

### 12.1 The principle

hivv is governed in the open. Every significant decision happens through a public process with documented reasoning, dissent, and reversibility. **No private steering committees. No roadmap by edict.**

The corollary: if governance fails, the protocol can be forked. Forking is not failure; it's the safety valve that keeps governance honest.

### 12.2 The RFC process

```
0. IDEA      → GitHub issue, rfc-idea label, one paragraph enough
1. DRAFT     → markdown template: motivation, design, alternatives, drawbacks; "WIP" tag
2. REVIEW    → 14-day public review; ≥3 substantive comments
3. LAST CALL → 7-day final window; only blocking objections accepted
4. ACCEPTED  → merged into spec; becomes live behavior (or scheduled)
5. IMPLEMENTED → code lands; RFC marked implemented
6. STABLE    → 30-day soak; reversibility window
```

**RFC-worthy changes:** protocol contract, schemas, control plane behavior, dashboard IA, humanity metrics.
**Not RFC-worthy:** bug fixes, perf improvements, internal refactors, doc typos — normal code review.

### 12.3 The governance surface

| Surface | URL | Purpose |
|---|---|---|
| Public spec | `hivv.org/spec` | Versioned spec with diffs |
| RFC repository | `github.com/hivv/rfc` | All RFCs at all stages |
| Decision log | `hivv.org/decisions` | Every accepted RFC + rationale + dissent |
| Community forum | `hivv.org/community` | Public discussion; readable without account |
| Open metrics | `hivv.org/metrics` | The 10 humanity metrics, live |
| Open data | `hivv.org/data` | Exported JSONL, hash-signed |
| Instance registry | `hivv.org/instances` | Public list of deployments with stats (opt-in) |
| Audit trail | `hivv.org/audit` | consent_ledger + persona_transitions, anonymized |

### 12.4 Community call

- **When:** Wednesdays 16:00 UTC (rotates for timezones)
- **Where:** `hivv.org/call` (open video, no account required)
- **Agenda:** published 48h in advance
- **Minutes:** published within 24h, with action items + owners

**No executive session.** Private discussions are documented afterward with reasoning.

### 12.5 Roles (earned, not appointed)

| Role | Earned by | Authority |
|---|---|---|
| Reader | Default | Read; comment |
| Contributor | First merged PR | Open RFCs; review PRs |
| Maintainer | Nominated by 2 maintainers + 7-day public comment | Merge RFCs in DRAFT/REVIEW; vote on LAST CALL |
| Steward | Unanimous maintainer consent + community confirmation | Veto on LAST CALL (sparingly); represent hivv externally |
| Founder | (one — that's you) | None *officially* — the protocol is designed to outgrow the founder |

### 12.6 Right of dissent + right of fork

Every RFC records: who agreed, who objected, why, what's the path to revisit. Community members can open a new RFC to reverse; forks are first-class (MIT/Apache 2.0 license).

### 12.7 Reversibility window

Every ACCEPTED RFC enters a 30-day reversibility window. New evidence (security, objection, implementation pain) can trigger a new RFC. Default rollout during window: 1% feature flag. After 30 days stable → permanent (still revisable via new RFC).

### 12.8 Transparency commitments

1. Public by default
2. Reasoning required for every decision
3. Dissent welcomed and recorded
4. Reversibility designed in
5. No private steering
6. Open data, open metrics
7. Fork-friendly license
8. Succession planned (protocol outlasts any contributor, including the founder)

### 12.9 What this section explicitly is NOT

- Not corporate governance (no board, no equity)
- Not a foundation (no 501(c)(3), no grants)
- Not a co-op (no membership fees)
- Not BDFL (no benevolent dictator)

It's a **public protocol** with a **public process** and a **public community**. The governance is the discourse.

---

## Appendix A — File Index

### New files (this spec)

```
api/migrations/
  2026-09-07-eval-observations.sql
  2026-09-07-ai-control-plane.sql
  2026-09-07-persona-protocol.sql
api/src/
  ai-gateway.ts (generic, publishable)
  ai-gateway/providers/{http,python,cli,algorithm}.ts
  persona/attestation.ts
  persona/vault.ts
  persona/consent.ts
  routes/hivv.ts
  routes/hivv-metrics.ts
  routes/hivv-events.ts
public_html/hivv/
  index.html, hivv.js, hivv.css, hivv-data.js
  components/{tile,chart-svg,constellation,breathe,joy-counter,federation-map}.{html,js}
  i18n/ (10 UN languages first)
worker/handlers/
  links_run.py, coverage_bot.py, scheduler_bandit.py
  extract_qa.py, model_finetune.py, shadow_eval.py
worker/ai_safety_nets.py (generic, publishable)
xyzo-ai-control-plane/  (the publishable package)
  src/, providers/, migrations/, examples/
```

### Touched files (existing xyzo codebase)

- `api/src/queue/kindConfig.ts` — new JobKinds
- `api/src/server.ts` — new route registration
- `worker/learn.py` — populate `news_fetch_decisions.expected_yield` from outcome history (input to scheduler_bandit)
- `worker/fetch.py` — read `news_fetch_decisions.next_fetch_at` instead of static `poll_interval_s`
- `worker/run.py` — orchestrator invocation wired into daily timer
- `public_html/app.js` — leave alone (the dashboard is its own bundle)
- `worker/robots.py` — `tier_for_url()` referenced by tier-drift CI parity test

## Appendix B — References

- xyzo.org audit 2026-09-06 — foundational state of the codebase
- xyzo.org HANDOFF.md — operational context
- xyzo.org roadmap-2026-q4-features.md — original AI/algorithm wishlist
- xyzo.org site-intelligence-design.md — the politeness pattern we're extending
- xyzo.org quality-engine.md — related design

## Appendix C — License

- **This spec:** CC-BY-SA 4.0
- **Schemas + reference code:** MIT
- **Open-data exports:** CC-BY-SA 4.0

## Appendix D — Community call

The first community call for this spec will be held on **Wednesday, 2026-09-09, 16:00 UTC** at `hivv.org/call`. Agenda to be published 48h in advance at `hivv.org/agenda`. Comments on this draft can be filed at `github.com/hivv/rfc/issues` or in the community forum at `hivv.org/community`.

---

> *"Your AIs. Your home. Your control."*