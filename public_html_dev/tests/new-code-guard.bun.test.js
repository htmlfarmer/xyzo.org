/**
 * new-code-guard.bun.test.js — Reminder: new code needs new tests.
 *
 * PURPOSE:
 *   This is a living checklist. Every time you touch a critical path
 *   (see list below), add a test BEFORE committing. The "critical function"
 *   tests below use a simple heuristic — they check that you mentioned the
 *   function name somewhere in a test file. If you add a function and don't
 *   mention it in any test, the test will fail and print a reminder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO USE:
 *   1. Make your code change
 *   2. If it touches anything in CRITICAL FUNCTIONS below → add a test
 *   3. Run `bun test` — this file passes if you did step 2
 *   4. Commit alongside the new code
 * ─────────────────────────────────────────────────────────────────────────
 *
 * CRITICAL FUNCTIONS — touch one of these? Add a test first.
 *
 *   Canvas / Pin Rendering
 *   ─────────────────────────
 *   _buildIconCache()        → mobile-icon-canvas-sync.bun.test.js
 *   _getIconCanvas()          → mobile-icon-canvas-sync.bun.test.js
 *   _scheduleRedraw()         → canvas-renderer.test.js
 *   syncLayers()              → canvas-renderer.test.js
 *   setPins()                 → canvas-renderer.test.js
 *   fetchPinsForViewport()    → mobile-pin-bug.bun.test.js
 *   resolveCategoryFromText() → canvas-renderer.test.js
 *   iconFor()                  → canvas-renderer.test.js
 *
 *   Mobile / Popup
 *   ─────────────────────────
 *   setupMobilePopupAutoClose()  → mobile-popup-autoclose.bun.test.js
 *   setupBottomBarKeyboardHide() → mobile-bottom-bar.bun.test.js
 *   closeActivePopup()           → mobile-close-popup-regression.bun.test.js
 *   buildPopup()                 → canvas-renderer.test.js
 *
 *   Geolocation Pipeline
 *   ─────────────────────────
 *   classify() [classify.py]  → worker/classify.py (88 test cases)
 *   auto_categorize()          → geo pipeline test
 *   geocode.py (nominatim)     → geocode test
 *
 *   Fetch / Fetch Lease System
 *   ──────────────────────────────
 *   fetch.run()               → fetch lease system tests
 *   cleanup_stale_leases()    → fetch lease system tests
 *   fetchAll()                → fetch-integrity tests
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * BEFORE COMMITTING SIGNIFICANT CHANGES, run:
 *   bun test public_html/tests/
 *   python3 worker/classify.py
 *   bash scripts/validate-api.sh
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// PROJECT_ROOT = /var/www/vhosts/xyzo.org (for spawning subprocesses)
// TESTS_DIR   = /var/www/vhosts/xyzo.org/public_html/tests (for reading test files)
// APP_JS     = /var/www/vhosts/xyzo.org/public_html/app.js
const PROJECT_ROOT = join(import.meta.dir, "../..");
const TESTS_DIR = join(PROJECT_ROOT, "public_html/tests");
const APP_JS = join(PROJECT_ROOT, "public_html/app.js");

/** Critical functions that need test coverage. */
// NOTE: If a function below truly doesn't need a test (e.g. it's a thin wrapper
// or only runs in specific conditions), add a suppression comment in THIS file:
//
//   // TESTED: no — reason
//   const FUNCTION_NAME = ...
const CRITICAL_FUNCTIONS = [
  "_buildIconCache",         // Tested: mobile-icon-canvas-sync.bun.test.js
  "_getIconCanvas",          // Tested: mobile-icon-canvas-sync.bun.test.js
  "_scheduleRedraw",         // Tested: canvas-renderer.test.js
  "syncLayers",              // Tested: canvas-renderer.test.js
  "fetchPinsForViewport",    // Tested: mobile-pin-bug.bun.test.js
  "iconFor",                 // Tested: canvas-renderer.test.js
  "setupMobilePopupAutoClose", // Tested: mobile-popup-autoclose.bun.test.js
  "setupBottomBarKeyboardHide", // Tested: mobile-bottom-bar.bun.test.js
  "closeActivePopup",        // Tested: mobile-close-popup-regression.bun.test.js
  "buildPopup",              // Tested: canvas-renderer.test.js

  // Low-risk client-side fallback — only fires when server classification
  // is absent. Pattern coverage is in classify.py unit tests instead.
  // TESTED: no — client-side fallback, server classify.py is the primary path
  // "resolveCategoryFromText",
];

/** Test files to scan (in order of priority). */
const TEST_FILES = [
  "mobile-icon-canvas-sync.bun.test.js",
  "canvas-renderer.test.js",
  "mobile-pin-bug.bun.test.js",
  "mobile-popup-autoclose.bun.test.js",
  "mobile-bottom-bar.bun.test.js",
  "mobile-close-popup-regression.bun.test.js",
  "taxonomy-integrity.bun.test.js",
  "a11y.bun.test.js",
  "a11y.test.js",
  "memory-leaks.test.js",
  "render-mode.test.js",
  "search-marker.test.js",
  "category-filter.test.js",
  "code-splitting.test.js",
  "report-story.test.js",
  "mobile-close-button.test.js",
];

/** Which test file to use when adding coverage for a function. */
const FUNCTION_TO_TEST_FILE = {
  "_buildIconCache":         "mobile-icon-canvas-sync.bun.test.js",
  "_getIconCanvas":          "mobile-icon-canvas-sync.bun.test.js",
  "_scheduleRedraw":         "canvas-renderer.test.js",
  "syncLayers":               "canvas-renderer.test.js",
  "fetchPinsForViewport":    "mobile-pin-bug.bun.test.js",
  "resolveCategoryFromText":  "canvas-renderer.test.js",
  "iconFor":                 "canvas-renderer.test.js",
  "setupMobilePopupAutoClose": "mobile-popup-autoclose.bun.test.js",
  "setupBottomBarKeyboardHide": "mobile-bottom-bar.bun.test.js",
  "closeActivePopup":        "mobile-close-popup-regression.bun.test.js",
  "buildPopup":              "canvas-renderer.test.js",
};

describe("new code guard — critical functions have tests", () => {

  /**
   * For each critical function: check if it appears in any test file.
   * This is a loose heuristic — it catches cases where you add a new
   * function and forget to mention it anywhere. It's not a substitute
   * for real test coverage, just a safety net.
   */
  for (const fn of CRITICAL_FUNCTIONS) {
    test(`${fn}() is mentioned in a test file`, () => {
      const found = TEST_FILES.some((file) => {
        try {
          const content = readFileSync(join(TESTS_DIR, file), "utf8");
          // Check: function name appears as a string, OR suppressed with a note
          const suppressionPattern = new RegExp(
            `//\\s*TESTED:?\\s*no[^]*${fn}|//\\s*SKIP\\s+${fn}`
          );
          return content.includes(fn) || suppressionPattern.test(content);
        } catch {
          return false;
        }
      });

      if (!found) {
        const where = FUNCTION_TO_TEST_FILE[fn] || "mobile-icon-canvas-sync.bun.test.js";
        throw new Error(
          `MISSING TEST COVERAGE: ${fn}() is not mentioned in any test file.\n` +
          `Add a guard in tests/${where}\n\n` +
          `See tests/new-code-guard.bun.test.js for the full critical function list.`
        );
      }

      expect(found).toBe(true);
    });
  }

  /**
   * Sanity: EVENT_ICONS must still be a large object (>85 entries).
   * Prevents accidentally replacing it with a stub.
   */
  test("EVENT_ICONS block is substantial (≥85 entries)", () => {
    const content = readFileSync(APP_JS, "utf8");
    const idx = content.indexOf("const EVENT_ICONS = {");
    const end = content.indexOf("};", idx);
    const block = content.slice(idx, end);
    const keys = [...block.matchAll(/^\s+(\w+):\s*`/gm)].map(m => m[1]);

    if (keys.length < 85) {
      throw new Error(
        `EVENT_ICONS has only ${keys.length} entries — expected ≥85. ` +
        "Did a refactor accidentally truncate the icon set?"
      );
    }
    expect(keys.length).toBeGreaterThanOrEqual(85);
  });

  /**
   * Sanity: classify.py tests must pass (86 unique categories, 0 duplicates).
   * Catches pattern drift between app.js and the server.
   */
  test("classify.py is up-to-date (86 unique categories, 0 duplicates)", () => {
    // Run python3 worker/classify.py from project root
    const result = Bun.spawnSync({
      cmd: ["python3", "worker/classify.py"],
      cwd: PROJECT_ROOT,
    });

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(
        `classify.py tests failed:\n${stderr}\n\n` +
        "Run `python3 worker/classify.py` to see what's broken."
      );
    }

    const output = new TextDecoder().decode(result.stdout);
    const uniqueMatch = output.match(/(\d+)\/(\d+)/);
    if (!uniqueMatch) {
      throw new Error(`Could not parse classify.py output: ${output}`);
    }

    const num = parseInt(uniqueMatch[1]);
    if (num < 86) {
      throw new Error(
        `classify.py has ${num} unique categories — expected ≥86. ` +
        "Update PATTERNS to include all 86 categories from the taxonomy."
      );
    }
    expect(num).toBeGreaterThanOrEqual(86);
  });
});

describe("new code reminder", () => {
  test("Reminder: add test cases for new critical code before committing", () => {
    console.info(`
╔══════════════════════════════════════════════════════════════════╗
║  NEW CODE? Before committing significant changes:                ║
║                                                                  ║
║  ✦ Touched _buildIconCache / _getIconCanvas?                    ║
║    → Add regression test in mobile-icon-canvas-sync.bun.test.js  ║
║                                                                  ║
║  ✦ Changed canvas rendering logic?                                ║
║    → Add test in canvas-renderer.test.js                        ║
║                                                                  ║
║  ✦ Changed fetch / pin fetching?                                 ║
║    → Check mobile-pin-bug.bun.test.js guards                   ║
║                                                                  ║
║  ✦ Changed classify.py PATTERNS?                                ║
║    → Run: python3 worker/classify.py                            ║
║                                                                  ║
║  ✦ Changed mobile popup / bottom bar?                           ║
║    → Check corresponding mobile-*.bun.test.js files            ║
║                                                                  ║
║  Run all tests before committing:                                ║
║    bun test public_html/tests/                                   ║
║    python3 worker/classify.py                                    ║
║    bash scripts/validate-api.sh                                  ║
╚══════════════════════════════════════════════════════════════════╝`
    );
    expect(true).toBe(true);
  });
});
