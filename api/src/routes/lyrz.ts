// src/routes/lyrz.ts — XYZO ↔ LYRz settlement endpoints.
//
//  1. POST /api/lyrz/link   — link a contributor to their LYRz identity so
//                              their contributions become a portable LYRz
//                              balance.
//  2. GET  /api/lyrz/status — what has been earned, settled and queued.

import { Hono } from "hono";
import { getDb } from "../db";
import { ensureQueueTable, lyrzFetch, settleBatch, config } from "../lib/lyrz";

export const lyrzRoute = new Hono();

/**
 * POST /api/lyrz/link
 * Body: { "email": "you@example.com", "global_user_id": "global_xxx",
 *         "lyrz_api_key": "gk_live_xxx" }
 *
 * The key is verified against LYRz before the link is stored, so nobody can
 * claim someone else's LYRz identity. The key itself is NOT stored.
 */
lyrzRoute.post("/lyrz/link", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { email, global_user_id, lyrz_api_key } = body ?? {};

    if (!email || !global_user_id || !lyrz_api_key) {
        return c.json(
            { error: "email, global_user_id and lyrz_api_key are required" },
            400
        );
    }

    try {
        // Verify the key really belongs to that global_user_id.
        const result = await lyrzFetch("/global/verify", {
            headers: { Authorization: `Bearer ${lyrz_api_key}` },
        });

        if (!result || result.valid !== true) {
            return c.json({ error: "That LYRz API key is not valid" }, 400);
        }
        if (result.global_user_id !== global_user_id) {
            return c.json(
                { error: "That API key does not belong to that global_user_id" },
                400
            );
        }

        const sql = getDb();
        await ensureQueueTable();

        // Link every submission this email has made. The link is on the
        // contributor, not on one item.
        await sql`
            UPDATE community_details SET lyrz_global_user_id = ${global_user_id}
            WHERE submitter_email = ${email}
        `;

        // If the contributor has no submissions yet, keep the mapping in the
        // queue table so it survives.
        await sql`
            INSERT INTO xyzo_lyrz_settlement_queue
                (idempotency_key, request_id, user_id, global_user_id, karma_delta, status)
            VALUES (
                ${`link:${email}:${global_user_id}`}, ${"link"}, ${email},
                ${global_user_id}, 0, 'linked'
            )
            ON CONFLICT (idempotency_key) DO NOTHING
        `;

        return c.json({
            ok: true,
            linked: true,
            email,
            global_user_id,
            username: result.username,
            entity_type: result.entity_type,
            allowed_sites: result.allowed_sites,
            message: "Linked. Your contributions now also accrue as a portable LYRz balance.",
        });
    } catch (err: any) {
        return c.json(
            {
                error: "Could not reach LYRz to verify the key",
                detail: String(err?.message ?? err),
            },
            502
        );
    }
});

/**
 * GET /api/lyrz/status
 * Query: ?email=...  (optional — otherwise totals across all contributors)
 */
lyrzRoute.get("/lyrz/status", async (c) => {
    const email = c.req.query("email") || null;
    try {
        const sql = getDb();
        await ensureQueueTable();

        const params = email ? [email] : [];
        const where = email ? "WHERE user_id = $1" : "";

        const [totals] = await sql<any[]>`
            SELECT
                COALESCE(SUM(karma_delta) FILTER (WHERE status = 'settled'), 0) AS settled,
                COALESCE(SUM(karma_delta) FILTER (WHERE status = 'pending'), 0) AS pending,
                COUNT(*) FILTER (WHERE status = 'settled') AS settled_count,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
            FROM xyzo_lyrz_settlement_queue ${sql.unsafe(where)}
        `.catch(() => [{}]);

        const [contribs] = await sql<any[]>`
            SELECT COUNT(*)::int AS n FROM community_details
        `.catch(() => [{ n: 0 }]);

        return c.json({
            ok: true,
            email,
            contributions: contribs?.n ?? 0,
            settled_lyrz: Number(totals?.settled ?? 0),
            pending_lyrz: Number(totals?.pending ?? 0),
            settled_count: Number(totals?.settled_count ?? 0),
            pending_count: Number(totals?.pending_count ?? 0),
            settlement: {
                configured: config.enabled,
                api: config.LYRZ_API,
                site_id: config.LYRZ_SITE_ID,
            },
        });
    } catch (err: any) {
        return c.json({ error: String(err?.message ?? err) }, 500);
    }
});

/**
 * POST /api/lyrz/settle — run a settlement pass now.
 * Requires the XYZO admin key.
 */
lyrzRoute.post("/lyrz/settle", async (c) => {
    const adminKey = process.env.XYZO_ADMIN_KEY;
    const presented = c.req.header("x-admin-key");
    if (!adminKey || presented !== adminKey) {
        return c.json({ error: "Admin key required" }, 403);
    }
    const summary = await settleBatch();
    return c.json({ ok: true, ...summary });
});
