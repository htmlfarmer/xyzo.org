/**
 * Facebook Friendships overlay — NOAA SOS Explorer.
 *
 * Ten million Facebook friendship pairs plotted as a global density map.
 * The interesting invariant is the ALPHA: the source PNG is fully opaque
 * with a dark-blue background, and the red channel IS the density
 * (ocean ≈ 1, USA ≈ 250). The build maps red → alpha so the basemap
 * shows through where nobody is and the arcs glow where people are.
 *
 * A flipped axis or a wrong density channel still produces a picture that
 * looks like a map — only known places tell you the arcs are in the right
 * place. Hence the probe table in the builder, and the probe checks here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const builder = readFileSync(join(ROOT, "..", "scripts", "facebook_build.py"), "utf8");
const DATA = join(ROOT, "data", "facebook");
const TILES = join(DATA, "tiles");

describe("facebook friendship overlay — registration", () => {
  test("is in the layers dropdown with an opacity slider", () => {
    expect(appJs).toMatch(/Facebook Friendships/);
    expect(appJs).toMatch(/data\/facebook\/tiles\/\{z\}\/\{x\}\/\{y\}\.png/);
    // maxZoom must match the built pyramid (z0..5).
    expect(appJs).toMatch(/maxZoom:\s*5,\s*minZoom:\s*0/);
  });

  test("has a URL-hash slug so a shared link can carry it", () => {
    expect(appJs).toMatch(/"facebook":\s*"🤝 Facebook Friendships"/);
    expect(appJs).toMatch(/"🤝 Facebook Friendships":\s*"facebook"/);
  });

  test("is also on the 3D globe", () => {
    const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
    expect(globeJs).toMatch(/key:\s*"facebook"/);
    expect(globeJs).toMatch(/maxzoom:\s*5/);
    // Every globe overlay needs a real opacity default or the readout
    // renders "NaN%".
    expect(globeJs).toMatch(/opacity:\s*0\.\d+/);
  });

  test("loads with the other layer modules (before app.js)", () => {
    // A plain L.tileLayer — no separate module, so no script tag. But the
    // registration must sit inside WEATHER_OVERLAYS, before the control.
    expect(appJs).toMatch(/const WEATHER_OVERLAYS = \{[\s\S]*?Facebook Friendships/);
  });
});

describe("facebook friendship overlay — the build", () => {
  test("the source is pinned to the NOAA FTP", () => {
    expect(builder).toMatch(/sos\.noaa\.gov/);
    expect(builder).toMatch(/2048\.png/);
  });

  test("the alpha IS the density — red channel, not a new colour ramp", () => {
    // The whole point: dark background becomes transparent, arcs stay.
    expect(builder).toMatch(/src\[\.\.\., 0\]/);
    expect(builder).toMatch(/density/);
    expect(builder).toMatch(/alpha/);
  });

  test("the Mercator inversion is per-pixel, not an imageOverlay stretch", () => {
    // An imageOverlay stretches plate-carrée content linearly across the
    // projected rectangle and distorts the poles; the tile path samples
    // the correct lon/lat per output pixel.
    expect(builder).toMatch(/arctan\(np\.sinh/);
    expect(builder).toMatch(/mercator_to_lonlat/);
    // The builder must actually sample per-pixel (not merely mention the
    // alternative in a comment).
    expect(builder).toMatch(/tile\[yy\[valid\], xx\[valid\]\]/);
  });

  test("verify() probes known places — a gate, not a checkpoint", () => {
    expect(builder).toMatch(/def _verify_source/);
    expect(builder).toMatch(/def _verify_tiles/);
    expect(builder).toMatch(/refusing to (build tiles|publish)/);
    // Known dense places…
    expect(builder).toMatch(/United States/);
    expect(builder).toMatch(/Sao Paulo/);
    // …and known sparse ones. The Amazon probe matters: it catches a
    // probe that was accidentally pointed at the Brazilian coast.
    expect(builder).toMatch(/Amazon/);
    expect(builder).toMatch(/Sahara/);
    // The dataset itself says China is dim.
    expect(builder).toMatch(/China/);
  });
});

describe("facebook friendship overlay — published assets", () => {
  test("meta.json carries the attribution and licence", () => {
    const p = join(DATA, "meta.json");
    expect(existsSync(p)).toBe(true);
    const m = JSON.parse(readFileSync(p, "utf8"));
    expect(m.attribution).toMatch(/NOAA/);
    expect(m.license).toMatch(/Public domain/);
    expect(m.max_zoom).toBe(5);
    expect(m.encoding).toMatch(/alpha/);
    expect(m.probes.length).toBeGreaterThanOrEqual(10);
  });

  test("the tile pyramid is built and has the expected shape", () => {
    expect(existsSync(TILES)).toBe(true);
    for (let z = 0; z <= 5; z++) {
      const dir = join(TILES, String(z));
      expect(existsSync(dir), `z${z} missing`).toBe(true);
      const count = readdirSync(dir).length;
      const expected = 2 ** z;
      expect(count, `z${z} should have ${expected} x-tiles`).toBe(expected);
    }
  });

  test("the tiles are small enough to ship (z0..z5 total)", () => {
    let total = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else total += statSync(p).size;
      }
    };
    walk(TILES);
    // ~17 MB raw. Anything much bigger would need a zoom cap.
    expect(total).toBeLessThan(40_000_000);
    expect(total).toBeGreaterThan(1_000_000);
  });
});
