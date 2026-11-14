// control-chrome-collision.bun.test.js — the clear band, and who may sit in it.
//
// The 2026-10-30 mobile review found the bottom-bar dropdowns anchored to
// TYPED constants that had drifted from the real chrome, so the control
// menu collided with three different pieces of furniture depending on
// which anchor you fixed. Measured on an iPhone 14 Pro (393x660):
//
//   1. bottom: 58px — the bar's HEIGHT, not its top edge (70px). The menu
//      sat 12px INSIDE the bar and its last row, "AI / Help", was
//      half-hidden behind it.
//   2. No top constraint at all — the menu is 799px tall in a 538px clear
//      band, so growing up from the bottom put it under the search pill.
//   3. #help-me-btn is z 9998 against the dropdown's z 10000, and it
//      floated OVER the menu, covering ~5 rows ("MY STYLE", "Save this
//      view", "Next visit", "My default map" — about 45,000 px²).
//
// The fix publishes BOTH chrome edges at run-time and parks anything else
// in the band while a dropdown is open. These are static checks on the
// shipped source; the live geometry is covered by the Playwright harness
// (see README, "Mobile & 3D-globe review").

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const globeCss = readFileSync(join(ROOT, "globe.css"), "utf8");
const globeHtml = readFileSync(join(ROOT, "globe.html"), "utf8");
const mapDebugJs = readFileSync(join(ROOT, "map-debug.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

// Slice a function (or IIFE body) out of a source string by its start
// marker and a terminator.
function sliceFrom(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i + startMarker.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

// Strip /* ... */ and // comments. Needed whenever a test asserts on the
// ABSENCE of a declaration: a rule that explains why it does not do
// something naturally names the thing, and a naive substring match then
// fails on the comment rather than on the code.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the control menu is clamped between the two chrome edges", () => {
  test("app.js publishes the bottom bar's TOP EDGE, not its height", () => {
    // The bar is itself offset from the viewport bottom by 12px (plus
    // env(safe-area-inset-bottom) on an iPhone), so its height is NOT the
    // distance a bottom-anchored fixed element has to clear. Height alone
    // is what put the menu 12px inside the bar.
    const fn = sliceFrom(appJs, "(function publishChromeEdges", "\n})();");
    expect(fn).toMatch(/--bottom-bar-top/);
    // window.innerHeight - r.top is the bar's top edge measured from the
    // bottom of the viewport — the quantity a `bottom:` anchor needs.
    expect(fn).toMatch(/innerHeight\s*-\s*r\.top/);
  });

  test("app.js publishes #top-bar's bottom edge", () => {
    // --top-band measures the MAP control stack, which sits BELOW the
    // search pill, so it is not the edge an overlay anchored at the top
    // has to clear. A menu clamped to it slid under the pill.
    const fn = sliceFrom(appJs, "(function publishChromeEdges", "\n})();");
    expect(fn).toMatch(/--top-chrome-bottom/);
    expect(fn).toMatch(/getElementById\("top-bar"\)/);
    expect(fn).toMatch(/\.bottom/);   // the edge, not the height
  });

  test("both edges re-measure, not just once at boot", () => {
    // The bands move: the bar grows by the safe-area inset, #top-bar grows
    // with the text-size zoom and with the i18n labels that land after
    // first paint. A one-shot measurement goes stale on rotate.
    const fn = sliceFrom(appJs, "(function publishChromeEdges", "\n})();");
    expect(fn).toMatch(/ResizeObserver/);
    expect(fn).toMatch(/orientationchange/);
    expect(fn).toMatch(/setTimeout\(sync/);
  });

  test("the menu's CSS reads BOTH measured edges", () => {
    const rule = sliceFrom(stylesCss, ".bar-dropdown {", "}");
    expect(rule).toMatch(/bottom:\s*calc\(var\(--bottom-bar-top/);
    expect(rule).toMatch(/top:\s*var\(--top-chrome-bottom/);
    // The height follows from the two edges. It must NOT be restated in
    // the --wide rule below, where a second calc would undershoot the band.
    expect(rule).toMatch(/max-height:\s*calc\(100vh\s*-\s*var\(--top-chrome-bottom/);
  });

  test("the --wide variant does NOT restate a max-height", () => {
    // A second `calc(100vh - 110px)` here would ignore that the bar's top
    // edge is 70px up, not 58, and undershoot the band.
    const wide = stripComments(sliceFrom(stylesCss, ".bar-dropdown--wide {", "min-height: 0;"));
    expect(wide).not.toMatch(/max-height/);
  });
});

describe("the control menu scrolls instead of overflowing", () => {
  test("the inner element is the scroll region", () => {
    // The menu is 799px tall in a 538px band, so it can never fit. The
    // shell clamps; the inner scrolls.
    expect(stylesCss).toMatch(/\.control-menu-inner\s*\{[^}]*overflow-y:\s*auto/);
  });

  test("the shell can shrink below its content's height", () => {
    // min-height:0 is load-bearing, not decoration: the shell is a column
    // flex container, so its child's automatic minimum is its content
    // height. Without this the inner STRETCHES to 918px, overflows the
    // ~550px shell, and overflow-y:auto never engages — scrollHeight and
    // clientHeight both read 918 and nothing scrolls. flex:1 1 auto
    // resolves the basis against the shell's definite box instead.
    const wide = sliceFrom(stylesCss, ".bar-dropdown--wide {", "}");
    expect(wide).toMatch(/min-height:\s*0/);
    expect(wide).toMatch(/display:\s*flex/);
    expect(wide).toMatch(/flex-direction:\s*column/);
    expect(stylesCss).toMatch(/\.control-menu-inner\s*\{[^}]*flex:\s*1\s*1\s*auto/);
  });

  test("the menu is wide enough for its widest row", () => {
    // Shrink-to-fit settled at 323px while the widest row (four 44px
    // chips) needed 333px, so the "✨ Cool" chip lost its tail. Because
    // the shell is centred with translateX(-50%), max-content re-centres
    // rather than pushing off-screen.
    const wide = sliceFrom(stylesCss, ".bar-dropdown--wide {", "}");
    expect(wide).toMatch(/width:\s*max-content/);
  });
});

describe("nothing else may sit in the clear band while a dropdown is open", () => {
  test("open state is flagged on <body>", () => {
    expect(appJs).toMatch(/function setDropdownOpen/);
    expect(appJs).toMatch(/body\.setAttribute\("data-dropdown-open"/);
  });

  test("the flag is set when a dropdown is about to open", () => {
    // closeOtherMenus runs BEFORE the caller shows its menu, so the answer
    // is simply "one is about to be open" — there is no second loop to
    // write, and a second loop could only ever see the menus just closed.
    const fn = stripComments(sliceFrom(appJs, "function closeOtherMenus", "\n}"));
    expect(fn).toMatch(/setDropdownOpen\(\s*!!exceptMenuId\s*\)/);
    expect(fn).not.toMatch(/anyOpen/);   // the dead loop that was removed
  });

  test("a click outside any dropdown clears the flag", () => {
    // Each dropdown hides its own menu in several places (its toggle's
    // else-branch, an outside-click handler, an option click). Patching
    // every one would mean six sites that can drift out of sync; one
    // listener catches all of them, because the click that closes a menu
    // is by definition not inside one.
    const fn = sliceFrom(appJs, "document.addEventListener(\"click\", (e) => {\n  if (!document.body.hasAttribute(\"data-dropdown-open\"))", "\n});");
    expect(fn).toMatch(/closest\("#time-dropdown-menu, #markers-dropdown-menu, #control-menu"\)/);
    expect(fn).toMatch(/setDropdownOpen\(false\)/);
  });

  test("CSS parks the Help Me pill while a dropdown is open", () => {
    // The pill is z 9998, the dropdown z 10000, so the pill painted OVER
    // the menu. On a 393px phone the menu is centred and spans the whole
    // band, so there is nowhere the pill could move to; hiding it costs
    // nothing because it is an emergency affordance, not a control.
    expect(stylesCss).toMatch(/body\[data-dropdown-open\]\s*#help-me-btn\s*\{[^}]*opacity:\s*0/);
    expect(stylesCss).toMatch(/body\[data-dropdown-open\]\s*#help-me-btn\s*\{[^}]*pointer-events:\s*none/);
  });
});

describe("the popup is sized in PRE-zoom widths", () => {
  // .leaflet-popup-content-wrapper carries `zoom: var(--ui-zoom)` (115 %
  // by default). CSS zoom is INVISIBLE to Leaflet: it measures
  // offsetWidth before the zoom, so a 341px popup rendered 392px and the
  // ✕ Close — absolutely anchored to the RENDERED right edge — landed off
  // the right-hand side of a 393px screen.
  test("popupUiZoom() reads the text-size zoom", () => {
    const fn = sliceFrom(appJs, "function popupUiZoom", "\n}");
    expect(fn).toMatch(/--ui-zoom/);
  });

  test("the width handed to Leaflet is divided by the zoom", () => {
    const fn = sliceFrom(appJs, "function popupMaxWidthForViewport", "\n}");
    expect(fn).toMatch(/\/\s*zoom/);
  });

  test("the CSS max-width is divided by the zoom too", () => {
    // max-width resolves INSIDE the zoomed coordinate space, so a bare
    // `calc(100vw - 24px)` rendered 15% wider than the viewport.
    expect(stylesCss).toMatch(/max-width:\s*calc\(\(100vw - 24px\)\s*\/\s*var\(--ui-zoom/);
  });

  test("the popup is framed by our own measurement, not Leaflet's autoPan", () => {
    // Leaflet's autoPan is ANIMATED, so a correction right after
    // popupopen races with it — measured 2 of 6 popups still off-screen.
    const opts = sliceFrom(appJs, "const POPUP_OPTIONS", "\n};");
    expect(opts).toMatch(/autoPan:\s*false/);
    expect(appJs).toMatch(/function keepPopupOnScreen/);
  });

  test("the framing clears the fixed chrome, not just the screen edge", () => {
    // A popup whose ✕ lands behind the search pill or #bottom-bar is
    // exactly as un-closable as one pushed off-screen.
    const fn = sliceFrom(appJs, "function keepPopupOnScreen", "\nmap.on(\"popupopen\"");
    expect(fn).toMatch(/#search-bar/);
    expect(fn).toMatch(/#bottom-bar/);
    // The inset must be read off the ELEMENT. Passing a rect into
    // getComputedStyle threw a TypeError on every popup open on a phone.
    expect(fn).toMatch(/getComputedStyle\(el\)/);
    expect(fn).not.toMatch(/getComputedStyle\(top\)/);
    expect(fn).not.toMatch(/getComputedStyle\(bottom\)/);
  });
});

describe("the 3D globe panel must be dismissible", () => {
  test("the panel has a ✕ and a way back", () => {
    // Without the reopen button the ✕ is a one-way door: on a phone the
    // panel is 298x606 on a 393x660 screen — 76% of the width — with no
    // other route back to the overlay list.
    expect(globeHtml).toMatch(/id="globe-panel-close"/);
    expect(globeHtml).toMatch(/id="globe-panel-open"/);
  });

  test("the closed state is a body class CSS can key off", () => {
    expect(globeJs).toMatch(/classList\.toggle\("globe-panel-hidden"/);
    expect(globeCss).toMatch(/body\.globe-panel-hidden\s+#globe-panel\s*\{\s*display:\s*none/);
    // The reopen button must not linger while the panel is open.
    expect(globeCss).toMatch(/#globe-panel-open\[hidden\]\s*\{\s*display:\s*none/);
  });

  test("the choice persists and a phone starts collapsed", () => {
    const fn = sliceFrom(globeJs, "(function wireGlobePanel", "\n  })();");
    expect(fn).toMatch(/settings\.panelOpen/);
    expect(fn).toMatch(/saveSettings/);
    // A remembered choice wins; otherwise the globe is the point of the
    // page on a phone and the panel is settings.
    expect(fn).toMatch(/innerWidth\s*>\s*640/);
  });

  test("the canvas is re-measured after the panel moves", () => {
    // The canvas is offset on wide screens to clear the panel.
    const fn = sliceFrom(globeJs, "(function wireGlobePanel", "\n  })();");
    expect(fn).toMatch(/map\.resize\(\)/);
  });

  test("MapLibre's own controls are raised to 44px on a coarse pointer", () => {
    // They ship at 29px. The flat map's Leaflet controls got this rule;
    // the globe's never did.
    const coarse = sliceFrom(globeCss, "@media (pointer: coarse)", "\n}");
    expect(coarse).toMatch(/\.maplibregl-ctrl-group button/);
    expect(coarse).toMatch(/width:\s*44px/);
    expect(coarse).toMatch(/#globe-panel-close\s*\{[^}]*44px/);
  });
});

describe("the debug overlay must not ship to every visitor", () => {
  test("map-debug.js is gated behind an explicit opt-in", () => {
    // It put a "🐛 debug" button at bottom:12px / left:12px, on top of the
    // language selector in #bottom-bar.
    expect(mapDebugJs).toMatch(/function debugEnabled/);
    expect(mapDebugJs).toMatch(/if\s*\(\s*debugEnabled\(\)\s*\)/);
  });

  test("index.html versions map-debug.js", () => {
    // A stale ?v= is how the Köppen layer went missing for cached browsers.
    expect(indexHtml).toMatch(/map-debug\.js\?v=\d+/);
  });
});
