// Batched status writer. Collects in-memory progress updates per job id and
// flushes them to Postgres either when the buffer reaches a threshold or when
// the timer fires. Terminal events bypass the timer and flush immediately.

import type { JSONValue } from "postgres";
import { getDb } from "../db";

const sql = getDb();

export interface StatusWriterOptions {
  flushIntervalMs?: number;
  batchThreshold?: number;
}

export interface PendingUpdate {
  id: string;
  state?: Record<string, unknown>;
  heartbeat?: boolean;
  terminal?: {
    status: "completed" | "failed" | "cancelled";
    result?: unknown;
    error?: string;
    traceback?: string;
  };
}

export class StatusWriter {
  private pending = new Map<string, PendingUpdate>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalListeners: Array<(ids: string[]) => void> = [];
  private flushIntervalMs: number;
  private batchThreshold: number;
  // Tracks total enqueue() calls since last flush. Decoupled from the
  // collapsing `pending` map so threshold-based immediate flushes still fire
  // when many updates share the same job id.
  private enqueueCount = 0;
  // Re-entrancy guard: while a flush is awaiting SQL, a concurrent
  // scheduleFlush() (e.g. from a threshold hit or new enqueue) must not start
  // a second flush — that would double-fire pg_notify and terminal listeners.
  private flushing = false;

  constructor(opts: StatusWriterOptions = {}) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 250;
    this.batchThreshold = opts.batchThreshold ?? 10;
  }

  get pendingSize(): number {
    return this.enqueueCount;
  }

  onTerminalFlush(listener: (ids: string[]) => void): void {
    this.terminalListeners.push(listener);
  }

  enqueue(update: PendingUpdate): void {
    const prev = this.pending.get(update.id);
    this.pending.set(update.id, {
      id: update.id,
      state: update.state ?? prev?.state,
      heartbeat: update.heartbeat ?? prev?.heartbeat,
      terminal: update.terminal ?? prev?.terminal,
    });
    this.enqueueCount++;
    this.scheduleFlush();
  }

  // Terminal events flush immediately, bypassing the timer.
  async enqueueTerminal(
    id: string,
    terminal: NonNullable<PendingUpdate["terminal"]>,
  ): Promise<void> {
    this.pending.set(id, { id, terminal });
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      // A flush is already running. The current flush will pick up any
      // pending changes via the normal schedule; don't double-fire
      // pg_notify / terminal listeners.
      return;
    }
    this.flushing = true;
    try {
      if (this.pending.size === 0) {
        this.enqueueCount = 0;
        this.flushTimer = null;
        return;
      }
      const updates = [...this.pending.values()];
      this.pending.clear();
      this.enqueueCount = 0;
      this.flushTimer = null;

      try {
        await this.executeFlushes(updates);
        await this.notifyAndFanout(updates);
      } catch (e) {
        console.error("[statusWriter] flush failed, re-seeding pending:", e);
        // Re-add the failed snapshot back to pending so a future flush can
        // retry. Merge with whatever may already be pending (newer enqueue
        // wins per field, matching normal enqueue semantics).
        for (const u of updates) {
          const prev = this.pending.get(u.id);
          this.pending.set(u.id, {
            id: u.id,
            state: u.state ?? prev?.state,
            heartbeat: u.heartbeat ?? prev?.heartbeat,
            terminal: u.terminal ?? prev?.terminal,
          });
        }
      }
    } finally {
      this.flushing = false;
      // If new enqueues arrived during this flush, schedule another.
      if (this.enqueueCount > 0) {
        this.scheduleFlush();
      }
    }
  }

  private async executeFlushes(updates: PendingUpdate[]): Promise<void> {
    const stateById = new Map<string, Record<string, unknown>>();
    const heartbeatIds: string[] = [];
    for (const u of updates) {
      if (u.state) stateById.set(u.id, u.state);
      if (u.heartbeat) heartbeatIds.push(u.id);
    }

    if (stateById.size > 0) {
      const stateKeys = [...stateById.keys()];
      const stateJsonStrings = [...stateById.values()].map((v) => JSON.stringify(v));
      await sql`
        UPDATE discovery_jobs AS d SET
          state = u.state::jsonb,
          heartbeat_at = now()
        FROM UNNEST(${sql.array(stateKeys)}::uuid[], ${sql.array(stateJsonStrings)}::text[]) AS u(id, state)
        WHERE d.id = u.id
      `;
    }

    if (heartbeatIds.length > 0) {
      await sql`UPDATE discovery_jobs SET heartbeat_at = now() WHERE id = ANY(${heartbeatIds}::uuid[])`;
    }

    for (const u of updates) {
      if (!u.terminal) continue;
      if (u.terminal.status === "completed") {
        await sql`
          UPDATE discovery_jobs SET status = 'completed', result = ${sql.json((u.terminal.result ?? null) as JSONValue)}::jsonb,
                                    finished_at = now(), heartbeat_at = now()
          WHERE id = ${u.id}::uuid
        `;
      } else if (u.terminal.status === "failed") {
        await sql`
          UPDATE discovery_jobs SET status = 'failed', error = ${u.terminal.error ?? "unknown"},
                                    traceback = ${u.terminal.traceback ?? null},
                                    finished_at = now()
          WHERE id = ${u.id}::uuid
        `;
      } else if (u.terminal.status === "cancelled") {
        await sql`
          UPDATE discovery_jobs SET status = 'cancelled', finished_at = now()
          WHERE id = ${u.id}::uuid
        `;
      }
    }
  }

  private async notifyAndFanout(updates: PendingUpdate[]): Promise<void> {
    const terminalIds: string[] = [];
    for (const u of updates) {
      if (u.terminal) terminalIds.push(u.id);
    }
    if (terminalIds.length === 0) return;

    try {
      await sql`SELECT pg_notify('job_status_changed', ${JSON.stringify({ ids: terminalIds })}::text)`;
    } catch (e) {
      console.error("[statusWriter] NOTIFY failed:", e);
    }
    for (const listener of this.terminalListeners) {
      try {
        listener(terminalIds);
      } catch (e) {
        console.error("[statusWriter] terminal listener threw:", e);
      }
    }
  }

  private scheduleFlush(): void {
    // Threshold check first: if we've piled up enough enqueue() calls (even
    // collapsed onto a single id), we must flush immediately. The timer check
    // comes second so a long-lived flushTimer doesn't suppress later
    // threshold triggers.
    if (this.enqueueCount >= this.batchThreshold) {
      void this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }
}

// Singleton instance used by workerPool.
export const statusWriter = new StatusWriter();
