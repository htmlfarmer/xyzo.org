// ocean-current-visible.bun.test.js — the animated ocean currents must
// actually be SEEN.
//
// The owner's report: *"im not seeing the waves move."* The animation
// was running — the canvas existed, the particle loop ticked, the
// frame counter advanced — and the reader saw nothing, for two
// reasons that both had to be fixed:
//
//  1. **THE RAMP STARTED NEAR-BLACK.** The median ocean surface
//     current is 0.11 m/s and most of the ocean is slower than
//     0.3 m/s, so a ramp whose first stop was #0b1020 painted the
//     great majority of the ocean in a colour indistinguishable from
//     a dark satellite basemap. The same lesson the wind taught: a
//     ramp with a dark end is invisible on a dark map. The ramp is
//     now BRIGHT AT BOTH ENDS, and it is PUBLISHED (meta.json), so the
//     flat map and the globe use the same one.
//
//  2. **SEEDING PICKED RANDOM SCREEN PIXELS.** A particle was
//     seeded by unprojecting a random point on screen and rejected
//     unless the water there was moving — so a view over a continent
//     seeded almost nothing, and the field looked dead. The particles
//     are now seeded from the grid's WET cells.
//
// And the console noise: a DEAD PICTURE at a publisher must not be an
// error in the reader's browser. The image proxy now answers a missing
// picture with HTTP 200 and a 1x1 transparent PNG, because an <img>
// that 404s is a console error nobody can silence and nobody can act
// on.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const layerJs = readFileSync(join(ROOT, "ocean-current-layer.js"), "utf8");
const buildPy = readFileSync(join(ROOT, "..", "scripts", "ocean_currents_build.py"), "utf8");
const meta = JSON.parse(readFileSync(join(ROOT, "data", "ocean", "meta.json"), "utf8"));
const proxyTs = readFileSync(join(ROOT, "..", "api", "src", "routes", "imageProxy.ts"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

describe("the ocean currents are visible", () => {
  test("the ramp is BRIGHT at BOTH ends and it is published", () => {
    expect(meta.ramp).toBeTruthy();
    expect(meta.ramp.length).toBeGreaterThan(3);
    // The first stop must not be a near-black: that is what made the
    // animation invisible over the (slow, and therefore mostly dark)
    // ocean.
    const first = meta.ramp[0].rgb;
    expect(first).not.toMatch(/^#0[0-9a-f]{5}$/);
    expect(first).not.toMatch(/^#1[0-9a-f]{5}$/);
    // ...and the build script publishes it, so the globe reads the same.
    expect(buildPy).toMatch(/"ramp": RAMP/);
    expect(buildPy).toMatch(/RAMP = \[/);
  });

  test("the particles are seeded from the grid's WET cells", () => {
    expect(layerJs).toMatch(/function buildWetCells\(/);
    expect(layerJs).toMatch(/wetCells\.push\(i\)/);
    expect(layerJs).toMatch(/function seed\(map\)/);
    // ...and it must NOT be the old "pick a screen pixel and hope".
    expect(layerJs).not.toMatch(/Math\.random\(\) \* \(state\.w/);
  });

  test("the published grid really has moving water to seed from", () => {
    expect(meta.grid.layout).toBe("planar_uv");
    expect(meta.observed_ms[0]).toBeGreaterThan(0.02);
    expect(meta.range_ms[1]).toBeGreaterThan(0.5);
  });
});

describe("a dead picture is not a console error", () => {
  test("the proxy answers a missing picture with a placeholder, not an error", () => {
    // An <img> that 404s is a console error the reader cannot silence
    // and cannot act on: the picture is gone AT THE PUBLISHER.
    expect(proxyTs).toMatch(/function placeholder\(/);
    expect(proxyTs).toMatch(/PLACEHOLDER_PNG/);
    // ...and every failure path that used to return a 404 for an <img>
    // now returns the placeholder.
    expect(proxyTs).toMatch(/if \(status === 404\) return placeholder\(\);/);
    expect(proxyTs).toMatch(/return placeholder\(\);/);
    // The genuinely different faults stay errors: a malformed request
    // and our own rate limit.
    expect(proxyTs).toMatch(/c\.json\(\{ error: "rate_limited"/);
  });

  test("the client hides a placeholder-sized image", () => {
    // The placeholder is 1x1, so its natural size gives it away: the
    // layout must be exactly as it was when the image used to fail.
    expect(appJs).toMatch(/function imgOnLoad\(/);
    expect(appJs).toMatch(/naturalWidth > 1 \|\| imgEl\.naturalHeight > 1/);
    expect(appJs).toMatch(/onload="imgOnLoad\(this\)"/);
  });

  test("a healthy image is still served as the image itself", () => {
    expect(proxyTs).toMatch(/return new Response\(buffer, \{/);
    expect(proxyTs).toMatch(/"Content-Type": contentType/);
  });
});
