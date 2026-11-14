// globe-overlay-settings.bun.test.js — the 3D globe must paint what the
// flat map paints, and must remember what the user chose.
//
// The bug this pins: globe.js's loadTemp() indexed meta.ramp's stops as
// if they were evenly spaced in °C (step = (hi - lo) / (n - 1)). They
// are not — the temperature ramp's gaps run 4.2, 4.9, 3.5, 2.1 — so the
// globe landed on the wrong stop: up to +4.9 °C too warm, 0 °C painted
// lime-yellow where the flat map paints green, worst disagreement 114
// RGB units, 19 of 36 sampled temperatures visibly different.
//
// A comment in the same file had asserted the temperature ramp "is
// uniform", which is what let it ship. Both the arithmetic and that
// claim are now under test.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const fieldBakeJs = readFileSync(join(ROOT, "field-bake.js"), "utf8");
const globeWindJs = readFileSync(join(ROOT, "globe-wind.js"), "utf8");
const tempLayer = readFileSync(join(ROOT, "temp-layer.js"), "utf8");
const meta = JSON.parse(readFileSync(join(ROOT, "data", "temp", "meta.json"), "utf8"));
const ramp = meta.ramp;

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const rgbToHex = (a) =>
  "#" + ((1 << 24) | (a[0] << 16) | (a[1] << 8) | a[2]).toString(16).slice(1);

// temp-layer.js rampColor(), transcribed as the reference implementation.
function flatColor(c) {
  const lo = ramp[0], hi = ramp[ramp.length - 1];
  if (c <= lo.c) return hexToRgb(lo.rgb);
  if (c >= hi.c) return hexToRgb(hi.rgb);
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i], b = ramp[i + 1];
    if (c >= a.c && c <= b.c) {
      const t = (c - a.c) / (b.c - a.c);
      const ca = hexToRgb(a.rgb), cb = hexToRgb(b.rgb);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t),
        Math.round(ca[1] + (cb[1] - ca[1]) * t),
        Math.round(ca[2] + (cb[2] - ca[2]) * t),
      ];
    }
  }
  return hexToRgb(hi.rgb);
}

// Pull rampColor OUT OF THE SHIPPED field-bake.js and run it, so this
// tests the real code rather than a copy of it that could drift.
//
// field-bake.js is now the SINGLE owner of the ramp and of the
// mercator bake: the flat map's temp-layer.js and the globe both call
// it, so a drift between the two views is no longer possible — and
// this test pins that they really do call it.
function extractRampColor() {
  const start = fieldBakeJs.indexOf("function rampColor(ramp, c)");
  expect(start).toBeGreaterThan(-1);
  let i = fieldBakeJs.indexOf("{", start);
  let depth = 0, end = i;
  for (; end < fieldBakeJs.length; end++) {
    if (fieldBakeJs[end] === "{") depth++;
    else if (fieldBakeJs[end] === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  const src = fieldBakeJs.slice(start, end) +
    "\nreturn rampColor;";
  // hexToRgb is a SIBLING function in field-bake.js, not inside
  // rampColor, so the extraction has to supply it or rampColor throws
  // "not defined" in the sandbox and the comparison silently tests
  // nothing.
  return new Function("hexToRgb", src)(hexToRgb);
}

const dist = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

describe("globe temperature colour agrees with the flat map", () => {
  test("the ramp really is non-uniform (the assumption that caused the bug)", () => {
    const gaps = ramp.slice(0, -1).map((e, i) => ramp[i + 1].c - e.c);
    const distinct = new Set(gaps.map((g) => Math.abs(g).toFixed(2)));
    // If this ever collapses to one value the old index maths would be
    // safe — but nothing should rely on that.
    expect(distinct.size).toBeGreaterThan(1);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
  });

  test("shipped rgbOf matches the flat map at every 2 °C", () => {
    const rgbOf = extractRampColor();
    let worst = 0, worstAt = null, bad = 0;
    for (let c = -40; c <= 30; c += 2) {
      const g = rgbOf(ramp, c);
      const f = flatColor(c);
      const d = dist(g, f);
      if (d > worst) { worst = d; worstAt = c; }
      if (d > 12) bad++;   // one ramp step of slack for rounding
    }
    // Before the fix: worst 113.9 at 0 °C, 19 of 36 over 30.
    expect(bad).toBe(0);
    expect(worst).toBeLessThanOrEqual(12);
    if (worst > 0) expect(worstAt).toBeGreaterThanOrEqual(-40);
  });

  test("0 °C is green, not lime-yellow — the exact symptom", () => {
    const rgbOf = extractRampColor();
    const g = rgbOf(ramp, 0);
    const f = flatColor(0);
    expect(dist(g, f)).toBeLessThanOrEqual(12);
    // the frozen wrong answer was rgb(163,230,53)
    expect(g).not.toEqual([163, 230, 53]);
    expect(g).toEqual(f);
  });

  test("nothing indexes ramp stops by an even step, in either view", () => {
    // The old expression: Math.round((c - lo) / step) with
    // step = (hi - lo) / (ramp.length - 1), applied to meta.ramp.
    const hasUniformIndex =
      /ramp\[Math\.max[\s\S]{0,120}round\(\(.*- lo\) \/ step\)/.test(globeJs + fieldBakeJs);
    expect(hasUniformIndex).toBe(false);
    // ...and the shared implementation must scan for the bracketing pair.
    expect(fieldBakeJs).toMatch(/function rampColor\(ramp, c\)[\s\S]{0,700}for \(let i = 0; i < ramp\.length - 1; i\+\+\)/);
  });

  test("BOTH views call the shared ramp and the shared bake", () => {
    // One ramp, one mapping, two views. A second implementation is a
    // second source of truth, and the second source of truth is the one
    // that drifts.
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.rampColor\(/);
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.bakeMercator\(/);
    expect(tempLayer).toMatch(/window\.XYZO_FIELD_BAKE\.rampColor\(ramp, c\)/);
    expect(tempLayer).toMatch(/window\.XYZO_FIELD_BAKE\.tileLat\(v\)/);
  });

  test("the false 'the temperature ramp is uniform' claim is gone", () => {
    expect(globeJs).not.toMatch(/temperature ramp is uniform/);
  });
});

describe("every other ramp lookup on the globe is segment-based too", () => {
  test("magRampColor scans bracketing pairs", () => {
    const src = globeJs.slice(globeJs.indexOf("function magRampColor"));
    expect(src).toMatch(/for \(let i = 0; i < ramp\.length - 1; i\+\+\)/);
    // no stop-indexing by value
    expect(src).not.toMatch(/ramp\[Math\.round\(/);
  });

  test("the lightning ramp scans bracketing pairs", () => {
    const idx = globeJs.indexOf("ramp[0].t");
    expect(idx).toBeGreaterThan(-1);
    const src = globeJs.slice(idx - 200, idx + 600);
    expect(src).toMatch(/for \(let i = 0; i < ramp\.length - 1; i\+\+\)/);
  });

  test("the mag wash LUT samples the ramp instead of indexing it", () => {
    // A uniform LUT over the VALUE range is fine — each entry is built
    // by calling magRampColor, so the non-uniformity is handled at build
    // time. What matters is that no lookup indexes ramp[] directly.
    const lut = globeJs.slice(globeJs.indexOf("const lutStep ="), globeJs.indexOf("const lutStep =") + 400);
    expect(lut).toMatch(/magRampColor\(ramp, lo \+ i \* lutStep\)/);
    expect(lut).not.toMatch(/ramp\[Math\.round\(/);
  });

  test("temp-layer.js (the reference) interpolates by real c values", () => {
    const src = tempLayer.slice(tempLayer.indexOf("function rampColor"));
    expect(src).toMatch(/for \(let i = 0; i < ramp\.length - 1; i\+\+\)/);
  });
});

describe("globe image sources are MERCATOR, and stop at the mercator limit", () => {
  test("the three field images use the shared mercator quad", () => {
    // ±90 projects to y=Infinity on the globe and the source SILENTLY
    // never renders — an invisible failure no screenshot catches. The
    // limit is the MERCATOR one (85.051129), because the picture is
    // mercator: an image source is a quad in mercator space, so a
    // latitude bake is sampled with the wrong row for every latitude
    // except the equator.
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.mercatorQuad\(\)/);
    expect(fieldBakeJs).toMatch(/const LAT_LIMIT = 85\.051129/);
    expect(fieldBakeJs).toMatch(/function tileLat\(v\)/);
    // The bake's rows are linear in MERCATOR, not in latitude.
    expect(fieldBakeJs).toMatch(/const lat = tileLat\(\(py \+ 0\.5\) \/ H\)/);
    // The old latitude bake must be gone: it is what put the Sahara's
    // heat at 45°N.
    expect(globeJs).not.toMatch(/const lat = 90 - \(180 \* \(py \+ 0\.5\)\) \/ H/);
  });

  test("no image source reaches the exact pole", () => {
    const coords = [...globeJs.matchAll(/coordinates: \[\[([^\]]+)\], \[([^\]]+)\], \[([^\]]+)\], \[([^\]]+)\]\]/g)];
    for (const m of coords) {
      const body = m.slice(1).join(",");
      expect(body).not.toMatch(/-?90\]/);   // no ±90 corner
    }
  });
});
