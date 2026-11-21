// src/lib/lyrz.ts — XYZO → LYRz settlement bridge.
//
// XYZO is the knowledge pipeline: it clusters news, extracts entities and
// places, and lets the community vote on re-evaluations. That work is real
// contribution to a shared body of knowledge.
//
// This module gives contributors a portable LYRz balance for it — one that
// follows them across the whole ecosystem (lyrz.org, blnq.org, hivv.org,
// xyzo.org) rather than being locked inside one site.
//
// Design notes
// ------------
// * Idempotent. Each contribution is keyed by (request_id, user_id) so a
//   replayed submission can never pay twice.
// * Queued, not dropped. If LYRz is unreachable the batch is parked and
//   retried. Contributions are never silently lost.
// * Nothing is paid without a real LYRz identity. A contributor must have
//   linked their LYRz global_user_id first.
// * Optional. If no LYRz key is configured the bridge stays dormant and
//   XYZO behaves exactly as before.

import { getDb } from "../db";

const LYRZ_API = (process.env.XYZO_LYRZ_API_URL ?? "https://lyrz.org/api/v1").replace(/\/+$/, "");
const LYRZ_SITE_ID = process.env.XYZO_LYRZ_SITE_ID ?? "xyzo.org";
const LYRZ_API_KEY = process.env.XYZO_LYRZ_API_KEY ?? "";

const BATCH_SIZE = Number(process.env.XYZO_LYRZ_SETTLE_BATCH ?? "50");
const INTERVAL_MS = Number(process.env.XYZO_LYRZ_SETTLE_INTERVAL_MS ?? String(5 * 60 * 1000));

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface SettlementSummary {
    settled: number;
    skipped: number;
    failed: number;
    errors: string[];
}

export interface SettlementEntry {
    idempotencyKey: string;
    requestId: string | number;
    userId: string;
    globalUserId: string;
    karmaDelta: number;
}

/**
 * Create the settlement queue if it does not exist yet.
 * Safe to call repeatedly.
 */
export async function ensureQueueTable(): Promise<void> {
    const sql = getDb();
    await sql`
        CREATE TABLE IF NOT EXISTS xyzo_lyrz_settlement_queue (
            queue_id        BIGSERIAL PRIMARY KEY,
            idempotency_key VARCHAR(191) NOT NULL UNIQUE,
            request_id      VARCHAR(191),
            user_id         VARCHAR(191) NOT NULL,
            global_user_id  VARCHAR(64),
            karma_delta     NUMERIC(18,6) NOT NULL DEFAULT 0,
            status          VARCHAR(20) NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_xyzo_lyrz_queue_status
            ON xyzo_lyrz_settlement_queue(status, updated_at)
    `;
    await sql`
        CREATE INDEX IF NOT EXISTS idx_xyzo_lyrz_queue_user
            ON xyzo_lyrz_settlement_queue(user_id)
    `;
    // Link a contributor to their LYRz identity.
    // community_details is keyed by pin_id (the submitted item).
    await sql`
        ALTER TABLE community_details
            ADD COLUMN IF NOT EXISTS lyrz_global_user_id VARCHAR(64)
    `.catch(() => {});
}

/** Call the LYRz API. Throws on a non-2xx response. */
export async function lyrzFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    if (!LYRZ_API_KEY) throw new Error("XYZO_LYRZ_API_KEY is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(`${LYRZ_API}${path}`, {
            ...options,
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${LYRZ_API_KEY}`,
                ...(options.headers || {}),
            },
        });
        const text = await res.text();
        let body: any = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { raw: text };
        }
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        return (body?.data ?? body) as T;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Look up a contributor's LYRz global_user_id.
 * Falls back to the queue (an earlier link) if the member row has none.
 */
export async function resolveGlobalUserId(userId: string): Promise<string | null> {
    const sql = getDb();
    const [member] = await sql<any[]>`
        SELECT lyrz_global_user_id FROM community_details
        WHERE submitter_email = ${userId} AND lyrz_global_user_id IS NOT NULL
        LIMIT 1
    `.catch(() => []);
    if (member?.lyrz_global_user_id) return member.lyrz_global_user_id;

    const [queued] = await sql<any[]>`
        SELECT global_user_id FROM xyzo_lyrz_settlement_queue
        WHERE user_id = ${userId} AND global_user_id IS NOT NULL
        LIMIT 1
    `.catch(() => []);
    return queued?.global_user_id ?? null;
}

/**
 * Queue a contribution for settlement.
 * Idempotent on `idempotencyKey`.
 */
export async function enqueueSettlement(entry: SettlementEntry): Promise<void> {
    try {
        await getDb()`SELECT 1 FROM xyzo_lyrz_settlement_queue LIMIT 1`;
    } catch {
        await ensureQueueTable();
    }

    const sql = getDb();
    await sql`
        INSERT INTO xyzo_lyrz_settlement_queue
            (idempotency_key, request_id, user_id, global_user_id, karma_delta, status)
        VALUES (
            ${entry.idempotencyKey}, ${String(entry.requestId)}, ${entry.userId},
            ${entry.globalUserId}, ${entry.karmaDelta}, 'pending'
        )
        ON CONFLICT (idempotency_key) DO NOTHING
    `;
}

/**
 * Settle one batch of queued contributions.
 * Never throws — a settlement failure must not take the pipeline down.
 */
export async function settleBatch(limit = BATCH_SIZE): Promise<SettlementSummary> {
    const summary: SettlementSummary = { settled: 0, skipped: 0, failed: 0, errors: [] };
    if (running) return { ...summary, skipped: 0, errors: ["already running"] };
    running = true;

    try {
        const sql = getDb();
        await ensureQueueTable();

        const pending = await sql<any[]>`
            SELECT * FROM xyzo_lyrz_settlement_queue
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT ${limit}
        `.catch(() => []);

        if (!pending.length) return summary;

        // Group by user so one LYRz call can carry a contributor's batch.
        const byUser = new Map<string, { userId: string; globalUserId: string; delta: number; rows: any[] }>();
        for (const row of pending) {
            if (!row.global_user_id) {
                summary.skipped++;
                continue;
            }
            if (!byUser.has(row.user_id)) {
                byUser.set(row.user_id, {
                    userId: row.user_id,
                    globalUserId: row.global_user_id,
                    delta: 0,
                    rows: [],
                });
            }
            const group = byUser.get(row.user_id)!;
            group.delta += Number(row.karma_delta || 0);
            group.rows.push(row);
        }

        for (const group of byUser.values()) {
            if (group.delta <= 0) {
                await sql`
                    UPDATE xyzo_lyrz_settlement_queue
                    SET status = 'settled', updated_at = NOW()
                    WHERE queue_id = ANY(${sql.array(group.rows.map((r: any) => r.queue_id))}::bigint[])
                `.catch(() => {});
                summary.skipped += group.rows.length;
                continue;
            }

            try {
                await lyrzFetch("/karma/sync", {
                    method: "POST",
                    body: JSON.stringify({
                        site_id: LYRZ_SITE_ID,
                        karma_delta: group.delta,
                        user_id: group.globalUserId,
                        action: "contribution_settlement",
                    }),
                });

                await sql`
                    UPDATE xyzo_lyrz_settlement_queue
                    SET status = 'settled', updated_at = NOW()
                    WHERE queue_id = ANY(${sql.array(group.rows.map((r: any) => r.queue_id))}::bigint[])
                `.catch(() => {});
                summary.settled += group.rows.length;
            } catch (err: any) {
                const message = String(err?.message ?? err);
                summary.failed += group.rows.length;
                summary.errors.push(message);
                // Park it for a retry rather than dropping the contribution.
                await sql`
                    UPDATE xyzo_lyrz_settlement_queue
                    SET status = 'pending', attempts = attempts + 1,
                        last_error = ${message.slice(0, 500)}, updated_at = NOW()
                    WHERE queue_id = ANY(${sql.array(group.rows.map((r: any) => r.queue_id))}::bigint[])
                `.catch(() => {});
            }
        }
    } catch (err: any) {
        summary.errors.push(String(err?.message ?? err));
    } finally {
        running = false;
    }

    return summary;
}

/** Start the background settler. */
export function startSettlementLoop(): void {
    if (timer) return;
    if (!LYRZ_API_KEY) {
        console.warn("[lyrz] settlement disabled: XYZO_LYRZ_API_KEY is not configured");
        return;
    }
    const tick = () => {
        settleBatch()
            .then((s) => {
                if (s.settled || s.failed) {
                    console.log(
                        `[lyrz] settlement: settled=${s.settled} failed=${s.failed} skipped=${s.skipped}` +
                        (s.errors.length ? ` errors=${s.errors.slice(0, 2).join(" | ")}` : "")
                    );
                }
            })
            .catch((e) => console.error("[lyrz] settlement loop error:", e.message));
    };
    timer = setInterval(tick, INTERVAL_MS);
    tick();
    console.log(`[lyrz] settlement loop started (every ${INTERVAL_MS}ms) → ${LYRZ_API}`);
}

export function stopSettlementLoop(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export const config = {
    LYRZ_API,
    LYRZ_SITE_ID,
    enabled: !!LYRZ_API_KEY,
};
