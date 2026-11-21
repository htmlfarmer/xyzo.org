// wind-paint-containment.bun.test.js — why the wind pane must NOT be
// given a `contain` property, and what anyone who re-proposes one owes.
//
// THE BUG (owner report, 2026-11-20): *"i dont see the wind working now?"*
//
// `contain: paint` had been added to the wind pane as a compositing fix
// for the earlier *"the wind dots don't move around very fast"* report.
// It hid the wind completely, and the fps number it produced looked
// like a triumph:
//
//     Firefox   as shipped:  51.3 fps,      58 wind px   <-- invisible
//     Firefox   no contain:  24.5 fps,  34,954 wind px
//     Chromium  as shipped:  51.6 fps,       0 wind px   <-- invisible
//     Chromium  no contain:  22.3 fps,  33,948 wind px
//
// **THE 51 fps WAS FAST BECAUSE NOTHING WAS BEING DRAWN.** Every
// Leaflet pane is 0 × 0 (its children are absolutely positioned, so it
// has no intrinsic size), and paint containment clips painting to the
// padding box — so a 0 × 0 pane clips its contents to nothing.
// `contain: strict` had been correctly rejected for the same reason
// (size containment *forces* the pane to 0 × 0); `paint` clipped to
// 0 × 0 too, because the pane was *already* 0 × 0.
//
// THE TRAP THIS FILE EXISTS TO CLOSE: the previous version of these
// tests asserted that `pane.style.contain = "paint"` **appears in the
// source**. That is a gate which passes against code that hides the
// wind — it pins the bug in place. It also recorded the fps numbers
// (9.0 → 32.3) without ever counting a pixel, which is exactly the
// pairing AGENTS.md forbids for this renderer: *"any future 'make it
// faster' change to this renderer therefore needs a pixel/geometry
// check beside the fps number."*
//
// The file's own comment had also spotted the right mechanism and
// drawn the wrong conclusion from it: it rejected `strict` because the
// pane would become 0 × 0 and *"the wind would vanish"* — not noticing
// that the pane already IS 0 × 0.
//
// So: the containment line must be GONE, the measurement that killed it
// must be IN THE SOURCE beside where it used to be, and the good parts
// of the original diagnosis (the compositing theory, the rejected
// alternatives) are kept because they are still the best explanation of
// the slow-wind report and the next person will reach for them first.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const windJs = readFileSync(join(ROOT, "wind-layer.js"), "utf8");

/** The block that used to carry the containment line: from the pane's
 *  creation to the canvas's. Everything about the wind pane's styling
 *  lives in there. */
function paneBlock() {
  const start = windJs.indexOf('const pane = map.getPane("windPane");');
  expect(start, "wind pane creation not found").toBeGreaterThan(-1);
  const end = windJs.indexOf("if (!state.canvas)", start);
  expect(end, "canvas creation not found").toBeGreaterThan(start);
  // These are PROSE assertions about a COMMENT, so read it as prose:
  // strip the `//` markers (they otherwise land mid-sentence — "wind
  // working now" — and fail an assertion the text satisfies), then
  // collapse the wrapping. A sentence that wraps must not fail a test
  // it satisfies.
  return windJs
    .slice(start, end)
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("the wind pane carries no `contain` property", () => {
  test("containment is NOT set on the pane", () => {
    // THE FIX. `contain: paint` on a 0 × 0 pane clips the wind to
    // nothing: 58 px on screen in Firefox, 0 px in Chromium, while the
    // fps read 51 — fast because nothing was drawn.
    expect(paneBlock()).not.toMatch(/pane\.style\.contain\s*=/);
  });

  test("…and not anywhere else in the file either", () => {
    // A stray `contain` on the canvas or on a wrapper would hide the
    // wind just as effectively and is just as unmeasurable by fps.
    // Only comments may mention it.
    const code = windJs
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/\.style\.contain\s*=/);
    expect(code).not.toMatch(/contain\s*:\s*["'](paint|strict|size|content|layout|style)["']/);
  });

  test("no `strict` / `size` / `content` containment either", () => {
    // The original rejection of these was right, for the reason above.
    expect(windJs).not.toMatch(/contain\s*=\s*"strict"/);
    expect(windJs).not.toMatch(/contain\s*=\s*"content"/);
    expect(windJs).not.toMatch(/contain\s*=\s*"size"/);
  });
});

describe("the pane keeps its place in the stack", () => {
  test("z-index 379, under the pins at 400", () => {
    const block = paneBlock();
    expect(block).toMatch(/zIndex\s*=\s*"379"/);
    expect(block).toMatch(/pointerEvents\s*=\s*"none"/);
  });

  test("the pane is still created and the canvas still anchored to it", () => {
    // Removing containment must not disturb the pane-anchor dance:
    // `anchorCanvas()` re-anchors on every pan or the whole field
    // sits paneOffset away from its geography (the 2026-10-29 bug).
    expect(windJs).toMatch(/map\.getPane\("windPane"\)/);
    expect(windJs).toMatch(/function anchorCanvas\(\)/);
    expect(windJs).toMatch(/containerPointToLayerPoint\(\[0,\s*0\]\)/);
  });
});

describe("the measurement that killed it is recorded at the site", () => {
  test("the fps AND the pixel count are written down together", () => {
    // The whole failure was an fps number with no pixel count beside
    // it. Both halves must be in the source, next to the line that
    // used to be there, or the next reader sees only "51 fps" and
    // re-adds it.
    const block = paneBlock();
    expect(block).toMatch(/51\.3 fps/);
    expect(block).toMatch(/58 wind px/);
    expect(block).toMatch(/34,954 wind px/);
    expect(block).toMatch(/51\.6 fps/);
    expect(block).toMatch(/33,948 wind px/);
  });

  test("the owner's report is quoted where the fix is", () => {
    expect(paneBlock()).toMatch(/i dont see the wind working now/i);
  });

  test("the zero-sized pane is explained — the mechanism, not just the symptom", () => {
    const block = paneBlock();
    // Every Leaflet pane is 0 × 0: this is the fact that makes ANY
    // containment on a pane dangerous, and it is the fact the original
    // analysis had hold of before drawing the wrong conclusion.
    expect(block).toMatch(/EVERY LEAFLET PANE IS 0 × 0/);
    expect(block).toMatch(/clips its contents to \*\*nothing\*\*/);
  });

  test("what a re-proposal must prove: fps AND non-zero pixels, in one run", () => {
    const block = paneBlock();
    expect(block).toMatch(/size\s+the\s+pane\s+to\s+the\s+viewport\s+FIRST/i);
    expect(block).toMatch(/the\s+fps\s+number\s+AND\s+a\s+non-zero\s+screen-pixel\s+count/i);
    // …and the honest caveat: with the wind actually drawn, containment
    // measured no benefit at all.
    expect(block).toMatch(/14\.4 fps/);
    expect(block).toMatch(/14\.7 fps/);
  });

  test("the rejected alternatives are still recorded", () => {
    // `will-change: transform` / `translateZ(0)` are the obvious next
    // guesses and they do not work. Say so before someone tries.
    const block = paneBlock();
    expect(block).toMatch(/will-change/i);
    expect(block).toMatch(/translateZ/i);
  });
});

describe("the wind actually draws", () => {
  // The guard that the fps number alone could never be: if the canvas
  // stops being cleared and filled, the wind is fast because it is
  // invisible — the exact failure this file documents.
  test("the canvas is still cleared every frame", () => {
    expect(windJs).toMatch(/ctx\.clearRect\(0,\s*0,\s*size\.x,\s*size\.y\)/);
  });

  test("the marks are still filled every frame", () => {
    expect(windJs).toMatch(/ctx\.fill\(cores\[sb\]\)/);
  });

  test("the adaptive quality guard is still in place", () => {
    expect(windJs).toMatch(/state\.lastFps < 40 && state\.qscale > 0\.4/);
    expect(windJs).toMatch(/state\.lastFps > 56 && state\.qscale < 1/);
  });

  test("the canvas is still a real, sized canvas", () => {
    // A 0 × 0 canvas would draw nothing and be invisible for the same
    // reason the pane clipped it — guard the geometry too. The backing
    // store is sized from the map's own size in resize().
    expect(windJs).toMatch(/c\.className = "wind-canvas"/);
    expect(windJs).toMatch(/canvas\.width\s*=\s*Math\.round\(size\.x \* state\.dpr\)/);
    expect(windJs).toMatch(/canvas\.height\s*=\s*Math\.round\(size\.y \* state\.dpr\)/);
    // …and it is resized on every map resize, or it drifts off the
    // geography the same way an un-re-anchored canvas does.
    expect(windJs).toMatch(/function anchorCanvas\(\)/);
  });
});

describe("the pixel check exists as an instrument, not just as prose", () => {
  // AGENTS.md's rule for this renderer: a pixel/geometry check beside
  // every fps number. The rule is only real if a script enforces it.
  const audit = readFileSync(
    join(ROOT, "..", "scripts", "wind_perf_audit.py"),
    "utf8",
  );

  test("the wind perf audit counts SCREEN pixels for the wind pane", () => {
    // Screenshot-diff with the pane hidden and re-shown isolates the
    // wind's own pixels. Reading the canvas with getImageData does NOT
    // work — the backing store keeps its ink while the pane clips it
    // away, which is how "the canvas ink is unchanged" coexisted with a
    // wind nobody could see.
    expect(audit).toMatch(/wind_px|screenshot|pixel/i);
  });

  test("the audit refuses to report an fps gain with no pixels", () => {
    // The gate: a run that speeds up while drawing nothing must FAIL,
    // not be published as a win.
    expect(audit).toMatch(/invisible|no wind pixels|zero pixels|drawn/i);
  });
});
