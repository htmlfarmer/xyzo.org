import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { getDb } from "../db";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { getJob, requestCancel } from "../queue/jobQueue";
import { cancelJob as poolCancelJob } from "../queue/workerPool";
import { adminAuth } from "../auth";
import { JobTimeoutError } from "../queue/errors";

// Response size caps (Tier response-size-caps, Audit 4):
// - /api/region-sources: max 200 per page (was unbounded — country/region
//   wildcards could match hundreds of sources). limit > 400 rejected with
//   400 limit_too_large. Response now includes `pagination: { limit,
//   has_more }`.

// Required — no default. A misconfigured deploy must fail loudly rather than
// silently spawn workers against a fallback database.
function requireDbDsn(): string {
  const dsn = process.env.XYZO_DB_URL ?? process.env.NEWSIUM_DB_URL;
  if (!dsn) throw new Error("XYZO_DB_URL (or NEWSIUM_DB_URL legacy alias) is required");
  return dsn;
}

// Track active discovery child processes so we can cancel them.
const activeChildren = new Map<number, { child: ReturnType<typeof spawn>; startedAt: number }>();

// Server-side cooldown: tracks when discovery was last triggered for each area.
// Shared across all users — if one user triggers discovery for an area,
// other users won't re-trigger it for 5 minutes.
const discoveryCooldowns = new Map<string, number>(); // bbox_key → timestamp
const DISCOVER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function getBboxKey(bbox: number[]): string {
  // Round to ~10km grid so nearby areas share cooldown
  return bbox.map(n => Math.round(n * 10) / 10).join(",");
}

function isCoolingDown(bbox: number[]): { cooling: boolean; remaining_s: number } {
  const key = getBboxKey(bbox);
  const lastRun = discoveryCooldowns.get(key);
  if (!lastRun) return { cooling: false, remaining_s: 0 };
  const elapsed = Date.now() - lastRun;
  if (elapsed >= DISCOVER_COOLDOWN_MS) return { cooling: false, remaining_s: 0 };
  return { cooling: true, remaining_s: Math.ceil((DISCOVER_COOLDOWN_MS - elapsed) / 1000) };
}

function setCooldown(bbox: number[]): void {
  const key = getBboxKey(bbox);
  discoveryCooldowns.set(key, Date.now());
  // Clean up old entries periodically
  if (discoveryCooldowns.size > 1000) {
    const now = Date.now();
    for (const [k, v] of discoveryCooldowns) {
      if (now - v > DISCOVER_COOLDOWN_MS * 2) discoveryCooldowns.delete(k);
    }
  }
}

// Shared directory for live discovery status files. The auto-discover
// endpoint points the worker at /var/log/newsium/discovery-<id>.json;
// the polling endpoint reads the same file on each tick and merges the
// data with DB-derived counts. Idempotent: a worker can be spawned
// multiple times against different ids without overwriting.
// Per-request worker progress files. Stored under the project's gitignored
// `logs/` directory rather than /var/log/newsium so the API (running as
// the project's user) and the spawned worker can write there without
// needing sudo. Each request gets its own file: discovery-<id>.json.
const STATUS_DIR = process.env.NEWSIUM_STATUS_DIR ?? "/var/www/vhosts/xyzo.org/logs/discovery-status";

export const exploreRoute = new Hono();

// Rate limiter: 10 requests per hour per IP (expensive operation)
const exploreLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

// Validation schema for the explore-region request. Accepts either the
// legacy `"bbox": "minLng,minLat,maxLng,maxLat"` string OR the explicit
// `{min_lng, min_lat, max_lng, max_lat}` shape used by callers that don't
// pre-encode the bbox (e.g. the live smoke harness). Both shapes are
// normalized to `bbox: [minLng,minLat,maxLng,maxLat]` before enqueue.
const ExploreRegionSchema = z.object({
  bbox: z.string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .transform((s) => s.split(",").map(Number))
    .optional(),
  min_lng: z.number().optional(),
  min_lat: z.number().optional(),
  max_lng: z.number().optional(),
  max_lat: z.number().optional(),
  auto_add: z.boolean().optional().default(false),
  // Optional topic filter (e.g. "technology", "sports"). The worker uses
  // this to bias both the AI prompt and the DuckDuckGo queries.
  category_hint: z.string().min(1).max(60).optional(),
});

// ── POST /api/explore-region ────────────────────────────────────────────
//
// Explore a geographic region to discover news sources and existing news.
// Takes a bounding box from the map viewport, finds cities, searches the
// DB for existing news, and optionally discovers new RSS sources via AI.
//
// This is a synchronous endpoint that spawns the Python worker and waits
// for results (up to 60s). The worker does the heavy lifting:
//   - Nominatim city lookup
//   - DB search for existing articles/events
//   - AI-powered news source discovery
//   - RSS feed validation
//   - Optional auto-addition to feeds registry
exploreRoute.post(
  "/explore-region",
  zValidator("json", ExploreRegionSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = exploreLimiter.check(ip);
    if (!rl.allowed) {
      const sec = Math.ceil(rl.retryAfterMs / 1000);
      return c.json({ error: "rate_limited", retry_after_s: sec }, 429);
    }

    const data = c.req.valid("json");
    let bbox: number[];
    if (data.bbox) {
      bbox = data.bbox;
    } else if (
      data.min_lng !== undefined && data.min_lat !== undefined &&
      data.max_lng !== undefined && data.max_lat !== undefined
    ) {
      bbox = [data.min_lng, data.min_lat, data.max_lng, data.max_lat];
    } else {
      return c.json({ error: "bbox_required" }, 400);
    }
    const auto_add = data.auto_add;
    const category_hint = data.category_hint;
    console.log(`[explore] bbox=${bbox} auto_add=${auto_add} category=${category_hint ?? "-"} — enqueueing worker`);

    // Sync-wait up to 75s for the worker to complete. The frontend
    // (app.js renderExploreResults) reads `cities`/`existing_news`/etc.
    // directly off the response, so the queue path must return the same
    // synchronous shape the legacy spawn returned. waitMs matches
    // KIND_CONFIG.explore_region.defaultTimeoutMs.
    try {
      const result = await enqueueOrSpawn(
        "explore_region",
        { bbox, auto_add, category_hint },
        { waitMs: 75_000, enqueuedBy: "api/explore-region" },
      );

      if (result.kind === "async") {
        return c.json(result, 202);
      }
      return c.json(result.result);
    } catch (e: any) {
      if (e instanceof JobTimeoutError) {
        const job = await getJob(e.jobId);
        if (job) {
          if (job.status === "completed" && job.result) {
            return c.json(job.result);
          }
          return c.json(
            {
              kind: "async",
              requestId: job.id,
              statusUrl: `/api/discovery-status/${job.id}`,
              message: "Discovery is taking longer than expected. Polling for results...",
            },
            202,
          );
        }
      }
      throw e;
    }
  },
);

// ── POST /api/explore-region/add-sources ─────────────────────────────────
//
// Take the already-validated sources returned by `renderExploreResults`
// (i.e. feeds the explore pipeline already probed and accepted) and insert
// them into `news_sources` WITHOUT re-running discovery, geocoding, or
// feed validation. Skips duplicates by `feed_url`.
//
// Mirrors the worker's `add_source_to_feeds()` shape but is intentionally
// minimal: no feeds.json mutation, no Nominatim geocode (sources will be
// geocoded on demand by the next fetch cycle when they have articles).
// The trade-off is faster UI feedback at the cost of slightly less eager
// spatial coverage on `news_sources.lat` / `news_sources.lng`.
const addSourcesLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

const AddSourcesSchema = z.object({
  sources: z.array(z.object({
    name: z.string().min(1).max(200),
    feed_url: z.string().url().refine(
      (s) => { try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } },
      { message: "must be http(s)" },
    ),
    country: z.string().max(8).optional(),
    language: z.string().max(10).optional(),
    region: z.string().max(80).optional(),
    description: z.string().max(1000).optional(),
    homepage_url: z.string().url().optional(),
  })).min(1).max(50),
});

exploreRoute.post(
  "/explore-region/add-sources",
  zValidator("json", AddSourcesSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = addSourcesLimiter.check(ip);
    if (!rl.allowed) {
      const sec = Math.ceil(rl.retryAfterMs / 1000);
      return c.json({ error: "rate_limited", retry_after_s: sec }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();
    let added = 0;
    let skipped = 0;
    const addedIds: number[] = [];
    const errors: Array<{ name: string; feed_url: string; reason: string }> = [];

    for (const src of data.sources) {
      const feedUrl = src.feed_url.trim();
      const name = src.name.trim();
      try {
        // Pre-check so we can surface the difference between "duplicate"
        // and "real DB error" in `errors`. We still rely on
        // ON CONFLICT DO NOTHING as the authoritative dedupe gate — the
        // SELECT is only for telemetry on the response.
        const existing = await sql<Array<{ id: number | bigint }>>`
          SELECT id FROM news_sources WHERE feed_url = ${feedUrl} LIMIT 1
        `;
        if (existing.length > 0) {
          skipped += 1;
          continue;
        }

        const inserted = await sql<Array<{ id: number | bigint }>>`
          INSERT INTO news_sources (
            name, feed_url, country, language, region,
            source_type, active, homepage_url
          ) VALUES (
            ${name},
            ${feedUrl},
            ${src.country ?? null},
            ${src.language ?? "en"},
            ${src.region ?? "unknown"},
            'rss',
            TRUE,
            ${src.homepage_url ?? null}
          )
          ON CONFLICT (feed_url) DO NOTHING
          RETURNING id
        `;
        const row = inserted[0];
        if (row?.id != null) {
          added += 1;
          addedIds.push(Number(row.id));
        } else {
          // Lost the race — another writer inserted between our SELECT
          // and INSERT. Treat as duplicate.
          skipped += 1;
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[add-sources] insert failed for ${name} (${feedUrl}):`, reason);
        errors.push({ name, feed_url: feedUrl, reason });
      }
    }

    console.log(
      `[add-sources] added=${added} skipped=${skipped} errors=${errors.length}`,
    );

    // Trigger a fetch cycle for newly-added sources so articles appear
    // quickly on the map instead of waiting for the next timer tick.
    if (added > 0) {
      setTimeout(() => {
        try {
          enqueueOrSpawn(
            "fetch",
            { limit: 0 },
            { waitMs: 0, enqueuedBy: "api/add-sources/fetch" },
          );
        } catch (e) {
          console.error("[add-sources] Failed to trigger fetch:", e);
        }
      }, 1000); // 1s delay so INSERT is committed before fetch claims the rows
    }

    return c.json({
      added,
      skipped,
      errors,
      added_ids: addedIds,
    });
  },
);

// ── GET /api/region-sources ─────────────────────────────────────────────
//
// Get all news sources that cover a specific region (by country code).
// This is a lightweight query that doesn't spawn a worker.
exploreRoute.get(
  "/region-sources",
  async (c) => {
    const country = c.req.query("country");
    const region = c.req.query("region");

    if (!country && !region) {
      return c.json({ error: "country_or_region_required" }, 400);
    }

    // Response size cap (Audit 4): a country or region wildcard could
    // match hundreds of sources. Hard-cap at 200 and 400 — anything
    // above is rejected so a misconfigured client can't drain the DB.
    const MAX_REGION_SOURCES = 200;
    const requested = Number(c.req.query("limit") ?? 100);
    if (requested > MAX_REGION_SOURCES * 2) {
      return c.json(
        { error: "limit_too_large", max: MAX_REGION_SOURCES * 2 },
        400,
      );
    }
    const limit = Math.min(Math.max(requested, 1), MAX_REGION_SOURCES);

    const sql = getDb();
    let sources;

    if (country) {
      sources = await sql<any[]>`
        SELECT id, name, feed_url, homepage_url, country, language, region, active,
               reliability_score, last_success_at, error_count
        FROM news_sources
        -- Tier 1.4: filter retired sources so they don't leak into public listings.
        WHERE country = ${country.toUpperCase()}
          AND deleted_at IS NULL
        ORDER BY active DESC, reliability_score DESC, name
        LIMIT ${limit}
      `;
    } else if (region) {
      sources = await sql<any[]>`
        SELECT id, name, feed_url, homepage_url, country, language, region, active,
               reliability_score, last_success_at, error_count
        FROM news_sources
        -- Tier 1.4: filter retired sources so they don't leak into public listings.
        WHERE region ILIKE ${"%" + region + "%"}
          AND deleted_at IS NULL
        ORDER BY active DESC, reliability_score DESC, name
        LIMIT ${limit}
      `;
    }

    return c.json({
      country: country?.toUpperCase() || null,
      region: region || null,
      // news_sources.id is BIGSERIAL (int8) — postgres.js hands it back as
      // BigInt and JSON.stringify throws. Coerce before serializing.
      sources: (sources || []).map((s: any) => ({ ...s, id: Number(s.id) })),
      count: sources?.length || 0,
      pagination: { limit, has_more: (sources?.length ?? 0) === limit },
    });
  },
);

// ── POST /api/add-source ────────────────────────────────────────────────
//
// Manually add a news source to the registry. Validates the RSS feed
// before adding. Admin-only endpoint.
exploreRoute.post(
  "/add-source",
  async (c) => {
    // Tier 1.6: gate the endpoint — previously callable by anyone, which
    // made the shell-injection vector (below) exploitable. adminAuth
    // returns 401 for missing/invalid key, 403 for wrong role.
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const ip = getClientIp(c.req.raw);
    const rl = exploreLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }

    const body = await c.req.json();
    const { name, feed_url, country, language, region } = body;

    if (!name || !feed_url) {
      return c.json({ error: "name_and_feed_url_required" }, 400);
    }

    // Tier 1.6: Fix shell injection (CRITICAL from full site audit).
    // User-supplied fields are no longer interpolated into the Python
    // source string; they're passed via sys.argv so quotes/quotes-in-quotes
    // can't escape the Python interpreter. python3 -c receives a fixed
    // literal as argv[0]; everything user-controlled is argv[1..] and
    // is referenced via sys.argv indices — never via string formatting.
    //
    // Source strings like `name = "x"; import os; os.system("id"); x="y"`
    // land as a single argv element and are passed straight to Python as
    // a string value, not executed as code.
    const safeCountry = country || "";
    const safeLanguage = language || "en";
    const safeRegion = region || "unknown";

    // Spawn worker to validate and add
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const exitCode: number = await new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/python3.11",
        [
          "-c",
          `
import json, sys
from worker.explore_region import validate_rss_feed, add_source_to_feeds
name = sys.argv[1]
feed_url = sys.argv[2]
country = sys.argv[3]
language = sys.argv[4]
region = sys.argv[5]
result = validate_rss_feed(feed_url)
if result["valid"]:
    add_result = add_source_to_feeds({
        "name": name,
        "feed_url": feed_url,
        "country": country,
        "language": language,
        "region": region,
        "homepage_url": result.get("homepage_url"),
    })
    print(json.dumps({"validation": result, "add_result": add_result}))
else:
    print(json.dumps({"validation": result, "add_result": None}))
`,
          name,
          feed_url,
          safeCountry,
          safeLanguage,
          safeRegion,
        ],
        {
          cwd: "/var/www/vhosts/xyzo.org",
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          timeout: 30_000,
        },
      );
      child.stdout.on("data", (b: Buffer) => stdout.push(b));
      child.stderr.on("data", (b: Buffer) => stderr.push(b));
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      return c.json({ error: "validation_failed" }, 500);
    }

    try {
      const result = JSON.parse(Buffer.concat(stdout).toString("utf8").trim());
      return c.json(result);
    } catch {
      return c.json({ error: "bad_output" }, 500);
    }
  },
);

// Rate limiter for recommend-news: 20 per hour per IP
const recommendLimiter = new RateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

// Validation schema for recommend-news request
const RecommendNewsSchema = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .transform((s) => s.split(",").map(Number)),
  center_lat: z.number().min(-90).max(90),
  center_lng: z.number().min(-180).max(180),
  map_zoom: z.number().int().min(1).max(20).optional(),
  session_id: z.string().min(1).max(100).optional(),
  message: z.string().max(500).optional(),
});

// ── POST /api/recommend-news ────────────────────────────────────────────
//
// Request AI-powered news discovery for a geographic area.
// Stores the request in the database for future processing.
// Returns immediately with a confirmation.
exploreRoute.post(
  "/recommend-news",
  zValidator("json", RecommendNewsSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = recommendLimiter.check(ip);
    if (!rl.allowed) {
      const sec = Math.ceil(rl.retryAfterMs / 1000);
      return c.json({ error: "rate_limited", retry_after_s: sec }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();

    // Check for recent duplicate from same session
    if (data.session_id) {
      const existing = await sql<any[]>`
        SELECT id FROM news_area_requests
        WHERE session_id = ${data.session_id}
          AND ABS(center_lat - ${data.center_lat}) < 1
          AND ABS(center_lng - ${data.center_lng}) < 1
          AND requested_at > now() - interval '1 hour'
          AND status IN ('pending', 'processing')
        LIMIT 1
      `;
      if (existing.length > 0) {
        return c.json({
          ok: true,
          id: Number(existing[0].id),
          message: "Request already submitted for this area recently.",
          duplicate: true,
        });
      }
    }

    // Insert the request. request_source='recommend-news' is the default,
    // but we set it explicitly so the community-vote filter on
    // news_area_requests_community_idx never sees auto-discover rows
    // even if the schema default ever drifts.
    const rows = await sql<any[]>`
      INSERT INTO news_area_requests (
        bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng,
        center_lat, center_lng, map_zoom,
        session_id, requester_ip, message,
        request_source
      ) VALUES (
        ${data.bbox[1]}, ${data.bbox[0]}, ${data.bbox[3]}, ${data.bbox[2]},
        ${data.center_lat}, ${data.center_lng}, ${data.map_zoom || null},
        ${data.session_id || null},
        ${ip !== 'unknown' ? ip : null}::inet,
        ${data.message || null},
        'recommend-news'
      )
      RETURNING id
    `;

    const requestId = Number(rows[0].id);
    console.log(`[recommend-news] id=${requestId} center=${data.center_lat},${data.center_lng} zoom=${data.map_zoom}`);

    return c.json({
      ok: true,
      id: requestId,
      message: "Request submitted! We'll prioritize news coverage for this area.",
    });
  },
);

// ── GET /api/recommend-news/recent ──────────────────────────────────────
//
// Get recent recommend-news requests (for admin/debugging)
exploreRoute.get("/recommend-news/recent", async (c) => {
  // Tier 1.6: gate — returns session_id + bbox for every recent request,
  // which is PII / behavioral telemetry. Super admin only.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const limit = Math.min(Number(c.req.query("limit") || 20), 100);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT id, bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng,
           center_lat, center_lng, map_zoom, session_id, message,
           requested_at, status, processed_at
    FROM news_area_requests
    ORDER BY requested_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    requests: rows.map((r) => ({
      id: Number(r.id),
      bbox: [r.bbox_min_lng, r.bbox_min_lat, r.bbox_max_lng, r.bbox_max_lat],
      center: { lat: Number(r.center_lat), lng: Number(r.center_lng) },
      map_zoom: r.map_zoom,
      session_id: r.session_id,
      message: r.message,
      requested_at: r.requested_at,
      status: r.status,
      processed_at: r.processed_at,
    })),
    total: rows.length,
  });
});

// Rate limiter for auto-discover: 5 per hour per IP
const autoDiscoverLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

// Validation schema for auto-discover request
const AutoDiscoverSchema = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .transform((s) => s.split(",").map(Number)),
  center_lat: z.number().min(-90).max(90),
  center_lng: z.number().min(-180).max(180),
  // Leaflet's `getZoom()` can return a fractional value during flyTo's
  // zoom animation (e.g. 9.5 mid-transition). The previous `.int()`
  // constraint rejected those intermediates as 400 and aborted the
  // entire auto-discover before the worker could spawn. Accept the
  // fractional range; we only need a sane zoom level for telemetry.
  map_zoom: z.number().min(0).max(22),
  session_id: z.string().min(1).max(100).optional(),
});

// ── POST /api/auto-discover ──────────────────────────────────────────────
//
// Check if an area has news coverage. If not, automatically discover and
// add news sources for that region, then trigger a fetch cycle.
// Returns immediately with coverage status and discovery results.
exploreRoute.post(
  "/auto-discover",
  zValidator("json", AutoDiscoverSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = autoDiscoverLimiter.check(ip);
    if (!rl.allowed) {
      const sec = Math.ceil(rl.retryAfterMs / 1000);
      return c.json({ error: "rate_limited", retry_after_s: sec }, 429);
    }

    const data = c.req.valid("json");
    // news_area_requests.map_zoom is INTEGER. Leaflet's getZoom() can
    // return a fractional value mid-flyTo; coerce here so the INSERT
    // below doesn't 500. We only use the zoom for telemetry, so
    // rounding is lossless.
    const mapZoom = Math.round(data.map_zoom);
    const sql = getDb();

    // Check existing coverage in this area
    const [minLng, minLat, maxLng, maxLat] = data.bbox;
    const coverage = await sql<any[]>`
      SELECT COUNT(*) as article_count
      FROM news_articles a
      JOIN news_locations l ON l.id = a.location_id
      WHERE l.geom::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
        AND a.status IN ('extracted', 'clustered')
        AND a.fetched_at > now() - interval '7 days'
    `;

    const articleCount = Number(coverage[0]?.article_count || 0);

    // If we have good coverage, just return the status
    if (articleCount >= 10) {
      return c.json({
        has_coverage: true,
        article_count: articleCount,
        message: `Area has ${articleCount} recent articles. No discovery needed.`,
        discovery_triggered: false,
      });
    }

    // Check if we've recently triggered discovery for this area
    const recentRequest = await sql<any[]>`
      SELECT id, status, processed_at
      FROM news_area_requests
      WHERE ABS(center_lat - ${data.center_lat}) < 2
        AND ABS(center_lng - ${data.center_lng}) < 2
        AND requested_at > now() - interval '2 hours'
      ORDER BY requested_at DESC
      LIMIT 1
    `;

    if (recentRequest.length > 0 && recentRequest[0].status === 'completed') {
      return c.json({
        has_coverage: false,
        article_count: articleCount,
        message: `Area has ${articleCount} articles. Discovery was recently completed.`,
        discovery_triggered: false,
        recent_request_id: Number(recentRequest[0].id),
      });
    }

    // Trigger discovery in background using the queue system
    console.log(`[auto-discover] Low coverage (${articleCount} articles) at ${data.center_lat},${data.center_lng} zoom=${data.map_zoom}`);

    // We need the request id BEFORE enqueueing so we can track it. Insert
    // the request row first, then enqueue with that id.
    const requestRows = await sql<any[]>`
      INSERT INTO news_area_requests (
        bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng,
        center_lat, center_lng, map_zoom,
        session_id, requester_ip, message, status,
        request_source
      ) VALUES (
        ${minLat}, ${minLng}, ${maxLat}, ${maxLng},
        ${data.center_lat}, ${data.center_lng}, ${mapZoom},
        ${data.session_id || null},
        ${ip !== 'unknown' ? ip : null}::inet,
        'Auto-discovery triggered due to low coverage',
        'processing',
        'auto-discover'
      )
      RETURNING id
    `;

    const requestId = Number(requestRows[0].id);

    try {
      // Use the queue system instead of direct spawn for proper progress tracking
      const result = await enqueueOrSpawn(
        "explore_region",
        { bbox: [minLng, minLat, maxLng, maxLat], auto_add: true, category_hint: null, request_id: requestId },
        { waitMs: 0, enqueuedBy: "api/auto-discover" }, // Don't wait, return immediately
      );

      if (result.kind === "async") {
        // Also trigger a fetch cycle for existing sources after a delay
        setTimeout(() => {
          try {
            enqueueOrSpawn(
              "fetch",
              { limit: 0 }, // 0 = drain, no per-cycle cap
              { waitMs: 0, enqueuedBy: "api/auto-discover/fetch" },
            );
          } catch (e) {
            console.error("[auto-discover] Failed to trigger fetch:", e);
          }
        }, 5000); // 5 second delay

        return c.json({
          has_coverage: false,
          article_count: articleCount,
          message: `Area has only ${articleCount} articles. Discovering news sources...`,
          discovery_triggered: true,
          request_id: requestId,
          job_id: result.requestId, // UUID from queue system
          status_url: `/api/discovery-status/${result.requestId}`,
          estimated_time_seconds: 30,
        });
      } else {
        // Completed synchronously (unlikely but possible)
        await sql`UPDATE news_area_requests SET status = 'completed', processed_at = now() WHERE id = ${requestId}`;
        return c.json({
          has_coverage: false,
          article_count: articleCount,
          message: `Area has only ${articleCount} articles. Discovery completed.`,
          discovery_triggered: true,
          request_id: requestId,
          result: result.result,
        });
      }
    } catch (e: any) {
      console.error("[auto-discover] Failed to enqueue discovery:", e);
      await sql`UPDATE news_area_requests SET status = 'failed', processed_at = now(), message = ${e.message || 'Unknown error'} WHERE id = ${requestId}`;
      throw e;
    }

    return c.json({
      has_coverage: false,
      article_count: articleCount,
      message: `Area has only ${articleCount} articles. Discovering news sources...`,
      discovery_triggered: true,
      request_id: requestId,
      estimated_time_seconds: 30,
    });
  }
);

// ── GET /api/discovery-status/:id ─────────────────────────────────────────
//
// Get real-time status of a discovery request. Reads from the
// `discovery_jobs` row populated by the queue (workerPool → statusWriter):
//   * `state` jsonb holds the in-flight progress (current_step,
//     step_detail, progress, counters, recent_articles, recent_sources,
//     center, elapsed_seconds) — produced by the dispatcher's ctx-aware
//     handler.
//   * Top-level columns (`status`, `started_at`, `finished_at`,
//     `error`, `attempts`, `cancel_requested`) come straight from the
//     job row.
// The response shape mirrors the pre-migration file-backed handler so
// the frontend polling loop keeps working without changes.
exploreRoute.get("/discovery-status/:id", async (c) => {
  const id = c.req.param("id");

  // The id is always a UUID from the queue system (discovery_jobs.id).
  // Both explore-region and auto-discover now use the queue system.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (!isUuid) {
    // Not a valid UUID - return 404
    return c.json({ error: "not_found", message: "Invalid job ID format. Expected UUID." }, 404);
  }

  // ── Queue path: UUID lookup in discovery_jobs ────────────────────────
  let job: Awaited<ReturnType<typeof getJob>>;
  try {
    job = await getJob(id);
  } catch (_e) {
    // getJob throws if the input isn't a valid UUID. We've already
    // gated on `isUuid`, but defensive try/catch keeps any future
    // regex drift from surfacing as 500.
    return c.json({ error: "not_found" }, 404);
  }
  if (!job) {
    return c.json({ error: "not_found" }, 404);
  }

  const state = (job.state ?? {}) as Record<string, unknown>;
  const counters = (state.counters ?? {}) as Record<string, unknown>;
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const payloadBbox = Array.isArray(payload.bbox)
    ? (payload.bbox as number[]).map(Number)
    : null;

  // Map the queue status onto the field names the frontend already
  // consumes. `completed` maps to `completed`; `failed`/`cancelled` are
  // surfaced as-is so the UI can branch on them.
  const status = job.status;
  const currentStep = (state.current_step as string) ?? "detect";
  const stepDetail = (state.step_detail as string) ?? "Starting discovery...";
  // The handler writes `progress` as a 0..1 fraction; the legacy
  // endpoint returned a 0..100 percentage, so scale up here.
  const rawProgress = state.progress;
  const progressPct = typeof rawProgress === "number"
    ? (rawProgress > 1 ? Math.round(rawProgress) : Math.round(rawProgress * 100))
    : 0;
  const elapsedSeconds = typeof state.elapsed_seconds === "number"
    ? Math.round(state.elapsed_seconds)
    : 0;

  const sourcesAdded = Number(counters.sources_added ?? 0);
  const articlesFetched = Number(counters.articles_fetched ?? 0);
  const finalCount =
    status === "completed" || status === "failed"
      ? articlesFetched
      : null;

  return c.json({
    // Frontend looks for both `id` and `request_id` (smoke harness uses
    // request_id). Keep both populated.
    id: job.id,
    request_id: job.id,
    kind: job.kind,
    status,
    attempts: job.attempts,
    error: job.error,
    started_at: job.started_at,
    finished_at: job.finished_at,
    heartbeat_at: job.heartbeat_at,
    cancel_requested: job.cancel_requested,
    // Legacy field names the polling code reads directly.
    current_step: status === "completed" ? "complete" : currentStep,
    step_detail: status === "failed"
      ? "Discovery failed: " + (job.error || "Unknown error")
      : status === "cancelled"
        ? "Discovery was cancelled"
        : stepDetail,
    progress: status === "completed" || status === "failed" || status === "cancelled"
      ? 100
      : progressPct,
    elapsed_seconds: elapsedSeconds,
    bbox: payloadBbox,
    center: (state.center as { lat: number; lng: number } | undefined) ?? null,
    map_zoom: (payload.map_zoom as number | undefined) ?? null,
    sources_added: sourcesAdded,
    articles_fetched: articlesFetched,
    final_articles_count: finalCount,
    // Live fields surfaced to the UI.
    counters: Object.keys(counters).length ? counters : null,
    recent_articles: (state.recent_articles as unknown[]) ?? [],
    recent_sources: (state.recent_sources as unknown[]) ?? [],
    live_available: state.recent_articles != null || state.recent_sources != null,
    message: (state.detail as string | undefined) ?? null,
    // Queue-only field — handy for ops dashboards debugging stuck jobs.
    result: job.result,
  });
});

// ── POST /api/discovery-cancel/:id ──────────────────────────────────────
//
// Cancel a running discovery request. Drives both paths:
//
//  1. Queue path: set `cancel_requested=true` on the discovery_jobs row,
//     then send a `cancel` IPC message to the slot that owns the job so
//     the worker checks ctx.check_cancel() and unwinds promptly.
//     Returns 404 if the job isn't in a cancellable state (missing,
//     already terminal).
//  2. Auto-discover's direct spawn: kill the tracked Python child via
//     activeChildren, update the news_area_requests row, and clean up
//     the per-request status file. Auto-discover bypasses the queue by
//     design (fire-and-forget, no persistence needed), so this branch
//     remains for its in-flight requests.
exploreRoute.post("/discovery-cancel/:id", async (c) => {
  // Tier 1.6: gate — previously open to anyone, anyone could kill any
  // in-flight discovery (DoS / sabotage vector). Super admin required.
  // (Per-session ownership would be nicer UX but discovery_jobs doesn't
  // store session_id; news_area_requests does, but only for the legacy
  // auto-discover path. Admin gate covers both paths uniformly.)
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const id = c.req.param("id");

  // ── 1. Try the queue path first ────────────────────────────────────
  const updated = await requestCancel(id);
  if (updated) {
    poolCancelJob(id); // IPC cancel to the slot that owns this job
    console.log(`[discovery-cancel] queue cancel dispatched for ${id}`);
    return c.json({ ok: true, id, via: "queue" });
  }

  // ── 2. Legacy fallback for auto-discover direct-spawn jobs ─────────
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId < 1) {
    return c.json({ error: "not_found_or_terminal" }, 404);
  }

  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT id, status FROM news_area_requests WHERE id = ${requestId} LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: "not_found_or_terminal" }, 404);
  }

  const currentStatus = rows[0].status;
  if (currentStatus === "completed" || currentStatus === "failed" || currentStatus === "cancelled") {
    return c.json({
      ok: true,
      id: requestId,
      status: currentStatus,
      message: "Already finished",
      via: "legacy",
    });
  }

  // Kill the tracked Python child if it's still around
  const tracked = activeChildren.get(requestId);
  if (tracked) {
    try {
      process.kill(-tracked.child.pid!, "SIGTERM");
      console.log(`[discovery-cancel] legacy: killed process group for ${requestId} (pid ${tracked.child.pid})`);
    } catch (e) {
      console.log(`[discovery-cancel] legacy: kill failed for ${requestId}: ${e}`);
    }
    activeChildren.delete(requestId);
  }

  // Best-effort pkill for any orphaned workers
  try {
    const killProc = spawn("pkill", ["-f", `NEWSIUM_AREA_REQUEST_ID=${requestId}`], {
      timeout: 5000,
      stdio: "ignore",
    });
    killProc.on("close", () => {});
  } catch (e) {
    // Quick wins: surface the failure (best-effort cleanup, but operators should still see it).
    console.warn(`[discovery-cancel] legacy pkill failed for ${requestId}:`, (e as Error).message);
  }

  await sql`
    UPDATE news_area_requests
    SET status = 'cancelled', processed_at = now(), message = 'Cancelled by user'
    WHERE id = ${requestId}
  `;

  // Clean up status file (still in use by the legacy auto-discover path)
  const statusFile = `${STATUS_DIR}/discovery-${requestId}.json`;
  try { if (existsSync(statusFile)) unlinkSync(statusFile); } catch (_) {}
  try { if (existsSync(statusFile + ".tmp")) unlinkSync(statusFile + ".tmp"); } catch (_) {}

  console.log(`[discovery-cancel] legacy cancel complete for ${requestId}`);
  return c.json({
    ok: true,
    id: requestId,
    status: "cancelled",
    message: "Discovery cancelled",
    via: "legacy",
  });
});
