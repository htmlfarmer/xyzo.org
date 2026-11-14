/**
 * The pressure CHANGE map's window in the URL.
 *
 * Owner ask: *"can you make sure the url is updated when someone clicks
 * on [the 24 h change button]"* — and the button it names is
 * `<button data-delta="24h">24 h</button>`, the chip that switches the
 * isobar layer from the ordinary chart to the CHANGE map (the difference
 * between two archived pressure analyses).
 *
 * The defect it fixes: the window lived ONLY in localStorage
 * (`xyzo.isobarDelta`). The chip changed the map, the address bar did
 * not move, and the SHARE button copies `location.href` verbatim — so a
 * reader who switched to the change map and pressed Share handed over a
 * link to the ORDINARY chart. The same defect the step, the colour and
 * the analysis had, and they all travel for the same reason: the change
 * map is a DIFFERENT PICTURE of the same atmosphere, not a different
 * setting of the same picture.
 *
 * The rules, each one load-bearing:
 *
 *   • `delta=<window>` is written when a window is chosen and the
 *     isobars are on. The ordinary chart is the default and there is
 *     exactly ONE way to spell it, so a segment that says "the default"
 *     can only add a way to be wrong.
 *   • It is READ back, and applied BEFORE the layer is enabled — the
 *     window decides what the fetch asks for, so it has to be on the
 *     layer when the layer goes on.
 *   • A link is a VIEW, not a settings change: `persist: false`, so
 *     opening someone else's map never overwrites the reader's own
 *     stored window.
 *   • Only the windows the layer OFFERS are accepted. A hand-edited
 *     link must not be able to ask the archive for a window that does
 *     not exist.
 *   • The chip row is repainted from `setDeltaWindow()` itself, because
 *     a window can arrive with no click at all (a link, a saved style) —
 *     and a chip row that says "pressure" while the map draws the
 *     change map is a control lying about what is on screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const layerJs = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const presetJs = readFileSync(join(ROOT, "map-presets.js"), "utf8");

// The slice of source between two markers. Anchored on CODE, never on a
// comment: prose gets reworded, and an assertion anchored on prose ends
// up slicing from -1.
function between(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const j = rest.indexOf(endMarker);
  return j < 0 ? rest : rest.slice(0, j);
}

const setDelta = between(layerJs, "async function setDeltaWindow(win, opts)", "function getDeltaWindow");

describe("the chip changes the map", () => {
  test("the windows it offers are the ones the API serves", () => {
    const block = between(layerJs, "const DELTA_WINDOWS = [", "const STEP_CHOICES");
    const keys = [...block.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["24h", "3d", "7d", "moon", "season", "year"]);
    // Each one carries the label the chip shows and the words the
    // tooltip uses.
    for (const k of keys) {
      expect(block).toContain(`key: "${k}"`);
    }
    expect(block).toMatch(/label: "24 h"/);
  });

  test("the window is stored, and the stored one is validated", () => {
    expect(layerJs).toContain('const DELTA_STORE_KEY = "xyzo.isobarDelta"');
    // A stored value that is no longer offered must fall back to the
    // ordinary chart rather than ask the API for a window that does not
    // exist.
    expect(layerJs).toContain("return DELTA_WINDOWS.some((w) => w.key === v) ? v : \"\";");
  });

  test("a window the layer does not offer is refused", () => {
    // The chips can only produce a valid one, but a LINK can carry
    // anything — and the archive has no such window.
    expect(setDelta).toContain("if (want && !DELTA_WINDOWS.some((w) => w.key === want)) return false;");
  });

  test("changing it refetches — it is different DATA, not different paint", () => {
    expect(setDelta).toContain("state.loaded = null;");
    expect(setDelta).toContain("await refresh(true);");
  });
});

describe("it is part of the URL", () => {
  test("the writer emits it when a window is chosen", () => {
    const emit = between(appJs, "const delta = (deltaWindow && isobarsOn)", ";");
    expect(emit).toContain("/delta=${encodeURIComponent(deltaWindow)}");
    // The ordinary chart is the default and there is exactly one way to
    // spell it — so the segment is written ONLY when a window is set.
    expect(emit).toContain("deltaWindow && isobarsOn");
    // ...and it reaches the address bar.
    expect(appJs).toContain("${overlays}${iso}${isoSrc}${delta}${wind}");
    expect(appJs).toContain('typeof window.IsobarLayer.getDeltaWindow === "function"');
  });

  test("the parser reads it back", () => {
    expect(appJs).toMatch(/const deltaMatch = p\.match\(\/\^delta=/);
    expect(appJs).toContain("res.deltaWindow = deltaMatch[1]");
  });

  test("a link's window is applied BEFORE the layer is enabled", () => {
    // The window decides WHAT the fetch asks for, so it has to be on the
    // layer when the layer goes on — one fetch, carrying the right
    // window.
    const at = appJs.indexOf("window.IsobarLayer.setDeltaWindow(parsed.deltaWindow, { persist: false })");
    expect(at).toBeGreaterThan(-1);
    const enabled = appJs.indexOf("window.IsobarLayer.setEnabled(true);", at);
    expect(enabled).toBeGreaterThan(-1);
    expect(at).toBeLessThan(enabled);
  });

  test("a link's window does NOT overwrite the reader's own choice", () => {
    // A LINK IS A VIEW, NOT A SETTINGS CHANGE — the rule every other
    // layer preference follows at boot.
    expect(setDelta).toContain("if (!(opts && opts.persist === false))");
    expect(setDelta).toContain('localStorage.setItem(DELTA_STORE_KEY, want || "")');
    expect(appJs).toContain("setDeltaWindow(parsed.deltaWindow, { persist: false })");
  });

  test("the layer tells the app when the window changed", () => {
    // One event between the layer (which owns the control) and the app
    // (which owns the URL) — the same pattern the step, the colour and
    // the analysis use.
    expect(layerJs).toContain('new window.CustomEvent("xyzo:isobar-delta"');
    expect(layerJs).toContain("detail: { window: want }");
    expect(appJs).toContain('window.addEventListener("xyzo:isobar-delta"');
  });

  test("the URL moves BEFORE the archive answers", () => {
    // The reader pressed a chip; the address bar should say so at once,
    // not after the fetch. The event is dispatched before the await.
    const dispatch = setDelta.indexOf('new window.CustomEvent("xyzo:isobar-delta"');
    const fetchAt = setDelta.indexOf("await refresh(true);");
    expect(dispatch).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(fetchAt);
  });

  test("the chip row is repainted even when there was no click", () => {
    // A link or a saved style sets the window without a click, so the
    // painter has to be reachable from setDeltaWindow() itself — a
    // painter living only in the click handler leaves the row saying
    // "pressure" while the map draws the CHANGE map.
    expect(setDelta).toContain("paintDeltaRow();");
    const paint = between(layerJs, "function paintDeltaRow()", "async function loadDeltaWindows");
    expect(paint).toContain('document.getElementById("isobar-change-switch")');
    expect(paint).toContain('b.dataset.delta || ""');
    expect(paint).toContain('b.setAttribute("aria-pressed"');
  });
});

describe("a link pasted into an OPEN tab applies it too", () => {
  test("the hashchange handler carries the window", () => {
    // A pasted link is a SAME-DOCUMENT navigation: the page does not
    // reload, so the boot-time restore never runs and the hashchange
    // handler is the ONLY thing that can apply it. Without it the
    // address bar would promise a picture the map is not drawing.
    const handler = between(appJs, "window.addEventListener('hashchange'", "// ── Share Button");
    expect(handler).toContain("window.IsobarLayer.setDeltaWindow(hashView.deltaWindow, { persist: false });");
    // ...and it is applied BEFORE the layer is switched on, so the fetch
    // carries it.
    const at = handler.indexOf("setDeltaWindow(hashView.deltaWindow");
    const enabled = handler.indexOf("window.IsobarLayer.setEnabled(true);", at);
    expect(at).toBeGreaterThan(-1);
    expect(enabled).toBeGreaterThan(-1);
    expect(at).toBeLessThan(enabled);
  });

  test("it applies the layer's other settings the same way", () => {
    // The step, the colour and the analysis have the same defect: a
    // pasted link reproduced the layer but not the setting the sender
    // chose. One place, one order — the same order the boot path uses.
    const handler = between(appJs, "window.addEventListener('hashchange'", "// ── Share Button");
    expect(handler).toContain("window.IsobarLayer.setStep(hashView.isoStep, { persist: false });");
    expect(handler).toContain("window.IsobarLayer.setColour(hashView.isoColour, { persist: false });");
    expect(handler).toContain("window.IsobarLayer.setSource(hashView.isoSource, { persist: false });");
  });
});

describe("a saved style carries it too", () => {
  test("MY STYLE is a snapshot of the EXACT map", () => {
    expect(appJs).toContain('typeof window.IsobarLayer.getDeltaWindow === "function"');
    expect(appJs).toContain("deltaWindow: style.deltaWindow || undefined");
    expect(appJs).toContain("deltaWindow: s.deltaWindow,");
    expect(appJs).toContain("deltaWindow: state.deltaWindow || undefined");
  });
});

describe("a preset speaks the same grammar", () => {
  test("it parses the segment and keeps it", () => {
    // The grammar a preset speaks is deliberately the one a shared URL
    // speaks, so a preset, a pasted link and a saved style can never
    // diverge.
    expect(presetJs).toContain("const delta = p.match(");
    expect(presetJs).toContain("state.deltaWindow = decodeURIComponent(delta[1]);");
    expect(presetJs).toContain('if (typeof state.deltaWindow === "string" && state.deltaWindow) {');
    expect(presetJs).toContain("out.deltaWindow = state.deltaWindow;");
  });
});
