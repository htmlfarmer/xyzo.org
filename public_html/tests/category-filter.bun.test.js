/**
 * category-filter.bun.test.js — Regression tests for Category Filter Lifecycle,
 * Persistent Storage Purge, and Active Filter Indicator UX.
 *
 * Prevents the regression where:
 * 1. Category filters were silently stored in localStorage across page reloads.
 * 2. Hard refreshes (Ctrl+Shift+R) failed to restore map pins because localStorage
 *    persisted ["environment"], filtering thousands of pins down to 2 without
 *    any visual indicator.
 * 3. Legend button had broken selector (#legend-toggle vs #legend-btn).
 * 4. Diagnostics failed to surface active category filters.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("category filter — storage safety & no stale persist", () => {
  test("app.js purges stale xyzo-category-filters from localStorage on boot", () => {
    expect(appJs).toContain("function loadCategoryFilters()");
    expect(appJs).toContain("localStorage.removeItem(CATEGORY_FILTER_KEY)");
  });

  test("toggleCategoryFilter does NOT persist category filters into localStorage", () => {
    // Find toggleCategoryFilter function body
    const startIdx = appJs.indexOf("function toggleCategoryFilter(");
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = appJs.indexOf("function checkCategoryInViewport(", startIdx);
    const body = appJs.slice(startIdx, endIdx);

    // Must NOT write to localStorage
    expect(body).not.toContain("localStorage.setItem(CATEGORY_FILTER_KEY");
  });

  test("clearCategoryFilters cleans both localStorage and sessionStorage", () => {
    const startIdx = appJs.indexOf("function clearCategoryFilters()");
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = appJs.indexOf("window.clearCategoryFilters", startIdx);
    const body = appJs.slice(startIdx, endIdx);

    expect(body).toContain("localStorage.removeItem(CATEGORY_FILTER_KEY)");
    expect(body).toContain("sessionStorage.removeItem(CATEGORY_FILTER_KEY)");
    expect(body).toContain("_activeCategoryFilters.clear()");
    expect(body).toContain("updateActiveFilterIndicator()");
  });
});

describe("category filter — UI indicator & legend feedback", () => {
  test("index.html contains #active-filter-indicator with clear button", () => {
    expect(indexHtml).toContain('id="active-filter-indicator"');
    expect(indexHtml).toContain('id="active-filter-text"');
    expect(indexHtml).toContain('id="active-filter-clear-btn"');
    expect(indexHtml).toContain("clearCategoryFilters()");
  });

  test("styles.css defines styling for .active-filter-pill", () => {
    expect(stylesCss).toContain(".active-filter-pill {");
    expect(stylesCss).toContain(".active-filter-pill button");
    expect(stylesCss).toContain(".legend-btn.has-filter");
  });

  test("renderLegend applies .has-filter class to #legend-btn", () => {
    const startIdx = appJs.indexOf("function renderLegend()");
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = appJs.indexOf("function buildLegendRows()", startIdx);
    const body = appJs.slice(startIdx, endIdx);

    expect(body).toContain('document.getElementById("legend-btn")');
    expect(body).toContain('btn.classList.toggle("has-filter"');
  });

  test("canvasRenderer._draw updates _lastDrawnCount and calls updateActiveFilterIndicator", () => {
    expect(appJs).toContain("this._lastDrawnCount = drawnCount;");
    expect(appJs).toContain("updateActiveFilterIndicator();");
  });
});

describe("category filter — diagnostics visibility", () => {
  test("window.__xyzoMarkerDiagnostics exports activeCategoryFilters and canvasRenderedPinCount", () => {
    const startIdx = appJs.indexOf("window.__xyzoMarkerDiagnostics = function()");
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = appJs.indexOf("XLog.log(\"[XYZO Marker Diagnostics]\"", startIdx);
    const body = appJs.slice(startIdx, endIdx);

    expect(body).toContain("activeCategoryFilters:");
    expect(body).toContain("canvasRenderedPinCount:");
  });
});
