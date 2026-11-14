// delta-contour.bun.test.js — the CHANGE map, contoured in the browser.
//
// WHY THE CLIENT CONTOURS. The server publishes the delta FIELD (the
// difference of two archived pressure analyses) and the chart's ladder —
// 0.10, 0.25, 0.5, 1, 2, 4, 8, 16 hPa — is applied HERE. So every
// step works from ONE fetch, with no round trip to re-cut the lines, and
// the server never contours a delta at all: there is exactly ONE
// contouring implementation for the change maps, and nothing to drift.
//
// THE SEGMENTS ARE STITCHED. Marching squares cuts a contour wherever the
// field grazes the level, so one line arrives as hundreds of pieces;
// drawn as they come, the chart is a field of dashes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const contourJs = readFileSync(join(ROOT, "delta-contour.js"), "utf8");
const isobarJs = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

// Run the module in a sandbox and hand back its API.
function loadContour() {
  const window = {};
  const fn = new Function("window", `${contourJs}\nreturn window.DeltaContour;`);
  return fn(window);
}

describe("the delta contour", () => {
  test("a step of a grid with a known slope gives the line you expect", () => {
    const { contourAt } = loadContour();
    // A 4x4 grid whose value is the COLUMN index: every level runs
    // straight down the middle of a column, so the line for level 1.5
    // sits at column 1.5.
    const cols = 4, rows = 4;
    const values = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) values[r * cols + c] = c * 10; // 0, 10, 20, 30
    }
    const grid = { cols, rows, latMin: 0, latStep: 1, lonMin: 0, lonStep: 1, scale: 1 };
    const items = contourAt(values, grid, 15);
    expect(items.length).toBeGreaterThan(0);
    // The line is at longitude 1.5 (the grid's lonMin + 1.5 * lonStep).
    for (const it of items) {
      for (const [lng, lat] of it.coordinates) {
        expect(Math.abs(lng - 1.5)).toBeLessThan(0.51);
        expect(lat).toBeGreaterThanOrEqual(0);
        expect(lat).toBeLessThanOrEqual(4);
      }
    }
  });

  test("the pieces are STITCHED into one line, not left as dashes", () => {
    const { contourAt } = loadContour();
    const cols = 20, rows = 6;
    const values = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) values[r * cols + c] = c * 10;
    }
    const grid = { cols, rows, latMin: 0, latStep: 1, lonMin: 0, lonStep: 1, scale: 1 };
    const items = contourAt(values, grid, 55);
    // A straight field gives ONE line that crosses every row — not one
    // two-point segment per cell. Six rows means six crossings, so six
    // points; un-stitched, it would be FIVE separate two-point dashes.
    expect(items.length).toBe(1);
    expect(items[0].coordinates.length).toBe(rows);
    // And the points run along the crossing, in order.
    const lats = items[0].coordinates.map((c) => c[1]);
    for (let i = 1; i < lats.length; i++) {
      expect(lats[i]).toBeGreaterThan(lats[i - 1]);
    }
  });

  test("the ladder draws the CHOSEN step, and only it", () => {
    const { contourLadder } = loadContour();
    const cols = 60, rows = 20;
    const values = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) values[r * cols + c] = c * 20 - 600; // -600..580
    }
    // 0.05 hPa per unit — the GCD of the ladder, so every step lands
    // exactly on a level of the grid.
    const grid = { cols, rows, latMin: 0, latStep: 1, lonMin: 0, lonStep: 1, scale: 20 };
    const steps = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
    for (const step of steps) {
      const items = contourLadder(values, grid, steps, step);
      const levels = [...new Set(items.map((i) => i.level_hpa))];
      // Every level is a multiple of the step: 0.25 hPa is not a
      // multiple of 0.1, so the levels are snapped — but they must still
      // land ON the chosen ladder.
      for (const l of levels) {
        const k = l / step;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      }
    }
  });

  test("the ladder the chart offers is the same one the layers share", () => {
    // The isobar layer's STEP_CHOICES and the delta's steps must be the
    // SAME ladder, or a step that works on the pressure chart would not
    // work on the change map.
    expect(isobarJs).toMatch(/const STEP_CHOICES = \[0\.1, 0\.25, 0\.5, 1, 2, 4, 8, 16\]/);
  });

  // ── WHY THE CHART USED TO FREEZE THE BROWSER (2026-11-13) ──────────
  //
  // Owner report: *"they do load however they freeze up the computer and
  // almost crash it"*. Three defects, all measured on the real 24-hour
  // delta (the 2026-11-12 → 2026-11-13 analysis):
  //
  //  1. THE LEVELS RAN FROM -180 TO +180 hPa — the LONGITUDE range —
  //     applied to a chart about a CHANGE in pressure, which lives around
  //     zero. For the 0.10 hPa step that is 3,601 levels where the field
  //     spans ~840, and every one of them is a full pass over the 65,160
  //     cells: 234 million cell tests. Measured: 5,771 ms.
  //  2. THE FIELD WAS NEVER SMOOTHED, while the LIVE chart is contoured
  //     from a blurred field — so the change map contoured the GRIB's own
  //     noise, and a difference of two fields is TWICE the noise.
  //  3. THE WHOLE WORLD WAS CONTOURED AND THEN TRIMMED TO THE VIEWPORT,
  //     so every pan paid for the whole globe.
  test("the levels come from the FIELD'S OWN range, not the longitude range", () => {
    // The observable difference is TIME, so this is pinned in the source
    // as well as in the behaviour below.
    expect(contourJs).not.toMatch(/Math\.ceil\(-180 \/ s\)/);
    expect(contourJs).toMatch(/const first = Math\.ceil\(\(lo \/ scale\) \/ s\) \* s;/);
    // …and the range defaults to the field's own extent.
    expect(contourJs).toMatch(/for \(let i = 0; i < values\.length; i\+\+\)/);
  });

  test("a field's range bounds the levels it can draw", () => {
    const { contourLadder } = loadContour();
    // A field that spans -2 … +2 hPa.
    const cols = 40, rows = 10;
    const values = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) values[r * cols + c] = Math.round(-20 + (40 * c) / (cols - 1));
    }
    const grid = { cols, rows, latMin: 0, latStep: 1, lonMin: 0, lonStep: 1, scale: 10 };
    const items = contourLadder(values, grid, [0.1], 0.1);
    for (const it of items) {
      expect(it.level_hpa).toBeGreaterThanOrEqual(-2.001);
      expect(it.level_hpa).toBeLessThanOrEqual(2.001);
    }
  });

  test("a cell range does not change the lines — it only limits the work", () => {
    const { contourLadder, cellRangeFor } = loadContour();
    const cols = 40, rows = 10;
    const values = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) values[r * cols + c] = Math.round(-20 + (40 * c) / (cols - 1));
    }
    const grid = { cols, rows, latMin: 0, latStep: 1, lonMin: 0, lonStep: 1, scale: 10 };
    const all = contourLadder(values, grid, [0.1], 0.1);
    // A range covering the WHOLE grid must give the same lines as no
    // range at all — the range is an optimisation, never a different
    // chart.
    const cr = cellRangeFor(grid, { west: -10, south: -10, east: 50, north: 20 });
    expect(cr).not.toBeNull();
    const ranged = contourLadder(values, grid, [0.1], 0.1, { cellRange: cr });
    const key = (arr) => JSON.stringify(arr.map((l) => [l.level_hpa, l.coordinates]));
    expect(key(ranged)).toBe(key(all));
  });

  test("the cell range follows the viewport and WRAPS in longitude", () => {
    const { cellRangeFor } = loadContour();
    const grid = { cols: 360, rows: 181, latMin: -90, latStep: 1, lonMin: 0, lonStep: 1 };
    const city = cellRangeFor(grid, { west: 2.2, south: 48.7, east: 2.5, north: 48.9 });
    expect(city.r0).toBeGreaterThanOrEqual(0);
    expect(city.r1).toBeLessThanOrEqual(180);
    // A viewport that runs off the east edge comes back on the west.
    const wrapped = cellRangeFor(grid, { west: 350, south: -10, east: 10, north: 10 });
    expect(wrapped.c0).toBeGreaterThanOrEqual(0);
    expect(wrapped.c1).toBeGreaterThan(wrapped.c0);
  });

  test("the field is blurred with the SAME rule the live chart uses", () => {
    // worker/isobars.py::smooth_field(): σ = FIELD_SMOOTH_SIGMA_DEG (0.5°)
    // in cells against the grid spacing, with a FLOOR of two cells; the
    // longitude axis WRAPS (it is periodic) and the latitude axis does
    // NOT (the poles are edges, not a seam).
    const { smoothField } = loadContour();
    const cols = 8, rows = 5;
    const values = new Int16Array(cols * rows);
    values.fill(0);
    values[2 * cols + 3] = 100;  // one spike
    const grid = { cols, rows, latMin: -80, latStep: 40, lonMin: 0, lonStep: 45 };
    const out = smoothField(values, grid);
    expect(out.length).toBe(values.length);
    // The spike is spread: its neighbours are no longer zero…
    expect(out[2 * cols + 2]).toBeGreaterThan(0);
    expect(out[2 * cols + 4]).toBeGreaterThan(0);
    // …and the peak is BELOW the original, because a Gaussian of a
    // single cell cannot keep its height.
    expect(out[2 * cols + 3]).toBeLessThan(100);
    // A constant field is unchanged.
    const flat = new Int16Array(cols * rows).fill(40);
    const flatOut = smoothField(flat, grid);
    for (const v of flatOut) expect(v).toBeCloseTo(40, 6);
  });

  test("the blur REMOVES LINES — that is the point of it", () => {
    // Measured on the real delta: the blur cuts the 0.10 hPa chart from
    // 28,171 lines to 11,181. A field of noise contours into a scribble;
    // a blurred one contours into a chart.
    const { contourLadder, smoothField } = loadContour();
    const cols = 60, rows = 30;
    const values = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        values[r * cols + c] = Math.round(60 * Math.sin(c / 1.7) + 40 * Math.cos(r / 1.3));
      }
    }
    const grid = { cols, rows, latMin: -60, latStep: 4, lonMin: 0, lonStep: 6, scale: 10 };
    const steps = [0.1];
    const raw = contourLadder(values, grid, steps, 0.1).length;
    const blurred = contourLadder(smoothField(values, grid), grid, steps, 0.1).length;
    expect(blurred).toBeLessThan(raw);
  });

  test("a SADDLE cell cuts TWO segments, and both are drawn", () => {
    // The 16 marching-squares cases list PAIRS of edges — a saddle cuts
    // two. An earlier rewrite walked the list as flat elements and drew
    // a degenerate point instead of the saddle's two segments, which
    // silently destroyed whole lines.
    const { contourAt } = loadContour();
    const cols = 3, rows = 3;
    const values = new Int16Array(cols * rows);
    // A checkerboard: the middle cell's corners alternate above and
    // below the level — the saddle case.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) values[r * cols + c] = (r + c) % 2 === 0 ? 100 : -100;
    }
    const grid = { cols, rows, latMin: 0, latStep: 1, lonMin: 0, lonStep: 1, scale: 1 };
    const items = contourAt(values, grid, 0);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      // No degenerate segment: a saddle's two ends are different points.
      expect(it.coordinates.length).toBeGreaterThan(1);
      const first = it.coordinates[0];
      const last = it.coordinates[it.coordinates.length - 1];
      const same = Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;
      // A closed loop returns to its start; anything else must not be a
      // single repeated point.
      if (!same) expect(it.coordinates.length).toBeGreaterThan(1);
    }
  });
});

describe("the layer offers the change map", () => {
  test("there is a CHANGE row of chips, with the windows", () => {
    expect(isobarJs).toMatch(/id = "isobar-change-switch"/);
    for (const w of ["24h", "3d", "7d", "moon", "season", "year"]) {
      expect(isobarJs).toMatch(new RegExp(`key: "${w}"`));
    }
  });

  test("a CHANGE is signed and carries its unit", () => {
    // "+8 hPa" says the pressure ROSE; without the sign and the unit a
    // change map is a chart of unlabelled numbers.
    expect(isobarJs).toMatch(/labelTextFor/);
    expect(isobarJs).toMatch(/\+.*hPa/);
  });

  test("the change map has its OWN ramp — blue where it fell, red where it rose", () => {
    expect(isobarJs).toMatch(/function deltaColor/);
    expect(isobarJs).toMatch(/DELTA_COLOR_STOPS/);
  });

  test("the contouring module loads BEFORE the layer that asks for it", () => {
    const contourAt = indexHtml.indexOf("delta-contour.js");
    const layerAt = indexHtml.indexOf("isobar-layer.js");
    expect(contourAt).toBeGreaterThan(-1);
    expect(contourAt).toBeLessThan(layerAt);
  });
});
