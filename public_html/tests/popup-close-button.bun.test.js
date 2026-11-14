/**
 * popup-close-button.bun.test.js — every popup must have a way out.
 *
 * Bug (2026-10-27): after a search, clicking a result opened a story
 * popup with NO close button. Leaflet's own × is hidden by CSS
 * (`.leaflet-container a.leaflet-popup-close-button { display: none
 * !important }`) because a custom `.popup-close-btn` replaced it — and
 * the event popup (the one a search result opens) never got one. The
 * map is created with `closePopupOnClick: false`, so clicking the map
 * does not dismiss it either. The popup was simply unclosable.
 *
 * The same gap was in the "N stories here" cluster popup and the
 * Wikipedia marker popup.
 *
 * These checks pin the invariant: every popup template renders a close
 * button, and the wiring is centralised on `popupopen` so a popup
 * builder added later cannot forget it.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

// ── slice helpers ──────────────────────────────────────────────────────

/** The body of a named `function name(...) { … }` declaration. */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return "";
  // Skip the parameter list — it can contain braces of its own
  // (`opts = {}`), which would throw the brace counter off.
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

/** A window of source around a marker, for templates that are not functions. */
function around(src, marker, before = 200, after = 1400) {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  return src.slice(Math.max(0, i - before), i + after);
}

/** The `map.on("popupopen", …)` handler. */
function slicePopupOpenHandler(src) {
  const start = src.indexOf('map.on("popupopen"');
  if (start < 0) return "";
  let depth = 0, end = -1, seen = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") { depth++; seen = true; }
    else if (c === "}") {
      depth--;
      if (seen && depth === 0) { end = i + 1; break; }
    }
  }
  return end < 0 ? "" : src.slice(start, end);
}

// ── the reason the custom button is mandatory ──────────────────────────
describe("popup close — Leaflet's own X is hidden", () => {
  test("the default Leaflet close button is display:none", () => {
    // This is WHY every popup needs a custom button: the built-in one
    // is not rendered.
    expect(stylesCss).toMatch(
      /\.leaflet-container a\.leaflet-popup-close-button\s*\{[^}]*display:\s*none\s*!important/
    );
  });

  test("the custom button is what remains", () => {
    expect(stylesCss).toMatch(/\.popup-close-btn\s*\{/);
    expect(stylesCss).toMatch(/\.popup-close-btn-mobile\s*\{/);
  });
});

// ── every popup template renders a close button ────────────────────────
describe("popup close — every popup template has a button", () => {
  test("the single-pin popup (buildPopup) has one", () => {
    const src = sliceFunction(appJs, "buildPopup");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/class="popup-close-btn"/);
    expect(src).toMatch(/class="popup-close-btn-mobile"/);
  });

  test("the search-result popup (buildEventPopup) has one", () => {
    // The one the bug report was about: a search result opens an
    // EVENT popup, and it had no button on either layout.
    const src = sliceFunction(appJs, "buildEventPopup");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/class="popup-close-btn"/);
    expect(src).toMatch(/class="popup-close-btn-mobile"/);
  });

  test("the event popup's desktop branch has the desktop button", () => {
    const src = sliceFunction(appJs, "buildEventPopup");
    // The mobile branch comes first, the desktop one after it.
    const mobile = src.indexOf("popup-close-btn-mobile");
    const desktop = src.indexOf('class="popup-close-btn"');
    expect(mobile).toBeGreaterThan(-1);
    expect(desktop).toBeGreaterThan(-1);
    expect(desktop).toBeGreaterThan(mobile);
  });

  test("the 'N stories here' cluster popup has one", () => {
    const src = around(appJs, "Zoom In ▸", 1200, 200);
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/class="popup-close-btn"/);
  });

  test("the Wikipedia marker popup has one", () => {
    // The wiki popup template is the one with the 180px min-width box;
    // "Open on Wikipedia" also appears in the search-results list.
    const src = around(appJs, 'style="min-width:180px"', 200, 1200);
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/class="popup-close-btn"/);
  });
});

// ── the wiring ─────────────────────────────────────────────────────────
describe("popup close — the wiring", () => {
  test("attachPopupClose exists and finds the button", () => {
    const src = sliceFunction(appJs, "attachPopupClose");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/\.popup-close-btn, \.popup-close-btn-mobile/);
    expect(src).toMatch(/addEventListener\("click"/);
    expect(src).toMatch(/window\.closeActivePopup\(\)/);
  });

  test("it is idempotent — the same element is never wired twice", () => {
    const src = sliceFunction(appJs, "attachPopupClose");
    expect(src).toMatch(/_xyzoCloseWired/);
  });

  test("every popupopen wires it centrally", () => {
    // Central wiring is what stops the next popup builder from
    // forgetting the button.
    const handler = slicePopupOpenHandler(appJs);
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/attachPopupClose\(e\.popup\.getElement\(\)\)/);
  });

  test("the pin and event popup paths wire it too", () => {
    expect(sliceFunction(appJs, "wirePopupActions")).toMatch(/attachPopupClose\(el\)/);
    expect(sliceFunction(appJs, "wireEventPopupActions")).toMatch(/attachPopupClose\(el\)/);
  });

  test("the button is reachable from the keyboard", () => {
    // It is a real <button>, so it is focusable and fires on Enter.
    const src = sliceFunction(appJs, "buildEventPopup");
    expect(src).toMatch(/<button class="popup-close-btn" aria-label="Close popup">/);
  });

  // ── the listener must be DELEGATED, not bound to the button ──────────
  //
  // Bug (2026-10-28): the ✕ did nothing. Leaflet's `Popup.update()` calls
  // `_updateContent()`, and the popup content is a FUNCTION
  // (`bindPopup(() => buildPopup(...))`), so the content DOM is rebuilt
  // and the button is REPLACED. The canvas pin path also rebuilds it
  // outright when the full pin data lands
  // (`popup.setContent(buildPopup(pinData))`).
  //
  // The listener was bound to the button, so it was thrown away with the
  // old node — and because the idempotency flag lived on the popup
  // ELEMENT, `attachPopupClose` returned early and never wired the
  // replacement. The popup element survives the rebuild, so the listener
  // has to be delegated from it.
  test("the listener is delegated from the popup element, not bound to the button", () => {
    const src = sliceFunction(appJs, "attachPopupClose");
    // Delegated from the element...
    expect(src).toMatch(/el\.addEventListener\("click"/);
    // ...resolving the button by closest() at click time...
    expect(src).toMatch(/closest\("\.popup-close-btn, \.popup-close-btn-mobile"\)/);
    // ...and NOT bound directly to the button (that is the bug).
    expect(src).not.toMatch(/closeBtn\.addEventListener\("click"/);
  });

  // ── the satellite popup's stopPropagation must not strand the ✕ ──────
  //
  // Bug (2026-10-29): the satellite popup's mini-map needs clicks
  // inside the popup to NOT bubble into the outer map's click gate
  // (two of them 500 ms apart would open the SUBMITTER over the
  // satellite view). openSatellitePopup therefore stops propagation
  // on the .sat-popup root — but that root sits INSIDE the popup
  // element where the CENTRAL attachPopupClose delegation lives, so
  // stopping every click also stranded the custom ✕: its click never
  // reached the delegated listener.
  //
  // The rule: the stopPropagation handler must let close-button
  // clicks THROUGH (return before stopping), so they bubble up to
  // the popup element and the central wiring catches them.
  test("the satellite popup's stopPropagation lets the close button through", () => {
    const src = sliceFunction(appJs, "openSatellitePopup");
    // The popup renders a custom ✕ (it is created with closeButton: false).
    expect(src).toMatch(/closeButton:\s*false/);
    expect(src).toMatch(/popup-close-btn/);
    // The root stops propagation (the mini-map must not leak clicks)…
    expect(src).toMatch(/stopPropagation/);
    // …but close-button clicks are exempt — the guard must exist and
    // must run BEFORE the stop.
    const guardAt = src.indexOf('.popup-close-btn, .popup-close-btn-mobile"');
    const stopAt = src.indexOf("e.stopPropagation()");
    expect(guardAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(guardAt);
  });
});
