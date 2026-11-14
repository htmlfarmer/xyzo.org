// wind-slow-devices.bun.test.js — what the wind does on a device that
// cannot keep up, and how the reader is told.
//
// Owner report (2026-11-14): *"the wind dots don't move around very
// fast on Firefox"* on a fifteen-overlay link. Measured on that exact
// URL (scripts/wind_perf_audit.py, reports/wind_perf_baseline.json):
//
//     firefox  3.7–6.5 fps · dots 15.6 px/s   (39 px/s at 17 fps)
//     chromium 3.6–6.0 fps · dots 13.3 px/s
//
// THREE defects, THREE pins:
//
//   1. `step()` capped dt at 0.1 s — below 10 fps the animation threw
//      away the rest of every second, so a 4 fps device ran the field
//      at 40 % of real speed. The cap is 0.25 s now (real-time pace
//      down to 4 fps, still bounded so a stall cannot slash a trail
//      across the map).
//   2. The Flow style advanced its fibres PER FRAME (`step` px/frame
//      with no dt), and aged them per frame too — the same defect in
//      the same file. Both are dt-scaled now.
//   3. The particles were drawn with two wide round-capped STROKES per
//      bucket — the most expensive call this layer makes (36.2 ms a
//      frame at 1,234 dots in Firefox, against 15.3 ms for the same
//      picture as concentric fills). They are fills now.
//
// …and the reader gets the number: the legend prints the frame rate it
// is actually managing next to the dot count, and offers the fix while
// it is slow.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const windJs = readFileSync(join(ROOT, "wind-layer.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

// Run the module against stubs so the physics can be asserted rather
// than grepped for. It needs window/localStorage/document/L at load.
let W = null;
beforeAll(() => {
  const win = { localStorage: { getItem: () => null, setItem: () => {} } };
  win.window = win;
  const factory = new Function(
    "window", "localStorage", "document", "location", "navigator", windJs
  );
  factory(win, win.localStorage, undefined, { hash: "" }, { maxTouchPoints: 0 });
  W = win.WindLayer;
});

function bodyOf(fnName) {
  const m = windJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`));
  expect(m, `${fnName} not found`).toBeTruthy();
  return m[0];
}

// ── 1. the dt cap ──────────────────────────────────────────────────────
describe("the dt cap keeps the field at real speed", () => {
  test("the cap is 0.25 s and step() applies it", () => {
    expect(windJs).toMatch(/const MAX_DT_S = 0\.25;/);
    expect(windJs).toMatch(
      /Math\.min\(\(now - state\.lastT\) \/ 1000, MAX_DT_S\)/
    );
    // The old value, and any other single-tenth cap, is the bug: it
    // turns the animation into a slideshow AND a crawl at once.
    expect(windJs).not.toMatch(/\/ 1000, 0\.1\)/);
  });

  test("…but it still bounds a stall: never more than a third of a second", () => {
    const cap = Number(windJs.match(/const MAX_DT_S = ([\d.]+);/)[1]);
    expect(cap).toBeGreaterThan(0.1);
    // A tab frozen for two seconds must step the field forward by a
    // bounded amount — at the target 69 px/s, 0.25 s is ~17 px, a
    // step rather than a slash across the map.
    expect(cap).toBeLessThanOrEqual(0.3);
  });

  test("motion is proportional to dt, so a bigger cap IS a faster field", () => {
    // 15.6 px/s measured at 4 fps against 39 px/s at 17 fps is exactly
    // the ratio the cap imposes (0.1 s / 0.25 s frames). This asserts
    // the physics the cap relies on: distance grows linearly with the
    // time step, so handing the frame the time it really took restores
    // the pace.
    //
    // The module's grid is stubbed here (1 m/s due east over a 2×2
    // cell) because `sample()` returns null on an unloaded layer and
    // `_advance()` would answer null for every call.
    const st = typeof W._state === "function" ? W._state() : W._state;
    st.scale = 100;
    st.meta = { grid: { rows: 2, cols: 2, lat_min: 0, lat_max: 1,
                        lon_min: 0, lon_step: 1, lat_step: 1 } };
    st.n = 4;
    st.u = new Int16Array([100, 100, 100, 100]);   // 1 m/s eastward
    st.v = new Int16Array([0, 0, 0, 0]);
    st.speedScale = 1 / 111320;

    const a = W._advance(0.5, 0.5, 0.0625);
    const b = W._advance(0.5, 0.5, 0.25);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(b.metres).toBeGreaterThan(a.metres * 3.9);
    expect(b.metres).toBeLessThan(a.metres * 4.1);
    // And it goes EAST, which is what the easterly u is for — a sign
    // flip here would make "faster" mean "backwards".
    expect(b.lng).toBeGreaterThan(a.lng);
  });
});

// ── 2. the flow renderer's per-frame constants ─────────────────────────
describe("the flow style advances per second, not per frame", () => {
  test("the streaklet step is scaled by dt and bounded", () => {
    const flow = bodyOf("renderFlow");
    expect(flow).toMatch(/FLOW_SEG_PX \* clamp\(sp \/ MEAN_SPEED_MS, 0\.25, 3\) \*/);
    expect(flow).toMatch(/Math\.min\(3, dt \* 60\)/);
  });

  test("a fibre's lifetime is wall-clock, not frames", () => {
    const flow = bodyOf("renderFlow");
    expect(flow).toMatch(/s\.age \+= dt \* 60;/);
    expect(flow).not.toMatch(/s\.age \+= 1;/);
    // The fade itself was already dt-scaled; if it ever regresses the
    // low-fps flow would pile fibres up and grey out the map.
    expect(flow).toMatch(/FLOW_FADE \* Math\.min\(3, dt \* 60\)/);
  });
});

// ── 3. the particles are FILLED, not stroked ───────────────────────────
describe("the dot is painted as concentric discs", () => {
  test("renderParticles strokes nothing and fills its three rings", () => {
    const particles = bodyOf("renderParticles");
    expect(particles).not.toMatch(/ctx\.stroke\(/);
    expect(particles).toMatch(/ctx\.fill\(halo\)/);
    expect(particles).toMatch(/ctx\.fill\(blooms\[sb\]\)/);
    expect(particles).toMatch(/ctx\.fill\(cores\[sb\]\)/);
    // The measurement this fix is worth, kept next to the code (the
    // comment sits with the ring constants, ABOVE the function, so the
    // file is what carries it):
    // 36.2 ms → 15.3 ms a frame at 1,234 dots (Firefox), stroke() was
    // 80 % of the layer's canvas time.
    expect(windJs).toMatch(/36\.2 ms/);
    expect(windJs).toMatch(/80 % of every frame/);
  });

  test("the three discs are concentric — halo widest, core exactly the dot", () => {
    const particles = bodyOf("renderParticles");
    expect(particles).toMatch(/r \+ PARTICLE_HALO_R/);
    expect(particles).toMatch(/r \+ PARTICLE_BLOOM_R/);
    // …and the radii are DERIVED from the ring widths the stroked
    // version used, so the picture does not change with the technique.
    expect(windJs).toMatch(/const PARTICLE_HALO_R = PARTICLE_HALO_PX \/ 2/);
    expect(windJs).toMatch(/const PARTICLE_BLOOM_R = \(PARTICLE_HALO_PX - 0\.8\) \/ 2/);
  });

  test("every ring is still painted dark → bloom → core, in that order", () => {
    const particles = bodyOf("renderParticles");
    const dark = particles.indexOf('rgba(8,12,20,');
    const bloom = particles.indexOf("ctx.fill(blooms[sb])");
    const core = particles.indexOf("ctx.fill(cores[sb])");
    expect(dark).toBeGreaterThan(-1);
    expect(bloom).toBeGreaterThan(dark);
    expect(core).toBeGreaterThan(bloom);
  });
});

// ── 4. the reader is told, and told how to fix it ──────────────────────
describe("the legend reports the frame rate and offers the fix", () => {
  test("the readout carries the live fps of an ANIMATED style", () => {
    expect(windJs).toMatch(/const animated = state\.style !== "arrows";/);
    // Arrows do not animate: a fps there would only print the display
    // refresh rate and mislead the reader into thinking all is well.
    expect(windJs).toMatch(/\(animated && state\.lastFps > 0 \? " · " \+ state\.lastFps \+ " fps" : ""\)/);
  });

  test("the fps is refreshed from step()'s once-a-second block", () => {
    // Not from a timer of its own — the layer already measures fps
    // there, and a second clock would drift against the first.
    const step = windJs.match(/function step\(now\) \{[\s\S]*?\n  \}/);
    expect(step).toBeTruthy();
    expect(step[0]).toMatch(/paintDensityReadout\(\);/);
  });

  test("below 30 fps the legend says so and names both levers", () => {
    expect(windJs).toMatch(/const SLOW_FPS = 30;/);
    expect(windJs).toMatch(/Slow here — turn overlays off or lower the density for smoother motion\./);
    // The tip must be able to go AWAY — a hint that stays after the
    // reader has acted is worse than no hint.
    expect(windJs).toMatch(/hint\.classList\.toggle\("is-on", slow\)/);
    expect(windJs).toMatch(/msg = slow/);
    // …and the element it writes to exists in the legend markup.
    expect(windJs).toMatch(/id="wind-perf-hint"/);
  });

  test("the tip is legible on the panel: ≥11px and a passing grey", () => {
    // scripts/legend_contrast_check.py fails anything under 4.5:1 or
    // 11 px on the layers dropdown's white — a tip nobody can read is
    // not a tip.
    const m = stylesCss.match(/\.wind-perf-hint \{([^}]*)\}/);
    expect(m, ".wind-perf-hint missing from styles.css").toBeTruthy();
    const decl = m[1];
    const px = Number((decl.match(/font-size:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
    expect(px).toBeGreaterThanOrEqual(11);
    const hex = (decl.match(/color:\s*(#[0-9a-fA-F]{6})/) || [])[1];
    expect(hex).toBeTruthy();
    const lum = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    expect(Number((1.05 / (L + 0.05)).toFixed(2))).toBeGreaterThanOrEqual(4.5);
    // …and it only shows when it has something to say.
    expect(stylesCss).toMatch(/\.wind-perf-hint \{[^}]*display:\s*none/s);
    expect(stylesCss).toMatch(/\.wind-perf-hint\.is-on \{[^}]*display:\s*block/s);
  });
});
