// temp-layer.bun.test.js — the "🌡️ Temperature (GFS)" overlay.
//
// A filled colour field of the GFS 2 m analysis, rendered client-side
// from two static files, with a legend and a probe that read in BOTH
// °F and °C.
//
// The traps this file guards:
//   • NO PNG tiles. Every *.png under public_html is served
//     `immutable` for a year, so a regenerated pyramid would be
//     invisible behind a stale version token (the Köppen incident of
//     2026-10-22). The tiles are painted in the browser from grid.bin
//     + meta.json instead, which are NOT immutable and always
//     revalidate.
//   • Tile rows must be sampled in MERCATOR y, or latitude bands drift
//     against the basemap — these are Web Mercator tiles.
//   • The probe and the painted colour must come from the same grid,
//     so what you read IS the colour you are looking at.
//   • Both units, everywhere: legend ticks and probe.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const tempJs = readFileSync(join(ROOT, "temp-layer.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const workerPy = readFileSync(join(ROOT, "..", "worker", "tempmap.py"), "utf8");
const isobarsPy = readFileSync(join(ROOT, "..", "worker", "isobars.py"), "utf8");
const bumpSh = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("temp layer — module wiring", () => {
  test("loads before app.js and exposes the API app.js needs", () => {
    const tempIdx = indexHtml.indexOf("temp-layer.js");
    const appIdx = indexHtml.indexOf("app.js?");
    expect(tempIdx).toBeGreaterThan(-1);
    expect(appIdx).toBeGreaterThan(-1);
    expect(tempIdx).toBeLessThan(appIdx);
    expect(tempJs).toMatch(/window\.TempLayer\s*=/);
    expect(tempJs).toMatch(/getTileLayer/);
    expect(tempJs).toMatch(/function init\(map\)/);
  });

  test("is registered in WEATHER_OVERLAYS so it gets the dropdown checkbox", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\["🌡️ Temperature \(GFS\)"\] = tempLayer/);
    expect(appJs).toMatch(/window\.TempLayer\.init\(map\)/);
  });

  test("is in the asset list that gets stamped", () => {
    expect(bumpSh).toMatch(/temp-layer\.js/);
    expect(indexHtml).toMatch(/temp-layer\.js\?v=\d+/);
  });

  test("round-trips through the URL hash", () => {
    expect(appJs).toMatch(/"temperature": "🌡️ Temperature \(GFS\)"|"temperature": TEMP_LAYER_NAME/);
    expect(appJs).toMatch(/"🌡️ Temperature \(GFS\)": "temperature"/);
  });
});

describe("temp layer — data source and caching", () => {
  test("reads the grid, never a tile pyramid", () => {
    // *.png is immutable for a year — see the header of temp-layer.js.
    expect(tempJs).toMatch(/data\/temp\/grid\.bin/);
    expect(tempJs).toMatch(/data\/temp\/meta\.json/);
    expect(tempJs).not.toMatch(/\.png\?|tiles\/\{z\}/);
    expect(existsSync(join(ROOT, "data", "temp", "grid.bin"))).toBe(true);
    expect(existsSync(join(ROOT, "data", "temp", "meta.json"))).toBe(true);
  });

  test("hands the field to a custom GridLayer painted from the in-memory grid", () => {
    expect(tempJs).toMatch(/L\.GridLayer\.extend/);
    expect(tempJs).toMatch(/createTile/);
    expect(tempJs).toMatch(/putImageData/);
    // A bare GridLayer has no setOpacity, and the layers dropdown calls
    // it for every overlay.
    expect(tempJs).toMatch(/setOpacity\(value\)/);
    // Repaint once the grid arrives: early tiles are painted blank.
    expect(tempJs).toMatch(/state\.overlay\.redraw\(\)/);
  });

  test("the tile rows are linear in Mercator, not in latitude", () => {
    // A Web Mercator tile's y axis is Mercator; sampling in latitude
    // would shift the bands against the basemap.
    expect(tempJs).toMatch(/function tileLat\(/);
    expect(tempJs).toMatch(/Math\.atan\(Math\.exp\(Math\.PI \* \(1 - 2 \* v\)\)\)/);
  });

  test("the layer repeats across the antimeridian", () => {
    // An imageOverlay spans one copy of the world and leaves a gap when
    // you pan past +/-180; a GridLayer tiles, so it never does. The
    // longitude wrap below is what makes a tile at x=0 and one at x=n
    // sample the same column.
    // Longitude wraps in the sampler regardless of the tile's x index.
    expect(tempJs).toMatch(/\(\(col % g\.cols\) \+ g\.cols\) % g\.cols/);
  });

  test("the worker fetches the 0.25° product, like the isobars", () => {
    // The temperature moved from 1° to 0.25° on 2026-11-04, so that it
    // matches the isobars — which have always been 0.25° — and because
    // the overlay is a COLOUR FIELD: its resolution is what the reader
    // sees. Measured, the same GFS cycle at 1° and at 0.25° agrees to a
    // median of 0.0 °C and is at worst 2.4 °C out.
    //
    // The globe keeps the 1° copy (it bakes the field into a picture
    // and shows no numbers), so the worker publishes BOTH.
    expect(workerPy).toMatch(/suffixes=\("0p25",\)/);
    expect(workerPy).toMatch(/TMP/);
    expect(workerPy).toMatch(/2_m_above_ground/);
    expect(workerPy).toMatch(/grid-1deg\.bin/);
  });

  test("the worker verifies the field before publishing", () => {
    // A decode bug still yields a plausible-looking map, so the checks
    // are relational: equator warmer than poles.
    expect(workerPy).toMatch(/def verify\(/);
    expect(workerPy).toMatch(/equator - poles < 30\.0/);
    expect(workerPy).toMatch(/refusing to publish/);
  });

  test("the shared GFS fetch is reused by both workers", () => {
    expect(isobarsPy).toMatch(/def fetch_grib_field\(/);
    expect(isobarsPy).toMatch(/def decode_field\(/);
  });
});

describe("temp layer — painting cost", () => {
  test("the field is baked once and tiles are a blit", () => {
    // Per-pixel sampling in createTile cost ~23 ms a tile: half a second
    // for a screenful and two seconds for a full redraw. Bake the field
    // into one canvas and every tile becomes a drawImage.
    expect(tempJs).toMatch(/function buildBaked\(/);
    expect(tempJs).toMatch(/function blitTile\(/);
    expect(tempJs).toMatch(/ctx\.drawImage\(BAKED\.canvas/);
    expect(tempJs).toMatch(/ensureBaked\(\)/);
    // createTile must not loop over pixels itself.
    const createTile = tempJs.slice(tempJs.indexOf("createTile(coords, done)"));
    expect(createTile.slice(0, 900)).toMatch(/paintTile\(tile, coords\)/);
    expect(createTile.slice(0, 900)).toMatch(/setTimeout\(\(\) => done\(null, tile\), 0\)/);
  });

  test("the bake is sized to the data, not to the screen", () => {
    // 1024 is ~2.8 px per degree against a 1° grid — already finer than
    // the source. The bake is quadratic in the size (68 ms at 1024,
    // 260 ms at 2048) for pixels that carry no extra information.
    expect(tempJs).toMatch(/const BAKED_W = 1024;/);
  });

  test("the baked rows are linear in Mercator, like the tiles", () => {
    expect(tempJs).toMatch(/tileLat\(\(py \+ 0\.5\) \/ H\)/);
  });

  test("a tile that straddles the antimeridian is wrapped, not clipped", () => {
    expect(tempJs).toMatch(/Straddles \(or is beyond\) the world edge/);
    expect(tempJs).toMatch(/ctx\.drawImage\(BAKED\.canvas, 0, sy/);
  });
});

describe("temp layer — both units", () => {
  test("the legend shows °C and °F scales", () => {
    expect(tempJs).toMatch(/temp-ticks-c/);
    expect(tempJs).toMatch(/temp-ticks-f/);
    expect(stylesCss).toMatch(/content: "°C"/);
    expect(stylesCss).toMatch(/content: "°F"/);
    // The conversion is derived, never duplicated.
    expect(tempJs).toMatch(/c \* 9 \/ 5 \+ 32/);
  });

  test("the probe reports both units at once", () => {
    expect(tempJs).toMatch(/temp-probe-c/);
    expect(tempJs).toMatch(/temp-probe-f/);
    expect(tempJs).toMatch(/fOf\(c\)/);
  });

  test("the same grid drives the colour and the probe", () => {
    // Colouring and sampling both read state.grid, so the reading is
    // the colour under the cursor rather than a second data source.
    expect(tempJs).toMatch(/function sampleC\(/);
    expect(tempJs).toMatch(/function paintTile\(/);
    expect(tempJs).toMatch(/state\.grid\[r \* g\.cols \+ c\]/);
  });
});

describe("temp layer — interaction", () => {
  test("the probe does not steal the map click when it is armed", () => {
    expect(tempJs).toMatch(/blocksClick/);
    expect(appJs).toMatch(/TempLayer\.blocksClick === "function" && window\.TempLayer\.blocksClick\(\)/);
  });

  test("the legend mounts into the layers control, not over the map", () => {
    expect(tempJs).toMatch(/\.leaflet-control-layers-list/);
    expect(tempJs).toMatch(/section\.appendChild\(host\)/);
    expect(stylesCss).toMatch(/\.temp-legend/);
  });

  test("the enabled state persists", () => {
    expect(tempJs).toMatch(/storageSet\(STORE_KEY/);
    expect(tempJs).toMatch(/storageGet\(STORE_KEY/);
  });
});
