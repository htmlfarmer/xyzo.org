/**
 * Cropland / land-cover overlays — ESA WorldCover.
 *
 * Two layers-control entries share one module and one probe grid.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const cropJs = readFileSync(join(root, "cropland-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("cropland-layer module", () => {
  test("exposes CroplandLayer with both mode names", () => {
    expect(cropJs).toMatch(/window\.CroplandLayer\s*=/);
    expect(cropJs).toMatch(/LAYER_NAME:\s*"🌾 Cropland \(ESA\)"/);
    expect(cropJs).toMatch(/LANDCOVER_LAYER_NAME:\s*"🗺️ Land Cover \(ESA\)"/);
  });

  test("registers both modes in WEATHER_OVERLAYS", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.CroplandLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.CroplandLayer\.LANDCOVER_LAYER_NAME/);
    expect(appJs).toMatch(/window\.CroplandLayer\.init\(map\)/);
  });

  test("tiles carry a BUILD token and both modes have paths", () => {
    expect(cropJs).toMatch(/const BUILD = "\d+"/);
    expect(cropJs).toMatch(/BASE \+ "\/" \+ mode \+ "\/tiles\//);
    // The two mode directory names are the ones cropland_build.py writes.
    expect(cropJs).toMatch(/cropland:/);
    expect(cropJs).toMatch(/landcover:/);
  });

  test("probe reads share + class grids and blocks click-to-submit", () => {
    expect(cropJs).toMatch(/grid\.bin/);
    expect(cropJs).toMatch(/class\.bin/);
    expect(cropJs).toMatch(/blocksClick/);
    expect(appJs).toMatch(/window\.CroplandLayer\.blocksClick\(\)/);
  });

  test("loads before app.js and is stamped", () => {
    const cropAt = indexHtml.indexOf("cropland-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(cropAt).toBeGreaterThan(-1);
    expect(cropAt).toBeLessThan(appAt);
    expect(bump).toMatch(/cropland-layer\.js/);
  });

  test("water stays out of the land-cover key", () => {
    // ESA class 80 is drawn transparent (the basemap already has water).
    expect(cropJs).toMatch(/c\.code === 80/);
  });
});

describe("cropland data assets", () => {
  test("meta.json describes the ESA class table when present", () => {
    const metaPath = join(root, "data", "cropland", "meta.json");
    if (!existsSync(metaPath)) return;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(Array.isArray(meta.classes)).toBe(true);
    expect(meta.classes.some((c) => c.code === 40 && /Cropland/i.test(c.title))).toBe(true);
    expect(meta.attribution).toMatch(/ESA/i);
    expect(meta.grid.grids.share).toBe("grid.bin");
  });
});

describe("cropland layer — HUD sampling", () => {
  test("sampleAt reads the same share/class grids as the probe", () => {
    expect(cropJs).toMatch(/function sampleAt\(latlng\)/);
    expect(cropJs).toMatch(/gridSample\(state\.share/);
    expect(cropJs).toMatch(/gridSample\(state\.cls/);
  });

  test("sampleAt is on when EITHER mode is enabled", () => {
    // A landcover-only view must still read out in the HUD.
    expect(cropJs).toMatch(/isEnabled: \(\) => state\.enabled\.cropland \|\| state\.enabled\.landcover/);
    expect(cropJs).toMatch(/const any = state\.enabled\.cropland \|\| state\.enabled\.landcover/);
  });

  test("sampleAt is exported on the public API", () => {
    expect(cropJs).toMatch(/^\s+sampleAt,$/m);
  });
});
