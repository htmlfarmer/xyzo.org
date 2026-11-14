/**
 * Rivers overlay — FAO AQUASTAT "Rivers (Global, edition 2026)".
 *
 * The 2026 HydroRIVERS network, served by the publisher's own WMS, with
 * a DETAIL LEVEL and a RIVER-NAMES switch.
 *
 * What is pinned here:
 *  - the module's contract (registration, ordering, pane, attribution)
 *  - the DETAIL LEVELS: four of them, each a server-side filter, and each
 *    one MEANINGFULLY DIFFERENT from the others — a filter that is
 *    ignored looks exactly like a filter that matches everything
 *  - the LABEL selection: one label per name, on screen, spaced apart
 *  - the published data: the class table, the SLD, the licence
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const layerJs = readFileSync(join(root, "fao-rivers-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");
const presetsJs = readFileSync(join(root, "map-presets.js"), "utf8");

const metaPath = join(root, "data", "rivers", "fao", "meta.json");
const labelsPath = join(root, "data", "rivers", "fao", "labels.geojson");
const hasMeta = existsSync(metaPath);
const meta = hasMeta ? JSON.parse(readFileSync(metaPath, "utf8")) : null;

function loadLayer() {
  const win = {};
  const fn = new Function("window", layerJs);
  fn(win);
  return win.FaoRiversLayer;
}

describe("fao-rivers module contract", () => {
  test("exposes FaoRiversLayer with a stable name", () => {
    expect(layerJs).toMatch(/window\.FaoRiversLayer\s*=/);
    expect(layerJs).toMatch(/LAYER_NAME:\s*"🌊 Rivers \(FAO 2026\)"/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity",
                      "setLevel", "getLevel", "setLabelsOn", "getLabelsOn"]) {
      expect(layerJs).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.FaoRiversLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.FaoRiversLayer\.init\(map\)/);
  });

  test("loads before app.js and is stamped", () => {
    const at = indexHtml.indexOf("fao-rivers-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(bump).toMatch(/fao-rivers-layer\.js/);
  });

  test("carries its attribution — CC BY 4.0 REQUIRES it", () => {
    expect(layerJs).toMatch(/attribution\s*:/);
    expect(layerJs).toMatch(/FAO AQUASTAT/);
    expect(layerJs).toMatch(/CC BY 4\.0/);
  });

  test("uses the publisher's WMS, the river_network layer, and WMS 1.1.1", () => {
    // 1.3.0 + EPSG:4326 uses the CRS authority's axis order, which for
    // EPSG:4326 is (latitude, longitude) — a request for the Amazon
    // renders ANTARCTICA. 1.1.1 mandates (longitude, latitude).
    //
    // The NORMAL path is now the proxy (the upstream URL is built
    // server-side); the publisher's WMS is only the fallback, and the
    // version lives in BOTH places so the fallback is correct too.
    const proxy = readFileSync(join(root, "..", "api", "src", "routes", "faoRiversProxy.ts"), "utf8");
    expect(proxy).toMatch(/WMS_VERSION = "1\.1\.1"/);
    expect(proxy).toMatch(/const WMS_LAYER = "river_network"/);
    expect(layerJs).toMatch(/VERSION:\s*"1\.1\.1"/);
    expect(layerJs).toMatch(/const WMS_LAYER = "river_network"/);
  });

  test("owns a pane of its own, and never eats a click", () => {
    expect(layerJs).toMatch(/const PANE = "faoRiverPane"/);
    expect(layerJs).toMatch(/const PANE_Z = 371/);
    expect(layerJs).toMatch(/function blocksClick\(\)\s*\{\s*return false/);
  });

  test("its labels can never take a click either", () => {
    // A permanent tooltip is interactive by default in Leaflet, and a
    // label that takes a click breaks the click-to-submit flow.
    expect(layerJs).toMatch(/interactive:\s*false/);
  });
});

describe("fao-rivers — the detail levels", () => {
  test("there are four levels and the finest one has no filter", () => {
    const layer = loadLayer();
    const levels = layer._levels();
    expect(levels.length).toBe(4);
    expect(levels.map((l) => l.id)).toEqual(["major", "medium", "fine", "full"]);
    // "Full detail" is the publisher's whole network — no filter at all.
    expect(levels[3].filter).toBe(null);
    // The others thin it server-side, on the long-term average discharge.
    expect(levels[0].filter).toMatch(/dis_av_cms>=100/);
    expect(levels[1].filter).toMatch(/dis_av_cms>=10/);
    expect(levels[2].filter).toMatch(/dis_av_cms>=1/);
  });

  test("the module's fallback levels agree with the published ones", () => {
    if (!hasMeta) return;
    const layer = loadLayer();
    const published = meta.levels.map((l) => l.id + "|" + l.filter);
    const fallback = layer._levels().map((l) => l.id + "|" + l.filter);
    expect(fallback).toEqual(published);
  });

  test("the level travels in the tile URL — and the SLD does NOT", () => {
    // The level is a different PICTURE and a different cache entry, so it
    // is in the URL. The SLD (4.3 KB) and the discharge filter are the
    // PROXY's business: it reads them from the published metadata and
    // attaches them server-side, so they no longer ride in every tile
    // request the browser makes.
    const layer = loadLayer();
    // Below the cut: OUR OWN static tiles, rendered once, offline, from
    // our own copy of the network.
    // EVERY tile URL carries a build token: a PNG under public_html is
    // served `immutable` for a year and the proxy answers with
    // `max-age=604800`, so a rebuilt pyramid behind an unchanged URL is
    // invisible — which is exactly how the misaligned tiles stayed in
    // every reader's cache for a week.
    const v = "?v=" + layer._TILE_BUILD;
    expect(layer._tileUrlFor("medium", 3, 4, 5))
      .toBe("/data/rivers/fao/tiles/medium/3/5/4.png" + v);
    // Above the cut: the caching proxy.
    expect(layer._tileUrlFor("medium", 9, 4, 5))
      .toBe("/api/tile/fao-rivers/medium/9/4/5" + v);
    // z4 is a COUNTRY-sized view, so it is ours too — the whole of the
    // zoomed-out half of the map comes off our own disk.
    expect(layer._tileUrlFor("medium", 4, 7, 8))
      .toBe("/data/rivers/fao/tiles/medium/4/8/7.png" + v);
    expect(layer._tileUrlFor("full", 12, 100, 200))
      .toBe("/api/tile/fao-rivers/full/12/100/200" + v);
    // The NORMAL path never builds an upstream URL — the client asks our
    // proxy for a tile and nothing else. The publisher's WMS survives only
    // as the FALLBACK (if the proxy route is not deployed), and it is
    // built in its own function.
    const build = layerJs.slice(
      layerJs.indexOf("function buildLayer("),
      layerJs.indexOf("function getTileLayer("));
    expect(build).not.toMatch(/CQL_FILTER/);
    expect(build).not.toMatch(/sld_body/);
    // …and the fallback exists, and is used when the proxy is silent.
    expect(layerJs).toMatch(/function wmsUrl\(/);
    expect(layerJs).toMatch(/tileerror/);
  });

  test("the tile grid is the STANDARD slippy grid — tileSize must stay 256", () => {
    // **THIS IS THE BUG THAT PUT THE RIVERS IN THE WRONG PLACE ON EARTH.**
    //
    // Leaflet's `_pxBoundsToTileRange()` divides the pixel bounds by the
    // TILE SIZE, so a layer with `tileSize: 512` asks for a 512-px GRID:
    // its tile (11, 7) covers the ground of the STANDARD square (22, 14).
    // Our pyramid and the publisher are both cut on the standard 256-px
    // grid, so a 512-px layer fetched the tile from the NORTH-WEST
    // QUADRANT of where it belonged — measured: a tile the map wanted at
    // longitude 85 was fetched from longitude -56, and the rivers were
    // drawn over the Indian Ocean out of Greenland.
    //
    // The house rule (see the Macrostrat geology layer): the CRS scale
    // is fixed at 256·2^z, so the tile size stays at the default 256 and
    // the IMAGE is rendered at double resolution instead — the browser
    // downscales it into the slot, which is free sharpness.
    expect(layerJs).not.toMatch(/tileSize:\s*512/);
    const build = layerJs.slice(
      layerJs.indexOf("function buildLayer("),
      layerJs.indexOf("function getTileLayer("));
    expect(build).not.toMatch(/tileSize:\s*512/);
    // …and the two sizes are declared apart, so nobody confuses them
    // again: the grid is 256, the IMAGE is 512.
    expect(layerJs).toMatch(/const TILE_PX = 256;/);
    expect(layerJs).toMatch(/const IMAGE_PX = 512;/);
  });

  test("the tile URL carries the standard grid, and the proxy agrees", () => {
    // The proxy's route is `/tile/fao-rivers/:level/:z/:y/:x` and it
    // asks the publisher for THAT standard square — so the client must
    // send standard coordinates, which is what the 256-px grid gives.
    const layer = loadLayer();
    expect(layer._tileUrlFor("medium", 5, 11, 23))
      .toBe("/api/tile/fao-rivers/medium/5/11/23?v=" + layer._TILE_BUILD);
    expect(layer._tileUrlFor("medium", 3, 4, 5))
      .toBe("/data/rivers/fao/tiles/medium/3/5/4.png?v=" + layer._TILE_BUILD);
  });

  test("our copy of the network is GITIGNORED — it is 654 MB of a third party's data", () => {
    // `scripts/river_network_fetch.py` writes 8,477,883 reaches (654 MB)
    // into `data/rivers_fao_2026/`. It is the SOURCE for the rendered
    // pyramid, it lives outside the web root (the upstream HydroSHEDS
    // licence forbids distributing the data standalone), and it must
    // never reach the repository — a `git add -A` would commit a third
    // party's dataset at a quarter of a gigabyte.
    const gitignore = readFileSync(join(root, "..", ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^data\/rivers_fao_2026\/$/m);
  });

  test("the fallback asks for the tile in WEB MERCATOR, not in lat/lon", () => {
    // The slippy grid is a Mercator grid and Leaflet places a tile by
    // its Mercator square. A plate-carrée image stretched over a
    // Mercator square puts every line in the wrong place — measured at
    // z2, North America visibly moves.
    const wms = layerJs.slice(
      layerJs.indexOf("function wmsUrl("),
      layerJs.indexOf("const TILE_PX"));
    expect(wms).toMatch(/SRS:\s*"EPSG:3857"/);
    expect(wms).not.toMatch(/SRS:\s*"EPSG:4326"/);
  });

  test("the proxy owns the upstream URL, so the client cannot forge one", () => {
    // The upstream WMS URL is assembled server-side from a whitelist —
    // the level's own filter and the PUBLISHED SLD — so the route has no
    // SSRF surface. The client sends a level and a tile number, nothing
    // else.
    const proxy = readFileSync(join(root, "..", "api", "src", "routes", "faoRiversProxy.ts"), "utf8");
    expect(proxy).toMatch(/fao-rivers\/:level\/:z\/:y\/:x/);
    expect(proxy).toMatch(/unknown_level/);
    expect(proxy).toMatch(/CQL_FILTER/);
    // And the SLD it sends is the PUBLISHED one, not a caller's.
    expect(proxy).toMatch(/meta\.sld\.body/);
  });

  test("choosing a level repaints the legend, not just the map", () => {
    // The chip the reader clicked has to become the PRESSED one, and the
    // caption has to say what the new level means. A legend that keeps
    // showing the old level is a legend that lies about the map.
    const at = layerJs.indexOf("function setLevel(");
    expect(at).toBeGreaterThan(-1);
    const body = layerJs.slice(at, at + 700);
    expect(body).toMatch(/refreshLegend\(\)/);
  });

  test("the level survives a reload and a link does not overwrite it", () => {
    // The stored level is the reader's PREFERENCE; a link's level is a
    // VIEW. The two are different things and must not be confused.
    expect(layerJs).toMatch(/storageSet\(STORE_LEVEL, next\)/);
    expect(appJs).toMatch(/setLevel\(parsed\.riversLevel, \{ persist: false \}\)/);
  });
});

describe("fao-rivers — the label selection", () => {
  function loadRivers() {
    const win = {};
    const fn = new Function("window", layerJs);
    fn(win);
    return win.FaoRiversLayer;
  }
  const allIn = {
    zoom: 6, minStrahler: 3,
    contains: () => true,
    toContainerPoint: (ll) => ({ x: ll[1] * 10, y: ll[0] * 10 }),
  };

  test("only the rivers big enough for this zoom are labelled", () => {
    const layer = loadRivers();
    const labels = [
      { name: "Amazon", lat: -3, lng: -60, strahler: 7 },
      { name: "Creek", lat: 10, lng: 20, strahler: 1 },
    ];
    const out = layer._chooseLabels(labels, allIn);
    expect(out.map((c) => c.name)).toEqual(["Amazon"]);
  });

  test("an off-screen river never takes a label slot", () => {
    const layer = loadRivers();
    const labels = [
      { name: "Amazon", lat: -3, lng: -60, strahler: 7 },
      { name: "Nile", lat: 15, lng: 32, strahler: 7 },
    ];
    const out = layer._chooseLabels(labels, {
      ...allIn,
      contains: (ll) => ll[1] > 20,
    });
    expect(out.map((c) => c.name)).toEqual(["Nile"]);
  });

  test("two labels closer than the screen-space gap never both place", () => {
    const layer = loadRivers();
    const labels = [
      { name: "Paranaiba", lat: -10, lng: -48, strahler: 6 },
      { name: "Parana", lat: -10, lng: -47.8, strahler: 7 },
    ];
    // 0.2° apart at 10 px/° = 2 px — far inside the 70 px gap. The MORE
    // important river (the higher order) wins the slot.
    const out = layer._chooseLabels(labels, allIn);
    expect(out.map((c) => c.name)).toEqual(["Parana"]);
  });

  test("the label budget is bounded", () => {
    const layer = loadRivers();
    const labels = [];
    for (let i = 0; i < 200; i++) {
      labels.push({ name: "R" + i, lat: i * 0.5, lng: i * 0.5, strahler: 5 });
    }
    const out = layer._chooseLabels(labels, allIn);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  test("the size gate tightens as the map zooms out", () => {
    const layer = loadRivers();
    expect(layer._labelMinStrahler(2)).toBeGreaterThan(layer._labelMinStrahler(9));
  });
});

describe("fao-rivers — the published data", () => {
  test("meta.json states its licence and its attribution", () => {
    if (!hasMeta) return;
    expect(meta.license).toBe("CC BY 4.0");
    expect(meta.license).not.toMatch(/NC|NonCommercial|ShareAlike/);
    expect(meta.attribution.length).toBeGreaterThan(10);
    expect(meta.attribution).toMatch(/FAO AQUASTAT/);
    expect(meta.source).toMatch(/HydroRIVERS/);
  });

  test("A REBUILD MUST NOT DROP THE UPSTREAM LICENCE", () => {
    // The builder OVERWRITES the published meta.json, and the upstream
    // licence (Appendix A of the HydroSHEDS Technical Documentation v1.4)
    // requires the Exhibit B attribution to travel with the metadata.
    //
    // It was published once, by a version of the builder that carried it,
    // and the repo's builder could NOT reproduce it — so a rebuild
    // dropped it and this very test failed on the published file. The
    // builder now writes it, so the obligation survives a rebuild.
    if (!hasMeta) return;
    expect(typeof meta.upstream_attribution).toBe("string");
    expect(meta.upstream_attribution.length).toBeGreaterThan(200);
    expect(meta.upstream_attribution).toMatch(/HydroSHEDS version 1 database/);
    expect(meta.upstream_attribution).toMatch(/World Wildlife Fund/);
    expect(meta.upstream_citation).toMatch(/Lehner/);
    // …and the BUILDER writes them, so the next rebuild keeps them.
    const builder = readFileSync(
      join(root, "..", "scripts", "river_network_build.py"), "utf8");
    expect(builder).toMatch(/UPSTREAM_ATTRIBUTION\s*=/);
    expect(builder).toMatch(/UPSTREAM_CITATION\s*=/);
    expect(builder).toMatch(/"upstream_attribution":\s*UPSTREAM_ATTRIBUTION/);
    expect(builder).toMatch(/"upstream_citation":\s*UPSTREAM_CITATION/);
    // And the fetch script (the out-of-web-root manifest) reads the SAME
    // text from there — one licence statement, two places it travels.
    const fetch = readFileSync(
      join(root, "..", "scripts", "river_network_fetch.py"), "utf8");
    expect(fetch).toMatch(/from river_network_build import/);
    expect(fetch).toMatch(/UPSTREAM_ATTRIBUTION/);
  });

  test("the NAMES are OFF by default — a name is an option", () => {
    // Owner ask 2026-11-08: *"not to show any labels if the user
    // doesn't want to see them.. so default it without labels"*.
    //
    // The default is read from the store, and the store's fallback is
    // what a reader who has never touched the switch gets. It must be
    // "0" — OFF.
    expect(layerJs).toMatch(/storageGet\(STORE_LABELS,\s*"0"\)\s*!==\s*"0"/);
    // …and the switch's markup must NOT be pre-ticked (the legend paints
    // the box from the state, so a hard-coded `checked` would show a
    // ticked box for a frame before the state wins).
    expect(layerJs).not.toMatch(/id="ctrl-fao-rivers-labels"[^>]*\schecked/);
    // The choice is remembered, so this is a DEFAULT and not a removal.
    expect(layerJs).toMatch(/storageSet\(STORE_LABELS,\s*want\s*\?\s*"1"\s*:\s*"0"\)/);
  });

  test("BEHAVIOURALLY: a fresh reader gets no names, and their choice is kept", () => {
    // The same rule, RUN: the module is loaded with a store that has
    // nothing in it, and with one that carries the reader's choice.
    const fakeMap = () => {
      const panes = {};
      return {
        createPane(name) {
          panes[name] = { name, style: {}, appendChild() {} };
          return panes[name];
        },
        getPane(name) { return panes[name] || null; },
        on() {}, getZoom() { return 5; },
        getBounds() {
          return { getWest: () => -20, getEast: () => 20,
                   getNorth: () => 20, getSouth: () => -20, pad: () => null };
        },
        latLngToContainerPoint: () => ({ x: 0, y: 0 }),
        getContainer: () => ({ appendChild() {} }),
        hasLayer: () => false, addLayer() {}, removeLayer() {},
      };
    };

    const run = (store) => {
      // A document with no layers control in it: the legend cannot be
      // mounted, which is exactly the state before the dropdown exists.
      const doc = {
        querySelector: () => null,
        getElementById: () => null,
        createElement: () => ({ className: "", style: {}, setAttribute() {},
                                appendChild() {}, querySelector: () => null,
                                querySelectorAll: () => [] }),
        body: { appendChild() {} },
        addEventListener() {},
      };
      const win = { localStorage: store };
      const fn = new Function("window", "localStorage", "document", layerJs);
      fn(win, store, doc);
      win.FaoRiversLayer.init(fakeMap());
      return win.FaoRiversLayer;
    };

    const empty = { getItem: () => null, setItem() {}, removeItem() {} };
    const layer = run(empty);
    expect(layer.getLabelsOn(), "a fresh reader must see NO names").toBe(false);

    // The reader's own choice wins.
    const chosen = { getItem: (k) => (k === "xyzo.faoRivers.labels" ? "1" : null),
                     setItem() {}, removeItem() {} };
    const layer2 = run(chosen);
    expect(layer2.getLabelsOn(), "an explicit 'on' must be honoured").toBe(true);
  });

  test("the published names carry no description and no abbreviation", () => {
    // Measured on the source (86,882 features): the FAO's names are BASIN
    // names, and among them are 16 area DESCRIPTIONS in Spanish ("Zona
    // de rios en Chaco Boreal") and 12 one-or-two-letter abbreviations
    // ("Ko" for Lake Chad, "Lom" for the Danube, "Mu" for the
    // Irrawaddy). The parent basin is published under its own name, so
    // dropping an abbreviation loses nothing.
    if (!existsSync(labelsPath)) return;
    const fc = JSON.parse(readFileSync(labelsPath, "utf8"));
    const names = fc.features.map((f) => (f.properties || {}).name || "");
    for (const n of names) {
      expect(n.length, `"${n}" is too short to be a name`).toBeGreaterThanOrEqual(3);
      expect(n.toLowerCase(), `"${n}" is a description, not a river`)
        .not.toMatch(/zona|cuenca|versante|sin rios/);
    }
  });

  test("the publisher's mangled accents are repaired, not printed", () => {
    // The FAO's WFS sends the UTF-8 of U+FFFD, encoded a second time,
    // for 1,546 of its 86,882 features — verified at the source, so the
    // character is gone from THEIR data and cannot be recovered. The map
    // prints a plain "?" instead of the mojibake.
    if (!existsSync(labelsPath)) return;
    const fc = JSON.parse(readFileSync(labelsPath, "utf8"));
    const names = fc.features.map((f) => (f.properties || {}).name || "");
    expect(names.some((n) => n.includes("ï¿½")),
           "the mojibake is still in the published names").toBe(false);
    expect(names.some((n) => n.includes("?")),
           "the repaired names are missing").toBe(true);
    const builder = readFileSync(
      join(root, "..", "scripts", "river_network_build.py"), "utf8");
    expect(builder).toMatch(/MOJIBAKE\s*=/);
    expect(builder).toMatch(/repair_mojibake/);
  });

  test("the class table the legend is drawn from is published", () => {
    if (!hasMeta) return;
    expect(Array.isArray(meta.classes)).toBe(true);
    expect(meta.classes.length).toBeGreaterThan(2);
    for (const c of meta.classes) {
      expect(typeof c.title).toBe("string");
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(Number.isFinite(c.width)).toBe(true);
    }
    expect(meta.intermittent.dashed).toBe(true);
  });

  test("the SLD is published, and it is the one the map is drawn from", () => {
    if (!hasMeta) return;
    const sld = meta.sld && meta.sld.body;
    expect(typeof sld).toBe("string");
    expect(sld).toMatch(/StyledLayerDescriptor/);
    // The class the publisher's own style omits — every reach of order 7
    // and finer, which is 59 % of the network — has to be in ours, or
    // "Full detail" means nothing.
    expect(sld).toMatch(/ord_flow/);
    expect(sld).toMatch(/smooth_200/);
    // It travels in the URL of every tile request, so it has to stay
    // inside a request line a servlet container will accept.
    expect(sld.length).toBeLessThan(6000);
  });

  test("the labels are published, and the great rivers are among them", () => {
    if (!existsSync(labelsPath)) return;
    const fc = JSON.parse(readFileSync(labelsPath, "utf8"));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBeGreaterThan(100);
    const names = new Set(fc.features.map((f) => f.properties && f.properties.name));
    for (const n of ["Amazon", "Nile", "Congo", "Yangtze", "Danube"]) {
      expect(names.has(n), `${n} is missing from the labels`).toBe(true);
    }
    // The FAO names the Mississippi's basin "Mississippi - Missouri", so
    // the prefix is what the label carries.
    expect([...names].some((n) => n.startsWith("Mississippi")),
           "the Mississippi is missing from the labels").toBe(true);
    // A place is not a river: the curation drops the basin names that
    // read as land or sea.
    expect(names.has("Sahara")).toBe(false);
    expect(names.has("Gobi Interior")).toBe(false);
  });
});

describe("fao-rivers — the link carries the detail level", () => {
  test("the hash writer emits the level when the layer is on", () => {
    expect(appJs).toMatch(/rivers=\$\{encodeURIComponent\(lvl\)\}/);
  });

  test("the hash parser reads the level back", () => {
    expect(appJs).toMatch(/riversMatch\s*=\s*p\.match\(\/\^rivers=\(\[a-z\]\+\)\/\)/);
  });

  test("a link's level is a VIEW — it does not overwrite the reader's own", () => {
    expect(appJs).toMatch(/setLevel\(parsed\.riversLevel, \{ persist: false \}\)/);
  });

  test("the preset grammar speaks it too", () => {
    // A preset, a pasted link and a saved style must never diverge.
    expect(presetsJs).toMatch(/rivers=\(\[a-z\]\+\)/);
    expect(presetsJs).toMatch(/riversLevel/);
  });
});
