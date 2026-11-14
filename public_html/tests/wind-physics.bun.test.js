// wind-physics.bun.test.js — the "💨 Wind (GFS)" overlay, behaviourally.
//
// wind-layer.bun.test.js (its sibling) reads the source and matches it
// against regexes: it proves the module is WIRED correctly, not that
// the wind is RIGHT. This file runs the module.
//
// The wind overlay has three layers, and each needs its own proof:
//
//   1. THE DATA     — is grid.bin really the GFS 10 m wind analysis?
//                    worker/wind_verify.py and worker/tests/test_windmap.py
//                    answer that by re-decoding the same cycle.
//
//   2. THE SAMPLER  — does the browser read the right cell for a point?
//                    This file: the module's own sample() is run against
//                    the published grid.bin and the numbers it returns
//                    are compared with values read straight out of the
//                    file and with values read out of the raw GRIB.
//
//   3. THE PHYSICS  — do the particles move the way the wind blows?
//                    This file: the module's own advance() is stepped
//                    and the drawn trails are read back off the canvas
//                    to see which way the flow actually goes on screen.
//
// The harness below runs wind-layer.js with a fake Leaflet, a fake
// canvas and a fetch that serves the REAL published grid — so the
// module's load path (the byte-length gate, the planar u/v split, the
// Int16 decode) is exercised too, not just its maths.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const windJs = readFileSync(join(ROOT, "wind-layer.js"), "utf8");
const meta = JSON.parse(readFileSync(join(ROOT, "data", "wind", "meta.json"), "utf8"));
const gridBuf = readFileSync(join(ROOT, "data", "wind", "grid.bin"));

const G = meta.grid;
const CELLS = G.rows * G.cols;
const RAW = new Int16Array(
  gridBuf.buffer.slice(gridBuf.byteOffset, gridBuf.byteOffset + gridBuf.byteLength)
);
const U = RAW.subarray(0, CELLS);
const V = RAW.subarray(CELLS, CELLS * 2);

// ── an independent read of the published grid ────────────────────────────
// Written the long way round — the grid points are gathered by their
// latitude and longitude and the weights are worked out from those —
// so it is a cross-check on the module, not a copy of it.
function gridAt(lat, lon) {
  const row = Math.round((lat - G.lat_min) / G.lat_step);
  const col = Math.round((((lon - G.lon_min) % 360) + 360) % 360 / G.lon_step) % G.cols;
  return {
    u: U[row * G.cols + col] / G.scale,
    v: V[row * G.cols + col] / G.scale,
  };
}

function bilinearAt(lat, lon) {
  const lonW = ((((lon - G.lon_min) % 360) + 360) % 360) + G.lon_min;
  const x = (lonW - G.lon_min) / G.lon_step;
  const y = (lat - G.lat_min) / G.lat_step;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = (x0 + 1) % G.cols, y1 = Math.min(y0 + 1, G.rows - 1);
  const at = (arr, r, c) => arr[r * G.cols + c] / G.scale;
  const mix = (arr) =>
    (1 - fy) * ((1 - fx) * at(arr, y0, x0) + fx * at(arr, y0, x1)) +
    fy * ((1 - fx) * at(arr, y1, x0) + fx * at(arr, y1, x1));
  return { u: mix(U), v: mix(V) };
}

// ── the harness ──────────────────────────────────────────────────────────
// Web Mercator, the projection the basemap uses. Getting this wrong
// would move the trails relative to the map, so it is the real thing
// and not a linear stand-in.
function projectRaw(lat, lng, scale) {
  const s = Math.sin((lat * Math.PI) / 180);
  // ln(tan φ + sec φ) = ln((1 + s) / (1 - s)) / 2, so the standard
  //   y = (1 - ln(tan φ + sec φ) / π) / 2 * scale
  // is the same as the form below.
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

function unprojectRaw(x, y, scale) {
  const n = Math.PI * (1 - (2 * y) / scale);
  return [Math.atan(Math.sinh(n)) * (180 / Math.PI), (x / scale) * 360 - 180];
}

function makeSandbox(opts = {}) {
  const zoom = opts.zoom ?? 5;
  const size = opts.size ?? { x: 900, y: 700 };
  const scale = 256 * Math.pow(2, zoom);
  const center = opts.center ?? [0, 0];
  const c0 = projectRaw(center[0], center[1], scale);
  const origin = { x: c0.x - size.x / 2, y: c0.y - size.y / 2 };
  const panes = {};
  const rafCbs = [];
  const drawnPaths = [];

  // A synthetic uniform wind field, so the physics can be tested with
  // the SAME wind at two latitudes — the published field has a
  // different wind at every point, which hides what is being checked.
  let servedMeta = meta;
  let servedGrid = gridBuf;
  if (opts.uniform) {
    const cells = G.rows * G.cols;
    const u16 = new Int16Array(cells);
    const v16 = new Int16Array(cells);
    for (let i = 0; i < cells; i++) {
      u16[i] = Math.round(opts.uniform.u * G.scale);
      v16[i] = Math.round(opts.uniform.v * G.scale);
    }
    const both = new Int16Array(cells * 2);
    both.set(u16, 0);
    both.set(v16, cells);
    servedGrid = Buffer.from(both.buffer);
    servedMeta = { ...meta, grid: { ...G }, mean_ms: opts.uniform.u };
  }

  // A Path2D holds many particles' trails at once, one subpath each.
  // The subpaths have to be kept apart: a flat list of points would
  // make the jump from the end of one trail to the start of the next
  // look like a movement of the wind.
  class Path2DStub {
    constructor() { this.subpaths = []; }
    moveTo(x, y) { this.subpaths.push([x, y]); }
    lineTo(x, y) { this.subpaths[this.subpaths.length - 1].push(x, y); }
  }

  const ctx = {
    strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform() {}, clearRect() {},
    stroke(p) { drawnPaths.push(p); },
  };

  const win = { devicePixelRatio: 1, addEventListener() {} };
  const created = [];
  const doc = {
    hidden: false,
    body: { appendChild() {} },
    createElement(tag) {
      const el = {
        tag, className: "", style: {}, width: 0, height: 0,
        hidden: true, isConnected: true,
        setAttribute() {},
        getContext() { return ctx; },
      };
      created.push(el);
      return el;
    },
    addEventListener() {},
  };

  const L = {
    GridLayer: Object.assign(function () {}, {
      prototype: { onAdd() {}, onRemove() {} },
      extend(proto) {
        function Ctor() {}
        Ctor.prototype = Object.assign(Object.create(L.GridLayer.prototype), proto);
        return Ctor;
      },
    }),
    point: (x, y) => ({ x, y }),
  };

  const container = { addEventListener() {} };
  const handlers = {};
  const map = {
    getSize: () => size,
    getBounds() {
      const a = unprojectRaw(origin.x, origin.y, scale);
      const b = unprojectRaw(origin.x + size.x, origin.y + size.y, scale);
      return {
        getNorth: () => a[0], getSouth: () => b[0],
        getWest: () => a[1], getEast: () => b[1],
      };
    },
    latLngToContainerPoint: (ll) => {
      const p = projectRaw(ll[0], ll[1], scale);
      return { x: p.x - origin.x, y: p.y - origin.y };
    },
    containerPointToLatLng: (p) =>
      unprojectRaw(p.x + origin.x, p.y + origin.y, scale),
    getPane: (name) => panes[name] || null,
    createPane(name) {
      panes[name] = { name, style: {}, appendChild() {} };
      return panes[name];
    },
    getContainer: () => container,
    on(names, fn) {
      for (const n of String(names).split(/\s+/)) {
        (handlers[n] = handlers[n] || []).push(fn);
      }
    },
  };

  const fakeFetch = (url) => {
    // Compare the PATH, not the whole string: grid.bin is now fetched as
    // `grid.bin?v=<built>` on purpose (see wind-layer.load) — the
    // version is what stops a truncated copy cached under an older URL
    // from being served for ever.
    const path = String(url).split("?")[0];
    if (path.endsWith("meta.json")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(servedMeta) });
    }
    if (path.endsWith("grid.bin")) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          servedGrid.buffer.slice(
            servedGrid.byteOffset,
            servedGrid.byteOffset + servedGrid.byteLength
          )
        ),
      });
    }
    return Promise.reject(new Error("unexpected fetch " + url));
  };

  const raf = (cb) => { rafCbs.push(cb); return rafCbs.length; };
  const caf = () => {};

  const factory = new Function(
    "window", "document", "L", "Path2D", "requestAnimationFrame",
    "cancelAnimationFrame", "fetch", "XLog", windJs
  );
  factory(win, doc, L, Path2DStub, raf, caf, fakeFetch, undefined);

  return {
    wind: win.WindLayer, map, rafCbs, drawnPaths, scale,
    fire(name, evt) {
      for (const fn of handlers[name] || []) fn(evt);
    },
    probeText() {
      const el = created.find((e) => e.className === "wind-probe");
      return el && !el.hidden ? el.innerHTML : null;
    },
    probeEl() {
      return created.find((e) => e.className === "wind-probe") || null;
    },
    async ready() {
      // The app wires the layer with WindLayer.init(map) and then the
      // dropdown adds it to the map; the module needs the map before
      // it can spawn a particle or calibrate the flow rate.
      win.WindLayer.init(map);
      const layer = win.WindLayer.getTileLayer();
      layer.onAdd(map);
      // The grid is published before start() runs, so waiting for
      // "loaded" alone would return before the first frame is queued.
      for (let i = 0; i < 400; i++) {
        const s = win.WindLayer._stats();
        if (s.loaded && s.particles > 0) {
          await new Promise((r) => setTimeout(r, 0));
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("the wind layer never finished loading");
    },
    runFrames(n) {
      let t = 1000;
      for (let i = 0; i < n; i++) {
        const cb = rafCbs.shift();
        if (!cb) break;
        t += 16.7;
        cb(t);
      }
    },
  };
}

// ── 2. THE SAMPLER ──────────────────────────────────────────────────────
describe("wind sampler — reads the right cell", () => {
  test("the module loads the published grid through its own load path", async () => {
    const sb = makeSandbox();
    await sb.ready();
    const stats = sb.wind._stats();
    expect(stats.loaded).toBe(true);
    expect(stats.runTime).toBe(meta.run_time);
  });

  test("it returns the wind the published analysis holds at a point", async () => {
    const sb = makeSandbox();
    await sb.ready();
    // The expected value is read out of the published file, not
    // hard-coded: the GFS analysis is republished every 6 hours, so a
    // golden number here would be stale by morning. The external
    // anchor — the published grid against the raw GRIB, cell by cell
    // — lives in worker/tests/test_windmap.py.
    const s = sb.wind._sample(40.873, -64.739);
    const want = bilinearAt(40.873, -64.739);
    expect(s).not.toBeNull();
    expect(s[0]).toBeCloseTo(want.u, 3);
    expect(s[1]).toBeCloseTo(want.v, 3);
    // And the published file must be a real GFS analysis cycle.
    expect(meta.run_time).toMatch(/^\d{4}-\d{2}-\d{2}T(00|06|12|18):00:00Z$/);
  });

  test("it agrees with an independent read of grid.bin", async () => {
    const sb = makeSandbox();
    await sb.ready();
    for (const [lat, lon] of [
      [40.873, -64.739], [41.74, -82.39], [51.5, -0.13], [35.68, 139.69],
      [-33.87, 151.21], [0, 0], [60, -40], [-25, -55], [25, 55],
    ]) {
      const got = sb.wind._sample(lat, lon);
      const want = bilinearAt(lat, lon);
      expect(got[0]).toBeCloseTo(want.u, 3);
      expect(got[1]).toBeCloseTo(want.v, 3);
    }
  });

  test("a grid point returns that cell's value exactly", async () => {
    const sb = makeSandbox();
    await sb.ready();
    for (const [lat, lon] of [[40, -64], [10, 100], [-70, 170]]) {
      const got = sb.wind._sample(lat, lon);
      const want = gridAt(lat, lon);
      expect(got[0]).toBeCloseTo(want.u, 3);
      expect(got[1]).toBeCloseTo(want.v, 3);
    }
  });

  test("a point off the grid returns nothing", async () => {
    const sb = makeSandbox();
    await sb.ready();
    expect(sb.wind._sample(95, 0)).toBeNull();
    expect(sb.wind._sample(-95, 0)).toBeNull();
  });

  test("longitude wraps instead of being rejected", async () => {
    const sb = makeSandbox();
    await sb.ready();
    const east = sb.wind._sample(0, 359.5);
    const west = sb.wind._sample(0, -0.5);
    expect(east[0]).toBeCloseTo(west[0], 6);
    expect(east[1]).toBeCloseTo(west[1], 6);
  });

  test("the antimeridian is interpolated ACROSS the seam", async () => {
    // The two neighbours of the last column are the last column and
    // column ZERO. Clamping the column instead leaves a stripe at the
    // dateline where the wind is stale and the particles visibly stall.
    //
    // The seam is half a cell from the edge, so the probe point moves
    // with the grid: it was 359.5°E on the 1° grid and is 359.875°E
    // on the 0.25° one.
    const sb = makeSandbox();
    await sb.ready();
    const step = G.lon_step;
    const seam = 360 - step / 2;
    const half = sb.wind._sample(0, seam);
    const a = gridAt(0, 360 - step), b = gridAt(0, 0);
    expect(half[0]).toBeCloseTo((a.u + b.u) / 2, 2);
    expect(half[1]).toBeCloseTo((a.v + b.v) / 2, 2);
  });

  test("the u and v planes are not swapped", async () => {
    const sb = makeSandbox();
    await sb.ready();

    // (1) THE SAMPLER, CROSS-CHECKED AGAINST AN INDEPENDENT READ.
    // bilinearAt() above reads the published grid.bin the long way
    // round — it is a cross-check, not a copy of the module. If the
    // module decoded the two planar planes in the wrong order then
    // s[0] would come back equal to the grid's v and s[1] its u, so
    // this fails however GFS filled the grid today.
    //
    // This assertion used to be a MAGNITUDE THRESHOLD on a single
    // point — "u > 4 m/s at 50S/40W" — which went red over CORRECT
    // data whenever the analysis ran calm (the 2026-10-29 cycle has
    // 3.72 m/s there). A data-dependent number cannot prove a
    // DECODING property; a cross-check can.
    for (const [lat, lon] of [[-50, -40], [0, 0], [50, -80], [-45, 90], [35, 140]]) {
      const s = sb.wind._sample(lat, lon);
      const g = bilinearAt(lat, lon);
      expect(s[0]).toBeCloseTo(g.u, 2);
      expect(s[1]).toBeCloseTo(g.v, 2);
    }

    // (2) THE CIRCULATION, ZONALLY AVERAGED. One point can go calm on
    // any given analysis; the circulation cannot. The roaring forties
    // blow EASTWARD (mean u > 0) and the equatorial trades WESTWARD
    // (mean u < 0) in every GFS cycle — and a u/v swap inverts those
    // signs, because it puts the meridional mean where the zonal one
    // belongs. Averaging the whole latitude belt every 30 degrees of
    // longitude makes the assertion immune to the cycle, which is the
    // entire point of writing it this way.
    const zonalMeanU = (lo, hi) => {
      let sum = 0, n = 0;
      for (let lat = lo; lat <= hi; lat += 5) {
        for (let lon = 0; lon < 360; lon += 30) {
          sum += sb.wind._sample(lat, lon)[0];
          n++;
        }
      }
      return sum / n;
    };
    expect(zonalMeanU(-55, -40)).toBeGreaterThan(2);
    expect(zonalMeanU(-10, 10)).toBeLessThan(-0.5);
  });
});

// The mean screen-space direction of every trail segment that was
// actually drawn. The subpaths have to be kept apart: a Path2D holds
// one trail per particle, and the jump from the end of one to the
// start of the next is not a movement of the wind.
function trailDirection(paths) {
  let sx = 0, sy = 0, n = 0;
  for (const p of paths) {
    for (const sp of p.subpaths) {
      for (let i = 2; i < sp.length; i += 2) {
        sx += sp[i] - sp[i - 2];
        sy += sp[i + 1] - sp[i - 1];
        n++;
      }
    }
  }
  return { sx, sy, n };
}

// ── 3. THE PHYSICS ──────────────────────────────────────────────────────
describe("wind physics — particles move the way the wind blows", () => {
  // The directional tests use the SYNTHETIC uniform field, not the live
  // GFS grid: the 6-hourly refresh moves the real wind at a fixed
  // coordinate, and a test that pins one cell's direction breaks the
  // moment the cycle shifts it (the easterly/southerly tests flapped
  // exactly that way on 2026-10-29). The physics is what is under test.
  test("an easterly wind moves a particle east", async () => {
    const sb = makeSandbox({ uniform: { u: 10, v: 0 } });
    await sb.ready();
    const a = sb.wind._advance(0, 0, 1);
    expect(a).not.toBeNull();
    expect(a.lng).toBeGreaterThan(0);
  });

  test("a southerly wind moves a particle south", async () => {
    const sb = makeSandbox({ uniform: { u: 0, v: -10 } });
    await sb.ready();
    const a = sb.wind._advance(40.873, -64.739, 1);
    expect(a.v).toBeLessThan(0);
    expect(a.lat).toBeLessThan(40.873);
  });

  test("the ground distance is the speed times the time, at any latitude", async () => {
    // This is the cos(lat) correction in one line: the distance a
    // particle covers on the ground must not depend on the latitude
    // it is covering it at. Without the correction the flow near the
    // poles races sideways across the screen.
    const sb = makeSandbox();
    await sb.ready();
    const scale = sb.wind._speedScale();
    for (const lat of [0, 20, 45, 60, 75]) {
      const a = sb.wind._advance(lat, 10, 1);
      const expected = a.speed * scale * 111320;
      expect(a.metres).toBeCloseTo(expected, 3);
    }
  });

  test("a degree of longitude shrinks by cos(lat)", async () => {
    // The same eastward wind covers more degrees of longitude the
    // further north you go, because a degree of longitude is shorter
    // there. Clamping instead of dividing would keep the degrees
    // constant and make the flow visibly race near the poles.
    //
    // A synthetic uniform field: the published one has a different
    // wind at every point, which hides what is being checked.
    const sb = makeSandbox({ uniform: { u: 10, v: 0 } });
    await sb.ready();
    const d = (lat) => Math.abs(sb.wind._advance(lat, 10, 1).lng - 10);
    expect(d(60) / d(0)).toBeCloseTo(1 / Math.cos((60 * Math.PI) / 180), 3);
    expect(d(75) / d(0)).toBeCloseTo(1 / Math.cos((75 * Math.PI) / 180), 3);
  });

  test("the ground distance does not depend on the latitude", async () => {
    // The same wind covers the same distance on the ground whether it
    // is at the equator or at the pole — that is what the cos(lat)
    // correction is for.
    const sb = makeSandbox({ uniform: { u: 10, v: 6 } });
    await sb.ready();
    const at0 = sb.wind._advance(0, 10, 1);
    const at60 = sb.wind._advance(60, 10, 1);
    expect(at60.metres).toBeCloseTo(at0.metres, 6);
  });

  test("the step points the way the wind blows", async () => {
    // The bearing of the displacement on the GROUND has to match the
    // bearing of the wind vector: an easterly wind sends the particle
    // east, not west. (The bearing in degrees of longitude is
    // distorted by the cos(lat) correction — the ground bearing is the
    // one that has to line up.)
    const sb = makeSandbox();
    await sb.ready();
    for (const [lat, lon] of [[40.873, -64.739], [41.74, -82.39], [51.5, -0.13]]) {
      const a = sb.wind._advance(lat, lon, 1);
      const cosLat = Math.cos((lat * Math.PI) / 180);
      const to = (Math.atan2(a.u, a.v) * 180) / Math.PI;
      const moved = (Math.atan2((a.lng - lon) * cosLat, a.lat - lat) * 180) / Math.PI;
      const diff = Math.abs(((to - moved + 540) % 360) - 180);
      expect(diff).toBeLessThan(0.001);
    }
  });

  test("a wind that comes FROM the north is reported as coming from the north", async () => {
    // The probe prints the meteorological direction — the way the wind
    // comes FROM, which is the opposite of the way it blows towards.
    // from = atan2(-u, -v). The sign rules are the QUADRANT rules:
    //   u > 0 (blows east)  ⇒ -u < 0 ⇒ sin(from) < 0 ⇒ from ∈ (180, 360)
    //   u < 0 (blows west)  ⇒ -u > 0 ⇒ sin(from) > 0 ⇒ from ∈ (0, 180)
    //   v > 0 (blows north) ⇒ -v < 0 ⇒ cos(from) < 0 ⇒ from ∈ (90, 270)
    //   v < 0 (blows south) ⇒ -v > 0 ⇒ cos(from) > 0 ⇒ from < 90 or > 270
    // An earlier version asserted one-sided bounds for the v rules
    // (from > 90 / from < 90) which silently held only while the cell
    // sat in one quadrant and broke the moment the 6-hourly GFS cycle
    // shifted it — the rules above survive every cycle.
    const sb = makeSandbox();
    await sb.ready();
    const s = sb.wind._sample(40.873, -64.739);
    const from = ((Math.atan2(-s[0], -s[1]) * 180) / Math.PI + 360) % 360;
    if (s[0] > 0) expect(from).toBeGreaterThan(180);
    if (s[0] < 0) expect(from).toBeLessThan(180);
    if (s[1] > 0) {
      expect(from).toBeGreaterThan(90);
      expect(from).toBeLessThan(270);
    }
    if (s[1] < 0) {
      expect(from < 90 || from > 270).toBe(true);
    }
    // And the reading is a real bearing, not NaN.
    expect(Number.isFinite(from)).toBe(true);
  });

  test("the drawn trails point the way the wind blows", async () => {
    // The end-to-end check: run real frames and read the trails back
    // off the canvas.
    //
    // On a Web Mercator map the screen direction of a ground vector is
    // (u, -v): the cos(lat) in the geographic displacement and the
    // 1/cos(lat) of the Mercator y axis cancel, so an easterly wind
    // draws to the right and a northerly one draws upwards.
    const cases = [
      { uniform: { u: 10, v: 0 }, expect: [1, 0], label: "an easterly wind draws east" },
      { uniform: { u: 0, v: 10 }, expect: [0, -1], label: "a northerly wind draws north" },
      { uniform: { u: 8, v: 8 }, expect: [1, -1], label: "a south-westerly draws south-east" },
    ];
    for (const c of cases) {
      const sb = makeSandbox({ ...c, zoom: 7 });
      await sb.ready();
      sb.runFrames(40);

      const { sx, sy, n } = trailDirection(sb.drawnPaths);
      expect(n).toBeGreaterThan(100);
      const angle = (Math.atan2(sy, sx) * 180) / Math.PI;
      const want = (Math.atan2(c.expect[1], c.expect[0]) * 180) / Math.PI;
      const diff = Math.abs(((angle - want + 540) % 360) - 180);
      expect(diff).toBeLessThan(3);
    }
  });

  test("the trails over the real field follow the wind there", async () => {
    // The same check, with the published analysis in the viewport: over
    // the North Atlantic at 40.9N, 64.7W the wind is a northerly, so
    // the trails must run down the screen.
    //
    // AND EACH TRAIL IS COMPARED WITH THE WIND AT ITS OWN MIDPOINT \u2014
    // not with one cell's sample. The field over an ocean is NOT
    // uniform, so an aggregate over the whole viewport and a single
    // point's sample disagree the moment the 6-hourly cycle changes the
    // wind here: measured a **51\u00b0 mismatch** against the
    // 2026-11-13 06:00Z cycle, where the previous cycle gave 15\u00b0.
    // A test that pins one cell's direction breaks on every cycle
    // change \u2014 which is exactly what happened on 2026-10-29 with the
    // easterly/southerly tests, and why the rest of this file uses a
    // SYNTHETIC uniform field.
    //
    // The physics is what is under test, and the physics is per
    // particle: every trail must follow the wind WHERE IT IS.
    const sb = makeSandbox({ zoom: 8, center: [40.873, -64.739] });
    await sb.ready();
    sb.runFrames(40);

    let checked = 0;
    let agree = 0;
    for (const p of sb.drawnPaths) {
      for (const sp of p.subpaths) {
        if (sp.length < 6) continue;
        // The second segment of the trail: the first is the spawn.
        const i = 2;
        const dx = sp[i] - sp[i - 2];
        const dy = sp[i + 1] - sp[i - 1];
        if (!dx && !dy) continue;
        const [lat, lon] = sb.map.containerPointToLatLng({
          x: (sp[i] + sp[i - 2]) / 2,
          y: (sp[i + 1] + sp[i - 1]) / 2,
        });
        const s = sb.wind._sample(lat, lon);
        if (!s) continue;
        // On a Web Mercator screen a ground vector's direction is
        // (u, -v): the cos(lat) of the geographic displacement and the
        // 1/cos(lat) of the Mercator y axis cancel.
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const want = (Math.atan2(-s[1], s[0]) * 180) / Math.PI;
        const diff = Math.abs(((angle - want + 540) % 360) - 180);
        checked++;
        if (diff < 45) agree++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    // Most of them must follow the wind where they are.
    expect(agree / checked).toBeGreaterThan(0.8);
  });

  test("the flow does not stop at the dateline", async () => {
    // A particle that crosses 180° keeps moving instead of dying at
    // the edge of the array.
    const sb = makeSandbox();
    await sb.ready();
    const a = sb.wind._advance(0, 179.99, 1);
    expect(a).not.toBeNull();
    expect(Number.isFinite(a.lng)).toBe(true);
  });

  test("the particles SURVIVE west of the antimeridian", async () => {
    // Owner report 2026-11-10: *"notice the right side has the wind
    // but the left doesn't"* — the western Pacific was blank.
    //
    // Leaflet's longitude space is CONTINUOUS: a view centred at -168
    // runs from about -199 to -137, and the particles on the far side of
    // the dateline are legitimately at -199. A FIXED -180…185 window
    // killed them EVERY FRAME — and `spawn()` picks the next longitude
    // from the same window, so the replacement died at once too.
    //
    // THE DISCRIMINATOR IS THE DRAWN TRAIL: a killed particle is
    // skipped (`continue`) BEFORE it is drawn, so with the old guard
    // nothing was ever painted west of the dateline.
    const sb = makeSandbox({ zoom: 5, center: [19, -168],
                             size: { x: 1400, y: 900 } });
    await sb.ready();

    // The view really does straddle the dateline.
    const b = sb.map.getBounds();
    expect(b.getWest()).toBeLessThan(-180);
    expect(b.getEast()).toBeGreaterThan(-180);

    sb.runFrames(60);

    // Where is the dateline on this screen?
    const x180 = sb.map.latLngToContainerPoint([19, -180]).x;
    const xs = [];
    for (const p of sb.drawnPaths) {
      for (const sub of p.subpaths) {
        for (let i = 0; i < sub.length; i += 2) xs.push(sub[i]);
      }
    }
    expect(xs.length, "nothing was drawn at all").toBeGreaterThan(100);
    const west = xs.filter((x) => x < x180).length;
    expect(west, "nothing was drawn west of the antimeridian").toBeGreaterThan(0);
    // And the particles are really there, on the far side of it.
    const ps = sb.wind._state.particles;
    expect(ps.length).toBeGreaterThan(10);
    expect(ps.some((p) => p.lng < -180),
           "no particle is west of the antimeridian").toBe(true);
  });
});

// ── the probe ───────────────────────────────────────────────────────────
describe("wind probe — reads the point under the cursor", () => {
  // The expected reading is derived from the published field, so it
  // survives the 6-hourly GFS cycle.
  function expectedReading(sb, lat, lng) {
    const s = sb.wind._sample(lat, lng);
    const speed = Math.hypot(s[0], s[1]);
    const from = ((Math.atan2(-s[0], -s[1]) * 180) / Math.PI + 360) % 360;
    const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return {
      speed: speed.toFixed(1),
      // Owner ask (2026-11-04): m/s is gone from every reader-facing
      // wind reading — miles/hour, kilometres/hour and knots instead.
      mph: Math.round(speed * 2.23694),
      kmh: Math.round(speed * 3.6),
      kt: Math.round(speed * 1.94384),
      name: names[Math.round(from / 22.5) % 16],
      deg: Math.round(from),
    };
  }

  test("it reports the wind at the point the cursor is on", async () => {
    const sb = makeSandbox();
    await sb.ready();
    const want = expectedReading(sb, 40.873, -64.739);
    sb.fire("mousemove", {
      latlng: { lat: 40.873, lng: -64.739 },
      containerPoint: { x: 100, y: 200 },
    });
    const text = sb.probeText();
    expect(text).not.toBeNull();
    expect(text).toMatch(new RegExp(`${want.mph} mph · ${want.kmh} km/h · ${want.kt} kt`));
    expect(text).toMatch(new RegExp(`from ${want.name} \\(${want.deg}°\\)`));
  });

  test("m/s is GONE from the wind readout", async () => {
    // Owner ask (2026-11-04): *"remove m/s and add miles/hr and kt and
    // km/hr"*. m/s stays the DATA unit — the published grid, the ramp
    // and the export band names are all in m/s — but the reader never
    // sees it.
    const sb = makeSandbox();
    await sb.ready();
    sb.fire("mousemove", {
      latlng: { lat: 40.873, lng: -64.739 },
      containerPoint: { x: 100, y: 200 },
    });
    const text = sb.probeText();
    expect(text).not.toContain("m/s");
    expect(text).toContain("mph");
    expect(text).toContain("kt");
    expect(text).toContain("km/h");
  });

  test("it uses the container point for its position, not the offset", async () => {
    const sb = makeSandbox();
    await sb.ready();
    sb.fire("mousemove", {
      latlng: { lat: 40.873, lng: -64.739 },
      containerPoint: { x: 321, y: 654 },
    });
    const el = sb.probeEl();
    expect(el.style.left).toBe("335px");
    expect(el.style.top).toBe("668px");
  });

  test("it does not use offsetX, which is relative to the pin canvas", async () => {
    // The pin canvas is 300 px wider than the map and offset by -300,
    // so it is the event target over most of the map — and offsetX
    // there is 300 px too big. The probe said "from WNW" where the
    // field said "from N".
    const sb = makeSandbox();
    await sb.ready();
    const want = expectedReading(sb, 40.873, -64.739);
    sb.fire("mousemove", {
      latlng: { lat: 40.873, lng: -64.739 },
      containerPoint: { x: 100, y: 200 },
      offsetX: 400,     // what a raw listener would have seen
      offsetY: 500,
    });
    const text = sb.probeText();
    expect(text).toMatch(new RegExp(`from ${want.name} \\(${want.deg}°\\)`));
  });

  test("it hides when the mouse leaves the map", async () => {
    const sb = makeSandbox();
    await sb.ready();
    sb.fire("mousemove", {
      latlng: { lat: 40.873, lng: -64.739 },
      containerPoint: { x: 100, y: 200 },
    });
    expect(sb.probeText()).not.toBeNull();
    sb.fire("mouseout", {});
    expect(sb.probeText()).toBeNull();
  });
});
