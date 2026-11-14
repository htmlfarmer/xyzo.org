// wave-layer.bun.test.js — wave height & power overlay.
//
// Two grids (height cm, period ds) fetched once by worker/wavemap.py;
// power is DERIVED client-side from the same constants the worker
// publishes — the tests pin the two sides against each other.

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const wJs = readFileSync(join(ROOT, "wave-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const workerPy = readFileSync(join(ROOT, "..", "worker", "wavemap.py"), "utf8");

describe("wave-layer module", () => {
  test("exposes WaveLayer with the layers-control surface", () => {
    expect(wJs).toMatch(/window\.WaveLayer\s*=/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity", "blocksClick", "setProperty"]) {
      expect(wJs, `${fn} missing`).toMatch(new RegExp(`\\b${fn}\\b`));
    }
    expect(wJs).toMatch(/LAYER_NAME:\s*"🌊 Wave height & power"/);
  });

  test("registered in WEATHER_OVERLAYS, initialized, blocks click-to-submit", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.WaveLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.WaveLayer\.init\(map\)/);
    expect(wJs).toMatch(/function blocksClick\(\)/);
    expect(appJs).toMatch(/window\.WaveLayer\.blocksClick\(\)/);
  });

  test("loads before app.js and is stamped", () => {
    const at = indexHtml.indexOf("wave-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(bump).toMatch(/wave-layer\.js/);
  });

  test("GridLayer instance provides setOpacity (L.GridLayer lacks it)", () => {
    // OverlayOpacity calls setOpacity on the WEATHER_OVERLAYS entry —
    // a bare GridLayer has no such method (the RiverLayer crash pattern).
    expect(wJs).toMatch(/state\.tileLayer\.setOpacity\s*=/);
    expect(wJs).toMatch(/state\.tileLayer\.getOpacity\s*=/);
  });

  test("power constants match the worker on both sides", () => {
    // P = 0.49 · Hs² · (0.9 · Tp) — worker and browser must agree
    // or the probe's kW/m will drift from the published formula.
    expect(wJs).toMatch(/POWER_HS_COEF = 0\.49/);
    expect(wJs).toMatch(/POWER_TE_OF_TP = 0\.9/);
    expect(workerPy).toMatch(/POWER_Hs_COEF = 0\.49/);
    expect(workerPy).toMatch(/POWER_TE_OF_TP = 0\.9/);
    expect(wJs).toMatch(/0\.441/);
  });

  test("grids are the native 0.25° GFS-wave grid (1440×721)", () => {
    expect(workerPy).toMatch(/COLS, ROWS = 1440, 721/);
    expect(workerPy).toMatch(/STEP = 0\.25/);
    // true90N..90S — not the secret 52.5N..15S "global" 0p16 file
    expect(workerPy).toMatch(/global\.0p25/);
  });

  test("source is NOMADS gfswave under the GFS tree (not /com/wave/, not Open-Meteo)", () => {
    // /com/wave/ is ACL-403; the same products live under com/gfs/.../wave/.
    expect(workerPy).toMatch(/com\/gfs\/prod/);
    expect(workerPy).toMatch(/wave\/gridded\/gfswave/);
    expect(workerPy).not.toMatch(/marine-api\.open-meteo/);
  });

  test("run_time no-op: a timer tick that lands early does nothing", () => {
    expect(workerPy).toMatch(/already published — nothing to do/);
    expect(workerPy).toMatch(/no newer cycle/);
  });

  test("refuses to publish when verification fails", () => {
    expect(workerPy).toMatch(/refusing to publish/);
  });

  test("verify() catches axis flips: land null, ocean populated", () => {
    expect(workerPy).toMatch(/Sahara \(land\)/);
    expect(workerPy).toMatch(/Mid-Atlantic/);
    expect(workerPy).toMatch(/Southern Ocean/);
    expect(workerPy).toMatch(/0\.45 <= frac <= 0\.85/);
  });

  test("GRIB decode forces north-first and rolls lon 0..360 → -180..180", () => {
    // The frontend samples ix = (lon+180)/lon_step; an un-rolled grid
    // puts the Sahara probe on the Indian Ocean and fails verify.
    expect(workerPy).toMatch(/np\.roll/);
    expect(workerPy).toMatch(/north_first/);
  });

  test("m→cm and s→ds scaling is100× and 10×, not 0.01/0.1", () => {
    // The inverse-scale bug published Hs=0 everywhere (1.81 m × 0.01
    // rounds to 0 cm) — pinned so it cannot come back.
    expect(workerPy).toMatch(/to_publish\(swh, 100\.0\)/);
    expect(workerPy).toMatch(/to_publish\(perpw, 10\.0\)/);
    expect(workerPy).not.toMatch(/to_publish\(swh, 0\.01\)/);
  });

  test("property switcher (Height | Power) persists", () => {
    expect(wJs).toMatch(/setProperty/);
    expect(wJs).toMatch(/xyzo\.waveProp/);
    expect(wJs).toMatch(/data-prop="height"/);
    expect(wJs).toMatch(/data-prop="power"/);
  });

  test("probe shows m, s AND kW/m together", () => {
    expect(wJs).toMatch(/sampleCell/);
    expect(wJs).toMatch(/kW\/m/);
    expect(wJs).toMatch(/toFixed\(1\)/);
  });

  test("bilinear sampling drops nodata corners (no coastline fringe)", () => {
    expect(wJs).toMatch(/sampleBilinear/);
    expect(wJs).toMatch(/if \(h === nd\) continue/);
    expect(wJs).toMatch(/wsum < 0\.5/);   // majority-land cell → null
  });

  test("pane sits above the relief (345), below climate (350)", () => {
    expect(wJs).toMatch(/PANE_Z = 346/);
  });

  test("hash slugs cover the obvious names", () => {
    for (const slug of ["waves", "wave", "wave-height", "wave-power"]) {
      expect(appJs, `slug ${slug}`).toMatch(
        new RegExp(`"${slug}": "🌊 Wave height & power"`)
      );
    }
  });

  test("attribution names NOAA/NCEP (public domain)", () => {
    expect(wJs).toMatch(/NOAA NCEP GFS Wave/);
    expect(workerPy).toMatch(/public domain/);
    expect(workerPy).toMatch(/NOAA NCEP/);
  });
});

describe("wave data assets", () => {
  const metaPath = join(ROOT, "data", "wave", "meta.json");
  test("when published: grids match meta geometry and formula is present", () => {
    if (!existsSync(metaPath)) return; // bake may still be running
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.grid.cols).toBe(1440);
    expect(meta.grid.rows).toBe(721);
    expect(meta.grid.nodata).toBe(-32768);
    expect(meta.power_formula).toMatch(/0\.441/);
    expect(meta.ramps.height.length).toBeGreaterThan(4);
    expect(meta.ramps.power.length).toBeGreaterThan(4);
    expect(meta.attribution).toMatch(/NOAA|NCEP/);
    expect(meta.run_time).toMatch(/^\d{10}$/);
    const h = readFileSync(join(ROOT, "data", "wave", "height.bin"));
    const p = readFileSync(join(ROOT, "data", "wave", "period.bin"));
    expect(h.length).toBe(1440 * 721 * 2);
    expect(p.length).toBe(1440 * 721 * 2);
  });
});

describe("wave layer — HUD sampling", () => {
  test("sampleAt reports Hs, Tp and derived power from sampleCell", () => {
    expect(wJs).toMatch(/function sampleAt\(latlng\)/);
    // Same grids as the probe — metres, seconds, kW/m.
    expect(wJs).toMatch(/sampleCell\(Number\(latlng\.lat\),\s*Number\(latlng\.lng\)\)/);
    expect(wJs).toMatch(/cell\.hs\.toFixed\(1\)/);
    expect(wJs).toMatch(/powerOf\(cell\.hs,\s*cell\.tp\)/);
  });

  test("sampleAt guards null cells and a null height", () => {
    expect(wJs).toMatch(/if \(!cell \|\| cell\.hs == null\) return null;/);
    expect(wJs).toMatch(/if \(!state\.enabled \|\| !latlng\) return null;/);
  });

  test("sampleAt is exported on the public API", () => {
    expect(wJs).toMatch(/^\s+sampleAt,$/m);
  });
});
