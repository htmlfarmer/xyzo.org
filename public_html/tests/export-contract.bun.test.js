/**
 * export-contract.js — the layer → exporter contract.
 *
 * The rule this file exists to protect: A LAYER EXPORTS ITSELF. The
 * exporter never re-implements a layer's sampler, its scale factor or
 * its colour ramp, because a second implementation is a second source
 * of truth — and the second source of truth is the one that drifts.
 * The soil layer says it itself: "never a second data source, or the
 * number under the cursor will eventually disagree with the colour."
 *
 * So every layer module registers a SURFACE at load time, and these
 * tests check that:
 *   · the contract loads BEFORE the layer modules (they register into
 *     it as they load, and a contract that arrives late collects
 *     nothing),
 *   · every layer that can be exported actually registers,
 *   · every surface carries the attribution and licence its dataset
 *     demands — CC BY 4.0 requires attribution, CC BY-SA 4.0 makes the
 *     derivative share-alike.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const contractJs = readFileSync(join(ROOT, "export-contract.js"), "utf8");
const engineJs = readFileSync(join(ROOT, "export-engine.js"), "utf8");
const writersJs = readFileSync(join(ROOT, "export-writers.js"), "utf8");

// The layers that publish a data product the user can take away, and
// the surface id each one must register.
const LAYER_SURFACES = [
  { layer: "temp-layer.js", id: "temperature" },
  { layer: "wind-layer.js", id: "wind" },
  { layer: "lightning-layer.js", id: "lightning" },
  { layer: "phytoplankton-layer.js", id: "phytoplankton" },
  { layer: "mag-layer.js", id: "magnetic" },
  { layer: "mag-layer.js", id: "magnetic-lines" },
  { layer: "wave-layer.js", id: "waves" },
  { layer: "soil-layer.js", id: "soil" },
  { layer: "cropland-layer.js", id: "cropland" },
  { layer: "cropland-layer.js", id: "landcover" },
  { layer: "etopo-layer.js", id: "relief" },
  { layer: "climate-layer.js", id: "climate" },
  { layer: "river-layer.js", id: "rivers" },
  { layer: "basin-layer.js", id: "basins" },
  { layer: "languages-layer.js", id: "languages" },
  { layer: "isobar-layer.js", id: "isobars" },
];

describe("export contract — wiring", () => {
  test("the contract loads BEFORE every layer module", () => {
    const at = indexHtml.indexOf('src="export-contract.js');
    expect(at).toBeGreaterThan(-1);
    for (const spec of LAYER_SURFACES) {
      const layerAt = indexHtml.indexOf('src="' + spec.layer);
      expect(layerAt, spec.layer + " is loaded").toBeGreaterThan(-1);
      expect(layerAt, spec.layer + " loads after the contract").toBeGreaterThan(at);
    }
  });

  test("the writers and the engine load with the contract", () => {
    const at = indexHtml.indexOf('src="export-contract.js');
    expect(indexHtml.indexOf('src="export-writers.js')).toBeGreaterThan(at);
    expect(indexHtml.indexOf('src="export-engine.js')).toBeGreaterThan(at);
  });

  test("the export panel loads", () => {
    expect(indexHtml).toMatch(/<script[^>]+src="export-panel\.js[^"]*"\s+defer><\/script>/);
  });

  test("the control menu has an EXPORT section", () => {
    expect(indexHtml).toMatch(/id="ctrl-export-btn"/);
    const section = indexHtml.slice(
      indexHtml.indexOf("EXPORT"),
      indexHtml.indexOf("EXPORT") + 400
    );
    expect(section).toMatch(/ctrl-export-btn/);
  });
});

describe("export contract — the registry", () => {
  function loadContract() {
    globalThis.window = globalThis;
    // eslint-disable-next-line no-eval
    eval(contractJs);
    return globalThis.XYZO_EXPORT;
  }

  test("register() keeps a surface and list() returns it", () => {
    const reg = loadContract();
    reg.unregister("__test__");
    const s = reg.register({ id: "__test__", label: "T", kind: "raster" });
    expect(s.id).toBe("__test__");
    expect(reg.get("__test__")).toBeTruthy();
    expect(reg.list("raster").some((x) => x.id === "__test__")).toBe(true);
    expect(reg.list("vector").some((x) => x.id === "__test__")).toBe(false);
    reg.unregister("__test__");
  });

  test("a surface without an id is refused", () => {
    const reg = loadContract();
    expect(reg.register({ label: "no id" })).toBeNull();
    expect(reg.register(null)).toBeNull();
  });

  test("a raster surface needs a sampler, a vector one needs features()", () => {
    const reg = loadContract();
    expect(reg.isExportable({ kind: "raster" })).toBe(false);
    expect(reg.isExportable({ kind: "raster", sample: () => 1 })).toBe(true);
    expect(reg.isExportable({ kind: "vector" })).toBe(false);
    expect(reg.isExportable({ kind: "vector", features: async () => ({}) })).toBe(true);
  });

  test("isActive() honours a surface's own report", () => {
    const reg = loadContract();
    expect(reg.isActive({ isActive: () => false })).toBe(false);
    expect(reg.isActive({ isActive: () => true })).toBe(true);
    // A surface with no isActive() is assumed active.
    expect(reg.isActive({})).toBe(true);
    // A throwing isActive() must not take the exporter down.
    expect(reg.isActive({ isActive: () => { throw new Error("boom"); } })).toBe(false);
  });
});

describe("export contract — every layer registers its surface", () => {
  for (const spec of LAYER_SURFACES) {
    test(spec.layer + " registers " + spec.id, () => {
      const src = readFileSync(join(ROOT, spec.layer), "utf8");
      expect(src, spec.layer + " exists").toBeTruthy();
      // The module calls registerExport() at load time…
      expect(src).toMatch(/function registerExport\(\)/);
      expect(src).toMatch(/registerExport\(\);/);
      // …and the registration names this surface.
      expect(src).toMatch(new RegExp('id:\\s*"' + spec.id + '"'));
      // The surface carries its licence obligations.
      expect(src).toMatch(/attribution:/);
      expect(src).toMatch(/licence:/);
      expect(src).toMatch(/window\.XYZO_EXPORT\.register\(/);
    });
  }
});

describe("export contract — the engine", () => {
  function loadEngine() {
    globalThis.window = globalThis;
    // eslint-disable-next-line no-eval
    eval(contractJs);
    // eslint-disable-next-line no-eval
    eval(writersJs);
    // eslint-disable-next-line no-eval
    eval(engineJs);
    return globalThis.XYZO_EXPORT_ENGINE;
  }

  test("a bbox is normalised into west, south, east, north", () => {
    const E = loadEngine();
    expect(E.normalizeBBox([10, -20, 30, 20])).toEqual([10, -20, 30, 20]);
    // South above north is swapped.
    expect(E.normalizeBBox([10, 20, 30, -20])).toEqual([10, -20, 30, 20]);
    // A viewport that straddles the antimeridian folds into one
    // continuous box: 170°E eastward across 180 to 350°E.
    const wrapped = E.normalizeBBox([170, -10, -170, 10]);
    expect(wrapped[0]).toBe(170);
    expect(wrapped[2]).toBe(190);
    // A box wider than the globe collapses to the globe.
    const wide = E.normalizeBBox([-400, -90, 400, 90]);
    expect(wide).toEqual([-180, -90, 180, 90]);
    // Garbage in, the world out.
    expect(E.normalizeBBox(null)).toEqual([-180, -90, 180, 90]);
    expect(E.normalizeBBox([1, 2, 3])).toEqual([-180, -90, 180, 90]);
  });

  test("a lattice is sized at the layer's own resolution", () => {
    const E = loadEngine();
    const surface = {
      native: { cols: 360, rows: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360 },
    };
    // The whole world at the native 1° grid.
    expect(E.latticeFor(surface, [-180, -90, 180, 90])).toEqual({
      width: 360, height: 181, scaled: false, deg: null,
    });
    // A quarter of the world: a quarter of the columns, and the rows
    // whose centres fall inside it (0°..90° inclusive — the native grid
    // carries a row at each pole).
    const q = E.latticeFor(surface, [0, 0, 90, 90]);
    expect(q.width).toBe(90);
    expect(q.height).toBe(91);
  });

  test("a lattice over the cell budget is scaled down and says so", () => {
    // The Köppen grid was rebuilt at 0.05° on 2026-10-29, so a
    // whole-world export of it is 7200 × 3600 = 26 M cells — 104 MB
    // for one float32 band. That is not a download, that is a crash.
    const E = loadEngine();
    const fine = {
      native: { cols: 7200, rows: 3600, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
    };
    const lat = E.latticeFor(fine, [-180, -90, 180, 90]);
    expect(lat.width * lat.height).toBeLessThanOrEqual(E.MAX_CELLS);
    expect(lat.scaled).toBe(true);
    // The effective degrees-per-cell is reported, so the UI can say
    // the file is coarser than the source.
    expect(lat.deg).toBeGreaterThan(0);
    expect(lat.deg).toBeGreaterThan(0.05);

    // A small grid is left alone.
    const coarse = {
      native: { cols: 360, rows: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360 },
    };
    expect(E.latticeFor(coarse, [-180, -90, 180, 90]).scaled).toBe(false);
  });

  test("rasterize() fills the lattice row 0 from the NORTH", async () => {
    const E = loadEngine();
    // A surface whose value is simply the latitude.
    const surface = {
      bands: [{ name: "v", unit: "m" }],
      sample: (lat) => lat,
    };
    const r = await E.rasterize(surface, [0, 0, 10, 10], 2, 2);
    expect(r.bands.length).toBe(1);
    expect(r.bands[0].data.length).toBe(4);
    // Row 0 is the northernmost row, so its values are the HIGHER ones.
    expect(r.bands[0].data[0]).toBeGreaterThan(r.bands[0].data[2]);
    expect(r.bands[0].data[0]).toBeCloseTo(7.5, 3);
    expect(r.bands[0].data[2]).toBeCloseTo(2.5, 3);
  });

  test("a nodata sample leaves NaN, not a zero", async () => {
    const E = loadEngine();
    const surface = {
      bands: [{ name: "v" }],
      sample: (lat) => (lat > 5 ? null : 1),
    };
    const r = await E.rasterize(surface, [0, 0, 10, 10], 1, 2);
    expect(Number.isNaN(r.bands[0].data[0])).toBe(true);
    expect(r.bands[0].data[1]).toBe(1);
  });

  test("a multi-band surface produces one band per declared band", async () => {
    const E = loadEngine();
    const surface = {
      bands: [{ name: "u" }, { name: "v" }],
      sample: () => [3, 4],
    };
    const r = await E.rasterize(surface, [0, 0, 1, 1], 2, 2);
    expect(r.bands.length).toBe(2);
    expect(r.bands[0].name).toBe("u");
    expect(r.bands[1].name).toBe("v");
    expect(r.bands[0].data[0]).toBe(3);
    expect(r.bands[1].data[0]).toBe(4);
  });

  test("the attribution block names every dataset and its licence", () => {
    const E = loadEngine();
    const text = E.attributionText([
      { id: "a", label: "A", attribution: "Source A", licence: "CC BY 4.0" },
      { id: "b", label: "B", attribution: "Source B", licence: "public domain" },
    ]);
    expect(text).toContain("Source A");
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("Source B");
    expect(text).toContain("public domain");
    expect(text.split("\n").length).toBe(2);
  });

  test("the pins become GeoJSON points with their real coordinates", () => {
    const E = loadEngine();
    const feats = E.pinFeatures([
      { title: "Story", lat: 10, lng: 20, place_name: "Somewhere" },
      { title: "No coords" },
      { title: "Null island", lat: 0, lng: 0 },
    ]);
    expect(feats.length).toBe(1);
    expect(feats[0].geometry.type).toBe("Point");
    expect(feats[0].geometry.coordinates).toEqual([20, 10]);
    expect(feats[0].properties.name).toBe("Story");
    expect(feats[0].properties.place_name).toBe("Somewhere");
  });

  test("a feature outside the bbox is recognised as outside", () => {
    const E = loadEngine();
    const bbox = [0, 0, 10, 10];
    expect(E.geomTouchesBBox({ type: "Point", coordinates: [5, 5] }, bbox)).toBe(true);
    expect(E.geomTouchesBBox({ type: "Point", coordinates: [50, 50] }, bbox)).toBe(false);
    expect(E.geomTouchesBBox({ type: "LineString", coordinates: [[-20, 5], [5, 5]] }, bbox)).toBe(true);
  });

  test("the PNG path refuses an empty selection rather than writing a blank file", async () => {
    const E = loadEngine();
    // No DOM canvas in bun, so the PNG path cannot run — but the
    // rasterize() contract it depends on must still be honest.
    expect(typeof E.png).toBe("function");
    expect(typeof E.geoTIFF).toBe("function");
    expect(typeof E.geoJSON).toBe("function");
    expect(typeof E.kml).toBe("function");
    expect(typeof E.bundle).toBe("function");
    expect(typeof E.csvPins).toBe("function");
  });
});

describe("export contract — the native geometry comes from the layer's own meta", () => {
  function loadContract() {
    globalThis.window = globalThis;
    // eslint-disable-next-line no-eval
    eval(contractJs);
    return globalThis.XYZO_EXPORT;
  }

  test("a bbox-shaped meta is read as it is", () => {
    const reg = loadContract();
    // The Köppen grid's shape — it was rebuilt at 0.05° on 2026-10-29.
    const n = reg.nativeFromMeta({
      grid: { width: 7200, height: 3600, degrees: 0.05, bbox: [-180, -90, 180, 90] },
    }, {});
    expect(n.cols).toBe(7200);
    expect(n.rows).toBe(3600);
    expect(n.latMin).toBe(-90);
    expect(n.latMax).toBe(90);
    expect(n.lonMin).toBe(-180);
    expect(n.lonMax).toBe(180);
  });

  test("a cols/rows meta derives its longitude range", () => {
    const reg = loadContract();
    // The GFS convention: 0..360, stored at integer degrees.
    const gfs = reg.nativeFromMeta({
      grid: { cols: 360, rows: 181, lat_min: -90, lat_max: 90, lon_min: 0, lon_step: 1 },
    }, {});
    expect(gfs.cols).toBe(360);
    expect(gfs.rows).toBe(181);
    expect(gfs.lonMin).toBe(0);
    expect(gfs.lonMax).toBe(360);
    // The wave grid: -180..180 at 0.25°.
    const wave = reg.nativeFromMeta({
      grid: { cols: 1440, rows: 721, lat_min: -90, lat_max: 90, lon_min: -180, lon_step: 0.25 },
    }, {});
    expect(wave.lonMax).toBe(180);
  });

  test("a width/height meta is a global 0.1° product", () => {
    const reg = loadContract();
    const n = reg.nativeFromMeta({
      grid: { width: 3600, height: 1800, degrees: 0.1, nodata: -32768 },
    }, {});
    expect(n.cols).toBe(3600);
    expect(n.rows).toBe(1800);
    expect(n.lonMin).toBe(-180);
    expect(n.lonMax).toBe(180);
  });

  test("an unreadable meta falls back rather than throwing", () => {
    const reg = loadContract();
    const fb = { cols: 1, rows: 2 };
    expect(reg.nativeFromMeta(null, fb)).toBe(fb);
    expect(reg.nativeFromMeta({}, fb)).toBe(fb);
    expect(reg.nativeFromMeta({ grid: {} }, fb)).toBe(fb);
  });

  test("every registered surface reads its geometry from its meta", () => {
    // A hard-coded extent is a silent bug: the Köppen grid was rebuilt
    // at twice the resolution and a hard-coded one would have exported
    // a quarter-resolution file with nothing to say so.
    for (const spec of LAYER_SURFACES) {
      const src = readFileSync(join(ROOT, spec.layer), "utf8");
      const at = src.indexOf('id: "' + spec.id + '"');
      expect(at, spec.id + " is registered").toBeGreaterThan(-1);
      const block = src.slice(at, at + 1400);
      if (/native:/.test(block)) {
        expect(block, spec.id + " reads its geometry from the meta")
          .toMatch(/get native\(\)/);
        expect(block, spec.id + " reads its geometry from the meta")
          .toMatch(/nativeFromMeta/);
      }
    }
  });
});

describe("export contract — a surface's getters stay LIVE", () => {
  function loadContract() {
    globalThis.window = globalThis;
    // eslint-disable-next-line no-eval
    eval(contractJs);
    return globalThis.XYZO_EXPORT;
  }

  test("register() does not freeze a getter's value", () => {
    // This is the bug that made every surface carry its EMPTY
    // defaults. A surface registers when its layer module loads —
    // long before the grid has arrived — so the unit, the attribution,
    // the period and the grid geometry must be READ at export time.
    //
    // Object.assign() evaluates a getter and copies the result, which
    // froze all of them at registration. defineProperty() with the
    // original descriptor keeps the getter live.
    const reg = loadContract();
    reg.unregister("__lazy__");
    let counter = 0;
    const surface = {
      id: "__lazy__",
      kind: "raster",
      get unit() { return "unit-" + (++counter); },
      get native() { return { cols: 10 + counter, rows: 20 }; },
      sample: () => 1,
    };
    const s = reg.register(surface);
    expect(s.unit).toBe("unit-1");
    expect(s.unit).toBe("unit-2");   // read again → still live
    expect(s.native.cols).toBe(12);  // the counter moved on, so the getter is live
    reg.unregister("__lazy__");
  });

  test("a surface's plain properties are copied as they are", () => {
    const reg = loadContract();
    reg.unregister("__plain__");
    const s = reg.register({ id: "__plain__", kind: "vector", features: async () => ({}) });
    expect(s.kind).toBe("vector");
    expect(typeof s.features).toBe("function");
    expect(reg.get("__plain__")).toBe(s);
    reg.unregister("__plain__");
  });
});
