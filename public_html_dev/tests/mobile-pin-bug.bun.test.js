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
 *   - The "Reload markers" UX button existing in #bottom-bar with the
 *     correct id, accessible name, and action hookup in app.js.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

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
  test("button exists in #bottom-bar with id=reload-pins-btn", () => {
    const barStart = indexHtml.indexOf('<div id="bottom-bar">');
    const barEnd = indexHtml.indexOf("</div><!-- /bottom-bar -->");
    expect(barStart).toBeGreaterThan(-1);
    expect(barEnd).toBeGreaterThan(barStart);
    const bar = indexHtml.slice(barStart, barEnd);
    const btnMatch = bar.match(/<button[^>]*\bid=["']reload-pins-btn["'][^>]*>/);
    expect(btnMatch).not.toBeNull();
  });

  test("button has an accessible name (aria-label)", () => {
    const btnMatch = indexHtml.match(/<button[^>]*\bid=["']reload-pins-btn["'][^>]*>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch[0]).toMatch(/aria-label=["']Reload markers["']/);
  });

  test("button has an icon (svg) for visual feedback", () => {
    const btnMatch = indexHtml.match(/<button[^>]*\bid=["']reload-pins-btn["'][^>]*>[\s\S]*?<\/button>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch[0]).toMatch(/<svg[^>]*class=["'][^"']*reload-pins-icon/);
  });

  test("app.js wires the click handler to call fetchPinsForViewport", () => {
    // The initReloadPinsButton IIFE must exist and call fetchPinsForViewport
    // (NOT the throttled reloadPins wrapper — the user asked for an
    // immediate fetch, so bypassing the throttle is correct).
    expect(appJs).toMatch(/initReloadPinsButton/);
    const iifeMatch = appJs.match(/initReloadPinsButton[\s\S]*?\}\)\(\);/);
    expect(iifeMatch).not.toBeNull();
    expect(iifeMatch[0]).toMatch(/fetchPinsForViewport\(\)/);
    // Should NOT wrap the call in throttle(); a manual reload should be
    // immediate so the user gets instant feedback.
    expect(iifeMatch[0]).not.toMatch(/throttle\(/);
  });

  test("spinning CSS animation exists for visual feedback", () => {
    expect(stylesCss).toMatch(/\.reload-pins-btn\.spinning[\s\S]{0,200}animation:/);
    expect(stylesCss).toMatch(/@keyframes reload-pins-spin/);
  });

  test("reduced-motion users skip the spin animation", () => {
    expect(stylesCss).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,300}\.reload-pins-btn\.spinning/);
  });

  test("button respects the WCAG 2.5.5 44×44 touch target on mobile", () => {
    // Extract EVERY @media (max-width: 720px) { ... } block (there are
    // several — the bottom-bar redesign lives in one that comes after
    // the existing rules). Concatenate them so we can assert across
    // all of them. Use a brace-counting scanner per block.
    const query = "@media (max-width: 720px)";
    const blocks = [];
    let from = 0;
    while (true) {
      const startIdx = stylesCss.indexOf(query, from);
      if (startIdx < 0) break;
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx + query.length; i < stylesCss.length; i++) {
        const c = stylesCss[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { endIdx = i + 1; break; }
        }
      }
      expect(endIdx).toBeGreaterThan(-1);
      blocks.push(stylesCss.slice(startIdx, endIdx));
      from = endIdx;
    }
    expect(blocks.length).toBeGreaterThan(0);
    const block = blocks.join("\n");
    // The reload-pins button gets its 44×44 floor either from an
    // explicit .reload-pins-btn rule inside the @media block, or by
    // inheriting from #bottom-bar > button (which already covers every
    // direct-child button of #bottom-bar).
    const hasExplicit = /\.reload-pins-btn[\s\S]*?min-height\s*:\s*44px/.test(block);
    const inheritsFromBottomBar =
      /#bottom-bar\s*>\s*button[\s\S]*?min-height\s*:\s*44px/.test(block);
    expect(hasExplicit || inheritsFromBottomBar).toBe(true);
  });
});
