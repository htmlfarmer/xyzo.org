// geology-layer.bun.test.js — Macrostrat bedrock + USGS contacts.
//
// Two layers-control entries share one module. Macrostrat tiles are
// hotlinked (CORS *, 512 px, z0–14) — baking that pyramid globally is
// impossible. The probe queries Macrostrat's point API for the unit
// name/age/lithology under the cursor.

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const geoJs = readFileSync(join(ROOT, "geology-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("geology-layer module", () => {
  test("exposes GeologyLayer with both layer factories", () => {
    expect(geoJs).toMatch(/window\.GeologyLayer\s*=/);
    expect(geoJs).toMatch(/getTileLayer:\s*getTileLayer/);
    expect(geoJs).toMatch(/getContactLayer:\s*getContactLayer/);
    expect(geoJs).toMatch(/LAYER_NAME:\s*"🪨 Geology \(Macrostrat\)"/);
    expect(geoJs).toMatch(/CONTACTS_LAYER_NAME:\s*"🗺️ Geologic contacts \(USGS\)"/);
  });

  test("both layers registered in WEATHER_OVERLAYS", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.GeologyLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.GeologyLayer\.CONTACTS_LAYER_NAME/);
    expect(appJs).toMatch(/window\.GeologyLayer\.init\(map\)/);
  });

  test("probe mode blocks click-to-submit", () => {
    expect(geoJs).toMatch(/function blocksClick\(\)/);
    expect(appJs).toMatch(/window\.GeologyLayer\.blocksClick\(\)/);
  });

  test("the probe stands down when the Hover HUD owns the cursor", () => {
    // 15 of the 16 probe layers check this; geology was the only one
    // that did not, so in "Everything" mode its box was the ONLY thing
    // rendered at cursor+14 — sitting where the reader expects the wind
    // speed — and it read "no data". Reported exactly that way:
    //   "the mouse pointer … doesn't show the wind speed in miles per
    //    hour, it just says No data".
    // It also fires a NETWORK request at Macrostrat's point API per
    // (debounced) mousemove, which is why geology is excluded from the
    // HUD's SAMPLERS altogether — the same rule, for the same reason.
    expect(geoJs).toMatch(/suppressesProbes\(\)/);
    // …and it must HIDE, not merely stop: a probe that stops updating
    // keeps its last text on screen.
    expect(geoJs).toMatch(/hudOwnsCursor\(\)\) \{[\s\S]{0,400}?hideProbe\(\);/);
    // A response already in flight must not re-show it either.
    expect(geoJs).toMatch(/\|\| hudOwnsCursor\(\)\) return;/);
  });

  test("the empty probe says WHAT has no data, never a bare 'no data'", () => {
    // probe-stack.js places this box among the wind and climate
    // readings, and formatUnit() renders bare text — so an unlabelled
    // "no data" beside "💨 5 mph" reads as the WIND having none.
    expect(geoJs).not.toMatch(/<em>no data<\/em>/);
    expect(geoJs).toMatch(/no rock unit here/);
  });

  test("module exposes setOpacity/getOpacity for the opacity registry", () => {
    // The tile layer is an L.TileLayer (native setOpacity), but the
    // MODULE must also expose it so OverlayOpacity can drive the
    // geology entry the same way as every other overlay.
    expect(geoJs).toMatch(/setOpacity:\s*\(v\)/);
    expect(geoJs).toMatch(/getOpacity:\s*\(\)/);
    // And it must actually forward to the tile layer, not just store it.
    expect(geoJs).toMatch(/state\.geoLayer\.setOpacity/);
  });

  test("Macrostrat tile URL uses the standard XYZ grid (no tileSize override)", () => {
    // Macrostrat's 512 px PNGs use standard z/x/y — same geographic
    // bounds as 256 px tiles. Overriding tileSize breaks Leaflet's CRS
    // math and stretches/shifts the whole overlay. Match only live code
    // (property assignments), not the explanatory comment.
    expect(geoJs).toMatch(/tiles\.macrostrat\.org\/carto\/\{z\}\/\{x\}\/\{y\}\.png/);
    expect(geoJs).not.toMatch(/^\s*tileSize:/m);
    expect(geoJs).toMatch(/Do NOT set tileSize/);
    // Real unit polygons through z14; beyond that Leaflet upscales.
    expect(geoJs).toMatch(/const MAX_NATIVE = 14/);
  });

  test("USGS contacts is a WMS layer on the GSC world-geology service", () => {
    expect(geoJs).toMatch(/mrdata\.usgs\.gov\/services\/worldgeol/);
    expect(geoJs).toMatch(/layers:\s*"contacts"/);
    expect(geoJs).toMatch(/L\.tileLayer\.wms/);
    expect(geoJs).toMatch(/transparent:\s*true/);
  });

  test("the contacts WMS draws black lines — CSS inverts them to white", () => {
    // Without this the contacts are invisible on our dark basemaps.
    expect(geoJs).toMatch(/xyzo-geology-contacts/);
    expect(stylesCss).toMatch(/\.xyzo-geology-contacts\s*\{[^}]*invert\(1\)/);
  });

  test("probe queries the Macrostrat point API (debounced + cached)", () => {
    expect(geoJs).toMatch(/macrostrat\.org\/api\/v2\/geologic_units\/map/);
    expect(geoJs).toMatch(/lat=.*toFixed.*lng=.*toFixed/);
    expect(geoJs).toMatch(/probeCache/);
    expect(geoJs).toMatch(/setTimeout\(/);
    expect(geoJs).toMatch(/250/);
  });

  test("formatUnit renders name, age range and lithology", () => {
    expect(geoJs).toMatch(/best_int_name|t_int_name/);
    expect(geoJs).toMatch(/b_age.*t_age/);
    expect(geoJs).toMatch(/lith/);
  });

  test("loads before app.js and is stamped", () => {
    const geoAt = indexHtml.indexOf("geology-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(geoAt).toBeGreaterThan(-1);
    expect(geoAt).toBeLessThan(appAt);
    expect(bump).toMatch(/geology-layer\.js/);
  });

  test("hotlinked tiles need no BUILD token (not under public_html/data)", () => {
    // Macrostrat is the tile server; we do not write their PNGs, so the
    // immutable-cache trap does not apply. Pin that decision.
    expect(geoJs).not.toMatch(/public_html\/data\/geology/);
    expect(geoJs).not.toMatch(/const BUILD/);
  });
});

describe("geology data assets", () => {
  // No local assets to check — everything is hotlinked. Just assert the
  // module itself exists and is non-trivial.
  test("geology-layer.js is a real implementation", () => {
    expect(existsSync(join(ROOT, "geology-layer.js"))).toBe(true);
    expect(geoJs.length).toBeGreaterThan(3000);
  });
});
