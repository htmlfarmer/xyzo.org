/**
 * The globe's overlay opacity must MULTIPLY the paint's own base, not
 * replace it.
 *
 * The flat map has always done it this way — basin-layer.js styles a
 * polygon `fillOpacity: 0.16 * state.opacity`, river-layer.js a line
 * `opacity: 0.9 * state.opacity`. The globe's generic fill/line builder
 * instead wrote the slider value straight over the paint's opacity, so an
 * overlay with a deliberately low base lost it entirely.
 *
 * Hydrological Basins is the overlay where that shows, because its base
 * is 0.16 and the slider default is 0.7. Measured on the shipped build:
 *   basins@100  ->  fill-opacity 1.0   (fully opaque)
 *   basins@35   ->  fill-opacity 0.35
 * and the whole globe became a flat cyan sheet — the satellite, Koppen,
 * soil, cropland and every other layer underneath were simply buried. You
 * could see the watershed outlines and nothing else, which is the exact
 * opposite of the flat map, where the basins are a hairline over terrain
 * you can still read.
 *
 * These are static checks on the shipped source. The live values are
 * verified by scripts/globe_audit.py (see the session notes).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const globeJs = readFileSync(join(root, "globe.js"), "utf8");
const basinLayerJs = readFileSync(join(root, "basin-layer.js"), "utf8");

// The slider value in the overlay spec, and the paint opacity it must
// combine with. Both read from the OVERLAYS array in the shipped file so
// a future edit to either one is caught rather than assumed.
function overlaySpec(key) {
  const start = globeJs.indexOf(`key: "${key}",`);
  if (start < 0) return null;
  const end = globeJs.indexOf("\n    },", start);
  return globeJs.slice(start, end);
}

describe("globe overlay opacity is a product, not a replacement", () => {
  test("a baseOpacity() helper reads the paint's own value", () => {
    // Absent or out-of-range means "no deliberate base" -> 1, so the
    // slider alone decides, exactly as before for layers that carry none.
    expect(globeJs).toMatch(/function baseOpacity\(o, prop\)/);
    expect(globeJs).toMatch(/typeof v === "number" && v >= 0 && v <= 1 \? v : 1/);
  });

  test("the FILL builder multiplies the base", () => {
    // This is the bug. `"fill-opacity": startOpacity` discarded the
    // spec's 0.16 and painted the basin wash at the slider value.
    expect(globeJs).toMatch(
      /"fill-opacity":\s*baseOpacity\(o,\s*"fill-opacity"\)\s*\*\s*startOpacity/);
    expect(globeJs).not.toMatch(/"fill-opacity":\s*startOpacity/);
  });

  test("the fill's outline layer multiplies ITS OWN base, not the fill's", () => {
    // The wash and the hairline are two different jobs and must not
    // share one number. The fill is deliberately faint (0.16 — a wash
    // you read terrain through); the OUTLINE is a 0.8 px hairline that
    // has to be visible over that wash, and the flat map draws it at
    // 0.85 (asserted in the reference test below).
    //
    // It previously read baseOpacity(o, "fill-opacity") — so the globe
    // painted its outlines at 0.16, a SIXTH of the flat map's strength,
    // and the owner reported "I don't see the black outlines" on the 3D
    // map. MEASURED on the live globe against a fill-only baseline
    // (animations hidden, baseline noise 0 px):
    //   0.16 -> 5,119 px changed, but only 2 above delta 40 (invisible)
    //   0.85 -> 11,558 px changed, 4,179 strong
    // It was being drawn — invisibly. Both halves must now multiply
    // their OWN base, and both must still scale with the slider.
    const id = globeJs.indexOf('id: o.key + "-line"');
    expect(id).toBeGreaterThan(-1);
    const block = globeJs.slice(id, id + 900);
    expect(block).toMatch(
      /"line-opacity":\s*baseOpacity\(o,\s*"line-opacity"\)\s*\*\s*startOpacity/);
    expect(block,
      "the outline is reading the FILL's base again — it will vanish")
      .not.toMatch(/"line-opacity":\s*baseOpacity\(o,\s*"fill-opacity"\)/);
  });

  test("the LINE builder multiplies the base", () => {
    expect(globeJs).toMatch(
      /"line-opacity":\s*baseOpacity\(o,\s*"line-opacity"\)\s*\*\s*startOpacity/);
    expect(globeJs).not.toMatch(/"line-opacity":\s*startOpacity\s*\}/);
  });

  test("applyOpacity() recomputes the SAME product as the builder", () => {
    // A freshly-loaded layer and a slider-dragged one must agree, or the
    // picture changes when you touch a slider that was already at its
    // stored value.
    // The window must clear the explanatory comments inside the fill
    // branch AND every branch above it (the raster, the quake circles
    // and the language-region fill all sit in front of it now).
    const fn = globeJs.slice(globeJs.indexOf("function applyOpacity"),
                             globeJs.indexOf("function applyOpacity") + 3000);
    expect(fn).toMatch(/const base = baseOpacity\(o, "fill-opacity"\)/);
    expect(fn).toMatch(/setPaintProperty\(o\.key, "fill-opacity", base \* v\)/);
    expect(fn).toMatch(/const base = baseOpacity\(o, "line-opacity"\)/);
    expect(fn).toMatch(/setPaintProperty\(o\.key, "line-opacity", base \* v\)/);
  });

  test("basins keeps its 0.16 fill base, 0.7 slider, and its own 0.85 line base", () => {
    const spec = overlaySpec("basins");
    expect(spec).not.toBeNull();
    expect(spec).toMatch(/opacity:\s*0\.7/);
    // The paint now comes from basinPaint() — it carries the reader's
    // stored scheme (blue/red/black) and colours each feature by its
    // kind, so the literals live there rather than in the spec.
    expect(spec).toMatch(/paint:\s*basinPaint\(\)/);
    const paint = globeJs.slice(globeJs.indexOf("function basinPaint"),
                                globeJs.indexOf("function basinPaint") + 700);
    expect(paint).toMatch(/"fill-opacity":\s*0\.16/);
    // The OUTLINE's own base, and it is 0.85 — the flat map's number
    // (see the reference test below). This is the one that was missing:
    // without it baseOpacity() fell through to 1 only by accident of the
    // old code reading the fill's 0.16 instead.
    expect(globeJs).toMatch(/const BASIN_LINE_OPACITY = 0\.85/);
    expect(paint).toMatch(/"line-opacity":\s*BASIN_LINE_OPACITY/);
  });

  test("the globe means the same thing by 'basins' as the flat map does", () => {
    // The reader's stored scheme and the published kind colours, so a
    // choice made on the flat map survives the trip to 3D.
    //
    // Verified on the live globe: storing xyzo.basinScheme="black" and
    // reloading read back lineColor
    //   ["match",["get","kind"],"river","#0a0a0a","coast","#1c1c1c",
    //    "interior","#333333","#0a0a0a"]
    // where it used to hardcode #38bdf8 regardless — the owner's "I
    // don't see the black outlines" was two bugs, and this is the other.
    expect(globeJs).toMatch(/localStorage\.getItem\("xyzo\.basinScheme"\)/);
    expect(globeJs).toMatch(/const BASIN_SCHEMES = \{/);
    expect(globeJs).toMatch(/black:\s*\{\s*river:\s*"#0a0a0a"/);
    expect(globeJs).toMatch(/\["match",\s*\["get",\s*"kind"\]/);
    // The blue scheme defers to the published kind_colors, exactly as
    // basin-layer.js's `SCHEMES.blue = null` does.
    expect(basinLayerJs).toMatch(/blue:\s*null/);
    // …and the globe must not hardcode the old single hue any more.
    expect(globeJs.slice(globeJs.indexOf("function basinPaint"),
                         globeJs.indexOf("function basinPaint") + 700))
      .not.toMatch(/"fill-color":\s*"#38bdf8"/);
  });

  test("rivers' base is 1.0 so its render strength is unchanged", () => {
    // Rivers' base used to be 0.85, which EQUALLED its slider default —
    // so the old replace-don't-multiply bug was invisible on rivers while
    // it buried the basins. Now that the two multiply, a base of 1.0
    // keeps rivers at exactly the strength it has always shipped at
    // (1.0 * 0.85 = 0.85). Raise this only if you mean to change how
    // rivers look.
    const spec = overlaySpec("rivers");
    expect(spec).not.toBeNull();
    expect(spec).toMatch(/"line-opacity":\s*1\.0/);
  });
});

describe("the flat map's basins opacity is the reference", () => {
  test("basin-layer.js multiplies a 0.16 fill base", () => {
    // The globe must agree with this, not invent its own scale.
    expect(basinLayerJs).toMatch(/fillOpacity:\s*0\.16\s*\*\s*state\.opacity/);
    expect(basinLayerJs).toMatch(/opacity:\s*0\.85\s*\*\s*state\.opacity/);
  });
});
