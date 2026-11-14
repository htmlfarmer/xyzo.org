// city-labels.bun.test.js — population-filtered city-name overlay.
//
// Reuses CityEngine's already-indexed 44,487 cities (never refetches
// the 4 MB JSON), draws on a canvas in cityLabelPane (z 380 — above
// wind, below pins), and never blocks clicks.

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const clJs = readFileSync(join(ROOT, "city-labels.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("city-labels module", () => {
  test("exposes CityLabels with the layers-control surface", () => {
    expect(clJs).toMatch(/window\.CityLabels\s*=/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity", "blocksClick"]) {
      expect(clJs, `${fn} missing`).toMatch(new RegExp(`\\b${fn}\\b`));
    }
    expect(clJs).toMatch(/LAYER_NAME:\s*"🏙️ City names"/);
  });

  test("registered in WEATHER_OVERLAYS and initialized after the map", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.CityLabels\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.CityLabels\.init\(map\)/);
  });

  test("loads before app.js and is stamped by bump_frontend.sh", () => {
    const at = indexHtml.indexOf("city-labels.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(bump).toMatch(/city-labels\.js/);
  });

  test("reuses CityEngine's index instead of refetching the 4 MB JSON", () => {
    // The primary path must go through CityEngine.load(); the direct
    // fetch is only a fallback if the module is somehow absent.
    expect(clJs).toMatch(/window\.CityEngine/);
    expect(clJs).toMatch(/CE\.load\(\)/);
    expect(clJs).toMatch(/_state\(\)\.allCities/);
    expect(clJs).toMatch(/CityEngine's index/);
  });

  test("population floor rises as you zoom out", () => {
    expect(clJs).toMatch(/const MIN_POP = \[/);
    expect(clJs).toMatch(/10_000_000/);
    expect(clJs).toMatch(/function minPopForZoom/);
    // z0 must demand megacities; z8+ draws everything.
    expect(clJs).toMatch(/0,\s*\/\/ z8\+/);
  });

  test("candidates are drawn largest-first with collision avoidance", () => {
    expect(clJs).toMatch(/sort\(/);
    expect(clJs).toMatch(/\(b\.p \|\| 0\) - \(a\.p \|\| 0\)/);
    expect(clJs).toMatch(/collision/);
    expect(clJs).toMatch(/placed\.push/);
    // Bounded: a world view must not try to draw 44k labels.
    expect(clJs).toMatch(/MAX_LABELS = 400/);
  });

  test("redraws only on moveend/zoomend/resize, not per frame", () => {
    expect(clJs).toMatch(/scheduleRedraw/);
    expect(clJs).toMatch(/moveend zoomend resize/);
    expect(clJs).toMatch(/setTimeout/);
    // Hide while dragging so a stale projection reads as loading, not glitching.
    expect(clJs).toMatch(/visibility = "hidden"/);
  });

  test("canvas is re-anchored to the screen origin on every redraw", () => {
    // THE OFF-CENTER FIX (2026-10-28): the canvas lives inside the map
    // pane, and Leaflet's pane translate PERSISTS after every drag-pan
    // (panBy([150,80]) → translate3d(-150,-80,0); only setView/zoom
    // zeroes it). Drawing at latLngToContainerPoint on a canvas that
    // rides along with the pane put every label paneOffset away from
    // its city — fine on a fresh load, drifting with every pan. The
    // anchor must be recomputed each redraw, because the translate
    // changes with every pan.
    const redrawFn = clJs.match(/function redraw\(\)\s*\{[\s\S]*?\n  \}/);
    expect(redrawFn, "redraw() not found").toBeTruthy();
    const body = redrawFn[0];
    expect(body).toMatch(/containerPointToLayerPoint\(\[0, 0\]\)/);
    expect(body).toMatch(/c\.style\.left = anchor\.x/);
    expect(body).toMatch(/c\.style\.top = anchor\.y/);
    // …and the drawing itself stays in container coordinates.
    expect(body).toMatch(/latLngToContainerPoint\(\[lat, lng\]\)/);
  });

  test("the canvas is un-hidden by redraw(), not by a bare moveend", () => {
    // A moveend → visibility="" handler un-hides STALE content for the
    // ~80 ms coalesce window; redraw() reveals only after painting.
    expect(clJs).toMatch(/c\.style\.visibility = ""/);
    // No bare moveend/zoomend handler restores visibility any more —
    // the only such block belongs to movestart/zoomstart (hidden).
    const bare = clJs.match(/map\.on\("moveend zoomend", \(\) => \{[^}]*visibility[^}]*\}\)/);
    expect(bare).toBeNull();
  });

  test("labels never block clicks (canvas is pointer-events:none)", () => {
    expect(clJs).toMatch(/return false/);
    expect(clJs).toMatch(/pointerEvents = "none"/);
    // and the public API agrees
    const fn = clJs.match(/function blocksClick\(\)\s*\{[^}]+\}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toMatch(/return false/);
  });

  test("pane sits between wind (370) and the pins (400)", () => {
    expect(clJs).toMatch(/PANE_Z = 380/);
  });

  test("setOpacity drives the canvas, not a tile container", () => {
    expect(clJs).toMatch(/state\.canvas\.style\.opacity/);
    // Instance-level pair for the opacity registry (GeoJSON-style fix).
    expect(clJs).toMatch(/state\._layer\.setOpacity/);
    expect(clJs).toMatch(/state\._layer\.getOpacity/);
  });

  test("persists the on/off choice and restores it on a bare revisit", () => {
    // onLayerToggled must write the preference…
    expect(clJs).toMatch(/storageSet\(STORE_KEY, state\.enabled \? "1" : "0"\)/);
    // … and init() must read it back and put the layer on the map. Without
    // the restore the checkbox worked for one session and a revisit with
    // no URL hash came back with labels OFF despite localStorage "1"
    // (the mag/climate layers restore the same way). The addTo must sit
    // AFTER the overlayadd listener registration, or state.enabled never
    // flips when the restore fires the event.
    const initFn = clJs.match(/function init\(map\)\s*\{[\s\S]*?\n  \}/);
    expect(initFn, "init() not found").toBeTruthy();
    const body = initFn[0];
    const listenerAt = body.indexOf('map.on("overlayadd"');
    const restoreAt = body.indexOf('storageGet(STORE_KEY, "0") === "1"');
    expect(restoreAt).toBeGreaterThan(-1);
    expect(listenerAt).toBeGreaterThan(-1);
    expect(listenerAt).toBeLessThan(restoreAt);
    expect(body.slice(restoreAt)).toMatch(/layer\.addTo\(map\)/);
  });

  test("data file exists with the expected shape", () => {
    const path = join(ROOT, "data", "cities.10k.json");
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(40000);
    const sample = data.find((c) => c.n && c.la != null && c.ln != null && c.p != null);
    expect(sample, "cities must carry name + lat + lng + population").toBeTruthy();
    expect(typeof sample.p).toBe("number");
  });
});
