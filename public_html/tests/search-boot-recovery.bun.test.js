/**
 * search-boot-recovery.bun.test.js — a shared search link must work.
 *
 * Bug (2026-10-27): opening "https://xyzo.org/?q=cybersecurity" showed
 * a map with no results and a status stuck on
 * `Searching "cybersecurity"…`. Three separate defects stacked up:
 *
 *   1. `map.isStyleLoaded()` DOES NOT EXIST in Leaflet (zero hits in
 *      vendor/leaflet/leaflet.js). The guard
 *      `if (map && map.isStyleLoaded())` threw a TypeError, and the
 *      `catch (e) {}` around it swallowed the error — so the boot
 *      search silently never ran.
 *
 *   2. `runSearch()` guards on `searchActive` but only SETS it at the
 *      very end of the function. A caller that did not come from a
 *      keystroke — the `?q=` boot path and the `#search=` hash path
 *      both set `searchInput.value` programmatically, which fires no
 *      `input` event — therefore bailed at the guard AFTER the fetches:
 *      no pins rendered, and the status never updated.
 *
 *   3. The boot path called `runSearch()` synchronously, while
 *      `debouncedTextSearch` (a `const` declared ~150 lines later) was
 *      still in its temporal dead zone → "Cannot access
 *      'debouncedTextSearch' before initialization".
 *
 * The shared "#…/pin=123" link had the same disease: `map.once("load",
 * …)` silently does nothing when the load event has already fired.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const leafletJs = readFileSync(join(ROOT, "vendor", "leaflet", "leaflet.js"), "utf8");

// ── slice helpers ──────────────────────────────────────────────────────

/** The body of `function name(...) { … }`, braces balanced. */
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

/** The source with its comments removed — for "is this called?" checks. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/[^\n]*/g, "");
}

function sliceAround(src, marker, before = 300, after = 1800) {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  return src.slice(Math.max(0, i - before), i + after);
}

// ── the API that does not exist ────────────────────────────────────────
describe("search boot — Leaflet has no isStyleLoaded()", () => {
  test("the bundled Leaflet really does not have it", () => {
    // If this ever starts passing, the guard that threw is harmless
    // again and the workaround can be simplified.
    expect(leafletJs).not.toMatch(/isStyleLoaded/);
  });

  test("app.js never calls it", () => {
    const calls = stripComments(appJs).match(/\.isStyleLoaded\s*\(/g) || [];
    expect(calls).toEqual([]);
  });

  test("the map-ready helper uses Leaflet's own whenReady()", () => {
    // whenReady() runs the callback now (on the next tick) if the map
    // is already loaded, and otherwise when it loads. `map.once("load",
    // fn)` does neither: it does nothing when the event has already
    // fired.
    const src = sliceFunction(appJs, "whenMapReady");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/map\.whenReady\(/);
    expect(src).not.toMatch(/once\("load"/);
  });
});

// ── the search itself ──────────────────────────────────────────────────
describe("search boot — runSearch marks itself active", () => {
  test("searchActive is set BEFORE the fetches, not at the end", () => {
    // The guard `if (ctrl.signal.aborted || !searchActive || …) return;`
    // bails AFTER the fetches. Setting the flag after it meant every
    // non-keystroke caller bailed with the status stuck on
    // "Searching …" and nothing rendered.
    const src = sliceFunction(appJs, "runSearch");
    expect(src.length).toBeGreaterThan(0);
    const setAt = src.indexOf("searchActive = true;");
    const guardAt = src.indexOf("!searchActive || _searchAbortCtrl");
    expect(setAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(guardAt);
  });

  test("the boot path defers the call out of the temporal dead zone", () => {
    // runSearch() reads `debouncedTextSearch`, a `const` declared
    // further down the file.
    const src = sliceAround(appJs, "function initSearchFromUrl", 200, 2200);
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/setTimeout\(run, 0\)/);
  });

  test("the boot path's catch does not swallow the error silently", () => {
    const src = sliceAround(appJs, "function initSearchFromUrl", 200, 2600);
    expect(src).toMatch(/XLog\.warn\("initSearchFromUrl"/);
    expect(src).not.toMatch(/\}\s*catch\s*\(e\)\s*\{\s*\}/);
  });
});

// ── the shared pin link ────────────────────────────────────────────────
describe("search boot — a shared #…/pin=123 link opens its popup", () => {
  test("the marker is looked up by number AND by string", () => {
    // Both maps are keyed by the numeric id, but the id arrives from a
    // URL hash as a string. `eventMarkers.get(String(id))` never
    // matched, so a link to an EVENT marker could not open at all.
    const src = sliceFunction(appJs, "findMarkerById");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/pinMarkers\.get\(n\)/);
    expect(src).toMatch(/eventMarkers\.get\(n\)/);
    expect(src).toMatch(/Number\(pinId\)/);
  });

  test("the popup is retried while the search is still loading", () => {
    // The search takes a few seconds; one 500 ms retry was not enough.
    const src = sliceFunction(appJs, "openPinPopup");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/PENDING_POPUP_MAX_ATTEMPTS/);
    expect(src).toMatch(/findMarkerById\(/);
  });

  test("the hash restore uses the map-ready helper", () => {
    const src = sliceAround(appJs, "If hash contains a pin, open that popup", 200, 1200);
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/whenMapReady\(openPin\)/);
  });
});
