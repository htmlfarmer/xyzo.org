import { getDb } from "../db";
import type { JobKind } from "./kindConfig";

const sql = getDb();

export interface EnqueueOptions {
  priority?: number;
  enqueuedBy?: string;
  maxAttempts?: number;
}

export type JobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface EnqueuedJob {
  id: string;
  kind: JobKind;
  status: "queued";
  priority: number;
  attempts: number;
  max_attempts: number;
}

export interface JobRow extends Omit<EnqueuedJob, "status"> {
  status: JobStatus;
  payload: unknown;
  result: unknown | null;
  error: string | null;
  traceback: string | null;
  worker_id: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  scheduled_at: Date;
  cancel_requested: boolean;
  state: Record<string, unknown>;
}

export async function enqueue(
  kind: JobKind,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<EnqueuedJob> {
  const rows = await sql<EnqueuedJob[]>`
    INSERT INTO discovery_jobs (kind, priority, payload, enqueued_by, max_attempts)
    VALUES (
      ${kind}::job_kind,
      ${opts.priority ?? 0},
      ${sql.json(payload)},
      ${opts.enqueuedBy ?? null},
      ${opts.maxAttempts ?? 1}
    )
    RETURNING id, kind, status, priority, attempts, max_attempts
  `;
  return rows[0];
}

export async function getJob(id: string): Promise<JobRow | null> {
  const rows = await sql<JobRow[]>`
    SELECT id, kind, status, priority, attempts, max_attempts,
           payload, result, error, traceback, worker_id, heartbeat_at,
           started_at, finished_at, scheduled_at, cancel_requested, state
    FROM discovery_jobs WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

export async function claimNext(workerId: string): Promise<JobRow | null> {
  // Atomic claim: SKIP LOCKED so concurrent claims never collide.
  const rows = await sql<JobRow[]>`
    UPDATE discovery_jobs SET
      status = 'claimed',
      worker_id = ${workerId},
      started_at = COALESCE(started_at, now()),
      heartbeat_at = now()
    WHERE id = (
      SELECT id FROM discovery_jobs
      WHERE status = 'queued'
        AND cancel_requested = false
        AND scheduled_at <= now()
      ORDER BY priority DESC, scheduled_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, kind, status, priority, attempts, max_attempts,
              payload, result, error, traceback, worker_id, heartbeat_at,
              started_at, finished_at, scheduled_at, cancel_requested, state
  `;
  return rows[0] ?? null;
}

export async function markStarted(id: string): Promise<void> {
  await sql`
    UPDATE discovery_jobs
    SET status = 'running', heartbeat_at = now()
    WHERE id = ${id}::uuid
  `;
}

export async function markProgress(
  id: string,
  statePatch: Record<string, unknown>,
): Promise<void> {
  await sql`
    UPDATE discovery_jobs
    SET state = state || ${sql.json(statePatch)}::jsonb,
        heartbeat_at = now()
    WHERE id = ${id}::uuid
  `;
}

export async function markComplete(id: string, result: unknown): Promise<void> {
  await sql`
    UPDATE discovery_jobs
    SET status = 'completed',
        result = ${sql.json(result)}::jsonb,
        finished_at = now(),
        heartbeat_at = now()
    WHERE id = ${id}::uuid
  `;
}

export async function markFailed(
  id: string,
  error: string,
  traceback: string | null,
): Promise<void> {
  await sql`
    UPDATE discovery_jobs
    SET status = 'failed',
        error = ${error},
        traceback = ${traceback},
        finished_at = now()
    WHERE id = ${id}::uuid
  `;
}

export async function markCancelled(id: string): Promise<void> {
  await sql`
    UPDATE discovery_jobs
    SET status = 'cancelled', finished_at = now()
    WHERE id = ${id}::uuid
  `;
}

export async function requestCancel(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE discovery_jobs
    SET cancel_requested = true
    WHERE id = ${id}::uuid AND status IN ('queued', 'claimed', 'running')
    RETURNING id
  `;
  return rows.length > 0;
}

export interface InFlightSnapshot {
  queued: Record<string, number>;
  claimed: Record<string, number>;
  running: Record<string, number>;
}

export async function listInFlight(): Promise<InFlightSnapshot> {
  const rows = await sql<
    { kind: JobKind; status: string; n: number }[]
  >`
    SELECT kind, status, COUNT(*)::int AS n
    FROM discovery_jobs
    WHERE status IN ('queued', 'claimed', 'running')
    GROUP BY kind, status
  `;
  const snap: InFlightSnapshot = { queued: {}, claimed: {}, running: {} };
  for (const r of rows) {
    const bucket = snap[r.status as "queued" | "claimed" | "running"];
    bucket[r.kind] = r.n;
  }
  return snap;
}
