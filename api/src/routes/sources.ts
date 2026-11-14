import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { spawn } from "node:child_process";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { getJob } from "../queue/jobQueue";
import { adminAuth } from "../auth";

// Response size caps (Tier response-size-caps, Audit 4):
// - /api/sources/stats: by_region capped at 100 (region vocabulary is
//   free-text and unbounded — without a cap a future typo like
//   region='%' would ship every row).
//   Response now includes `by_region_capped: boolean`.
//
// Note: /api/sources/search was already capped at 200
//   (Math.min(Number(... || 50), 200)).

export const sourcesRoute = new Hono();

const searchLimiter = new RateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
const addLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

// ── GET /api/sources/search ──────────────────────────────────────────
// Search for news sources by query, country, or region.
// Returns sources from the DB matching the criteria.
sourcesRoute.get("/sources/search", async (c) => {
  const q = c.req.query("q") || "";
  const country = c.req.query("country") || "";
  const region = c.req.query("region") || "";
  const status = c.req.query("status") || ""; // active, inactive, erroring, all
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const limitNum = Number(limit);

  const sql = getDb();
  const conditions: string[] = [];
  const queryParams: any[] = [];

  if (q) {
    conditions.push(`(s.name ILIKE $${queryParams.length + 1} OR s.feed_url ILIKE $${queryParams.length + 1})`);
    queryParams.push(`%${q}%`);
  }
  if (country) {
    conditions.push(`s.country = $${queryParams.length + 1}`);
    queryParams.push(country.toUpperCase());
  }
  if (region) {
    conditions.push(`s.region ILIKE $${queryParams.length + 1}`);
    queryParams.push(`%${region}%`);
  }
  if (status === "active") {
    conditions.push("s.active = TRUE");
  } else if (status === "inactive") {
    conditions.push("s.active = FALSE");
  } else if (status === "erroring") {
    conditions.push("s.active = TRUE AND s.error_count > 5");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Use tagged template for the main query, with dynamic WHERE
  let rows;
  if (q && country) {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      WHERE (s.name ILIKE ${"%" + q + "%"} OR s.feed_url ILIKE ${"%" + q + "%"})
        AND s.country = ${country.toUpperCase()}
      ORDER BY s.active DESC, s.reliability_score DESC NULLS LAST, s.name
      LIMIT ${limitNum}
    `;
  } else if (q) {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      WHERE s.name ILIKE ${"%" + q + "%"} OR s.feed_url ILIKE ${"%" + q + "%"}
      ORDER BY s.active DESC, s.reliability_score DESC NULLS LAST, s.name
      LIMIT ${limitNum}
    `;
  } else if (country) {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      WHERE s.country = ${country.toUpperCase()}
      ORDER BY s.active DESC, s.reliability_score DESC NULLS LAST, s.name
      LIMIT ${limitNum}
    `;
  } else if (status === "active") {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      WHERE s.active = TRUE
      ORDER BY s.reliability_score DESC NULLS LAST, s.name
      LIMIT ${limitNum}
    `;
  } else if (status === "inactive") {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      WHERE s.active = FALSE
      ORDER BY s.name
      LIMIT ${limitNum}
    `;
  } else if (status === "erroring") {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      WHERE s.active = TRUE AND s.error_count > 5
      ORDER BY s.error_count DESC, s.name
      LIMIT ${limitNum}
    `;
  } else {
    rows = await sql<any[]>`
      SELECT s.id, s.name, s.feed_url, s.homepage_url, s.country, s.language, s.region,
             s.source_type, s.active, s.reliability_score, s.error_count,
             s.last_success_at, s.last_failure_at, s.lat, s.lng,
             (SELECT COUNT(*) FROM news_articles a WHERE a.source_id = s.id
              AND a.fetched_at > now() - interval '7 days') as articles_7d
      FROM news_sources s
      ORDER BY s.active DESC, s.reliability_score DESC NULLS LAST, s.name
      LIMIT ${limitNum}
    `;
  }

  return c.json({
    query: q || null,
    country: country || null,
    region: region || null,
    count: rows.length,
    sources: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      feed_url: r.feed_url,
      homepage_url: r.homepage_url,
      country: r.country,
      language: r.language,
      region: r.region,
      source_type: r.source_type,
      active: r.active,
      reliability_score: r.reliability_score != null ? Number(r.reliability_score) : null,
      error_count: Number(r.error_count),
      last_success_at: r.last_success_at,
      last_failure_at: r.last_failure_at,
      has_coords: r.lat != null && r.lng != null,
      articles_7d: Number(r.articles_7d),
    })),
  });
});

// ── GET /api/sources/stats ───────────────────────────────────────────
// Aggregate stats about news sources.
sourcesRoute.get("/sources/stats", async (c) => {
  const sql = getDb();

  const [stats] = await sql<any[]>`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN active THEN 1 END) as active,
      COUNT(CASE WHEN NOT active THEN 1 END) as inactive,
      COUNT(CASE WHEN active AND error_count > 5 THEN 1 END) as erroring,
      COUNT(CASE WHEN active AND last_success_at > now() - interval '24 hours' THEN 1 END) as active_24h,
      COUNT(CASE WHEN active AND last_success_at IS NULL THEN 1 END) as never_succeeded,
      COUNT(CASE WHEN source_type = 'rss' THEN 1 END) as rss,
      COUNT(CASE WHEN source_type = 'web' THEN 1 END) as web,
      COUNT(CASE WHEN source_type = 'json' THEN 1 END) as json_sources,
      COUNT(DISTINCT country) as countries
    FROM news_sources
  `;

  const byCountry = await sql<any[]>`
    SELECT country, COUNT(*) as n,
           COUNT(CASE WHEN active THEN 1 END) as active
    FROM news_sources
    GROUP BY country
    ORDER BY n DESC
    LIMIT 30
  `;

  // Response size cap (Tier response-size-caps, Audit 4): the region
  // vocabulary is unbounded (free-text) — cap at 100 so a future
  // typo like region='%' doesn't ship every row in the table.
  const byRegion = await sql<any[]>`
    SELECT region, COUNT(*) as n,
           COUNT(CASE WHEN active THEN 1 END) as active
    FROM news_sources
    GROUP BY region
    ORDER BY n DESC
    LIMIT 100
  `;

  return c.json({
    total: Number(stats.total),
    active: Number(stats.active),
    inactive: Number(stats.inactive),
    erroring: Number(stats.erroring),
    active_24h: Number(stats.active_24h),
    never_succeeded: Number(stats.never_succeeded),
    rss: Number(stats.rss),
    web: Number(stats.web),
    json: Number(stats.json_sources),
    countries: Number(stats.countries),
    by_country: byCountry.map((r) => ({ country: r.country, total: Number(r.n), active: Number(r.active) })),
    by_region: byRegion.map((r) => ({ region: r.region, total: Number(r.n), active: Number(r.active) })),
    by_region_capped: byRegion.length >= 100,
  });
});

// ── POST /api/sources/discover ───────────────────────────────────────
// Search the internet for new news sources matching a query.
// Spawns the Python source_discovery module and returns results.
const DiscoverSchema = z.object({
  query: z.string().min(1).max(200),
  country: z.string().length(2).optional(),
  strategies: z.array(z.enum(["probe", "web", "directory", "ai"])).optional(),
});

sourcesRoute.post(
  "/sources/discover",
  zValidator("json", DiscoverSchema),
  async (c) => {
    // Gate ["super"]: source-discovery spawns a Python worker that
    // costs $$$ in AI calls (the "ai" strategy) and the public
    // discover panel is for the help page (admin-only).
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const ip = getClientIp(c.req.raw);
    const rl = searchLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const { query, country, strategies } = c.req.valid("json");

    // Fire through the unified queue entry point. This route is SYNC
    // (the frontend at public_html/help/index.html:1087 reads the
    // discovery result directly off the response), so we use sync-wait
    // up to the kind's default timeout (120s). If the worker exceeds
    // that, enqueueOrSpawn throws and we surface a 500 — the
    // alternative would be to return a 202 + statusUrl, which would
    // break the frontend.
    try {
      const result = await enqueueOrSpawn<Record<string, unknown>>(
        "sources_audit",
        { op: "discover", query, country, strategies },
        { waitMs: 65_000, enqueuedBy: "api/sources/discover" },
      );
      if (result.kind === "async") {
        // Should not happen with waitMs > 0, but TypeScript narrows it.
        return c.json(result, 202);
      }
      return c.json(result.result);
    } catch (e: any) {
      console.error("[sources:discover] worker failed:", e?.message ?? e);
      return c.json({
        error: "discovery_failed",
        message: typeof e?.message === "string" ? e.message.slice(-500) : "unknown",
      }, 500);
    }
  }
);

// ── POST /api/sources/add ────────────────────────────────────────────
// Add a single news source.

// FIX_NOTES 2.2 (partial): a registered feed_url is fetched by the
// root-run fetcher, so restrict scheme + reject obviously private targets
// at insert time. Full resolve-then-validate belongs in the fetcher
// (see FIX_NOTES §5 backlog).
const PublicFeedUrl = z.string().url().refine((u) => {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const h = url.hostname;
    if (/^(localhost|.*\.(local|internal|lan))$/i.test(h)) return false;
    if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "::1" || h.startsWith("[fc") || h.startsWith("[fe80")) return false;
    return true;
  } catch { return false; }
}, { message: "feed_url must be a public http(s) URL" });

const AddSourceSchema = z.object({
  name: z.string().min(1).max(200),
  feed_url: PublicFeedUrl,
  country: z.string().length(2).optional(),
  language: z.string().max(5).optional().default("en"),
  region: z.string().max(50).optional().default("global"),
  source_type: z.enum(["rss", "web", "json"]).optional().default("rss"),
  description: z.string().max(500).optional(),
  homepage_url: z.string().url().optional(),
});

sourcesRoute.post(
  "/sources/add",
  zValidator("json", AddSourceSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = addLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();

    // Check if already exists
    const existing = await sql<any[]>`
      SELECT id, name FROM news_sources WHERE feed_url = ${data.feed_url}
    `;
    if (existing.length > 0) {
      return c.json({
        added: false,
        source_id: Number(existing[0].id),
        reason: `already_exists (${existing[0].name})`,
      });
    }

    // Insert
    const rows = await sql<any[]>`
      INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active, homepage_url)
      VALUES (${data.name}, ${data.feed_url}, ${data.country || null}, ${data.language}, ${data.region}, ${data.source_type}, TRUE, ${data.homepage_url ?? null})
      ON CONFLICT (feed_url) DO NOTHING
      RETURNING id
    `;

    const sourceId = rows.length > 0 ? Number(rows[0].id) : null;

    return c.json({
      added: sourceId !== null,
      source_id: sourceId,
      reason: sourceId ? "added" : "conflict",
    });
  }
);

// ── POST /api/sources/bulk-add ───────────────────────────────────────
// Add multiple sources at once.
const BulkAddSchema = z.object({
  sources: z.array(AddSourceSchema).min(1).max(50),
});

sourcesRoute.post(
  "/sources/bulk-add",
  zValidator("json", BulkAddSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = addLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const { sources } = c.req.valid("json");
    const sql = getDb();

    let added = 0;
    let skipped = 0;
    const results: any[] = [];

    for (const src of sources) {
      const existing = await sql<any[]>`
        SELECT id, name FROM news_sources WHERE feed_url = ${src.feed_url}
      `;
      if (existing.length > 0) {
        results.push({ feed_url: src.feed_url, added: false, reason: "already_exists" });
        skipped++;
        continue;
      }

      try {
        const rows = await sql<any[]>`
          INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active, homepage_url)
          VALUES (${src.name}, ${src.feed_url}, ${src.country || null}, ${src.language || "en"}, ${src.region || "global"}, ${src.source_type || "rss"}, TRUE, ${src.homepage_url ?? null})
          ON CONFLICT (feed_url) DO NOTHING
          RETURNING id
        `;
        if (rows.length > 0) {
          results.push({ feed_url: src.feed_url, added: true, source_id: Number(rows[0].id) });
          added++;
        } else {
          results.push({ feed_url: src.feed_url, added: false, reason: "conflict" });
          skipped++;
        }
      } catch (e) {
        results.push({ feed_url: src.feed_url, added: false, reason: "error" });
        skipped++;
      }
    }

    return c.json({ total: sources.length, added, skipped, results });
  }
);

// ── Tier 1.4: source soft-delete ───────────────────────────────────────
// There is no DELETE endpoint for sources in this API — sources are
// retired via the Python scripts/remove_source.py script or by direct
// SQL. Operators should set `news_sources.deleted_at = now()` instead
// of running DELETE FROM news_sources; the FK on news_articles.source_id
// is now ON DELETE SET NULL (Tier 1.4), so articles are preserved with
// source_id set to NULL — the rankings / leaderboard / public source
// lists rely on `deleted_at IS NULL` to filter retired sources out of
// the user-facing surface.
//
// If a future DELETE endpoint is added, it MUST soft-delete via:
//   UPDATE news_sources SET deleted_at = now()
//     WHERE id = ${id} AND deleted_at IS NULL
// so the audit history + article links + interaction log stay intact.

// ── POST /api/sources/:id/toggle ─────────────────────────────────────
// Toggle a source active/inactive.
sourcesRoute.post("/sources/:id/toggle", async (c) => {
  // Tier 1.6: gate — toggles any source's active flag (could take a
  // legitimate source offline). Super admin only.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const sql = getDb();
  const rows = await sql<any[]>`
    UPDATE news_sources SET active = NOT active
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id, name, active
  `;

  if (rows.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json({
    id: Number(rows[0].id),
    name: rows[0].name,
    active: rows[0].active,
  });
});

// ── POST /api/sources/:id/reset-errors ───────────────────────────────
// Reset error count for a source.
sourcesRoute.post("/sources/:id/reset-errors", async (c) => {
  // Tier 1.6: gate — clears a source's error counter, which controls
  // whether the next ingest cycle disables it. Super admin only.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const sql = getDb();
  await sql`UPDATE news_sources SET error_count = 0 WHERE id = ${id}`;

  return c.json({ ok: true, id });
});

// ── GET /api/density/analyze ─────────────────────────────────────────
// Analyze pin density across the map. Returns clusters with dynamic
// thresholds based on city population.
sourcesRoute.get("/density/analyze", async (c) => {
  // Tier 1.6: gate — spawns a Python worker (CPU + DB scan) and exposes
  // cluster layout. Super admin only.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const hours = Math.min(Number(c.req.query("hours") || 168), 720);

  // Spawn Python worker for analysis
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const exitCode: number = await new Promise((resolve) => {
    const child = spawn("/usr/bin/python3.11", ["-c", `
import json
from worker.density import analyze_density
result = analyze_density(${hours})
print(json.dumps(result, default=str))
`], {
      cwd: "/var/www/vhosts/xyzo.org",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      timeout: 30_000,
    });
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.on("close", (code) => resolve(code ?? -1));
  });

  if (exitCode !== 0) {
    return c.json({ error: "analysis_failed", message: Buffer.concat(stderr).toString().slice(-300) }, 500);
  }

  try {
    return c.json(JSON.parse(Buffer.concat(stdout).toString().trim()));
  } catch {
    return c.json({ error: "bad_output" }, 500);
  }
});

// ── POST /api/density/auto-correct ───────────────────────────────────
// Run density analysis and auto-correct mislocated pins.
// Runs in background — returns immediately with a job ID.
// Poll GET /api/density/status/:jobId for progress.
// Body: { bbox?: [minLng, minLat, maxLng, maxLat] }

sourcesRoute.post("/density/auto-correct", async (c) => {
  // Tier 1.6: gate — enqueues an expensive sources_audit job that runs
  // AI / relocation work. Repeat calls are a DoS / cost-incurrence vector.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const ip = getClientIp(c.req.raw);
  const rl = searchLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  // Parse optional bbox from body
  let bbox: number[] | null = null;
  try {
    const body = await c.req.json();
    if (body.bbox && Array.isArray(body.bbox) && body.bbox.length === 4) {
      bbox = body.bbox;
    }
  } catch {}

  // Fire through the unified queue entry point with waitMs: 0 (fire-
  // and-forget) — the worker runs in the background and the polling
  // endpoint below reads progress from discovery_jobs.
  const result = await enqueueOrSpawn<unknown>(
    "sources_audit",
    { op: "auto_correct", bbox },
    { waitMs: 0, enqueuedBy: "api/density/auto-correct" },
  );
  // Queue path is always async; result.requestId is the UUID stored in
  // discovery_jobs that the status endpoint reads.
  const responseJobId =
    result.kind === "async" ? result.requestId : null;
  if (!responseJobId) {
    return c.json({ error: "queue_unavailable" }, 503);
  }
  return c.json({
    ok: true,
    job_id: responseJobId,
    message: "Density correction started",
  });
});

// ── POST /api/density/relocate ──────────────────────────────────────
// Relocate mislocated articles using non-AI text parsing.
// Runs in background — returns immediately with a job ID.
sourcesRoute.post("/density/relocate", async (c) => {
  // Tier 1.6: gate — enqueues an expensive sources_audit job that
  // rewrites article locations. Repeat calls are a DoS vector.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const ip = getClientIp(c.req.raw);
  const rl = searchLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  // Fire through the unified queue entry point with waitMs: 0 (fire-
  // and-forget). Same pattern as /density/auto-correct above; the
  // worker writes progress via ctx.progress which the status endpoint
  // surfaces.
  const result = await enqueueOrSpawn<unknown>(
    "sources_audit",
    { op: "relocate", limit: 200, only_flagged: true },
    { waitMs: 0, enqueuedBy: "api/density/relocate" },
  );
  const responseJobId =
    result.kind === "async" ? result.requestId : null;
  if (!responseJobId) {
    return c.json({ error: "queue_unavailable" }, 503);
  }
  return c.json({
    ok: true,
    job_id: responseJobId,
    message: "Relocation started",
  });
});

// ── GET /api/density/status/:jobId ───────────────────────────────────
//
// Polls the status of a background density job started by either
// /density/auto-correct or /density/relocate. Reads from discovery_jobs
// (the queue is the only path); the worker writes state jsonb + result
// via ctx.progress, and we mirror the legacy response shape (status /
// elapsed_ms / result / error / progress) the frontend already consumes.
sourcesRoute.get("/density/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const job = await getJob(jobId);
  if (!job) {
    return c.json({ error: "not_found" }, 404);
  }
  const state = (job.state ?? {}) as Record<string, unknown>;
  // Queue `result` is the dict the handler returned; surface it as
  // the legacy `result` field so the frontend's `r.relocated /
  // r.spread / r.flagged_for_ai` rendering keeps working.
  const result = (job.result ?? null) as any;
  let status: "running" | "done" | "error" = "running";
  if (job.status === "completed") status = "done";
  else if (job.status === "failed" || job.status === "cancelled") status = "error";
  return c.json({
    status,
    elapsed_ms:
      job.started_at
        ? Date.now() - new Date(job.started_at).getTime()
        : 0,
    result: status === "done" ? result : null,
    error:
      status === "error"
        ? job.error || (job.status === "cancelled" ? "cancelled" : "unknown")
        : null,
    // The handler writes `state = {step, detail}` only — the legacy
    // shape had `current`, `total`, `article_title`, `article_url`,
    // `updated_at` too. Fill them in as nulls so the frontend's
    // `progress.detail / progress.article_title / progress.current /
    // progress.total` reads don't crash on undefined.
    progress: state && Object.keys(state).length
      ? {
          step: state.step ?? null,
          detail: state.detail ?? null,
          current: state.current ?? 0,
          total: state.total ?? 0,
          article_title: state.article_title ?? "",
          article_url: state.article_url ?? "",
          updated_at: state.updated_at ?? null,
        }
      : null,
  });
});

// ── GET /api/sources/discover/metrics ───────────────────────────────
// Source-discovery pipeline metrics for the admin /help diagnostics
// panel. Reads from discovery_jobs (the unified queue) filtered to the
// discovery-related job kinds — explore_region is the auto-explorer,
// sources_audit is the polite-poll re-checker, and analytics_inline is
// the inline analytics sweep. Returns aggregate counts since N hours ago.
//
// Caller: help/index.html:2260. T-13 closes the silent 404 that
// previously surfaced as "Failed to load" in the metrics card.
const DiscoverMetricsSchema = z.object({
  hours: z.coerce.number().int().min(1).max(8760).optional().default(24),
});

sourcesRoute.get(
  "/sources/discover/metrics",
  zValidator("query", DiscoverMetricsSchema),
  async (c) => {
    // Gate ["super"]: discovery queue depth + failure counts are
    // operator-only (internal queue telemetry).
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const { hours } = c.req.valid("query");
    const sql = getDb();
    const rows = await sql<{
      status: string;
      n: string;
    }[]>`
      SELECT status, COUNT(*) AS n
      FROM discovery_jobs
      WHERE kind IN ('explore_region', 'sources_audit', 'analytics_inline')
        AND scheduled_at >= now() - (${hours}::text || ' hours')::interval
      GROUP BY status
    `;
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      counts[r.status] = Number(r.n);
      total += Number(r.n);
    }
    return c.json({
      hours,
      total_runs: total,
      by_status: counts,
      note: "Counts derived from discovery_jobs where kind in (explore_region, sources_audit, analytics_inline).",
    });
  },
);

// ── GET /api/sources/:id/articles ─────────────────────────────────────
// Returns recent articles from a specific news source.
// Used by the "Near Me" / local sources panel in the live feed.
sourcesRoute.get("/sources/:id/articles", async (c) => {
  const sourceId = Number(c.req.param("id"));
  if (!Number.isFinite(sourceId)) {
    return c.json({ error: "invalid_source_id" }, 400);
  }
  const limit = Math.min(Number(c.req.query("limit") ?? 10), 50);

  const sql = getDb();
  const rows = await sql<Array<{
    id: number;
    title: string | null;
    url: string | null;
    published_at: Date | null;
    place_name: string | null;
    lat: number | null;
    lng: number | null;
  }>>`
    SELECT a.id, a.title, a.url, a.published_at,
           l.place_name,
           l.lat, l.lng
    FROM news_articles a
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE a.source_id = ${sourceId}
    ORDER BY a.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;

  return c.json({
    articles: rows.map(r => ({
      id: Number(r.id),
      title: r.title,
      url: r.url,
      published_at: r.published_at?.toISOString() ?? null,
      location: (r.lat != null && r.lng != null) ? {
        lat: r.lat,
        lng: r.lng,
        place_name: r.place_name,
      } : null,
    })),
  });
});

// ── GET /api/sources/health ────────────────────────────────────────
// Comprehensive source health dashboard for ops monitoring.
// Returns aggregate health metrics across all sources.
const HealthQuerySchema = z.object({
  country: z.string().optional(),
});

sourcesRoute.get(
  "/sources/health",
  zValidator("query", HealthQuerySchema),
  async (c) => {
    const { country } = c.req.valid("query");
    const sql = getDb();

    const whereClause = country
      ? sql`WHERE s.country = ${country.toUpperCase()}`
      : sql``;

    // Aggregate source health metrics
    const sourceHealth = await sql<any[]>`
      SELECT
        COUNT(*) as total_sources,
        COUNT(*) FILTER (WHERE s.active = true) as active_sources,
        COUNT(*) FILTER (WHERE s.active = false) as inactive_sources,
        COUNT(*) FILTER (WHERE s.error_count = 0 AND s.active = true) as healthy_sources,
        COUNT(*) FILTER (WHERE s.error_count > 0 AND s.error_count <= 10 AND s.active = true) as low_error_sources,
        COUNT(*) FILTER (WHERE s.error_count > 10 AND s.error_count <= 50 AND s.active = true) as medium_error_sources,
        COUNT(*) FILTER (WHERE s.error_count > 50 AND s.active = true) as high_error_sources,
        COUNT(*) FILTER (WHERE s.active = true AND s.last_success_at < now() - interval '7 days') as stale_sources,
        COUNT(*) FILTER (WHERE s.active = true AND s.last_success_at IS NULL) as never_fetched_sources,
        AVG(s.reliability_score) FILTER (WHERE s.active = true AND s.reliability_score IS NOT NULL) as avg_reliability
      FROM news_sources s
      ${whereClause}
    `;

    // Cold sources (no articles in 7 days)
    // FIX_NOTES 4.22: HAVING without GROUP BY aggregated the WHOLE table
    // into one row — the count only appeared when literally every source
    // was cold, so `cold` always reported 0.
    const coldSources = await sql<any[]>`
      SELECT COUNT(*) as count FROM (
        SELECT s.id
        FROM news_sources s
        LEFT JOIN news_articles a ON s.id = a.source_id AND a.published_at > now() - interval '7 days'
        WHERE s.active = true ${country ? sql`AND s.country = ${country.toUpperCase()}` : sql``}
        GROUP BY s.id
        HAVING COUNT(a.id) = 0
      ) cold
    `;

    // Articles in last 24h, 7d, 30d
    const articleStats = await sql<any[]>`
      SELECT
        COUNT(*) FILTER (WHERE published_at > now() - interval '24 hours') as articles_24h,
        COUNT(*) FILTER (WHERE published_at > now() - interval '7 days') as articles_7d,
        COUNT(*) FILTER (WHERE published_at > now() - interval '30 days') as articles_30d,
        COUNT(*) FILTER (WHERE location_id IS NULL AND published_at > now() - interval '7 days') as unlocated_7d
      FROM news_articles a
      ${country ? sql`WHERE a.source_id IN (SELECT id FROM news_sources WHERE country = ${country.toUpperCase()})` : sql``}
    `;

    // Top countries by source count
    const topCountries = await sql<any[]>`
      SELECT s.country, COUNT(*) as source_count,
             COUNT(*) FILTER (WHERE s.active = true) as active_count,
             COUNT(*) FILTER (WHERE s.error_count > 50) as high_error_count
      FROM news_sources s
      WHERE s.country IS NOT NULL AND s.country != ''
      GROUP BY s.country
      ORDER BY source_count DESC
      LIMIT 20
    `;

    // Cross-country contamination count (sources with primary_city_id in wrong country)
    const contaminationCheck = await sql<any[]>`
      SELECT COUNT(*) as misassigned_count
      FROM news_sources s
      JOIN world_cities wc ON s.primary_city_id = wc.id
      WHERE s.primary_city_id IS NOT NULL
        AND s.active = true
        AND wc.country_code != s.country
        AND s.country IS NOT NULL AND s.country != ''
    `;

    return c.json({
      source_health: {
        total: Number(sourceHealth[0]?.total_sources ?? 0),
        active: Number(sourceHealth[0]?.active_sources ?? 0),
        inactive: Number(sourceHealth[0]?.inactive_sources ?? 0),
        healthy: Number(sourceHealth[0]?.healthy_sources ?? 0),
        low_error: Number(sourceHealth[0]?.low_error_sources ?? 0),
        medium_error: Number(sourceHealth[0]?.medium_error_sources ?? 0),
        high_error: Number(sourceHealth[0]?.high_error_sources ?? 0),
        stale: Number(sourceHealth[0]?.stale_sources ?? 0),
        never_fetched: Number(sourceHealth[0]?.never_fetched_sources ?? 0),
        cold: Number(coldSources[0]?.count ?? 0),
        avg_reliability: Number(sourceHealth[0]?.avg_reliability ?? 0).toFixed(3),
      },
      article_stats: {
        last_24h: Number(articleStats[0]?.articles_24h ?? 0),
        last_7d: Number(articleStats[0]?.articles_7d ?? 0),
        last_30d: Number(articleStats[0]?.articles_30d ?? 0),
        unlocated_7d: Number(articleStats[0]?.unlocated_7d ?? 0),
      },
      contamination: {
        misassigned_primary_city: Number(contaminationCheck[0]?.misassigned_count ?? 0),
      },
      top_countries: topCountries.map(r => ({
        country: r.country,
        sources: Number(r.source_count),
        active: Number(r.active_count),
        high_error: Number(r.high_error_count),
      })),
      timestamp: new Date().toISOString(),
    });
  },
);
