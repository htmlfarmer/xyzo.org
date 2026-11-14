/**
 * Soil overlay — SoilGrids wash + property switcher.
 *
 * Pins the contract app.js relies on: the module exists before app.js
 * registers it, the layers-control name is stable, and the probe path
 * is present so a soil tap does not fall through to click-to-submit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const soilJs = readFileSync(join(root, "soil-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("soil-layer module", () => {
  test("exposes SoilLayer on window before app.js reads it", () => {
    expect(soilJs).toMatch(/window\.SoilLayer\s*=/);
    // The public surface app.js touches.
    for (const fn of ["init", "getTileLayer", "setEnabled", "blocksClick", "setOpacity"]) {
      expect(soilJs).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("uses one layers-control entry with a property switcher", () => {
    // The name dropped "(SoilGrids)" when the USDA-orders chip made it
    // false: nine properties are ISRIC's, one is OpenGeoHub's. The slug
    // stays soil-soilgrids (REVERSE_LAYER_SLUGS) so links keep working.
    expect(soilJs).toMatch(/LAYER_NAME:\s*"🟫 Soil"/);
    expect(soilJs).not.toMatch(/LAYER_NAME:\s*"🟫 Soil \(/);
    // Ten layers: the two CLASSIFICATION maps first (WRB groups, then
    // the USDA orders), then USDA texture, then the seven continuous
    // properties.
    expect(soilJs).toMatch(/PROP_ORDER\s*=\s*\["wrb",\s*"usda",\s*"texture",\s*"clay",\s*"sand",\s*"silt",\s*"phh2o",\s*"soc",\s*"bdod",\s*"cec"\]/);
    expect(soilJs).toMatch(/soil-prop-switch/);
    expect(soilJs).toMatch(/data-prop=/);
  });

  test("the corner credit follows the ACTIVE property's publisher", () => {
    // CC BY requires the right credit in the most visible place on the
    // page: ISRIC for nine properties, OpenGeoHub for the USDA orders.
    expect(soilJs).toMatch(/const PROP_ATTRIBUTION = \{/);
    expect(soilJs).toMatch(/usda: "OpenLandMap-soildb/);
    expect(soilJs).toMatch(/attribution: attributionFor\(key\)/);
    // …and the exported file names the source that was on screen.
    expect(soilJs).toMatch(/get attribution\(\)/);
    expect(soilJs).toMatch(/get source\(\)/);
  });

  test("tiles carry a BUILD token (PNGs are immutable for a year)", () => {
    expect(soilJs).toMatch(/const BUILD = "\d+"/);
    expect(soilJs).toMatch(/tiles\/\{z\}\/\{x\}\/\{y\}\.png\?v=/);
  });

  test("probe reads the same grid the tiles were classified from", () => {
    expect(soilJs).toMatch(/grid\.bin/);
    expect(soilJs).toMatch(/sampleRaw/);
    expect(soilJs).toMatch(/blocksClick/);
  });

  test("is registered in WEATHER_OVERLAYS and initialized after the map", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.SoilLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.SoilLayer\.init\(map\)/);
  });

  test("probe mode blocks click-to-submit", () => {
    expect(appJs).toMatch(/window\.SoilLayer\.blocksClick\(\)/);
  });

  test("loads before app.js and is stamped by bump_frontend.sh", () => {
    const soilAt = indexHtml.indexOf("soil-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(soilAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);
    expect(soilAt).toBeLessThan(appAt);
    expect(bump).toMatch(/soil-layer\.js/);
  });

  test("refuses to sample off the end of a short grid", () => {
    // The length check is what stops a half-downloaded grid.bin from
    // reading undefined and formatting "NaN %" into the probe.
    expect(soilJs).toMatch(/arr\.length !== expect/);
  });
});

describe("switching property does not break the layer's own state", () => {
  // Found LIVE while shipping the USDA chip: the old setProperty removed
  // the tile layer and added a freshly BUILT one. The layers control is
  // constructed with ONE object per overlay, so the removal fired
  // `overlayremove` — which the module's own listener turned into
  // state.enabled = false — while the replacement fired NO `overlayadd`
  // (the control has never seen it). Measured on the unchanged wrb→clay
  // switch: no meta/grid fetch, legend stuck on WRB, EVERY chip
  // disabled, and localStorage["xyzo.soilLayer"] written to "0" so the
  // next visit lost the layer entirely. The fix swaps the URL on the
  // SAME object (setUrl), so no layer event fires at all.
  test("setProperty swaps the URL in place — never remove + rebuild", () => {
    const at = soilJs.indexOf("function setProperty");
    expect(at, "setProperty must exist").toBeGreaterThan(-1);
    const body = soilJs.slice(at, soilJs.indexOf("\n  }", at));
    expect(body, "must swap the URL on the existing layer").toMatch(/setUrl\(tilesUrl\(key\)\)/);
    expect(body, "must NOT remove the layer object").not.toMatch(/removeLayer/);
    expect(body, "must NOT build a replacement layer").not.toMatch(/buildLayer\(/);
    // and the corner credit has to be moved by hand, because setUrl
    // fires no layeradd/layerremove for the attribution control
    expect(body, "must re-credit through the attribution control").toMatch(/removeAttribution/);
    expect(body, "must re-credit through the attribution control").toMatch(/addAttribution/);
  });

  test("the overlay listeners still exist for genuine on/off toggles", () => {
    // setProperty must not fire them — but a real checkbox toggle must,
    // or the layer could never be switched off.
    expect(soilJs).toMatch(/map\.on\("overlayadd"/);
    expect(soilJs).toMatch(/map\.on\("overlayremove"/);
  });
});

describe("soil data assets", () => {
  test("usda-orders pyramid was published (12 orders, OpenGeoHub credit)", () => {
    const metaPath = join(root, "data", "soil", "usda", "meta.json");
    if (!existsSync(metaPath)) return; // build may still be running
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.key).toBe("usda");
    // The 12 orders of the USDA Soil Taxonomy, 1..12, each a distinct
    // colour — the client looks the grid value up by `index`.
    expect(meta.classes.length).toBe(12);
    expect(meta.classes.map((c) => c.index)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
    expect(new Set(meta.classes.map((c) => c.color)).size).toBe(12);
    expect(meta.classes[0].label).toBe("Alfisols");
    expect(meta.classes[11].label).toBe("Vertisols");
    // Licence obligations: this is a DIFFERENT publisher from the other
    // nine properties, so the credit must name it.
    expect(meta.attribution).toMatch(/OpenLandMap/);
    expect(meta.license).toMatch(/CC BY/);
    expect(meta.grid.width).toBe(3600);
    expect(meta.grid.nodata).toBe(0);
  });

  test("clay pyramid was published (meta + tiles)", () => {
    const metaPath = join(root, "data", "soil", "clay", "meta.json");
    if (!existsSync(metaPath)) return; // build may still be running
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.key).toBe("clay");
    expect(Array.isArray(meta.classes)).toBe(true);
    expect(meta.classes.length).toBeGreaterThan(3);
    expect(meta.grid.width).toBe(3600);
    expect(meta.grid.height).toBe(1800);
    expect(meta.attribution).toMatch(/ISRIC/i);
  });
});
