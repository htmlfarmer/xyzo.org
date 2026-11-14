import { Hono } from "hono";
import { aiBreaker } from "../ai-breaker";

export const aiStatusRoute = new Hono();

const startedAt = Date.now();

// ── GET /api/ai-status ───────────────────────────────────────────────
// Full AI diagnostics: breaker state, endpoint config, uptime, call stats.
aiStatusRoute.get("/ai-status", (c) => {
  const snap = aiBreaker.snapshot();
  const uptimeMs = Date.now() - startedAt;
  const uptimeH = Math.floor(uptimeMs / 3_600_000);
  const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);

  return c.json({
    healthy: !snap.open,
    retry_after_ms: snap.open_for_ms,
    recent_failures: snap.recent_failures,
    last_error: snap.last_error || null,

    // Breaker details
    breaker: {
      open: snap.open,
      open_for_ms: snap.open_for_ms,
      fail_window_ms: snap.fail_window_ms,
      fail_threshold: snap.fail_threshold,
      cooldown_ms: snap.cooldown_ms,
      recent_failures: snap.recent_failures,
    },

    // Call statistics
    stats: {
      total_calls: snap.total_calls,
      total_failures: snap.total_failures,
      total_short_circuits: snap.total_short_circuits,
      success_rate_pct: snap.success_rate,
      last_success_at: snap.last_success_at,
      last_failure_at: snap.last_failure_at,
    },

    // Recent error history (last 10)
    recent_errors: snap.recent_errors,

    // Endpoint configuration
    // FIX_NOTES 2.4: this leaked the internal AI host/port to every
    // anonymous visitor (and the default embedded a LAN address).
    endpoint: {
      configured: Boolean(process.env.XYZO_AI_URL),
      timeout_ms: Number(process.env.XYZO_AI_TIMEOUT ?? 25) * 1000,
    },

    // Process info
    process: {
      uptime_ms: uptimeMs,
      uptime_human: `${uptimeH}h ${uptimeM}m`,
      pid: process.pid,
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
    },
  });
});
