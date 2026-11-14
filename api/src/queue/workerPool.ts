// api/src/queue/workerPool.ts
//
// Pool manager that spawns Python `worker.dispatcher` subprocesses, fans
// out jobs from discovery_jobs to free slots over stdin/stdout JSON-lines,
// and translates worker events back into PostgreSQL state updates via the
// shared statusWriter (batched progress + immediate terminal + NOTIFY).
//
// Lifecycle:
//
//   startWorkerPool()
//     → for each slot: spawnChild()
//     → await waitForReady() for every slot (10s budget per child)
//     → state = RUNNING, startSweeper(), claimLoop() on setImmediate
//
//   child stdout 'ready'   → slot.ready = true; slot.readySince = now
//   child stdout progress  → statusWriter.enqueue({ state, heartbeat })
//   child stdout terminal  → statusWriter.enqueueTerminal(...); free slot
//   child exits unexpectedly → onChildExit(): per-slot respawn count
//                              resets after READY_GRACE_MS of continuous
//                              ready state. If respawnCount reaches
//                              RESPAWN_MAX, pool → DEGRADED.
//
//   stopWorkerPool()
//     → state = DRAINING, stopSweeper()
//     → send 'shutdown' to every ready child
//     → wait up to maxWaitMs for clean exit; SIGTERM stragglers; SIGKILL
//
// DB import note: this codebase exports `getDb()` from `../db`; the plan's
// `import { sql } from '../db'` is incorrect for this codebase — we use the
// `getDb()` pattern that every other queue module already follows.

import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  IpcParser,
  encode,
  type WorkerToNode,
  type NodeToWorker,
} from './ipcProtocol';
import {
  claimNext,
  markStarted,
  markCancelled,
  requestCancel,
  listInFlight,
} from './jobQueue';
import { statusWriter } from './statusWriter';
import { type JobKind } from './kindConfig';
import { startSweeper, stopSweeper } from './staleClaimSweeper';

const ROOT = path.resolve(__dirname, '../../../');
const PYTHON = process.env.NEWSIUM_PYTHON ?? 'python3';
const POOL_SIZE = Number(process.env.NEWSIUM_WORKER_POOL_SIZE ?? 4);
const READY_TIMEOUT_MS = 10_000;
// After a slot has been continuously READY for this long, its respawn
// counter is considered "fresh" — i.e. an exit here is an occasional crash,
// not a sustained failure pattern. Used to gate when we treat the next
// death as a "fresh failure" that should trip the threshold.
const READY_GRACE_MS = 60_000;
const RESPAWN_MAX = 3;
const SWEEPER_INTERVAL_MS = 30_000;
const STOP_DEADLINE_CAP_MS = 25_000;
const STOP_POLL_MS = 100;
const SIGTERM_GRACE_MS = 1_000;
const CLAIM_POLL_MS = 100;
const CLAIM_BACKOFF_MS = 250;
const CLAIM_ERROR_BACKOFF_MS = 1_000;

type PoolState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'DRAINING' | 'DEGRADED';

interface Slot {
  id: number;
  child: ChildProcess | null;
  parser: IpcParser;
  currentJobId: string | null;
  ready: boolean;
  // epoch ms the slot last entered ready state; 0 if never.
  // Used by onChildExit to detect "has been healthy long enough to reset
  // the respawn counter".
  readySince: number;
  respawnCount: number;
  lastRespawnAt: number;
}

interface SlotSnapshot {
  id: number;
  hasChild: boolean;
  ready: boolean;
  currentJobId: string | null;
  respawnCount: number;
  lastRespawnAt: number;
}

interface PoolSnapshot {
  state: PoolState;
  poolSize: number;
  // Slots that have a live child, are ready, and have no in-flight job —
  // i.e. free AND ready AND alive.
  activeWorkers: number;
  degradedSince: Date | null;
  slots: SlotSnapshot[];
}

const slots: Slot[] = [];
let state: PoolState = 'STOPPED';
let poolSize = POOL_SIZE;
let degradedSince: Date | null = null;

export function getPoolState(): PoolState {
  return state;
}

export function getPoolSnapshot(): PoolSnapshot {
  return {
    state,
    poolSize,
    activeWorkers: slots.filter(
      (s) => s.child && s.ready && !s.currentJobId,
    ).length,
    degradedSince,
    slots: slots.map((s) => ({
      id: s.id,
      hasChild: !!s.child,
      ready: s.ready,
      currentJobId: s.currentJobId,
      respawnCount: s.respawnCount,
      lastRespawnAt: s.lastRespawnAt,
    })),
  };
}

export async function startWorkerPool(opts: { size?: number } = {}): Promise<void> {
  if (state !== 'STOPPED') return;
  state = 'STARTING';
  poolSize = opts.size ?? POOL_SIZE;
  for (let i = 0; i < poolSize; i++) {
    slots.push(createSlot(i));
  }
  // Wait for all to become ready (or timeout)
  await Promise.all(slots.map((s) => waitForReady(s)));
  state = 'RUNNING';
  startSweeper(SWEEPER_INTERVAL_MS);
  // Start claim loop after a tick (let things settle)
  setImmediate(() => void claimLoop());
}

export async function stopWorkerPool(opts: { maxWaitMs?: number } = {}): Promise<void> {
  if (state === 'STOPPED') return;
  state = 'DRAINING';
  stopSweeper();
  const maxWaitMs = opts.maxWaitMs ?? 30_000;

  // Send shutdown to all workers
  for (const s of slots) {
    if (s.child && s.ready) {
      try {
        s.child.stdin?.write(encode({ type: 'shutdown' } as NodeToWorker));
      } catch {
        /* ignore */
      }
    }
  }

  // Wait for clean exit
  const deadline = Date.now() + Math.min(maxWaitMs, STOP_DEADLINE_CAP_MS);
  while (Date.now() < deadline && slots.some((s) => s.child)) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
  // Force-kill stragglers
  for (const s of slots) {
    if (s.child) {
      try {
        s.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
  // Brief grace period for SIGTERM to take effect (Python dispatchers
  // exit cleanly within ~1s after their stdin closes). Anything still
  // alive gets SIGKILL'd.
  await new Promise((r) => setTimeout(r, SIGTERM_GRACE_MS));
  for (const s of slots) {
    if (s.child) {
      try {
        s.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  // Reset for a clean restart.
  slots.length = 0;
  degradedSince = null;
  state = 'STOPPED';
}

export function cancelJob(jobId: string): void {
  // Send cancel to the slot that owns this job
  const slot = slots.find((s) => s.currentJobId === jobId);
  if (slot?.child) {
    try {
      slot.child.stdin?.write(encode({ type: 'cancel', id: jobId } as NodeToWorker));
    } catch {
      /* ignore */
    }
  }
}

// ── internals ──────────────────────────────────────────────────────

function getReadySlot(): Slot | null {
  return slots.find((s) => s.ready && s.child && !s.currentJobId) ?? null;
}

function createSlot(id: number): Slot {
  const slot: Slot = {
    id,
    child: null,
    parser: new IpcParser(),
    currentJobId: null,
    ready: false,
    readySince: 0,
    respawnCount: 0,
    lastRespawnAt: 0,
  };
  spawnChild(slot);
  return slot;
}

function spawnChild(slot: Slot): void {
  slot.ready = false;
  slot.readySince = 0;
  slot.parser.reset();
  const child = spawn(
    PYTHON,
    ['-m', 'worker.dispatcher', `--slot-id=${slot.id}`],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  slot.child = child;

  const readyTimer = setTimeout(() => {
    if (!slot.ready) {
      console.error(
        `[workerPool] slot ${slot.id} did not become ready in ${READY_TIMEOUT_MS}ms; killing`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, READY_TIMEOUT_MS);

  child.stdout?.on('data', (chunk: Buffer) => {
    slot.parser.feed(
      chunk.toString('utf8'),
      (msg: WorkerToNode) => {
        if (msg.type === 'ready') {
          slot.ready = true;
          slot.readySince = Date.now();
          clearTimeout(readyTimer);
          return;
        }
        void handleIpcMessage(slot, msg);
      },
      (err: Error) => {
        console.error(`[workerPool] slot ${slot.id} sent invalid JSON:`, err.message);
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      },
    );
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) console.warn(`[worker:${slot.id}] ${text}`);
  });

  child.on('exit', (code, signal) => onChildExit(slot, code, signal));
}

async function waitForReady(slot: Slot): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !slot.ready) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!slot.ready) throw new Error(`slot ${slot.id} failed to become ready`);
}

function onChildExit(
  slot: Slot,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const hadJob = slot.currentJobId;
  const wasReadySince = slot.readySince;
  slot.child = null;
  slot.currentJobId = null;
  slot.ready = false;
  slot.readySince = 0;

  if (state === 'DRAINING' || state === 'STOPPED') return;

  if (hadJob) {
    console.warn(
      `[workerPool] slot ${slot.id} exited with in-flight job ${hadJob} (code=${code}, signal=${signal})`,
    );
    // Don't reset the job's status — let the stale-claim sweeper handle it.
  }

  // Per-slot respawn semantics:
  //
  // The pool goes DEGRADED when a single slot dies RESPAWN_MAX times in
  // a row without ever having been continuously READY for READY_GRACE_MS
  // between crashes. As soon as a slot survives READY_GRACE_MS in ready
  // state, we treat its next death as an "occasional crash" and reset the
  // counter to 0. This means a slot that's been alive for a minute can
  // fail 3 more times before DEGRADED, instead of inheriting a stale
  // counter from earlier (pre-grace) deaths.
  const now = Date.now();
  if (wasReadySince > 0 && now - wasReadySince >= READY_GRACE_MS) {
    slot.respawnCount = 0;
  }
  if (slot.respawnCount < RESPAWN_MAX) {
    slot.lastRespawnAt = now;
    slot.respawnCount++;
    setTimeout(() => spawnChild(slot), CLAIM_BACKOFF_MS * slot.respawnCount);
  } else {
    console.error(`[workerPool] slot ${slot.id} respawn threshold exceeded; pool degraded`);
    if (state === 'RUNNING') {
      state = 'DEGRADED';
      degradedSince = new Date();
    }
  }
}

async function handleIpcMessage(slot: Slot, msg: WorkerToNode): Promise<void> {
  switch (msg.type) {
    case 'started':
      if (slot.currentJobId === msg.id) {
        await markStarted(msg.id);
      }
      break;
    case 'progress':
      if (slot.currentJobId === msg.id) {
        const statePatch: Record<string, unknown> = {};
        if (msg.step !== undefined) statePatch.current_step = msg.step;
        if (msg.pct !== undefined) statePatch.progress = msg.pct;
        if (msg.message !== undefined) statePatch.step_detail = msg.message;
        if (msg.state) Object.assign(statePatch, msg.state);
        statusWriter.enqueue({ id: msg.id, state: statePatch, heartbeat: true });
      }
      break;
    case 'log':
      // info-level logs are not persisted; warn+error go to stderr already
      // and to the Node logger for ops visibility.
      console[msg.level === 'error' ? 'error' : 'warn'](
        `[worker:${slot.id} job=${msg.id}] ${msg.message}`,
      );
      break;
    case 'complete':
      if (slot.currentJobId === msg.id) {
        await statusWriter.enqueueTerminal(msg.id, {
          status: 'completed',
          result: msg.result,
        });
        slot.currentJobId = null;
      }
      break;
    case 'fail':
      if (slot.currentJobId === msg.id) {
        await statusWriter.enqueueTerminal(msg.id, {
          status: 'failed',
          error: msg.error,
          ...(msg.traceback !== null ? { traceback: msg.traceback } : {}),
        });
        slot.currentJobId = null;
      }
      break;
    case 'cancelled':
      if (slot.currentJobId === msg.id) {
        await statusWriter.enqueueTerminal(msg.id, { status: 'cancelled' });
        slot.currentJobId = null;
      }
      break;
    case 'heartbeat':
      if (slot.currentJobId === msg.id) {
        statusWriter.enqueue({ id: msg.id, heartbeat: true });
      }
      break;
    case 'ready':
      // handled in spawnChild before reaching here
      break;
  }
}

let claimLoopRunning = false;
async function claimLoop(): Promise<void> {
  if (claimLoopRunning) return;
  claimLoopRunning = true;
  while (state === 'RUNNING' || state === 'DRAINING') {
    if (state === 'DRAINING') break;
    try {
      // When user is active, throttle workers to keep system responsive
      // When idle, workers can run at full speed
      const { isUserActive } = await import('../routes/analytics.js');
      if (isUserActive()) {
        // User is active — slow down to 1 job every 5 seconds
        await new Promise((r) => setTimeout(r, 5000));
      }
      
      const freeSlot = getReadySlot();
      if (!freeSlot) {
        await new Promise((r) => setTimeout(r, CLAIM_POLL_MS));
        continue;
      }
      const job = await claimNext(`w${freeSlot.id}`);
      if (!job) {
        await new Promise((r) => setTimeout(r, CLAIM_BACKOFF_MS));
        continue;
      }
      freeSlot.currentJobId = job.id;
      const msg: NodeToWorker = {
        type: 'job',
        id: job.id,
        kind: job.kind as JobKind,
        payload: job.payload,
      };
      try {
        freeSlot.child!.stdin!.write(encode(msg));
      } catch (e) {
        console.error(`[workerPool] failed to write to slot ${freeSlot.id}:`, e);
        freeSlot.currentJobId = null;
        // Sweeper will reset this job
      }
    } catch (e) {
      console.error('[workerPool] claim loop error:', e);
      await new Promise((r) => setTimeout(r, CLAIM_ERROR_BACKOFF_MS));
    }
  }
  claimLoopRunning = false;
}

// Re-exports kept so external modules can drive the queue directly without
// reaching into jobQueue (e.g. tests that exercise cancel via the API).
export { requestCancel, markCancelled, listInFlight };
