/**
 * Global Shutdown System
 *
 * Allows verified humans to temporarily shut down the site if >10% of
 * active users complain via the help page. Think of it as a community
 * "emergency brake" — if enough people are unhappy, the site goes into
 * maintenance mode until an admin resets it.
 *
 * Endpoints:
 *   POST /api/shutdown/complaint  — File a complaint (increments counter)
 *   GET  /api/shutdown/status     — Check if site is shutdown + stats
 *   POST /api/shutdown/reset      — Admin reset (requires X-Admin-Key)
 *   POST /api/shutdown/activate   — Admin manual shutdown (requires X-Admin-Key)
 */
import { Hono } from "hono";
import { getDb } from "../db";
import { adminAuth } from "../auth";
import { RateLimiter, getClientIp } from "../ratelimit";

const complaintLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

export const shutdownRoute = new Hono();

// In-memory cache for shutdown state (refreshed every 30s)
let _shutdownCache: { is_shutdown: boolean; checked_at: number } | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * Check if the site is currently shut down.
 * Uses in-memory cache to avoid DB hit on every request.
 * Called by middleware on every request.
 */
export async function isSiteShutdown(): Promise<boolean> {
  const now = Date.now();
  if (_shutdownCache && now - _shutdownCache.checked_at < CACHE_TTL_MS) {
    return _shutdownCache.is_shutdown;
  }
  try {
    const sql = getDb();
    const rows = await sql<{ is_shutdown: boolean }[]>`
      SELECT is_shutdown FROM shutdown_state WHERE id = 1
    `;
    const isDown = rows[0]?.is_shutdown ?? false;
    _shutdownCache = { is_shutdown: isDown, checked_at: now };
    return isDown;
  } catch {
    // If DB is down, don't shutdown — let other errors surface naturally
    return false;
  }
}

/**
 * Force-refresh the shutdown cache (called after reset/activate).
 */
export function refreshShutdownCache(): void {
  _shutdownCache = null;
}

// ── POST /api/shutdown/complaint ──────────────────────────────────────
// File a complaint. This is what users click when they're unhappy.
// Each complaint is logged with a 24h rolling window.
// If complaints exceed 10% of active users, the site shuts down.
shutdownRoute.post("shutdown/complaint", async (c) => {
  // FIX_NOTES 2.1: an anonymous flood of complaints used to be able to
  // trip the kill-switch (the denominator was also publicly writable).
  const rl = complaintLimiter.check(getClientIp(c.req.raw));
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const { complaint, session_id } = body;

  if (!complaint || typeof complaint !== "string" || complaint.trim().length < 5) {
    return c.json({ error: "complaint_too_short", message: "Please describe the issue in at least 5 characters." }, 400);
  }

  const sql = getDb();
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("cf-connecting-ip")
    || c.req.header("x-real-ip")
    || null;
  const ua = c.req.header("user-agent") || null;

  // Log the complaint
  await sql`
    INSERT INTO shutdown_complaints (session_id, complaint_text, ip_address, user_agent)
    VALUES (${session_id || null}, ${complaint.trim().slice(0, 2000)}, ${ip}, ${ua})
  `;

  // Update complaint count in shutdown_state
  await sql`
    UPDATE shutdown_state
    SET complaint_count = complaint_count + 1,
        updated_at = now()
    WHERE id = 1
  `;

  // Check if we should auto-shutdown
  const stats = await sql`
    SELECT * FROM shutdown_stats()
  `;

  const s = stats[0];
  if (s?.should_shutdown && !s.is_shutdown) {
    // Auto-shutdown triggered!
    await sql`
      UPDATE shutdown_state
      SET is_shutdown = TRUE,
          shutdown_at = now(),
          shutdown_reason = 'auto: ' || ${complaint.trim().slice(0, 500)},
          updated_at = now()
      WHERE id = 1
    `;
    refreshShutdownCache();
    return c.json({
      ok: true,
      shutdown: true,
      message: "The site has been temporarily shut down due to community feedback. An admin will review and reset soon.",
      stats: {
        complaints_24h: Number(s.complaints_24h),
        active_users: s.active_users,
        threshold_pct: Number(s.threshold_pct),
      },
    });
  }

  return c.json({
    ok: true,
    shutdown: false,
    message: "Thank you for your feedback. We take community concerns seriously.",
    stats: {
      complaints_24h: Number(s.complaints_24h),
      active_users: s.active_users,
      threshold_pct: Number(s.threshold_pct),
      should_shutdown: s.should_shutdown,
    },
  });
});

// ── GET /api/shutdown/status ──────────────────────────────────────────
// Check shutdown status + stats. Used by frontend to show banner.
shutdownRoute.get("shutdown/status", async (c) => {
  const sql = getDb();
  const stats = await sql`SELECT * FROM shutdown_stats()`;
  const s = stats[0];

  return c.json({
    is_shutdown: s?.is_shutdown ?? false,
    complaints_24h: Number(s?.complaints_24h ?? 0),
    active_users: s?.active_users ?? 0,
    threshold_pct: Number(s?.threshold_pct ?? 0),
    should_shutdown: s?.should_shutdown ?? false,
  });
});

// ── POST /api/shutdown/reset ──────────────────────────────────────────
// Admin reset. Requires X-Admin-Key header.
shutdownRoute.post("shutdown/reset", async (c) => {
  // FIX_NOTES 2.1: this compared the raw header text against the bcrypt
  // key_hash column — legitimate admins could never pass, and anyone who
  // ever leaked a hash value could. Standard verification gate now.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;
  const sql = getDb();

  await sql`
    UPDATE shutdown_state
    SET is_shutdown = FALSE,
        complaint_count = 0,
        shutdown_at = NULL,
        shutdown_reason = NULL,
        reset_at = now(),
        reset_by = ${gate.auth.name},
        updated_at = now()
    WHERE id = 1
  `;

  // Clear recent complaints
  await sql`DELETE FROM shutdown_complaints WHERE created_at > now() - INTERVAL '24 hours'`;

  refreshShutdownCache();

  return c.json({ ok: true, message: "Site has been reset and is now live." });
});

// ── POST /api/shutdown/activate ───────────────────────────────────────
// Admin manual shutdown. Requires X-Admin-Key header.
shutdownRoute.post("shutdown/activate", async (c) => {
  // FIX_NOTES 2.1: same flawed raw-vs-bcrypt-hash comparison as reset.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;
  const sql = getDb();

  const body = await c.req.json().catch(() => ({}));
  const reason = body?.reason || "Manual admin shutdown";

  await sql`
    UPDATE shutdown_state
    SET is_shutdown = TRUE,
        shutdown_at = now(),
        shutdown_reason = ${reason},
        updated_at = now()
    WHERE id = 1
  `;

  refreshShutdownCache();

  return c.json({ ok: true, message: "Site has been shut down." });
});

// ── PUT /api/shutdown/active-users ────────────────────────────────────
// Called by analytics to update the active user estimate.
// This is how we know what "10% of users" means.
shutdownRoute.put("shutdown/active-users", async (c) => {
  // FIX_NOTES 2.1: this was a PUBLIC write. Whoever controlled the
  // denominator controlled the complaint threshold — one complaint could
  // shut the whole site down. Admin-only now (no legitimate public
  // caller exists; the presence pipeline feeds the estimate internally).
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;
  const body = await c.req.json().catch(() => ({}));
  const { count } = body;

  if (typeof count !== "number" || count < 0) {
    return c.json({ error: "invalid_count" }, 400);
  }

  const sql = getDb();
  await sql`
    UPDATE shutdown_state
    SET active_users_estimate = ${Math.round(count)},
        updated_at = now()
    WHERE id = 1
  `;

  return c.json({ ok: true });
});
