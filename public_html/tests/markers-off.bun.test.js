/**
 * Markers off-switch + layers-panel close (owner spec 2026-10-29).
 *
 * Three affordances, each a static-analysis guard:
 *
 *  1. MASTER MARKERS TOGGLE — a "Markers" checkbox row in the layers
 *     dropdown turns every pin-consuming mode (markers/clusters/heatmap)
 *     off at once. The mode buttons only switch BETWEEN modes; nobody
 *     discovers that clicking one twice clears the map.
 *
 *  2. LAYERS PANEL CLOSE — the panel is created with collapsed:false so
 *     it no longer auto-collapses on an outside click (it used to
 *     "suddenly disappear" mid-interaction). A visible ✕ is then the
 *     only explicit dismiss, alongside the stack-icon toggle.
 *
 *  3. PER-PIN ✕ DISMISS — DOM pins carry a hover-revealed ✕ that drops
 *     just that marker. Delegated from the map container in the CAPTURE
 *     phase so the pin's own click (which opens the popup) never fires.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const stylesCss = readFileSync(join(root, "styles.css"), "utf8");

describe("master markers toggle in the layers dropdown", () => {
  test("the checkbox row is injected as a sibling of the overlay list", () => {
    // Leaflet rebuilds the overlay list on every layer change — a row
    // INSIDE it would be wiped. Same contract as the links row.
    expect(appJs).toMatch(/function mountMarkersRow\(\)/);
    expect(appJs).toMatch(/leaflet-control-layers-overlays/);
    expect(appJs).toMatch(/insertAdjacentElement\("afterend", row\)/);
    expect(appJs).toMatch(/id="ctrl-markers-toggle"/);
  });

  test("it is re-mounted after Leaflet rebuilds the list", () => {
    // remountOverlaySliders runs on overlayadd/overlayremove; the
    // markers row must be re-injected there or it vanishes on first use.
    const fn = appJs.slice(
      appJs.indexOf("function remountOverlaySliders"),
      appJs.indexOf("map.on(\"overlayadd\", () => setTimeout(remountOverlaySliders"));
    expect(fn).toMatch(/mountMarkersRow\(\)/);
  });

  test("toggling off clears every pin-consuming mode at once", () => {
    const fn = appJs.slice(
      appJs.indexOf("function setMarkersVisible"),
      appJs.indexOf("function mountMarkersRow"));
    expect(fn).toMatch(/activeModes\.delete\("markers"\)/);
    expect(fn).toMatch(/activeModes\.delete\("clusters"\)/);
    expect(fn).toMatch(/activeModes\.delete\("heatmap"\)/);
    // Turning back on restores the default mode, never the user's
    // previous clusters/heatmap choice.
    expect(fn).toMatch(/activeModes\.size === 0\) activeModes\.add\("markers"\)/);
  });

  test("the mode-dropdown buttons + label stay in sync", () => {
    const fn = appJs.slice(
      appJs.indexOf("function setMarkersVisible"),
      appJs.indexOf("function mountMarkersRow"));
    expect(fn).toMatch(/getModeButtons\(\)/);
    expect(fn).toMatch(/markers-dropdown-label/);
    // The label reflects the OFF state too, or the button lies.
    expect(fn).toMatch(/"Off"/);
  });

  test("the checkbox reflects the live mode state", () => {
    expect(appJs).toMatch(/window\.__syncMarkersToggle/);
    // The sync helper reads the live mode set, but the INITIAL
    // checked-state must not (activeModes is a const declared ~750
    // lines later — reading it at parse time is a TDZ crash).
    const mountFn = appJs.slice(
      appJs.indexOf("function mountMarkersRow"),
      appJs.indexOf("wirePinDismiss();"));
    expect(mountFn).toMatch(/window\.__syncMarkersToggle = \(\) => \{ cb\.checked = markersVisible && activeModes\.size > 0; \}/);
    expect(mountFn).toMatch(/cb\.checked = markersVisible;/);
    // The sync helper above DOES read activeModes — correctly, since it
    // runs at runtime. The bug was only the INITIAL `cb.checked =` at
    // parse time. Assert the last `cb.checked` line is the bare form.
    const checkedLines = mountFn.split("\n").filter((l) => /cb\.checked =/.test(l));
    const initialLine = checkedLines[checkedLines.length - 1];
    expect(initialLine).toMatch(/cb\.checked = markersVisible;/);
    expect(initialLine).not.toMatch(/activeModes/);
  });
});

describe("layers panel close button", () => {
  test("both viewports start CLOSED, and the constructor still says isPhoneViewport()", () => {
    // OWNER RULE (2026-11-06): "don't start with the two control
    // windows open when someone first visits." Desktop and phone both
    // open on a closed panel now — the map is the first thing you see.
    //
    // The constructor option is unchanged and must stay
    // `isPhoneViewport()` — it decides the panel's SEMANTICS, not its
    // start state:
    //
    //   · collapsed:true (phone) makes Leaflet bind map-click →
    //     collapse and mouseenter → _expandSafely, which is what the
    //     touch handler builds on.
    //   · collapsed:false (desktop) binds NEITHER, so the panel is
    //     sticky once opened — no "suddenly disappears while you are
    //     reaching for a slider".
    //
    // The START STATE is a separate, explicit collapse() immediately
    // after addTo(map), in the same synchronous block — so desktop is
    // constructed open (collapsed:false makes _initLayout call
    // expand()) and closed again before anything can paint it.
    //
    // (This test used to assert a bare `collapsed: false` with a regex
    // that scanned past the constructor to an unrelated `false`
    // elsewhere in the file, so it kept passing after the phone
    // behaviour landed. Pin what the constructor actually says.)
    const ctor = appJs.slice(
      appJs.indexOf("L.control.layers(TILE_LAYERS, WEATHER_OVERLAYS, {"),
      appJs.indexOf("}).addTo(map)", appJs.indexOf("L.control.layers(TILE_LAYERS, WEATHER_OVERLAYS, {")));
    expect(ctor).toMatch(/collapsed:\s*isPhoneViewport\(\)/);
    expect(ctor).not.toMatch(/collapsed:\s*false/);
    // The start state: collapse() right after the control is added.
    const afterAdd = appJs.indexOf("}).addTo(map)", appJs.indexOf("L.control.layers(TILE_LAYERS"));
    expect(afterAdd).toBeGreaterThan(-1);
    expect(appJs.slice(afterAdd, afterAdd + 400)).toMatch(/layersControl\.collapse\(\)/);
    // …and isPhoneViewport() really is a phone test.
    const isPhoneAt = appJs.indexOf("const isPhoneViewport");
    const isPhoneEnd = appJs.indexOf("L.control.layers(TILE_LAYERS", isPhoneAt);
    expect(appJs.slice(isPhoneAt, isPhoneEnd)).toMatch(/max-width: 768px/);
  });

  test("a visible ✕ collapses the panel via the control API", () => {
    expect(appJs).toMatch(/function mountLayersCloseButton/);
    expect(appJs).toMatch(/leaflet-layers-close/);
    // Must call the control's own collapse(), not poke at classes —
    // Leaflet keeps internal state that a class-only close desyncs.
    expect(appJs).toMatch(/layersControl\.collapse\(\)/);
    expect(appJs).toMatch(/setAttribute\("aria-label", "Close layers panel"\)/);
  });

  test("the close button re-attaches after Leaflet rebuilds the panel", () => {
    const fn = appJs.slice(
      appJs.indexOf("function mountLayersCloseButton"),
      appJs.indexOf("// ── The layers toggle must open on a TOUCH"));
    expect(fn).toMatch(/map\.on\("overlayadd"/);
    expect(fn).toMatch(/map\.on\("overlayremove"/);
    // Idempotent: a re-attach must not double-wire.
    expect(fn).toMatch(/_xyzoCloseWired/);
  });

  test("the close button is styled and sized for touch", () => {
    expect(stylesCss).toMatch(/\.leaflet-layers-close\s*\{/);
    // 44px touch target on leaflet-touch (the map's own convention).
    expect(stylesCss).toMatch(/\.leaflet-touch \.leaflet-layers-close/);
  });
});

describe("per-pin dismiss button", () => {
  test("DOM pins carry a dismiss button", () => {
    expect(appJs).toMatch(/function buildMarkerDiv/);
    const fn = appJs.slice(
      appJs.indexOf("function buildMarkerDiv"),
      appJs.indexOf("function buildPinMarker"));
    expect(fn).toMatch(/class="pin-dismiss"/);
    expect(fn).toMatch(/aria-label="Dismiss this marker"/);
  });

  test("the handler is delegated from the map container, in capture phase", () => {
    // Pins are re-created constantly by renderPins; binding per-marker
    // would leak listeners. Capture phase + stopPropagation keeps the
    // pin's own click (which opens the popup) from firing.
    expect(appJs).toMatch(/function wirePinDismiss/);
    const fn = appJs.slice(
      appJs.indexOf("function wirePinDismiss"),
      appJs.indexOf("function buildPinMarker"));
    expect(fn).toMatch(/addEventListener\("click"/);
    expect(fn).toMatch(/\}, true\); \/\/ capture phase/);
    expect(fn).toMatch(/stopImmediatePropagation/);
    expect(fn).toMatch(/closest\("\.pin-dismiss"\)/);
  });

  test("dismissing removes the marker from the map and the registries", () => {
    const fn = appJs.slice(
      appJs.indexOf("function wirePinDismiss"),
      appJs.indexOf("function buildPinMarker"));
    expect(fn).toMatch(/map\.removeLayer\(marker\)/);
    expect(fn).toMatch(/pinMarkers\.delete\(id\)/);
    expect(fn).toMatch(/eventMarkers\.delete\(id\)/);
    // And the cluster groups, so a rebuild does not resurrect it.
    expect(fn).toMatch(/pinCluster\.removeLayer/);
    expect(fn).toMatch(/eventCluster\.removeLayer/);
  });

  test("the handler is wired once at startup", () => {
    // Declared as a function (hoisted) but called after mountMarkersRow,
    // where `map` is already in scope.
    expect(appJs).toMatch(/wirePinDismiss\(\);/);
    const defAt = appJs.indexOf("function wirePinDismiss");
    const callAt = appJs.indexOf("wirePinDismiss();");
    // The definition may come after the call (hoisting makes it safe),
    // but there must be exactly one call site in the init path.
    expect(defAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect((appJs.match(/wirePinDismiss\(\);/g) || []).length).toBe(1);
  });
});
