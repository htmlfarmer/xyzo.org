// population-layer.bun.test.js — WorldPop 1 km density overlay.
//
// Why each of these is pinned rather than assumed: the published FAO
// catalogue URL for this dataset is wrong in two ways, and both errors
// come back fast and readable — the obvious reaction is to trust the
// catalogue and conclude the service is dead. It is not.
//
//   tilematrixset=EPSG:900913  -> HTTP 400; the service's list has no
//                                  such name. WebMercatorQuad is correct.
//   (no style parameter)       -> HTTP 400
//                                  `Missing 'GetTile' parameters: {'style'}`.
//
// Verified live: 200 across z0–z15, and in a browser 35/35 tiles with
// zero failures, the pane at 349 with pointer-events:none, the slider
// reaching the module's opacity, and z4 fetching nothing (minZoom).
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const src = readFileSync(join(ROOT, "population-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const registry = readFileSync(join(ROOT, "generic-layers.js"), "utf8");

// Negative assertions must run against CODE, not prose: this file
// deliberately documents the broken catalogue values and the surfaces it
// does not offer, so matching the raw source fires on the documentation.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const code = stripComments(src);
const appCode = stripComments(appJs);
// The WMTS query moved SERVER-SIDE when this layer was put behind our
// tile mirror: tileMirror.ts builds it from a whitelist, revalidates it
// every 7 days, and hands Leaflet a plain XYZ template. These facts are
// still worth pinning — but in the file that now owns them. Asserting
// them against the layer would pass forever while the real URL silently
// drifted back to the catalogue's broken one.
const mirrorTs = readFileSync(
  join(ROOT, "..", "api", "src", "routes", "tileMirror.ts"),
  "utf8",
);

describe("the WMTS request is the WORKING one, not the catalogue's", () => {
  test("the layer asks our mirror, and the mirror builds the real URL", () => {
    expect(code).toMatch(/\/api\/tile\/mirror\/worldpop\/\{z\}\/\{x\}\/\{y\}/);
    expect(code).not.toMatch(/data\.apps\.fao\.org/);
    expect(mirrorTs).toMatch(/fao-gismgr\/WPOP\/mapsets\/WPOP-GLOBAL2-D/);
  });

  test("uses WebMercatorQuad — the catalogue's EPSG:900913 returns 400", () => {
    expect(mirrorTs).toMatch(/tilematrixset=WebMercatorQuad/);
    // the header note in this file mentions EPSG:900913 only as the
    // catalogue's BROKEN value — match the code, not the note
    expect(mirrorTs).not.toMatch(/EPSG:900913/);
  });

  test("carries style=default — omitting it is the other 400", () => {
    expect(mirrorTs).toMatch(/style=default/);
    // and the fact is recorded in this file so nobody "simplifies" it away
    expect(src).toMatch(/Missing 'GetTile' parameters/);
  });

  test("is a genuine XYZ template Leaflet can substitute", () => {
    // Template-literal form now: the mirror substitutes z/x/y itself.
    expect(mirrorTs).toMatch(/TileMatrix=\$\{z\}&TileCol=\$\{x\}&TileRow=\$\{y\}/);
  });

  test("it is an XYZ grid, so tiles must NOT be marked 512", () => {
    // The Macrostrat trap: tileSize:512 on a standard XYZ grid doubles
    // the spacing and shifts the whole overlay. This service serves
    // ordinary 256 px XYZ tiles.
    expect(src).not.toMatch(/tileSize:\s*512/);
    expect(mirrorTs).toMatch(/tilematrixset=WebMercatorQuad/);
  });
});

describe("the layer exists where a wash should be", () => {
  test("own pane, below the climate wash, click-transparent", () => {
    expect(src).toMatch(/const PANE = "populationPane"/);
    expect(src).toMatch(/const PANE_Z = 349/);
    // 349 sits above relief/wave/ivt/cape and below climate 350
    expect(src).toMatch(/pane\.style\.pointerEvents = "none"/);
  });

  test("renders at EVERY zoom, including the low ones", () => {
    // Originally gated at 6, on the wrong belief that a sub-pixel 1 km
    // cell would smear. The WMTS renders each tile at its own 256 px, so
    // a z2 tile is a correctly downsampled global view — and the gate
    // made the checkbox lie (checked but blank) at z2/z3/z4, which is
    // exactly where people open this layer to see the global pattern.
    // Reported with two live example URLs at z4 and z3.
    expect(src).toMatch(/const MIN_ZOOM = 0/);
    expect(src).toMatch(/minZoom: MIN_ZOOM/);
    // The ceiling side still matters: the service answers z0-z15 and
    // Leaflet upscales past 15 rather than asking for tiles that do not
    // exist.
    expect(src).toMatch(/maxNativeZoom: MAX_NATIVE_ZOOM/);
    expect(src).toMatch(/const MAX_NATIVE_ZOOM = 15/);
    // The probe that justified removing the gate is recorded too.
    expect(src).toMatch(/z1 18\.7 KB|13,824/);
  });

  test("acknowledges the slow third-party tiles", () => {
    // ~1.5–2 s a tile: fetch on pan settle, not every frame.
    expect(src).toMatch(/updateWhenIdle: true/);
    expect(src).toMatch(/keepBuffer: 1/);
  });

  test("exposes the layers-control surface app.js's loop expects", () => {
    expect(src).toMatch(/window\.PopulationLayer = \{/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "isEnabled",
                      "setOpacity", "getOpacity", "blocksClick"]) {
      expect(src, `missing ${fn}`).toMatch(new RegExp(`\\b${fn}\\s*[:,]`));
    }
    expect(src).toMatch(/LAYER_NAME:\s*"🧍 Population density/);
    expect(src).toMatch(/function blocksClick\(\)\s*\{\s*\n?\s*return false/);
  });
});

describe("registration", () => {
  test("generic-layers.js lists it, and loads BEFORE app.js", () => {
    expect(registry).toMatch(/"PopulationLayer"/);
    const at = indexHtml.indexOf("generic-layers.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
  });

  test("app.js reads the registry instead of naming modules inline", () => {
    // Naming it inline (twice) would have blown the 850,000-byte
    // ceiling app.js sat under — removed 2026-11-01. The registry is
    // still the better shape on its own: one entry per layer, and
    // adding one costs an edit to generic-layers.js rather than to
    // app.js.
    expect(appJs).toMatch(/for \(const name of window\.XYZO_GENERIC_LAYERS\)/);
    expect(appJs).not.toMatch(/\["CapeLayer", "IvtLayer"\]/);
    expect((appJs.match(/window\.XYZO_GENERIC_LAYERS/g) || []).length).toBe(2);
    // registration AND init — one without the other is a layer that
    // appears in the dropdown but never gets a map.
    expect(registry).toMatch(/"CapeLayer"/);
    expect(registry).toMatch(/"IvtLayer"/);
  });

  // There was an `app.js < 850_000` test here, and its comment is why
  // this overlay lives in generic-layers.js rather than being named
  // inline in app.js: "two bytes for the registry swap instead of
  // thirty-six for an inline list". The size assertion was removed
  // 2026-11-01 with every other size ceiling — see the note in
  // code-splitting.bun.test.js. The registry tests above still pin the
  // design decision itself; only the byte count that motivated it is
  // gone.

  test("both files are stamped by bump_frontend.sh", () => {
    expect(bump).toMatch(/population-layer\.js/);
    expect(bump).toMatch(/generic-layers\.js/);
    expect(indexHtml.match(/<script src="population-layer\.js/g).length).toBe(1);
    expect(indexHtml.match(/<script src="generic-layers\.js/g).length).toBe(1);
  });
});

describe("attribution is on the map, not just in a file", () => {
  test("the Leaflet options carry a printable attribution naming WorldPop", () => {
    expect(src).toMatch(/attribution:/);
    expect(src).toMatch(/WorldPop/);
    expect(src).toMatch(/CC BY 4\.0/);
    // The origin, not merely the tile server that renders it.
    expect(src).toMatch(/worldpop\.org/);
  });

  test("the layer is absent from the size-gated app.js slug tables on purpose", () => {
    // getLayerSlug() derives "population-density" from LAYER_NAME and
    // resolveLayerName() falls back to comparing derived slugs, so no
    // hand-written entry is needed — and none was affordable at 8 bytes
    // of headroom.
    expect(appCode).not.toMatch(/"population":/);
    expect(appJs).toMatch(/function getLayerSlug\(/);
  });
});

describe("it does not pretend to hold values it cannot read", () => {
  test("no sampleAt and no export registration", () => {
    // FAO serves pre-coloured PNGs: we hold a picture, not numbers, so
    // the Hover HUD and the export engine must not claim a surface this
    // layer cannot honour.
    expect(code).not.toMatch(/sampleAt/);
    expect(code).not.toMatch(/XYZO_EXPORT\.register/);
    expect(existsSync(join(ROOT, "data", "population"))).toBe(false);
  });
});
