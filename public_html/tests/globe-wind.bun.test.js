// globe-wind.bun.test.js — the globe's wind: the ANIMATION and the SPEED
// field, and the fact that they are TWO different things.
//
// The bug this pins (found by scripts/globe_wind_audit.py, a Playwright
// study of the live globe):
//
//   **THE GLOBE HAD ONE CONTROLLER FOR TWO ANIMATIONS.** The wind and
//   the ocean currents are both "a canvas over the map", so both asked
//   for a controller — and they both wrote it into the SAME variable.
//   The second one created (the ocean currents) overwrote the first
//   (the wind), so:
//
//     · switching "Wind (GFS)" on switched the OCEAN CURRENTS on
//       instead, and the wind never animated at all;
//     · and the reader was told nothing, because the globe had NO
//       LOGGER — console-guard.js (which defines window.XLog) was not
//       loaded there, so every failure was completely silent.
//
// Both are pinned here: the controllers are a MAP keyed by the overlay,
// and the globe loads the logger.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const windJs = readFileSync(join(ROOT, "globe-wind.js"), "utf8");
const globeHtml = readFileSync(join(ROOT, "globe.html"), "utf8");

describe("the globe's wind", () => {
  test("both the animation and the speed field are in the panel", () => {
    expect(globeJs).toMatch(/key:\s*"wind-speed"/);
    expect(globeJs).toMatch(/label:\s*"🌬️ Wind speed \(GFS\)"/);
    expect(globeJs).toMatch(/key:\s*"wind"/);
    expect(globeJs).toMatch(/label:\s*"💨 Wind \(GFS\)"/);
    // The flat map's defaults, so the two views agree.
    expect(globeJs).toMatch(/type:\s*"wind-speed",[\s\S]{0,80}opacity:\s*0\.4/);
    expect(globeJs).toMatch(/type:\s*"wind",[\s\S]{0,80}opacity:\s*0\.95/);
  });

  test("the speed field is a Mercator-baked image, like the temperature", () => {
    expect(globeJs).toMatch(/loadWindSpeed/);
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.bakeMercator/);
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.mercatorQuad\(\)/);
    expect(windJs).toMatch(/addSpeedLayer/);
  });

  test("EACH animation has its own controller", () => {
    // One variable for two animations means the second one wins and
    // the first one is unreachable.
    expect(globeJs).toMatch(/const windControllers = \{\}/);
    expect(globeJs).toMatch(/windControllers\[o\.key\] = ctrl/);
    expect(globeJs).toMatch(/const ctrl = windControllers\[o\.key\]/);
    // ...and no single variable may be left behind.
    expect(globeJs).not.toMatch(/windController\s*=\s*window\.XYZO_GLOBE_WIND/);
    expect(globeJs).not.toMatch(/if \(windController\)/);
  });

  test("the two animations read their OWN grid", () => {
    // The wind reads the COARSE pair: the globe draws 900 streaks on a
    // sphere and shows no numbers, so the 0.25° grid (2.8 MB
    // gzipped) buys it nothing. `meta-1deg.json` describes
    // `grid-1deg.bin` — the SAME analysis, the SAME run, subsampled to
    // 1° by the worker, so the two cannot disagree.
    expect(windJs).toMatch(/wind:\s*\{\s*meta:\s*"\/data\/wind\/meta-1deg\.json"/);
    expect(windJs).toMatch(/grid:\s*"\/data\/wind\/grid-1deg\.bin"/);
    expect(windJs).toMatch(/ocean:\s*\{\s*meta:\s*"\/data\/ocean\/meta\.json"/);
    // One cache per source, so the two never share a grid.
    expect(windJs).toMatch(/const shared = \{\}/);
    expect(windJs).toMatch(/const sharedPromises = \{\}/);
    // The wind overlay asks for the wind source; the currents ask for
    // their own.
    expect(globeJs).toMatch(/key:\s*"wind",[\s\S]{0,200}type:\s*"wind"/);
    expect(globeJs).toMatch(/key:\s*"ocean-current",[\s\S]{0,220}source:\s*"ocean"/);
  });

  test("the globe HAS a logger", () => {
    // console-guard.js defines window.XLog. Without it every failure
    // in a globe module is silent: the overlay simply does nothing.
    expect(globeHtml).toMatch(/console-guard\.js/);
    // ...and it must come BEFORE the modules that log.
    const i = globeHtml.indexOf("console-guard.js");
    const j = globeHtml.indexOf("globe-wind.js");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  test("the animation culls the far side of the sphere", () => {
    // A particle behind the globe has no screen position; without the
    // back-face test it is drawn over the front of the planet.
    expect(windJs).toMatch(/function visible\(lng, lat\)/);
    expect(windJs).toMatch(/Math\.atan2\(u, v\)|Math\.cos\(pl\) \* Math\.sin\(pLng\)/);
  });

  test("the physics are the wind layer's physics", () => {
    expect(windJs).toMatch(/\(\(\(lng - g\.lon_min\) % 360\) \+ 360\) % 360/);
    expect(windJs).toMatch(/const x1 = \(x0 \+ 1\) % g\.cols/);
    expect(windJs).toMatch(/cosLat/);
    expect(windJs).toMatch(/if \(acc >= TRAIL_PX\)/);
  });

  test("the audit script exists and matches the row by its BARE label", () => {
    const py = readFileSync(join(ROOT, "..", "scripts", "globe_wind_audit.py"), "utf8");
    expect(py).toMatch(/globe_wind_audit|XYZO_GLOBE_WIND|Wind \(GFS\)/);
    // The first version matched with `indexOf(...) === length - n`,
    // which is TRUE for any row that does not contain the label at all
    // and happens to be the same length — so it switched the RIVERS on
    // and reported that the wind did nothing.
    expect(py).not.toMatch(/indexOf\('Wind \(GFS\)'\) ===/);
  });
});

// ── DOTS in BOTH views ────────────────────────────────────────────────
//
// Owner ask: "we want to have similar dots for both wind animations 2d
// or 3d". The flat map's `particles` style draws a filled circle with a
// DARK HALO under a bloom; the globe drew only long streaks, so a link
// carrying `wind=particles:speed` opened on the globe as something the
// flat map would never show.
//
// The globe cannot import wind-layer.js's constants (globe.html does
// not load it), so it carries its own copy — which is exactly the
// arrangement a parity test exists for. Two copies that drift apart
// would give the reader a different dot in each view with nothing on
// screen saying so.
describe("the globe's wind DOTS", () => {
  const flat = readFileSync(join(ROOT, "wind-layer.js"), "utf8");

  // Pull `const NAME = <expr>;` out of a source and evaluate it. The
  // alphas are written as `0.9 * 0.5` so the arithmetic is visible in
  // the file, which means a number-only regex would read `0.9` for all
  // three — and the assertion would then pass or fail on the wrong
  // value. Only arithmetic and digits are allowed through.
  function constValue(src, name) {
    const m = src.match(new RegExp("const\\s+" + name + "\\s*=\\s*([^;]+);"));
    if (!m) return null;
    const expr = m[1].trim();
    if (!/^[\d\s.*+()-]+$/.test(expr)) return null;
    // eslint-disable-next-line no-new-func
    return Number(new Function("return (" + expr + ")")());
  }

  test("the dot geometry is the flat map's, constant for constant", () => {
    const pairs = [
      ["PARTICLE_R_MIN", "PARTICLE_R_MIN"],
      ["PARTICLE_R_SPAN", "PARTICLE_R_SPAN"],
      ["PARTICLE_HALO_PX", "PARTICLE_HALO_PX"],
      ["SPEED_BUCKETS", "SPEED_BUCKETS"],
    ];
    for (const [g, f] of pairs) {
      const gv = constValue(windJs, g), fv = constValue(flat, f);
      expect(fv, "wind-layer.js must define " + f).not.toBeNull();
      expect(gv, "globe-wind.js must define " + g).not.toBeNull();
      expect(gv, g + " drifted from the flat map").toBe(fv);
    }
  });

  test("the three passes are the flat map's, in the flat map's order", () => {
    // The flat map paints, per speed bucket: DARK halo → bloom → core,
    // each as a CONCENTRIC FILLED DISC (since 2026-11-14 — a wide
    // round-capped stroke cost 36.2 ms a frame against 15.3 ms for the
    // same picture as fills, in Firefox). The order is the whole point
    // — a bloom in the dot's own colour can only brighten the ground
    // around it, which is the one thing that cannot help over a bright
    // basemap.
    expect(flat).toMatch(/rgba\(8,12,20,/);
    expect(flat).toMatch(/ctx\.fill\(halo\)/);
    expect(flat).toMatch(/ctx\.fill\(blooms\[sb\]\)/);
    expect(flat).toMatch(/ctx\.fill\(cores\[sb\]\)/);
    expect(flat).toMatch(/base \* 0\.5/);
    expect(flat).toMatch(/base \* 0\.30/);
    expect(flat).toMatch(/fillStyle = paintColor\(repSpeed, base\)/);
    // The globe paints the same three, with the same alphas — the flat
    // map bakes `opacity * 0.9` into `base`, the globe leaves the layer
    // opacity to `globalAlpha` and multiplies here.
    expect(windJs).toMatch(/fillStyle = "rgba\(8,12,20," \+ DOT_HALO_A \+ "\)"/);
    expect(constValue(windJs, "DOT_HALO_A")).toBeCloseTo(0.9 * 0.5, 6);
    expect(constValue(windJs, "DOT_BLOOM_A")).toBeCloseTo(0.9 * 0.30, 6);
    expect(constValue(windJs, "DOT_CORE_A")).toBeCloseTo(0.9, 6);

    // The dark halo comes FIRST on both, and each view reaches the same
    // radii from the same two expressions.
    const halo = windJs.indexOf("DOT_HALO_A");
    const bloom = windJs.indexOf("DOT_BLOOM_A");
    const core = windJs.indexOf("DOT_CORE_A");
    expect(halo).toBeGreaterThan(-1);
    expect(halo).toBeLessThan(bloom);
    expect(bloom).toBeLessThan(core);
    for (const [src, name] of [[flat, "flat map"], [windJs, "globe"]]) {
      expect(src, name + " does not derive the halo radius").toMatch(
        /PARTICLE_HALO_R = PARTICLE_HALO_PX \/ 2/
      );
      expect(src, name + " does not draw the halo at r + PARTICLE_HALO_R")
        .toMatch(/r \+ PARTICLE_HALO_R/);
      expect(src, name + " does not draw the bloom at r + PARTICLE_BLOOM_R")
        .toMatch(/r \+ PARTICLE_BLOOM_R/);
    }
    // …and the flat map strokes NOTHING while drawing a dot — the
    // whole point of the change, and the number it was measured at.
    const flatParticles = flat.match(/function renderParticles\([\s\S]*?\n  \}/);
    expect(flatParticles).toBeTruthy();
    expect(flatParticles[0]).not.toMatch(/ctx\.stroke\(/);
  });

  test("a dot is drawn as a CIRCLE at the particle's own point", () => {
    // Not a line: the whole request is dots rather than "little long
    // pieces". The window is the branch BODY — from the guard to the
    // comment that starts the streak code — so the assertions are about
    // what the particles style actually does, not about what follows it.
    const particlesBranch = windJs.indexOf('state.style === "particles"');
    expect(particlesBranch).toBeGreaterThan(-1);
    const trailCode = windJs.indexOf("The trail, trimmed by LENGTH");
    expect(trailCode).toBeGreaterThan(particlesBranch);
    const branch = windJs.slice(particlesBranch, trailCode);
    expect(branch).toMatch(/ctx\.arc\(pt\.x, pt\.y, r, 0, Math\.PI \* 2\)/);
    expect(branch).toMatch(/ctx\.fill\(\)/);
    // …and it must NOT touch the trail: a dot has no tail, and pushing
    // history here would leave a streak waiting for a switch back.
    expect(branch).not.toMatch(/p\.hist\.push/);
    // It still has to move the particle, or the field freezes…
    expect(branch).toMatch(/p\.lat = nLat/);
    expect(branch).toMatch(/p\.lng = nLng/);
    // …and CONTINUE, or it falls through into the streak code below and
    // the reader gets a dot with a tail — the "little long pieces"
    // again, attached.
    expect(branch).toMatch(/continue;/);
    // …and it must come BEFORE the streak code, or the streak wins.
    expect(particlesBranch).toBeLessThan(windJs.indexOf("p.hist.push(pt.x, pt.y)"));
  });

  test("the radius grows with the speed, bounded by the ramp's top", () => {
    const branch = windJs.slice(windJs.indexOf('state.style === "particles"'),
                                 windJs.indexOf('state.style === "particles"') + 1600);
    expect(branch).toMatch(/PARTICLE_R_MIN \+ PARTICLE_R_SPAN \* frac/);
    // `frac` is min(1, sp/maxMs) — already clamped above the branch, so
    // a hurricane cannot draw a dot the size of the screen.
    expect(windJs).toMatch(/const frac = Math\.min\(1, sp \/ maxMs\)/);
  });

  test("the style comes from the LINK first, then the reader's own choice", () => {
    // A shared link's `wind=particles:speed` must win: the hash is the
    // promise "share the exact map", and it is the route the owner's
    // own URL takes (globe.js keeps the segment — see
    // GLOBE_OWNED_PREFIXES, which does not list `wind=`).
    const read = windJs.slice(windJs.indexOf("function readStyle"),
                              windJs.indexOf("function readStyle") + 900);
    expect(read).toMatch(/location\.hash/);
    expect(read).toMatch(/wind=\(\[\^:\/\]\+\)/);
    expect(read.indexOf("location.hash")).toBeLessThan(read.indexOf("localStorage"));
    // …and both are validated against the flat map's own list, so a
    // hand-edited link cannot ask for a style that does not exist.
    expect(read).toMatch(/STYLE_CHOICES\.indexOf\(s\) >= 0/);
    expect(read).toMatch(/STYLE_CHOICES\.indexOf\(v\) >= 0/);
    expect(windJs).toMatch(/const DEFAULT_STYLE = "streamlines"/);
    // The four ids must be the flat map's four. The flat map's list is
    // an array of OBJECTS (`{ id, label, hint }`) and the globe's is a
    // bare array of strings, so compare the extracted ids — comparing
    // the raw text would only prove the two files are formatted
    // differently.
    const flatBlock = flat.slice(flat.indexOf("const STYLE_CHOICES"),
                                 flat.indexOf("const DEFAULT_STYLE"));
    const flatIds = [...flatBlock.matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    const globeBlock = windJs.match(/const STYLE_CHOICES = \[([^\]]+)\]/);
    expect(globeBlock, "globe STYLE_CHOICES").not.toBeNull();
    const globeIds = [...globeBlock[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(flatIds.length, "wind-layer.js STYLE_CHOICES").toBe(4);
    expect(globeIds).toEqual(flatIds);
    expect(windJs).toMatch(/const DEFAULT_STYLE = "streamlines"/);
  });

  test("only the WIND reads the style — the currents keep their own", () => {
    // `wind=` describes the wind. The globe's ocean-currents animation
    // shares this engine, and the flat map's currents have their own
    // chips and their own default; one segment must not restyle two
    // overlays.
    expect(windJs).toMatch(/style: sourceName === "wind" \? readStyle\(\) : DEFAULT_STYLE/);
  });

  test("switching style drops the streak history", () => {
    // A dot has no tail. If hist survives the switch, the first frame
    // back on streamlines draws one long line across the planet from
    // the accumulated path.
    const setStyle = windJs.slice(windJs.indexOf("function setStyle"),
                                  windJs.indexOf("function setStyle") + 900);
    expect(setStyle).toMatch(/state\.particles\[i\]\.hist\.length = 0/);
    expect(setStyle).toMatch(/STYLE_CHOICES\.indexOf\(id\) < 0/);
    expect(windJs).toMatch(/setStyle: setStyle/);
    expect(windJs).toMatch(/getStyle: \(\) => state\.style/);
  });

  test("the constants are exported for the parity check, not just commented", () => {
    expect(windJs).toMatch(/PARTICLES:\s*\{/);
    expect(windJs).toMatch(/R_MIN: PARTICLE_R_MIN/);
    expect(windJs).toMatch(/HALO_PX: PARTICLE_HALO_PX/);
    expect(windJs).toMatch(/readStyle: readStyle/);
  });
});
