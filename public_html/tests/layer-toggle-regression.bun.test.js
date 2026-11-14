/**
 * layer-toggle-regression.bun.test.js — Static-analysis guard for the
 * marker on/off toggle contract.
 *
 * History:
 *  - Old bug: clusters off + heatmap on → nothing rendered (heatmap had
 *    no pins to build from, and markerLayer/pinCluster were gone).
 *  - Old "fix": force-re-add "markers" whenever the last pin-display mode
 *    was toggled off. That made a clean basemap impossible — users could
 *    never turn all markers off.
 *  - Current contract: an empty mode set is a legitimate view. Turning
 *    everything off must clear pin data entirely, any pin-consuming mode
 *    (markers/clusters/heatmap) re-enabling must trigger a fetch, and
 *    heatmap-only sessions must fetch pins too (heat is built from pins).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// Extract the mode-button click handler block. The buttons moved from a
// flat #mode-buttons container into the #markers-dropdown-menu (commit
// 65f183b / the bottom-bar redesign) — the handler now iterates
// `menu.querySelectorAll("button[data-mode]")` inside wireMarkersDropdown().
// The selector string appears twice (refreshActiveStates + the wiring
// loop); the SECOND occurrence is the one with the click listener.
function sliceModeButtonClickHandler(src) {
  const marker = 'for (const item of menu.querySelectorAll("button[data-mode]"))';
  const first = src.indexOf(marker);
  if (first < 0) return "";
  const start = src.indexOf(marker, first + marker.length);
  if (start < 0) return "";
  const clickIdx = src.indexOf('addEventListener("click"', start);
  if (clickIdx < 0) return "";
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

function sliceFn(src, decl) {
  const fnStart = src.indexOf(decl);
  if (fnStart < 0) return "";
  let depth = 0;
  for (let i = fnStart; i < src.length; i++) {
    if (src[i] === "{" && depth === 0) depth = 1;
    else if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(fnStart, i + 1);
    }
  }
  return "";
}

const handler = sliceModeButtonClickHandler(appJs);

describe("layer toggle — marker on/off contract", () => {
  test("MODE_BUTTONS click handler exists", () => {
    expect(handler.length).toBeGreaterThan(0);
  });

  test("toggling off the last mode does NOT force markers back", () => {
    expect(handler).toMatch(/activeModes\.delete\(mode\)/);
    // The old guard re-added markers when activeModes became empty —
    // a clean basemap must be possible, so it must stay gone.
    expect(handler).not.toMatch(/activeModes\.size === 0[\s\S]{0,40}activeModes\.add\("markers"\)/);
  });

  test("handler calls applyLayers() after every mode change", () => {
    expect(handler).toMatch(/applyLayers\(\)/);
  });

  test("applyLayers adds markerLayer when markers is active", () => {
    const fnBody = sliceFn(appJs, "function applyLayers()");
    expect(fnBody).toMatch(/activeModes\.has\("markers"\)[^}]*addLayer\(markerLayer\)/s);
  });

  test("applyLayers adds pinCluster/eventCluster when clusters is active", () => {
    const fnBody = sliceFn(appJs, "function applyLayers()");
    expect(fnBody).toMatch(/activeModes\.has\("clusters"\)/);
    expect(fnBody).toMatch(/addLayer\(pinCluster\)/);
    expect(fnBody).toMatch(/addLayer\(eventCluster\)/);
  });

  test("applyLayers clears pin data when every display mode is off", () => {
    const fnBody = sliceFn(appJs, "function applyLayers()");
    expect(fnBody).toMatch(/!activeModes\.has\("markers"\)[\s\S]*?!activeModes\.has\("clusters"\)[\s\S]*?!activeModes\.has\("heatmap"\)/);
    expect(fnBody).toMatch(/canvasRenderer\.setPins\(\[\]\)/);
    expect(fnBody).toMatch(/clearAllMarkers\(\)/);
  });

  test("applyLayers refetches when ANY pin-consuming mode is on", () => {
    const fnBody = sliceFn(appJs, "function applyLayers()");
    expect(fnBody).toMatch(/activeModes\.has\("heatmap"\)[\s\S]{0,220}fetchPinsForViewport/);
  });

  test("fetchPinsForViewport skips the network while all modes are off", () => {
    const fnBody = sliceFn(appJs, "async function fetchPinsForViewport()");
    expect(fnBody).toMatch(/!activeModes\.has\("markers"\)[\s\S]{0,160}!activeModes\.has\("clusters"\)[\s\S]{0,160}!activeModes\.has\("heatmap"\)/);
  });

  test("markers-and-clusters remain mutually exclusive", () => {
    expect(handler).toMatch(/if \(mode === "markers"\) activeModes\.delete\("clusters"\)/);
    expect(handler).toMatch(/if \(mode === "clusters"\) activeModes\.delete\("markers"\)/);
  });
});
