/**
 * Interaction preferences — owner spec 2026-10-29.
 *
 * Three accessibility affordances, each a static-analysis guard over
 * the source that implements it:
 *
 *  1. TEXT SIZE — A / A+ / A++ in the control menu; default A+ (115 %)
 *     because "a little larger anyway". The early <head> script applies
 *     the stored class BEFORE first paint; the CSS zooms inner content
 *     only (never positioned boxes with vh/calc heights or centered
 *     transforms — that shifts them off-screen).
 *
 *  2. DOUBLE-CLICK TO SUBMIT — elderly users were opening the submitter
 *     by ACCIDENT on a single tap. A first click leaves a hint; only a
 *     second click within 500 ms / 40 px opens the form. The map's own
 *     doubleClickZoom is disabled so the gesture is exclusively "add a
 *     story". Probe-armed single clicks stay single-click (they return
 *     earlier in the guard chain).
 *
 *  3. SAVED STYLES — one click saves view + base + overlays + opacity;
 *     one click restores. Restore reuses applyLayersFromParsedHash (the
 *     shared-link path) so a saved style and a pasted URL can never
 *     diverge.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const stylesCss = readFileSync(join(root, "styles.css"), "utf8");

describe("text size (A / A+ / A++)", () => {
  test("default is A+ — the early script only applies NON-default classes", () => {
    // The <head> script runs before first paint so the page never
    // flashes at the wrong size; "115" needs no class (html's own
    // --ui-zoom is 1.15).
    expect(indexHtml).toMatch(/localStorage\.getItem\("xyzo\.textSize"\)/);
    expect(indexHtml).toMatch(/ts-"\+t|"ts-"\s*\+|ts-\$\{?t/);
    // No stored preference must still yield the larger default.
    expect(stylesCss).toMatch(/html\s*\{\s*--ui-zoom:\s*1\.15/);
  });

  test("the two override steps exist in CSS", () => {
    expect(stylesCss).toMatch(/html\.ts-100\s*\{\s*--ui-zoom:\s*1;\s*\}/);
    expect(stylesCss).toMatch(/html\.ts-130\s*\{\s*--ui-zoom:\s*1\.3;\s*\}/);
  });

  test("zoom targets are INNER content, never the positioned boxes", () => {
    // Zooming .live-panel or .bar-dropdown themselves multiplies their
    // vh/calc heights and translateX(-50%) — the panel slides off
    // screen. The target list must be inner elements only.
    const zoomRules = stylesCss.match(/[^{}]*\{[^}]*zoom:\s*var\(--ui-zoom\)[^}]*\}/g) || [];
    expect(zoomRules.length).toBeGreaterThan(0);
    for (const rule of zoomRules) {
      // A bare `.live-panel {` or `.bar-dropdown {` selector (without
      // `> *` or a child class) would be the dangerous form.
      expect(rule).not.toMatch(/^\s*\.live-panel\s*\{/);
      expect(rule).not.toMatch(/^\s*\.bar-dropdown\s*\{/);
      expect(rule).not.toMatch(/^\s*#bottom-bar\s*\{/);
      expect(rule).not.toMatch(/^\s*body\s*\{/);
      expect(rule).not.toMatch(/^\s*html\s*\{/);
    }
    // The popup content wrapper is safe (no vh heights, no transform).
    expect(stylesCss).toMatch(/\.leaflet-popup-content-wrapper[^{]*\{[^}]*zoom:\s*var\(--ui-zoom\)/s);
  });

  test("the control menu offers the picker and app.js wires it", () => {
    expect(indexHtml).toMatch(/id="text-size-picker"/);
    for (const s of ["100", "115", "130"]) {
      expect(indexHtml).toMatch(new RegExp(`data-size="${s}"`));
    }
    expect(appJs).toMatch(/text-size-picker/);
    expect(appJs).toMatch(/xyzo\.textSize/);
    // The default when nothing is stored must be the larger step.
    expect(appJs).toMatch(/localStorage\.getItem\("xyzo\.textSize"\)\s*\|\|\s*"115"/);
  });
});

describe("double-click to submit", () => {
  test("the map's doubleClickZoom is disabled — the gesture is 'add a story'", () => {
    expect(appJs).toMatch(/doubleClickZoom:\s*false/);
  });

  test("the gate requires a second click within 500 ms and 40 px", () => {
    expect(appJs).toMatch(/_submitTap/);
    expect(appJs).toMatch(/\(now - _submitTap\.t\) < 500/);
    expect(appJs).toMatch(/<\s*40/);
    // A first click must NOT reach openSubmitAtPoint — only the
    // double-click branch may call it.
    expect(appJs).toMatch(/if \(!dbl\) \{\s*\n\s*showSubmitHint/);
  });

  test("the first click leaves a hint, and the hint never steals clicks", () => {
    expect(appJs).toMatch(/function showSubmitHint/);
    expect(appJs).toMatch(/Double-click to add a story here/);
    expect(stylesCss).toMatch(/\.submit-hint\b/);
    // pointer-events: none is load-bearing — the second click lands on
    // the map THROUGH the hint.
    expect(stylesCss).toMatch(/\.submit-hint\s*\{[^}]*pointer-events:\s*none/s);
  });

  test("probe-armed single clicks are unaffected (guards stay BEFORE the gate)", () => {
    // The blocksClick guards must appear before openSubmitAtPoint in the
    // click handler, or arming a probe would now need a double-click.
    const guardsAt = appJs.indexOf("window.BasinLayer.blocksClick");
    const gateAt = appJs.indexOf("if (!dbl)");
    expect(guardsAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(guardsAt);
  });
});

describe("satellite offer on the lone click (right-click stays native)", () => {
  test("the context menu is NEVER intercepted — Inspect must survive", () => {
    // Owner constraint 2026-10-29: right-click on the map must keep the
    // browser's native menu (Inspect, Save image, extensions). A page
    // cannot ADD items to that menu, so the satellite affordance hangs
    // off the lone click instead — and nothing may ever preventDefault
    // a contextmenu.
    expect(appJs).not.toMatch(/on\(\s*["']contextmenu["']/);
    expect(appJs).not.toMatch(/addEventListener\(\s*["']contextmenu["']/);
    expect(appJs).not.toMatch(/["']contextmenu["'][\s\S]{0,160}preventDefault\(/);
  });

  test("the hint morphs into the satellite offer only AFTER the 500 ms window", () => {
    // A fast double-click must still submit; the chip changes job just
    // past the gate so a slow second tap was never a submit anyway.
    expect(appJs).toMatch(/View satellite of this spot/);
    expect(appJs).toMatch(/is-satellite/);
    const morphAt = appJs.indexOf("}, 520)");
    const gateAt = appJs.indexOf("if (!dbl)");
    expect(morphAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    // The morph lives inside showSubmitHint (before the click gate).
    const showAt = appJs.indexOf("function showSubmitHint");
    expect(showAt).toBeGreaterThan(-1);
    expect(morphAt).toBeGreaterThan(showAt);
    expect(gateAt).toBeGreaterThan(morphAt);
    // …and a real double-click kills the hint + morph before opening
    // the submitter, so the offer never floats over the form.
    expect(appJs).toMatch(/hideSubmitHint\(\);\s*\n\s*openSubmitAtPoint/);
  });

  test("the chip's satellite click never bubbles into the map's own gate", () => {
    // The chip lives inside the map container — a bubbling click would
    // be seen as an empty-map tap (two of them = phantom submitter).
    const listenerAt = appJs.indexOf('_submitHintEl.addEventListener("click"');
    expect(listenerAt).toBeGreaterThan(-1);
    expect(appJs.slice(listenerAt, listenerAt + 400)).toMatch(/stopPropagation/);
    expect(appJs.slice(listenerAt, listenerAt + 400)).toMatch(/openSatellitePopup/);
    // The hint keeps its submit-phase contract: pointer-events:none
    // until .is-satellite (pinned in CSS below and by the base rule).
    expect(appJs).toMatch(/classList\.remove\("is-satellite"\)/);
  });

  test("the mini map's host is found THROUGH THE POPUP, never by a document-wide id", () => {
    // Owner report 2026-11-08: *"Uncaught Error: Map container is
    // already initialized"* — thrown by `L.map()` inside
    // openSatellitePopup.
    //
    // THE TRAP: `document.getElementById("sat-popup-map")` returns the
    // FIRST element with that id in the DOCUMENT, and the popup pane
    // can hold more than one satellite popup at once — the one fading
    // out (Leaflet removes a closed popup's container 200 ms AFTER
    // the close) and any ghost the auto-restore re-opened. Leaflet
    // REFUSES to initialise a container that already carries a map
    // ("Map container is already initialized" — an UNCAUGHT error,
    // because the build runs in a timer, outside the try/catch), and
    // when it does initialise, it initialises the WRONG element: the
    // popup the reader is looking at then shows an empty grey box.
    //
    // Measured before the fix (Playwright, Firefox): a second satellite
    // popup opened inside the 200 ms fade put the map in the OLD,
    // fading popup — the visible one's host had no `_leaflet_id` and
    // no children at all.
    const popAt = appJs.indexOf("function openSatellitePopup");
    expect(popAt).toBeGreaterThan(-1);
    const body = appJs.slice(popAt, appJs.indexOf("\nmap.on(\"click\"", popAt));
    // The host is read out of the popup's OWN element…
    expect(body).toMatch(/querySelector\("\.sat-popup-map"\)/);
    // …and there is NO document-wide id lookup left anywhere in it.
    // (Comments are stripped first — the fix NOTE quotes the broken
    // call, exactly like the broken call it replaced.)
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/getElementById\("sat-popup-map"\)/);
    // A stale `_leaflet_id` (an orphaned map) means the element cannot
    // be initialised again — so a FRESH element replaces it.
    expect(body).toMatch(/target\._leaflet_id/);
    expect(body).toMatch(/cloneNode\(false\)/);
    // A failure is LOGGED, never thrown into the reader's console.
    expect(body).toMatch(/XLog\.warn\("\[satellite-popup\] mini map failed/);
    // The pending build is CANCELLED when the popup closes, and the
    // map is removed with it.
    expect(body).toMatch(/clearTimeout\(miniTimer\)/);
    expect(body).toMatch(/popup\.on\("contentupdate"/);
  });

  test("the popup offers Google + Bing satellite of the EXACT point", () => {
    expect(appJs).toMatch(/function openSatellitePopup/);
    expect(appJs).toMatch(/google\.com\/maps\/@\$\{lat\},\$\{lng\},16z\/data=!3m1!1e3/);
    expect(appJs).toMatch(/bing\.com\/maps\?cp=\$\{lat\}~\$\{lng\}&lvl=16&style=a/);
    // Coordinates are wrapped to [-180,180] before going in a URL.
    expect(appJs).toMatch(/latlng\.lng \+ 180\) % 360/);
    // Outbound links open in a new tab and never hand the referrer over.
    expect(appJs).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });

  test("the popup follows the house popup rules", () => {
    // Custom close button (Leaflet's own is hidden by CSS) — the
    // central popupopen handler wires it via attachPopupClose, which
    // DELEGATES from the .leaflet-popup element ABOVE .sat-popup. The
    // root's stopPropagation must therefore let close-button clicks
    // through, or ✕ is dead (the 2026-10-29 bug).
    expect(appJs).toMatch(/sat-popup[\s\S]{0,400}popup-close-btn/);
    const addAt = appJs.indexOf('popup.on("add"');
    expect(addAt).toBeGreaterThan(-1);
    const addBody = appJs.slice(addAt, appJs.indexOf('popup.on("remove"'));
    expect(addBody).toMatch(/root\.addEventListener\("click"/);
    expect(addBody).toMatch(/stopPropagation/);
    expect(addBody).toMatch(/closest\("\.popup-close-btn, \.popup-close-btn-mobile"\)\) return/);
    // The contextmenu is NOT stopped — right-click → Inspect works
    // over the popup too.
    expect(addBody).not.toMatch(/contextmenu/);
    // The nested mini map is destroyed on close — a leaked Leaflet
    // instance keeps drawing tiles forever behind the popup.
    expect(appJs).toMatch(/_satMiniMap\.remove\(\)/);
  });

  test("the mini map uses PLAIN tiles at z12 — Esri degrades CORS requests", () => {
    // Two hard-won rules (2026-10-29): (1) NEVER crossOrigin these
    // tiles — Esri answers Origin-bearing requests with flat placeholder
    // JPEGs where a plain <img> of the same URL returns real imagery
    // (and a tainted canvas can't be read anyway, so pixel-classifying
    // plain tiles is impossible); (2) z12 not z16 — Esri has no z16
    // imagery for much of the world (ocean, interior Suriname: HTTP 200
    // + flat #CCCCCC), while z12 is broadly covered. The popup must
    // behave exactly like the Satellite basemap.
    const popAt = appJs.indexOf("function openSatellitePopup");
    const removeAt = appJs.indexOf('popup.on("remove"', popAt);
    const body = appJs.slice(popAt, removeAt);
    // The exact option shape IS the pin: any crossOrigin added to the
    // tileLayer call breaks the match (the comment may mention it).
    expect(body).toMatch(/L\.tileLayer\(url,\s*\{\s*maxZoom:\s*19,\s*attribution:\s*attr\s*\}\)/);
    expect(body).toMatch(/zoom:\s*12/);
    expect(body).toMatch(/scrollWheelZoom:\s*false/);
    // The pixel-classifier machinery is gone for good — nobody may
    // reintroduce a CORS probe that fights Esri's placeholders.
    expect(appJs).not.toMatch(/isPlaceholder/);
    expect(appJs).not.toMatch(/is-probing/);
    expect(appJs).not.toMatch(/_satStepTimer/);
  });

  test("the mini map reuses the Satellite basemap's own tiles + attribution", () => {
    expect(appJs).toMatch(/TILE_LAYERS\["🛰️ Satellite"\]/);
    // The Esri URL itself now lives server-side (tileMirror.ts builds it
    // from a whitelist), so what has to hold HERE is that the mini map
    // reuses the SAME entry — one layer, one attribution — and that the
    // credit to Esri still ships with it. Losing the attribution would
    // be a licence breach, and that is what this line protects.
    expect(appJs).toMatch(/\/api\/tile\/mirror\/esri-imagery\/\{z\}\/\{x\}\/\{y\}/);
    expect(appJs).toMatch(/Source: Esri, Maxar, Earthstar Geographics/);
    expect(appJs).toMatch(/scrollWheelZoom:\s*false/);
  });

  test("CSS: clickable only in the satellite state", () => {
    // Base rule stays pointer-events:none (pinned above); the morph
    // state opts in.
    expect(stylesCss).toMatch(/\.submit-hint\.is-satellite\s*\{[^}]*pointer-events:\s*auto/s);
    expect(stylesCss).toMatch(/\.sat-popup-map\s*\{/);
    expect(stylesCss).toMatch(/\.sat-popup-links\s*\{/);
  });
});

describe("saved styles (MY STYLE)", () => {
  test("capture uses the same slug + opacity helpers as the URL hash", () => {
    // A saved style and a shared link must never diverge — both go
    // through getLayerSlug + overlayOpacityFor.
    expect(appJs).toMatch(/function captureStyle/);
    const capture = appJs.slice(
      appJs.indexOf("function captureStyle"),
      appJs.indexOf("function applySavedStyle"));
    expect(capture).toMatch(/getLayerSlug\(name\)/);
    expect(capture).toMatch(/overlayOpacityFor\(name\)/);
    expect(capture).toMatch(/_activeOverlayNames/);
    expect(capture).toMatch(/_activeBaseLayerName/);
  });

  test("restore removes overlays the style does not contain", () => {
    // applyLayersFromParsedHash only ADDS; the removal half is what
    // makes the map match the snapshot exactly.
    const restore = appJs.slice(
      appJs.indexOf("function applySavedStyle"),
      appJs.indexOf("function styleLabel"));
    expect(restore).toMatch(/map\.removeLayer/);
    expect(restore).toMatch(/_activeOverlayNames\.delete/);
    // And the adds/opacity/base go through the shared-link path.
    expect(restore).toMatch(/applyLayersFromParsedHash/);
    // The isobar layer is not in WEATHER_OVERLAYS — it needs its own
    // disable, mirroring the hash-apply special case.
    expect(restore).toMatch(/IsobarLayer\.setEnabled\(false\)/);
  });

  test("styles persist in localStorage with a bounded list", () => {
    expect(appJs).toMatch(/xyzo\.savedStyles/);
    expect(appJs).toMatch(/SAVED_STYLES_MAX\s*=\s*8/);
    expect(appJs).toMatch(/slice\(0,\s*SAVED_STYLES_MAX\)/);
  });

  test("the control menu offers Save + the saved list + delete", () => {
    expect(indexHtml).toMatch(/id="ctrl-save-style"/);
    expect(indexHtml).toMatch(/id="saved-styles-list"/);
    expect(appJs).toMatch(/function renderSavedStyles/);
    expect(appJs).toMatch(/saved-style-del/);
    // Saving feedback: the button confirms, then reverts.
    expect(appJs).toMatch(/✓ Saved/);
  });
});

describe("the languages slug rename left no dangling names", () => {
  test("every language-slug alias resolves to the LIVE layer name", () => {
    // The Indigenous Languages layer was replaced by the Glottolog
    // languages layer; a slug still pointing at the old display name
    // resolves to nothing and the shared link silently does nothing.
    expect(appJs).not.toMatch(/"🌎 Indigenous Languages"/);
    expect(appJs).toMatch(/"languages":\s*"🌍 Languages"/);
    expect(appJs).toMatch(/"🌍 Languages":\s*"languages"/);
    // Legacy aliases keep working.
    expect(appJs).toMatch(/"indigenous":\s*"🌍 Languages"/);
    expect(appJs).toMatch(/"native-languages":\s*"🌍 Languages"/);
  });
});
