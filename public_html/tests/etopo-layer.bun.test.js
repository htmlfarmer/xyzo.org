// etopo-layer.bun.test.js — topography/bathymetry relief overlay.
//
// ETOPO 2022 v1 (60 arc-second, the ETOPO1 successor) baked to
// hypsometric tiles + hillshade, with a metre/feet probe.

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const eJs = readFileSync(join(ROOT, "etopo-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const buildPy = readFileSync(join(ROOT, "..", "scripts", "etopo_build.py"), "utf8");

describe("etopo-layer module", () => {
  test("exposes EtopoLayer with the layers-control surface", () => {
    expect(eJs).toMatch(/window\.EtopoLayer\s*=/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity", "blocksClick"]) {
      expect(eJs, `${fn} missing`).toMatch(new RegExp(`\\b${fn}\\b`));
    }
    expect(eJs).toMatch(/LAYER_NAME:\s*"⛰️ Relief \(ETOPO\)"/);
  });

  test("registered in WEATHER_OVERLAYS, initialized, blocks click-to-submit", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.EtopoLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.EtopoLayer\.init\(map\)/);
    expect(eJs).toMatch(/function blocksClick\(\)/);
    expect(appJs).toMatch(/window\.EtopoLayer\.blocksClick\(\)/);
  });

  test("loads before app.js and is stamped", () => {
    const at = indexHtml.indexOf("etopo-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(bump).toMatch(/etopo-layer\.js/);
  });

  test("carries a BUILD token on its tile URLs", () => {
    expect(eJs).toMatch(/const BUILD = "\d+"/);
    expect(eJs).toMatch(/tiles\/\{z\}\/\{x\}\/\{y\}\.png\?v=/);
  });

  test("maxNativeZoom matches the 1-arc-minute source (z7 ≈ 1.2 km/px)", () => {
    expect(eJs).toMatch(/const MAX_NATIVE_ZOOM = 7/);
  });

  test("probe shows BOTH metres and feet", () => {
    expect(eJs).toMatch(/mToFt/);
    expect(eJs).toMatch(/fmtM/);
    expect(eJs).toMatch(/fmtFt/);
    expect(eJs).toMatch(/grid\.bin/);
  });

  test("pane sits above the base tiles and below the climate wash", () => {
    expect(eJs).toMatch(/PANE_Z = 345/);
  });

  test("hash slugs cover the obvious names", () => {
    for (const slug of ["etopo", "relief", "topography", "bathymetry"]) {
      expect(appJs, `slug ${slug} missing`).toMatch(
        new RegExp(`"${slug}": "⛰️ Relief \\(ETOPO\\)"`)
      );
    }
  });
});

describe("etopo builder invariants", () => {
  test("palette fits a byte: 31 bins x 8 shade steps", () => {
    expect(buildPy).toMatch(/SHADE_STEPS = 8/);
    // 32 bin edges -> 31 bins; 31*8 + 1 = 249 <= 256
    const edges = buildPy.match(/BIN_EDGES = \[([\s\S]*?)\]/);
    expect(edges).toBeTruthy();
    const count = (edges[1].match(/-?\d+/g) || []).length;
    expect(count).toBe(32);
    expect(31 * 8 + 1).toBeLessThanOrEqual(256);
  });

  test("hillshade uses arctan(hypot(...)), not raw hypot", () => {
    // Using the gradient magnitude as a "slope angle" collapses the
    // shade to 0 on steep terrain — pinned so it cannot come back.
    expect(buildPy).toMatch(/slope = np\.arctan\(np\.hypot/);
    expect(buildPy).not.toMatch(/slope = np\.hypot\(dzdx, dzdy\)\s*$/m);
  });

  test("source is ETOPO2022 60s surface, downloaded once to ~/.xyzo", () => {
    expect(buildPy).toMatch(/ETOPO_2022_v1_60s_surface\.tif/);
    expect(buildPy).toMatch(/465_969_062/);
    expect(buildPy).toMatch(/\.xyzo.*etopo/);
    // Resumable + content-length guarded.
    expect(buildPy).toMatch(/Range/);
    expect(buildPy).toMatch(/download incomplete/);
  });

  test("verify() probes catch axis flips at the model's own resolution", () => {
    // Everest at 60" is ~6,700 m and Challenger Deep ~-10,000 m — the
    // bounds must match what the model produces, not survey extremes.
    expect(buildPy).toMatch(/Challenger Deep/);
    expect(buildPy).toMatch(/\(27\.998, 86\.925, 6000, 9000/);
    expect(buildPy).toMatch(/\(11\.37, 142\.59, -10500, -9500/);
  });

  test("tiles share ONE fixed palette so seams match", () => {
    // A per-tile adaptive palette would make a gradient step differently
    // across tiles — visible seams. Pin the global-palette decision.
    expect(buildPy).toMatch(/build_palette/);
    expect(buildPy).toMatch(/img\.putpalette\(pal\)/);
    expect(buildPy).toMatch(/ONE FIXED palette|one FIXED palette/);
  });

  test("probe grid is 0.1° Int16 metres", () => {
    expect(buildPy).toMatch(/GRID_DEG = 0\.1/);
    expect(buildPy).toMatch(/astype\("<i2"\)/);
  });
});

describe("etopo data assets", () => {
  test("when published: meta has a ramp and grid geometry", () => {
    const metaPath = join(ROOT, "data", "etopo", "meta.json");
    if (!existsSync(metaPath)) return; // build may still be running
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.key).toBe("etopo");
    expect(Array.isArray(meta.ramp)).toBe(true);
    expect(meta.ramp.length).toBeGreaterThan(20);
    expect(meta.ramp[0].rgb).toHaveLength(3);
    expect(meta.grid.width).toBe(3600);
    expect(meta.grid.height).toBe(1800);
    expect(meta.attribution).toMatch(/NOAA/i);
  });

  test("when published: tiles exist at z0 and grid.bin is the right size", () => {
    if (!existsSync(join(ROOT, "data", "etopo", "meta.json"))) return;
    expect(existsSync(join(ROOT, "data", "etopo", "tiles", "0", "0", "0.png"))).toBe(true);
    const stat = require("fs").statSync(join(ROOT, "data", "etopo", "grid.bin"));
    expect(stat.size).toBe(3600 * 1800 * 2);
  });
});

describe("etopo layer — HUD sampling", () => {
  test("sampleAt reports metres and feet from the same grid as the probe", () => {
    expect(eJs).toMatch(/function sampleAt\(latlng\)/);
    // The probe and the HUD must read the same buffer — one source of
    // truth, or the number and the colour eventually disagree.
    expect(eJs).toMatch(/sampleM\(Number\(latlng\.lat\),\s*Number\(latlng\.lng\)\)/);
    expect(eJs).toMatch(/fmtM\(m\).*fmtFt\(m\)/s);
  });

  test("sampleAt is gated on enabled", () => {
    expect(eJs).toMatch(/function sampleAt\(latlng\) \{\s*\n\s*if \(!state\.enabled/);
  });

  test("sampleAt is exported on the public API", () => {
    expect(eJs).toMatch(/^\s+sampleAt,$/m);
  });
});
