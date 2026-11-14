// popup-zoom-to-place.bun.test.js — the map does NOT zoom on its own.
//
// Owner ask: *"rather then autozooming in on a pin thats in a city we
// need to give people the option after the popup opens to zoom in
// someplace in the popup after they click on the news pin."*
//
// What it was: clicking a pin called `maybeZoomToCluster()`, which flew
// the map to a city-level view of the pin's neighbours **unasked** — the
// reader's view of the world was taken away from them by a pin they had
// merely tapped, and the popup opened into the middle of that 700 ms
// flight.
//
// What it is now: the click opens the popup where the reader already is,
// and the popup carries a 🔎 button that flies to that place **when they
// ask for it**.
//
// TWO RULES THAT COME WITH IT:
//
//   * THE BUTTON IS IN THE ACTION ROW, beside the coordinates and the
//     satellite button — NOT lower down the popup. The popup's content
//     is ~914 px in a ~380 px box, so a control below the fold is
//     invisible AND un-hittable (clipped content is not hit-tested).
//   * THE BUTTON ALWAYS DOES SOMETHING. With three or more stories
//     nearby it shows the cluster (what the auto-zoom used to show);
//     with an isolated pin it shows the place itself at city level. A
//     button that does nothing is worse than no button.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

/** The source of one function, from its name to the next top-level one. */
function sliceFrom(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return "";
  const b = src.indexOf(end, a);
  return src.slice(a, b < 0 ? a + 4000 : b);
}

describe("a pin click does not move the map", () => {
  test("the canvas click path has no auto-zoom", () => {
    const fn = sliceFrom(appJs, "_activatePin(pin) {", "\n}\n");
    expect(fn.length).toBeGreaterThan(0);
    // The overflow badge (a cluster badge, not a story pin) still flies
    // to its cluster; a REGULAR pin must not.
    const regular = fn.slice(fn.indexOf("A REGULAR PIN DOES NOT MOVE THE MAP"));
    expect(regular).not.toMatch(/maybeZoomToCluster\(/);
  });

  test("the DOM marker click path has no auto-zoom", () => {
    const fn = sliceFrom(appJs, "NO AUTO-ZOOM", "marker._xyzoCategory");
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toMatch(/maybeZoomToCluster\(/);
    // The popup still waits for the map to settle — that is the small
    // pan to the pin, not the cluster flight.
    expect(fn).toMatch(/openPopupWhenSettled\(/);
  });
});

describe("the popup carries the zoom", () => {
  test("the button is in the ACTION ROW, beside the coordinates", () => {
    const fn = sliceFrom(appJs, "function pointActionButtons", "function buildPopup");
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/popup-zoom-here-btn/);
    // Beside the satellite and copy buttons — the row that is always
    // visible, because the rest of the popup is a scroll box.
    expect(fn).toMatch(/popup-satellite-btn/);
    expect(fn).toMatch(/popup-copy-coords-btn/);
    // And it carries the coordinates it zooms to.
    expect(fn).toMatch(/data-lat="\$\{ll\.lat\}" data-lng="\$\{ll\.lng\}"/);
  });

  test("the button is wired by DELEGATION from the popup element", () => {
    // The popup's content is a FUNCTION: Leaflet rebuilds it on a zoom
    // or a pan, so a listener bound to the button dies with the old
    // node. The popup ELEMENT survives every rebuild, so the listener
    // goes there and the button is resolved with closest() at click
    // time.
    const fn = sliceFrom(appJs, "_xyzoPointWired", "toggleStaleBannerDetails");
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/closest\("\.popup-satellite-btn, \.popup-copy-coords-btn, \.popup-zoom-here-btn"\)/);
    expect(fn).toMatch(/popup-zoom-here-btn/);
    expect(fn).toMatch(/zoomToPlace\(lat, lng\)/);
  });

  test("the action always zooms somewhere", () => {
    const fn = sliceFrom(appJs, "function zoomToPlace", "// Count pins within 30km");
    expect(fn.length).toBeGreaterThan(0);
    // The cluster when there is one…
    expect(fn).toMatch(/maybeZoomToCluster\(lat, lng\)/);
    // …and the place itself when there is not.
    expect(fn).toMatch(/map\.flyTo\(\[lat, lng\]/);
    // And it never ZOOMS OUT from where the reader already is.
    expect(fn).toMatch(/Math\.max\(map\.getZoom\(\), 11\)/);
  });

  test("the cluster zoom still reports whether it did anything", () => {
    // zoomToPlace() needs to know: "did the cluster zoom happen, or do
    // I fall back to the place itself?"
    const fn = sliceFrom(appJs, "function maybeZoomToCluster", "function zoomToPlace");
    expect(fn).toMatch(/if \(nearby\.length < 3\) return false/);
    expect(fn).toMatch(/return true;/);
  });
});
