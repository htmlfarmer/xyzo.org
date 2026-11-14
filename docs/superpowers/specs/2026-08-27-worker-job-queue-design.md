# Xyzo — Worker-as-Service Job Queue (Slice A)

**Date:** 2026-08-27
**Status:** Approved (post-brainstorm)
**Author:** Brainstorming session
**Scope:** Foundation refactor. Replaces 7 `spawn("python3", ...)` call sites with a Postgres-backed job queue + in-process Python worker pool. Enables Slices B (autonomous map discovery) and C (auto-linking stories).

## Goal

Today, 7 API routes spawn Python child processes synchronously and block the request thread for up to 75 seconds (worst case: `worker/explore_region.py` via `/api/explore-region`). The other 6 spawn sites — `sources.ts`, `links.ts`, `analytics.ts`, `community.ts`, `auto_categorize.ts`, `feedback.ts` — share the same antipattern with shorter horizons. The Python interpreter pays a 200–500ms startup tax per call, no connection pooling happens across calls, and there is no concurrency control. This makes scaling concurrent discoveries impossible and forecloses on automatic map-driven discovery.

After this slice:

1. The API enqueues work to a Postgres `discovery_jobs` table and returns immediately. The request thread is free in milliseconds, not seconds.
2. A pool of long-running Python worker children consumes jobs from the queue via `SELECT ... FOR UPDATE SKIP LOCKED`. The interpreter startup tax is paid once per worker lifetime, not per call.
3. Callers can choose between **fire-and-forget** (return `{ requestId, statusUrl }`, client polls) and **sync-wait** (helper blocks via Postgres `LISTEN/NOTIFY` until terminal state, with timeout).
4. Status, cancellation, and progress are sourced from a single DB row. The legacy status-file mechanism at `/var/www/vhosts/xyzo.org/logs/discovery-status/` is removed.
5. A feature flag (`USE_JOB_QUEUE`) controls the migration; legacy spawn code stays reachable behind the flag until removed in Phase 5.

## Decisions captured in brainstorming

| Question | Answer |
|---|---|
| Multi-subsystem scope | This slice covers worker-queue only (A). B/C/D/E are separate specs. |
| Routes migrated | All 7 spawn sites: explore, sources, links, analytics, community, auto_categorize, feedback. |
| Worker model | In-process pool managed by the Node API (no new systemd unit). |
| Queue backend | Postgres `SKIP LOCKED` table (no pg-boss, no Redis). |
| Caller patterns | Both sync-wait and fire-and-forget supported; route chooses. |
| Status reporting | DB is single source of truth. Status files removed. |
| AI breaker | Replicated in Python as `worker/ai_client.py` (mirrors `api/src/ai-breaker.ts`). Config shared via `worker/ai_config.json`. |
| Worker dispatch | Single Python dispatcher with lazy per-kind import. |
| Migration | Feature flag `USE_JOB_QUEUE` with legacy fallback path. Per-phase rollout. |
| Per-kind soft caps | On by default; route can override via `enqueueOrSpawn` opts. |
| LISTEN/NOTIFY connections | Dedicated long-lived `pg.Client` pool, separate from regular query pool. |
| Shutdown behavior | Cancel in-flight jobs on API shutdown (do not let them finish). |
| Sweeper reset fields | Keep `started_at` (debugging); clear `worker_id`; null `heartbeat_at`. |

## Architecture

### Components

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Node API (Hono)                         │
│                                                                      │
│  api/src/queue/                                                       │
│    ├── enqueueOrSpawn.ts   // unified entry point, handles flag      │
│    ├── jobQueue.ts         // enqueue / claim / cancel / status     │
│    ├── workerPool.ts       // spawns N py children, IPC, lifecycle   │
│    ├── statusWriter.ts     // batches progress events → DB updates   │
│    ├── ipcProtocol.ts      // JSON-lines codec                      │
│    └── kindConfig.ts       // per-kind soft caps, timeouts, priority │
│                                                                      │
│  api/src/routes/*.ts  ──► enqueueOrSpawn(kind, payload, opts)       │
│                                                                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ enqueue / claim / LISTEN
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  Postgres: discovery_jobs (NEW)                      │
│   id | kind | priority | payload | status | attempts | result | ...  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ SKIP LOCKED claim
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│           Python worker (one of N, long-running)                     │
│                                                                      │
│  worker/dispatcher.py        // stdio JSON-lines, lazy per-kind load │
│    └── handlers/                                                     │
│        ├── explore_region.py                                         │
│        ├── sources_audit.py                                          │
│        ├── links_generate.py                                         │
│        ├── auto_categorize.py                                        │
│        ├── analytics_inline.py                                       │
│        ├── community_triage.py                                       │
│        └── feedback_suggest.py                                       │
│    └── ai_client.py            // python mirror of ai-breaker.ts     │
└──────────────────────────────────────────────────────────────────────┘
```

The 7 existing handler modules stay almost unchanged. Each is repositioned as a callable `run(payload, ctx) -> dict` rather than a script entry point. The CLI invocation (e.g. `python3 -m worker.explore_region …`) remains as a thin wrapper for cron / backfill use.

### Files to create

- `api/schema-job-queue.sql` — `discovery_jobs` table + enums + indexes
- `api/src/queue/enqueueOrSpawn.ts` — unified entry point with flag handling
- `api/src/queue/jobQueue.ts` — low-level enqueue / claim / cancel / status SQL
- `api/src/queue/workerPool.ts` — pool manager, child process lifecycle, IPC
- `api/src/queue/statusWriter.ts` — batched progress event flusher
- `api/src/queue/ipcProtocol.ts` — JSON-lines codec shared with Python
- `api/src/queue/kindConfig.ts` — per-kind config (priority, soft caps, timeouts)
- `api/src/queue/staleClaimSweeper.ts` — runs every 30s
- `api/src/queue/listenClientPool.ts` — dedicated `LISTEN` connections
- `worker/dispatcher.py` — new entry point; stdio JSON-lines loop
- `worker/handlers/explore_region.py` — extracted callable from `worker/explore_region.py`
- `worker/handlers/sources_audit.py` — extracted from `api/src/routes/sources.ts:243,491,558`
- `worker/handlers/links_generate.py` — extracted from `api/src/routes/links.ts:61`
- `worker/handlers/auto_categorize.py` — extracted from `api/src/routes/auto_categorize.ts:215`
- `worker/handlers/analytics_inline.py` — extracted from `api/src/routes/analytics.ts:497,613`
- `worker/handlers/community_triage.py` — extracted from `api/src/routes/community.ts:331,438`
- `worker/handlers/feedback_suggest.py` — extracted from `api/src/routes/feedback.ts:266`
- `worker/ai_client.py` — Python mirror of `api/src/ai-breaker.ts`
- `worker/ai_config.json` — shared breaker config (URL, thresholds, rate limits)
- `api/tests/queue/*` — unit + integration tests for the queue subsystem

### Files to modify

- `api/src/server.ts` — boot sequence: pool start, sweeper start, migration run
- `api/src/routes/explore.ts` — replace spawn with `enqueueOrSpawn`; switch `/api/discovery-status/:id` and `/api/discovery-cancel/:id` to DB-backed
- `api/src/routes/sources.ts` — replace 3 spawn sites
- `api/src/routes/links.ts` — replace 1 spawn site
- `api/src/routes/analytics.ts` — replace 2 spawn sites
- `api/src/routes/community.ts` — replace 2 spawn sites
- `api/src/routes/auto_categorize.ts` — replace 1 spawn site
- `api/src/routes/feedback.ts` — replace 1 spawn site
- `api/src/routes/health.ts` — add queue state to health response
- `worker/explore_region.py` — keep CLI wrapper; delegate to `handlers/explore_region.py`
- `deploy/xyzo-api.service` — ensure `Restart=on-failure` and graceful SIGTERM handling; no new units

### Files NOT touched

- All frontend code. The existing `/api/discovery-status/:id` response shape stays compatible.
- `api/src/ai-breaker.ts` — its logic is mirrored in `worker/ai_client.py`; the Node version keeps serving AI calls made directly by the API (chat, status).
- Any `worker/*.py` file that is NOT a spawn target (e.g. `worker/fetch.py`, `worker/extract.py`).
- The Postgres schema for the rest of the application.

## Data model

### `api/schema-job-queue.sql`

```sql
CREATE TYPE job_kind AS ENUM (
  'explore_region', 'sources_audit', 'links_generate',
  'auto_categorize', 'analytics_inline', 'community_triage', 'feedback_suggest'
);

CREATE TYPE job_status AS ENUM (
  'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'
);

CREATE TABLE discovery_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             job_kind NOT NULL,
  priority         smallint NOT NULL DEFAULT 0,
  payload          jsonb NOT NULL,
  status           job_status NOT NULL DEFAULT 'queued',
  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL DEFAULT 1,
  enqueued_by      text,
  result           jsonb,
  error            text,
  traceback        text,
  worker_id        text,
  heartbeat_at     timestamptz,
  scheduled_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  state            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX discovery_jobs_claim_idx
  ON discovery_jobs (priority DESC, scheduled_at ASC)
  WHERE status = 'queued';

CREATE INDEX discovery_jobs_status_idx
  ON discovery_jobs (status, heartbeat_at)
  WHERE status IN ('claimed', 'running');

CREATE INDEX discovery_jobs_id_status_idx
  ON discovery_jobs (id) INCLUDE (status, result, error);
```

`state` is a single `jsonb` column holding the latest snapshot of the job's progress — overwritten by the status writer on every flush. Replaces the current "status file per job" mechanism. Schema is owned by the handler that emits progress; the explore_region handler's state shape (counters, recent_articles, recent_sources, etc.) is the dominant one because that's the route users actually see. Other handlers can write minimal state (`{ step: 'processing' }`) or none at all.

### Stale-claim sweeper

Runs every 30s in the API process:

```sql
UPDATE discovery_jobs
SET status = 'queued',
    worker_id = NULL,
    heartbeat_at = NULL,
    attempts = attempts + 1,
    started_at = CASE WHEN attempts + 1 >= max_attempts THEN started_at ELSE NULL END
WHERE status IN ('claimed', 'running')
  AND heartbeat_at < now() - INTERVAL '30 seconds'
RETURNING id, attempts;
```

Reset jobs whose `attempts >= max_attempts` to `failed` with `error = 'max attempts exceeded'`.

## IPC protocol

stdio JSON-lines. One JSON object per line in each direction. Newline-delimited; no length prefixes.

### Node → Worker

```jsonc
{ "type": "job",      "id": "<uuid>", "kind": "explore_region", "payload": {...} }
{ "type": "cancel",   "id": "<uuid>" }
{ "type": "heartbeat_check" }
{ "type": "shutdown" }
```

### Worker → Node

```jsonc
{ "type": "ready",     "worker_id": "<slot>" }
{ "type": "started",   "id": "<uuid>", "ts": <epoch> }
{ "type": "progress",  "id": "<uuid>", "ts": ..., "step": "...", "pct": 0.42, "message": "...", "meta": {...} }
{ "type": "log",       "id": "<uuid>", "level": "info|warn|error", "message": "...", "fields": {...} }
{ "type": "complete",  "id": "<uuid>", "ts": ..., "result": {...} }
{ "type": "fail",      "id": "<uuid>", "ts": ..., "error": "...", "traceback": "..." }
{ "type": "cancelled", "id": "<uuid>" }
{ "type": "heartbeat", "id": "<uuid>" }
```

The worker's first stdout line is `ready`. If not received within 10s of spawn, the pool kills that child and respawns.

Anything written to **worker stdout** other than JSON-lines is a bug. The dispatcher redirects any rogue `print()` calls to stderr via `print(..., file=sys.stderr)`.

### Python dispatcher shape

```python
# worker/dispatcher.py
HANDLERS = {
    'explore_region':   ('worker.handlers.explore_region',  'run'),
    'sources_audit':    ('worker.handlers.sources_audit',   'run'),
    'links_generate':   ('worker.handlers.links_generate',  'run'),
    'auto_categorize':  ('worker.handlers.auto_categorize', 'run'),
    'analytics_inline': ('worker.handlers.analytics_inline','run'),
    'community_triage': ('worker.handlers.community_triage','run'),
    'feedback_suggest': ('worker.handlers.feedback_suggest','run'),
}

def main():
    loaded = {}  # kind → callable, lazy import
    for line in sys.stdin:
        msg = json.loads(line)
        if msg['type'] == 'job':
            try:
                mod_path, fn_name = HANDLERS[msg['kind']]
                if msg['kind'] not in loaded:
                    loaded[msg['kind']] = getattr(importlib.import_module(mod_path), fn_name)
                ctx = JobContext(msg['id'], send)
                send({'type': 'started', 'id': msg['id'], 'ts': time.time()})
                result = loaded[msg['kind']](msg['payload'], ctx)
                if ctx.cancelled:
                    send({'type': 'cancelled', 'id': msg['id']})
                else:
                    send({'type': 'complete', 'id': msg['id'], 'ts': time.time(), 'result': result})
            except CancelledError:
                send({'type': 'cancelled', 'id': msg['id']})
            except Exception as e:
                send({'type': 'fail', 'id': msg['id'], 'ts': time.time(),
                      'error': str(e), 'traceback': traceback.format_exc()})
        elif msg['type'] == 'shutdown':
            break

class JobContext:
    def __init__(self, job_id, send):
        self.job_id = job_id
        self.cancelled = False
        self._send = send

    def check_cancel(self):
        if self.cancelled:
            raise CancelledError()

    def progress(self, *, step=None, pct=None, message=None, meta=None):
        self._send({'type': 'progress', 'id': self.job_id,
                    'ts': time.time(), 'step': step, 'pct': pct,
                    'message': message, 'meta': meta or {}})

    def log(self, level, message, **fields):
        self._send({'type': 'log', 'id': self.job_id,
                    'level': level, 'message': message, 'fields': fields})
```

Handlers call `ctx.check_cancel()` at natural pause points (between source batches, between pages, between AI retries). Handlers raise `CancelledError` from `worker/dispatcher.py` to abort cleanly.

### Cancellation flow

1. `POST /api/discovery-cancel/:id` → `UPDATE discovery_jobs SET cancel_requested = true WHERE id = $1 AND status IN ('queued','claimed','running')`
2. Node pool sends `{type: 'cancel', id}` over IPC to the worker currently holding the job (tracked in a `slotId → jobId` map)
3. Worker's `JobContext.cancelled = True`
4. Handler's next `ctx.check_cancel()` raises `CancelledError`
5. Worker emits `{type: 'cancelled'}`; status writer flushes immediately
6. **Hard-kill fallback:** if the handler ignores checkpoints (hung on sync I/O), `heartbeat_check` fires every 5s; after 3 missed heartbeats AND `cancel_requested = true`, pool sends SIGTERM, then SIGKILL after 5s

### Heartbeats

- Worker emits `{type: 'heartbeat', id}` every 2s while a job is running
- `statusWriter.ts` updates `heartbeat_at = now()` on receipt
- Sweeper considers a job stale after 30s of missing heartbeats

## Status reporting

### Batched writer (Node side)

```ts
class StatusWriter {
  private pending = new Map<string, JobStatusUpdate>();
  private flushTimer: NodeJS.Timeout | null = null;

  enqueue(update) {
    // Last-write-wins per job_id for state and heartbeat;
    // progress updates collapse to the latest snapshot.
    const prev = this.pending.get(update.id);
    this.pending.set(update.id, {
      id: update.id,
      state: update.state ?? prev?.state,
      heartbeat: update.heartbeat ?? prev?.heartbeat,
      terminal: update.terminal ?? prev?.terminal,
    });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 250);
    } else if (this.pending.size >= 10) {
      this.flush();
    }
  }

  async flush() {
    if (!this.pending.size) return;
    const updates = [...this.pending.values()];
    this.pending.clear();
    this.flushTimer = null;
    await sql`
      UPDATE discovery_jobs SET
        state = CASE
          WHEN t.id = ANY(${updates.map(u => u.id)}) THEN t.state
          ELSE state
        END,
        heartbeat_at = COALESCE(t.heartbeat, heartbeat_at)
      FROM UNNEST(${updates}::job_update[]) AS t(id text, state jsonb, heartbeat timestamptz)
      WHERE discovery_jobs.id = t.id::uuid
    `;
    const terminalIds = updates.filter(u => u.terminal).map(u => u.id);
    if (terminalIds.length) {
      await pgClient.query(
        `SELECT pg_notify('job_status_changed', $1)`,
        [JSON.stringify({ ids: terminalIds })]
      );
    }
  }
}
```

- **Flush cadence:** every 250ms OR when 10 events queued, whichever first
- **Terminal events (started / complete / fail / cancelled) bypass the timer** — flushed immediately and emit `NOTIFY job_status_changed`
- **Progress events overwrite `state`** — the handler sends a full state snapshot on every `ctx.progress()` call; the writer persists the latest
- **`info`-level logs:** written to worker stderr only, NOT persisted to DB
- **`warn`/`error` logs:** appended to a `last_log` jsonb field for ops visibility

### State ownership and shape

The `state` jsonb is **handler-owned**. Each handler defines its own state shape; the queue infra treats it as opaque. This matters because the frontend's discovery panel has very specific expectations shaped by the legacy status file:

```jsonc
// state shape for explore_region (matches what public_html/app.js:5433-5488 reads)
{
  "current_step":  "geocoding | extracting | fetching | complete | ...",
  "step_detail":   "human-readable string",
  "progress":      0..100,                            // integer percent
  "center":        { "lat": 40.7, "lng": -74.0 },     // bbox centroid
  "elapsed_seconds": 42,
  "counters": {
    "articles_fetched":   176,
    "articles_extracted": 232,
    "articles_geocoded":  345,
    "sources_added":      0,
    "sources_geocoded":   0
  },
  "recent_articles": [
    { "id": 114259, "title": "...", "lat": ..., "lng": ..., "category": "geocoded", "place": "..." }
  ],
  "recent_sources": [
    { "id": 545, "name": "...", "country": "...", "articles_inserted": 0 }
  ]
}
```

Other handlers can write minimal state (`{ step: 'processing', pct: 0 }`) or omit `ctx.progress()` entirely. The status writer does not validate the shape; whatever the handler sends is what gets persisted.

### Status polling endpoint

`GET /api/discovery-status/:id` flattens the queue-level fields with the handler's `state`:

```jsonc
{
  "request_id":      "<uuid>",          // mirrors id for legacy frontend compat
  "kind":            "explore_region",
  "status":          "queued | claimed | running | completed | failed | cancelled",
  "attempts":        0,
  "error":           "..." | null,
  "started_at":      "...",
  "finished_at":     "..." | null,
  "heartbeat_at":    "..." | null,
  "cancel_requested": false,
  // state fields, flattened:
  "current_step":    "geocoding",
  "step_detail":     "...",
  "progress":        42,
  "center":          { "lat": ..., "lng": ... },
  "elapsed_seconds": 12,
  "counters":        { ... },
  "recent_articles": [ ... ],
  "recent_sources":  [ ... ],
  "result":          {...} | null      // present when status === 'completed'
}
```

The response shape is intentionally a superset of what the frontend currently reads (`public_html/app.js:5433, 5438, 5440, 5455, 5472, 5475, 5482, 5492, 5515-5527`). All those fields remain present. `elapsed_seconds` and `progress` are computed server-side from `started_at` and `state.progress` respectively — no frontend changes required.

The `result` field is what `complete` jobs expose for sync-wait callers; for `explore_region` it's a small summary (counts only) since the heavy lifting is the live streaming itself.

## API contract

### `enqueueOrSpawn(kind, payload, opts)`

```ts
interface EnqueueOptions {
  waitMs?: number;       // 0 = fire-and-forget, >0 = sync-wait with timeout
  priority?: number;     // 0 = batch, 10 = viewport / user-initiated
  enqueuedBy?: string;   // route name for ops debugging
  maxAttempts?: number;  // default 1
  useQueue?: boolean;    // override the global flag for this call
}

type EnqueueResult<T> =
  | { kind: 'async'; requestId: string; statusUrl: string; backpressure?: 'queue-full' }
  | { kind: 'sync'; result: T };
```

Behavior:

1. If `useQueue ?? process.env.USE_JOB_QUEUE === 'true'`, go through the queue
2. Else, call `legacySpawn(kind, payload)` — the original spawn code, preserved as a fallback for the entire migration window
3. With `waitMs === 0`, return immediately with `{ requestId, statusUrl }`
4. With `waitMs > 0`, subscribe to `LISTEN job_status_changed`, await a `NOTIFY` for this job OR timeout; read final state from DB; throw on `failed`/`cancelled`/`timeout`

### Per-route mapping

| Route | Kind | Pattern | Default `waitMs` |
|---|---|---|---|
| `POST /api/explore-region` | `explore_region` | async | 0 |
| `POST /api/sources/audit` | `sources_audit` | async | 0 |
| `POST /api/feed/links` | `links_generate` | caller chooses | caller |
| `POST /api/auto-categorize` | `auto_categorize` | sync | 5000 |
| Analytics inline calls | `analytics_inline` | sync | 3000 |
| `POST /api/community/triage` | `community_triage` | async | 0 |
| `POST /api/feedback/suggest` | `feedback_suggest` | sync | 5000 |

### `kindConfig.ts`

```ts
export const KIND_CONFIG: Record<JobKind, {
  defaultPriority: number;
  softCap: { queued: number; running: number };
  defaultMaxAttempts: number;
  defaultTimeoutMs: number;
}> = {
  explore_region:   { defaultPriority: 0, softCap: { queued: 5, running: 2 },  defaultMaxAttempts: 2, defaultTimeoutMs: 75_000 },
  sources_audit:    { defaultPriority: 0, softCap: { queued: 5, running: 2 },  defaultMaxAttempts: 1, defaultTimeoutMs: 120_000 },
  links_generate:   { defaultPriority: 0, softCap: { queued: 10, running: 3 }, defaultMaxAttempts: 2, defaultTimeoutMs: 60_000 },
  auto_categorize:  { defaultPriority: 5, softCap: { queued: 50, running: 4 }, defaultMaxAttempts: 1, defaultTimeoutMs: 5_000 },
  analytics_inline: { defaultPriority: 5, softCap: { queued: 50, running: 4 }, defaultMaxAttempts: 1, defaultTimeoutMs: 3_000 },
  community_triage: { defaultPriority: 0, softCap: { queued: 5, running: 2 },  defaultMaxAttempts: 1, defaultTimeoutMs: 60_000 },
  feedback_suggest: { defaultPriority: 5, softCap: { queued: 20, running: 3 }, defaultMaxAttempts: 1, defaultTimeoutMs: 5_000 },
};
```

When `running` count for a kind is at its cap, `enqueue` returns `backpressure: 'queue-full'`; the caller decides whether to surface that to the user or proceed with the queued job.

## Worker pool lifecycle

### Boot (API startup)

```
1. Logger init
2. Postgres pool + LISTEN client pool init
3. Run pending migrations (idempotent)
4. KIND_CONFIG + enqueueOrSpawn init
5. Stale-claim sweeper start (30s tick)
6. workerPool.start({ size: XYZO_WORKER_POOL_SIZE ?? NEWSIUM_WORKER_POOL_SIZE ?? 4 })
   - spawn N children
   - wait for each "ready" handshake (10s timeout)
7. Mount routes
8. HTTP listener
```

### Pool state machine

```
            start()
              │
              ▼
         ┌─────────┐    child EOF/exit    ┌──────────┐
         │ RUNNING │◀─────────────────────│ RESPAWN  │
         │  (N/M)  │                      │ (≤3/5m)  │
         └────┬────┘                      └────┬─────┘
              │ SIGTERM (api shutdown)          │ 4th crash in 5m
              ▼                                 ▼
         ┌──────────┐                     ┌────────────┐
         │ DRAINING │                     │ DEGRADED   │
         │ no new   │                     │ refuse new │
         │ claims   │                     │ jobs       │
         └────┬─────┘                     └────────────┘
              │ all workers exited
              ▼
          stopped
```

### Graceful shutdown

On SIGTERM:

1. Pool enters `DRAINING`; claim loop exits on next iteration
2. For each in-flight worker: send `{type: 'cancel', id}` to flip its `JobContext.cancelled` flag
3. Wait up to 5s for handlers to raise `CancelledError` and emit terminal events
4. After 5s, send `{type: 'shutdown'}` to each worker
5. Wait up to 25s for clean exit
6. SIGTERM any remaining; SIGKILL after 5s
7. Any job still `running` is left as-is; the next boot's stale-claim sweeper handles it (or marks it `failed` after `attempts >= max_attempts`)

In-flight jobs are **cancelled, not allowed to finish**, on API shutdown. The user-facing trade-off: a discovery in progress when the API restarts loses its place. The operational trade-off: no double-execution, no zombie jobs, no need to reason about partial state.

### Worker crash recovery

```ts
function onWorkerExit(slotId, code, signal) {
  const job = pool.slotToJobId.get(slotId);
  if (job) logger.warn({ worker: slotId, job, code, signal }, 'worker died with in-flight job');

  const sinceBoot = recentRespawnCount(slotId, 5 * 60_000);
  if (state === 'RUNNING' && sinceBoot < 3) {
    respawnCounters.push({ slotId, at: Date.now() });
    setTimeout(() => spawnWorker(slotId), 250 * (sinceBoot + 1));  // exponential backoff
  } else if (sinceBoot >= 3) {
    logger.error({ worker: slotId, sinceBoot }, 'respawn threshold exceeded — degraded');
    setPoolState('DEGRADED');
    // enqueue() rejects with JobQueueUnavailableError
  }
}
```

The crashed job's status is left as `running`. The stale-claim sweeper resets it after 30s of missing heartbeats.

### Health endpoint

`GET /api/health` adds a `queue` object:

```jsonc
{
  "ok": true,
  "queue": {
    "state": "RUNNING",
    "poolSize": 4,
    "activeWorkers": 4,
    "jobsByKind": {
      "queued":  { "explore_region": 1, "auto_categorize": 0, ... },
      "running": { "explore_region": 1, "auto_categorize": 2, ... }
    },
    "recentRespawns": 0,
    "degradedSince": null
  }
}
```

Alert on `state === 'DEGRADED'` or `activeWorkers < poolSize` sustained for > 2 minutes.

### Logging

- Worker **stdout**: pure IPC JSON-lines
- Worker **stderr**: free-form, prefixed with `worker_id` + (when applicable) `job_id`
- One systemd unit, one log stream. Greppable by worker_id.

### Resources

- Each Python worker: ~80MB RSS; 4 workers ≈ 320MB
- All workers on the API host, sharing its outbound network and DB pool
- Workers do NOT touch the GPU; they call `http://192.168.1.3:8888/v1/...` over HTTP through `worker/ai_client.py`

## AI breaker

`worker/ai_client.py` mirrors `api/src/ai-breaker.ts`. Shared config lives in `worker/ai_config.json`:

```jsonc
{
  "base_url": "http://192.168.1.3:8888",
  "model": "gemma-3-27b",
  "rate_limit_per_minute": 60,
  "breaker": {
    "failure_threshold": 5,
    "reset_timeout_ms": 30_000,
    "half_open_max": 1
  },
  "fallback_strategy": "non_ai_classifier"
}
```

Two implementations, one config. Drift risk is real but acceptable for v1. The simplification path: extract the breaker into a small Python package shared with a future sidecar if drift becomes a problem.

The Python worker uses `httpx.AsyncClient` with a connection pool sized to `max_concurrent_jobs`. Critical for `explore_region`'s Nominatim + AI calls.

## Migration plan

### Phases

| Phase | Scope | Flag default |
|---|---|---|
| **P0** | Schema migration, `worker/dispatcher.py`, pool, status writer, sweeper, `enqueueOrSpawn`, all unit + integration tests. Synthetic `test_noop` kind registered only in tests. **No routes migrated.** | `false` |
| **P1** | `explore_region` migrated. Async + polling path. | `false` |
| **P2** | `feedback_suggest`, `auto_categorize`, `analytics_inline` migrated (sync-wait). | `false` |
| **P3** | `sources_audit`, `links_generate`, `community_triage` migrated. | `false` |
| **P4** | Set `USE_JOB_QUEUE` env default to `'true'`. Legacy code now unreachable in production. | `true` |
| **P5** | After 14 clean days per success criteria: remove `USE_JOB_QUEUE` flag, remove `legacySpawn()`. One PR. CI grep guards against accidental reintroduction. | removed |

### Testing strategy per phase

- **P0:** unit (queue CRUD, IPC codec, status writer batching, sweeper); integration (full cycle via `test_noop` kind, cancel during execution, crash recovery, soft caps, LISTEN/NOTIFY); load (200 concurrent `test_noop` enqueues against 4 workers)
- **P1:** E2E with real `/api/explore-region` — assert result is byte-identical to legacy spawn output for the same input. Regression: legacy path stays callable in tests via `?useQueue=false` for side-by-side comparison.
- **P2:** Parity test per route — response body identical regardless of flag. Timeout behavior verified by `waitMs: 100` against a 500ms handler.
- **P3:** Lighter — these routes are 1-line changes. Verify `{ requestId, statusUrl }` and polling still work.
- **P4:** Smoke against staging, watch `/api/health` queue state for 30 min, compare metrics to baseline.

### Rollback

| Trigger | Action |
|---|---|
| Single route breaks in prod | Revert that PR |
| Queue infra breaks globally | Set `USE_JOB_QUEUE=false`, restart API. Seconds. |
| Pool enters DEGRADED | Investigate logs; pool auto-rejects new jobs |
| Migration breaks | Migration is idempotent (`CREATE TYPE/TABLE IF NOT EXISTS`); drop tables if no P1+ has shipped |

### Success criteria for P5

14 consecutive days of:

| Metric | Threshold |
|---|---|
| Per-route error rate (queue vs legacy baseline) | ≤ legacy + 0.1% |
| Per-route P99 latency (queue path) | ≤ legacy × 1.2 |
| Stale-claim sweeper resets per day | < 5 |
| Pool degraded events | 0 |
| Legacy-path calls per day | 0 |
| Discovery job timeouts (75s hit) | < 1% of `explore_region` |

If any threshold slips, P5 is blocked and we dig in.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Worker process crashes | Pool detects stdio EOF | Pool respawns (≤3 in 5min); degraded mode beyond that |
| Worker sends invalid JSON | JSON parse error in pool | Log + kill + respawn (treated as corrupt IPC) |
| Handler raises | worker's `except` catches | Emit `fail`; if `attempts < max_attempts`, requeue with exponential backoff (5s, 30s, 5m) |
| Worker hangs indefinitely | `heartbeat_check` mechanism | SIGTERM at 3 missed checks, SIGKILL at 4 |
| API restarts mid-job | Pool cancels all in-flight jobs | Sweeper + next-boot sweeper cleans residual |
| LISTEN/NOTIFY connection drops | `pg.Client` error event | Reconnect; in-flight sync-waiters get `JobTimeoutError` and retry on caller side |
| Soft cap exceeded | `enqueueOrSpawn` checks before insert | Returns `backpressure: 'queue-full'`; caller decides |
| Postgres unreachable | All queries throw | Pool enters DEGRADED; `/api/health` reports |

## Out of scope (deferred to later specs)

- Per-kind worker pools (one shared pool of 4 today)
- External dispatcher service (currently in-process)
- pgvector / embeddings (Slice C)
- Multi-region queue replication
- Job deduplication (Slice B's responsibility)
- Auto-trigger on map moveend (Slice B)
- Per-kind dynamic priority adjustments based on observed queue depths

## Open questions

- **`worker/immediate_discover.py`**: not yet audited. If it contains another spawn site not on the list of 7, it gets folded into Phase P3. Audit required before P1 starts.
- **The `data/cities_load_report.json` artifact** and other ad-hoc worker scripts: out of scope unless they also call into the 7 routes' patterns.
