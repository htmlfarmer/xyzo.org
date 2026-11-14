/**
 * mobile-close-popup-regression.bun.test.js — Static-analysis regression
 * guard for the mobile popup close button.
 *
 * Bug: tapping "Close" on mobile called map.closePopup() directly
 * without setting _isUserExplicitClose, so the popupclose handler
 * auto-restored the popup 50 ms later (the user couldn't dismiss it).
 *
 * Fix: the mobile close button handler now calls window.closeActivePopup()
 * which sets the flag, clears state, and closes the popup.
 *
 * This test ensures no future refactor re-introduces the bug.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// Extract the wirePopupActions function body
function sliceWirePopupActions(src) {
  const start = src.indexOf("function wirePopupActions");
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

// Extract the mobile close button click handler block
function sliceMobileCloseHandler(wireSrc) {
  const marker = 'popup-close-btn-mobile';
  const markerIdx = wireSrc.indexOf(marker);
  if (markerIdx < 0) return "";
  // Find the addEventListener("click" after the marker
  const clickIdx = wireSrc.indexOf('addEventListener("click"', markerIdx);
  if (clickIdx < 0) return "";
  // Find the matching closing of the handler
  let depth = 0;
  let start = -1;
  for (let i = clickIdx; i < wireSrc.length; i++) {
    if (wireSrc[i] === "{" && start === -1) {
      start = i;
      depth = 1;
    } else if (wireSrc[i] === "{") depth++;
    else if (wireSrc[i] === "}") {
      depth--;
      if (depth === 0) return wireSrc.slice(start, i + 1);
    }
  }
  return "";
}

const wireSrc = sliceWirePopupActions(appJs);
const handler = sliceMobileCloseHandler(wireSrc);

describe("mobile close button — popup-close regression guard", () => {
  test("mobile close button handler calls window.closeActivePopup()", () => {
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toMatch(/closeActivePopup/);
  });

  test("mobile close button handler does NOT call map.closePopup() directly", () => {
    // Calling map.closePopup() without _isUserExplicitClose being set
    // would trigger auto-restore in the popupclose handler.
    expect(handler).not.toMatch(/map\.closePopup/);
  });

  test("mobile close button handler does NOT use stopPropagation", () => {
    // stopPropagation prevented the capture-phase close listener from
    // ever seeing the click. Removing it keeps the event pipeline clean.
    expect(handler).not.toMatch(/stopPropagation/);
  });

  test("_isUserExplicitClose is set before closePopup in closeActivePopup", () => {
    // Verify closeActivePopup sets the flag
    const closeActive = appJs.substring(
      appJs.indexOf("window.closeActivePopup"),
      appJs.indexOf("};", appJs.indexOf("window.closeActivePopup"))
    );
    expect(closeActive).toMatch(/_isUserExplicitClose\s*=\s*true/);
  });
});
