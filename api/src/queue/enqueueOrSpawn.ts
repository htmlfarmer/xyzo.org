// Unified entry point for every async / sync-wait route that needs to fan
// work out to a worker.
//
// Every call enqueues a job into the Postgres-backed `discovery_jobs`
// queue. Fire-and-forget callers pass `waitMs: 0`; sync-wait callers
// block on the LISTEN/NOTIFY bridge until the job reaches a terminal
// state (or `waitMs` elapses). Failed / cancelled jobs throw to the
// caller; the route handler is responsible for translating to the HTTP
// response shape.
//
// Soft caps never reject — over-cap jobs still enqueue, but the async
// response carries `backpressure: 'queue-full'` so callers can surface
// that signal to the user. The pool-state guard is the only hard reject.

import { enqueue, listInFlight } from './jobQueue';
import { waitForJobTerminal } from './listenClientPool';
import { getPoolState } from './workerPool';
import { KIND_CONFIG, type JobKind } from './kindConfig';
import { JobQueueUnavailableError } from './errors';

export interface EnqueueOptions {
  /** 0 = fire-and-forget; >0 = sync-wait; undefined = use kind default timeout. */
  waitMs?: number;
  priority?: number;
  enqueuedBy?: string;
  maxAttempts?: number;
}

export type EnqueueResult<T> =
  | {
      kind: 'async';
      requestId: string;
      statusUrl: string;
      backpressure?: 'queue-full';
    }
  | { kind: 'sync'; result: T };

function statusUrlFor(jobId: string): string {
  return `/api/discovery-status/${jobId}`;
}

export async function enqueueOrSpawn<T = unknown>(
  kind: JobKind,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult<T>> {
  const poolState = getPoolState();
  if (poolState === 'DEGRADED') {
    throw new JobQueueUnavailableError('pool-degraded');
  }
  // During STARTING, jobs enqueue fine (queue is Postgres-backed) but
  // won't be claimed until workers boot.  Still, callers that need a
  // fast response (e.g. explore-region) should know the pool isn't
  // ready yet.  We allow enqueue to proceed — the queue is durable.

  const config = KIND_CONFIG[kind];
  const inflight = await listInFlight();
  const runningCount =
    (inflight.running[kind] ?? 0) + (inflight.claimed[kind] ?? 0);
  const overCap = runningCount >= config.softCap.running;

  const job = await enqueue(kind, payload, {
    priority: opts.priority ?? config.defaultPriority,
    enqueuedBy: opts.enqueuedBy,
    maxAttempts: opts.maxAttempts ?? config.defaultMaxAttempts,
  });

  // Fire-and-forget: never wait, never block on the DB.
  if (opts.waitMs === 0) {
    return overCap
      ? {
          kind: 'async',
          requestId: job.id,
          statusUrl: statusUrlFor(job.id),
          backpressure: 'queue-full',
        }
      : { kind: 'async', requestId: job.id, statusUrl: statusUrlFor(job.id) };
  }

  // Sync-wait: block via LISTEN/NOTIFY. waitForJobTerminal rejects with
  // JobTimeoutError / JobFailedError / JobCancelledError — let those
  // bubble up untouched so the route can map them to HTTP responses.
  const timeoutMs = opts.waitMs ?? config.defaultTimeoutMs;
  const terminal = await waitForJobTerminal(job.id, timeoutMs);
  return { kind: 'sync', result: terminal.result as T };
}