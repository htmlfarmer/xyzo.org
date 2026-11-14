/**
 * weather-delta.ts — the CHANGE in pressure over a period.
 *
 * WHAT THIS IS. The isobar layer draws the pressure of ONE analysis.
 * This route draws the DIFFERENCE between two analyses — the Δp map, the
 * pressure anomaly, what a synoptic chart calls the tendency: where the
 * air has RISEN and where it has FALLEN over the window.
 *
 * WHY IT IS COMPUTED HERE AND NOT STORED. A difference of two sets of
 * contour lines is not a field — you cannot subtract a polyline. So the
 * ARCHIVE holds the pressure FIELD of every cycle (1°, 130 KB a cycle,
 * ~190 MB a year) and the delta is computed from two of them, on demand,
 * for ANY window and ANY past cycle. Storing the delta per window would
 * cost 1.5 GB a year for a field that is 190 MB.
 *
 * WHY THE GRID, NOT THE LINES. The grid goes to the client, which
 * contours it — so EVERY step of the chart's ladder works (0.10, 0.25,
 * 0.5, 1, 2, 4, 8, 16 hPa) from ONE fetch, with no round trip to
 * re-cut the lines. The server never contours a delta, so there is
 * exactly one contouring implementation for them and nothing to drift.
 *
 * THE WINDOWS. 24 h and 3 d and 7 d work as soon as the archive holds
 * that much; the lunar cycle (29.53 d), the seasonal quarter (91.3 d)
 * and the year (365.25 d) light up as the archive fills. A year-long
 * change cannot be computed until a year of fields exists — the route
 * says so rather than answering with something else.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter } from "../ratelimit";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

export const weatherDeltaRoute = new Hono();

const limiter = new RateLimiter({ max: 120, windowMs: 60 * 1000 });

// Read LAZILY (per request): the tests point it at a fixture directory.
function archiveRoot(): string {
  return resolve(
    process.env.XYZO_WEATHER_ARCHIVE ||
      join(process.cwd(), "..", "data", "weather_archive"),
  );
}

/** The windows, in the order the buttons show them. */
export const DELTA_WINDOWS = [
  { key: "24h", days: 1, label: "24 h", title: "the change over the last day" },
  { key: "3d", days: 3, label: "3 d", title: "the change over three days" },
  { key: "7d", days: 7, label: "7 d", title: "the change over a week" },
  { key: "moon", days: 29.53059, label: "moon", title: "one lunar cycle (29.53 days)" },
  { key: "season", days: 91.3125, label: "season", title: "a quarter of the year" },
  { key: "year", days: 365.25, label: "year", title: "a full year" },
] as const;

type WindowKey = (typeof DELTA_WINDOWS)[number]["key"];

/** Every archived cycle, as { key, iso, dt } — newest last. */
function archivedCycles(): { key: string; iso: string; dt: number }[] {
  const root = archiveRoot();
  if (!existsSync(root)) return [];
  const out: { key: string; iso: string; dt: number }[] = [];
  for (const name of readdirSync(root)) {
    if (!/^\d{10}$/.test(name)) continue;
    const metaPath = join(root, name, "mslp-meta.json");
    const gridPath = join(root, name, "mslp-1deg.bin");
    if (!existsSync(metaPath) || !existsSync(gridPath)) continue;
    let iso = "";
    try {
      iso = String(JSON.parse(readFileSync(metaPath, "utf8")).run_time || "");
    } catch {
      continue;
    }
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    out.push({ key: name, iso, dt: t });
  }
  out.sort((a, b) => a.dt - b.dt);
  return out;
}

/** The cycle in effect at `at`, and the one it is measured against. */
function pickCycles(
  cycles: { key: string; iso: string; dt: number }[],
  atMs: number,
  days: number,
): { now: { key: string; iso: string; dt: number }; ref: { key: string; iso: string; dt: number } } | null {
  // The cycle IN EFFECT at the requested moment: the newest one at or
  // before it.
  let now: { key: string; iso: string; dt: number } | null = null;
  for (const c of cycles) {
    if (c.dt <= atMs) now = c;
    else break;
  }
  if (!now) now = cycles[0];
  if (!now) return null;

  // The reference: the archived cycle nearest to one window back. The
  // tolerance is one analysis (6 h), because the cycles are six-hourly
  // and a window of 29.53 days lands between them.
  const want = now.dt - days * 86400000;
  const tolerance = 6 * 3600 * 1000;
  let ref: { key: string; iso: string; dt: number } | null = null;
  let best = Infinity;
  for (const c of cycles) {
    if (c.dt >= now.dt) break;
    const d = Math.abs(c.dt - want);
    if (d < best) {
      best = d;
      ref = c;
    }
  }
  if (!ref || best > tolerance) return null;
  return { now, ref };
}

// ── GET /api/weather/pressure/delta/cycles ─────────────────────────────
weatherDeltaRoute.get("/weather/pressure/delta/cycles", async (c) => {
  const ip = c.req.header("x-forwarded-for") || "local";
  const limit = limiter.check(ip);
  if (!limit.allowed) return c.json({ error: "rate_limited" }, 429);

  const cycles = archivedCycles();
  const newest = cycles.length ? cycles[cycles.length - 1].dt : Date.now();
  const windows = DELTA_WINDOWS.map((w) => {
    const pick = pickCycles(cycles, newest, w.days);
    return {
      window: w.key,
      label: w.label,
      days: w.days,
      title: w.title,
      available: !!pick,
      cycle: pick ? pick.now.iso : null,
      ref_cycle: pick ? pick.ref.iso : null,
    };
  });
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    count: cycles.length,
    oldest: cycles.length ? cycles[0].iso : null,
    newest: cycles.length ? cycles[cycles.length - 1].iso : null,
    windows,
  });
});

// ── GET /api/weather/pressure/delta ────────────────────────────────────
const DeltaQuery = z.object({
  at: z.string().optional(),
  window: z.string().optional(),
});

weatherDeltaRoute.get("/weather/pressure/delta", zValidator("query", DeltaQuery), async (c) => {
  const ip = c.req.header("x-forwarded-for") || "local";
  const limit = limiter.check(ip);
  if (!limit.allowed) return c.json({ error: "rate_limited" }, 429);

  const q = c.req.valid("query");
  const win = DELTA_WINDOWS.find((w) => w.key === (q.window || "24h")) || DELTA_WINDOWS[0];
  const atMs = q.at ? Date.parse(q.at) : Date.now();
  if (!Number.isFinite(atMs)) return c.json({ error: "bad_at" }, 400);

  const cycles = archivedCycles();
  if (!cycles.length) return c.json({ error: "no_archive" }, 404);

  const pick = pickCycles(cycles, atMs, win.days);
  if (!pick) {
    return c.json(
      {
        error: "window_not_available",
        window: win.key,
        days: win.days,
        message:
          `The archive does not reach back ${win.days} days yet — this window fills in as the archive grows.`,
        oldest: cycles[0].iso,
      },
      404,
    );
  }

  const root = archiveRoot();
  const nowGrid = readFileSync(join(root, pick.now.key, "mslp-1deg.bin"));
  const refGrid = readFileSync(join(root, pick.ref.key, "mslp-1deg.bin"));
  const meta = JSON.parse(readFileSync(join(root, pick.now.key, "mslp-meta.json"), "utf8"));

  // The grids are Int16 little-endian at 0.1 hPa per unit. The delta is
  // the difference of two of them — in the SAME units, so the scale
  // carries over untouched.
  const n = Math.min(nowGrid.length, refGrid.length) >> 1;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const a = nowGrid.readInt16LE(i * 2);
    const b = refGrid.readInt16LE(i * 2);
    let v = a - b;
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }

  c.header("Cache-Control", "public, max-age=300");
  c.header("X-Delta-Window", win.key);
  c.header("X-Delta-Cycle", pick.now.iso);
  c.header("X-Delta-Ref-Cycle", pick.ref.iso);
  return c.json({
    window: win.key,
    days: win.days,
    label: win.label,
    title: win.title,
    cycle: pick.now.iso,
    ref_cycle: pick.ref.iso,
    grid: {
      cols: meta.grid.cols,
      rows: meta.grid.rows,
      lat_min: meta.grid.lat_min,
      lat_max: meta.grid.lat_max,
      lon_min: meta.grid.lon_min,
      lat_step: meta.grid.lat_step,
      lon_step: meta.grid.lon_step,
      scale: meta.grid.scale,
      layout: meta.grid.layout,
      row0: meta.grid.row0,
    },
    units: "hPa",
    source: "NOAA NCEP GFS — mean sea-level pressure difference",
    license: meta.license,
    attribution: meta.attribution,
    data: out.toString("base64"),
  });
});
