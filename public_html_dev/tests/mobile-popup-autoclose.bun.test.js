/**
 * mobile-popup-autoclose.bun.test.js — Static-analysis checks for the
 * mobile popup auto-close-on-pan fix.
 *
 * Bug: on phones, the popup is anchored to its pin and Leaflet's
 * autoPan tries to keep it on-screen while the user pans. The close
 * (×) button often falls off-screen after a pan, leaving the user
 * stuck with no easy way to dismiss it.
 *
 * Fix: on mobile viewports, any user-initiated map movement (touch
 * drag, mouse drag, or wheel zoom) closes the open popup. The fix
 * must NOT close on programmatic flyTo()/setView() (search results,
 * "Fly to" buttons, explore-region jumps) and must NOT close when
 * the user is scrolling/tapping inside the popup itself.
 *
 * Guards CI on the structural invariants so a future refactor that
 * accidentally re-opens the popup immediately after the auto-close,
 * or that closes the popup on programmatic flyTo, would fail here.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// ── Slice helpers ─────────────────────────────────────────────────────
// We need to inspect the body of `setupMobilePopupAutoClose` in
// isolation so our assertions aren't polluted by the global `map.on`
// listeners from other systems (search, flag-quality, map-debug, …).

function sliceSetupMobilePopupAutoClose(src) {
  const start = src.indexOf("function setupMobilePopupAutoClose");
  if (start < 0) return "";
  // Find the matching closing brace for the function body.
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return "";
  return src.slice(start, end);
}

// Slice the popupclose handler so we can assert it honors the
// suppress flag (not just that the flag exists somewhere).
function slicePopupCloseHandler(src) {
  const start = src.indexOf('map.on("popupclose"');
  if (start < 0) return "";
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return "";
  return src.slice(start, end);
}

// Slice the movestart handler that lives inside the auto-close setup
// function. We anchor on the literal `map.on("movestart"` substring
// AFTER the setup function so we only match the auto-close instance
// (which is the one that calls closePopup).
function sliceAutoCloseMovestartHandler(src) {
  const setup = sliceSetupMobilePopupAutoClose(src);
  const start = setup.indexOf('map.on("movestart"');
  if (start < 0) return "";
  let depth = 0;
  let end = -1;
  for (let i = start; i < setup.length; i++) {
    const c = setup[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return "";
  return setup.slice(start, end);
}

describe("mobile popup auto-close — setup wiring", () => {
  test("setupMobilePopupAutoClose is defined and called once", () => {
    expect(appJs).toMatch(/function\s+setupMobilePopupAutoClose\s*\(/);
    // Must be invoked exactly once at module top-level.
    const calls = appJs.match(/setupMobilePopupAutoClose\(\s*\)\s*;/g) || [];
    expect(calls.length).toBe(1);
  });

  test("mobile detection uses matchMedia + a touch+width fallback", () => {
    const setup = sliceSetupMobilePopupAutoClose(appJs);
    expect(setup.length).toBeGreaterThan(0);
    expect(setup).toMatch(/matchMedia\(\s*["']\(max-width:\s*768px\)["']\)/);
    expect(setup).toMatch(/ontouchstart/);
  });

  test("setup function early-returns on non-mobile viewports", () => {
    const setup = sliceSetupMobilePopupAutoClose(appJs);
    expect(setup.length).toBeGreaterThan(0);
    // The isMobile const must gate handler registration.
    expect(setup).toMatch(/if\s*\(\s*!isMobile\s*\)\s*return\s*;/);
  });
});

describe("mobile popup auto-close — movestart handler", () => {
  test("only fires on user-initiated events (touchstart/mousedown/wheel)", () => {
    const handler = sliceAutoCloseMovestartHandler(appJs);
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/closePopup/);
    expect(handler).toMatch(/originalEvent/);
    expect(handler).toMatch(/touchstart/);
    expect(handler).toMatch(/mousedown/);
    expect(handler).toMatch(/wheel/);
  });

  test("programmatic flyTo/setView pass through (no originalEvent → return)", () => {
    const handler = sliceAutoCloseMovestartHandler(appJs);
    expect(handler.length).toBeGreaterThan(0);
    // Must early-return when originalEvent is missing — that's how
    // Leaflet signals a programmatic move.
    expect(handler).toMatch(/if\s*\(\s*!\s*original\s*\)\s*return\s*;/);
  });

  test("non-user originalEvent types are ignored (e.g. focus, scroll)", () => {
    const handler = sliceAutoCloseMovestartHandler(appJs);
    expect(handler.length).toBeGreaterThan(0);
    // The allowed-types check must use strict inequality on all three
    // types so unknown event types (focus, visibilitychange, …) fall
    // through without closing.
    expect(handler).toMatch(/!==\s*["']touchstart["']\s*&&\s*[^&]+\s*!==\s*["']mousedown["']\s*&&\s*[^&]+\s*!==\s*["']wheel["']/);
  });
});

describe("mobile popup auto-close — touchstart guard", () => {
  test("popupopen handler attaches touchstart/touchend listeners to popup element", () => {
    const setup = sliceSetupMobilePopupAutoClose(appJs);
    expect(setup.length).toBeGreaterThan(0);
    // We must register via the popupopen event so each new popup gets
    // a fresh binding (popups are reused/swapped across pin clicks).
    expect(setup).toMatch(/map\.on\(\s*["']popupopen["']/);
    expect(setup).toMatch(/getElement\(\s*\)/);
    expect(setup).toMatch(/addEventListener\(\s*["']touchstart["']/);
    expect(setup).toMatch(/addEventListener\(\s*["']touchend["']/);
  });

  test("movestart handler respects the popupInteracting flag", () => {
    const handler = sliceAutoCloseMovestartHandler(appJs);
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/if\s*\(\s*popupInteracting\s*\)\s*return\s*;/);
  });
});

describe("mobile popup auto-close — auto-restore suppression", () => {
  test("a module-level suppress flag is declared", () => {
    // Must be at module scope (declared with `let`/`var`) so the
    // popupclose handler can read it synchronously when it fires.
    expect(appJs).toMatch(/^let\s+_mobilePanSuppressRestore\s*=\s*false\s*;/m);
  });

  test("the movestart handler flips the suppress flag before closing", () => {
    const handler = sliceAutoCloseMovestartHandler(appJs);
    expect(handler.length).toBeGreaterThan(0);
    // Flag must be set BEFORE closePopup so the popupclose handler
    // sees it when it fires synchronously.
    const flagAt = handler.indexOf("_mobilePanSuppressRestore = true");
    const closeAt = handler.indexOf("closePopup");
    expect(flagAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(closeAt);
  });

  test("the popupclose handler honors the suppress flag (no auto-restore)", () => {
    const popupclose = slicePopupCloseHandler(appJs);
    expect(popupclose.length).toBeGreaterThan(0);
    // Must be in the same condition as _isUserExplicitClose and
    // _inSyncLayers — otherwise the restore path will still run.
    expect(popupclose).toMatch(
      /_isUserExplicitClose\s*\|\|\s*_inSyncLayers\s*\|\|\s*_mobilePanSuppressRestore/
    );
    // The flag must gate the "Do NOT schedule auto-restore" branch.
    expect(popupclose).toMatch(
      /if\s*\([^)]*_mobilePanSuppressRestore[^)]*\)\s*\{[\s\S]*?Do NOT schedule auto-restore/
    );
  });
});
