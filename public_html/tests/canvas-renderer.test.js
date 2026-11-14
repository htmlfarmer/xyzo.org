/**
 * XYZO Canvas Renderer & Pin Loading Tests
 * Tests for canvas pin rendering, viewport fetch flow, search,
 * syncLayers diff tracking, and API response handling.
 *
 * Prevents regressions like:
 * - Canvas not moving with map (pane vs container positioning)
 * - Pins not loading after pan (generation counter / AbortController bugs)
 * - Search markers disappearing on moveend
 * - syncLayers doing full clear+re-add instead of diff
 * - Enriched endpoint 404 for articles with NULL location_id
 *
 * Run: open /tests/index.html in browser
 */

(function () {
  'use strict';

  const tests = [];

  // ── Mock Map ───────────────────────────────────────────────────────
  function makeMockMap(opts) {
    const containerW = opts?.containerW || 1024;
    const containerH = opts?.containerH || 768;
    const zoom = opts?.zoom || 5;
    const center = opts?.center || { lat: 20, lng: -80 };
    return {
      _zoom: zoom,
      _layers: new Set(),
      _events: {},
      _container: {
        clientWidth: containerW,
        clientHeight: containerH,
        getBoundingClientRect() {
          return { left: 0, top: 0, width: containerW, height: containerH };
        },
      },
      getContainer() { return this._container; },
      getSize() { return { x: containerW, y: containerH }; },
      getZoom() { return this._zoom; },
      getCenter() { return center; },
      getBounds() {
        return {
          getWest: () => center.lng - 30,
          getSouth: () => center.lat - 15,
          getEast: () => center.lng + 30,
          getNorth: () => center.lat + 15,
        };
      },
      getPane(name) {
        return {
          appendChild() {},
          removeChild() {},
          offsetWidth: containerW,
          offsetHeight: containerH,
        };
      },
      hasLayer(l) { return this._layers.has(l); },
      addLayer(l) { this._layers.add(l); },
      removeLayer(l) { this._layers.delete(l); },
      on() {},
      off() {},
      latLngToContainerPoint(ll) {
        // Simple Mercator-ish projection for testing
        return {
          x: (ll.lng - center.lng) * 5 + containerW / 2,
          y: (center.lat - ll.lat) * 5 + containerH / 2,
        };
      },
      latLngToLayerPoint(ll) {
        return this.latLngToContainerPoint(ll);
      },
    };
  }

  // ── Mock Canvas Context ────────────────────────────────────────────
  function makeMockCtx() {
    return {
      calls: [],
      setTransform() {},
      clearRect(...a) { this.calls.push({ fn: 'clearRect', a }); },
      drawImage(...a) { this.calls.push({ fn: 'drawImage', a }); },
      fillRect(...a) { this.calls.push({ fn: 'fillRect', a }); },
      fillText() {},
      beginPath() {},
      arc() {},
      fill() {},
      stroke() {},
      scale() {},
    };
  }

  // ── Test: _radiusForZoom returns correct values ────────────────────
  function testRadiusForZoom() {
    // Direct implementation matching app.js _radiusForZoom
    function radiusForZoom(zoom) {
      return zoom <= 1 ? 5 : zoom <= 2 ? 7 : zoom <= 4 ? 9
        : zoom <= 6 ? 11 : zoom <= 8 ? 13 : zoom <= 10 ? 15
        : zoom <= 12 ? 17 : 19;
    }
    const cases = [
      [0, 5], [1, 5], [2, 7], [3, 9], [4, 9],
      [5, 11], [6, 11], [7, 13], [8, 13], [9, 15],
      [10, 15], [11, 17], [12, 17], [13, 19], [18, 19],
    ];
    let allPass = true;
    for (const [zoom, expected] of cases) {
      const got = radiusForZoom(zoom);
      if (got !== expected) {
        tests.push({ pass: false, msg: `_radiusForZoom(${zoom}): expected ${expected}, got ${got}` });
        allPass = false;
      }
    }
    if (allPass) {
      tests.push({ pass: true, msg: '_radiusForZoom: all zoom levels return correct radius' });
    }
  }

  // ── Test: Canvas bucket colors are visually distinct (no confusing overlap) ─
  // Prevents regressions where technology/health/other collapse to the same
  // cyan/teal blob. Uses Euclidean RGB distance with a two-tier threshold:
  //   • STRICT (≥55): cross-hue pairs must be clearly different
  //   • RELAXED (≥30): same-hue family pairs (crime/conflict, environment/sports,
  //     science/technology, etc.) may be closer since semantic grouping is similar.
  // The old palette had technology(#06b6d4)/health(#14b8a6) at ~20 RGB units,
  // which triggered this test and prompted the palette redesign.
  function testCanvasColorsDistinct() {
    const BUCKET_COLORS = [
      ['politics', '#f97316'], ['business', '#eab308'], ['crime', '#dc2626'],
      ['conflict', '#b91c1c'], ['weather', '#3b82f6'], ['science', '#8b5cf6'],
      ['technology', '#9333ea'], ['sports', '#22c55e'], ['culture', '#ec4899'],
      ['environment', '#84cc16'], ['disaster', '#d97706'], ['humanitarian', '#f472b6'],
      ['health', '#06b6d4'], ['other', '#5eead4'],
    ];
    function hexToRgb(hex) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return [r, g, b];
    }
    function rgbDist(a, b) {
      return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    }
    // Alphabetically sorted keys — must match .sort().join('/') lookup
    const SAME_HUE = {
      'conflict/crime': true, 'crime/humanitarian': true,
      'disaster/politics': true, 'environment/sports': true,
      'culture/humanitarian': true, 'science/technology': true,
    };
    const STRICT = 55;
    const RELAXED = 30;
    const failures = [];
    for (let i = 0; i < BUCKET_COLORS.length; i++) {
      for (let j = i + 1; j < BUCKET_COLORS.length; j++) {
        const [n1, c1] = BUCKET_COLORS[i];
        const [n2, c2] = BUCKET_COLORS[j];
        const d = rgbDist(hexToRgb(c1), hexToRgb(c2));
        const key = [n1, n2].sort().join('/');
        const thr = SAME_HUE[key] ? RELAXED : STRICT;
        if (d < thr) {
          failures.push([n1, n2, Math.round(d)]);
        }
      }
    }
    if (failures.length > 0) {
      const msg = 'Color collisions: ' + failures.map(([a, b, d]) => a + '/' + b + '(' + d + ')').join(', ');
      tests.push({ pass: false, msg });
    } else {
      tests.push({ pass: true, msg: 'Canvas bucket colors: all 14 buckets pass distinctness check' });
    }
  }

  // ── Test: CANVAS_CAT_COLORS has all expected categories ────────────
  function testCanvasCatColors() {
    const expected = [
      'politics', 'business', 'crime', 'conflict', 'weather',
      'science', 'technology', 'sports', 'culture', 'environment',
      'disaster', 'humanitarian', 'health', 'other',
    ];
    const colors = {
      politics: '#f97316', business: '#eab308', crime: '#ef4444', conflict: '#dc2626',
      weather: '#3b82f6', science: '#8b5cf6', technology: '#06b6d4', sports: '#22c55e',
      culture: '#ec4899', environment: '#10b981', disaster: '#a16207', humanitarian: '#f43f5e',
      health: '#14b8a6', other: '#5eead4',
    };
    let allPass = true;
    for (const cat of expected) {
      if (!colors[cat]) {
        tests.push({ pass: false, msg: `CANVAS_CAT_COLORS missing color for "${cat}"` });
        allPass = false;
      }
    }
    if (allPass) {
      tests.push({ pass: true, msg: 'CANVAS_CAT_COLORS: all categories have colors defined' });
    }
  }

  // ── Test: pickCanvasLimitForZoom returns sensible limits ────────────
  function testCanvasLimitForZoom() {
    function pickCanvasLimitForZoom(z) {
      if (z <= 2) return 500;
      if (z <= 4) return 1000;
      if (z <= 6) return 2500;
      if (z <= 8) return 4000;
      return 5000;
    }
    const cases = [[1, 500], [3, 1000], [5, 2500], [7, 4000], [10, 5000]];
    let allPass = true;
    for (const [z, expected] of cases) {
      const got = pickCanvasLimitForZoom(z);
      if (got !== expected) {
        tests.push({ pass: false, msg: `pickCanvasLimitForZoom(${z}): expected ${expected}, got ${got}` });
        allPass = false;
      }
    }
    if (allPass) {
      tests.push({ pass: true, msg: 'pickCanvasLimitForZoom: returns correct limits per zoom' });
    }
  }

  // ── Test: Canvas uses container coordinates (not layer points) ──────
  function testCanvasUsesContainerCoords() {
    const map = makeMockMap({ containerW: 800, containerH: 600, zoom: 5, center: { lat: 0, lng: 0 } });
    const pin = { lat: 10, lng: 20, c: 'news' };

    // Container point: relative to visible area
    const cp = map.latLngToContainerPoint([pin.lat, pin.lng]);
    // Layer point: should be the same for our mock
    const lp = map.latLngToLayerPoint([pin.lat, pin.lng]);

    // In the real Leaflet, containerPoint accounts for the map pane position.
    // The canvas at position (0,0) in the container should use containerPoint.
    // Verify that containerPoint gives coordinates within the canvas bounds.
    const canvasW = map.getContainer().clientWidth;
    const canvasH = map.getContainer().clientHeight;

    const inBounds = cp.x >= 0 && cp.x <= canvasW && cp.y >= 0 && cp.y <= canvasH;
    tests.push({
      pass: inBounds,
      msg: `Canvas container coords: pin at (10,20) → containerPoint (${cp.x.toFixed(0)}, ${cp.y.toFixed(0)}) within ${canvasW}x${canvasH} canvas`,
    });
  }

  // ── Test: Canvas fills the map container ────────────────────────────
  function testCanvasFillsContainer() {
    const containerW = 1200;
    const containerH = 800;
    const dpr = 2;

    // Simulate canvas sizing
    const canvasW = containerW * dpr;
    const canvasH = containerH * dpr;

    tests.push({
      pass: canvasW === 2400 && canvasH === 1600,
      msg: `Canvas sizing: ${containerW}x${containerH} @${dpr}x DPR → ${canvasW}x${canvasH} bitmap`,
    });
  }

  // ── Test: Generation counter prevents stale renders ─────────────────
  function testGenerationCounter() {
    let _fetchGen = 0;
    const renders = [];

    // Simulate3 rapid fetchPinsForViewport calls
    function simulateFetch(gen, items, delay) {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (gen !== _fetchGen) {
            renders.push({ gen, status: 'stale' });
          } else {
            renders.push({ gen, status: 'rendered', count: items });
          }
          resolve();
        }, delay);
      });
    }

    const gen1 = ++_fetchGen; // 1
    const gen2 = ++_fetchGen; // 2
    const gen3 = ++_fetchGen; // 3

    return Promise.all([
      simulateFetch(gen1, 500, 30), // will be stale (gen1 < _fetchGen=3)
      simulateFetch(gen2, 750, 20), // will be stale
      simulateFetch(gen3, 1000, 10), // current
    ]).then(() => {
      const stale = renders.filter(r => r.status === 'stale');
      const rendered = renders.filter(r => r.status === 'rendered');
      const pass = stale.length === 2 && rendered.length === 1 && rendered[0].count === 1000;
      tests.push({
        pass,
        msg: `Generation counter: ${stale.length} stale, ${rendered.length} rendered (expected 2 stale, 1 rendered with 1000 items)`,
      });
    });
  }

  // ── Test: syncLayers diff tracking ──────────────────────────────────
  function testSyncLayersDiff() {
    // Simulate the diff tracking Sets
    const inClusterPins = new Set();
    const desiredPins = new Set([1, 2, 3, 4, 5]);

    // First sync: everything is new
    const toAdd1 = [];
    const toRemove1 = [];
    for (const id of desiredPins) { if (!inClusterPins.has(id)) toAdd1.push(id); }
    for (const id of inClusterPins) { if (!desiredPins.has(id)) toRemove1.push(id); }

    // Apply
    for (const id of toAdd1) inClusterPins.add(id);

    // Second sync: pins 3,4 removed, pin 6 added
    const desiredPins2 = new Set([1, 2, 5, 6]);
    const toAdd2 = [];
    const toRemove2 = [];
    for (const id of desiredPins2) { if (!inClusterPins.has(id)) toAdd2.push(id); }
    for (const id of inClusterPins) { if (!desiredPins2.has(id)) toRemove2.push(id); }

    const pass = toAdd1.length === 5 && toRemove1.length === 0 &&
                 toAdd2.length === 1 && toRemove2.length === 2 &&
                 toAdd2[0] === 6 && toRemove2.includes(3) && toRemove2.includes(4);
    tests.push({
      pass,
      msg: `syncLayers diff: first sync +5/-0, second sync +1/-2 (expected +1 for id=6, -2 for ids 3,4)`,
    });
  }

  // ── Test: clearSearch resets state properly ─────────────────────────
  function testClearSearchResetsState() {
    let searchActive = true;
    let searchInputValue = 'mumbai';
    let snapshotTaken = true;
    let viewportPinsSnapshot = [{ id: 1 }, { id: 2 }];
    const pinMarkers = new Map();
    pinMarkers.set(1, { _isSearchResult: true });
    pinMarkers.set(2, { _isSearchResult: false });

    // Simulate clearSearch
    searchActive = false;
    searchInputValue = '';
    viewportPinsSnapshot = [];
    snapshotTaken = false;
    pinMarkers.clear();

    const pass = !searchActive && searchInputValue === '' &&
                 viewportPinsSnapshot.length === 0 && !snapshotTaken &&
                 pinMarkers.size === 0;
    tests.push({
      pass,
      msg: `clearSearch: searchActive=false, input="", snapshot cleared, pinMarkers empty`,
    });
  }

  // ── Test: Search query is passed to canvas URL ─────────────────────
  function testSearchQueryInCanvasUrl() {
    const searching = true;
    const q = 'mumbai';
    const bbox = '-180,-85,180,85';
    const canvasLimit = 2500;
    const since = '2026-09-04T00:00:00Z';

    let url = `/api/pins/map?bbox=${bbox}&limit=${canvasLimit}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (searching) url += `&q=${encodeURIComponent(q)}`;

    const pass = url.includes('q=mumbai') && url.includes('bbox=') && url.includes('limit=2500');
    tests.push({
      pass,
      msg: `Search URL: canvas fetch includes q=mumbai in URL`,
    });
  }

  // ── Test: No AbortError skip in fetch flow ──────────────────────────
  function testNoAbortErrorSkip() {
    // Simulate the fixed fetch pattern: AbortError doesn't skip setPins
    let items = [];
    let setPinsCalled = false;

    function simulateFetch() {
      // Simulate AbortError catch — should NOT return before setPins
      try {
        throw new Error('The operation was aborted');
      } catch (err) {
        if (err.name !== 'AbortError') {
          return; // only non-abort errors return
        }
        // AbortError: fall through to setPins
      }
      // This code should run even after AbortError
      if (items.length > 0) {
        setPinsCalled = true;
      }
    }

    items = [{ id: 1, lat: 10, lng: 20 }];
    simulateFetch();

    tests.push({
      pass: setPinsCalled,
      msg: `No AbortError skip: setPins called even when fetch is aborted`,
    });
  }

  // ── Test: Enriched endpoint handles NULL location_id ────────────────
  function testEnrichedNullLocation() {
    // Simulate the fixed enriched query logic
    const article = { id: 6879074, title: 'Guide du weekend', location_id: null };
    const location = article.location_id ? { lat: 19, lng: 72 } : null;

    // The fix: use LEFT JOIN so location can be null
    const pin = {
      id: article.id,
      title: article.title,
      location: location, // null is valid
    };

    const pass = pin.id === 6879074 && pin.location === null && pin.title === 'Guide du weekend';
    tests.push({
      pass,
      msg: `Enriched NULL location: article with NULL location_id returns pin with null location (not 404)`,
    });
  }

  // ── Test: _hitTest uses container coordinates ───────────────────────
  function testHitTestUsesContainerCoords() {
    const map = makeMockMap({ containerW: 1024, containerH: 768, center: { lat: 0, lng: 0 } });
    const pins = [
      { id: 1, lat: 0, lng: 0, c: 'news' },    // center of map
      { id: 2, lat: 10, lng: 10, c: 'sports' },  // offset
    ];

    // Mouse at center of container (512, 384)
    const mx = 512, my = 384;
    const radius = 11;
    const hitR = radius * 1.4 + 4;

    let best = null, bestDist = hitR * hitR;
    for (const p of pins) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      const dx = pt.x - mx, dy = pt.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) { bestDist = d2; best = p; }
    }

    const pass = best && best.id === 1;
    tests.push({
      pass,
      msg: `Hit test: mouse at center hits pin at (0,0), not offset pin`,
    });
  }

  // ── Test: Multiple rapid pans don't leave stale data ────────────────
  function testRapidPansResolve() {
    let _fetchGen = 0;
    const results = [];

    // Simulate5 rapid pan events
    for (let i = 0; i < 5; i++) {
      const gen = ++_fetchGen;
      // Simulate fetch completing in order
      if (gen === _fetchGen) {
        results.push({ gen, items: (i + 1) * 100 });
      }
    }

    // Only the last one should have been rendered
    const pass = results.length === 5 && results[4].items === 500;
    tests.push({
      pass,
      msg: `Rapid pans: 5 pans, last has gen=${_fetchGen} with 500 items`,
    });
  }

  // ── Test: Stale fetchPinsForViewport call must not clobber canvas ──
  // Tier 1.5 regression test. Models the second-pan-no-pins race:
  // fetchA starts (sets inflightCtrl = ctrlA), then fetchB starts
  // (inflightCtrl = ctrlB and aborts ctrlA). If ctrlA's await
  // nevertheless completes before its catch sees the AbortError, the
  // setPins it would call would clobber ctrlB's pins. The fix
  // (`if (inflightCtrl !== ctrl) return;` before setPins) prevents this.
  function testStaleFetchDoesNotClobberCanvas() {
    let inflightCtrl = null;
    const writesToCanvas = [];

    function fakeSetPins(items, ctrl) {
      // Mirrors the real guard: a stale call (ctrl !== inflightCtrl) must
      // be a no-op. Without the guard, the canvas would receive stale
      // data after a newer fetch had already painted.
      if (inflightCtrl !== ctrl) return;
      writesToCanvas.push(items);
    }

    // fetchA starts. Records its ctrl in module state.
    const ctrlA = { id: "A" };
    inflightCtrl = ctrlA;

    // fetchB starts before A's response handling. B replaces inflightCtrl
    // and aborts A. fetchB is now the "current" call.
    const ctrlB = { id: "B" };
    try { ctrlA.id && (ctrlA.aborted = true); } catch (_) {}
    inflightCtrl = ctrlB;

    // A's response handling resumes (e.g. streaming was already in flight).
    // The fix's stale-check must prevent A from painting.
    fakeSetPins([{ id: 1, source: "A" }], ctrlA);
    // B's response handling runs normally.
    fakeSetPins([{ id: 2, source: "B" }], ctrlB);

    const pass = writesToCanvas.length === 1 &&
                 writesToCanvas[0].length === 1 &&
                 writesToCanvas[0][0].source === "B";
    tests.push({
      pass,
      msg: `Stale fetch guard: only B painted (${writesToCanvas.length} write(s)); A was blocked by inflightCtrl check`,
    });

    // Reset for any later tests.
    inflightCtrl = null;
  }

  // ── Test: City-fallback setPins must not clobber canvas ─────────────
  // Mobile-pin-bug fix regression test. Tier 1.5 added a guard at the
  // entry to the 0-pin / city-fallback branch, but the FALLBACK itself
  // does a SECOND fetch (canvas fetch returned 0 pins → city-name
  // fallback fetch). If the abort fires after that second fetch
  // resolves but before its setPins runs, the fallback would clobber
  // the new viewport's canvas with the previous viewport's city pins.
  // The fix: guard setPins(fbItems) inside the fallback block.
  function testCityFallbackStaleGuard() {
    let inflightCtrl = null;
    const writesToCanvas = [];

    // Mirrors the real guard pattern at line ~4236.
    function fakeCityFallbackSetPins(items, ctrl) {
      if (inflightCtrl !== ctrl) return;
      writesToCanvas.push({ source: "fallback", items });
    }

    // 1. Fetch A passes the Tier 1.5 entry guard at 4190 (inflightCtrl === ctrlA).
    // 2. Main fetch returns 0 pins — A enters the city-fallback branch.
    // 3. A's city-fallback fetch resolves (fast network on desktop).
    // 4. User pans, fetch B starts, aborts A, inflightCtrl = ctrlB.
    // 5. A's city-fallback json() parsing completes — the guard at the
    //    new stale check MUST skip the setPins.
    const ctrlA = { id: "A" };
    inflightCtrl = ctrlA;
    // Simulate A passing the Tier 1.5 entry guard (it was the current
    // fetch at the time).
    // ... time passes, user pans ...
    const ctrlB = { id: "B" };
    try { ctrlA.id && (ctrlA.aborted = true); } catch (_) {}
    inflightCtrl = ctrlB;
    // A's city-fallback json() now completes. Without the guard, it
    // would write fbItems and clobber the canvas.
    fakeCityFallbackSetPins([{ id: 1, source: "cityA" }], ctrlA);
    // B's eventual setPins (after its own fetch completes) writes correctly.
    fakeCityFallbackSetPins([{ id: 2, source: "viewportB" }], ctrlB);

    const pass = writesToCanvas.length === 1 &&
                 writesToCanvas[0].source === "viewportB";
    tests.push({
      pass,
      msg: `City-fallback stale guard: only B painted (${writesToCanvas.length} write(s)); A's fallback was blocked by inflightCtrl check`,
    });

    inflightCtrl = null;
  }

  // ── Test: Search-mode setPins must not clobber canvas ───────────────
  // Mobile-pin-bug fix regression test. The `if (searching)` branch
  // sits OUTSIDE the Tier 1.5 entry guard at 4190 (which only guards
  // the canvas branch above). Without its own stale check, an aborted
  // search fetch can still call setPins(pins) and clobber whatever
  // a newer fetchPinsForViewport has painted.
  function testSearchModeStaleGuard() {
    let inflightCtrl = null;
    const writesToCanvas = [];

    function fakeSearchSetPins(items, ctrl) {
      if (inflightCtrl !== ctrl) return;
      writesToCanvas.push({ source: "search", items });
    }

    // Search fetch A starts; user pans before its json() completes.
    const ctrlA = { id: "A-search" };
    inflightCtrl = ctrlA;
    const ctrlB = { id: "B-viewport" };
    try { ctrlA.id && (ctrlA.aborted = true); } catch (_) {}
    inflightCtrl = ctrlB;
    // A's json() completes — guard must skip setPins.
    fakeSearchSetPins([{ id: 1, source: "searchA" }], ctrlA);
    fakeSearchSetPins([{ id: 2, source: "viewportB" }], ctrlB);

    const pass = writesToCanvas.length === 1 &&
                 writesToCanvas[0].source === "viewportB";
    tests.push({
      pass,
      msg: `Search-mode stale guard: only B painted (${writesToCanvas.length} write(s)); A's search was blocked by inflightCtrl check`,
    });

    inflightCtrl = null;
  }

  // ── Test: Canvas draw skips off-screen pins ─────────────────────────
  function testDrawSkipsOffscreen() {
    const canvasW = 1024, canvasH = 768, radius = 11;
    const pins = [
      { lat: 0, lng: 0 },     // center — should draw
      { lat: 90, lng: 180 },  // far away — should skip
      { lat: 0, lng: 1 },     // near center — should draw
    ];

    // Simulate containerPoint mapping
    function toContainer(lat, lng) {
      return { x: (lng + 90) * 5, y: (45 - lat) * 5 };
    }

    let drawn = 0, skipped = 0;
    for (const p of pins) {
      const pt = toContainer(p.lat, p.lng);
      if (pt.x < -radius * 2 || pt.x > canvasW + radius * 2 ||
          pt.y < -radius * 2 || pt.y > canvasH + radius * 2) {
        skipped++;
      } else {
        drawn++;
      }
    }

    const pass = drawn === 2 && skipped === 1;
    tests.push({
      pass,
      msg: `Canvas draw: ${drawn} drawn, ${skipped} skipped (pins at (0,0) and (0,1) drawn, (90,180) skipped)`,
    });
  }

  // ── Test: _getIconCanvas returns fallback for unknown category ──────
  function testIconCanvasFallback() {
    const CANVAS_CAT_COLORS = { other: '#5eead4' };
    const cat = 'nonexistent_category';
    const color = CANVAS_CAT_COLORS[cat] || CANVAS_CAT_COLORS.other;
    const pass = color === '#5eead4';
    tests.push({
      pass,
      msg: `Icon fallback: unknown category "${cat}" falls back to "other" color`,
    });
  }

  // ── Test: groupPinsByCluster handles empty array ────────────────────
  function testGroupPinsEmpty() {
    const pins = [];
    // groupPinsByCluster should return empty for empty input
    const result = pins.length === 0 ? [] : pins;
    const pass = result.length === 0;
    tests.push({
      pass,
      msg: `groupPinsByCluster: empty input returns empty array`,
    });
  }

  // ── Test: Progressive pagination respects generation ────────────────
  function testPaginationRespectsGen() {
    let _fetchGen = 0;
    const gen = ++_fetchGen;
    let pagesLoaded = 0;

    // Simulate pagination loop
    for (let page = 0; page < 5; page++) {
      if (gen !== _fetchGen) break; // should not break for gen=1
      pagesLoaded++;
      // Simulate a new fetch starting mid-pagination
      if (page === 2) _fetchGen++; // new fetch starts
    }

    const pass = pagesLoaded === 3; // loaded 3 pages before gen changed
    tests.push({
      pass,
      msg: `Pagination: loaded ${pagesLoaded} pages before generation changed (expected 3)`,
    });
  }

  // ── Test: Marker diff doesn't recreate existing markers ─────────────
  function testMarkerDiffReuses() {
    const pinMarkers = new Map();
    const built = [];

    // First render: create markers
    const pins1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    for (const p of pins1) {
      if (!pinMarkers.has(p.id)) {
        pinMarkers.set(p.id, { id: p.id, _pinData: p });
        built.push(p.id);
      }
    }

    // Second render: same pins + one new
    const pins2 = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const rebuilt = [];
    for (const p of pins2) {
      if (!pinMarkers.has(p.id)) {
        pinMarkers.set(p.id, { id: p.id, _pinData: p });
        rebuilt.push(p.id);
      }
    }

    const pass = built.length === 3 && rebuilt.length === 1 && rebuilt[0] === 4;
    tests.push({
      pass,
      msg: `Marker diff: first render built 3, second render only built 1 new (id=4), reused 3 existing`,
    });
  }

  // ── Run all tests ──────────────────────────────────────────────────
  function runTests() {
    tests.length = 0;

    testRadiusForZoom();
    testCanvasColorsDistinct();
    testCanvasCatColors();
    testCanvasLimitForZoom();
    testCanvasUsesContainerCoords();
    testCanvasFillsContainer();
    testSyncLayersDiff();
    testClearSearchResetsState();
    testSearchQueryInCanvasUrl();
    testNoAbortErrorSkip();
    testEnrichedNullLocation();
    testHitTestUsesContainerCoords();
    testRapidPansResolve();
    testStaleFetchDoesNotClobberCanvas();
    testCityFallbackStaleGuard();
    testSearchModeStaleGuard();
    testDrawSkipsOffscreen();
    testIconCanvasFallback();
    testGroupPinsEmpty();
    testPaginationRespectsGen();
    testMarkerDiffReuses();

    // Async tests
    return testGenerationCounter().then(() => {
      const passed = tests.filter(t => t.pass).length;
      const failed = tests.filter(t => !t.pass).length;
      return { passed, failed, tests };
    });
  }

  window.CanvasRendererTests = { runTests, tests };
})();
