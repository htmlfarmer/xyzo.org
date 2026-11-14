/**
 * Sea Surface Salinity overlay — NOAA GFDL CM2.6 via NOAA SOS.
 *
 * A near-clone of the Human Transportation layer (same wrapping-GridLayer
 * pattern, same one-time frozen asset), plus one extra contract: the
 * land mask is a PNG transparency index, and a rebuild that loses it
 * would ship an opaque magenta continent.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const js = readFileSync(join(root, "salinity-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("salinity-layer module", () => {
  test("exposes SalinityLayer with a stable name", () => {
    expect(js).toMatch(/window\.SalinityLayer\s*=/);
    expect(js).toMatch(/LAYER_NAME:\s*"🧂 Sea surface salinity"/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity"]) {
      expect(js).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
    // The attribution names the data source — data-licences pins it.
    expect(js).toMatch(/NOAA GFDL/);
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.SalinityLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.SalinityLayer\.init\(map\)/);
  });

  test("loads before app.js, exactly once, and is stamped", () => {
    const at = indexHtml.indexOf('src="salinity-layer.js');
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    // Exactly ONE script tag — a duplicate re-runs the IIFE and swaps
    // the live state object underneath app.js mid-boot.
    const tags = indexHtml.match(/src="salinity-layer\.js[^"]*"/g) || [];
    expect(tags.length).toBe(1);
    expect(bump).toMatch(/salinity-layer\.js/);
  });

  test("paints through a wrapping GridLayer, not a one-world imageOverlay", () => {
    expect(js).toMatch(/L\.GridLayer\.extend/);
    expect(js).not.toMatch(/L\.imageOverlay\(/);
  });

  test("resolves each tile row through the inverse Mercator", () => {
    // The source is equirectangular but tiles are Mercator; sampling in
    // latitude-space would slide the salinity bands off their latitudes.
    expect(js).toMatch(/function tileLat\(v\)/);
    expect(js).toMatch(/tileLat\(v\)/);
  });

  test("wraps a tile that straddles the antimeridian", () => {
    expect(js).toMatch(/Straddles \(or is beyond\) the world edge/);
    expect(js).toMatch(/drawImage\(img, 0, srcRow/);
  });

  test("calls done() asynchronously", () => {
    expect(js).toMatch(/setTimeout\(\(\)\s*=>\s*done\(null,\s*tile\),\s*0\)/);
  });

  test("the GridLayer provides setOpacity for the sliders", () => {
    expect(js).toMatch(/setOpacity\(value\)/);
    expect(js).toMatch(/getOpacity\(\)/);
  });

  test("registers overlayadd BEFORE the localStorage restore", () => {
    const listenerAt = js.indexOf('map.on("overlayadd"');
    const restoreAt = js.indexOf("storageGet(STORE_KEY");
    expect(listenerAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(listenerAt).toBeLessThan(restoreAt);
    expect(js).toMatch(/never sees the restore/);
  });

  test("never blocks map clicks — it is a picture, not a probe", () => {
    expect(js).toMatch(/blocksClick:\s*\(\)\s*=>\s*false/);
  });

  test("uses XLog, never raw console", () => {
    expect(js).toMatch(/window\.XLog/);
    expect(js).not.toMatch(/console\.(log|warn|error|debug)/);
  });

  test("sets the pane between climate (350) and soil (352)", () => {
    expect(js).toMatch(/const PANE_Z = 351/);
  });

  test("warms the image at idle so the first toggle is instant", () => {
    expect(js).toMatch(/requestIdleCallback\(warm/);
  });

  test("redraws tiles painted before the image landed", () => {
    expect(js).toMatch(/state\.overlay\.redraw\(\)/);
  });
});

describe("salinity data asset", () => {
  const img = join(root, "data", "salinity", "salinity.png");

  test("the equirectangular PNG is published and reasonably sized", () => {
    if (!existsSync(img)) return;
    const bytes = statSync(img).size;
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(4_000_000);
    const head = readFileSync(img).subarray(0, 8);
    expect(Array.from(head)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("image is 2:1 — equirectangular, not sphere-projected", () => {
    if (!existsSync(img)) return;
    const buf = readFileSync(img);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    expect(w / h).toBeCloseTo(2.0, 2);
  });

  test("carries a tRNS chunk — land is transparent, not black or magenta", () => {
    // The land mask is a palette transparency index. A rebuild that
    // forgets `transparency=` ships an opaque magenta continent (the
    // sentinel colour survives quantization); a rebuild that forgets
    // the sentinel ships solid black land. Both die here.
    if (!existsSync(img)) return;
    const buf = readFileSync(img);
    let off = 8; // skip PNG signature
    let sawTrns = false;
    let sawPlte = false;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      if (type === "tRNS") sawTrns = true;
      if (type === "PLTE") sawPlte = true;
      if (type === "IEND") break;
      off += 12 + len;
      if (len < 0 || off > buf.length) break;
    }
    expect(sawPlte).toBe(true);   // palette mode — the 652 KB size trade
    expect(sawTrns).toBe(true);   // the land mask itself
  });
});
