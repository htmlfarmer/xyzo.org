// /api/debug — consolidated system diagnostics for debugging.
//
// Returns everything needed to diagnose AI, discovery, DB, and queue
// issues in a single request. Use ?verbose=1 for full detail.
import { Hono } from "hono";
import { aiBreaker } from "../ai-breaker";
import { getDb } from "../db";
import { getPoolSnapshot } from "../queue/workerPool";
import { listInFlight } from "../queue/jobQueue";
import { parseAdminKey, verifyAdminKey } from "../auth";

export const debugRoute = new Hono();

const startedAt = Date.now();

debugRoute.get("/debug", async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header);
  if (!parsed) return c.json({ error: "unauthorized" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!auth) return c.json({ error: "unauthorized" }, 401);

  const verbose = c.req.query("verbose") === "1";
  const sql = getDb();

  // ── DB check ──────────────────────────────────────────────────────
  let dbOk = false;
  let dbLatencyMs = -1;
  let dbError: string | null = null;
  let dbStats: Record<string, unknown> = {};
  try {
    const t0 = Date.now();
    await sql`SELECT 1`;
    dbLatencyMs = Date.now() - t0;
    dbOk = true;

    if (verbose) {
      const [counts] = await sql`
        SELECT
          (SELECT COUNT(*) FROM news_articles) AS articles,
          (SELECT COUNT(*) FROM news_articles WHERE status = 'pending') AS pending,
          (SELECT COUNT(*) FROM news_articles WHERE status = 'extracted') AS extracted,
          (SELECT COUNT(*) FROM news_events WHERE status = 'active') AS events,
          (SELECT COUNT(*) FROM news_sources WHERE active) AS active_sources,
          (SELECT COUNT(*) FROM news_locations) AS locations,
          (SELECT COUNT(*) FROM discovery_jobs WHERE status IN ('queued','claimed','running')) AS in_flight_jobs
      `;
      dbStats = {
        articles: Number(counts?.articles ?? 0),
        pending: Number(counts?.pending ?? 0),
        extracted: Number(counts?.extracted ?? 0),
        events: Number(counts?.events ?? 0),
        active_sources: Number(counts?.active_sources ?? 0),
        locations: Number(counts?.locations ?? 0),
        in_flight_jobs: Number(counts?.in_flight_jobs ?? 0),
      };
    }
  } catch (e) {
    dbError = (e as Error)?.message?.slice(0, 200) ?? "unknown";
  }

  // ── AI breaker ────────────────────────────────────────────────────
  const aiSnap = aiBreaker.snapshot();

  // ── Queue ─────────────────────────────────────────────────────────
  const pool = getPoolSnapshot();
  const inflight = await listInFlight().catch(
    () => ({ queued: {}, claimed: {}, running: {} }),
  );

  // ── Recent discovery jobs ─────────────────────────────────────────
  let recentJobs: unknown[] = [];
  if (verbose) {
    try {
      recentJobs = await sql`
        SELECT id, kind, status, attempts,
               scheduled_at, started_at, finished_at,
               error, worker_id,
               EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - scheduled_at))::int AS duration_s
        FROM discovery_jobs
        WHERE scheduled_at > now() - interval '1 hour'
        ORDER BY scheduled_at DESC
        LIMIT 20
      `;
    } catch { /* ignore */ }
  }

  // ── Recent AI extraction stats ────────────────────────────────────
  let extractionStats: unknown = null;
  if (verbose) {
    try {
      const [stats] = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'extracted' AND extracted_at > now() - interval '1 hour') AS extracted_1h,
          COUNT(*) FILTER (WHERE status = 'failed' AND fetched_at > now() - interval '1 hour') AS failed_1h,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_now,
          COUNT(*) FILTER (WHERE status = 'unlocated' AND fetched_at > now() - interval '1 hour') AS unlocated_1h
        FROM news_articles
      `;
      extractionStats = {
        extracted_1h: Number(stats?.extracted_1h ?? 0),
        failed_1h: Number(stats?.failed_1h ?? 0),
        pending_now: Number(stats?.pending_now ?? 0),
        unlocated_1h: Number(stats?.unlocated_1h ?? 0),
      };
    } catch { /* ignore */ }
  }

  // ── Process ───────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  const uptimeMs = Date.now() - startedAt;

  return c.json({
    timestamp: new Date().toISOString(),
    uptime_ms: uptimeMs,

    // Component status
    components: {
      database: {
        ok: dbOk,
        latency_ms: dbLatencyMs,
        error: dbError,
        stats: verbose ? dbStats : undefined,
      },
      ai: {
        ok: !aiSnap.open,
        breaker: {
          open: aiSnap.open,
          open_for_ms: aiSnap.open_for_ms,
          recent_failures: aiSnap.recent_failures,
          fail_threshold: aiSnap.fail_threshold,
          cooldown_ms: aiSnap.cooldown_ms,
        },
        stats: {
          total_calls: aiSnap.total_calls,
          total_failures: aiSnap.total_failures,
          total_short_circuits: aiSnap.total_short_circuits,
          success_rate_pct: aiSnap.success_rate,
          last_success_at: aiSnap.last_success_at,
          last_failure_at: aiSnap.last_failure_at,
        },
        recent_errors: aiSnap.recent_errors,
        endpoint: process.env.XYZO_AI_URL ?? "http://192.168.1.3:8888/chat/stream",
      },
      queue: {
        ok: pool.state !== "DEGRADED",
        state: pool.state,
        poolSize: pool.poolSize,
        activeWorkers: pool.activeWorkers,
        degradedSince: pool.degradedSince?.toISOString() ?? null,
        slots: pool.slots,
        jobsByKind: inflight,
      },
    },

    // Verbose-only sections
    ...(verbose ? {
      recent_jobs: recentJobs,
      extraction_stats: extractionStats,
    } : {}),

    process: {
      pid: process.pid,
      memory: {
        heap_used_mb: Math.round(mem.heapUsed / 1_048_576),
        heap_total_mb: Math.round(mem.heapTotal / 1_048_576),
        rss_mb: Math.round(mem.rss / 1_048_576),
      },
      bun_version: Bun.version,
    },
  });
});
