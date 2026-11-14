// isobar-layer.bun.test.js — the "⛅ Pressure lines (isobars)" layer.
//
// The isobars are drawn from vector lines that worker/isobars.py
// contours out of the NOAA NCEP GFS pressure analysis. There is no free
// isobar tile service, so the layer is a polylines overlay rather than
// an L.tileLayer.
//
// The switch is a plain checkbox in the Leaflet layers dropdown, listed
// under the BASE layers.
//
// The trap this test guards: Leaflet's Control.Layers._update() empties
// BOTH `.leaflet-control-layers-base` and `.leaflet-control-layers-overlays`
// and rebuilds them from scratch on every layer change. A checkbox
// injected as a CHILD of the base list is therefore wiped by the first
// overlay toggle or base-layer switch. The row has to be injected into
// `.leaflet-control-layers-list` — the parent of the base list — right
// after the base list.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const isobarJs = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
const opacityJs = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const workerPy = readFileSync(join(ROOT, "..", "worker", "isobars.py"), "utf8");

describe("isobar layer — module", () => {
  test("the module is loaded before app.js and exposes the API app.js needs", () => {
    const isobarIdx = indexHtml.indexOf("isobar-layer.js");
    const appIdx = indexHtml.indexOf("app.js?");
    expect(isobarIdx).toBeGreaterThan(-1);
    expect(appIdx).toBeGreaterThan(-1);
    // app.js calls IsobarLayer.init(map) — the module has to be there.
    expect(isobarIdx).toBeLessThan(appIdx);

    expect(isobarJs).toMatch(/window\.IsobarLayer\s*=/);
    expect(isobarJs).toMatch(/init,/);
    expect(isobarJs).toMatch(/setEnabled,/);
    expect(isobarJs).toMatch(/isEnabled,/);
    expect(isobarJs).toMatch(/setOpacity,/);
  });

  test("it fetches the isobars from the API, not a tile service", () => {
    expect(isobarJs).toMatch(/\/api\/weather\/isobars/);
    // A tile layer would be wrong — the lines are vectors.
    expect(isobarJs).not.toMatch(/L\.tileLayer/);
    expect(isobarJs).toMatch(/L\.polyline/);
  });

  test("the lines live in their own pane, above the climate wash and below the pins", () => {
    expect(isobarJs).toMatch(/createPane\("isobarPane"\)/);
    // climatePane is 350, the pin canvas (overlayPane) is 400.
    expect(isobarJs).toMatch(/isobarPane"\)\.style\.zIndex = "360"/);
  });

  test("labels are placed in screen space and re-placed when the view changes", () => {
    // The contour vertices sit on the 1° analysis grid, so the length
    // test has to use the WHOLE line, not one segment.
    expect(isobarJs).toMatch(/latLngToContainerPoint/);
    expect(isobarJs).toMatch(/drawLabels/);
    // The label angle follows the line.
    expect(isobarJs).toMatch(/atan2/);
  });
});

describe("isobar layer — layers dropdown", () => {
  test("the checkbox is injected into the dropdown", () => {
    expect(appJs).toMatch(/function mountIsobarRow\(\)/);
    expect(appJs).toMatch(/ctrl-isobars-toggle/);
    expect(appJs).toMatch(/mountIsobarRow\(\);/);
  });

  test("the row is a SIBLING of the base list, never a child of it", () => {
    // Leaflet rebuilds the base list on every layer change.
    expect(appJs).toMatch(/base\.insertAdjacentElement\("afterend", row\)/);
    expect(appJs).not.toMatch(/base\.appendChild\(row\)/);
    // It goes into the list container, which Leaflet never empties.
    expect(appJs).toMatch(/\.leaflet-control-layers-list/);
  });

  test("the row is placed directly under the base layers", () => {
    expect(appJs).toMatch(/querySelector\("\.leaflet-control-layers-base"\)/);
  });

  test("the row is not a floating panel over the map", () => {
    expect(indexHtml).not.toMatch(/ctrl-isobars-toggle/);
  });

  test("the isobar row gets an opacity slider like every other overlay", () => {
    expect(opacityJs).toMatch(/function mountRow\(/);
    expect(opacityJs).toMatch(/window\.OverlayOpacity = \{[^}]*mount[^}]*restore[^}]*mountRow/);
    expect(appJs).toMatch(/OverlayOpacity\.mountRow\(/);
  });
});

describe("isobar layer — URL hash", () => {
  test("the layer round-trips through the URL hash", () => {
    expect(appJs).toMatch(/ISOBAR_LAYER_NAME/);
    expect(appJs).toMatch(/"isobars": ISOBAR_LAYER_NAME/);
    // It is added to the active-overlay set so getMapHash() emits it.
    expect(appJs).toMatch(/_activeOverlayNames\.add\(ISOBAR_LAYER_NAME\)/);
  });

  test("the state persists in localStorage", () => {
    expect(isobarJs).toMatch(/xyzo\.isobarLayer/);
  });
});

describe("isobar layer — styling", () => {
  test("the label has a style", () => {
    expect(stylesCss).toMatch(/\.xyzo-isobar-label/);
  });
});

describe("isobar layer — labels", () => {
  test("a label is placed along a line, not once per polyline", () => {
    // A single isobar arrives as many short chains. One label per chain
    // stamped "1020" twelve times in a row on one line.
    expect(isobarJs).toMatch(/LABEL_SPACING_PX/);
    expect(isobarJs).toMatch(/for \(let d = first; d <= c\.total; d \+= LABEL_SPACING_PX\)/);
  });

  test("a chain shorter than half a spacing still gets a label", () => {
    // Otherwise a fragmented isobar goes unlabelled altogether.
    expect(isobarJs).toMatch(/Math\.min\(LABEL_SPACING_PX \/ 2, c\.total \/ 2\)/);
  });

  test("labels of the same value are de-duplicated by distance", () => {
    expect(isobarJs).toMatch(/LABEL_MIN_GAP_PX/);
    expect(isobarJs).toMatch(/p\.level === level/);
  });

  test("only lines that are actually on screen are labelled", () => {
    // Ranking by on-screen length, not total length, so a line that is
    // mostly off-screen does not eat the label budget.
    expect(isobarJs).toMatch(/visible \+= seg/);
    expect(isobarJs).toMatch(/candidates\.sort\(\(a, b\) => b\.visible - a\.visible\)/);
    // And labels are kept clear of the viewport edge.
    expect(isobarJs).toMatch(/LABEL_VIEWPORT_PAD_PX/);
  });

  test("the label angle is kept upright", () => {
    expect(isobarJs).toMatch(/if \(angle > 90\) angle -= 180/);
  });
});

describe("isobar layer — data source", () => {
  test("the worker uses NOAA NCEP GFS, not a key-based API", () => {
    expect(workerPy).toMatch(/nomads\.ncep\.noaa\.gov/);
    expect(workerPy).toMatch(/PRMSL/);
    // The worker publishes the FINEST of the eight detail steps the UI
    // offers (0.1 / 0.25 / 0.5 / 1 / 2 / 4 / 8 / 16) — and cuts at 0.05
    // hPa, the GCD of that ladder, so every step divides into the one
    // lattice and the API thins ONE dataset instead of holding two
    // copies of it. 4 hPa — the synoptic-chart standard — is still
    // reproducible exactly, because the contour of a given level does
    // not depend on the interval used to enumerate the levels.
    expect(workerPy).toMatch(/ISO_INTERVAL_HPA = 0\.05/);
  });

  test("the worker imports psycopg before eccodes", () => {
    // Loaded in the wrong order the interpreter segfaults at exit and
    // systemd records a successful run as a failure.
    const psycopgIdx = workerPy.indexOf("from .db import connect");
    const eccodesIdx = workerPy.indexOf("import eccodes");
    expect(psycopgIdx).toBeGreaterThan(-1);
    expect(eccodesIdx).toBeGreaterThan(-1);
    expect(psycopgIdx).toBeLessThan(eccodesIdx);
  });
});

describe("isobar layer — HUD sampling", () => {
  function loadIsobars() {
    const win = {};
    const fn = new Function("window", isobarJs);
    fn(win);
    return win.IsobarLayer;
  }

  test("sampleAt reports the nearest isobar when nothing else is near", () => {
    const layer = loadIsobars();
    layer._state.enabled = true;
    layer._state.items = [
      { level_hpa: 1008, coordinates: [[0, 0], [1, 0]] },
    ];
    // Sitting exactly on the line: the reading IS the line's level.
    expect(layer.sampleAt({ lat: 0, lng: 0.5 })).toBe("1008 hPa");
  });

  test("sampleAt interpolates between two bracketing levels", () => {
    const layer = loadIsobars();
    layer._state.enabled = true;
    layer._state.items = [
      { level_hpa: 1000, coordinates: [[0, 0], [1, 0]] },
      { level_hpa: 1004, coordinates: [[0, 1], [1, 1]] },
    ];
    // Halfway between 1000 (lat 0) and 1004 (lat 1).
    expect(layer.sampleAt({ lat: 0.5, lng: 0.5 })).toBe("≈1002 hPa");
    // A quarter of the way from 1000.
    expect(layer.sampleAt({ lat: 0.25, lng: 0.5 })).toBe("≈1001 hPa");
  });

  test("sampleAt returns null when disabled or empty", () => {
    const layer = loadIsobars();
    layer._state.items = [{ level_hpa: 1012, coordinates: [[0, 0], [1, 0]] }];
    layer._state.enabled = false;
    expect(layer.sampleAt({ lat: 0, lng: 0 })).toBeNull();
    layer._state.enabled = true;
    layer._state.items = [];
    expect(layer.sampleAt({ lat: 0, lng: 0 })).toBeNull();
    expect(layer.sampleAt(null)).toBeNull();
    expect(layer.sampleAt({ lat: NaN, lng: 0 })).toBeNull();
  });

  test("sampleAt skips malformed levels instead of poisoning the scan", () => {
    const layer = loadIsobars();
    layer._state.enabled = true;
    layer._state.items = [
      { level_hpa: "not-a-number", coordinates: [[0, 0]] },
      { level_hpa: 1016, coordinates: [[0, 0.2]] },
    ];
    // The bad level is skipped; the good line is 0.2° away (not on it).
    expect(layer.sampleAt({ lat: 0, lng: 0 })).toBe("1016 hPa isobar");
  });

  test("the public API exports sampleAt and _state", () => {
    expect(isobarJs).toMatch(/sampleAt,/);
    expect(isobarJs).toMatch(/_state:\s*state/);
  });
});

describe("the module EVALUATES (no temporal dead zone)", () => {
  // THE BUG THIS PINS: the state literal calls readStoredColour(),
  // which reads COLOUR_CHOICES — and COLOUR_CHOICES was declared
  // BELOW the literal. A `const` below its use is in its temporal dead
  // zone, so the whole module threw
  //
  //     Cannot access 'COLOUR_CHOICES' before initialization
  //
  // at LOAD time, and not one line of it ever ran: no IsobarLayer, no
  // layer, no isobars — and the error was invisible because the
  // layer's own failure handler swallowed it.
  //
  // It is a SOURCE-ORDER bug, so it is pinned as one: every constant
  // the state initialiser reads must be declared ABOVE it.
  test("COLOUR_CHOICES is declared before the state literal", () => {
    const src = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
    const choices = src.indexOf("const COLOUR_CHOICES");
    const state = src.indexOf("const state = {");
    expect(choices).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(-1);
    expect(choices, "COLOUR_CHOICES must be declared BEFORE the state literal")
      .toBeLessThan(state);
  });

  test("the store key and the default colour are declared before it too", () => {
    const src = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
    const state = src.indexOf("const state = {");
    expect(src.indexOf("const COLOUR_STORE_KEY")).toBeLessThan(state);
    expect(src.indexOf("const DEFAULT_COLOUR")).toBeLessThan(state);
    expect(src.indexOf("function readStoredColour")).toBeLessThan(state);
  });

  test("and the file is syntactically valid — a duplicate declaration is a SyntaxError", () => {
    const src = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
    // One declaration each.
    for (const name of ["COLOUR_CHOICES", "COLOUR_STORE_KEY", "DEFAULT_COLOUR"]) {
      const n = (src.match(new RegExp("const " + name + "\\b", "g")) || []).length;
      expect(n, name + " must be declared exactly once").toBe(1);
    }
  });
});

// ── THE DATELINE ───────────────────────────────────────────────────────
//
// Owner: *"notice the pressure lines show up on the left but not
// right?"* at #49.1961,175.6055,5 — a view whose bounds Leaflet
// reports as 143.96 .. 207.25, i.e. east PAST 180.
//
// The fetch was never the problem: that bbox returns 1,157 lines, and
// 499 + 658 for the two halves separately — exactly the same total.
// All 1,157 were being DRAWN. The projection was the problem: Leaflet
// anchors its CRS at the map CENTRE (175.6), so a vertex at -170
// belongs 14° EAST of centre but is placed 345° WEST of it — off the
// left edge.
//
// MEASURED before the fix, by projecting every drawn vertex to a
// container point:
//     127,530 of the 250,609 vertices carry a NEGATIVE longitude — the
//     Pacific east of the dateline, i.e. the RIGHT half of this view —
//     and **all 127,530 project off the LEFT edge. Zero on screen.**
//     Only 2,203 vertices (the 175.6–180 sliver) appeared on the right.
// AFTER: 19,673 on the right, ratio right/left 0.11 -> 0.88.
//
// The helpers are EXECUTED, not grepped: they are pure functions of
// numbers, so the assertion can be about behaviour.
describe("isobars — the dateline", () => {
  const faultJs = readFileSync(join(ROOT, "fault-layer.js"), "utf8");

  function loadIsobars() {
    const win = {};
    const doc = {
      addEventListener() {}, body: { appendChild() {} },
      querySelector: () => null, querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, appendChild() {},
        querySelector: () => null, querySelectorAll: () => [],
        getContext: () => ({}),
      }),
    };
    const L = { canvas: () => ({}), polyline: () => ({}), DomUtil: {} };
    const fn = new Function("window", "document", "localStorage", "location",
                            "L", "requestAnimationFrame", "fetch", isobarJs);
    fn(win, doc, { getItem: () => null, setItem() {} }, { hash: "" }, L,
       () => 0, () => Promise.reject(new Error("no network in tests")));
    return win.IsobarLayer;
  }

  test("wrapLine keeps a dateline-crossing line in ONE piece", () => {
    const layer = loadIsobars();
    expect(typeof layer._wrapLine).toBe("function");
    const line = [[40, 144], [41, 170], [42, 180], [42, -179], [41, -170], [40, -153]];
    const pts = line.map((p) => p.slice());
    expect(layer._wrapLine(pts, 2.4)).toBe(true);
    const lngs = pts.map((p) => p[1]);
    expect(lngs).toEqual([144, 170, 180, 181, 190, 207]);
    let maxStep = 0;
    for (let i = 1; i < lngs.length; i++) maxStep = Math.max(maxStep, Math.abs(lngs[i] - lngs[i - 1]));
    // A step over 180 means Leaflet draws one chord across the whole
    // map — the "horizontal bands" seen when this was anchored to the
    // centre instead of to the previous vertex.
    expect(maxStep, "the line is torn across the map").toBeLessThanOrEqual(180);
  });

  test("the two copies of this algorithm agree — parity with the faults", () => {
    // isobar-layer.js and fault-layer.js each carry a wrapLine(), for
    // the same reason each carries its own copy of the contouring
    // primitives: the modules do not import from one another. Two
    // copies is two copies, so the only defence is a test that runs the
    // SAME input through both and demands the same answer.
    const faultJsPath = join(ROOT, "fault-layer.js");
    const faultSrc = readFileSync(faultJsPath, "utf8");
    const faultWin = {};
    new Function("window", faultSrc)(faultWin);
    const faultWrap = faultWin.FaultLayer._wrapLine;
    const isoWrap = loadIsobars()._wrapLine;
    expect(typeof faultWrap).toBe("function");
    expect(typeof isoWrap).toBe("function");

    const cases = [
      { pts: [[40, 144], [41, 170], [42, 180], [42, -179], [41, -170], [40, -153]], c: 2.4 },
      { pts: [[42, -180], [42, -170], [41, -153]], c: 175.6 },
      { pts: [[10, 10], [11, 11]], c: 10.5 },          // nowhere near the dateline
      { pts: [[0, -179], [0, 179]], c: 0 },            // a line the long way round
    ];
    for (const { pts, c } of cases) {
      const a = pts.map((p) => p.slice());
      const b = pts.map((p) => p.slice());
      isoWrap(a, c);
      faultWrap(b, c);
      expect(a, `isobar/fault copies disagree at centre ${c}`).toEqual(b);
    }
  });

  test("the wrap is applied where the lines are BUILT, and re-applied on pan", () => {
    // Building is only half: a view panned ONTO the dateline keeps the
    // offsets chosen for the old centre, so rewrapLines() has to run on
    // moveend/zoomend too. Without it the lines that should be visible
    // sit a full turn off the map.
    expect(isobarJs).toMatch(/wrapLine\(latlngs, state\.map\.getCenter\(\)\.lng\)/);
    expect(isobarJs).toMatch(/function rewrapLines\(\)/);
    expect(isobarJs).toMatch(/map\.on\("moveend zoomend", rewrapLines\)/);
    // …and the fault layer needs both halves as well.
    expect(faultJs).toMatch(/wrapLine\(latlngs, state\.map\.getCenter\(\)\.lng\)/);
    expect(faultJs).toMatch(/function rewrapLines\(\)/);
    expect(faultJs).toMatch(/rewrapLines\(\);\s*\n\s*scheduleUpdate/);
  });
});

// ── the rewrap is EXECUTED, not just wired ─────────────────────────────
//
// The dateline tests above run `wrapLine` (the pure function) and
// PIN the `map.on("moveend zoomend", rewrapLines)` binding as source.
// What neither does is call the function a pan actually calls — so a
// bug inside `rewrapLines` itself (reading the wrong state key,
// iterating the wrong collection, forgetting to write back) would ship
// behind a green suite.
//
// This is the path a fresh load never exercises: the fly from the
// dateline to Europe that found the FIRST version of this fix tearing
// lines in two with a 310-degree chord.
describe("the dateline — re-anchoring on pan", () => {
  const faultSrc = readFileSync(join(ROOT, "fault-layer.js"), "utf8");

  function loadIsobars() {
    const win = {};
    const doc = {
      addEventListener() {}, body: { appendChild() {} },
      querySelector: () => null, querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, appendChild() {},
        querySelector: () => null, querySelectorAll: () => [],
        getContext: () => ({}),
      }),
    };
    const L = { canvas: () => ({}), polyline: () => ({}), DomUtil: {} };
    const fn = new Function("window", "document", "localStorage", "location",
                            "L", "requestAnimationFrame", "fetch", isobarJs);
    fn(win, doc, { getItem: () => null, setItem() {} }, { hash: "" }, L,
       () => 0, () => Promise.reject(new Error("no network in tests")));
    return win.IsobarLayer;
  }

  function loadFaults() {
    const win = {};
    new Function("window", faultSrc)(win);
    return win.FaultLayer;
  }

  // A line as rewrapLines sees it: getLatLngs() in, setLatLngs()/redraw()
  // out, and a count of how often it was asked to repaint (a line that
  // was already correct must NOT be rewritten — that is what makes a pan
  // away from the dateline cost one scan and no redraws).
  function fakeLine(lngs, onWrite) {
    const pts = lngs.map((lng) => ({ lat: 50, lng }));
    return {
      getLatLngs: () => pts,
      setLatLngs: () => onWrite(),
      redraw: () => onWrite(),
      lngs: () => pts.map((p) => p.lng),
    };
  }

  const maxStep = (lngs) =>
    lngs.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - lngs[i])), 0);

  test("isobars: a line stored for the OLD centre moves, a correct one does not", () => {
    const layer = loadIsobars();
    // Stored for a dateline centre (175.6): these are 175..185 E
    // written as -185..-175. Viewed from Europe they are a world away.
    const stale = fakeLine([-185, -180, -175], () => { stale.writes++; });
    stale.writes = 0;
    // Already within 180 of the new centre — the common case, and the
    // one that must stay a no-op or every pan repaints every line.
    const fine = fakeLine([144, 170, 180], () => { fine.writes++; });
    fine.writes = 0;

    layer._state.map = { getCenter: () => ({ lng: 2.4 }) };
    layer._state.labelGroup = null;      // drawLabels() early-returns
    layer._state.group = {
      eachLayer: (fn) => { fn(stale); fn(fine); },
    };

    layer._rewrapLines();

    expect(stale.writes, "the stale line was never written back").toBe(1);
    expect(stale.lngs()).toEqual([175, 180, 185]);
    expect(maxStep(stale.lngs()),
      "the line is torn across the map").toBeLessThanOrEqual(180);

    expect(fine.writes, "an already-correct line must not be repainted").toBe(0);
    expect(fine.lngs()).toEqual([144, 170, 180]);

    // Idempotent: a second pan with the same centre changes nothing.
    layer._rewrapLines();
    expect(stale.writes).toBe(1);
    expect(stale.lngs()).toEqual([175, 180, 185]);
  });

  test("faults: the same re-anchoring, through the fault layer's own copy", () => {
    const layer = loadFaults();
    const stale = fakeLine([-185, -180, -175], () => { stale.writes++; });
    stale.writes = 0;
    const fine = fakeLine([-10, 0, 10], () => { fine.writes++; });
    fine.writes = 0;

    layer._state.map = { getCenter: () => ({ lng: 2.4 }) };
    layer._state.layer = {
      eachLayer: (fn) => { fn(stale); fn(fine); },
    };

    layer._rewrapLines();

    expect(stale.writes).toBe(1);
    expect(stale.lngs()).toEqual([175, 180, 185]);
    expect(maxStep(stale.lngs())).toBeLessThanOrEqual(180);
    expect(fine.writes, "an already-correct trace must not be redrawn").toBe(0);
    expect(fine.lngs()).toEqual([-10, 0, 10]);
  });

  test("both copies agree on what re-anchoring does", () => {
    // The two modules each carry their own rewrapLines, exactly as they
    // each carry their own wrapLine — so run the SAME stale line
    // through both and demand the same answer.
    const a = loadIsobars();
    const b = loadFaults();
    const la = fakeLine([-185, -180, -175], () => {});
    const lb = fakeLine([-185, -180, -175], () => {});
    for (const layer of [a, b]) {
      layer._state.map = { getCenter: () => ({ lng: 2.4 }) };
      layer._state.labelGroup = null;
      layer._state.group = { eachLayer: (fn) => fn(layer === a ? la : lb) };
      layer._state.layer = { eachLayer: (fn) => fn(layer === a ? la : lb) };
    }
    a._rewrapLines();
    b._rewrapLines();
    expect(la.lngs()).toEqual(lb.lngs());
    expect(la.lngs()).toEqual([175, 180, 185]);
  });
});
