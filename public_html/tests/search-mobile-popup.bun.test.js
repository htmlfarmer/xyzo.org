// search-mobile-popup.bun.test.js — after a search ON A PHONE, tapping a
// result must open a popup that is fully on screen, STILL, and closable.
//
// THE MEASURED BUG (2026-11-11, scripts/search_mobile_audit.py on a
// 393×852 Chromium phone profile with real touch):
//
//   BEFORE  the popup's box was 558,-474 → 927,-94 in a 393×852 viewport:
//           the ✕ Close button sat at 834,-464 → 917,-432 — 464 px ABOVE
//           the top of the screen and 441 px past the right edge — and it
//           could not be tapped, so the popup could not be closed at all.
//           4 of the 9 audit checks failed.
//   AFTER   the popup's box is 10,215 → 379,595 — inside the viewport —
//           the ✕ is at 286,225 → 369,257, the popup does not move for
//           1.5 s after the tap, and tapping the ✕ closes it.
//           9 of 9 checks pass.
//
// FIVE DEFECTS, ONE MEASUREMENT:
//
//   1. THE PAN IN keepPopupOnScreen() HAD THE WRONG SIGN. `map.panBy([dx,
//      dy])` moves the map's CENTRE by (dx, dy), so the popup — which is
//      anchored to its pin — moves the OTHER way. The correction had the
//      SAME sign as the screen-space error, so every correction pushed
//      the popup FURTHER off the screen: measured, the popup walked from
//      34 px past the right edge to 970 px above the top of the screen
//      in four corrections, each DOUBLE the last.
//   2. THE POPUP OPENED INTO A FLIGHT. Leaflet's own `click → _openPopup`
//      handler opened it synchronously, 0 ms into the 700 ms
//      flyToBounds that maybeZoomToCluster() starts for any pin with ≥3
//      neighbours within 30 km — which, after a search, is nearly every
//      pin. The popup then RIDE the flight.
//   3. THE FRAMING NEVER RE-RAN. keepPopupOnScreen() ran at popupopen
//      and one tick later — i.e. DURING the flight. Nothing re-framed
//      the popup once the flight landed.
//   4. THE STATUS LINE WAS NOT RESERVED. `#search-status` ("All news in
//      Chicago · 9 stories") is `position: fixed; bottom: 58px` and only
//      exists AFTER a search; the framing measured the bottom bar's
//      HEIGHT, which is ~14 px short of its measured top edge
//      (--bottom-bar-top).
//   5. THE MOBILE "Details ▸" BUTTON WAS DEAD: buildPopup()'s mobile
//      branch emitted `.popup-details-full` while wirePopupActions()
//      looked for `.popup-details-content`.
//
// Plus two more that the same audit found: maybeZoomToCluster() counted
// every pin TWICE (the canvas list and the DOM marker registry hold the
// same search results), and restoreActivePopup()'s standalone popup was
// never wired, so its action buttons were dead.
//
// These are static-analysis checks on the shipped source (the house
// pattern); the live behaviour is scripts/search_mobile_audit.py.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// Slice a function (or an IIFE body) out of a source string.
function sliceFrom(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

/** The body of a named `function name(...) { … }` declaration. */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return "";
  // Skip the parameter list — it can contain braces of its own.
  let i = src.indexOf("(", start);
  if (i < 0) return "";
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") { paren--; if (paren === 0) { i++; break; } }
  }
  const bodyStart = src.indexOf("{", i);
  if (bodyStart < 0) return "";
  let depth = 0, end = -1;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) { end = j + 1; break; }
    }
  }
  return end < 0 ? "" : src.slice(start, end);
}

describe("the framing pans the MAP, and the sign is the map's", () => {
  test("the correction is the map's pan, not the popup's", () => {
    const fn = sliceFrom(appJs, "function keepPopupOnScreen", 'map.on("popupopen"');
    expect(fn.length).toBeGreaterThan(0);
    // The popup moves the OTHER way, so a popup that is too far RIGHT
    // needs a POSITIVE dx (pan the centre right → the popup goes left).
    expect(fn).toMatch(/dx = Math\.round\(r\.right - \(size\.x - POPUP_EDGE_MARGIN\)\)/);
    expect(fn).toMatch(/dy = Math\.round\(r\.bottom - \(size\.y - insetBottom\)\)/);
    // The old, wrong-way form must not come back.
    expect(fn).not.toMatch(/dx = size\.x - POPUP_EDGE_MARGIN - r\.right/);
    expect(fn).not.toMatch(/dy = size\.y - insetBottom - r\.bottom/);
    // The pan itself is unchanged — the house rule.
    expect(fn).toMatch(/map\.panBy\(\[dx, dy\],\s*\{\s*animate:\s*false\s*\}\)/);
  });

  test("the correction is ROUNDED before the zero test", () => {
    // Leaflet rounds the offset itself, and its `panBy([0, 0])` FIRES
    // moveend WITHOUT moving — so a fractional correction fed the
    // framing pass back into itself and the reader got "Maximum call
    // stack size exceeded" instead of a popup.
    const fn = sliceFrom(appJs, "function keepPopupOnScreen", 'map.on("popupopen"');
    expect(fn).toMatch(/Math\.round\(r\.right - \(size\.x - POPUP_EDGE_MARGIN\)\)/);
    expect(fn).toMatch(/Math\.round\(r\.top - insetTop\)/);
    // …and the framing cannot re-enter itself.
    expect(fn).toMatch(/_popupFraming/);
  });

  test("the framing reserves the status line and the measured bottom edge", () => {
    const fn = sliceFrom(appJs, "function keepPopupOnScreen", 'map.on("popupopen"');
    // The line that says "All news in Chicago · 9 stories" only exists
    // after a search, and it sits just above the bottom bar.
    expect(fn).toMatch(/#search-status/);
    // The bar's HEIGHT is ~14 px short of its top edge on a phone; the
    // measured edge is published as --bottom-bar-top.
    expect(fn).toMatch(/--bottom-bar-top/);
    expect(fn).toMatch(/#bottom-bar/);
    expect(fn).toMatch(/#search-bar/);
  });

  test("the framing re-runs when the map settles", () => {
    // The popup opened into a flight; nothing re-framed it once the
    // flight landed.
    expect(appJs).toMatch(/map\.on\("moveend", \(\) => \{[\s\S]{0,400}keepPopupOnScreen\(\)/);
    expect(appJs).toMatch(/map\.on\("zoomend", \(\) => \{[\s\S]{0,400}keepPopupOnScreen\(\)/);
    // …but a USER drag must never be fought: the popup is anchored to
    // its pin, so the reader is allowed to walk away from it.
    expect(appJs).toMatch(/_mapMoveByUser/);
    expect(appJs).toMatch(/map\.on\("dragstart"/);
  });
});

describe("a popup opens ONCE THE MAP HAS SETTLED", () => {
  test("there is ONE helper for it", () => {
    expect(appJs).toMatch(/function openPopupWhenSettled/);
    const fn = sliceFrom(appJs, "function openPopupWhenSettled", 'map.on("popupopen"');
    // It waits for moveend…
    expect(fn).toMatch(/map\.once\("moveend"/);
    // …with a bounded fallback that RE-ARMS while the map is moving: a
    // 700 ms flight is LONGER than the 600 ms coarse-pointer wait, so a
    // fallback that simply fired opened the popup 600 ms INTO the
    // flight — the very bug.
    expect(fn).toMatch(/isCoarsePointer\(\)\s*\?\s*600\s*:\s*150/);
    expect(fn).toMatch(/_mapIsMoving/);
    // …and it fires ONCE.
    expect(fn).toMatch(/if \(done\) return/);
    expect(fn).toMatch(/_popupSettleSeq/);
  });

  test("the DOM-marker path uses it", () => {
    const fn = sliceFunction(appJs, "buildPinMarker");
    expect(fn).toMatch(/openPopupWhenSettled\(/);
  });

  test("the canvas path uses it", () => {
    const fn = sliceFunction(appJs, "openPinPopupFromCanvas");
    expect(fn).toMatch(/openPopupWhenSettled\(/);
  });

  test("the event-marker path uses it", () => {
    const fn = sliceFunction(appJs, "buildEventMarker");
    expect(fn).toMatch(/openPopupWhenSettled\(/);
  });

  test("Leaflet's own synchronous open is removed from both markers", () => {
    // bindPopup() registers `click → _openPopup`, and it runs BEFORE the
    // handler that could defer the open — so the popup appeared 0 ms
    // into the flight.
    expect(sliceFunction(appJs, "buildPinMarker"))
      .toMatch(/marker\.off\("click", marker\._openPopup\)/);
    expect(sliceFunction(appJs, "buildEventMarker"))
      .toMatch(/marker\.off\("click", marker\._openPopup\)/);
  });
});

describe("the cluster zoom counts each pin once", () => {
  test("the canvas list and the DOM markers are deduplicated", () => {
    const fn = sliceFrom(appJs, "function maybeZoomToCluster", "// Count pins within 30km");
    expect(fn.length).toBeGreaterThan(0);
    // The same search results live in BOTH, so counting both counted
    // every pin twice.
    expect(fn).toMatch(/const seen = new Set\(\)/);
    expect(fn).toMatch(/if \(seen\.has\(key\)\) return/);
    expect(fn).toMatch(/canvasRenderer\._pins/);
    expect(fn).toMatch(/pinMarkers\.forEach/);
  });
});

describe("the mobile Details button is not dead", () => {
  test("the markup and the wiring use ONE class name", () => {
    // The mobile branch emitted `.popup-details-full` while the wiring
    // looked for `.popup-details-content`: on a phone the keywords, the
    // related stories, the locations and the reports were unreachable.
    expect(appJs).not.toMatch(/class="popup-details-full"/);
    const fn = sliceFunction(appJs, "buildPopup");
    expect(fn).toMatch(/class="popup-details-content"/);
    // The mobile branch is the FIRST one and it carries the same class.
    const mobile = fn.indexOf('class="popup-details-content" style="display:none;"');
    expect(mobile).toBeGreaterThan(-1);
    const wire = sliceFunction(appJs, "wirePopupActions");
    expect(wire).toMatch(/querySelector\("\.popup-details-content"\)/);
    expect(wire).toMatch(/popup-details-btn/);
  });
});

describe("a restored popup is wired like any other", () => {
  test("the standalone popup gets the close button and the actions", () => {
    const fn = sliceFunction(appJs, "restoreActivePopup");
    expect(fn).toMatch(/attachPopupClose\(el\)/);
    expect(fn).toMatch(/wirePopupActions\(standalone, pin\)/);
    expect(fn).toMatch(/wireEventPopupActions\(standalone, pin\)/);
  });

  test("the popup state carries the pin data", () => {
    // Without it a restored popup has nothing to wire its buttons from.
    expect(appJs).toMatch(/pin: e\.popup\._source\?\._pinData \|\| null/);
  });
});

describe("the canvas shift hack does not fight Leaflet", () => {
  test("it reads the popup's OWN element and stops when the map settles", () => {
    const fn = sliceFunction(appJs, "openPinPopupFromCanvas");
    // `document.querySelector('.leaflet-popup')` returns the FIRST popup
    // in the DOCUMENT — which may be a fading one.
    expect(fn).not.toMatch(/querySelector\('\.leaflet-popup'\)/);
    expect(fn).toMatch(/e\.popup\.getElement\(\)/);
    // …and it stops when the map settles: a popup that is not riding a
    // flight does not move.
    expect(fn).toMatch(/if \(!_mapIsMoving\) return/);
  });
});

describe("the close button keeps working", () => {
  test("it is delegated from the popup element and never stops propagation", () => {
    const fn = sliceFunction(appJs, "attachPopupClose");
    expect(fn).toMatch(/el\.addEventListener\("click"/);
    expect(fn).toMatch(/closest\("\.popup-close-btn, \.popup-close-btn-mobile"\)/);
    expect(fn).toMatch(/window\.closeActivePopup\(\)/);
    expect(fn).not.toMatch(/map\.closePopup\(\)/);
    expect(fn).not.toMatch(/stopPropagation/);
  });
});

describe("the onboarding tour must not sit on the popup", () => {
  // The tour card is the only thing the tour puts on the POINTER PATH,
  // at z-index 9998 — above the popup pane (1200). On a phone it is a
  // bottom sheet, so it covered the ✕ Close: measured, the element at
  // the ✕'s own coordinates was `xyzo-tour-title`, and the tap landed on
  // the tour instead of the button.
  test("a search ends the tour", () => {
    expect(appJs).toMatch(/function endTourForSearch/);
    const fn = sliceFunction(appJs, "endTourForSearch");
    expect(fn).toMatch(/XYZO_TOUR/);
    expect(fn).toMatch(/\.stop\(\)/);
    // stop() only marks the tour seen when it was OPEN, so the
    // auto-start would still fire later, over the popup.
    expect(fn).toMatch(/\.markSeen\(\)/);
    expect(sliceFunction(appJs, "runSearch")).toMatch(/endTourForSearch\(\)/);
    expect(sliceFunction(appJs, "runTextSearch")).toMatch(/endTourForSearch\(\)/);
  });
});
