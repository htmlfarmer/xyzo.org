import { Hono } from "hono";
import { parseAdminKey, verifyAdminKey } from "../auth";
import { metrics } from "../metrics";
import { RateLimiter, getClientIp } from "../ratelimit";

export const performanceRoute = new Hono();

// ── /api/performance/summary (super-only) ──────────────────────────────
//
// Full performance summary. Gated to ["super"] because the data can
// reveal operator-level patterns (endpoint names + their call volume)
// that the public dashboard doesn't need. Help page uses the public
// alias below.
performanceRoute.get("/performance/summary", async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header);
  if (!parsed) return c.json({ error: "unauthorized" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!auth) return c.json({ error: "unauthorized" }, 401);

  const hours = Number(c.req.query("hours") || 24);
  const summary = await metrics.getSummary(hours);
  return c.json(summary);
});

// ── /api/performance/slow (super-only) ─────────────────────────────────
//
// Same gating as /summary — slow-op metadata (endpoint + operation +
// metadata payload) is operator-only.
performanceRoute.get("/performance/slow", async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header);
  if (!parsed) return c.json({ error: "unauthorized" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!auth) return c.json({ error: "unauthorized" }, 401);

  const slow = await metrics.getSlowOperations(20);
  return c.json({ operations: slow });
});

// ── PII stripper for the public alias ───────────────────────────────────
//
// Two-layer allow/deny policy:
//
//   PII_DENY — keys that MUST be stripped (high-confidence PII / secrets).
//     Conservative intent: any key that smells like an identifier or
//     credential is dropped, regardless of what the inner value is.
//
//   PII_ALLOW — keys that are SAFE to expose on the public alias. If a
//     key matches this list, NEVER strip — even if the deny regex would
//     otherwise match. Used for legitimate aggregation columns whose
//     names happen to contain a denied substring (e.g. `metric_name`,
//     `topic_name`, `host_count`, `user_name`).
//
// Anything else is dropped by default (opt-in rather than opt-out).
// Operators who want to expose a new column add it to PII_ALLOW.
//
// Additionally, plain non-object values (Date, Buffer, primitives, URL,
// null-prototype objects, etc.) are returned verbatim — `Object.entries`
// on a Date returns `[]`, which would otherwise rebuild a Date as `{}`
// and break `new Date({}).getTime()` = NaN on the help-page renderer.
const PII_DENY =
  /^(session_?id|user_?id|ip(_?address)?|ip_address|email|user_?agent|authorization|password|passwd|token|secret|cookie|api_?key|access_?token|refresh_?token|private_?key|salt|hash)$/i;

const PII_ALLOW =
  // Top-level response keys (getSummary returns `totals`, `by_operation`,
  // `by_endpoint`) plus the aggregation columns inside them. `metadata`
  // is intentionally NOT in this list — the slow-ops row's `metadata`
  // payload can contain arbitrary key/value pairs the operator logged,
  // and we have no whitelist for it. With the conservative default
  // (strip unknown keys), `metadata` is dropped unless explicitly added.
  /^(operation|endpoint|method|status|count|calls|avg_ms|max_ms|total_ms|duration_ms|hour|created_at|hostname|topic_name|source_name|metric_name|operation_name|endpoint_name|table_name|host_name|host_count|admin_count|admin_url|user_name|totals|by_operation|by_endpoint|total_operations|total_duration_ms|total_cpu_ms|total_gpu_ms|avg_duration_ms)$/i;

function stripPii(value: unknown): unknown {
  // Preserve non-plain values verbatim — Date, Buffer, primitives, etc.
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripPii);
  // It's a plain object — strip PII keys.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_ALLOW.test(k)) {
      out[k] = stripPii(v);
      continue;
    }
    if (PII_DENY.test(k)) continue;
    // Conservative default: strip unknown keys (opt-in rather than
    // opt-out). Security-critical public alias; new fields must be
    // explicitly added to PII_ALLOW to be exposed.
  }
  return out;
}

// ── Rate limiter for the public alias ──────────────────────────────────
//
// 60 req/min per IP. The public aliases hit the DB with non-trivial
// aggregate scans (metrics.getSummary runs 3 grouped queries), so
// without this an attacker could trivially DoS the metrics table.
// 60/min is generous enough for a help-page auto-refresh + ad-hoc
// operator dashboard polling; tight enough that the cost of an
// aggressive scraper is bounded.
//
// This limiter is independent of `logLimiter` (analytics/log) and
// `reportLimiter` (analytics/report-quality) — the metrics endpoint
// has a different cost profile (read-heavy aggregate scans, no PII
// to write), so it gets its own budget.
const publicPerfLimiter = new RateLimiter({ max: 60, windowMs: 60 * 1000 });

// ── /api/performance/public-summary (PUBLIC) ───────────────────────────
//
// Read-only, PII-stripped alias of /performance/summary used by the
// help page's loadPerformance() dashboard. Tier 1.1 closes the Audit 3
// gap where the help page was calling the super-only route without an
// X-Admin-Key and getting 401 → "Failed to load performance data".
performanceRoute.get("/performance/public-summary", async (c) => {
  // Rate-limit check BEFORE the DB query — abusing this endpoint is
  // cheap (3 grouped aggregate scans per request).
  const ip = getClientIp(c.req.raw);
  const rl = publicPerfLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  const hours = Number(c.req.query("hours") || 24);
  const summary = await metrics.getSummary(hours);
  const safe = stripPii(summary);
  return c.json(safe);
});

// ── /api/performance/public-slow (PUBLIC) ───────────────────────────────
//
// Read-only, PII-stripped alias of /performance/slow.
performanceRoute.get("/performance/public-slow", async (c) => {
  // Rate-limit check BEFORE the DB query — same budget as /public-summary.
  const ip = getClientIp(c.req.raw);
  const rl = publicPerfLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  const slow = await metrics.getSlowOperations(20);
  const safe = stripPii(slow);
  return c.json({ operations: safe });
});