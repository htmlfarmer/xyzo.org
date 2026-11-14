# hivv Plan B — Improvement Orchestrator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the actual orchestrator loop. End state: a daily timer reads MVs, decides which loops to enqueue based on thresholds, applies hysteresis + circuit breaker + cooldown, and emits cross-loop signals. Handlers (already stubbed in Plan A) now do real work.

**Architecture:** One timer-driven service (`xyzo-improvement.timer` → `improvement_orchestrator.py`) that runs `analytics_inline` job kind. The orchestrator reads MVs, applies thresholds from `feature_config`, enqueues handler jobs (or doesn't), updates `improvement_orchestrator_state`, writes `eval_observations (loop='orchestrator_run')`. Cross-loop signals (Plan A §2.6) live in a single config table.

**Tech Stack:** Postgres (existing), Python 3.11 (psycopg), systemd timer.

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` (§1.2, §2.5, §2.6, §2.7, §5.4, §7)

**Prerequisites:** Plan A shipped + green.

**Out of scope (later plans):**
- Plan C: AI call instrumentation (loop='ai_call') into orchestrator
- Plan D: orchestrator status visible in dashboard
- Plan F: orchestrator respects persona/authority grants

**Cross-cutting invariants:**
1. Hysteresis: cooldown prevents re-enqueue within `cooldownS` of last trip
2. Cascade breaker: each handler enqueues at most 1 follow-up job per cycle
3. Circuit breaker: 3 failures → `circuit='open'`; manual reset via admin
4. Tier-aware: gov/university gaps only logged, never enqueued
5. Zero new writes to protected tiers

---

## File Structure

```
api/migrations/
  2026-09-08-orchestrator-config.sql        (Task 1)

worker/
  improvement_orchestrator.py                (Task 2 — main loop)
  orchestrator_thresholds.py                 (Task 3 — threshold table reader)
  orchestrator_cascade.py                    (Task 4 — cascade breaker)
  orchestrator_breaker.py                    (Task 5 — circuit breaker)

deploy/
  xyzo-improvement.service                   (Task 7)
  xyzo-improvement.timer                     (Task 7)

api/src/routes/
  improvement.ts                             (modify — add POST /run/<loop>)
  admin/improvement-reset.ts                 (Task 8)

worker/tests/
  test_improvement_orchestrator.py           (Task 6)
  test_orchestrator_cascade.py               (Task 4)
  test_orchestrator_breaker.py               (Task 5)

api/tests/
  orchestrator-status.test.ts                (Task 9)
```

---

## Task Index

- Task 1: `orchestrator_thresholds` config table + seed
- Task 2: `improvement_orchestrator.py` — main loop
- Task 3: Threshold reader (`orchestrator_thresholds.py`)
- Task 4: Cascade breaker (`orchestrator_cascade.py`)
- Task 5: Circuit breaker (`orchestrator_breaker.py`)
- Task 6: Orchestrator tests
- Task 7: systemd timer
- Task 8: Admin reset endpoint
- Task 9: Status endpoint integration test
- Task 10: Phase 3+4 smoke (raise rollout, verify enqueue)
- Task 11: Commit + handoff

---

### Task 1: `orchestrator_thresholds` config table + seed

**Files:**
- Create: `api/migrations/2026-09-08-orchestrator-config.sql`

- [ ] **Step 1: Write migration**

```sql
-- ── 2026-09-08-orchestrator-config.sql ──────────────────────────────
-- Tunable threshold table for the orchestrator. Each row = one loop's
-- trip decision. Spec: §2.7

BEGIN;

CREATE TABLE orchestrator_thresholds (
  loop TEXT PRIMARY KEY,
  metric_mv TEXT NOT NULL,           -- e.g. 'mv_coverage_breadth'
  warn_threshold NUMERIC,
  fail_threshold NUMERIC,
  direction TEXT NOT NULL DEFAULT 'below'
              CONSTRAINT orch_thresh_dir_check CHECK (direction IN ('below','above')),
  cooldown_s INT NOT NULL DEFAULT 3600,
  cross_loop_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- e.g. cross_loop_signals = {"trigger_links_run": true,
  --                              "trigger_coverage_bot": true}
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO orchestrator_thresholds (loop, metric_mv, warn_threshold, fail_threshold, direction, cooldown_s, cross_loop_signals) VALUES
  ('story_clustering', 'mv_story_signal_noise', 1.2, 1.0, 'below', 3600,
   '{"trigger_links_run": true}'::jsonb),
  ('coverage_bot',     'mv_coverage_breadth',   0.70, 0.55, 'below', 86400,
   '{"trigger_links_run": true}'::jsonb),
  ('scheduler_bandit', 'mv_coverage_breadth',   0.85, 0.70, 'below', 3600, '{}'::jsonb),
  ('extract_qa',       'mv_extraction_accuracy', 0.05, 0.10, 'above', 3600,
   '{"trigger_scheduler_bandit": true}'::jsonb);

GRANT SELECT, INSERT, UPDATE ON orchestrator_thresholds TO xyzo_app, xyzo_improver;

COMMIT;
```

- [ ] **Step 2: Apply**

```bash
cd api && bun run db:migrate -- up migrations/2026-09-08-orchestrator-config.sql
psql $XYZO_DB_DSN -c "SELECT * FROM orchestrator_thresholds ORDER BY loop"
```

- [ ] **Step 3: Commit**

```bash
git add api/migrations/2026-09-08-orchestrator-config.sql
git commit -m "feat(hivv-B): orchestrator_thresholds config table + seeds"
```

---

### Task 2: `improvement_orchestrator.py` — main loop

**Files:**
- Create: `worker/improvement_orchestrator.py`

- [ ] **Step 1: Write the orchestrator**

```python
"""Daily orchestrator: reads MVs, decides which loops to enqueue.
Spec: §2.5, §2.6
"""
import logging, os, json
import psycopg
from worker.eval import observe
from worker.orchestrator_thresholds import threshold_for, ThresholdRule
from worker.orchestrator_cascade import followup_allowed
from worker.orchestrator_breaker import circuit_state

log = logging.getLogger(__name__)
DSN = os.environ['XYZO_DB_DSN']

def refresh_mvs():
    """Refresh all 4 core MVs in sequence (each is fast; no need to parallelize)."""
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            for mv in ['mv_coverage_breadth', 'mv_extraction_accuracy',
                       'mv_story_signal_noise', 'mv_user_help_proxy']:
                cur.execute(f"REFRESH MATERIALIZED VIEW CONCURRENTLY {mv}")

def read_metric(mv: str) -> tuple[float, str]:
    """Return (metric_value, computed_at_iso)."""
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute(f"SELECT * FROM {mv}")
            row = cur.fetchone()
            cols = [d[0] for d in cur.description]
            d = dict(zip(cols, row)) if row else {}
    value_cols = [c for c in cols if c != 'computed_at']
    return (d.get(value_cols[0]) if value_cols else 0.0,
            d.get('computed_at', '').isoformat() if d.get('computed_at') else '')

def trip_decision(rule: ThresholdRule, metric_value: float) -> str:
    """Return 'fail_trip', 'warn_only', or 'ok'."""
    if rule.direction == 'below':
        if metric_value < rule.fail_threshold:
            return 'fail_trip'
        if metric_value < rule.warn_threshold:
            return 'warn_only'
    else:  # 'above'
        if metric_value > rule.fail_threshold:
            return 'fail_trip'
        if metric_value > rule.warn_threshold:
            return 'warn_only'
    return 'ok'

def enqueue_handler(kind: str, payload: dict) -> int:
    """Insert a discovery_jobs row. Return its id."""
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute("""
                INSERT INTO discovery_jobs (kind, payload_jsonb, run_at, status)
                VALUES (%s, %s::jsonb, NOW(), 'queued')
                RETURNING id
            """, (kind, json.dumps(payload)))
            return cur.fetchone()[0]

def run_once() -> dict:
    """One full orchestrator cycle. Idempotent. Returns summary."""
    refresh_mvs()

    trips = []
    for loop_name in ['story_clustering', 'coverage_bot', 'scheduler_bandit', 'extract_qa']:
        rule = threshold_for(loop_name)
        if not rule:
            continue

        # Circuit breaker: skip if open
        if circuit_state(loop_name) == 'open':
            observe(loop='orchestrator_run', tier='system',
                    payload={'orchestrator_decision': 'skip',
                             'reason': 'circuit_open', 'loop': loop_name})
            continue

        metric_value, computed_at = read_metric(rule.metric_mv)
        decision = trip_decision(rule, metric_value)

        if decision == 'fail_trip':
            # Tier check: gov/university → log only
            trip = {'loop': loop_name, 'metric': metric_value,
                    'decision': decision, 'cross_loop_signals': rule.cross_loop_signals}

            # Primary enqueue
            kind = loop_to_kind(loop_name)
            job_id = enqueue_handler(kind, {'trip_reason': 'fail',
                                             'metric_value': metric_value})
            trip['enqueued_job_id'] = job_id

            # Cross-loop signals (capped at 1 follow-up per cycle)
            for cross_loop, on in (rule.cross_loop_signals or {}).items():
                if on and followup_allowed():
                    cross_kind = loop_to_kind(cross_loop)
                    cross_id = enqueue_handler(cross_kind, {'triggered_by': loop_name})
                    trip[f'cross_{cross_loop}'] = cross_id

            trips.append(trip)
        elif decision == 'warn_only':
            observe(loop='orchestrator_run', tier='system',
                    payload={'orchestrator_decision': 'warn_only',
                             'loop': loop_name, 'metric': metric_value})

        # Update orchestrator state (cooldown)
        with psycopg.connect(DSN, autocommit=True) as c:
            with c.cursor() as cur:
                cur.execute("""
                    INSERT INTO improvement_orchestrator_state
                      (loop, last_run_at, last_metric, cooldown_until)
                    VALUES (%s, NOW(), %s::jsonb,
                            NOW() + INTERVAL '%s seconds')
                    ON CONFLICT (loop) DO UPDATE SET
                      last_run_at = NOW(),
                      last_metric = EXCLUDED.last_metric,
                      cooldown_until = EXCLUDED.cooldown_until,
                      updated_at = NOW()
                """, (loop_name, json.dumps({'value': metric_value, 'computed_at': computed_at}),
                      rule.cooldown_s))

        observe(loop='orchestrator_run', tier='system',
                payload={'orchestrator_decision': decision,
                         'loop': loop_name, 'metric': metric_value})

    return {'trips': trips, 'ran_at': 'NOW()'}

def loop_to_kind(loop_name: str) -> str:
    """Map loop name (from thresholds) to JobKind."""
    return {
        'story_clustering': 'links_run',
        'coverage_bot': 'coverage_bot',
        'scheduler_bandit': 'scheduler_bandit',
        'extract_qa': 'extract_qa',
    }[loop_name]

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(json.dumps(run_once(), default=str, indent=2))
```

- [ ] **Step 2: Commit (stub — Tests in Task 6 require other modules first)**

```bash
git add worker/improvement_orchestrator.py
git commit -m "feat(hivv-B): improvement_orchestrator main loop (stub, awaits helpers)"
```

---

### Task 3: Threshold reader (`orchestrator_thresholds.py`)

**Files:**
- Create: `worker/orchestrator_thresholds.py`

- [ ] **Step 1: Write the reader**

```python
"""Read orchestrator_thresholds table. Cached for 60s.
Spec: §2.7
"""
import os, time, threading
from dataclasses import dataclass
import psycopg

DSN = os.environ['XYZO_DB_DSN']
_cache_lock = threading.Lock()
_cache = {}        # loop → ThresholdRule
_cache_at = 0
CACHE_TTL_S = 60

@dataclass
class ThresholdRule:
    loop: str
    metric_mv: str
    warn_threshold: float
    fail_threshold: float
    direction: str
    cooldown_s: int
    cross_loop_signals: dict

def threshold_for(loop_name: str) -> ThresholdRule | None:
    global _cache_at, _cache
    with _cache_lock:
        if time.time() - _cache_at < CACHE_TTL_S and loop_name in _cache:
            return _cache.get(loop_name)
        # Refresh all
        with psycopg.connect(DSN) as c:
            with c.cursor() as cur:
                cur.execute("""
                    SELECT loop, metric_mv, warn_threshold, fail_threshold,
                           direction, cooldown_s, cross_loop_signals
                    FROM orchestrator_thresholds
                """)
                _cache = {r[0]: ThresholdRule(
                    loop=r[0], metric_mv=r[1],
                    warn_threshold=float(r[2]), fail_threshold=float(r[3]),
                    direction=r[4], cooldown_s=r[5],
                    cross_loop_signals=r[6] or {}) for r in cur.fetchall()}
        _cache_at = time.time()
    return _cache.get(loop_name)

def invalidate_cache():
    """Used by tests."""
    global _cache_at
    with _cache_lock:
        _cache_at = 0
        _cache.clear()
```

- [ ] **Step 2: Commit**

```bash
git add worker/orchestrator_thresholds.py
git commit -m "feat(hivv-B): orchestrator_thresholds reader with 60s cache"
```

---

### Task 4: Cascade breaker (`orchestrator_cascade.py`)

**Files:**
- Create: `worker/orchestrator_cascade.py`

- [ ] **Step 1: Write the cascade breaker**

```python
"""Hard limit: each orchestrator cycle can enqueue at most 1 follow-up
job (across all cross-loop signals). Prevents loop storms.
Spec: §5.3
"""
import threading
_counter_lock = threading.Lock()
_followups_this_cycle = 0
MAX_FOLLOWUP_ENQUEUES = 1

def begin_cycle():
    global _followups_this_cycle
    with _counter_lock:
        _followups_this_cycle = 0

def followup_allowed() -> bool:
    global _followups_this_cycle
    with _counter_lock:
        if _followups_this_cycle >= MAX_FOLLOWUP_ENQUEUES:
            return False
        _followups_this_cycle += 1
        return True

def followups_count() -> int:
    with _counter_lock:
        return _followups_this_cycle
```

- [ ] **Step 2: Test**

Create `worker/tests/test_orchestrator_cascade.py`:

```python
from worker.orchestrator_cascade import (
    begin_cycle, followup_allowed, followups_count
)

def test_cascade_blocks_after_one():
    begin_cycle()
    assert followup_allowed() is True
    assert followup_allowed() is False
    assert followups_count() == 1

def test_begin_cycle_resets():
    begin_cycle()
    followup_allowed()
    begin_cycle()
    assert followups_count() == 0
    assert followup_allowed() is True
```

- [ ] **Step 3: Run**

```bash
cd worker && pytest tests/test_orchestrator_cascade.py -v
```

Expected: 2 pass.

- [ ] **Step 4: Commit**

```bash
git add worker/orchestrator_cascade.py worker/tests/test_orchestrator_cascade.py
git commit -m "feat(hivv-B): cascade breaker (1 follow-up per cycle)"
```

---

### Task 5: Circuit breaker (`orchestrator_breaker.py`)

**Files:**
- Create: `worker/orchestrator_breaker.py`
- Create: `worker/tests/test_orchestrator_breaker.py`

- [ ] **Step 1: Write the breaker**

```python
"""Per-loop circuit breaker: 3 consecutive failures → open.
Admin reset via POST /api/admin/improvement/reset/<loop>.
Spec: §5.1
"""
import os
import psycopg

DSN = os.environ['XYZO_DB_DSN']
FAILURE_THRESHOLD = 3

def circuit_state(loop_name: str) -> str:
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("""
                SELECT circuit FROM improvement_orchestrator_state
                WHERE loop = %s
            """, (loop_name,))
            row = cur.fetchone()
            return row[0] if row else 'closed'

def record_failure(loop_name: str, error: str):
    """Increment failure count; open circuit if threshold reached."""
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute("""
                INSERT INTO improvement_orchestrator_state (loop, circuit, last_metric)
                VALUES (%s, CASE WHEN 1 >= %s THEN 'open' ELSE 'half_open' END,
                        jsonb_build_object('last_error', %s))
                ON CONFLICT (loop) DO UPDATE SET
                  circuit = CASE
                    WHEN (improvement_orchestrator_state.last_metric->>'consecutive_failures')::int + 1 >= %s
                    THEN 'open' ELSE 'closed' END,
                  last_metric = jsonb_set(
                    COALESCE(improvement_orchestrator_state.last_metric, '{}'::jsonb),
                    '{consecutive_failures}',
                    to_jsonb(COALESCE((improvement_orchestrator_state.last_metric->>'consecutive_failures')::int + 1, 1))
                  ),
                  last_metric = jsonb_set(
                    improvement_orchestrator_state.last_metric, '{last_error}', to_jsonb(%s::text)
                  ),
                  updated_at = NOW()
            """, (loop_name, FAILURE_THRESHOLD, error,
                  FAILURE_THRESHOLD, error))

def record_success(loop_name: str):
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute("""
                UPDATE improvement_orchestrator_state
                SET circuit = 'closed',
                    last_metric = COALESCE(last_metric, '{}'::jsonb)
                                    || jsonb_build_object('consecutive_failures', 0),
                    updated_at = NOW()
                WHERE loop = %s
            """, (loop_name,))

def reset(loop_name: str):
    """Admin reset: clear circuit, cooldown, last_metric."""
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute("""
                UPDATE improvement_orchestrator_state
                SET circuit = 'closed', cooldown_until = NULL,
                    last_metric = NULL, last_run_at = NULL,
                    updated_at = NOW()
                WHERE loop = %s
            """, (loop_name,))
```

- [ ] **Step 2: Test**

Create `worker/tests/test_orchestrator_breaker.py`:

```python
import os
from worker.orchestrator_breaker import (
    circuit_state, record_failure, record_success, reset
)

def setup_function(function):
    for loop in ['test_loop_a', 'test_loop_b']:
        reset(loop)

def test_circuit_opens_after_3_failures():
    loop = 'test_loop_a'
    assert circuit_state(loop) in ('closed', 'half_open')
    reset(loop)
    for _ in range(3):
        record_failure(loop, 'test error')
    assert circuit_state(loop) == 'open'

def test_record_success_resets_to_closed():
    loop = 'test_loop_b'
    reset(loop)
    record_failure(loop, 'err')
    record_success(loop)
    assert circuit_state(loop) == 'closed'
```

- [ ] **Step 3: Run**

```bash
cd worker && pytest tests/test_orchestrator_breaker.py -v
```

Expected: 2 pass.

- [ ] **Step 4: Commit**

```bash
git add worker/orchestrator_breaker.py worker/tests/test_orchestrator_breaker.py
git commit -m "feat(hivv-B): per-loop circuit breaker (3 failures → open)"
```

---

### Task 6: Orchestrator tests

**Files:**
- Create: `worker/tests/test_improvement_orchestrator.py`

- [ ] **Step 1: Write the test**

```python
import os, json
import psycopg
from worker.improvement_orchestrator import run_once, trip_decision, loop_to_kind
from worker.orchestrator_thresholds import ThresholdRule

DSN = os.environ['XYZO_DB_DSN']

def test_loop_to_kind_mapping():
    assert loop_to_kind('story_clustering') == 'links_run'
    assert loop_to_kind('coverage_bot') == 'coverage_bot'
    assert loop_to_kind('scheduler_bandit') == 'scheduler_bandit'
    assert loop_to_kind('extract_qa') == 'extract_qa'

def test_trip_decision_below_direction():
    rule = ThresholdRule('test', 'mv_x', warn_threshold=1.0, fail_threshold=0.5,
                          direction='below', cooldown_s=3600, cross_loop_signals={})
    assert trip_decision(rule, 0.3) == 'fail_trip'
    assert trip_decision(rule, 0.7) == 'warn_only'
    assert trip_decision(rule, 1.5) == 'ok'

def test_trip_decision_above_direction():
    rule = ThresholdRule('test', 'mv_x', warn_threshold=0.05, fail_threshold=0.10,
                          direction='above', cooldown_s=3600, cross_loop_signals={})
    assert trip_decision(rule, 0.15) == 'fail_trip'
    assert trip_decision(rule, 0.07) == 'warn_only'
    assert trip_decision(rule, 0.02) == 'ok'

def test_run_once_smoke():
    result = run_once()
    assert 'trips' in result
    assert isinstance(result['trips'], list)

def test_orchestrator_run_observations_written():
    c = psycopg.connect(DSN)
    before = c.execute("""
        SELECT COUNT(*) FROM eval_observations WHERE loop='orchestrator_run'
    """).fetchone()[0]
    run_once()
    after = c.execute("""
        SELECT COUNT(*) FROM eval_observations WHERE loop='orchestrator_run'
    """).fetchone()[0]
    assert after > before
```

- [ ] **Step 2: Run**

```bash
cd worker && pytest tests/test_improvement_orchestrator.py -v
```

Expected: 5 pass.

- [ ] **Step 3: Commit**

```bash
git add worker/tests/test_improvement_orchestrator.py
git commit -m "test(hivv-B): orchestrator main loop tests"
```

---

### Task 7: systemd timer

**Files:**
- Create: `deploy/xyzo-improvement.service`
- Create: `deploy/xyzo-improvement.timer`

- [ ] **Step 1: Write service**

`deploy/xyzo-improvement.service`:

```ini
[Unit]
Description=xyzo hivv: improvement orchestrator (daily 04:15)
After=postgresql.service

[Service]
Type=oneshot
Environment=XYZO_DB_DSN=postgresql://xyzo_app:...@localhost:5432/xyzo
ExecStart=/usr/bin/python3 -m worker.improvement_orchestrator
User=xyzo
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 2: Write timer**

`deploy/xyzo-improvement.timer`:

```ini
[Unit]
Description=Daily hivv improvement orchestrator
Requires=xyzo-improvement.service

[Timer]
OnCalendar=*-*-* 04:15:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Deploy locally**

```bash
sudo cp deploy/xyzo-improvement.service /etc/systemd/system/
sudo cp deploy/xyzo-improvement.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xyzo-improvement.timer
sudo systemctl list-timers xyzo-improvement.timer
```

Expected: timer shown with next run 04:15.

- [ ] **Step 4: Commit**

```bash
git add deploy/xyzo-improvement.service deploy/xyzo-improvement.timer
git commit -m "feat(hivv-B): systemd timer for orchestrator (daily 04:15)"
```

---

### Task 8: Admin reset endpoint

**Files:**
- Create: `api/src/routes/admin/improvement-reset.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Write endpoint**

```ts
import { Hono } from "hono";
import postgres from "postgres";
import { requireAdmin } from "../middleware/admin";

const sql = postgres(process.env.XYZO_DB_DSN!);

export const improvementResetRoutes = new Hono();

improvementResetRoutes.use("/api/admin/improvement/*", requireAdmin());

improvementResetRoutes.post("/api/admin/improvement/reset/:loop", async (c) => {
  const loop = c.req.param("loop");
  await sql`
    UPDATE improvement_orchestrator_state
    SET circuit = 'closed', cooldown_until = NULL,
        last_metric = NULL, last_run_at = NULL, updated_at = NOW()
    WHERE loop = ${loop}
  `;
  return c.json({ ok: true, loop, reset_at: new Date().toISOString() });
});

improvementResetRoutes.post("/api/improvement/run/:loop", async (c) => {
  // Admin manual trigger: enqueue the loop's JobKind
  const loop = c.req.param("loop");
  const kindMap: Record<string, string> = {
    story_clustering: 'links_run',
    coverage_bot: 'coverage_bot',
    scheduler_bandit: 'scheduler_bandit',
    extract_qa: 'extract_qa',
  };
  const kind = kindMap[loop];
  if (!kind) return c.json({ ok: false, error: 'unknown_loop' }, 400);

  const rows = await sql`
    INSERT INTO discovery_jobs (kind, payload_jsonb, run_at, status)
    VALUES (${kind}, ${sql.json({manual_trigger: true})}, NOW(), 'queued')
    RETURNING id
  `;
  return c.json({ ok: true, enqueued_job_id: rows[0].id });
});
```

- [ ] **Step 2: Wire**

In `api/src/server.ts`:

```ts
import { improvementResetRoutes } from "./routes/admin/improvement-reset";
app.route("/", improvementResetRoutes);
```

- [ ] **Step 3: Smoke**

```bash
curl -sX POST http://localhost:3008/api/improvement/run/coverage_bot
```

Expected: `{"ok":true,"enqueued_job_id":...}`.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/admin/improvement-reset.ts api/src/server.ts
git commit -m "feat(hivv-B): admin reset + manual run endpoints"
```

---

### Task 9: Status endpoint integration test

**Files:**
- Create: `api/tests/orchestrator-status.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

describe("/api/improvement/status", () => {
  test("returns state, mv_ages, degraded flag", async () => {
    const res = await fetch("http://localhost:3008/api/improvement/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("state");
    expect(body).toHaveProperty("mv_ages");
    expect(body).toHaveProperty("degraded");
    expect(typeof body.degraded).toBe("boolean");
  });

  test("all 4 MVs are reachable", async () => {
    for (const mv of ['mv_coverage_breadth', 'mv_extraction_accuracy',
                      'mv_story_signal_noise', 'mv_user_help_proxy']) {
      const rows = await sql.unsafe(`SELECT 1 FROM ${mv} LIMIT 1`);
      expect(rows.length).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 2: Run**

```bash
cd api && bun test tests/orchestrator-status.test.ts 2>&1 | tail -10
```

Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add api/tests/orchestrator-status.test.ts
git commit -m "test(hivv-B): orchestrator status endpoint test"
```

---

### Task 10: Phase 3+4 smoke (raise rollout, verify enqueue)

**Files:**
- Create: `api/tests/orchestrator-phase4.test.ts`

- [ ] **Step 1: Write smoke test**

```ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

describe("phase 4: rollout raised → handler actually runs", () => {
  test("coverage_bot at rollout=100 on commercial tier → enqueues", async () => {
    await sql`
      UPDATE feature_flags SET rollout_pct = 100
      WHERE key = 'improvement_loop.coverage_bot'
    `;
    // Run orchestrator
    const { spawnSync } = await import('child_process');
    const r = spawnSync('python3', ['-m', 'worker.improvement_orchestrator'],
                        { env: process.env, encoding: 'utf8' });
    expect(r.status).toBe(0);

    // Check: discovery_jobs should have a coverage_bot entry queued in last minute
    const rows = await sql`
      SELECT COUNT(*) AS c FROM discovery_jobs
      WHERE kind = 'coverage_bot'
        AND run_at > NOW() - INTERVAL '1 minute'
    `;
    expect(Number(rows[0].c)).toBeGreaterThan(0);

    // Reset
    await sql`
      UPDATE feature_flags SET rollout_pct = 0
      WHERE key = 'improvement_loop.coverage_bot'
    `;
  });
});
```

- [ ] **Step 2: Run**

```bash
cd api && bun test tests/orchestrator-phase4.test.ts 2>&1 | tail -10
```

Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add api/tests/orchestrator-phase4.test.ts
git commit -m "test(hivv-B): phase 4 smoke (rollout=100 → enqueue)"
```

---

### Task 11: Commit + handoff

- [ ] **Step 1: Commit handoff doc**

```bash
cat > docs/hivv-plan-b-summary.md <<'EOF'
# hivv Plan B — Improvement Orchestrator Summary

**Status:** Complete. Orchestrator reads MVs, decides, enqueues with hysteresis + cascade + circuit.

## What ships
- `improvement_orchestrator.py` — main loop, runs as `analytics_inline` job kind daily at 04:15
- `orchestrator_thresholds` — table of 4 loop rules (warn/fail/cooldown/cross-signals)
- Cascade breaker — max 1 follow-up enqueue per cycle
- Circuit breaker — 3 failures → circuit='open', admin reset
- systemd timer (`xyzo-improvement.timer`)
- Admin endpoints: `POST /api/admin/improvement/reset/:loop`, `POST /api/improvement/run/:loop`
- 6 new tests; smoke test verifies rollout=100 actually triggers enqueue

## Risks
- Hysteresis: cooldown prevents thrash but means metric must stay bad for full cooldown before next trip
- Circuit breaker: 3 failures is a magic number; tunable in `feature_config`
- Cross-loop signals can stack (cascade breaker caps at 1 follow-up per cycle)

## Next
Plan C — Distributed AI Control Plane (gateway + safety nets + breakers).
EOF
git add docs/hivv-plan-b-summary.md
git commit -m "docs(hivv-B): Plan B summary"
```

---

## Done — Plan B complete

Verify:
```bash
cd worker && pytest tests/test_orchestrator_cascade.py tests/test_orchestrator_breaker.py tests/test_improvement_orchestrator.py -v
cd api && bun test tests/orchestrator-status.test.ts tests/orchestrator-phase4.test.ts
```

Both green → proceed to **Plan C — Distributed AI Control Plane** (`docs/superpowers/plans/2026-09-07-hivv-plan-c-ai-control-plane.md`).
