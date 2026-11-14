// lightning-layer.bun.test.js — the "⚡ Lightning density (WWLLN)" overlay.
//
// A colour wash of the WWLLN Global Lightning Climatology — the finest
// global lightning climatology in the public domain, a 5 arc-minute
// grid (about 9.3 km per cell) rather than the 0.5 degree grid the
// NASA LIS/OTD map everyone shares uses.
//
// The traps this file guards:
//   • NO PNG tiles. Every *.png under public_html is served
//     `immutable` for a year, so a regenerated pyramid would be
//     invisible behind a stale version token (the Köppen incident of
//     2026-10-22). The wash is painted in the browser from grid_*.bin
//     + meta.json, which are NOT immutable and always revalidate.
//   • Tile rows must be sampled in MERCATOR y, or the field drifts
//     against the basemap — these are Web Mercator tiles.
//   • The probe and the painted colour must come from the same grid,
//     so what you read IS the colour you are looking at.
//   • The colour scale is a POWER LAW. A linear ramp over a field whose
//     median cell is 3e-5 and whose maximum is 0.144 — a factor of
//     4800 — would paint the whole world one colour.
//   • The scale must be the SAME for every period, or January and July
//     are not comparable.
//   • The published data must be a lightning field at all: the tropics
//     carry ~70 % of it, the poles carry ~0, the Sahara is dry, and the
//     ITCZ migrates north between December and July.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const layerJs = readFileSync(join(ROOT, "lightning-layer.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const hoverJs = readFileSync(join(ROOT, "hover-info.js"), "utf8");
const buildPy = readFileSync(join(ROOT, "..", "scripts", "lightning_build.py"), "utf8");
const bumpSh = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

const DATA_DIR = join(ROOT, "data", "lightning");
const meta = JSON.parse(readFileSync(join(DATA_DIR, "meta.json"), "utf8"));

// ── the module, loaded into a sandbox ───────────────────────────────────
function loadLayer() {
  const store = new Map();
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.navigator = globalThis.navigator || { maxTouchPoints: 0 };
  // eslint-disable-next-line no-eval
  eval(layerJs);
  return globalThis.LightningLayer;
}

// ── the published grid ───────────────────────────────────────────────────
const annualBuf = readFileSync(join(DATA_DIR, "grid_annual.bin"));
const annual = new Uint16Array(
  annualBuf.buffer,
  annualBuf.byteOffset,
  Math.floor(annualBuf.byteLength / 2),
);
const G = meta.grid;
const SCALE = G.scale;

/** Nearest-cell lookup, mirroring the server's own probe. */
function cell(lat, lon) {
  let r = Math.round((lat - G.lat_min) / G.lat_step);
  let c = Math.round((lon - G.lon_min) / G.lon_step);
  r = Math.max(0, Math.min(G.rows - 1, r));
  c = ((c % G.cols) + G.cols) % G.cols;
  return annual[r * G.cols + c] * SCALE;
}

/** Bilinear reference — what the client actually does. */
function bilinear(lat, lon) {
  let row = Math.max(0, Math.min(G.rows - 1, (lat - G.lat_min) / G.lat_step));
  const r0 = Math.floor(row);
  const r1 = r0 + 1 < G.rows ? r0 + 1 : r0;
  const fr = row - r0;
  let col = (lon - G.lon_min) / G.lon_step;
  col = ((col % G.cols) + G.cols) % G.cols;
  const c0 = Math.floor(col);
  const c1 = c0 + 1 < G.cols ? c0 + 1 : 0;
  const fc = col - c0;
  const at = (r, c) => annual[r * G.cols + c];
  const top = at(r0, c0) + (at(r0, c1) - at(r0, c0)) * fc;
  const bot = at(r1, c0) + (at(r1, c1) - at(r1, c0)) * fc;
  return (top + (bot - top) * fr) * SCALE;
}

describe("lightning layer — module wiring", () => {
  test("loads before app.js and exposes the API app.js needs", () => {
    const idx = indexHtml.indexOf("lightning-layer.js");
    const appIdx = indexHtml.indexOf("app.js?");
    expect(idx).toBeGreaterThan(-1);
    expect(appIdx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(appIdx);
    expect(layerJs).toMatch(/window\.LightningLayer\s*=/);
    expect(layerJs).toMatch(/getTileLayer/);
    expect(layerJs).toMatch(/function init\(map\)/);
  });

  test("is registered in WEATHER_OVERLAYS so it gets the dropdown checkbox", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.LightningLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.LightningLayer\.init\(map\)/);
  });

  test("is in the asset list that gets stamped", () => {
    expect(bumpSh).toMatch(/lightning-layer\.js/);
    expect(indexHtml).toMatch(/lightning-layer\.js\?v=\d+/);
  });

  test("the probe owns map clicks so a tap reads density instead of submitting", () => {
    expect(appJs).toMatch(/window\.LightningLayer\.blocksClick\(\)/);
    expect(layerJs).toMatch(/blocksClick:\s*\(\)\s*=>\s*state\.enabled\s*&&\s*state\.probeMode/);
  });

  test("the hover HUD aggregates it", () => {
    expect(hoverJs).toMatch(/\["⚡",\s*"LightningLayer"\]/);
  });

  test("the legend lives in the layers dropdown, not floating over the map", () => {
    expect(layerJs).toMatch(/querySelector\("\.leaflet-control-layers-list"\)/);
    expect(stylesCss).toMatch(/\.leaflet-control-layers-lightning/);
  });

  test("it has its own pane, above the temperature field and below the isobars", () => {
    expect(layerJs).toMatch(/createPane\("lightningPane"\)/);
    const m = layerJs.match(/lightningPane"\)\.style\.zIndex = "(\d+)"/);
    expect(m).not.toBeNull();
    const z = Number(m[1]);
    expect(z).toBeGreaterThan(355); // above the temperature field (355)
    expect(z).toBeLessThan(360);    // below the isobars (360)
  });
});

describe("lightning layer — published data", () => {
  test("meta.json describes the grid the client expects", () => {
    expect(meta.grid.rows).toBe(2160);
    expect(meta.grid.cols).toBe(4320);
    expect(meta.grid.dtype).toBe("uint16");
    expect(meta.grid.scale).toBeCloseTo(1e-4, 10);
    expect(meta.v_max).toBeGreaterThan(0);
    expect(meta.power).toBeGreaterThan(0);
    expect(meta.power).toBeLessThan(1);
    expect(meta.ramp.length).toBeGreaterThanOrEqual(5);
    expect(meta.alpha.length).toBeGreaterThanOrEqual(3);
    expect(meta.license).toMatch(/CC BY/);
    expect(meta.doi).toMatch(/zenodo/);
  });

  test("the legend ticks do not collide", () => {
    // The scale is a power law, so the tick VALUES bunch at one end of
    // the bar: 0.05 and 0.1 sit 2 % apart in ramp position and their
    // labels overlap completely. The thinning is by RAMP POSITION, and
    // the gap has to be wide enough for a label.
    const ticks = meta.ticks;
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].t - ticks[i - 1].t).toBeGreaterThan(0.07);
    }
    // The top of the scale is the value the reader most wants.
    expect(ticks[ticks.length - 1].year).toBe(54);
    expect(ticks[0].year).toBeGreaterThan(0);
  });

  test("the legend shows one tick row, in the unit people can read", () => {
    // The colour is a function of the DAILY rate, but the annual rate
    // is a fixed multiple of it, so the two share every position — and
    // the annual numbers are short. The per-day rate is in the probe.
    expect(layerJs).toMatch(/lightning-ticks-year/);
    expect(layerJs).not.toMatch(/lightning-ticks-daily/);
    expect(stylesCss).toMatch(/\.lightning-legend-row-year::after/);
  });

  test("the probe states the unit of the period it is showing", () => {
    // An annual field is a rate per year; a monthly field is a total
    // for that month, and months have different lengths.
    expect(layerJs).toMatch(/strokes\/km²\/yr/);
    expect(layerJs).toMatch(/strokes\/km² in /);
    expect(layerJs).toMatch(/\/km²\/day/);
  });

  test("every declared period is published and the right size", () => {
    for (const p of meta.periods) {
      const path = join(DATA_DIR, p.file);
      expect(existsSync(path)).toBe(true);
      // statSync, not readFileSync: these files are 18.7 MB each and
      // reading all thirteen of them would blow the test timeout.
      expect(statSync(path).size).toBe(p.rows * p.cols * 2);
    }
    expect(meta.periods.length).toBe(13); // annual + twelve months
    expect(meta.default_period).toBe("annual");
  });

  test("the grid is the published shape and carries real values", () => {
    expect(annual.length).toBe(G.rows * G.cols);
    let nonZero = 0;
    for (let i = 0; i < annual.length; i += 37) if (annual[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(0);
  });

  test("it is a LIGHTNING field: the tropics carry most of it, the poles none", () => {
    let tropics = 0;
    let polar = 0;
    let total = 0;
    for (let r = 0; r < G.rows; r++) {
      const lat = G.lat_min + r * G.lat_step;
      let band = 0;
      for (let c = 0; c < G.cols; c++) band += annual[r * G.cols + c];
      total += band;
      if (lat > -30 && lat < 30) tropics += band;
      if (lat > 60 || lat < -60) polar += band;
    }
    const share = (tropics / total) * 100;
    const pshare = (polar / total) * 100;
    // NOAA's own figure for this dataset family is "about 70 % in the
    // tropics". A flipped latitude axis moves that share.
    expect(share).toBeGreaterThan(60);
    expect(share).toBeLessThan(85);
    expect(pshare).toBeLessThan(1.5);
  });

  test("the known hotspots are where they belong", () => {
    const maracaibo = cell(9.6, -71.8);
    const congo = cell(-1.1, 28.0);
    const florida = cell(27.0, -81.5);
    const sahara = cell(23.0, 13.0);
    const antarctica = cell(-80.0, 0.0);

    expect(maracaibo).toBeGreaterThan(0.05);
    expect(congo).toBeGreaterThan(0.01);
    expect(florida).toBeGreaterThan(0.01);
    expect(sahara).toBeLessThan(maracaibo / 20);
    expect(antarctica).toBeLessThan(0.0005);
  });

  test("the longitude axis is not mirrored", () => {
    // Maracaibo is the hottest place on Earth; its mirror in Tajikistan
    // is a desert. A sign-flipped longitude would swap them.
    const real = cell(9.6, -71.8);
    const mirror = cell(9.6, 71.8);
    expect(real).toBeGreaterThan(20 * mirror);
  });
});

describe("lightning layer — the client's maths", () => {
  test("it samples the published grid at the published values", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    L._test.useGrid("annual", annual);

    const stored = L._test.sampleStored(9.6, -71.8);
    expect(stored).toBeGreaterThan(1000);
    const daily = L._test.dailyOf(stored);
    expect(daily).toBeGreaterThan(0.05);
    expect(daily).toBeLessThan(0.15);

    // The probe and the painted colour must be the same number.
    const expected = bilinear(9.6, -71.8);
    expect(Math.abs(daily - expected)).toBeLessThan(1e-9);
    // ...and it must be the same REGION as the nearest cell, i.e. the
    // interpolation is not wandering off to a different hot spot.
    expect(Math.abs(daily - cell(9.6, -71.8))).toBeLessThan(0.01);
  });

  test("longitude wraps across the antimeridian", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    L._test.useGrid("annual", annual);
    const east = L._test.sampleStored(0, 179.99);
    const west = L._test.sampleStored(0, -179.99);
    expect(east).not.toBeNull();
    expect(west).not.toBeNull();
    expect(Math.abs(east - west)).toBeLessThan(0.02);
  });

  test("the colour scale is a power law, so the faint field is still visible", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    // A thousandth of the maximum must NOT be the same colour as zero.
    const tTiny = Math.pow(0.001 / meta.v_max, meta.power);
    const tZero = 0;
    expect(tTiny).toBeGreaterThan(tZero + 0.01);
    // ...but it must still be dimmer than the maximum.
    expect(tTiny).toBeLessThan(0.2);
  });

  test("places with no lightning are transparent, not black", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    // The ramp stops at t=0 are fully transparent: 40 % of the globe has
    // no lightning at all and must not be painted over the basemap.
    expect(L._test.alphaAt(meta.alpha, 0)).toBe(0);
    expect(L._test.alphaAt(meta.alpha, meta.alpha[0].t)).toBe(0);
    expect(L._test.alphaAt(meta.alpha, 1)).toBe(255);
  });

  test("the ramp ends bright — black at the top is invisible on a dark basemap", () => {
    const top = meta.ramp[meta.ramp.length - 1].rgb;
    const rgb = [parseInt(top.slice(1, 3), 16), parseInt(top.slice(3, 5), 16), parseInt(top.slice(5, 7), 16)];
    expect(Math.max(...rgb)).toBeGreaterThan(200);
  });

  test("every period shares ONE scale, so months are comparable", () => {
    // v_max and the ramp are global, not per-period.
    expect(meta.v_max).toBeGreaterThan(0);
    expect(meta.periods.every((p) => typeof p.max_daily === "number")).toBe(true);
    // The annual field tops out just under v_max, so the default view
    // uses the whole ramp.
    const annualMax = meta.periods.find((p) => p.id === "annual").max_daily;
    expect(annualMax).toBeGreaterThan(meta.v_max * 0.8);
    expect(annualMax).toBeLessThanOrEqual(meta.v_max);
  });

  test("the year conversion uses the period's own length", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    L._test.useGrid("annual", annual);
    const stored = L._test.sampleStored(9.6, -71.8);
    const annualYear = L._test.yearlyOf(stored);
    expect(annualYear).toBeCloseTo(L._test.dailyOf(stored) * 365, 6);

    const jan = meta.periods.find((p) => p.id === "m01");
    L._test.useGrid("m01", annual);
    const janYear = L._test.yearlyOf(stored);
    expect(janYear).toBeCloseTo(L._test.dailyOf(stored) * jan.days, 6);
  });

  test("the tile rows are sampled in Mercator y", () => {
    const L = loadLayer();
    // The equator is the middle of the Mercator square.
    expect(L._test.tileLat(0.5)).toBeCloseTo(0, 3);
    // Northern latitudes are above the equator, i.e. a SMALLER v.
    expect(L._test.tileLat(0.25)).toBeGreaterThan(0);
    expect(L._test.tileLat(0.75)).toBeLessThan(0);
    expect(L._test.tileLat(0)).toBeCloseTo(85.0511, 2);
  });
});

describe("lightning layer — the tile-to-geography mapping", () => {
  // A tile is 1/n of the world, so one pixel of it is 1/(size*n) of the
  // world. Dividing the within-tile offset by `size` alone spreads the
  // whole globe across every tile: invisible at zoom 0, and at zoom 7
  // it throws the field hundreds of degrees away from where it
  // belongs — a garbled map that still looks like a plausible map.
  const SIZE = 256;

  test("a tile covers exactly its own slice of the world", () => {
    const L = loadLayer();
    for (const z of [0, 1, 3, 7]) {
      const n = 1 << z;
      for (const [tx, ty] of [[0, 0], [Math.floor(n / 2), Math.floor(n / 2)], [n - 1, n - 1]]) {
        const coords = { x: tx, y: ty, z };
        const west = L._test.pixelLatLon(coords, 0, 0, SIZE).lon;
        const east = L._test.pixelLatLon(coords, SIZE - 1, SIZE - 1, SIZE).lon;
        const wantWest = -180 + (360 * tx) / n;
        const wantEast = -180 + (360 * (tx + 1)) / n;
        expect(Math.abs(west - wantWest)).toBeLessThan(1.5);
        expect(Math.abs(east - wantEast)).toBeLessThan(1.5);
        // The tile must NOT spill outside its own slice.
        expect(west).toBeGreaterThanOrEqual(wantWest - 2);
        expect(east).toBeLessThanOrEqual(wantEast + 2);
      }
    }
  });

  test("a pixel's longitude matches where the map puts it", () => {
    const L = loadLayer();
    // Zoom 2, tile x=1 is the second quarter of the world: 90W to 0.
    const coords = { x: 1, y: 1, z: 2 };
    expect(L._test.pixelLatLon(coords, 0, 0, SIZE).lon).toBeCloseTo(-90, 0);
    expect(L._test.pixelLatLon(coords, SIZE - 1, 0, SIZE).lon).toBeCloseTo(0, 0);
    // ...and the middle of it is 45W.
    expect(L._test.pixelLatLon(coords, SIZE / 2, 0, SIZE).lon).toBeCloseTo(-45, 0);
  });

  test("the row axis is Mercator, so the tile's rows are not evenly spaced in latitude", () => {
    const L = loadLayer();
    const coords = { x: 0, y: 0, z: 1 };
    const top = L._test.pixelLatLon(coords, 0, 0, SIZE).lat;
    const mid = L._test.pixelLatLon(coords, 0, SIZE / 2, SIZE).lat;
    const bottom = L._test.pixelLatLon(coords, 0, SIZE - 1, SIZE).lat;
    expect(top).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(bottom);
    // The equator is the middle ROW of the whole Mercator square, so
    // the middle row of the top half of the world is at 45N-ish only
    // because the Mercator square is 85.05 tall — check it is between
    // the equator and the top edge.
    expect(top).toBeLessThanOrEqual(85.06);
    expect(top).toBeGreaterThan(60);
  });

  test("the whole world is covered exactly once, with no overlap", () => {
    const L = loadLayer();
    // Walk the seam between two adjacent tiles and check the longitudes
    // meet: the last pixel of tile x and the first pixel of tile x+1
    // must be one pixel apart, not a whole world apart.
    const z = 4;
    const n = 1 << z;
    const a = L._test.pixelLatLon({ x: 5, y: 0, z }, SIZE - 1, 0, SIZE).lon;
    const b = L._test.pixelLatLon({ x: 6, y: 0, z }, 0, 0, SIZE).lon;
    const step = 360 / (n * SIZE);
    expect(Math.abs(b - a)).toBeLessThan(step * 1.5);
  });
});

describe("lightning layer — the builder", () => {
  test("the builder is a gate, not a checkpoint", () => {
    expect(buildPy).toMatch(/def verify\(\)/);
    expect(buildPy).toMatch(/verification FAILED/);
    expect(buildPy).toMatch(/if not verify\(\)/);
  });

  test("the builder refuses to publish bad data", () => {
    expect(buildPy).toMatch(/def build\(\)/);
    // verify() runs AFTER build(), and a failure stops the build.
    const buildIdx = buildPy.indexOf("rc = build(args.max_points)");
    const verifyIdx = buildPy.indexOf("if not verify():");
    expect(verifyIdx).toBeGreaterThan(buildIdx);
  });

  test("the builder pins the source, its licence and its checksum", () => {
    expect(buildPy).toMatch(/zenodo\.org/);
    expect(buildPy).toMatch(/CC BY 4\.0/);
    expect(buildPy).toMatch(/SOURCE_SHA256/);
    expect(buildPy).toMatch(/SOURCE_BYTES/);
  });

  test("the published grid is the one the builder writes", () => {
    expect(buildPy).toMatch(/grid_annual\.bin/);
    expect(buildPy).toMatch(/grid_m\{m \+ 1:02d\}\.bin/);
    expect(buildPy).toMatch(/GRID_ROWS = 2160/);
    expect(buildPy).toMatch(/GRID_COLS = 4320/);
  });
});
