/**
 * Bun test wrapper for code-splitting.test.js
 *
 * The primary code-splitting.test.js is browser-only (uses window.fetch
 * and DOM). This file ports the static-analysis checks to bun:test so
 * we can run them headlessly in CI / locally without a browser.
 *
 * Verifies:
 *   1. city-engine.js defers the cities.10k.json fetch
 *      (no eager load() at module top level; uses requestIdleCallback
 *      or setTimeout to schedule the fetch).
 *   2. index.html does NOT have a <script src=flag-quality.js> or
 *      <script src=ai-story-chat.js> tag — chunks must be lazy-loaded
 *      only.
 *   3. city-engine.js exposes an ensureLoaded() helper for callers that
 *      need the dataset synchronously.
 *   4. app.js defines loadChunk() and proxies to window.XyzoFlagQuality
 *      / XyzoAiStoryChat.
 *   5. The chunks export the right globals (window.XyzoFlagQuality /
 *      XyzoAiStoryChat).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("code splitting + lazy load (Audit 2)", () => {
  test("city-engine.js defers cities.10k.json fetch", () => {
    const src = readFileSync(join(ROOT, "city-engine.js"), "utf8");

    // 1. Must NOT call load() eagerly at module top level. The script
    //    body should be wrapped in some kind of deferral.
    const hasEagerLoad = /^\s*load\(\);\s*$/m.test(src);
    expect(hasEagerLoad).toBe(false);

    // 2. Must use either requestIdleCallback or setTimeout to defer.
    const usesIdle = /requestIdleCallback/.test(src);
    const usesTimeout = /setTimeout\s*\(/.test(src);
    expect(usesIdle || usesTimeout).toBe(true);
  });

  test("city-engine.js exposes ensureLoaded() helper", () => {
    const src = readFileSync(join(ROOT, "city-engine.js"), "utf8");
    expect(src).toMatch(/function ensureLoaded\s*\(/);
    expect(src).toMatch(/window\.CityEngine/);
    expect(src).toMatch(/ensureLoaded,/); // exposed in public API
  });

  test("index.html does NOT eagerly load flag-quality.js or ai-story-chat.js", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    // <script src=...> would eagerly fetch+execute. We use
    // <link rel="preload"> only, so allow that pattern.
    const scriptTagForChunk =
      /<script[^>]*src=["'](flag-quality|ai-story-chat)\.js/i;
    expect(html).not.toMatch(scriptTagForChunk);

    // Preload hints ARE expected (we want the browser to fetch the
    // chunks during idle so the first click is snappy).
    expect(html).toMatch(/<link[^>]*rel=["']preload["'][^>]*flag-quality\.js/);
    expect(html).toMatch(/<link[^>]*rel=["']preload["'][^>]*ai-story-chat\.js/);
  });

  test("index.html preloads cities.10k.json for idle-time fetch", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    expect(html).toMatch(/<link[^>]*rel=["']preload["'][^>]*cities\.10k\.json/);
  });

  test("app.js defines loadChunk() lazy loader", () => {
    const src = readFileSync(join(ROOT, "app.js"), "utf8");
    expect(src).toMatch(/function loadChunk\s*\(/);
    // loadChunk must create a <script> tag dynamically
    expect(src).toMatch(/document\.createElement\s*\(\s*['"]script['"]/);
  });

  test("app.js wrappers defer to window.Xyzo* chunk globals", () => {
    const src = readFileSync(join(ROOT, "app.js"), "utf8");
    expect(src).toMatch(/window\.XyzoFlagQuality/);
    expect(src).toMatch(/window\.XyzoAiStoryChat/);
  });

  test("flag-quality.js exports window.XyzoFlagQuality with right methods", () => {
    const src = readFileSync(join(ROOT, "flag-quality.js"), "utf8");
    expect(src).toMatch(/window\.XyzoFlagQuality\s*=\s*\{/);
    expect(src).toMatch(/showQuickFlagDialog/);
    expect(src).toMatch(/showReportDialog/);
    expect(src).toMatch(/closeQuickFlagDialog/);
    expect(src).toMatch(/closeReportDialog/);
  });

  test("ai-story-chat.js exports window.XyzoAiStoryChat with open()", () => {
    const src = readFileSync(join(ROOT, "ai-story-chat.js"), "utf8");
    expect(src).toMatch(/window\.XyzoAiStoryChat\s*=\s*\{/);
    expect(src).toMatch(/open\s*:\s*openPinAiChat/);
  });

  test("app.js is smaller than the original (~528 KB)", () => {
    const stat = readFileSync(join(ROOT, "app.js"));
    // Original was 528,845 bytes. After extraction we should be
    // noticeably smaller. Allow generous headroom for other changes
    // (e.g. the a11y modal helpers added ~4 KB during the Audit 4
    // pass — keyboard-focus traps and Escape wiring are required for
    // WCAG 2.1.1 / 2.1.2).
    expect(stat.length).toBeLessThan(525_000);
  });

  test("city-engine.js exports load + ensureLoaded", () => {
    const src = readFileSync(join(ROOT, "city-engine.js"), "utf8");
    // The public API block should include both
    const apiBlock = src.match(/window\.CityEngine\s*=\s*\{([\s\S]*?)\}/);
    expect(apiBlock).not.toBeNull();
    if (apiBlock) {
      expect(apiBlock[1]).toMatch(/load\s*,/);
      expect(apiBlock[1]).toMatch(/ensureLoaded\s*,/);
    }
  });
});
