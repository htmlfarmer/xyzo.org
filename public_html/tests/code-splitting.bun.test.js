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
    // <script src=...> would eagerly fetch+execute. We use idle-time
    // <link rel="prefetch"> hints only (prefetch, not preload — the
    // chunks must not compete with the boot path for bandwidth), so
    // allow that pattern.
    const scriptTagForChunk =
      /<script[^>]*src=["'](flag-quality|ai-story-chat)\.js/i;
    expect(html).not.toMatch(scriptTagForChunk);

    // Prefetch hints ARE expected (we want the browser to fetch the
    // chunks during idle so the first click is snappy).
    expect(html).toMatch(/<link[^>]*rel=["']prefetch["'][^>]*flag-quality\.js/);
    expect(html).toMatch(/<link[^>]*rel=["']prefetch["'][^>]*ai-story-chat\.js/);
  });

  test("index.html does NOT preload the city index — it is not on the critical path", () => {
    // The preload used to be here, with a comment saying the point was
    // to start the 1.16 MB fetch "during idle time (after initial
    // render)". A <link rel="preload"> in the HEAD does not wait for
    // idle: the browser starts it as soon as it parses the HTML.
    // Measured 2026-11-12, it was the FIRST request on the page
    // (t=0.30 s, before app.js) and it competed with app.js and the
    // map's 280 tiles for a slow connection's bandwidth — and the
    // markers cannot start until app.js lands.
    //
    // The index is fetched when it is needed: when the reader touches
    // the search box or the map (app.js warms it; city-engine.js loads
    // it on demand).
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    expect(html).not.toMatch(/<link[^>]*rel=["']preload["'][^>]*cities\.10k\.json/);
    // And nothing else preloads it either.
    expect(html).not.toMatch(/<link[^>]*rel=["']preload["'][^>]*cities\./);
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

  // ── REMOVED 2026-11-01 (owner): app.js has NO size ceiling ──────────
  //
  // What used to live here was `expect(stat.length).toBeLessThan
  // (850_000)` — a "runaway-growth ceiling" added 2026-10-29 in
  // fbb3ed5 whose entire rationale sat in this comment ("if you blow
  // past 850 KB, extract another chunk rather than raising it again").
  //
  // It was never a speed guard, and it measured the wrong quantity:
  //
  //   * app.js ships as ~245 KB GZIPPED, not 850 KB — that is what
  //     actually crosses the wire, and gzip crushes the source 3.5x;
  //   * all 62 scripts on the page are `defer` (0 `async`), so a big
  //     app.js does not block rendering;
  //   * it is served `Cache-Control: immutable` for a YEAR, so the cost
  //     is a one-time first visit, not per-visit render time.
  //
  // Meanwhile it was the binding constraint on every frontend change —
  // six tests asserted it across five files, and it reshaped real work:
  //
  //   * the population overlay went into a generic-layers REGISTRY
  //     instead of being named inline (README records "8 bytes" of
  //     margin as the reason);
  //   * state-abbrev search moved 3.4 KB into city-engine.js;
  //   * the layers-tap fix deleted six uncalled functions and four dead
  //     consts purely to get back under it;
  //   * the Cool-maps keepView fix had to move its rationale into a
  //     test file to save 46 bytes of comment inside app.js.
  //
  // A gate you have to dismantle code to pass has stopped being a
  // guard. The tests that remain below still pin the thing that
  // actually matters — that code NOT needed at boot stays out of
  // app.js behind loadChunk(). That is an architectural rule, not a
  // byte count: grow app.js freely, but keep the parts only some
  // screens need in chunks.
  //
  // Do not re-add a size assertion here.
  test("the loadChunk escape hatch still exists for code that is not needed at boot", () => {
    const src = readFileSync(join(ROOT, "app.js"), "utf8");
    expect(src).toMatch(/function loadChunk\s*\(/);
    expect(src).toMatch(/createElement\s*\(\s*['"]script['"]/);
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
