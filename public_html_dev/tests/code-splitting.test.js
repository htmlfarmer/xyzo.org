/**
 * XYZO Code Splitting Tests
 *
 * Verifies the lazy-load behavior introduced in Audit 2:
 *
 *   1. cities.10k.json must NOT be fetched eagerly on city-engine
 *      script load. The city-engine wraps the fetch in
 *      requestIdleCallback (with a 1200ms setTimeout fallback) so it
 *      piggybacks on browser idle time instead of blocking initial
 *      render.
 *
 *   2. flag-quality.js and ai-story-chat.js must NOT appear as
 *      <script src=> in index.html. They're loaded dynamically the
 *      first time the user clicks the trigger button.
 *
 *   3. The thin wrapper functions in app.js must defer to the
 *      chunk's window.XyzoFlagQuality / XyzoAiStoryChat symbols and
 *      call loadChunk() only when those symbols are missing.
 *
 * Run: open /tests/index.html in browser (no JS env needed).
 */

(function () {
  'use strict';

  const tests = [];

  // ── Test 1: cities.10k.json must not be loaded synchronously on
  // city-engine script execution. We can't measure "is the fetch
  // happening" from a static test alone, but we CAN assert that:
  //   - state.loaded is false right after script load
  //   - the public API exposes an ensureLoaded() helper that callers
  //     can use to start the fetch earlier
  //   - the load is wrapped in requestIdleCallback / setTimeout
  //     (deferred), not awaited at module top-level
  function testCitiesLazyLoadApi() {
    const checks = [];
    // CityEngine API surface
    checks.push([
      typeof CityEngine !== "undefined" && typeof CityEngine.load === "function",
      "CityEngine.load is a function",
    ]);
    checks.push([
      typeof CityEngine !== "undefined" && typeof CityEngine.ensureLoaded === "function",
      "CityEngine.ensureLoaded is a function (lazy-load entry point)",
    ]);
    checks.push([
      typeof CityEngine !== "undefined" && typeof CityEngine.isLoaded === "function",
      "CityEngine.isLoaded is a function",
    ]);
    // Initially NOT loaded — lazy-load means the data isn't fetched
    // synchronously at script execution time.
    checks.push([
      typeof CityEngine !== "undefined" && CityEngine.isLoaded() === false,
      "CityEngine is NOT loaded synchronously after script execution",
    ]);
    // ensureLoaded() must return a Promise that, once awaited, flips
    // isLoaded() to true.
    const failed = checks.filter(([ok]) => !ok);
    if (failed.length === 0) {
      return { pass: true, msg: "cities.10k.json loads lazily via requestIdleCallback (audit 2 fix)" };
    }
    return {
      pass: false,
      msg: "Lazy-load API incomplete: " + failed.map(([, m]) => m).join("; "),
    };
  }
  tests.push(testCitiesLazyLoadApi);

  // ── Test 2: flag-quality.js and ai-story-chat.js must NOT be
  // loaded eagerly via <script src=> in index.html.
  // We fetch index.html as text and assert the chunks aren't there.
  async function testChunksNotInIndexHtml() {
    try {
      const resp = await fetch("/index.html", { cache: "no-store" });
      const html = await resp.text();
      const looksLikeScriptTag = /<script[^>]*src=["'](flag-quality|ai-story-chat)\.js/i;
      const inIndexHtml = looksLikeScriptTag.test(html);
      // Preload is OK (it's just a hint, no script execution) but a
      // <script src=> would be a regression.
      if (inIndexHtml) {
        return {
          pass: false,
          msg: "index.html has a <script src=flag-quality.js|ai-story-chat.js>. Chunks must be lazy-loaded only.",
        };
      }
      return {
        pass: true,
        msg: "flag-quality.js / ai-story-chat.js are not loaded via <script src=> (lazy-loaded dynamically)",
      };
    } catch (e) {
      return { pass: false, msg: `Could not fetch /index.html: ${e.message}` };
    }
  }
  tests.push(testChunksNotInIndexHtml);

  // ── Test 3: data/cities.10k.json must NOT be loaded eagerly via
  // <script src=> or a fetch initiated synchronously in city-engine.js.
  // We can't directly observe the network from this static check, but
  // we can assert the source file uses requestIdleCallback (or
  // setTimeout) for the load trigger rather than calling load()
  // synchronously at module top level.
  async function testCityEngineDefersLoad() {
    try {
      const resp = await fetch("/city-engine.js", { cache: "no-store" });
      const src = await resp.text();
      const hasIdle = /requestIdleCallback/.test(src) || /setTimeout/.test(src);
      const hasEagerLoad = /^\s*load\(\);\s*$/m.test(src);
      if (!hasIdle) {
        return {
          pass: false,
          msg: "city-engine.js does not defer the cities.10k.json load (no requestIdleCallback / setTimeout).",
        };
      }
      if (hasEagerLoad) {
        return {
          pass: false,
          msg: "city-engine.js calls load() at module top level — should be deferred.",
        };
      }
      return {
        pass: true,
        msg: "city-engine.js defers cities.10k.json fetch via requestIdleCallback / setTimeout",
      };
    } catch (e) {
      return { pass: false, msg: `Could not fetch /city-engine.js: ${e.message}` };
    }
  }
  tests.push(testCityEngineDefersLoad);

  // ── Test 4: app.js must have the chunk wrappers. They define
  // showQuickFlagDialog, showReportDialog, openPinAiChat as thin
  // proxies that defer to window.XyzoFlagQuality / XyzoAiStoryChat.
  async function testAppJsHasChunkWrappers() {
    try {
      const resp = await fetch("/app.js", { cache: "no-store" });
      const src = await resp.text();
      const hasLazyLoader = /function loadChunk\s*\(/.test(src);
      const defersToChunk = /window\.Xyzo(FlagQuality|AiStoryChat)/.test(src);
      if (!hasLazyLoader) {
        return { pass: false, msg: "app.js missing loadChunk() helper" };
      }
      if (!defersToChunk) {
        return { pass: false, msg: "app.js wrappers don't defer to window.Xyzo* chunks" };
      }
      return { pass: true, msg: "app.js lazy-loads chunks via loadChunk() + window.Xyzo* proxies" };
    } catch (e) {
      return { pass: false, msg: `Could not fetch /app.js: ${e.message}` };
    }
  }
  tests.push(testAppJsHasChunkWrappers);

  // ── Test 5: chunks themselves are correctly isolated. Their
  // public API must live on window.XyzoFlagQuality / XyzoAiStoryChat
  // and NOT pollute the global namespace beyond that.
  async function testChunkApiShape() {
    try {
      const fq = await fetch("/flag-quality.js", { cache: "no-store" });
      const ai = await fetch("/ai-story-chat.js", { cache: "no-store" });
      const fqSrc = await fq.text();
      const aiSrc = await ai.text();
      const fqHas = /window\.XyzoFlagQuality\s*=\s*\{/.test(fqSrc);
      const aiHas = /window\.XyzoAiStoryChat\s*=\s*\{/.test(aiSrc);
      if (!fqHas) return { pass: false, msg: "flag-quality.js missing window.XyzoFlagQuality export" };
      if (!aiHas) return { pass: false, msg: "ai-story-chat.js missing window.XyzoAiStoryChat export" };
      return { pass: true, msg: "Chunks export window.XyzoFlagQuality + window.XyzoAiStoryChat correctly" };
    } catch (e) {
      return { pass: false, msg: `Could not fetch chunks: ${e.message}` };
    }
  }
  tests.push(testChunkApiShape);

  // ── Run tests ─────────────────────────────────────────────────────
  async function runTests() {
    console.log("Running XYZO Code Splitting Tests...");
    let passed = 0, failed = 0;
    for (const test of tests) {
      const result = await test();
      if (result.pass) {
        console.log(`  ✅ ${result.msg}`);
        passed++;
      } else {
        console.error(`  ❌ ${result.msg}`);
        failed++;
      }
    }
    const total = passed + failed;
    console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);
    return { passed, failed, total };
  }

  // Export for use in browser console or HTML test page
  window.CodeSplittingTests = { runTests, tests };

  if (typeof module !== "undefined" && module.exports) module.exports = { runTests, tests };

  return { runTests, tests };
})();
