/**
 * Human Transportation overlay — NOAA "Anthropocene" composite.
 *
 * Pins the module contract (name, registration, load order, stamping),
 * the house rules that broke other overlays before (setOpacity on the
 * GridLayer, async done(), overlayadd registered before the localStorage
 * restore, no .png rebuild trap), and the published asset itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const js = readFileSync(join(root, "transport-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("transport-layer module", () => {
  test("exposes TransportLayer with a stable name", () => {
    expect(js).toMatch(/window\.TransportLayer\s*=/);
    expect(js).toMatch(/LAYER_NAME:\s*"🛰️ Human Transportation"/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity"]) {
      expect(js).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.TransportLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.TransportLayer\.init\(map\)/);
  });

  test("loads before app.js, exactly once, and is stamped", () => {
    const at = indexHtml.indexOf('src="transport-layer.js');
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    // Exactly ONE script tag — a duplicate re-runs the IIFE and swaps
    // the live state object underneath app.js mid-boot.
    const tags = indexHtml.match(/src="transport-layer\.js[^"]*"/g) || [];
    expect(tags.length).toBe(1);
    expect(bump).toMatch(/transport-layer\.js/);
  });

  test("paints through a wrapping GridLayer, not a one-world imageOverlay", () => {
    // A plain L.imageOverlay spans ONE copy of the world; panning past
    // the antimeridian leaves a gap (the documented temp-layer pitfall).
    expect(js).toMatch(/L\.GridLayer\.extend/);
    // Match the constructor CALL — the module docstring legitimately
    // mentions L.imageOverlay while explaining why it is not used.
    expect(js).not.toMatch(/L\.imageOverlay\(/);
  });

  test("resolves each tile row through the inverse Mercator", () => {
    // The source is equirectangular but tiles are Mercator; sampling
    // in latitude-space would shift the routes off their cities.
    expect(js).toMatch(/function tileLat\(v\)/);
    expect(js).toMatch(/tileLat\(v\)/);
  });

  test("wraps a tile that straddles the antimeridian", () => {
    // Two drawImage blits for a tile crossing the world edge.
    expect(js).toMatch(/Straddles \(or is beyond\) the world edge/);
    expect(js).toMatch(/drawImage\(img, 0, srcRow/);
  });

  test("calls done() asynchronously", () => {
    // A synchronous done() leaves every tile at visibility:hidden.
    expect(js).toMatch(/setTimeout\(\(\)\s*=>\s*done\(null,\s*tile\),\s*0\)/);
  });

  test("the GridLayer provides setOpacity for the sliders", () => {
    expect(js).toMatch(/setOpacity\(value\)/);
    expect(js).toMatch(/getOpacity\(\)/);
  });

  test("registers overlayadd BEFORE the localStorage restore", () => {
    // If the listener attaches after addTo(), the restore's synchronous
    // overlayadd is missed: state stays false and nothing draws while
    // the checkbox looks checked (the 2026-10-28 magnetic-layer bug).
    const listenerAt = js.indexOf('map.on("overlayadd"');
    const restoreAt = js.indexOf("storageGet(STORE_KEY");
    expect(listenerAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(listenerAt).toBeLessThan(restoreAt);
    // And the comment must record WHY, or the next refactor undoes it.
    // (Match a fragment on ONE line — the full sentence wraps.)
    expect(js).toMatch(/never sees the restore/);
  });

  test("never blocks map clicks — it is a picture, not a probe", () => {
    expect(js).toMatch(/blocksClick:\s*\(\)\s*=>\s*false/);
  });

  test("uses XLog, never raw console", () => {
    expect(js).toMatch(/window\.XLog/);
    expect(js).not.toMatch(/console\.(log|warn|error|debug)/);
  });

  test("sets the pane between mag (358) and isobars (360)", () => {
    expect(js).toMatch(/const PANE_Z = 359/);
  });

  test("warms the image at idle so the first toggle is instant", () => {
    expect(js).toMatch(/requestIdleCallback\(warm/);
  });

  test("redraws tiles painted before the image landed", () => {
    // Tiles created while the Image was still loading are blank; the
    // onload path must force a redraw or they stay that way forever.
    expect(js).toMatch(/state\.overlay\.redraw\(\)/);
  });
});

describe("transport data asset", () => {
  const img = join(root, "data", "transport", "human-transportation.png");

  test("the equirectangular PNG is published and reasonably sized", () => {
    if (!existsSync(img)) return;
    // Frozen 2012 asset: immutable caching is CORRECT here (it is never
    // regenerated), but it still must not be enormous — it downloads
    // whole before the first tile paints.
    const bytes = statSync(img).size;
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(4_000_000);
    // PNG magic
    const head = readFileSync(img).subarray(0, 8);
    expect(Array.from(head)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("image is 2:1 — equirectangular, not sphere-projected", () => {
    if (!existsSync(img)) return;
    const buf = readFileSync(img);
    // IHDR width/height are big-endian at offset 16.
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    expect(w / h).toBeCloseTo(2.0, 2);
  });
});
