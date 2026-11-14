// overlay-contracts.bun.test.js — the contracts every map overlay must
// honour so one bad module cannot brick the boot path again.
//
// History (why each rule exists):
// - 2026-10-28: RiverLayer returned a raw L.geoJSON with no setOpacity.
//   OverlayOpacity.mount() called it for every WEATHER_OVERLAYS entry,
//   the throw aborted app.js before `const pinMarkers` initialised, and
//   the whole map died with a TDZ ReferenceError. Every overlay now
//   either IS a TileLayer or attaches the method itself; the opacity
//   module also guards every call.
// - 2026-10-28: missing soil/cropland tiles answered 404 with the
//   *.png immutable header, so browsers cached the 404 for a year and
//   a rebuilt pyramid stayed invisible.
// - 2026-10-28: cropland tiles painted non-cropland classes as opaque
//   black (bytes([0]) tRNS) and left a 1px nodata stripe at every 3°
//   source-tile boundary (floored warp windows).

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const opacityJs = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");

const OVERLAYS = [
  { file: "climate-layer.js",  global: "ClimateLayer",  pane: "climatePane",  z: 350 },
  { file: "soil-layer.js",     global: "SoilLayer",     pane: "soilPane",     z: 352 },
  { file: "cropland-layer.js", global: "CroplandLayer", pane: "croplandPane", z: 353 },
  { file: "geology-layer.js",  global: "GeologyLayer",  pane: "geologyPane",  z: 354 },
  { file: "temp-layer.js",     global: "TempLayer",     pane: "tempPane",     z: 355 },
  { file: "lightning-layer.js", global: "LightningLayer", pane: "lightningPane", z: 356 },
  { file: "languages-layer.js", global: "LanguagesLayer", pane: "langPane", z: 364 },
  { file: "mag-layer.js",      global: "MagLayer",      pane: "magPane",      z: 358 },
  { file: "transport-layer.js", global: "TransportLayer", pane: "transportPane", z: 359 },
  { file: "salinity-layer.js",  global: "SalinityLayer",  pane: "salinityPane",  z: 351 },
  { file: "ocean-layer.js",     global: "OceanLayer",     pane: "oceanPane",     z: 361 },
  { file: "isobar-layer.js",   global: "IsobarLayer",   pane: "isobarPane",   z: 360 },
  { file: "basin-layer.js",    global: "BasinLayer",    pane: "basinPane",    z: 362 },
  { file: "river-layer.js",    global: "RiverLayer",    pane: "riverPane",    z: 365 },
  { file: "fao-rivers-layer.js", global: "FaoRiversLayer", pane: "faoRiverPane", z: 371 },
  { file: "wind-layer.js",     global: "WindLayer",     pane: "windPane",     z: 379 },
  // hwsd-layer.js is deliberately ABSENT: like population-layer.js and
  // wind-speed-layer.js it is wired through generic-layers.js's registry
  // loop, and the boot contract below demands LITERAL `window.X.init(map)`
  // / `typeof window.X.getTileLayer` wiring in app.js — a registry layer
  // can never satisfy that regex, so table membership would fail for a
  // reason unrelated to the layer's own correctness (the exact trap
  // generic-layers.js's header was written to avoid). Its contracts —
  // pane z 370, load order, stamping, attribution, the WMTS URL traps,
  // the overlayadd listeners — are pinned in hwsd-layer.bun.test.js.
  // The SOURCE-SCANNING pane test below still finds hwsdPane on its own.
  { file: "city-labels.js",    global: "CityLabels",    pane: "cityLabelPane", z: 380 },
  { file: "etopo-layer.js",    global: "EtopoLayer",    pane: "etopoPane",    z: 345 },
  { file: "wave-layer.js",     global: "WaveLayer",     pane: "wavePane",     z: 346 },
  { file: "ivt-layer.js",      global: "IvtLayer",      pane: "ivtPane",      z: 347 },
  { file: "cape-layer.js",     global: "CapeLayer",     pane: "capePane",     z: 348 },
  { file: "phytoplankton-layer.js", global: "PhytoplanktonLayer", pane: "phytoplanktonPane", z: 357 },
];

function load(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

// ── the opacity contract ────────────────────────────────────────────────

describe("overlay opacity contract", () => {
  test("overlay-opacity.js guards EVERY setOpacity call", () => {
    // A missing method must degrade, not throw — the throw killed boot.
    const calls = opacityJs.match(/\.setOpacity\(/g) || [];
    const guards = opacityJs.match(/typeof layer\.setOpacity === "function"/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    // One guard per call site that touches a layer's setOpacity.
    expect(guards.length).toBeGreaterThanOrEqual(calls.length);
  });

  test("mount() cannot abort on a layer without setOpacity", () => {
    // The exact line that crashed boot on 2026-10-28.
    expect(opacityJs).toMatch(/if \(typeof layer\.setOpacity === "function"\) \{\s*\n\s*layer\.setOpacity\(pct \/ 100\)/);
  });

  test("restore() cannot abort either", () => {
    expect(opacityJs).toMatch(/stored\[key\] != null && layer && typeof layer\.setOpacity === "function"/);
  });

  test("every tile-backed overlay module exposes setOpacity in its public API", () => {
    // The factory itself must supply it: cape/ivt declare no setOpacity
    // of their own, they inherit it from createFieldLayer's api object.
    // Without this check a factory layer could silently drop the
    // method and the opacity slider would throw on it.
    expect(load("field-layer.js")).toMatch(/setOpacity\(value\)/);
    expect(load("field-layer.js")).toMatch(/const api = \{/);

    for (const { file, global } of OVERLAYS) {
      const js = load(file);
      expect(js, `${global} missing`).toMatch(new RegExp(`window\\.${global}\\s*=`));
      // Four ways a layer can satisfy the contract:
      //   1. it declares setOpacity itself
      //   2. it builds via createFieldLayer(), which supplies one
      //   3. its getTileLayer attaches it to the instance (GeoJSON path)
      //   4. it returns a plain L.tileLayer, which Leaflet gives one
      // (The Köppen and Cropland layers are case 4: verified working in
      // the browser, the slider moves them.)
      const viaFactory = /window\.\w+\s*=\s*window\.createFieldLayer\(/.test(js);
      const inApi = /setOpacity/.test(js) || /L\.tileLayer/.test(js) || viaFactory;
      expect(inApi, `${file} must expose setOpacity or return an L.tileLayer`).toBe(true);
    }
  });

  test("RiverLayer attaches setOpacity to the GeoJSON instance", () => {
    // L.geoJSON has no setOpacity; the instance must get one.
    const js = load("river-layer.js");
    expect(js).toMatch(/state\.layer\.setOpacity\s*=/);
    expect(js).toMatch(/state\.layer\.getOpacity\s*=/);
  });

  test("WindLayer.setOpacity feeds the canvas stroke alpha", () => {
    // Wind draws on a full-map canvas — the slider must reach the
    // painter, not just options.opacity.
    const js = load("wind-layer.js");
    expect(js).toMatch(/setOpacity\(value\)/);
    expect(js).toMatch(/state\.opacity\s*=\s*v/);
    expect(js).toMatch(/state\.opacity \* repFade/);
  });
});

// ── the boot contract ───────────────────────────────────────────────────

describe("overlay boot contract", () => {
  test("every overlay module loads BEFORE app.js and is stamped", () => {
    for (const { file } of OVERLAYS) {
      const at = indexHtml.indexOf(file);
      const appAt = indexHtml.indexOf("app.js?");
      expect(at, `${file} missing from index.html`).toBeGreaterThan(-1);
      expect(at, `${file} must load before app.js`).toBeLessThan(appAt);
      expect(bump, `bump_frontend must stamp ${file}`).toMatch(
        new RegExp(file.replace(".", "\\."))
      );
    }
  });

  test("every overlay is initialized after the map is created", () => {
    for (const { global } of OVERLAYS) {
      expect(appJs, `${global}.init missing`).toMatch(
        new RegExp(`window\\.${global}\\.init\\(map\\)`)
      );
    }
  });

  test("every overlay that registers in WEATHER_OVERLAYS does so defensively", () => {
    // The `typeof … === "function"` guard means a failed module load
    // must not break the layers control. Driven by the OVERLAYS list so
    // a new layer cannot be added without its guard.
    //
    // IsobarLayer is deliberately excluded: the isobar checkbox is a
    // SEPARATE row injected into the dropdown (mountIsobarRow), not a
    // WEATHER_OVERLAYS entry, so it has no getTileLayer registration.
    for (const { global, file } of OVERLAYS) {
      if (file === "isobar-layer.js") continue;
      expect(appJs, `${global} registration must be guarded`).toMatch(
        new RegExp(`window\\.${global} && typeof window\\.${global}\\.getTileLayer`)
      );
    }
  });

  test("probe modes block click-to-submit for every probe-capable layer", () => {
    expect(appJs).toMatch(/window\.SoilLayer\.blocksClick\(\)/);
    expect(appJs).toMatch(/window\.CroplandLayer\.blocksClick\(\)/);
    // Climate and temperature already had the guard.
    expect(appJs).toMatch(/window\.ClimateLayer\.blocksClick\(\)/);
    expect(appJs).toMatch(/window\.TempLayer\.blocksClick\(\)/);
    // Mag, basins, geology, relief and waves also own a probe while armed.
    expect(appJs).toMatch(/window\.MagLayer\.blocksClick\(\)/);
    expect(appJs).toMatch(/window\.BasinLayer\.blocksClick\(\)/);
    expect(appJs).toMatch(/window\.GeologyLayer\.blocksClick\(\)/);
    expect(appJs).toMatch(/window\.EtopoLayer\.blocksClick\(\)/);
    expect(appJs).toMatch(/window\.WaveLayer\.blocksClick\(\)/);
  });

  test("every probe-capable module implements blocksClick; rivers never do", () => {
    for (const f of ["soil-layer.js", "cropland-layer.js", "mag-layer.js",
                     "basin-layer.js", "geology-layer.js", "etopo-layer.js",
                     "wave-layer.js"]) {
      expect(load(f), `${f} missing blocksClick`).toMatch(/function blocksClick\(\)/);
    }
    // Rivers must NOT — they never swallow a map click.
    expect(load("river-layer.js")).toMatch(/return false/);
  });

  test("GeologyLayer provides setOpacity on the object returned to WEATHER_OVERLAYS", () => {
    // The tile layer itself is an L.TileLayer (has setOpacity natively),
    // but the MODULE also exposes it so OverlayOpacity.restore() on the
    // registration object works the same as every other overlay.
    const js = load("geology-layer.js");
    expect(js).toMatch(/setOpacity:\s*\(v\)/);
    expect(js).toMatch(/getOpacity:\s*\(\)/);
  });

  test("hotlinked geology layers carry no BUILD token and no local data dir", () => {
    // Macrostrat is the tile server; baking it is impossible. Pin the
    // decision so nobody reflexively adds a BUILD constant or starts
    // writing tiles under public_html/data/geology/.
    const js = load("geology-layer.js");
    expect(js).not.toMatch(/const BUILD/);
    expect(js).not.toMatch(/public_html\/data\/geology/);
  });

  test("geology must NOT set tileSize: 512 (Macrostrat uses standard XYZ)", () => {
    // Macrostrat's 512 px PNGs use the standard z/x/y grid — same
    // geographic bounds as normal 256 px tiles. Leaflet's CRS scale is
    // 256 * 2^z; tileSize: 512 tells Leaflet each tile step is 512
    // CRS-pixels, which places every tile at 2x spacing covering 2x
    // area — the whole overlay comes out stretched and shifted. The
    // browser downscales the 512 px image into the default 256 px slot.
    // Match only live code (property assignments), not the comment.
    const js = load("geology-layer.js");
    expect(js).not.toMatch(/^\s*tileSize:/m);
    // A comment must explain why, so nobody "fixes" it back.
    expect(js).toMatch(/Do NOT set tileSize/);
  });
});

// ── pane stacking ───────────────────────────────────────────────────────
//
// Wrong z-index puts a wash over the pins or under the basemap.
// Order: base 200 < climate 350 < soil 352 < cropland 353 < geology 354
//        < temp 355 < lightning 356 < lang 357 < mag 358
//        < transport 359 < isobar 360 < basin 362 < river 365
//        < wind 370 < city labels 380 < pins 400.

describe("overlay pane stacking", () => {
  test("panes keep their documented z-indexes", () => {
    expect(load("etopo-layer.js")).toMatch(/PANE_Z = 345/);
    expect(load("wave-layer.js")).toMatch(/PANE_Z = 346/);
    expect(load("climate-layer.js")).toMatch(/zIndex.*350|"350"/);
    expect(load("soil-layer.js")).toMatch(/PANE_Z = 352/);
    expect(load("cropland-layer.js")).toMatch(/PANE_Z = 353/);
    expect(load("geology-layer.js")).toMatch(/PANE_Z = 354/);
    expect(load("temp-layer.js")).toMatch(/zIndex.*355/);
    expect(load("lightning-layer.js")).toMatch(/"356"/);
    expect(load("languages-layer.js")).toMatch(/PANE_Z = 364/);
    expect(load("mag-layer.js")).toMatch(/PANE_Z = 358/);
    expect(load("transport-layer.js")).toMatch(/PANE_Z = 359/);
    expect(load("salinity-layer.js")).toMatch(/PANE_Z = 351/);
    expect(load("ocean-layer.js")).toMatch(/PANE_Z = 361/);
    expect(load("isobar-layer.js")).toMatch(/zIndex.*360/);
    expect(load("basin-layer.js")).toMatch(/PANE_Z = 362/);
    expect(load("river-layer.js")).toMatch(/PANE_Z = 365/);
    expect(load("wind-layer.js")).toMatch(/zIndex.*379/);
    // These three were MISSING from this list, which is why their
    // collisions shipped: a uniqueness check over an incomplete list
    // cannot fail. See the source-scanning test below.
    expect(load("ivt-layer.js")).toMatch(/paneZ: *347/);
    expect(load("cape-layer.js")).toMatch(/paneZ: *348/);
    expect(load("phytoplankton-layer.js")).toMatch(/zIndex.*"357"/);
  });

  test("every OVERLAYS entry declares exactly the z-index the table claims", () => {
    // The table is hand-maintained, so bind it to the source: a layer
    // whose pane z drifts out of sync with the table must fail here
    // rather than quietly stacking in the wrong place on the map.
    const Z_RE = /(?:PANE_Z\s*=\s*|paneZ:\s*)(\d{2,3})|(?:\bpane\.style\.zIndex\s*=\s*["']|getPane\(["']\w+["']\)\.style\.zIndex\s*=\s*["'])(\d{2,3})/;
    for (const { file, z } of OVERLAYS) {
      const m = load(file).match(Z_RE);
      expect(m, `${file} declares no pane z-index`).toBeTruthy();
      expect(Number(m[1] || m[2]), `${file} pane z disagrees with OVERLAYS`).toBe(z);
    }
  });

  test("no two overlay panes share a z-index — SCANNED from the source", () => {
    // The version before 2026-10-29 iterated OVERLAYS only, and both
    // collisions that shipped (cape 346 on wave's 346; lang 357 on
    // phytoplankton's 357) belonged to layers nobody had added to the
    // table. A duplicate check over an incomplete list can never fire,
    // so this reads EVERY .js in the directory and finds each pane and
    // its z itself: a new layer is caught whether or not anyone
    // remembers to register it above.
    const LEAFLET_BUILTIN = new Set([
      "mapPane", "tilePane", "overlayPane", "shadowPane", "markerPane",
      "tooltipPane", "popupPane", "controlPane",
    ]);
    // pane NAME: createPane("X") / const PANE = "X" / pane: "X"
    const NAME_RE = /createPane\(["'](\w+Pane)["']\)|const\s+(?:\w*_)?PANE\s*=\s*["'](\w+Pane)["']|\bpane:\s*["'](\w+Pane)["']/g;
    // pane z: PANE_Z = N / paneZ: N / pane.style.zIndex = "N" /
    //          getPane("X").style.zIndex = "N" (the qualified forms keep
    //          app.js's unrelated marker zIndexes out of the count)
    const Z_RE = /(?:PANE_Z\s*=\s*|paneZ:\s*)(\d{2,3})|(?:\bpane\.style\.zIndex\s*=\s*["']|getPane\(["']\w+["']\)\.style\.zIndex\s*=\s*["'])(\d{2,3})/g;

    const declared = [];
    for (const name of readdirSync(ROOT)) {
      if (!name.endsWith(".js")) continue;
      // field-layer.js is a FACTORY: its paneZ is a default overridden
      // by each caller, so counting it would be counting a phantom pane.
      if (name === "field-layer.js") continue;
      const js = readFileSync(join(ROOT, name), "utf8");
      const panes = [...new Set(
        [...js.matchAll(NAME_RE)].map((m) => m[1] || m[2] || m[3]).filter(Boolean)
      )].filter((p) => !LEAFLET_BUILTIN.has(p));
      if (!panes.length) continue;
      const zs = [...new Set([...js.matchAll(Z_RE)].map((m) => Number(m[1] || m[2])))];
      // A file that makes a pane but sets no z is relying on Leaflet's
      // default (400 = the pin canvas), so say so loudly.
      expect(zs.length, `${name} declares a pane but no z-index`).toBe(1);
      declared.push({ file: name, panes, z: zs[0] });
    }

    expect(declared.length).toBeGreaterThan(15);

    const byPane = new Map();
    for (const { file, panes, z } of declared) {
      for (const p of panes) {
        const prior = byPane.get(p);
        if (prior) {
          // The same pane declared in two files (app.js + the module)
          // must agree, or whichever runs last wins.
          expect(z, `${p} set to ${prior.z} in ${prior.file} and ${z} in ${file}`).toBe(prior.z);
        } else {
          byPane.set(p, { z, file });
        }
      }
    }

    const byZ = new Map();
    for (const [p, v] of byPane) {
      if (!byZ.has(v.z)) byZ.set(v.z, []);
      byZ.get(v.z).push(`${p} (${v.file})`);
    }
    for (const [z, list] of byZ) {
      expect(list.length, `z=${z} claimed by two washes: ${list.join(" vs ")}`).toBe(1);
      // The pin canvas lives in Leaflet's own overlayPane at 400.
      expect(z, `${list[0]} must stay under the pin canvas`).toBeLessThan(400);
    }
  });

  test("no overlay pane sits on top of the pin canvas (400)", () => {
    for (const { file, z } of OVERLAYS) {
      expect(z, `${file} pane must stay under the pins`).toBeLessThan(400);
    }
  });

  // (The uniqueness check that used to live here iterated OVERLAYS and
  // so could not fail: the two washes that collided — cape 346 and
  // languages 357 — were simply not in the table. It is now the
  // source-scanning test above, which finds every pane in the tree.)
});

// ── BUILD tokens (PNG immutability) ─────────────────────────────────────

describe("BUILD tokens", () => {
  // PNG tiles are Caddy-immutable for a year: a rebuilt pyramid behind
  // a stale token is invisible. Rivers are GeoJSON (not immutable), so
  // it only carries a token for cache-busting convenience.
  const tiled = ["soil-layer.js", "cropland-layer.js", "climate-layer.js", "etopo-layer.js"];
  for (const file of tiled) {
    test(`${file} carries a BUILD token on its tile URLs`, () => {
      const js = load(file);
      expect(js).toMatch(/const BUILD = "\d+"/);
      expect(js).toMatch(/tiles\/\{z\}\/\{x\}\/\{y\}\.png\?v=/);
    });
  }
});

// ── soil: WRB default + fallback ────────────────────────────────────────

describe("soil layer defaults", () => {
  const js = load("soil-layer.js");

  test("WRB soil groups are the default property", () => {
    expect(js).toMatch(/PROP_ORDER = \["wrb",\s*"usda",\s*"texture"/);
    expect(js).toMatch(/storageGet\(PROP_STORE_KEY, "wrb"\)/);
  });

  test("falls back through the list if the preferred pyramid is missing", () => {
    // A build still running must not leave a dead "Loading…" forever.
    expect(js).toMatch(/function loadWithFallback\(/);
    expect(js).toMatch(/no soil layer published/);
  });

  test("the probe refuses a short/half-downloaded grid", () => {
    expect(js).toMatch(/arr\.length !== expect/);
  });

  test("class layers (wrb/texture) resolve labels, not raw numbers", () => {
    expect(js).toMatch(/key === "texture" \|\| key === "wrb" \|\| meta\.unit === "class"/);
  });
});

// ── cropland: palette transparency + seam-free warp ─────────────────────

describe("cropland builder invariants", () => {
  const py = readFileSync(join(ROOT, "..", "scripts", "cropland_build.py"), "utf8");

  test("palette emits a full per-slot alpha array (the black-wash fix)", () => {
    // bytes([transparent]) only marks slot 0; every other class went
    // opaque black. The builder must build an `alphas` list.
    expect(py).toMatch(/alphas\.append\(a\)/);
    expect(py).toMatch(/img\.info\["transparency"\] = alphas/);
    // The old buggy form must not come back.
    expect(py).not.toMatch(/img\.info\["transparency"\] = bytes\(\[transparent\]\)/);
  });

  test("pixel_range expands windows outward (the yellow-grid fix)", () => {
    expect(py).toMatch(/math\.floor\(\(lon0 \+ 180\.0\) \/ 360\.0 \* n\)/);
    expect(py).toMatch(/math\.ceil\(\(lon1 \+ 180\.0\) \/ 360\.0 \* n\)/);
  });

  test("the blit copies only valid pixels so edge slivers cannot clobber", () => {
    expect(py).toMatch(/valid = block != NODATA/);
    expect(py).toMatch(/dst\[valid\] = block\[valid\]/);
  });

  test("the probe-grid reshape is (coarse, fine, coarse, fine) = (30, 10, …)", () => {
    expect(py).toMatch(/coarse = int\(round\(3\.0 \/ GRID_DEG\)\)/);
    expect(py).toMatch(/arr\.reshape\(coarse, fine_per, coarse, fine_per\)/);
    // The old (10, 30) form wrote only 1/9 of the globe.
    expect(py).not.toMatch(/reshape\(sub, fine \/ sub, sub, fine \/ sub\)/);
  });

  test("--grids-only rebuilds probe grids without the pyramid", () => {
    expect(py).toMatch(/--grids-only/);
    expect(py).toMatch(/grids-only: keeping existing tiles/);
  });
});

// ── rivers: rank table + click safety ───────────────────────────────────

describe("river layer invariants", () => {
  const js = load("river-layer.js");

  test("every Natural Earth rank 1..12 has a style", () => {
    for (let r = 1; r <= 12; r++) {
      expect(js, `rank ${r} missing`).toMatch(new RegExp(`${r}:\\s*\\{\\s*width:`));
    }
  });

  test("every rank is visible by zoom 6 (drainage reads as a network)", () => {
    // The highest minZoom in the RANK TABLE must be ≤ 6. The scan has to
    // be scoped to the table: rankStyle() also carries a last-resort
    // fallback object with minZoom 9, which is not a rank entry.
    const table = js.slice(js.indexOf("FALLBACK_RANK"), js.indexOf("};", js.indexOf("FALLBACK_RANK")));
    const matches = [...table.matchAll(/minZoom:\s*(\d+)/g)];
    expect(matches.length).toBeGreaterThan(0);
    const max = Math.max(...matches.map((m) => Number(m[1])));
    expect(max).toBeLessThanOrEqual(6);
  });

  test("the GeoJSON carries a BUILD token", () => {
    expect(js).toMatch(/const BUILD = "\d+"/);
    expect(js).toMatch(/rivers\.geojson\?v=/);
  });

  test("rivers never swallow map clicks", () => {
    const fn = js.match(/function blocksClick\(\)\s*\{[^}]+\}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toMatch(/return false/);
  });

  test("labels are rank-gated and capped", () => {
    expect(js).toMatch(/FALLBACK_LABEL_RANK = 4/);
    // The cap is a DECLARED CONSTANT and it is USED — one label per river
    // name (2026-11-01) means the budget is spent by candidates, so the
    // break must still be there or a dense viewport could exceed 40.
    expect(js).toMatch(/MAX_LABELS = 40/);
    expect(js).toMatch(/out\.length >= MAX_LABELS\) break/);
    // One label per NAME, not per feature: Natural Earth splits a river
    // into several features and "per feature" drew Benue twice.
    expect(js).toMatch(/const byName = new Map\(\)/);
  });
});

// ── the empty-tile fallback (Caddy) ─────────────────────────────────────
//
// Missing tiles used to 404 with the *.png immutable header, so
// browsers cached the 404 for a year and a rebuilt pyramid stayed
// invisible. Caddy now answers them with a transparent pixel.

describe("missing-tile fallback", () => {
  // The Caddyfile is outside public_html; skip gracefully if absent.
  const caddyPath = join(ROOT, "..", "..", "caddy", "Caddyfile");
  const altPaths = ["/etc/caddy/Caddyfile", caddyPath];

  test("the empty-tile asset exists", () => {
    expect(existsSync(join(ROOT, "data", "empty-tile.png"))).toBe(true);
  });

  test("Caddy rewrites missing overlay tiles to the empty pixel", () => {
    let caddy = null;
    for (const p of altPaths) {
      if (existsSync(p)) { caddy = readFileSync(p, "utf8"); break; }
    }
    if (!caddy) return; // not on this machine
    expect(caddy).toMatch(/@missingTile/);
    expect(caddy).toMatch(/path \/data\/soil\/\* \/data\/cropland\/\* \/data\/koppen\/\*/);
    expect(caddy).toMatch(/not file/);
    expect(caddy).toMatch(/rewrite \* \/data\/empty-tile\.png/);
  });
});

// ── hash/localStorage restore ordering ──────────────────────────────────
//
// 2026-10-28: MagLayer.init() restored from localStorage by calling
// state.lines.addTo(map) BEFORE registering the overlayadd listener.
// addTo fires overlayadd synchronously; with no listener attached,
// onLayerToggled never ran, state.enabled stayed false, and fillLines()
// never happened — while the layers-control checkbox still looked
// checked (Leaflet only checks map.hasLayer). Reloading a shared link
// that DID include the overlay then skipped the addTo entirely
// (hasLayer was already true) and _activeOverlayNames never recorded
// the name, so the next hash rewrite dropped it.
//
// Rule: any module that restores from localStorage via addTo() in init
// MUST register its overlayadd/overlayremove listeners first. This test
// scans every overlay module's init body for the violation.

describe("overlay hash/localStorage restore ordering", () => {
  // Modules that restore a persisted on/off state by calling addTo()
  // inside init(). If a module uses a different mechanism (layer-level
  // on("add"), computing enabled from hasLayer) it is not listed.
  const RESTORERS = [
    "mag-layer.js",
    "climate-layer.js",
    "temp-layer.js",
    "basin-layer.js",
  ];

  for (const file of RESTORERS) {
    test(`${file}: overlayadd listener registered before any addTo in init`, () => {
      const js = load(file);
      const initStart = js.indexOf("function init(");
      // init ends at the next top-level function or the public API block.
      const initEnd = js.indexOf("function blocksClick", initStart) >= 0
        ? js.indexOf("function blocksClick", initStart)
        : js.indexOf("window.", initStart);
      expect(initStart, `${file} has no init()`).toBeGreaterThan(-1);
      expect(initEnd).toBeGreaterThan(initStart);
      const init = js.slice(initStart, initEnd);

      // Find every addTo in the init body (the localStorage restore).
      const addMatches = [...init.matchAll(/\.addTo\(/g)];
      if (addMatches.length === 0) return; // nothing to check

      // The first overlayadd/overlayremove registration must come before
      // the first addTo. Layer-level on("add") is a different mechanism
      // (fires whenever the layer joins the map, from any path) and is
      // NOT a substitute for the map-level listener in this rule — but
      // a module that uses only on("add") has no ordering hazard.
      const listenerAt = init.search(/map\.on\(\s*["']overlayadd["']/);
      const firstAddAt = addMatches[0].index;

      if (listenerAt === -1) {
        // No map-level listener: the module must either use layer-level
        // on("add") (safe — fires from any path) or compute enabled from
        // hasLayer after the restore. Assert one of those.
        const layerLevel = /\.on\(\s*["']add["']/.test(js);
        const computesFromHasLayer = /state\.enabled\s*=\s*!!.*hasLayer/.test(init)
          || /state\.enabled\s*=\s*.*\.hasLayer/.test(init);
        expect(
          layerLevel || computesFromHasLayer,
          `${file}: init() calls addTo() but has no overlayadd listener — ` +
          "use layer-level on('add') or compute enabled from hasLayer"
        ).toBe(true);
        return;
      }

      expect(
        listenerAt,
        `${file}: overlayadd listener must be registered before the localStorage addTo ` +
        "(addTo fires overlayadd synchronously; a later listener never sees the restore)"
      ).toBeLessThan(firstAddAt);
    });
  }
});

// ── the modules actually parse ──────────────────────────────────────────

describe("overlay modules parse", () => {
  for (const { file, global } of OVERLAYS) {
    test(`${file} is valid JS and exposes window.${global}`, () => {
      const js = load(file);
      // Bun can evaluate the IIFE in a bare window.
      const win = {};
      // L is required at definition time only inside functions; stub it.
      const fn = new Function("window", "L", "document", "localStorage", "fetch", js);
      try {
        fn(win, undefined, undefined, undefined, undefined);
      } catch (_) {
        // Some modules touch L/document at parse; the global must at
        // least be assigned before any throw inside init paths.
      }
      expect(js).toMatch(new RegExp(`window\\.${global}\\s*=`));
    });
  }
});
