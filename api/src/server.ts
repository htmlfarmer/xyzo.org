import { Hono } from "hono";
import { compress } from "hono/compress";
import { healthRoute } from "./routes/health";
import { pinsRoute } from "./routes/pins";
import { lyrzRoute } from "./routes/lyrz";
import { adminRoute } from "./routes/admin";
import { geocodeRoute } from "./routes/geocode";
import { eventsRoute } from "./routes/events";
import { upcomingEventsRoute } from "./routes/events_calendar";
import { sitesStudyRoute } from "./routes/sites_study";
import { searchRoute } from "./routes/search";
import { searchIntelRoute } from "./routes/search-intel";
import { analyticsRoute } from "./routes/analytics";
import { autoCategorizeRoute } from "./routes/auto_categorize";
import { citiesRoute } from "./routes/cities";
import { insightsRoute } from "./routes/insights";
import { communityRoute } from "./routes/community";
import { exploreRoute } from "./routes/explore";
import { feedbackRoute } from "./routes/feedback";
import { newsRoute } from "./routes/news";
import { locationViewsRoute } from "./routes/location-views";
import { locationsRoute } from "./routes/locations";
import { sniffRoute } from "./routes/sniff";
import { wikiRoute } from "./routes/wiki";
import { geoipRoute } from "./routes/geoip";
import { aiStatusRoute } from "./routes/ai-status";
import { nnRoute } from "./routes/nn";
import { sysloadRoute } from "./routes/sysload";
import { statsRoute } from "./routes/stats";
import { feedRoute } from "./routes/feed";
import { sourcesRoute } from "./routes/sources";
import { internalRoute } from "./routes/internal";
import { linksRoute } from "./routes/links";
import { aiChatRoute } from "./routes/ai-chat";
import { storyLinksRoute } from "./routes/story-links";
import { storyTreeRoute } from "./routes/story-tree";
import { commandRoute } from "./routes/command";
import { debugRoute } from "./routes/debug";
import { performanceRoute } from "./routes/performance";
import { aiFlagRoute } from "./routes/ai-flag";
import { imageProxyRoute } from "./routes/imageProxy";
import { tileProxyRoute } from "./routes/tileProxy";
import { tileMirrorRoute } from "./routes/tileMirror";
import { faoRiversProxyRoute } from "./routes/faoRiversProxy";
import { tagsRoute } from "./routes/tags";
import { digestRoute } from "./routes/digest";
import { versionRoute } from "./routes/version";
import { shutdownRoute, isSiteShutdown } from "./routes/shutdown";
import { agentRoute } from "./routes/agent";
import { problemsRoute } from "./routes/problems";
import { undercoverRoute } from "./routes/undercover";
import { desertsRoute } from "./routes/deserts";
import { scienceRoute } from "./routes/science";
import { photoRoute } from "./routes/photo";
import { sitemapRoute } from "./routes/sitemap";
import { searchResultsRoute } from "./routes/search_results";
import { journalistsRoute } from "./routes/journalists";
import { audioRoute } from "./routes/audio";
import { serviceEventsRoute } from "./routes/service-events";
import { videoRoute } from "./routes/video";
import { collabRoute } from "./routes/collab";
import { credibilityRoute } from "./routes/credibility";
import { cityStoryRoute } from "./routes/city-story";
import { cityValueRoute } from "./routes/city-value";
import { weatherRoute } from "./routes/weather";
import { weatherDeltaRoute } from "./routes/weather-delta";
import { weatherArchiveRoute } from "./routes/weather-archive";
import { closeDb } from "./db";
import { closeWikiDb } from "./wiki-db";
import { closeAllClients as closeFeedStreams } from "./feed-broadcaster";
import { metrics } from "./metrics";
import { startWorkerPool, stopWorkerPool } from "./queue/workerPool";
import { shutdownListenPool } from "./queue/listenClientPool";

const app = new Hono();

// Response compression for large JSON payloads (40-60% reduction)
app.use(compress());

// ── Global Shutdown Middleware ────────────────────────────────────────
// If the site is shut down (community complaint threshold exceeded),
// only allow health checks, shutdown status, and admin endpoints through.
// Everything else gets a 503 with a maintenance message.
app.use("*", async (c, next) => {
  const path = c.req.path;

  // Always allow: health, shutdown status/reset, admin, and static assets
  if (
    path.startsWith("/api/health") ||
    path.startsWith("/api/shutdown/status") ||
    path.startsWith("/api/shutdown/reset") ||
    path.startsWith("/api/shutdown/activate") ||
    path.startsWith("/api/admin/") ||
    path.startsWith("/api/version") ||
    !path.startsWith("/api/")
  ) {
    return next();
  }

  // Check shutdown state (cached in-memory, refreshes every 30s)
  if (await isSiteShutdown()) {
    return c.json({
      error: "site_shutdown",
      message: "xyzo.org is temporarily offline for maintenance. We received community feedback about an issue and are working to resolve it. Please try again later.",
      shutdown: true,
    }, 503);
  }

  return next();
});

// Track request timing
app.use("*", async (c, next) => {
  const start = performance.now();
  const startCpu = process.cpuUsage();
  await next();
  const duration = performance.now() - start;
  const cpuUsage = process.cpuUsage(startCpu);
  const cpuTimeMs = Math.round((cpuUsage.user + cpuUsage.system) / 1000);

  // Add timing header
  c.header("X-Response-Time", `${Math.round(duration)}ms`);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Track metrics for non-health endpoints
  const path = c.req.path;
  if (!path.startsWith('/api/health')) {
    // FIX_NOTES 2.5: cpuTimeMs used to be passed as the session_id arg —
    // CPU time was stored in the session column and never recorded.
    metrics.trackRequest(path, duration);
  }
});

app.route("/api/health", healthRoute);
app.route("/api", pinsRoute);
// LYRz settlement: link a contributor to their LYRz identity and settle
// their contributions out to lyrz.org as a portable LYRz balance.
app.route("/api", lyrzRoute);
app.route("/api", geocodeRoute);
app.route("/api", eventsRoute);
app.route("/api", upcomingEventsRoute);
app.route("/api", sitesStudyRoute);
app.route("/api", searchRoute);
app.route("/api", searchIntelRoute);
app.route("/api", analyticsRoute);
app.route("/api", autoCategorizeRoute);
app.route("/api", citiesRoute);
app.route("/api/city-value", cityValueRoute);
app.route("/api", insightsRoute);
app.route("/api", communityRoute);
app.route("/api", exploreRoute);
app.route("/api", feedbackRoute);
app.route("/api", newsRoute);
app.route("/api", locationViewsRoute);
app.route("/api", locationsRoute);
app.route("/api", sniffRoute);
app.route("/api", wikiRoute);
app.route("/api", geoipRoute);
app.route("/api", aiStatusRoute);
app.route("/api/nn", nnRoute);
app.route("/api", sysloadRoute);
app.route("/api", statsRoute);
app.route("/api", feedRoute);
app.route("/api/internal", internalRoute);
app.route("/api", sourcesRoute);
app.route("/api", linksRoute);
app.route("/api/story-links", storyLinksRoute);
app.route("/api", storyTreeRoute);
app.route("/api", cityStoryRoute);
app.route("/api", weatherRoute);
// The CHANGE in pressure over a period (the Δp map) — computed from
// two archived pressure fields.
app.route("/api", weatherDeltaRoute);
// The ARCHIVED weather maps — a year of cycles, served from
// data/weather_archive/ (outside the web root).
app.route("/api", weatherArchiveRoute);
app.route("/api/command", commandRoute);
app.route("/api", aiChatRoute);
app.route("/api", aiFlagRoute);
app.route("/api", debugRoute);
app.route("/api", imageProxyRoute);
// The tile mirror is registered FIRST of all the /tile/ routes: its
// path is /tile/mirror/:mapId/:z/:x/:y, which is SIX segments after
// /api/ — exactly the shape of the NASA route's
// /tile/:dataset/:date/:z/:y/:x (dataset="mirror", date=<mapId>).
// Registered after it, every mirrored basemap tile would be answered by
// the GIBS proxy as an unknown dataset.
app.route("/api", tileMirrorRoute);
// The FAO rivers proxy is registered FIRST on purpose: the NASA
// tile proxy's pattern is /tile/:dataset/:date/:z/:y/:x, which
// matches ANY five-segment path under /tile/ — including
// /tile/fao-rivers/medium/8/8/8. This route's first segment is
// the literal "fao-rivers", so it claims only its own URLs, and
// registering it first keeps the NASA route from claiming them.
app.route("/api", faoRiversProxyRoute);
app.route("/api", tileProxyRoute);
app.route("/api/admin", adminRoute);
app.route("/api", serviceEventsRoute);
app.route("/api", shutdownRoute);
app.route("/api", agentRoute);
app.route("/api", performanceRoute);
app.route("/api", tagsRoute);
app.route("/api", digestRoute);
app.route("/api", versionRoute);
  app.route("/api", problemsRoute);
  app.route("/api", undercoverRoute);
  app.route("/api", desertsRoute);
  app.route("/api", journalistsRoute);
  app.route("/api", audioRoute);
  app.route("/api", scienceRoute);
  app.route("/api", photoRoute);
  app.route("/api", videoRoute);
  app.route("/api", collabRoute);
app.route("/api", credibilityRoute);
  app.route("/", sitemapRoute);
  app.route("/search", searchResultsRoute);

app.onError((err, c) => {
  console.error("[xyzo] unhandled error:", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// Boot the worker pool BEFORE the HTTP listener accepts requests. Route
// handlers may enqueue jobs on first hit; the pool must be live by then.
// startWorkerPool also boots the stale-claim sweeper internally, so we
// don't import or start it here. If boot fails, shut down cleanly so we
// don't leak already-spawned Python children.
//
// However, we start the HTTP server FIRST so /api/health responds immediately
// (the client health-check has a 12s timeout; blocking here for 10-40s while
// workers boot would show the "System Upgrade" banner on every page load).
// The health endpoint returns ok:true while state=STARTING; job enqueue
// guards against STARTING state and throws JobQueueUnavailableError.

const port = Number(process.env.XYZO_PORT ?? 3008);
const hostname = process.env.XYZO_HOST ?? "127.0.0.1";
const server = Bun.serve({
  hostname,
  port,
  fetch: app.fetch,
  // The /api/events/search endpoint spawns a Python worker that takes
  // 20–90 seconds to run cluster + extraction. The default Bun idle
  // timeout of 10s was killing the request mid-flight. 120s matches
  // what the worker takes in the worst case + a safety margin.
  idleTimeout: 120,
});

console.log(`[xyzo] listening on ${hostname}:${server.port}`);

// LYRz settlement: contributors' work becomes a portable LYRz balance that
// follows them across the ecosystem. Non-fatal by design — if LYRz is down
// the contributions stay queued locally and are retried.
void import("./lib/lyrz")
  .then(async (m) => {
    await m.ensureQueueTable();
    m.startSettlementLoop();
  })
  .catch((e) => console.error("[lyrz] bridge not started:", e?.message ?? e));

// Warm city lookup cache in background (world_cities foreign table, ~30s)
// MAJOR_CITIES (~200 cities) are always loaded instantly; this adds coverage.
void import("./lib/cityLookup").then(m => m.warmCityLookup()).catch(() => {});

// Log startup event to service_events table (fire-and-forget)
void logStartupEvent().catch((e) =>
  console.error("[xyzo] failed to log startup event:", e),
);

async function logStartupEvent() {
  const { getDb } = await import("./db");
  const { resolve } = await import("node:path");

  function git(args: string[], cwd: string): string | null {
    try {
      const proc = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000,
      });
      if (proc.exitCode !== 0) return null;
      return proc.stdout.toString().trim();
    } catch {
      return null;
    }
  }

  function findRepoRoot(start: string): string {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const probe = Bun.spawnSync(["test", "-d", `${dir}/.git`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (probe.exitCode === 0) return dir;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    return start;
  }

  const root = findRepoRoot(resolve(import.meta.dir, "../../../"));
  const sha = git(["rev-parse", "HEAD"], root);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const message = git(["log", "-1", "--pretty=%s"], root);

  const sql = getDb();
  await sql`
    INSERT INTO service_events (
      service_name,
      event_type,
      git_sha_after,
      git_branch,
      git_message,
      reason,
      created_by
    ) VALUES (
      ${"xyzo-api"},
      ${"restart"},
      ${sha ?? null},
      ${branch ?? null},
      ${message ?? null},
      ${"API server startup"},
      ${"system"}
    )
  `;
  console.log(`[xyzo] logged startup event (sha=${sha?.slice(0, 7) ?? "?"})`);
}

// Boot worker pool in the background — HTTP is already accepting requests.
// Health endpoint returns ok:true during STARTING so clients don't panic.
startWorkerPool().catch((e) => {
  console.error("[xyzo] worker pool failed to boot:", e);
  stopWorkerPool({ maxWaitMs: 5_000 }).catch(() => undefined);
});

// Shutdown order: stop accepting new HTTP, drain in-flight queue jobs,
// release LISTEN/NOTIFY waiters, then close the DB pool. SIGINT alongside
// SIGTERM so Ctrl+C during dev also drains cleanly.
const shutdown = async (signal: string): Promise<void> => {
  console.log(`[xyzo] ${signal} received, draining...`);
  server.stop(); // stop accepting new HTTP requests first
  // End open SSE streams immediately, before the (up to 30s) worker-pool
  // drain: a clean `bye` + EOF lets EventSource reconnect silently once
  // the new process is up, instead of ERR_HTTP2_PROTOCOL_ERROR in every
  // open tab. Caddy's lb_try_duration covers the port-closed window.
  await closeFeedStreams(signal).catch(() => undefined);
  await stopWorkerPool({ maxWaitMs: 30_000 });
  await shutdownListenPool(); // release any LISTEN/NOTIFY waiters
  await closeWikiDb();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
