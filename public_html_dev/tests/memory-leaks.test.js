/**
 * XYZO Memory-Leak Prevention Tests
 *
 * Locks in the fixes from the Tier memory-leak cleanup pass (Audit 1).
 * Covers:
 *   - LRUMap: bounded size, key promotion on re-set, resize at runtime
 *   - _discoverCooldowns prune: drops entries older than the cooldown
 *   - _imageDimensionsMap LRU: bounded size, promotes on re-set
 *   - AbortController cleanup: finally blocks reset module-scope handles
 *
 * Run: open /tests/index.html in browser.
 */

(function () {
  'use strict';

  const tests = [];

  // ── Re-implementations of the production utilities ────────────────
  // Mirrors app.js LRUMap exactly so we can test in isolation without
  // pulling in the whole Leaflet-bound app module.
  class LRUMap extends Map {
    constructor(maxSize) {
      super();
      this.maxSize = Math.max(1, maxSize | 0);
    }
    set(key, value) {
      if (super.has(key)) super.delete(key);
      super.set(key, value);
      while (super.size > this.maxSize) {
        const firstKey = super.keys().next().value;
        if (firstKey === undefined) break;
        super.delete(firstKey);
      }
      return this;
    }
    resize(maxSize) {
      this.maxSize = Math.max(1, maxSize | 0);
      while (super.size > this.maxSize) {
        const firstKey = super.keys().next().value;
        if (firstKey === undefined) break;
        super.delete(firstKey);
      }
      return this;
    }
  }

  // Mirror of app.js pruneDiscoverCooldowns() — drops entries older than
  // AUTO_DISCOVER_COOLDOWN_MS. Tested by populating the map with a mix of
  // fresh and stale timestamps and verifying only the fresh ones remain.
  const AUTO_DISCOVER_COOLDOWN_MS = 5 * 60 * 1000;
  function pruneDiscoverCooldowns(cooldowns, now) {
    const cutoff = now - AUTO_DISCOVER_COOLDOWN_MS;
    for (const [key, ts] of cooldowns) {
      if (ts < cutoff) cooldowns.delete(key);
    }
  }

  // ── Test: LRUMap caps at maxSize ──────────────────────────────────
  function testLRUMapCapsAtMaxSize() {
    const cache = new LRUMap(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // should evict 'a'
    const pass = cache.size === 3
      && !cache.has('a')
      && cache.has('b')
      && cache.has('c')
      && cache.has('d');
    tests.push({
      pass,
      msg: `LRUMap caps at maxSize=3: after 4 sets, size=${cache.size}, has a=${cache.has('a')}, b=${cache.has('b')}, c=${cache.has('c')}, d=${cache.has('d')}`,
    });
  }

  // ── Test: LRUMap re-set promotes key ──────────────────────────────
  function testLRUMapResetPromotesKey() {
    const cache = new LRUMap(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Re-set 'a' — should become most-recently-used, evict order: b → c → a
    cache.set('a', 99);
    cache.set('d', 4); // should evict 'b' (LRU), keep 'a' (just promoted)
    const pass = cache.size === 3
      && cache.get('a') === 99
      && !cache.has('b')
      && cache.has('c')
      && cache.has('d');
    tests.push({
      pass,
      msg: `LRUMap re-set promotes key: after re-set+1 insert, has a=${cache.has('a')}(val=${cache.get('a')}), b=${cache.has('b')}, c=${cache.has('c')}, d=${cache.has('d')}`,
    });
  }

  // ── Test: LRUMap size 1 evicts on every new set ───────────────────
  function testLRUMapSizeOne() {
    const cache = new LRUMap(1);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    const pass = cache.size === 1 && cache.has('c') && !cache.has('a') && !cache.has('b');
    tests.push({
      pass,
      msg: `LRUMap size 1: only the latest entry survives (size=${cache.size}, has c=${cache.has('c')})`,
    });
  }

  // ── Test: LRUMap resize shrinks to new bound ──────────────────────
  function testLRUMapResize() {
    const cache = new LRUMap(5);
    for (let i = 0; i < 5; i++) cache.set('k' + i, i);
    cache.resize(2);
    // First two keys (k0, k1) should be evicted to fit new bound
    const pass = cache.size === 2 && cache.has('k3') && cache.has('k4');
    tests.push({
      pass,
      msg: `LRUMap.resize(2) shrinks to 2 entries (size=${cache.size}, has k3=${cache.has('k3')}, k4=${cache.has('k4')})`,
    });
  }

  // ── Test: LRUMap resize grows the bound ──────────────────────────
  function testLRUMapResizeGrow() {
    const cache = new LRUMap(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.resize(5);
    cache.set('c', 3);
    cache.set('d', 4);
    cache.set('e', 5);
    const pass = cache.size === 5;
    tests.push({
      pass,
      msg: `LRUMap.resize(5) grows bound: 5 sets produce size=${cache.size} (was 2)`,
    });
  }

  // ── Test: LRUMap handles maxSize < 1 by clamping to 1 ────────────
  function testLRUMapClampsMinSize() {
    const cache = new LRUMap(0);
    cache.set('a', 1);
    const pass = cache.maxSize === 1 && cache.size === 1;
    tests.push({
      pass,
      msg: `LRUMap maxSize=0 clamps to 1: maxSize=${cache.maxSize}, size=${cache.size}`,
    });
  }

  // ── Test: _discoverCooldowns prune drops old entries ───────────────
  function testPruneDiscoverCooldowns() {
    const cooldowns = new Map();
    const now = 1_700_000_000_000;
    // 5 stale (10 min ago), 5 fresh (1 min ago)
    for (let i = 0; i < 5; i++) cooldowns.set(`stale-${i}`, now - 10 * 60 * 1000);
    for (let i = 0; i < 5; i++) cooldowns.set(`fresh-${i}`, now - 60 * 1000);

    pruneDiscoverCooldowns(cooldowns, now);

    const freshRemain = Array.from(cooldowns.keys()).filter((k) => k.startsWith('fresh-')).length;
    const staleRemain = Array.from(cooldowns.keys()).filter((k) => k.startsWith('stale-')).length;
    const pass = cooldowns.size === 5 && freshRemain === 5 && staleRemain === 0;
    tests.push({
      pass,
      msg: `_discoverCooldowns prune: 5 stale dropped, 5 fresh kept (size=${cooldowns.size}, fresh=${freshRemain}, stale=${staleRemain})`,
    });
  }

  // ── Test: _discoverCooldowns prune is a no-op on empty map ────────
  function testPruneDiscoverCooldownsEmpty() {
    const cooldowns = new Map();
    pruneDiscoverCooldowns(cooldowns, Date.now());
    const pass = cooldowns.size === 0;
    tests.push({
      pass,
      msg: `pruneDiscoverCooldowns on empty map: size=${cooldowns.size} (no-op)`,
    });
  }

  // ── Test: _discoverCooldowns prune handles all-fresh entries ──────
  function testPruneDiscoverCooldownsAllFresh() {
    const cooldowns = new Map();
    const now = Date.now();
    for (let i = 0; i < 100; i++) cooldowns.set(`k${i}`, now);
    pruneDiscoverCooldowns(cooldowns, now);
    const pass = cooldowns.size === 100;
    tests.push({
      pass,
      msg: `_discoverCooldowns prune on all-fresh: nothing removed (size=${cooldowns.size})`,
    });
  }

  // ── Test: _imageDimensionsMap LRU caps at 500 ─────────────────────
  function testImageDimensionsMapLRU() {
    const map = new LRUMap(500);
    // Insert 1000 distinct URLs
    for (let i = 0; i < 1000; i++) {
      map.set(`https://example.com/img/${i}.jpg`, { w: 100, h: 100 });
    }
    const pass = map.size === 500 && !map.has('https://example.com/img/0.jpg') && map.has('https://example.com/img/999.jpg');
    tests.push({
      pass,
      msg: `_imageDimensionsMap LRU cap=500: 1000 inserts → size=${map.size}, first evicted=${!map.has('https://example.com/img/0.jpg')}, last kept=${map.has('https://example.com/img/999.jpg')}`,
    });
  }

  // ── Test: _imageDimensionsMap re-set promotes key ────────────────
  function testImageDimensionsMapReuse() {
    const map = new LRUMap(3);
    map.set('a', { w: 1, h: 1 });
    map.set('b', { w: 2, h: 2 });
    map.set('c', { w: 3, h: 3 });
    // Re-set 'a' to a new value — should promote
    map.set('a', { w: 99, h: 99 });
    // Now insert 'd' — should evict 'b' (now the LRU), keep 'a'
    map.set('d', { w: 4, h: 4 });
    const pass = map.size === 3
      && map.get('a').w === 99
      && !map.has('b')
      && map.has('c')
      && map.has('d');
    tests.push({
      pass,
      msg: `_imageDimensionsMap re-set promotes: 'a' survives + updated (w=${map.get('a').w}), 'b' evicted, 'c'+'d' kept`,
    });
  }

  // ── Test: AbortController inflight handle cleared in finally ──────
  // Mirrors the pattern used in probe(), fetchWikiSearch(), etc. The
  // module-scope handle should be cleared when the call settles so the
  // AbortController is GC-eligible.
  function testAbortHandleClearedOnSuccess() {
    let _handle = null;
    async function fakeFetch() {
      if (_handle) _handle.abort();
      const ctrl = new AbortController();
      _handle = ctrl;
      try {
        // simulate successful await
        await Promise.resolve();
        return 'ok';
      } finally {
        if (_handle === ctrl) _handle = null;
      }
    }
    return fakeFetch().then(() => {
      const pass = _handle === null;
      tests.push({
        pass,
        msg: `AbortController cleared in finally (success path): _handle=${_handle}`,
      });
    });
  }

  // ── Test: AbortController cleared on abort path ───────────────────
  function testAbortHandleClearedOnAbort() {
    let _handle = null;
    async function fakeFetch() {
      if (_handle) _handle.abort();
      const ctrl = new AbortController();
      _handle = ctrl;
      try {
        // simulate aborted await
        await new Promise((_, reject) => {
          ctrl.signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
          ctrl.abort();
        });
        return 'ok';
      } catch (e) {
        if (e?.name === 'AbortError') return 'aborted';
        throw e;
      } finally {
        if (_handle === ctrl) _handle = null;
      }
    }
    return fakeFetch().then((result) => {
      const pass = result === 'aborted' && _handle === null;
      tests.push({
        pass,
        msg: `AbortController cleared in finally (abort path): result=${result}, _handle=${_handle}`,
      });
    });
  }

  // ── Test: AbortController pattern — newer handle replaces older ───
  function testAbortHandleReplaced() {
    let _handle = null;
    function startCall() {
      if (_handle) _handle.abort();
      const ctrl = new AbortController();
      _handle = ctrl;
      return ctrl;
    }
    const ctrl1 = startCall();
    const ctrl2 = startCall();
    // ctrl1 should have been aborted when ctrl2 was created
    const pass = _handle === ctrl2 && ctrl1.signal.aborted === true;
    tests.push({
      pass,
      msg: `AbortController replacement: newer ctrl is current (_handle===ctrl2=${_handle === ctrl2}), older aborted=${ctrl1.signal.aborted}`,
    });
    // Clean up
    if (_handle) _handle.abort();
    _handle = null;
  }

  // ── Test: End-to-end — long simulated session stays bounded ───────
  // Simulates a user panning across many bboxes (a "world tour"). Without
  // pruning, the cooldowns map grows linearly. With prune, it stays
  // bounded to entries within the cooldown window.
  function testLongSessionBounded() {
    const cooldowns = new Map();
    const cooldownMs = AUTO_DISCOVER_COOLDOWN_MS;

    // Simulate 2000 pan-triggered discoveries across many areas, with
    // varying ages. Mix in old entries to simulate the leak from before
    // the fix.
    const now = Date.now();
    for (let i = 0; i < 2000; i++) {
      // 90% stale (older than cooldown), 10% fresh
      const ageMs = i % 10 === 0 ? 60 * 1000 : cooldownMs + i * 100;
      cooldowns.set(`area-${i}`, now - ageMs);
    }
    const beforePrune = cooldowns.size;

    pruneDiscoverCooldowns(cooldowns, now);

    // Should retain only the fresh ones (every 10th = 200)
    const pass = beforePrune === 2000 && cooldowns.size === 200;
    tests.push({
      pass,
      msg: `Long session bounded: pre-prune=${beforePrune}, post-prune=${cooldowns.size} (expected 200 fresh entries retained)`,
    });
  }

  // ── Run all tests ─────────────────────────────────────────────────
  function runTests() {
    tests.length = 0;

    // Sync tests
    testLRUMapCapsAtMaxSize();
    testLRUMapResetPromotesKey();
    testLRUMapSizeOne();
    testLRUMapResize();
    testLRUMapResizeGrow();
    testLRUMapClampsMinSize();
    testPruneDiscoverCooldowns();
    testPruneDiscoverCooldownsEmpty();
    testPruneDiscoverCooldownsAllFresh();
    testImageDimensionsMapLRU();
    testImageDimensionsMapReuse();
    testAbortHandleReplaced();
    testLongSessionBounded();

    // Async tests
    return Promise.all([
      testAbortHandleClearedOnSuccess(),
      testAbortHandleClearedOnAbort(),
    ]).then(() => {
      const passed = tests.filter((t) => t.pass).length;
      const failed = tests.filter((t) => !t.pass).length;
      return { passed, failed, tests };
    });
  }

  window.MemoryLeaksTests = { runTests, tests };
})();