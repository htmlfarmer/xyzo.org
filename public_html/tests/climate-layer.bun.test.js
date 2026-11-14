// climate-layer.bun.test.js — static contract checks for the Köppen climate
// overlay (public_html/climate-layer.js + the assets it loads).
//
// These are cheap static checks — the browser-side behaviour is covered by
// scripts/run_ui_tests.py and the Playwright diagnostics CLI.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const climateJs = readFileSync(join(ROOT, "climate-layer.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

const DATA = join(ROOT, "data", "koppen");

describe("climate layer — script + markup wiring", () => {
  test("climate-layer.js is loaded before app.js (app.js registers the overlay)", () => {
    expect(indexHtml).toMatch(/<script[^>]+src="climate-layer\.js[^"]*"\s+defer><\/script>/);
    const climateAt = indexHtml.indexOf('src="climate-layer.js');
    const appAt = indexHtml.indexOf('src="app.js');
    expect(climateAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);
    expect(climateAt).toBeLessThan(appAt);
  });

  test("the overlay is registered in the Leaflet layers control", () => {
    // The overlay belongs in the layers control next to the NASA layers.
    expect(appJs).toMatch(/WEATHER_OVERLAYS\["🌍 Köppen Climate"\]/);
    expect(appJs).toMatch(/ClimateLayer\.getTileLayer\(\)/);
    expect(appJs).toMatch(/"🌍 Köppen Climate":\s*"koppen"/);
  });

  test("the on/off switch is the layers-control checkbox, with the others", () => {
    // No separate floating control: the overlay is switched from the
    // Leaflet layers dropdown, next to the NASA overlays.
    expect(appJs).toMatch(/WEATHER_OVERLAYS\["🌍 Köppen Climate"\]/);
    expect(climateJs).not.toMatch(/mountQuickToggle/);
    expect(stylesCss).not.toMatch(/\.climate-quick\s*\{/);
  });

  test("the probe toggle lives in the dropdown, not in a floating panel", () => {
    expect(climateJs).toMatch(/id="ctrl-climate-probe-toggle"/);
    // There is no floating climate panel in the markup any more.
    expect(indexHtml).not.toMatch(/id="ctrl-climate-probe-toggle"/);
    expect(indexHtml).not.toMatch(/id="climate-legend"/);
  });

  test("the 29-class key lives INSIDE the Leaflet layers dropdown", () => {
    // Nothing floats over the map: the key is injected into the layer
    // list, which is collapsed by default.
    expect(climateJs).toMatch(/function mountLegendIntoLayersControl\(/);
    expect(climateJs).toMatch(/\.leaflet-control-layers-list/);
    expect(climateJs).toMatch(/section\.appendChild\(host\)/);
    expect(stylesCss).toMatch(/\.leaflet-control-layers-climate\s*\{/);
  });

  test("the app.js cache-buster is bumped with the app.js changes", () => {
    // app.js gained the Köppen registration on 2026-10-22 but its ?v=
    // token was left at the older stamp — cached browsers never got the
    // overlay entry in the layers dropdown.
    const appToken = (indexHtml.match(/app\.js\?v=(\d+)/) || [])[1];
    const climateToken = (indexHtml.match(/climate-layer\.js\?v=(\d+)/) || [])[1];
    expect(appToken).toBeTruthy();
    expect(appToken).toBe(climateToken);
  });

  test("probe mode is offered only where there is no hover", () => {
    // Leaflet's own leaflet-touch class cannot be used — desktop Chrome
    // exposes window.TouchEvent, so Leaflet tags every browser with it.
    expect(climateJs).toMatch(/pointer: coarse/);
    expect(climateJs).toMatch(/maxTouchPoints/);
    expect(stylesCss).toMatch(/\.leaflet-control-layers-climate\.is-touch \.climate-probe-toggle/);
  });

  test("no climate legend panel is rendered in the page markup", () => {
    // The panel was removed — the key is built by climate-layer.js and
    // injected into the layers dropdown.
    expect(indexHtml).not.toMatch(/climate-legend/);
    expect(climateJs).toMatch(/id="climate-legend-body"/);
    expect(climateJs).toMatch(/id="climate-legend-detail"/);
  });

  test("climate pane sits above the base tiles and below the pin canvas", () => {
    // tilePane = 200, overlayPane (pin canvas + heatmap) = 400.
    expect(appJs).toMatch(/createPane\("climatePane"\)/);
    expect(appJs).toMatch(/zIndex = "350"/);
  });

  test("overlay is a tile layer pointing at the built pyramid", () => {
    expect(climateJs).toMatch(/L\.tileLayer\(TILES_URL/);
    expect(climateJs).toMatch(/tiles\/\{z\}\/\{x\}\/\{y\}\.png/);
  });

  test("probe mode blocks the click-to-submit flow", () => {
    expect(climateJs).toMatch(/blocksClick:\s*\(\)\s*=>\s*state\.enabled\s*&&\s*state\.probeMode/);
    expect(appJs).toMatch(/ClimateLayer\.blocksClick\(\)/);
  });

  test("climate state round-trips through the URL hash", () => {
    // The overlay is a normal layers-control overlay, so the hash uses the
    // standard /overlay=koppen segment; /climate=1 stays as an alias.
    expect(appJs).toMatch(/koppen/);
    expect(appJs).toMatch(/res\.climate\s*=/);
  });

  test("legend styles exist", () => {
    expect(stylesCss).toMatch(/\.leaflet-control-layers-climate\s*\{/);
    expect(stylesCss).toMatch(/\.climate-legend-grid\s*\{/);
    expect(stylesCss).toMatch(/\.climate-legend-chip\s*\{/);
    expect(stylesCss).toMatch(/\.climate-swatch\s*\{/);
    expect(stylesCss).toMatch(/\.climate-probe\s*\{/);
  });
});

describe("climate layer — built assets", () => {
  test("classes.json exists and lists the Koppen classes", () => {
    const p = join(DATA, "classes.json");
    expect(existsSync(p)).toBe(true);
    const meta = JSON.parse(readFileSync(p, "utf8"));
    expect(meta.classes.length).toBeGreaterThanOrEqual(29);
    expect(meta.classes.map((c) => c.code)).toContain("BWh");
    expect(meta.classes.map((c) => c.code)).toContain("Af");
    for (const c of meta.classes) {
      expect(c.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(typeof c.description).toBe("string");
    }
    expect(meta.grid.width).toBeGreaterThan(0);
    expect(meta.grid.height).toBeGreaterThan(0);
  });

  test("lookup grid PNG exists and is a plausible size", () => {
    const p = join(DATA, "grid.png");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(1000);
  });

  test("tile pyramid exists for zoom levels 0-7", () => {
    // z7 is 1223 m/px at the equator, within 1.3x of Beck et al.'s 928 m
    // source — the level at which the published data actually resolves.
    // 32768/128 = 256, so those tiles slice the master raster 1:1 with
    // no resampling.
    for (const z of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const dir = join(DATA, "tiles", String(z));
      expect(existsSync(dir)).toBe(true);
    }
    expect(existsSync(join(DATA, "tiles", "0", "0", "0.png"))).toBe(true);
    expect(existsSync(join(DATA, "tiles", "2", "1", "1.png"))).toBe(true);
  });
});
