/**
 * /api/weather/pressure/delta — the CHANGE in pressure over a period.
 *
 * WHAT THIS IS. The isobar layer draws the pressure of ONE analysis.
 * This route draws the DIFFERENCE between two — the Δp map, the
 * pressure anomaly, what a synoptic chart calls the tendency: where
 * the air has RISEN and where it has FALLEN over the window.
 *
 * WHY IT IS COMPUTED AND NOT STORED. A difference of two sets of
 * contour lines is not a field — you cannot subtract a polyline. So the
 * ARCHIVE holds the pressure FIELD of every cycle (1°, 130 KB a cycle,
 * ~190 MB a year) and the delta is computed from two of them, on
 * demand, for ANY window and ANY past cycle.
 *
 * THE RULES THIS PINS:
 *
 *   * the cycle served is the one IN EFFECT at the requested moment,
 *     and the reference is the archived cycle nearest to one window
 *     back (the analyses are six-hourly, so a window of 29.53 days
 *     lands between them — the tolerance is one analysis);
 *   * a window the archive cannot reach yet is a 404 that SAYS SO,
 *     never a silent empty answer — the lunar cycle and the year need
 *     a year of fields, and the archive has ten days;
 *   * the grid is the delta in the SAME units as the archived fields
 *     (Int16 little-endian, 0.1 hPa per unit), so the scale carries
 *     over untouched;
 *   * the client contours the grid, so every step of the ladder works
 *     from one fetch — the server never contours a delta, so there is
 *     exactly one contouring implementation and nothing to drift.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = mkdtempSync(join(tmpdir(), "xyzo-delta-test-"));
process.env.XYZO_WEATHER_ARCHIVE = ROOT;

const { weatherDeltaRoute } = await import("../src/routes/weather-delta");

const app = new Hono();
app.route("/api", weatherDeltaRoute);

// Two cycles, 360x181 Int16 at 0.1 hPa. The first is a flat 1000.0 hPa;
// the second is 1000.0 hPa everywhere EXCEPT a patch that is 5.0 hPa
// lower — so the delta is 0 everywhere and -5.0 in that patch.
const COLS = 360;
const ROWS = 181;
// 0.05 hPa per unit — the GCD of the chart's ladder, so EVERY step
// (0.10, 0.25, …) lands exactly on a level of the grid.
const SCALE = 20;

function writeCycle(key: string, iso: string, bump: (r: number, c: number) => number) {
  const dir = join(ROOT, key);
  mkdirSync(dir, { recursive: true });
  const vals = new Int16Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      vals[r * COLS + c] = Math.round((1000 + bump(r, c)) * SCALE);
    }
  }
  const buf = Buffer.alloc(vals.length * 2);
  for (let i = 0; i < vals.length; i++) buf.writeInt16LE(vals[i], i * 2);
  writeFileSync(join(dir, "mslp-1deg.bin"), buf);
  writeFileSync(
    join(dir, "mslp-meta.json"),
    JSON.stringify({
      source: "NOAA NCEP GFS",
      variable: "mean sea-level pressure",
      units: "hPa",
      product: "gfs.1p00",
      run_time: iso,
      license: "US Government work (public domain)",
      attribution: "NOAA NCEP GFS — mean sea-level pressure",
      grid: {
        file: "mslp-1deg.bin",
        cols: COLS, rows: ROWS,
        lat_min: -90, lat_max: 90, lon_min: 0,
        lat_step: 1, lon_step: 1,
        scale: SCALE, layout: "row_major", row0: "south",
      },
      range_hpa: [980, 1020],
    }),
  );
}

beforeAll(() => {
  // Two cycles a day apart, and one three days before the newest.
  writeCycle("2026111100", "2026-11-11T00:00:00Z", () => 0);
  writeCycle("2026111106", "2026-11-11T06:00:00Z", () => 0);
  writeCycle("2026111112", "2026-11-11T12:00:00Z", () => 0);
  writeCycle("2026111200", "2026-11-12T00:00:00Z", () => 0);
  writeCycle("2026111206", "2026-11-12T06:00:00Z", (r, c) =>
    r > 80 && r < 100 && c > 100 && c < 140 ? -5 : 0,
  );
  writeCycle("2026110906", "2026-11-09T06:00:00Z", () => 0);
});

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
});

describe("the pressure change map", () => {
  test("it lists the windows and which ones the archive can answer", async () => {
    const res = await app.request("/api/weather/pressure/delta/cycles");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(6);
    const byKey = Object.fromEntries(body.windows.map((w: any) => [w.window, w]));
    // 24 h: a day back is inside the archive.
    expect(byKey["24h"].available).toBe(true);
    // The lunar cycle and the year need a year of fields; the archive
    // has days, so they are NOT available — and the route says so rather
    // than answering with something else.
    expect(byKey["moon"].available).toBe(false);
    expect(byKey["year"].available).toBe(false);
  });

  test("the delta is the difference of the two archived fields", async () => {
    const res = await app.request("/api/weather/pressure/delta?window=24h");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe("24h");
    expect(body.units).toBe("hPa");
    expect(body.grid.cols).toBe(COLS);
    expect(body.grid.rows).toBe(ROWS);
    expect(body.grid.scale).toBe(SCALE);
    // The cycle in effect, and the one it is measured against.
    expect(body.cycle).toBe("2026-11-12T06:00:00Z");
    expect(body.ref_cycle).toBe("2026-11-11T06:00:00Z");

    // The grid: Int16 little-endian, 0.1 hPa per unit. The patch is
    // -5.0 hPa; everywhere else it is 0.
    const raw = Buffer.from(body.data, "base64");
    expect(raw.length).toBe(COLS * ROWS * 2);
    const vals = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    let min = 0, max = 0;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min / SCALE).toBe(-5);
    expect(max).toBe(0);
  });

  test("a window the archive cannot reach is a 404 that says so", async () => {
    const res = await app.request("/api/weather/pressure/delta?window=year");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("window_not_available");
    expect(body.window).toBe("year");
    // The message says WHY, so the reader (and the operator) can see it
    // is a filling-up archive and not a broken one.
    expect(body.message).toMatch(/archive does not reach back/i);
    expect(body.oldest).toBeTruthy();
  });
});
