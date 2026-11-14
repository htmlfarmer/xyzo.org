/**
 * Tectonic faults & plate boundaries overlay — USGS + GEM GAF-DB.
 *
 * The invariants that matter:
 *
 *  • THE TWO SOURCES STAY APART. The USGS half is public domain; the
 *    GEM half is CC BY-SA 4.0. One GeoJSON holding both would drag the
 *    ShareAlike term onto the public-domain data, so they are published
 *    in two directories with two meta.json files.
 *
 *  • THE COORDINATES ARE NOT SWAPPED. A lat/lon exchange is a valid
 *    coordinate, so only a probe finds it: the San Andreas has to be in
 *    California, and the plate boundaries have to be in the Pacific and
 *    the Atlantic.
 *
 *  • A FAULT NEVER SWALLOWS A MAP CLICK. It is scenery.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");

const faultJs = readFileSync(join(ROOT, "fault-layer.js"), "utf8");
const builder = readFileSync(join(REPO, "scripts", "faults_build.py"), "utf8");

const FAULTS_DIR = join(ROOT, "data", "faults");
const GEM_DIR = join(ROOT, "data", "gem-faults");

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ── the module ──────────────────────────────────────────────────────────
describe("fault layer — module contract", () => {
  test("exposes window.FaultLayer with the documented API", () => {
    expect(faultJs).toMatch(/window\.FaultLayer\s*=/);
    expect(faultJs).toMatch(/LAYER_NAME:\s*"🪨 Tectonic faults \(USGS\)"/);
    for (const fn of [
      "init", "getTileLayer", "setEnabled", "setOpacity", "getOpacity",
      "blocksClick", "onLayerToggled", "sampleAt", "mountLegend",
    ]) {
      expect(faultJs, `FaultLayer.${fn} missing`).toMatch(
        new RegExp(`\\b${fn}\\s*:`)
      );
    }
    expect(faultJs).toMatch(/isEnabled:\s*\(\)\s*=>\s*state\.enabled/);
  });

  test("never calls console.* directly (AGENTS.md)", () => {
    const direct = faultJs.match(/^\s*console\.(log|warn|error|debug|info)\(/gm) || [];
    expect(direct).toEqual([]);
    // It uses the house logger instead.
    expect(faultJs).toMatch(/window\.XLog/);
  });

  test("a fault NEVER swallows a map click", () => {
    const fn = faultJs.match(/function blocksClick\(\)\s*\{[^}]+\}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toMatch(/return false/);
    // The pane is pointer-events: none and every path is non-interactive.
    expect(faultJs).toMatch(/pointerEvents\s*=\s*"none"/);
    expect(faultJs).toMatch(/interactive:\s*false/);
  });

  test("the GeoJSON group carries setOpacity/getOpacity", () => {
    // A raw L.geoJSON has no setOpacity, and OverlayOpacity.mount() calls
    // it on every overlay — the throw aborted app.js once already.
    expect(faultJs).toMatch(/state\.layer\.setOpacity\s*=/);
    expect(faultJs).toMatch(/state\.layer\.getOpacity\s*=/);
  });

  test("the layer owns a pane of its own, under the pins", () => {
    expect(faultJs).toMatch(/const PANE = "faultPane"/);
    expect(faultJs).toMatch(/PANE_Z = 367/);
    expect(faultJs).toMatch(/createPane\(PANE\)/);
  });

  test("the pane z-index does not collide with any other overlay pane", () => {
    // The uniqueness check has to read the SOURCE, not a hand-kept
    // table: a table can never fire for a layer nobody added to it.
    const LEAFLET_BUILTIN = new Set([
      "mapPane", "tilePane", "overlayPane", "shadowPane", "markerPane",
      "tooltipPane", "popupPane", "controlPane",
    ]);
    const NAME_RE = /createPane\(["'](\w+Pane)["']\)|const\s+(?:\w*_)?PANE\s*=\s*["'](\w+Pane)["']|\bpane:\s*["'](\w+Pane)["']/g;
    const Z_RE = /(?:PANE_Z\s*=\s*|paneZ:\s*)(\d{2,3})|(?:\bpane\.style\.zIndex\s*=\s*["']|getPane\(["']\w+["']\)\.style\.zIndex\s*=\s*["'])(\d{2,3})/g;
    const byPane = new Map();
    for (const name of readdirSync(ROOT)) {
      if (!name.endsWith(".js")) continue;
      if (name === "field-layer.js") continue;   // a factory
      const js = readFileSync(join(ROOT, name), "utf8");
      const panes = [...new Set(
        [...js.matchAll(NAME_RE)].map((m) => m[1] || m[2] || m[3]).filter(Boolean)
      )].filter((p) => !LEAFLET_BUILTIN.has(p));
      if (!panes.length) continue;
      const zs = [...new Set([...js.matchAll(Z_RE)].map((m) => Number(m[1] || m[2])))];
      expect(zs.length, `${name} declares a pane but no z-index`).toBe(1);
      for (const p of panes) {
        const prior = byPane.get(p);
        if (prior) {
          // The same pane declared in two files must agree, or whichever
          // runs last wins the slot.
          expect(zs[0], `${p}: ${prior.z} in ${prior.file} vs ${zs[0]} in ${name}`)
            .toBe(prior.z);
        } else {
          byPane.set(p, { z: zs[0], file: name });
        }
      }
    }
    const byZ = new Map();
    for (const [pane, v] of byPane) {
      const list = byZ.get(v.z) || [];
      list.push(`${pane} (${v.file})`);
      byZ.set(v.z, list);
    }
    for (const [z, list] of byZ) {
      expect(list.length, `z=${z} claimed by two panes: ${list.join(" vs ")}`).toBe(1);
      expect(z, `${list[0]} must stay under the pin canvas`).toBeLessThan(400);
    }
    expect(byZ.has(367)).toBe(true);
  });

  test("there is a legend with the colour key", () => {
    expect(faultJs).toMatch(/function mountLegend\(\)/);
    expect(faultJs).toMatch(/fault-legend/);
    expect(faultJs).toMatch(/leaflet-control-layers-list/);
    // It is inserted as a SIBLING of the overlay list — Leaflet empties
    // and rebuilds .leaflet-control-layers-overlays on every change.
    expect(faultJs).not.toMatch(/leaflet-control-layers-overlays["']\)\.appendChild/);
  });

  test("the colour map covers the age classes and the plate boundary", () => {
    expect(faultJs).toMatch(/FALLBACK_AGE_COLORS/);
    expect(faultJs).toMatch(/"historic":\s*"#ff4d6d"/);
    expect(faultJs).toMatch(/"latest-quaternary":\s*"#ff9f43"/);
    expect(faultJs).toMatch(/"unspecified":\s*"#8b9bb4"/);
    expect(faultJs).toMatch(/FALLBACK_PLATE_COLOR = "#ffffff"/);
  });

  test("the zoom gate and the viewport gate are both applied", () => {
    // min_zoom keeps a world view from being a hairball; the viewport
    // keeps the browser from drawing 49,000 paths at once.
    expect(faultJs).toMatch(/min_zoom/);
    expect(faultJs).toMatch(/function candidates\(/);
    expect(faultJs).toMatch(/getBounds\(\)\.pad\(/);
  });

  test("it renders on a canvas, not thousands of SVG paths", () => {
    expect(faultJs).toMatch(/L\.canvas/);
  });
});

// ── the builder ─────────────────────────────────────────────────────────
describe("fault overlay — the build script", () => {
  test("it names the two sources and their real download URLs", () => {
    expect(builder).toMatch(/earthquake\.usgs\.gov\/learn\/plate-boundaries\.kmz/);
    expect(builder).toMatch(/earthquake\.usgs\.gov\/static\/lfs\/nshm\/qfaults\/qfaults\.kmz/);
    expect(builder).toMatch(/gem-global-active-faults/);
  });

  test("it states both licences accurately", () => {
    // USGS is a work of the US Government: public domain.
    expect(builder).toMatch(/Public domain — US Government work \(USGS\)/);
    // GEM GAF-DB is CC BY-SA 4.0 — attribution AND share-alike.
    expect(builder).toMatch(/CC BY-SA 4\.0/);
    expect(builder).toMatch(/GEM Global Active Faults Database/);
  });

  test("it publishes faults.geojson + meta.json, and the GEM pair", () => {
    expect(builder).toMatch(/public_html",\s*"data",\s*"faults"/);
    expect(builder).toMatch(/faults\.geojson/);
    expect(builder).toMatch(/gem-faults\.geojson/);
  });

  test("verify() is a GATE — it refuses to publish", () => {
    expect(builder).toMatch(/def verify\(/);
    expect(builder).toMatch(/raise SystemExit\("verify\(\) failed — refusing to publish"\)/);
    // The probes are the known places only a swap can break.
    expect(builder).toMatch(/San Andreas/);
    expect(builder).toMatch(/Hayward/);
    expect(builder).toMatch(/Aleutian plate boundary/);
    expect(builder).toMatch(/Mid-Atlantic ridge/);
  });

  test("the swap guard is explicit", () => {
    // A lat/lon exchange puts the San Andreas in the sea east of the
    // Philippines — a valid coordinate, so only a negative probe finds it.
    expect(builder).toMatch(/SWAP_GUARD/);
    expect(builder).toMatch(/122\.30/);
  });

  test("the geometry is simplified and quantised", () => {
    expect(builder).toMatch(/def douglas_peucker\(/);
    expect(builder).toMatch(/SIMPLIFY_TOL_DEG = 0\.01/);
    expect(builder).toMatch(/COORD_DECIMALS = 4/);
  });

  test("it has the house argparse surface", () => {
    expect(builder).toMatch(/--out/);
    expect(builder).toMatch(/--verify-only/);
    expect(builder).toMatch(/--refresh/);
  });
});

// ── the published data ──────────────────────────────────────────────────
describe("fault overlay — the published data", () => {
  test("faults.geojson + meta.json exist", () => {
    expect(existsSync(join(FAULTS_DIR, "faults.geojson"))).toBe(true);
    expect(existsSync(join(FAULTS_DIR, "meta.json"))).toBe(true);
  });

  test("meta.json carries the licence and the attribution", () => {
    const m = readJson(join(FAULTS_DIR, "meta.json"));
    expect(typeof m.license).toBe("string");
    expect(m.license.length).toBeGreaterThan(4);
    expect(m.license).toMatch(/Public domain/);
    expect(m.license).not.toMatch(/NonCommercial|ShareAlike/);
    expect(typeof m.attribution).toBe("string");
    expect(m.attribution).toMatch(/USGS/);
    expect(m.feature_count).toBeGreaterThan(1000);
  });

  test("every feature is a LineString with the documented properties", () => {
    const fc = readJson(join(FAULTS_DIR, "faults.geojson"));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBeGreaterThan(1000);
    for (const f of fc.features.slice(0, 400)) {
      expect(f.geometry.type).toBe("LineString");
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      const [lon, lat] = f.geometry.coordinates[0];
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      const p = f.properties;
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(["quaternary-fault", "plate-boundary"]).toContain(p.kind);
      expect(typeof p.age).toBe("string");
      expect(typeof p.min_zoom).toBe("number");
      expect(typeof p.source).toBe("string");
    }
  });

  test("the coordinates are quantised to 4 decimals", () => {
    const fc = readJson(join(FAULTS_DIR, "faults.geojson"));
    for (const f of fc.features.slice(0, 50)) {
      for (const [lon, lat] of f.geometry.coordinates) {
        expect(Math.abs(lon * 10000 - Math.round(lon * 10000))).toBeLessThan(1e-6);
        expect(Math.abs(lat * 10000 - Math.round(lat * 10000))).toBeLessThan(1e-6);
      }
    }
  });

  test("the San Andreas and the Hayward are in California, not swapped", () => {
    const fc = readJson(join(FAULTS_DIR, "faults.geojson"));
    const faults = fc.features.filter((f) => f.properties.kind === "quaternary-fault");
    const named = (needle) => faults.filter(
      (f) => f.properties.name.toLowerCase().includes(needle)
    );
    const san = named("san andreas");
    const hay = named("hayward");
    expect(san.length).toBeGreaterThan(10);
    expect(hay.length).toBeGreaterThan(1);
    // Every San Andreas trace must be in California — nowhere else on
    // Earth, and emphatically not at the swapped position (122.3°E).
    for (const f of san) {
      for (const [lon, lat] of f.geometry.coordinates) {
        expect(lon).toBeGreaterThan(-125);
        expect(lon).toBeLessThan(-114);
        expect(lat).toBeGreaterThan(32);
        expect(lat).toBeLessThan(42);
      }
    }
    for (const f of hay) {
      for (const [lon, lat] of f.geometry.coordinates) {
        expect(lon).toBeGreaterThan(-123);
        expect(lon).toBeLessThan(-121);
        expect(lat).toBeGreaterThan(36);
        expect(lat).toBeLessThan(39);
      }
    }
  });

  test("the plate boundaries are global", () => {
    const fc = readJson(join(FAULTS_DIR, "faults.geojson"));
    const plates = fc.features.filter((f) => f.properties.kind === "plate-boundary");
    expect(plates.length).toBeGreaterThan(1000);
    // One in the North Pacific, one on the Mid-Atlantic ridge.
    const inBox = (lo1, la1, lo2, la2) => plates.some((f) =>
      f.geometry.coordinates.some(([lon, lat]) =>
        lon >= lo1 && lon <= lo2 && lat >= la1 && lat <= la2));
    expect(inBox(-155, 50, -145, 60)).toBe(true);   // Aleutians
    expect(inBox(-35, -5, -25, 5)).toBe(true);       // Mid-Atlantic
    expect(inBox(120, 30, 145, 45)).toBe(true);      // Japan / China
  });

  test("the zoom ladder keeps a world view readable", () => {
    const fc = readJson(join(FAULTS_DIR, "faults.geojson"));
    const hist = {};
    for (const f of fc.features) {
      const z = f.properties.min_zoom;
      hist[z] = (hist[z] || 0) + 1;
    }
    // Only the plate boundaries (and a handful of the longest faults)
    // are drawn at world zoom.
    expect(hist[0]).toBeGreaterThan(1000);
    expect(hist[0]).toBeLessThan(fc.features.length * 0.1);
    // …and the deepest bucket is where the short local traces live.
    expect(Object.keys(hist).length).toBeGreaterThan(3);
  });

  test("the GEM half is published separately, with its own licence", () => {
    expect(existsSync(join(GEM_DIR, "gem-faults.geojson"))).toBe(true);
    const m = readJson(join(GEM_DIR, "meta.json"));
    expect(m.license).toBe("CC BY-SA 4.0");
    expect(m.attribution).toMatch(/GEM/);
    expect(m.feature_count).toBeGreaterThan(5000);
    const fc = readJson(join(GEM_DIR, "gem-faults.geojson"));
    expect(fc.features.length).toBe(m.feature_count);
    for (const f of fc.features.slice(0, 200)) {
      expect(f.geometry.type).toBe("LineString");
      expect(f.properties.kind).toBe("gem-active-fault");
    }
  });

  test("the GEM faults are genuinely global, not a US repeat", () => {
    const fc = readJson(join(GEM_DIR, "gem-faults.geojson"));
    const inBox = (lo1, la1, lo2, la2) => fc.features.some((f) =>
      f.geometry.coordinates.some(([lon, lat]) =>
        lon >= lo1 && lon <= lo2 && lat >= la1 && lat <= la2));
    expect(inBox(165, -47, 178, -40)).toBe(true);    // New Zealand
    expect(inBox(28, 35, 45, 42)).toBe(true);       // Turkey / the Aegean
    expect(inBox(-125, 32, -114, 42)).toBe(true);    // California
  });
});

// ── the HUD sampler ─────────────────────────────────────────────────────
describe("fault layer — HUD sampling", () => {
  function loadLayer() {
    const win = {};
    const fn = new Function("window", faultJs);
    fn(win);
    return win.FaultLayer;
  }

  test("sampleAt names the nearest trace", () => {
    const layer = loadLayer();
    const ft = layer._prepare({
      features: [{
        type: "Feature",
        properties: { name: "San Andreas fault zone", kind: "quaternary-fault", min_zoom: 0 },
        geometry: { type: "LineString", coordinates: [[-122.4, 37.7], [-122.2, 37.9]] },
      }],
    });
    layer._state.features = ft;
    layer._state.grid = layer._buildGrid(ft);
    layer._state.enabled = true;
    layer._state.map = { getZoom: () => 8 };
    const out = layer.sampleAt({ lat: 37.8, lng: -122.3 });
    expect(out).toMatch(/San Andreas/);
  });

  test("sampleAt returns null when the layer is off or the point is far", () => {
    const layer = loadLayer();
    const ft = layer._prepare({
      features: [{
        type: "Feature",
        properties: { name: "Hayward fault zone", kind: "quaternary-fault", min_zoom: 0 },
        geometry: { type: "LineString", coordinates: [[-122.3, 37.7], [-122.2, 37.9]] },
      }],
    });
    layer._state.features = ft;
    layer._state.grid = layer._buildGrid(ft);
    layer._state.map = { getZoom: () => 8 };
    layer._state.enabled = true;
    expect(layer.sampleAt({ lat: 0, lng: 0 })).toBeNull();
    layer._state.enabled = false;
    expect(layer.sampleAt({ lat: 37.8, lng: -122.25 })).toBeNull();
  });
});

// ── THE DATELINE ───────────────────────────────────────────────────────
//
// Owner: *"the tectonic faults need to work across the pacific ocean"*.
//
// Two independent ways to be wrong at a view that crosses the
// antimeridian, both found by driving #49.1961,175.6055,5:
//
//   1. SELECTION. Leaflet reports that view as 121.82 .. 229.39 —
//      continuous longitude, east PAST 180. candidates() took the
//      single-span branch, so it scanned cells floor(121.8/CELL) ..
//      floor(229.4/CELL) and never the NEGATIVE cells holding the
//      faults east of the dateline. MEASURED: 842 selected where a
//      dateline-aware scan finds 2,143 — 1,301 missing (61 %), and not
//      one of the added features had a negative longitude.
//
//   2. RENDERING. Selecting is not enough: Leaflet projects a vertex
//      through a CRS anchored at the map's CENTRE, so a fault at -170
//      with the centre at 175.6 lands 345° WEST — off the left edge.
//
// These EXECUTE the exported helpers rather than grepping for them:
// both are pure functions of numbers, so there is no reason to assert
// about a comment when the code can be run.
describe("fault layer — the dateline", () => {
  function loadLayer() {
    const win = {};
    const fn = new Function("window", faultJs);
    fn(win);
    return win.FaultLayer;
  }

  test("viewSpans puts the whole viewport inside [-180, 180]", () => {
    const { _viewSpans: spans } = loadLayer();
    expect(typeof spans).toBe("function");
    // A plain view is untouched.
    expect(spans(10, 50)).toEqual([[10, 50]]);
    // THE BUG: east past 180 must be split, or the negative cells are
    // never scanned. These two numbers are the owner's own view.
    expect(spans(121.82, 229.39)).toEqual([[121.82, 180], [-180, -130.61]]);
    // The case the old code already handled — Leaflet's other wrapping
    // convention — must keep working.
    expect(spans(170, -170)).toEqual([[170, 180], [-180, -170]]);
    // …and the same, from the other side.
    expect(spans(-200, -160)).toEqual([[-180, -160], [160, 180]]);
    // Every span is inside the indexed range, which is the whole point.
    for (const [w, e] of spans(121.82, 229.39)) {
      expect(w).toBeGreaterThanOrEqual(-180);
      expect(e).toBeLessThanOrEqual(180);
      expect(w).toBeLessThan(e);
    }
  });

  test("wrapLine keeps a dateline-crossing trace in ONE piece", () => {
    const { _wrapLine: wrap } = loadLayer();
    expect(typeof wrap).toBe("function");
    // A trace stored across the antimeridian, viewed from Europe
    // (centre 2.4) — the case where anchoring EVERY vertex to the
    // centre tears the line: -170 is within 180° of 2.4, so it stayed
    // put while its neighbours moved, and Leaflet drew a 351° chord
    // straight across the map.
    const line = [[40, 144], [41, 170], [42, 180], [42, -179], [41, -170], [40, -153]];
    const pts = line.map((p) => p.slice());
    expect(wrap(pts, 2.4)).toBe(true);
    const lngs = pts.map((p) => p[1]);
    // contiguous: no step over 180, and monotonic across the seam
    let maxStep = 0;
    for (let i = 1; i < lngs.length; i++) maxStep = Math.max(maxStep, Math.abs(lngs[i] - lngs[i - 1]));
    expect(maxStep, "the trace is torn across the map").toBeLessThanOrEqual(180);
    expect(lngs).toEqual([144, 170, 180, 181, 190, 207]);
    // The same trace seen from the dateline must land in the view.
    const d = line.map((p) => p.slice());
    wrap(d, 175.6);
    expect(d.map((p) => p[1])).toEqual([144, 170, 180, 181, 190, 207]);
    // A trace stored entirely as negatives (the Pacific east of the
    // dateline) must be brought into the dateline view, not left at -180
    // where the CRS puts it off the left edge.
    const right = [[42, -180], [42, -170], [41, -153]];
    wrap(right, 175.6);
    expect(right.map((p) => p[1])).toEqual([180, 190, 207]);
    // Idempotent: running it twice must not shift the line again.
    const again = right.map((p) => p.slice());
    expect(wrap(again, 175.6)).toBe(false);
    expect(again.map((p) => p[1])).toEqual([180, 190, 207]);
    // LatLng OBJECTS as well as [lat, lng] arrays — Leaflet hands back
    // the former from getLatLngs().
    const objs = [{ lat: 40, lng: -170 }, { lat: 41, lng: -169 }];
    wrap(objs, 175.6);
    expect(objs.map((p) => p.lng)).toEqual([190, 191]);
    // A non-numeric longitude must be skipped, not turned into NaN.
    const junk = [[40, 144], [41, "x"], [42, 170]];
    expect(() => wrap(junk, 2.4)).not.toThrow();
    expect(junk[1][1]).toBe("x");
  });
});
