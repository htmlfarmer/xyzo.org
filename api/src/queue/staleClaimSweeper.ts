// api/src/queue/staleClaimSweeper.ts
import { getDb } from "../db";

export interface SweepResult {
  reset: number;
  failed: number;
}

export async function runSweep(now: Date = new Date()): Promise<SweepResult> {
  const sql = getDb();
  const rows = await sql<{ was_reset: number; was_failed: number }[]>`
    UPDATE discovery_jobs SET
      status = CASE
        WHEN attempts + 1 < max_attempts THEN 'queued'::job_status
        ELSE 'failed'::job_status
      END,
      worker_id = CASE
        WHEN attempts + 1 < max_attempts THEN NULL
        ELSE worker_id
      END,
      heartbeat_at = CASE
        WHEN attempts + 1 < max_attempts THEN NULL
        ELSE heartbeat_at
      END,
      attempts = attempts + 1,
      error = CASE
        WHEN attempts + 1 >= max_attempts THEN 'max attempts exceeded'
        ELSE error
      END,
      finished_at = CASE
        WHEN attempts + 1 >= max_attempts THEN now()
        ELSE finished_at
      END
    WHERE status IN ('claimed', 'running')
      AND heartbeat_at IS NOT NULL
      AND heartbeat_at < ${now} - INTERVAL '30 seconds'
    RETURNING
      id,
      CASE WHEN status = 'queued' THEN 1 ELSE 0 END AS was_reset,
      CASE WHEN status = 'failed' THEN 1 ELSE 0 END AS was_failed
  `;

  let reset = 0;
  let failed = 0;
  for (const r of rows) {
    reset += r.was_reset;
    failed += r.was_failed;
  }
  return { reset, failed };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startSweeper(intervalMs = 30_000): void {
  if (intervalHandle) return;
  // Run once immediately, then on interval.
  void runSweep().catch((e) => console.error("[sweeper] initial run failed:", e));
  intervalHandle = setInterval(() => {
    void runSweep().catch((e) => console.error("[sweeper] run failed:", e));
  }, intervalMs);
}

export function stopSweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}