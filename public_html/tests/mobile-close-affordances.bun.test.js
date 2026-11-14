// mobile-close-affordances.bun.test.js — every ✕ on the phone.
//
// The 2026-10-29 mobile review found five close/dismiss affordances that
// worked on desktop and failed on a phone. Each one is pinned here, with
// the reason it broke, so none of them can come back quietly.
//
//   1. The layers ✕ stayed in the DOM after the panel collapsed and sat
//      directly on top of the stack-icon toggle — the layers panel could
//      never be reopened after the first ✕.
//   2. The touch toggle hand-rolled the open (class + display:block) and
//      never called layersControl.expand(), the only thing that caps the
//      list height. The panel came out 3,078 px tall on a 660 px phone
//      and 26 overlays were unreachable.
//   3. #help-me-btn (z-index 9998) sat on #bottom-bar's (z-index 500)
//      right-hand end, which on a phone is where the ⚙ tools button and
//      the Markers button live. Both were untappable.
//   4. Leaflet sized and auto-panned the popup from the PRE-zoom
//      offsetWidth while .leaflet-popup-content-wrapper renders at
//      zoom: 1.15 — so the popup, and the ✕ Close anchored to its right
//      edge, landed off the right-hand side of the screen.
//   5. The 3D globe's panel had no close affordance at all and covered
//      76 % of a phone's screen.
//
// These are static-analysis checks on the shipped source (the house
// pattern); the live behaviour is covered by the Playwright harness in
// the session notes.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const globeHtml = readFileSync(join(ROOT, "globe.html"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const globeCss = readFileSync(join(ROOT, "globe.css"), "utf8");
const mapDebugJs = readFileSync(join(ROOT, "map-debug.js"), "utf8");

// Slice a function (or an IIFE body) out of a source string by its start
// marker and a terminator.
function sliceFrom(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

describe("layers ✕ must not block the toggle when the panel is collapsed", () => {
  test("styles.css hides .leaflet-layers-close while collapsed", () => {
    // THE fix for "the X button broke the layers panel". The ✕ is
    // appended to the control and never removed, so it outlives the
    // collapse sitting in the panel's top-right corner — the same box as
    // the toggle underneath it.
    expect(stylesCss).toMatch(
      /\.leaflet-control-layers:not\(\.leaflet-control-layers-expanded\)\s+\.leaflet-layers-close\s*\{\s*display:\s*none/);
  });

  test("the rule is commented with why (so it is not 'cleaned up')", () => {
    const block = sliceFrom(stylesCss, ".leaflet-control-layers:not(.leaflet-control-layers-expanded)",
      "@media (pointer: coarse)");
    expect(block).toMatch(/never be reopened|swallow|on top of the toggle/i);
  });
});

describe("layers panel must be scrollable on a phone", () => {
  test("the touch toggle routes through setLayersPanelOpen()", () => {
    // The hand-rolled open is the bug. It added the expanded class and
    // `display: block` by hand and never called expand(), so the list
    // never got its height cap or the scrollbar class.
    const toggle = sliceFrom(appJs, "(function makeLayersToggleTouchFriendly", "Per-overlay opacity sliders");
    expect(toggle).toMatch(/setLayersPanelOpen\(/);
    expect(toggle).not.toMatch(/style\.display = "block"/);
  });

  test("setLayersPanelOpen() calls expand() AND caps the list", () => {
    const fn = sliceFrom(appJs, "function setLayersPanelOpen", "function layersListBottomReserve");
    expect(fn).toMatch(/layersControl\.expand\(\)/);
    expect(fn).toMatch(/capLayersListHeight\(\)/);
  });

  test("capLayersListHeight applies Leaflet's scrollbar class", () => {
    // .leaflet-control-layers-scrollbar is what gives the list
    // `overflow-y: scroll` — without it the panel is as tall as its
    // content and the bottom of the overlay list is unreachable.
    const fn = sliceFrom(appJs, "function capLayersListHeight", "(function mountLayersCloseButton");
    expect(fn).toMatch(/leaflet-control-layers-scrollbar/);
    expect(fn).toMatch(/section\.style\.height/);
    // Must no-op while collapsed: measuring a display:none list gives 0
    // and would cap the panel at nothing on its next open.
    expect(fn).toMatch(/leaflet-control-layers-expanded/);
  });

  test("the bottom reserve accounts for the floating #bottom-bar", () => {
    const fn = sliceFrom(appJs, "function layersListBottomReserve", "function capLayersListHeight");
    expect(fn).toMatch(/bottom-bar/);
  });

  test("the cap is re-applied on resize / rotate", () => {
    const iife = sliceFrom(appJs, "(function keepLayersListCapped", "Per-overlay opacity sliders");
    expect(iife).toMatch(/resize/);
    expect(iife).toMatch(/orientationchange/);
  });

  test("iOS momentum scrolling is enabled for the capped list", () => {
    expect(stylesCss).toMatch(/\.leaflet-control-layers-scrollbar\s*\{[^}]*-webkit-overflow-scrolling:\s*touch/);
  });
});

describe("Help Me must not cover the bottom bar", () => {
  test("#help-me-btn derives its bottom from a measured variable", () => {
    // A hard-coded `bottom: 12px` put the pill on top of the bar's ⚙ and
    // Markers buttons on any phone-width screen.
    const rule = sliceFrom(stylesCss, "#help-me-btn {", "#help-me-btn:hover");
    expect(rule).toMatch(/bottom:\s*var\(--help-me-bottom/);
  });

  test("the narrow-screen override keeps the variable", () => {
    // This block used to re-hard-code bottom:12px, undoing the fix.
    const mq = sliceFrom(stylesCss, "@media (max-width: 600px) {", ".category-discovery-banner");
    const helpMe = sliceFrom(mq, "#help-me-btn {", "}");
    expect(helpMe).toMatch(/var\(--help-me-bottom/);
    expect(helpMe).not.toMatch(/bottom:\s*12px/);
  });

  test("app.js measures the bar and publishes --help-me-bottom", () => {
    const fn = sliceFrom(appJs, "(function publishChromeEdges", "(function setupBottomBarKeyboardHide");
    expect(fn).toMatch(/getElementById\("bottom-bar"\)/);
    expect(fn).toMatch(/--help-me-bottom/);
    expect(fn).toMatch(/ResizeObserver/);
  });

  test("the bar's TOP EDGE and #top-bar's bottom edge are both published", () => {
    // Fixed dropdowns sit in the clear band between #top-bar and
    // #bottom-bar. Both edges move (safe-area inset, text-size zoom,
    // i18n labels), so the band is measured, not typed. #top-band is NOT
    // a substitute: it measures the map control stack, below the search
    // pill, so a menu clamped to it slid under the pill.
    const fn = sliceFrom(appJs, "(function publishChromeEdges", "(function setupBottomBarKeyboardHide");
    expect(fn).toMatch(/--bottom-bar-top/);
    expect(fn).toMatch(/innerHeight\s*-\s*r\.top/);   // distance from the bottom
    expect(fn).toMatch(/getElementById\("top-bar"\)/);
    expect(fn).toMatch(/--top-chrome-bottom/);
  });

  test("the control menu clamps between the two chrome edges and scrolls", () => {
    // On a 393x660 phone the menu's natural height is 799px but the clear
    // band is 538px, so it can never fit — it has to scroll inside a box
    // bounded by both edges. Anchoring only to the bottom let it grow over
    // the search pill; anchoring only to the top let it slide under Help Me.
    const rule = sliceFrom(stylesCss, ".bar-dropdown {", "}");
    expect(rule).toMatch(/bottom:\s*calc\(var\(--bottom-bar-top/);
    expect(rule).toMatch(/top:\s*var\(--top-chrome-bottom/);
    expect(rule).toMatch(/max-height:\s*calc\(100vh\s*-\s*var\(--top-chrome-bottom/);
    // Its child is the scroll region; the shell must not clip instead.
    expect(stylesCss).toMatch(/\.bar-dropdown[\s\S]{0,400}?\.control-menu-inner\s*\{[^}]*overflow-y:\s*auto/);
  });
});

describe("the popup ✕ must be on-screen on a phone", () => {
  test("Leaflet is told the PRE-zoom width", () => {
    // .leaflet-popup-content-wrapper carries `zoom: var(--ui-zoom)`
    // (115 % by default). Leaflet measures offsetWidth before that zoom,
    // so a 341 px layout rendered 392 px and pushed the popup — and the
    // ✕ anchored to its right edge — off a 393 px screen.
    expect(appJs).toMatch(/function popupUiZoom/);
    expect(appJs).toMatch(/function popupMaxWidthForViewport/);
    expect(appJs).toMatch(/maxWidth:\s*popupMaxWidthForViewport\(\)/);
    // The pre-zoom width is divided by the zoom factor.
    expect(sliceFrom(appJs, "function popupMaxWidthForViewport", "// Standard Leaflet Popup"))
      .toMatch(/\/\s*zoom/);
  });

  test("the CSS max-width also divides by the zoom", () => {
    // max-width resolves INSIDE the zoomed coordinate space, so the
    // old `calc(100vw - 24px)` rendered 15 % wider than the viewport.
    const mq = sliceFrom(stylesCss, "/* ── Mobile popup fixes", "@media (max-width: 480px)");
    expect(mq).toMatch(/max-width:\s*calc\(\(100vw - 24px\)\s*\/\s*var\(--ui-zoom/);
  });

  test("autoPan is off and the app frames the popup itself", () => {
    // Leaflet's autoPan is animated, so a correction run right after
    // popupopen races with it and the popup lands wherever the last
    // pan finished. One measured, immediate pan replaces it.
    const opts = sliceFrom(appJs, "const POPUP_OPTIONS", "const XYZO_DEBUG");
    expect(opts).toMatch(/autoPan:\s*false/);
    expect(appJs).toMatch(/function keepPopupOnScreen/);
  });

  test("keepPopupOnScreen clears the search bar and the bottom bar", () => {
    // A popup whose ✕ sits behind the search pill is exactly as
    // un-closable as one pushed off the edge of the screen.
    const fn = sliceFrom(appJs, "function keepPopupOnScreen", 'map.on("popupopen"');
    expect(fn).toMatch(/#search-bar/);
    expect(fn).toMatch(/#bottom-bar/);
    // Pans the MAP, not the popup — the popup stays anchored to its pin.
    expect(fn).toMatch(/map\.panBy\(\[dx, dy\],\s*\{\s*animate:\s*false\s*\}\)/);
    // Only corrects an axis the popup actually fits on.
    expect(fn).toMatch(/r\.height <= size\.y/);
    expect(fn).toMatch(/r\.width <= size\.x/);
  });

  test("the popup waits for the pan to settle before opening", () => {
    // A popup that opens mid-pan slides for the rest of the animation and
    // a tap aimed at the ✕ lands where it used to be.
    const fn = sliceFrom(appJs, "function openPinPopup", "function updateUrlHash");
    expect(fn).toMatch(/map\.once\("moveend"/);
    expect(fn).toMatch(/isCoarsePointer\(\)\s*\?\s*600\s*:\s*150/);
  });

  test("a coarse-pointer probe exists", () => {
    expect(appJs).toMatch(/function isCoarsePointer|const isCoarsePointer/);
    // pointer: coarse catches landscape phones and tablets that a width
    // check misses; maxTouchPoints catches the rest.
    expect(appJs).toMatch(/pointer:\s*coarse/);
    expect(appJs).toMatch(/maxTouchPoints/);
  });
});

describe("3D globe panel must be dismissible", () => {
  test("globe.html has a ✕ in the panel and a ☰ to bring it back", () => {
    expect(globeHtml).toMatch(/id="globe-panel-close"/);
    expect(globeHtml).toMatch(/id="globe-panel-open"/);
    // Without the reopen button the ✕ is a one-way door.
    expect(globeHtml).toMatch(/☰ Layers/);
  });

  test("globe.js wires both directions", () => {
    const fn = sliceFrom(globeJs, "(function wireGlobePanel", "// ── keyboard: escape");
    expect(fn).toMatch(/globe-panel-close/);
    expect(fn).toMatch(/globe-panel-open/);
    expect(fn).toMatch(/globe-panel-hidden/);
    // The choice survives a reload, like the rest of the view state.
    expect(fn).toMatch(/settings\.panelOpen/);
    expect(fn).toMatch(/saveSettings/);
    // A phone starts collapsed; a wide screen starts open.
    expect(fn).toMatch(/innerWidth\s*>\s*640/);
    // The canvas is offset on wide screens, so it must be re-measured.
    expect(fn).toMatch(/map\.resize\(\)/);
  });

  test("globe.css hides the panel in the collapsed state", () => {
    expect(globeCss).toMatch(/body\.globe-panel-hidden\s+#globe-panel\s*\{\s*display:\s*none/);
    // The ☰ must not be visible while the panel is open.
    expect(globeCss).toMatch(/#globe-panel-open\[hidden\]\s*\{\s*display:\s*none/);
  });

  test("MapLibre's 29px controls are raised to 44px on a coarse pointer", () => {
    const mq = sliceFrom(globeCss, "@media (pointer: coarse)", "/* The header bar");
    expect(mq).toMatch(/\.maplibregl-ctrl-group button/);
    expect(mq).toMatch(/44px/);
  });
});

describe("the outage banner must not cover a popup's ✕", () => {
  test("the banner reserves the measured chrome, not just --top-band", () => {
    // --top-band measures the CONTROL STACK only, so the banner slid
    // under the search pill and over the top of any top-anchored popup.
    // It is z-index 9999 against the popup pane's 1200, so the popup's
    // ✕ became untappable for the whole duration of an outage.
    const rule = sliceFrom(stylesCss, ".system-wide-error-banner {", ".system-error-inner");
    expect(rule).toMatch(/--map-top-chrome/);
    expect(rule).toMatch(/--bottom-bar-h/);
  });

  test("the banner is capped to the space that is actually free", () => {
    const rule = sliceFrom(stylesCss, ".system-wide-error-banner {", ".system-error-inner");
    expect(rule).toMatch(/max-height:/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  test("app.js publishes --map-top-chrome from the real search bar", () => {
    const fn = sliceFrom(appJs, "(function trackControlBand", "// Save map position/zoom");
    expect(fn).toMatch(/--map-top-chrome/);
    // app.js reaches the bar by id, not by selector.
    expect(fn).toMatch(/getElementById\("search-bar"\)/);
    // Re-measures on the same triggers as --top-band, plus once after
    // i18n has had a chance to grow the label.
    expect(fn).toMatch(/ResizeObserver/);
    expect(fn).toMatch(/orientationchange/);
  });

  test("the banner is still dismissible", () => {
    expect(appJs).toMatch(/system-banner-close-btn/);
  });
});

describe("the debug overlay must not ship to every visitor", () => {
  test("map-debug.js is gated behind an explicit opt-in", () => {
    // The 🐛 button is fixed at bottom:12px / left:12px, which on a phone
    // lands on the language selector in #bottom-bar.
    expect(mapDebugJs).toMatch(/function debugEnabled/);
    expect(mapDebugJs).toMatch(/if \(debugEnabled\(\)\) whenMap\(init, 60\)/);
  });

  test("index.html versions map-debug.js", () => {
    // It had no ?v= token, so a cached copy could never pick up a fix.
    expect(indexHtml).toMatch(/map-debug\.js\?v=\d+/);
  });
});
