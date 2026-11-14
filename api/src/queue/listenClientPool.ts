// LISTEN-based waiter for terminal job status.
//
// Postgres-js manages its own connection pool internally, so unlike the
// pg.Pool-based plan there is no separate "listen client pool" to acquire
// and release. Instead, each call to `waitForJobTerminal` registers a
// transient LISTEN subscription via `sql.listen(channel, callback)` and
// tears it down on resolve / reject / timeout.
//
// Race handling: a worker can finish a job before the caller subscribes.
// We guard against that with a fast path that reads the current job row
// and returns immediately if it is already terminal.

import { getDb } from "../db";
import {
  JobCancelledError,
  JobFailedError,
  JobNotFoundError,
  JobTimeoutError,
} from "./errors";
import { getJob } from "./jobQueue";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface JobTerminalResult {
  id: string;
  status: TerminalStatus;
  result: unknown | null;
  error: string | null;
}

interface PendingWaiter {
  resolve: (r: JobTerminalResult) => void;
  reject: (e: Error) => void;
  unlisten: () => Promise<void>;
}

// Concurrent `waitForJobTerminal` calls for the same `jobId` are not
// supported. The second call rejects with `Already waiting…` until the
// first finishes. Fan out your own Promises if multiple consumers need
// to react to the same terminal event.
const activeWaiters = new Map<string, PendingWaiter>();

export async function waitForJobTerminal(
  jobId: string,
  timeoutMs: number,
): Promise<JobTerminalResult> {
  const sql = getDb();

  // Fast path: worker may have finished before we subscribed. Re-read the
  // row and return immediately if it's already terminal. This closes the
  // race where pg_notify fires before we call sql.listen().
  const existing = await getJob(jobId);
  if (!existing) throw new JobNotFoundError(jobId);
  if ((TERMINAL_STATUSES as readonly string[]).includes(existing.status)) {
    return {
      id: jobId,
      status: existing.status as TerminalStatus,
      result: existing.result,
      error: existing.error,
    };
  }

  // Slow path: subscribe to NOTIFY and wait for the terminal transition.
  return new Promise<JobTerminalResult>((resolve, reject) => {
    if (activeWaiters.has(jobId)) {
      // A waiter already exists for this job — reject to avoid leaking
      // two LISTEN handlers for one job. Callers should serialize.
      reject(new Error(`Already waiting for terminal status of job ${jobId}`));
      return;
    }

    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (
      action: () => void,
      withUnlisten: { unlisten: () => Promise<void> } | null,
    ): void => {
      if (resolved) return;
      resolved = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      activeWaiters.delete(jobId);
      const teardown = async (): Promise<void> => {
        if (withUnlisten) {
          try {
            await withUnlisten.unlisten();
          } catch {
            /* swallow — best-effort cleanup */
          }
        }
      };
      void teardown().finally(action);
    };

    timer = setTimeout(() => {
      finish(() => reject(new JobTimeoutError(jobId, timeoutMs)), pendingListen);
    }, timeoutMs);

    const pendingListen: { unlisten: () => Promise<void> } = { unlisten: async () => {} };

    sql
      .listen("job_status_changed", (payload) => {
        if (resolved) return;
        let ids: string[] = [];
        try {
          const parsed: unknown = payload ? JSON.parse(payload) : { ids: [] };
          if (
            parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { ids?: unknown }).ids)
          ) {
            ids = (parsed as { ids: unknown[] }).ids.filter(
              (x): x is string => typeof x === "string",
            );
          }
        } catch (e) {
          console.error("[listenClientPool] malformed NOTIFY payload:", e);
          return;
        }
        if (!ids.includes(jobId)) return;

        // Re-read DB to confirm terminal — NOTIFY is a hint, not a
        // guarantee. Defensive code trusts the row, not the channel.
        void getJob(jobId)
          .then((row) => {
            if (resolved) return;
            if (!row) {
              finish(() => reject(new JobNotFoundError(jobId)), pendingListen);
              return;
            }
            if (!(TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
              // Not terminal yet — keep waiting for the real terminal NOTIFY.
              return;
            }
            if (row.status === "completed") {
              finish(
                () =>
                  resolve({
                    id: jobId,
                    status: "completed",
                    result: row.result,
                    error: null,
                  }),
                pendingListen,
              );
            } else if (row.status === "failed") {
              finish(
                () =>
                  reject(
                    new JobFailedError(
                      jobId,
                      row.error ?? "unknown",
                      row.traceback ?? null,
                      row.attempts ?? 1,
                    ),
                  ),
                pendingListen,
              );
            } else {
              finish(() => reject(new JobCancelledError(jobId)), pendingListen);
            }
          })
          .catch((e) => {
            finish(
              () => reject(e instanceof Error ? e : new Error(String(e))),
              pendingListen,
            );
          });
      })
      .then(({ unlisten }) => {
        if (resolved) {
          // The waiter already finished (timeout or fast-path resolve)
          // before the LISTEN handshake completed. Release the listener
          // immediately so we don't leak.
          void unlisten().catch(() => {});
          return;
        }
        pendingListen.unlisten = unlisten;
        activeWaiters.set(jobId, {
          resolve: (r) => finish(() => resolve(r), pendingListen),
          reject: (e) => finish(() => reject(e), pendingListen),
          unlisten,
        });
      })
      .catch((e) => {
        finish(
          () => reject(e instanceof Error ? e : new Error(String(e))),
          pendingListen,
        );
      });
  });
}

// Drain all in-flight waiters by rejecting them with a shutdown error.
// Safe to call multiple times. Real connection lifecycle is owned by
// postgres-js via closeDb(); this only releases the waiters so they don't
// hang past process exit.
export async function shutdownListenPool(): Promise<void> {
  for (const [, waiter] of activeWaiters) {
    try {
      await waiter.unlisten();
    } catch {
      /* ignore */
    }
    try {
      waiter.reject(new Error("listenClientPool shutting down"));
    } catch {
      /* ignore */
    }
  }
  activeWaiters.clear();
}
