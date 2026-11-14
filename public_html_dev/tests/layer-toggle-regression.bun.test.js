/**
 * layer-toggle-regression.bun.test.js — Static-analysis guard for the
 * "turn off clusters with heatmap on → no markers visible" bug.
 *
 * Bug: the mode-button click handler toggled activeModes freely without
 * ensuring at least one pin-display mode (markers or clusters) remains.
 * Toggling off clusters left activeModes = {"heatmap"}, which places
 * heatLayer on the map but removes markerLayer, pinCluster, and hides
 * the canvas — no individual pins visible at all.
 *
 * Fix: when toggling OFF a mode, auto-enable "markers" if no pin-display
 * mode remains active.
 *
 * This test prevents regressions by asserting structural invariants.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// Extract the MODE_BUTTONS click handler block
function sliceModeButtonClickHandler(src) {
  const marker = "for (const btn of MODE_BUTTONS)";
  const start = src.indexOf(marker);
  if (start < 0) return "";
  // Find the addEventListener("click" after the marker
  const clickIdx = src.indexOf('addEventListener("click"', start);
  if (clickIdx < 0) return "";
  // Find the matching closing brace for the handler function
  let depth = 0;
  let handlerStart = -1;
  for (let i = clickIdx; i < src.length; i++) {
    if (src[i] === "{" && handlerStart === -1) {
      handlerStart = i;
      depth = 1;
    } else if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(clickIdx, i + 1);
    }
  }
  return "";
}

const handler = sliceModeButtonClickHandler(appJs);

describe("layer toggle — no-marker-display regression guard", () => {
  test("MODE_BUTTONS click handler exists", () => {
    expect(handler.length).toBeGreaterThan(0);
  });

  test("handler auto-enables 'markers' when last pin-display mode is toggled off", () => {
    // After deleting the mode, the handler must check whether both
    // markers and clusters are absent and re-add markers.
    expect(handler).toMatch(/activeModes\.delete\(mode\)/);
    // Must check that neither markers nor clusters is active after delete
    expect(handler).toMatch(/!activeModes\.has\("markers"\)\s*&&\s*!activeModes\.has\("clusters"\)/);
    // And re-add markers as fallback
    expect(handler).toMatch(/activeModes\.add\("markers"\)/);
  });

  test("handler calls applyLayers() after every mode change", () => {
    expect(handler).toMatch(/applyLayers\(\)/);
  });

  test("applyLayers always adds markerLayer when markers is active", () => {
    // Find the applyLayers function
    const fnStart = appJs.indexOf("function applyLayers()");
    expect(fnStart).toBeGreaterThan(-1);
    let depth = 0;
    let fnEnd = -1;
    for (let i = fnStart; i < appJs.length; i++) {
      if (appJs[i] === "{" && depth === 0) depth = 1;
      else if (appJs[i] === "{") depth++;
      else if (appJs[i] === "}") {
        depth--;
        if (depth === 0) { fnEnd = i + 1; break; }
      }
    }
    const fnBody = appJs.slice(fnStart, fnEnd);
    // When markers is active, markerLayer must be added to the map
    expect(fnBody).toMatch(/activeModes\.has\("markers"\)[^}]*addLayer\(markerLayer\)/s);
  });

  test("applyLayers always adds pinCluster/eventCluster when clusters is active", () => {
    const fnStart = appJs.indexOf("function applyLayers()");
    let depth = 0;
    let fnEnd = -1;
    for (let i = fnStart; i < appJs.length; i++) {
      if (appJs[i] === "{" && depth === 0) depth = 1;
      else if (appJs[i] === "{") depth++;
      else if (appJs[i] === "}") {
        depth--;
        if (depth === 0) { fnEnd = i + 1; break; }
      }
    }
    const fnBody = appJs.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/activeModes\.has\("clusters"\)/);
    expect(fnBody).toMatch(/addLayer\(pinCluster\)/);
    expect(fnBody).toMatch(/addLayer\(eventCluster\)/);
  });
});
