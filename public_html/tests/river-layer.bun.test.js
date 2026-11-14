/**
 * Rivers overlay — Natural Earth 10m lake centerlines.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const riverJs = readFileSync(join(root, "river-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("river-layer module", () => {
  test("exposes RiverLayer with a stable name", () => {
    expect(riverJs).toMatch(/window\.RiverLayer\s*=/);
    expect(riverJs).toMatch(/LAYER_NAME:\s*"💧 Rivers"/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity"]) {
      expect(riverJs).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.RiverLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.RiverLayer\.init\(map\)/);
  });

  test("loads GeoJSON with a BUILD token", () => {
    expect(riverJs).toMatch(/const BUILD = "\d+"/);
    expect(riverJs).toMatch(/rivers\.geojson\?v=/);
  });

  test("styles by scalerank and shows everything by zoom 6", () => {
    expect(riverJs).toMatch(/scalerank/);
    expect(riverJs).toMatch(/minZoom/);
    expect(riverJs).toMatch(/min_zoom/);
    // Rank 1 is the Amazon; rank 9 is a creek. Both must be in the table.
    expect(riverJs).toMatch(/1:\s*\{\s*width:\s*3\.2/);
    expect(riverJs).toMatch(/9:\s*\{\s*width:\s*0\.6/);
    // Every rank visible by zoom 6 — no waiting for street zoom.
    const last = riverJs.match(/12:\s*\{\s*width:\s*[\d.]+,\s*color:\s*"[^"]+",\s*minZoom:\s*(\d+)/);
    expect(last).toBeTruthy();
    expect(Number(last[1])).toBeLessThanOrEqual(6);
  });

  test("rivers never swallow map clicks", () => {
    expect(riverJs).toMatch(/function blocksClick\(\)\s*\{\s*return false/);
  });

  test("loads before app.js and is stamped", () => {
    const riverAt = indexHtml.indexOf("river-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(riverAt).toBeGreaterThan(-1);
    expect(riverAt).toBeLessThan(appAt);
    expect(bump).toMatch(/river-layer\.js/);
  });
});

describe("river data assets", () => {
  test("geojson + meta are published with major rivers present", () => {
    const gjPath = join(root, "data", "rivers", "rivers.geojson");
    const metaPath = join(root, "data", "rivers", "meta.json");
    if (!existsSync(gjPath) || !existsSync(metaPath)) return;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.feature_count).toBeGreaterThan(500);
    expect(meta.named_count).toBeGreaterThan(100);
    expect(meta.attribution).toMatch(/Natural Earth/i);

    const fc = JSON.parse(readFileSync(gjPath, "utf8"));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBe(meta.feature_count);
    // The Amazon must be in there, or the warp is wrong.
    const labels = new Set(
      fc.features.map((f) => f.properties && (f.properties.label || f.properties.name_en || f.properties.name)).filter(Boolean)
    );
    expect(labels.has("Amazon")).toBe(true);
    expect(labels.has("Mississippi")).toBe(true);
    expect(labels.has("Nile")).toBe(true);
  });
});

describe("river layer — label selection (2026-11-01: no doubled names)", () => {
  function loadRivers() {
    const win = {};
    const fn = new Function("window", riverJs);
    fn(win);
    return win.RiverLayer;
  }
  // Every river inside the viewport, identity projection so the gap
  // maths is the only thing under test.
  const allIn = { zoom: 4, minRank: 4, contains: () => true,
                  toContainerPoint: (ll) => ({ x: ll[1] * 10, y: ll[0] * 10 }) };

  test("a river split into several features gets ONE label, on its longest stem", () => {
    // Natural Earth really does split the Benue in two — that is what
    // drew "Benue" twice, 43 px apart, on the live map.
    const layer = loadRivers();
    const feats = [
      { properties: { name: "Benue", scalerank: 3 },
        geometry: { type: "LineString", coordinates: [[8, 8], [9, 8]] } },
      { properties: { name: "Benue", scalerank: 3 },
        geometry: { type: "LineString",
          coordinates: [[10, 10], [11, 10], [12, 10], [13, 10]] } },
    ];
    const out = layer._chooseLabels(feats, allIn);
    expect(out.length).toBe(1);
    // The anchor is a third along the LONGER piece — lat 10, not lat 8.
    expect(out[0].anchor[0]).toBeCloseTo(10, 5);
    expect(out[0].name).toBe("Benue");
  });

  test("an off-screen river never takes a label slot", () => {
    const layer = loadRivers();
    const feats = [
      { properties: { name: "Benue", scalerank: 2 },
        geometry: { type: "LineString", coordinates: [[8, 8], [9, 8]] } },
      { properties: { name: "Nile", scalerank: 1 },
        geometry: { type: "LineString", coordinates: [[30, 30], [31, 30]] } },
    ];
    // The viewport only contains the Nile's anchor.
    const out = layer._chooseLabels(feats, {
      ...allIn,
      contains: (ll) => ll[1] > 20,
    });
    expect(out.map((c) => c.name)).toEqual(["Nile"]);
  });

  test("two labels closer than the screen-space gap never both place", () => {
    // Paraná and Paranaíba join; their anchors sat 42 px apart and the
    // words collided. The MORE important river (lower scalerank) wins.
    const layer = loadRivers();
    const feats = [
      { properties: { name: "Paranaíba", scalerank: 4 },
        geometry: { type: "LineString", coordinates: [[-10, -48], [-9, -48]] } },
      { properties: { name: "Paraná", scalerank: 2 },
        geometry: { type: "LineString", coordinates: [[-10, -47.8], [-9, -47.8]] } },
    ];
    // 0.2° apart at 10 px/° = 2 px — far inside the 70 px gap.
    const out = layer._chooseLabels(feats, allIn);
    expect(out.map((c) => c.name)).toEqual(["Paraná"]);
    // Swap the ranks and the other one wins: it is importance, not
    // file order, that decides.
    const swapped = layer._chooseLabels(
      [feats[0], { ...feats[1], properties: { name: "Paraná", scalerank: 9 } }],
      allIn);
    expect(swapped.map((c) => c.name)).toEqual(["Paranaíba"]);
  });

  test("labels re-place on PAN — placement is viewport-dependent now", () => {
    // A slot spent on an off-screen anchor is a slot a visible river
    // never gets, so zoomend alone is not enough: moveend must re-run
    // the selection (throttled, because animated pans chain moveends).
    const at = riverJs.indexOf('map.on("moveend"');
    expect(at).toBeGreaterThan(-1);
    const body = riverJs.slice(at, at + 400);
    expect(body).toMatch(/updateLabels\(/);
    expect(riverJs).toMatch(/function chooseLabels\(/);
  });

  test("the NAMES are OFF by default — and there is a switch", () => {
    // Owner ask 2026-11-08: *"not to show any labels if the user
    // doesn't want to see them.. so default it without labels"* — and
    // the FAO layer's names turned out to be the reason (they are BASIN
    // names; the source carries no river name at all). This layer's
    // names are the good kind, but the RULE is the one the reader asked
    // for, and it is the same rule on both river layers: **a name is an
    // option, not the price of admission.**
    expect(riverJs).toMatch(/storageGet\(STORE_LABELS,\s*"0"\)\s*!==\s*"0"/);
    // The selection must respect it…
    expect(riverJs).toMatch(/!state\.enabled\s*\|\|\s*!state\.labelsOn\s*\|\|\s*zoom\s*<\s*4/);
    // …there must be a switch, and it must not be pre-ticked…
    expect(riverJs).toMatch(/id="ctrl-rivers-labels"/);
    expect(riverJs).not.toMatch(/id="ctrl-rivers-labels"[^>]*\schecked/);
    // …in a legend inside the layers dropdown (the one place a layer's
    // own options live), and the choice must be remembered.
    expect(riverJs).toMatch(/mountLegendIntoLayersControl/);
    expect(riverJs).toMatch(/leaflet-control-layers-list/);
    expect(riverJs).toMatch(/storageSet\(STORE_LABELS,\s*want\s*\?\s*"1"\s*:\s*"0"\)/);
    expect(riverJs).toMatch(/setLabelsOn:/);
    expect(riverJs).toMatch(/getLabelsOn:/);
  });

  test("BEHAVIOURALLY: a fresh reader gets no names, and their choice is kept", () => {
    // The same rule, RUN.
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
      const fn = new Function("window", "localStorage", "document", riverJs);
      fn(win, store, doc);
      win.RiverLayer.init(fakeMap());
      return win.RiverLayer;
    };

    const empty = { getItem: () => null, setItem() {}, removeItem() {} };
    expect(run(empty).getLabelsOn(), "a fresh reader must see NO names").toBe(false);

    const chosen = { getItem: (k) => (k === "xyzo.rivers.labels" ? "1" : null),
                     setItem() {}, removeItem() {} };
    expect(run(chosen).getLabelsOn(), "an explicit 'on' must be honoured").toBe(true);
  });
});

describe("river layer — HUD sampling", () => {
  function loadRivers() {
    const win = {};
    const fn = new Function("window", riverJs);
    fn(win);
    return win.RiverLayer;
  }

  test("sampleAt names the nearest named river within ~38 km", () => {
    const layer = loadRivers();
    layer._state.enabled = true;
    layer._state.features = {
      features: [
        { properties: { name: "Amazon", name_en: "Amazon River" },
          geometry: { type: "LineString", coordinates: [[-60, -3], [-59, -3]] } },
        { properties: { name: "Nil" },   // far away — must not be named
          geometry: { type: "LineString", coordinates: [[30, 15], [31, 15]] } },
      ],
    };
    expect(layer.sampleAt({ lat: -3, lng: -59.5 })).toBe("Amazon River");
  });

  test("sampleAt returns null beyond the threshold and when disabled", () => {
    const layer = loadRivers();
    layer._state.features = {
      features: [
        { properties: { name: "Amazon" },
          geometry: { type: "LineString", coordinates: [[-60, -3], [-59, -3]] } },
      ],
    };
    layer._state.enabled = true;
    // ~10° away — a river on the far side of a continent is a guess.
    expect(layer.sampleAt({ lat: 10, lng: -50 })).toBeNull();
    layer._state.enabled = false;
    expect(layer.sampleAt({ lat: -3, lng: -59.5 })).toBeNull();
    expect(layer.sampleAt(null)).toBeNull();
  });

  test("unnamed features are skipped", () => {
    const layer = loadRivers();
    layer._state.enabled = true;
    layer._state.features = {
      features: [
        { properties: { scalerank: 9 },  // no name at all
          geometry: { type: "LineString", coordinates: [[0, 0], [0.1, 0]] } },
      ],
    };
    expect(layer.sampleAt({ lat: 0, lng: 0 })).toBeNull();
  });

  test("MultiLineString geometries are scanned too", () => {
    const layer = loadRivers();
    layer._state.enabled = true;
    layer._state.features = {
      features: [
        { properties: { name_en: "Danube" },
          geometry: { type: "MultiLineString",
            coordinates: [[[10, 40], [11, 40]], [[16, 48], [17, 48]]] } },
      ],
    };
    expect(layer.sampleAt({ lat: 48, lng: 16.5 })).toBe("Danube");
  });
});
