// hover-ring.bun.test.js — the mouse pointer must work on EVERYTHING,
// not only on the story pins.
//
// The bugs this pins, all found by scripts/hover_audit.py (a Playwright
// study of the real pointer):
//
//  1. **THE RING WAS THE PIN RENDERER'S PRIVATE ELEMENT.** The
//     earthquakes, the faults and the language regions had no ring at
//     all — pointing at one showed nothing, and the reader had no way
//     to tell what was under the cursor. There is now ONE ring
//     (public_html/hover-ring.js) and every point overlay asks it to
//     move, so there is never more than one circle under the cursor.
//
//  2. **A LEAFLET CANVAS RENDERER SILENTLY SWALLOWED THE POINTER.**
//     `L.canvas()` puts its container in the DEFAULT overlay pane —
//     which is exactly where the STORY PIN canvas lives. The renderer
//     was therefore appended AFTER the pin canvas and sat ON TOP of
//     it, and because it is a full-map element with pointer-events
//     auto it swallowed every pointer event over the map. The pins'
//     own hover (the ring, the card) died the moment the earthquakes
//     or the language points were switched on. The renderer must be
//     told its pane, and the pane is pointer-events: none.
//
//  3. **THE CARD ONLY KNEW ABOUT PINS.** It now takes a generic
//     TARGET from any layer.
//
//  4. **THE GLOBE HAD NO RING**, and its first attempt used a
//     map-wide queryRenderedFeatures, which does not report the
//     features under the cursor on a sphere. It uses the LAYER's own
//     mouse event instead.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const ringJs = readFileSync(join(ROOT, "hover-ring.js"), "utf8");
const hudJs = readFileSync(join(ROOT, "hover-info.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const quakeJs = readFileSync(join(ROOT, "earthquake-layer.js"), "utf8");
const langJs = readFileSync(join(ROOT, "languages-layer.js"), "utf8");
const faultJs = readFileSync(join(ROOT, "fault-layer.js"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");

describe("there is ONE ring", () => {
  test("hover-ring.js owns the element", () => {
    expect(ringJs).toMatch(/window\.HoverRing\s*=/);
    for (const fn of ["show", "hide", "el", "isVisible"]) {
      expect(ringJs).toContain(fn + ":");
    }
  });

  test("the pin renderer uses the SHARED element, not one of its own", () => {
    // It must not create a second element with the same class: two
    // elements would mean two circles could be on screen at once, and
    // a query for ".xyzo-pin-hover-ghost" could find the wrong one.
    expect(appJs).toMatch(/window\.HoverRing\.el\(this\._map\)/);
    expect(appJs).toMatch(/window\.HoverRing\.show\(/);
    expect(appJs).toMatch(/window\.HoverRing\.hide\("pin"\)/);
  });

  test("the ring is pointer-events: none, so it can never eat a click", () => {
    // The CSS rule, not the JS.
    const css = readFileSync(join(ROOT, "styles.css"), "utf8");
    const block = css.slice(css.indexOf(".xyzo-pin-hover-ghost {"));
    expect(block.slice(0, 400)).toMatch(/pointer-events:\s*none/);
  });
});

describe("no canvas renderer may swallow the pointer", () => {
  test("every L.canvas() is told which pane it lives in", () => {
    // A renderer without a pane lands in the overlay pane — on top of
    // the story pins — and takes every pointer event on the map.
    for (const [name, src] of [["earthquake-layer.js", quakeJs], ["languages-layer.js", langJs], ["fault-layer.js", faultJs]]) {
      const calls = [...src.matchAll(/L\.canvas\(\{([^}]*)\}\)/g)];
      expect(calls.length, name + " must have a canvas renderer").toBeGreaterThan(0);
      for (const c of calls) {
        expect(c[1], name + ": L.canvas() must name its pane").toMatch(/pane:\s*[A-Z_]+/);
      }
    }
  });

  test("the layers' panes are pointer-events: none", () => {
    for (const [name, src] of [["earthquake-layer.js", quakeJs], ["languages-layer.js", langJs], ["fault-layer.js", faultJs]]) {
      expect(src, name).toMatch(/pane\.style\.pointerEvents\s*=\s*"none"/);
    }
  });
});

describe("the card can say what is under the cursor", () => {
  test("the HUD takes a generic target from any layer", () => {
    expect(hudJs).toMatch(/function setTarget\(/);
    expect(hudJs).toMatch(/function clearTarget\(/);
    expect(hudJs).toMatch(/setTarget: setTarget/);
    expect(hudJs).toMatch(/clearTarget: clearTarget/);
  });

  test("the card shows the target even in the default 'pins' mode", () => {
    // Before, "pins" mode showed the card only over a story pin, so
    // hovering an earthquake showed nothing at all.
    expect(hudJs).toMatch(/state\.mode === "pins" && !state\.pin && !state\.target/);
    expect(hudJs).toMatch(/if \(state\.target\) parts\.push\(targetBlock\(state\.target\)\)/);
  });

  test("the earthquakes push a target and move the ring", () => {
    expect(quakeJs).toMatch(/HoverInfo\.setTarget\(/);
    expect(quakeJs).toMatch(/HoverRing\.show\(/);
    expect(quakeJs).toMatch(/map\.on\("mousemove", onMouseMove\)/);
  });

  test("the earthquake age is the AGE, not the timestamp", () => {
    // relativeAge() takes an AGE in ms. Handing it props.time (the
    // epoch) printed "20761 d ago" — the time since 1970.
    expect(quakeJs).toMatch(/relativeAge\(ageOf\(props\)\)/);
    expect(quakeJs).not.toMatch(/relativeAge\(props\.time\)/);
  });
});

describe("the globe has a ring too", () => {
  test("the ring follows the hovered pin", () => {
    expect(globeJs).toMatch(/pin-hover-ring/);
    // The LAYER's own mouse event: a map-wide queryRenderedFeatures
    // does not report the features under the cursor on a sphere.
    expect(globeJs).toMatch(/map\.on\("mousemove", "pins"/);
    expect(globeJs).toMatch(/setHoverRing\(e\.features && e\.features\.length \? e\.features\[0\] : null\)/);
  });
});

describe("the audit script exists", () => {
  test("scripts/hover_audit.py measures the pointer", () => {
    const py = readFileSync(join(ROOT, "..", "scripts", "hover_audit.py"), "utf8");
    expect(py).toMatch(/elementFromPoint/);
    expect(py).toMatch(/HoverRing/);
    expect(py).toMatch(/hover-hud/);
  });
});
