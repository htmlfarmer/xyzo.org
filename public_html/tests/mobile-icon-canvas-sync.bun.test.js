/**
 * mobile-icon-canvas-sync.bun.test.js — Guards for the mobile icon rendering
 * bug where pins show blue circles instead of colored category icons.
 *
 * THE BUG:
 *   _buildIconCache() pre-renders canvas icon variants inside img.onload
 *   callbacks. Mobile browsers often fire the first map draw call BEFORE the
 *   async onload fires. This causes _getIconCanvas() to miss the
 *   _iconCanvasCache and fall through to the plain colored-circle fallback.
 *
 *   On desktop this is usually fine (onload fires fast enough). On mobile
 *   with slow CPUs and async image decoding, the race is much more likely.
 *
 * THE FIX (required):
 *   Before drawing, _getIconCanvas() must check img.complete &&
 *   img.naturalWidth > 0 on the source image. If already loaded, it
 *   should build the canvas variant synchronously rather than falling
 *   through to the circle fallback.
 *
 *   Additionally, _getIconCanvas() should call a _buildCanvasVariant()
 *   helper (or inline equivalent) that mirrors the onload canvas-build
 *   logic but executes immediately when img.complete is true.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// ── Slice helpers ───────────────────────────────────────────────────────────

function sliceGetIconCanvas(src) {
  const start = src.indexOf("function _getIconCanvas(cat, size)");
  if (start < 0) return "";
  let depth = 0, startBrace = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      if (startBrace < 0) startBrace = i;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0 && startBrace >= 0) return src.slice(start, i + 1);
    }
  }
  return "";
}

function sliceBuildIconCache(src) {
  const start = src.indexOf("function _buildIconCache()");
  if (start < 0) return "";
  let depth = 0, startBrace = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      if (startBrace < 0) startBrace = i;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0 && startBrace >= 0) return src.slice(start, i + 1);
    }
  }
  return "";
}

// ── THE FIX ────────────────────────────────────────────────────────────────
//
// The synchronous build path must exist in _getIconCanvas. The pattern is:
//
//   const img = _iconImageCache.get(cat);
//   if (img && img.complete && img.naturalWidth > 0) {
//     // Build canvas variant synchronously — avoids blue-circle race
//     return _buildCanvasVariant(img, size, color);
//   }
//
// If this test fails, the mobile icon bug will re-appear on slow mobile CPUs.

describe("FIX: _getIconCanvas has synchronous icon-canvas builder", () => {
  test("checks img.complete && img.naturalWidth > 0 before the circle fallback", () => {
    const fn = sliceGetIconCanvas(appJs);
    expect(fn.length).toBeGreaterThan(0);

    // This is THE critical guard. Without it, the mobile icon race fires
    // every time on slow mobile hardware.
    const hasCompleteCheck = /img\.complete\s*&&\s*img\.naturalWidth\s*>\s*0/.test(fn) ||
                            /img\.naturalWidth\s*>\s*0\s*&&\s*img\.complete/.test(fn);
    expect(hasCompleteCheck).toBe(true);
    if (!hasCompleteCheck) {
      throw new Error(
        "MISSING FIX: _getIconCanvas() must check img.complete && " +
        "img.naturalWidth > 0 to avoid the mobile blue-circle race. " +
        "See mobile-icon-canvas-sync.bun.test.js for details."
      );
    }
  });

  test("builds canvas variant synchronously when img is already complete", () => {
    const fn = sliceGetIconCanvas(appJs);
    expect(fn.length).toBeGreaterThan(0);

    // After the complete check, must build the canvas variant (not just return)
    // The synchronous path must mirror the onload canvas-build logic:
    //   - create canvas at size * 2 * dpr
    //   - draw colored circle
    //   - draw image centered
    //   - cache it
    const hasSyncBuild =
      /drawImage\(img|oc\.getContext\("2d"\)|octx\.arc\(.*size.*0\.92/.test(fn);
    expect(hasSyncBuild).toBe(true);
    if (!hasSyncBuild) {
      throw new Error(
        "MISSING FIX: _getIconCanvas() must build the canvas variant " +
        "synchronously when img.complete is true. Without this, mobile " +
        "browsers show blue circles instead of colored category icons."
      );
    }
  });

  test("circle fallback is only reached when image not yet loaded", () => {
    const fn = sliceGetIconCanvas(appJs);
    expect(fn.length).toBeGreaterThan(0);

    const fallbackIdx = fn.indexOf("octx.arc(size, size, size * 0.92");
    const completeIdx = fn.search(/img\.complete\s*&&\s*img\.naturalWidth/);

    expect(fallbackIdx).toBeGreaterThan(-1);
    // The img.complete guard must come BEFORE the fallback arc-draw
    if (completeIdx >= 0) {
      expect(completeIdx).toBeLessThan(fallbackIdx);
    }
  });
});

describe("FIX: _buildIconCache preloads images and builds canvas variants", () => {
  test("iterates over sizes array to build each canvas size variant", () => {
    const fn = sliceBuildIconCache(appJs);
    expect(fn.length).toBeGreaterThan(0);

    const hasSizesLoop =
      /for\s*\(\s*const\s+size\s+of\s+sizes\s*\)/.test(fn) ||
      /sizes\.forEach/.test(fn);
    expect(hasSizesLoop).toBe(true);
  });

  test("stores each canvas variant in _iconCanvasCache", () => {
    const fn = sliceBuildIconCache(appJs);
    expect(fn.length).toBeGreaterThan(0);
    expect(/_iconCanvasCache\.set\(/.test(fn)).toBe(true);
  });

  test("marks icon as ready via _iconReady.add(cat)", () => {
    const fn = sliceBuildIconCache(appJs);
    expect(fn.length).toBeGreaterThan(0);
    expect(/_iconReady\.add\(cat\)/.test(fn)).toBe(true);
  });

  test("schedules redraw when all icons are loaded", () => {
    const fn = sliceBuildIconCache(appJs);
    expect(fn.length).toBeGreaterThan(0);
    expect(/_scheduleRedraw|canvasRenderer\._scheduleRedraw/.test(fn)).toBe(true);
  });
});

describe("DPR-aware canvas sizing for mobile Retina screens", () => {
  test("_getIconCanvas applies devicePixelRatio to canvas width/height", () => {
    const fn = sliceGetIconCanvas(appJs);
    expect(fn.length).toBeGreaterThan(0);

    // DPR scaling is essential for sharp icons on mobile Retina displays
    expect(/devicePixelRatio|dpr/.test(fn)).toBe(true);
    expect(/\boc\.width\b|\boc\.height\b/.test(fn)).toBe(true);
  });

  test("_buildIconCache applies devicePixelRatio in onload canvas build", () => {
    const fn = sliceBuildIconCache(appJs);
    expect(fn.length).toBeGreaterThan(0);
    expect(/devicePixelRatio|dpr/.test(fn)).toBe(true);
  });
});

describe("all 86 classify.py categories covered in app.js", () => {
  test("EVENT_ICONS has ≥86 keys matching classify.py PATTERNS", () => {
    const start = appJs.indexOf("const EVENT_ICONS = {");
    const end = appJs.indexOf("\n};", start);
    const block = appJs.slice(start, end);
    const keys = [...block.matchAll(/^\s+(\w+):\s*`/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(86);
  });

  test("EVENT_COLORS has ≥86 keys matching classify.py PATTERNS", () => {
    const start = appJs.indexOf("const EVENT_COLORS = {");
    const end = appJs.indexOf("\n};", start);
    const block = appJs.slice(start, end);
    const keys = [...block.matchAll(/^\s+(\w+):\s*"/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(86);
  });

  test("CANVAS_CAT_COLORS has ≥86 keys matching classify.py PATTERNS", () => {
    const start = appJs.indexOf("const CANVAS_CAT_COLORS = {");
    const end = appJs.indexOf("\n};", start);
    const block = appJs.slice(start, end);
    const keys = [...block.matchAll(/^\s+(\w+):\s*"/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(86);
  });

  test("every EVENT_ICONS key has a matching EVENT_COLORS entry", () => {
    const iconStart = appJs.indexOf("const EVENT_ICONS = {");
    const iconEnd = appJs.indexOf("\n};", iconStart);
    const iconBlock = appJs.slice(iconStart, iconEnd);
    const iconKeys = new Set([...iconBlock.matchAll(/^\s+(\w+):\s*`/gm)].map(m => m[1]));

    const colorStart = appJs.indexOf("const EVENT_COLORS = {");
    const colorEnd = appJs.indexOf("\n};", colorStart);
    const colorBlock = appJs.slice(colorStart, colorEnd);
    const colorKeys = new Set([...colorBlock.matchAll(/^\s+(\w+):\s*"/gm)].map(m => m[1]));

    const missing = [...iconKeys].filter(k => !colorKeys.has(k));
    expect(missing).toHaveLength(0);
  });
});
