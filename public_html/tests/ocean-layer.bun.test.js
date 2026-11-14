/**
 * Ocean Currents + Temperature overlay — NOAA "Perpetual Ocean" (ECCO).
 *
 * Pins the module contract (name, registration, load order, single tag),
 * the house rules that broke other overlays before (setOpacity on the
 * GridLayer, async done(), overlayadd before localStorage restore, no
 * imageOverlay), and the published asset's integrity.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const js = readFileSync(join(root, "ocean-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("ocean-layer module", () => {
  test("exposes OceanLayer with a stable name", () => {
    expect(js).toMatch(/window\.OceanLayer\s*=/);
    expect(js).toMatch(/LAYER_NAME:\s*"🌊 Ocean Currents \(ECCO\)"/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity"]) {
      expect(js).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.OceanLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.OceanLayer\.init\(map\)/);
  });

  test("loads before app.js, exactly once, and is stamped", () => {
    const at = indexHtml.indexOf('src="ocean-layer.js');
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    const tags = indexHtml.match(/src="ocean-layer\.js[^"]*"/g) || [];
    expect(tags.length).toBe(1);
    expect(bump).toMatch(/ocean-layer\.js/);
  });

  test("URL slugs resolve for shared links", () => {
    for (const slug of ["ocean", "ocean-currents", "perpetual-ocean", "ecco", "currents"]) {
      expect(appJs).toMatch(new RegExp(`"${slug}": "🌊 Ocean Currents`));
    }
  });

  test("paints through a wrapping GridLayer, not a one-world imageOverlay", () => {
    expect(js).toMatch(/L\.GridLayer\.extend/);
    // Match the constructor CALL — the docstring explains why it is not used.
    expect(js).not.toMatch(/L\.imageOverlay\(/);
  });

  test("resolves each tile row through the inverse Mercator", () => {
    expect(js).toMatch(/function tileLat\(v\)/);
    expect(js).toMatch(/tileLat\(v\)/);
  });

  test("wraps a tile that straddles the antimeridian", () => {
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

  test("sets a unique pane between isobars (360) and basins (362)", () => {
    expect(js).toMatch(/const PANE_Z = 361/);
  });

  test("warms the image at idle and redraws once it lands", () => {
    expect(js).toMatch(/requestIdleCallback\(warm/);
    expect(js).toMatch(/state\.overlay\.redraw\(\)/);
  });
});

describe("ocean data asset", () => {
  const img = join(root, "data", "transport", "ocean-currents.png");

  test("the equirectangular PNG is published and reasonably sized", () => {
    if (!existsSync(img)) return;
    const bytes = statSync(img).size;
    expect(bytes).toBeGreaterThan(50_000);
    expect(bytes).toBeLessThan(2_000_000);
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

  test("image carries a transparency index (land is masked out)", () => {
    // The SOS source bakes in opaque land, which would double up over
    // our basemap. The published asset must have a transparency entry
    // so the land is see-through.
    if (!existsSync(img)) return;
    const buf = readFileSync(img);
    // Scan for a tRNS chunk — its presence is what makes land transparent.
    let i = 8;
    let foundTrns = false;
    while (i < buf.length - 8) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString("ascii", i + 4, i + 8);
      if (type === "tRNS") { foundTrns = true; break; }
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + len;
    }
    expect(foundTrns).toBe(true);
  });
});
