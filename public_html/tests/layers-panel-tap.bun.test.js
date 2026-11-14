/**
 * layers-panel-tap.bun.test.js — a tap on a layers row must toggle it.
 *
 * Reported: "you click on city names once then turn it off and the names
 * still show up". Traced on an iPhone 14 Pro with a real touchscreen:
 *
 *   touchstart  INPUT.leaflet-control-layers-selector   scroll=1173
 *   touchend    INPUT.leaflet-control-layers-selector   scroll=1173
 *   expand()    height '560px' -> '600px'              scroll 1173 -> 0
 *   mousedown   BUTTON.leaflet-preset-chip             scroll=0
 *   click       BUTTON.leaflet-preset-chip
 *
 * Three separate defects, all in Leaflet's own `_expandSafely`, which
 * fires from `mouseenter` — and on touch Chrome synthesises that
 * mouseenter from the SAME gesture as the tap, so it lands ~0 ms before
 * the click does:
 *
 *   1. it rewrites the list's `height` with its own hard-coded 50px
 *      reserve, overwriting the measured cap — and rewriting `height` on
 *      a scroll container RESETS scrollTop to 0, so the row you had just
 *      scrolled to vanished and the synthesised click landed on a
 *      neighbouring control (here a Cool-maps preset chip);
 *   2. it registers `L.DomEvent.preventDefault` on the whole list for one
 *      tick, so the click that toggles the checkbox was cancelled;
 *   3. it sets `_preventClick`, which makes `_onInputClick` bail — so even
 *      with the click delivered, the layer was never added.
 *
 * Each is undone in app.js's `layersControl.expand` wrapper. These are
 * static checks on the shipped source; the live behaviour (a full
 * ON→OFF→ON→OFF cycle with real taps) is verified by the Playwright
 * harness recorded in the session notes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

function sliceFrom(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i + startMarker.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

describe("the list keeps its scroll position across a re-cap", () => {
  test("capLayersListHeight never clears height to re-measure", () => {
    // Clearing `height` on a scroll container resets scrollTop to 0. That
    // is invisible until the user has scrolled to a row and taps it.
    const fn = sliceFrom(appJs, "function capLayersListHeight", "const _expand = layersControl.expand");
    expect(fn).toContain("function capLayersListHeight");
    // The COLLAPDED branch may still clear: a hidden panel has no scroll
    // to lose. What must not happen is a clear on the EXPANDED path,
    // where it silently throws away the user's position. Counting rather
    // than slicing — a slice that starts at `const avail` missed a clear
    // inserted just above it, so the mutation test passed when it should
    // have failed.
    const clears = fn.match(/section\.style\.height = ""/g) || [];
    expect(clears.length, "the collapsed branch's clear, and no other").toBe(1);
    // scrollHeight reports CONTENT height whether or not the box has one,
    // so the old clear bought nothing.
    expect(fn).toContain("section.scrollHeight");
  });

  test("the height write is skipped when the value is unchanged", () => {
    // A re-cap that computes the same cap must not touch the box at all.
    const fn = sliceFrom(appJs, "function capLayersListHeight", "const _expand = layersControl.expand");
    expect(fn).toMatch(/if \(section\.style\.height !== avail \+ "px"\)/);
  });

  test("layersControl.expand is wrapped to keep the scroll", () => {
    // Leaflet's expand() rewrites height with its own 50px reserve; the
    // wrapper re-applies the measured cap and restores the offset.
    const fn = sliceFrom(appJs, "const _expand = layersControl.expand", "// ── ✕ close button");
    expect(fn).toContain("const _expand = layersControl.expand");
    expect(fn).toContain("capLayersListHeight();");
    expect(fn).toMatch(/s\.scrollTop = keep/);
  });
});

describe("the first tap on a checkbox is not swallowed", () => {
  test("the wrapper releases _expandSafely's preventDefault", () => {
    // _expandSafely registers L.DomEvent.preventDefault on the whole
    // list for one tick, which cancels the click that toggles the box.
    const fn = sliceFrom(appJs, "const _expand = layersControl.expand", "// ── ✕ close button");
    expect(fn).toMatch(/L\.DomEvent\.off\(\s*s,\s*"click",\s*L\.DomEvent\.preventDefault\s*\)/);
  });

  test("the wrapper clears _preventClick so _onInputClick runs", () => {
    // Leaflet's _onInputClick is gated on `if (!this._preventClick)` —
    // clearing the handler alone delivered the click but left the layer
    // un-added (checkbox ticks, nothing happens).
    const fn = sliceFrom(appJs, "const _expand = layersControl.expand", "// ── ✕ close button");
    expect(fn).toMatch(/this\._preventClick = false/);
  });
});

describe("the panel cannot run off the left edge of a phone", () => {
  test("the expanded panel is capped to the viewport", () => {
    // The panel is right-anchored with no width of its own, so it sizes
    // to its widest row — and the rows grew in the legibility sweep. On a
    // 393px phone it reached 418px at x = -35, putting the CHECKBOX
    // column off-screen: elementAtPoint at the City names box returned
    // null and the toggle was untappable, which reads as "the layer
    // ignores the checkbox".
    const rule = sliceFrom(stylesCss, ".leaflet-control-layers-expanded {", "}");
    expect(rule).toMatch(/max-width:\s*calc\(100vw - 20px\)/);
    // Rows must be able to shrink to fit the cap rather than push it.
    expect(stylesCss).toMatch(/\.leaflet-overlay-row > label\s*\{[^}]*flex:\s*0 1 auto/);
    expect(stylesCss).toMatch(/\.leaflet-overlay-leader\s*\{[^}]*flex:\s*1 1 auto/);
  });
});
