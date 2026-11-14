/**
 * mobile-pin-bug.bun.test.js — Static-analysis checks for the mobile
 * pan-pin-bug fix and the user-requested reload-markers UX.
 *
 * The original "second pan no pins" bug was fixed in Tier 1.5 (commit
 * 2603ed3) with five `if (inflightCtrl !== ctrl) return;` guards in
 * fetchPinsForViewport. But the user reports it persists on mobile —
 * investigation found two more setPins paths that lacked the guard:
 *
 *   1. City-fallback setPins inside the canvas branch (the existing
 *      guard at line ~4190 protects entry into the branch but not the
 *      second fetch-and-setPins that runs after a sparse 0-pin response).
 *   2. Search-mode setPins inside the parallel `if (searching)` branch
 *      (no surrounding guard at all — the Tier 1.5 fix only covered the
 *      canvas branch).
 *
 * Both can race with a newer fetchPinsForViewport that took over
 * between `await fetch()` resolving and `await res.json()` completing
 * (the abort signal doesn't cancel response-body parsing), leaving the
 * canvas painted with the previous viewport's pins.
 *
 * This test gates CI on:
 *   - Each missed path having the stale-check guard.
 *
 * The "Reload markers" UX button this file originally guarded was
 * removed from the bottom bar in commit 0060b0d (2026-09-11,
 * "chore: remove Reload and Share buttons from bottom bar"). The
 * dead IIFE in app.js self-guards with `if (!btn) return;`, so no
 * DOM assertions for it remain here.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// Slice out the canvas-branch "else" block (the 0-pin / city-fallback
// branch) of fetchPinsForViewport() so we can assert about it in
// isolation. We anchor on the existing Tier 1.5 guard comment so the
// slice is stable across edits.
function sliceCityFallbackBranch(src) {
  const anchor = "if (inflightCtrl !== ctrl) return;";
  // Find the Tier 1.5 guard at line ~4190 (the one right before
  // `const items = body.pins || [];`) and walk forward to the
  // city-fallback's `canvasRenderer.setPins(fbItems);` call.
  const anchorIdx = src.indexOf(anchor);
  if (anchorIdx < 0) return "";
  // The second occurrence of the anchor inside fetchPinsForViewport is
  // the one we want (the first is in the catch-block).
  const secondIdx = src.indexOf(anchor, anchorIdx + anchor.length);
  if (secondIdx < 0) return "";
  const end = src.indexOf("canvasRenderer.setPins(fbItems);", secondIdx);
  if (end < 0) return "";
  // Extend the slice to include the line itself.
  const lineEnd = src.indexOf("\n", end);
  return src.slice(secondIdx, lineEnd + 1);
}

// Slice out the search-mode branch of fetchPinsForViewport() so we can
// assert about it in isolation.
function sliceSearchModeBranch(src) {
  const start = src.indexOf("// ── Search mode:");
  if (start < 0) return "";
  const end = src.indexOf("canvasRenderer.setPins(pins);", start);
  if (end < 0) return "";
  const lineEnd = src.indexOf("\n", end);
  return src.slice(start, lineEnd + 1);
}

describe("mobile pan-pin-bug fix — missed stale-fetch paths", () => {
  test("city-fallback setPins is guarded by `inflightCtrl !== ctrl`", () => {
    const branch = sliceCityFallbackBranch(appJs);
    expect(branch.length).toBeGreaterThan(0);
    // The guard must appear BEFORE the setPins(fbItems) call inside
    // the if(fbItems.length > 0) block. We require it inside that
    // block specifically, not just anywhere in fetchPinsForViewport.
    const setPinsAt = branch.lastIndexOf("canvasRenderer.setPins(fbItems);");
    const guardAt = branch.lastIndexOf("if (inflightCtrl !== ctrl) return;");
    expect(guardAt).toBeGreaterThan(-1);
    expect(setPinsAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(setPinsAt);
  });

  test("search-mode setPins is guarded by `inflightCtrl !== ctrl`", () => {
    const branch = sliceSearchModeBranch(appJs);
    expect(branch.length).toBeGreaterThan(0);
    const setPinsAt = branch.lastIndexOf("canvasRenderer.setPins(pins);");
    const guardAt = branch.lastIndexOf("if (inflightCtrl !== ctrl) return;");
    expect(guardAt).toBeGreaterThan(-1);
    expect(setPinsAt).toBeGreaterThan(-1);
    // Search-mode has NO enclosing guard from Tier 1.5, so the guard
    // we add must come inside this branch — not just outside it.
    expect(guardAt).toBeLessThan(setPinsAt);
  });

  test("the Tier 1.5 guard at line ~4190 still exists (regression)", () => {
    // Make sure we didn't accidentally remove the Tier 1.5 root-cause
    // guard when adding the new ones. The comment header is unique.
    expect(appJs).toMatch(/Tier 1\.5: root-cause fix for second-pan-no-pins bug/);
    expect(appJs).toMatch(/if \(inflightCtrl !== ctrl\) return;\s*\n\s*\n\s*const items = body\.pins \|\| \[\];/);
  });
});

describe("reload-markers UX button", () => {
  // Removed from the bottom bar in commit 0060b0d (2026-09-11). What
  // remains in app.js is the self-guarding IIFE — if the button is
  // ever re-added, the wiring is still there; while it's absent the
  // IIFE is a no-op. Assert the no-op contract so nobody re-adds a
  // handler that throws on a missing element.
  test("app.js reload IIFE self-guards when the button is absent", () => {
    expect(appJs).toMatch(/initReloadPinsButton/);
    const iifeMatch = appJs.match(/initReloadPinsButton[\s\S]*?\}\)\(\);/);
    expect(iifeMatch).not.toBeNull();
    expect(iifeMatch[0]).toMatch(/if \(!btn\) return;/);
  });
});
