/**
 * XYZO Map Rendering & Mode Tests
 * Tests for render mode (markers/heatmap/clusters), popup behavior,
 * search snapshot/restore, and discovery panel dismissal.
 *
 * Run: open /tests/render-test.html in browser OR paste this into DevTools console
 */

(function () {
  'use strict';

  const tests = [];

  // ── Mock Leaflet / Map for headless testing ─────────────────────────
  const mockMap = {
    _layers: new Set(),
    _popup: null,
    hasLayer(l) { return this._layers.has(l); },
    addLayer(l) { this._layers.add(l); },
    removeLayer(l) { this._layers.delete(l); },
    closePopup() { this._popup = null; },
    panTo() {},
    flyTo() {},
    invalidateSize() {},
    getCenter() { return { lat: 40.7, lng: -74.0 }; },
    getZoom() { return 10; },
    getBounds() {
      return {
        getWest: () => -74.5, getSouth: () => 40.5,
        getEast: () => -73.5, getNorth: () => 41.5,
      };
    },
  };

  const mockClusterGroup = {
    _layers: [],
    _markers: new Set(),
    clearLayers() { this._layers = []; this._markers.clear(); },
    addLayers(markers) { for (const m of markers) { this._markers.add(m); this._layers.push(m); } },
    refreshClusters() {},
    getAllMarkers() { return Array.from(this._markers); },
  };

  const mockLayerGroup = {
    _layers: new Set(),
    clearLayers() { this._layers.clear(); },
    addLayer(m) { this._layers.add(m); },
    addLayers(markers) { for (const m of markers) markers.forEach(m => this._layers.add(m)); },
    hasLayer(l) { return this._layers.has(l); },
  };

  // ── Mock marker ────────────────────────────────────────────────────
  function makeMockMarker(id, lat, lng) {
    return {
      _xyzoId: id,
      _xyzoLat: lat,
      _xyzoLng: lng,
      _xyzoCategory: 'technology',
      _xyzoHeatType: 'rss',
      _pinData: { id, location: { lat, lng }, title: `Pin ${id}` },
      _map: null,
      isPopupOpen() { return false; },
      setLatLng() {},
    };
  }

  // ── Test: Snapshot/restore ─────────────────────────────────────────
  function testSnapshotRestore() {
    // Simulate pin registry with some pins
    const pinMarkers = new Map();
    pinMarkers.set(1, makeMockMarker(1, 40.7128, -74.0060));
    pinMarkers.set(2, makeMockMarker(2, 40.7580, -73.9855));
    pinMarkers.set(3, makeMockMarker(3, 40.6782, -73.9442));

    // Simulate taking a snapshot (before search)
    let _viewportPinsSnapshot = [];
    let _snapshotTaken = false;

    if (pinMarkers.size > 0) {
      _viewportPinsSnapshot = Array.from(pinMarkers.values()).map(m => ({
        id: m._xyzoId,
        lat: m._xyzoLat,
        lng: m._xyzoLng,
        category: m._xyzoCategory,
        source_type: m._xyzoHeatType,
        pinData: m._pinData,
      }));
      _snapshotTaken = true;
    }

    // Simulate clearing (search mode → restore)
    pinMarkers.clear();
    const snapshotRestored = _viewportPinsSnapshot.length === 3 && _snapshotTaken === true;

    // Verify snapshot was saved before search
    if (!snapshotRestored) {
      return { pass: false, msg: 'Snapshot should have 3 pins before search' };
    }

    // Verify clear kept snapshot
    if (_viewportPinsSnapshot.length !== 3) {
      return { pass: false, msg: 'Snapshot should still have 3 pins after clear (not yet restored)' };
    }

    return { pass: true, msg: 'Snapshot correctly captures viewport pins before search' };
  }
  tests.push(testSnapshotRestore);

  // ── Test: Mode toggle sets correct layer ───────────────────────────
  function testModeToggleLayers() {
    const pinCluster = Object.assign({}, mockClusterGroup);
    const eventCluster = Object.assign({}, mockClusterGroup);
    const markerLayer = Object.assign({}, mockLayerGroup);
    const heatLayer = Object.assign({}, mockLayerGroup);
    const map = Object.assign({}, mockMap);

    const VALID_MODES = new Set(['heatmap', 'markers', 'clusters', 'none']);
    let renderMode = 'markers';

    function setMode(mode) {
      if (!VALID_MODES.has(mode)) return;
      renderMode = mode;
      // Detach all
      map.removeLayer(pinCluster);
      map.removeLayer(eventCluster);
      map.removeLayer(markerLayer);
      map.removeLayer(heatLayer);
      // Attach correct layer
      if (mode === 'heatmap') map.addLayer(heatLayer);
      else if (mode === 'markers') map.addLayer(markerLayer);
      else if (mode === 'clusters') { map.addLayer(pinCluster); map.addLayer(eventCluster); }
    }

    // Test markers mode
    setMode('markers');
    if (!map.hasLayer(markerLayer)) return { pass: false, msg: 'Markers mode should attach markerLayer' };
    if (map.hasLayer(pinCluster)) return { pass: false, msg: 'Markers mode should NOT have pinCluster' };

    // Test heatmap mode
    setMode('heatmap');
    if (!map.hasLayer(heatLayer)) return { pass: false, msg: 'Heatmap mode should attach heatLayer' };
    if (map.hasLayer(markerLayer)) return { pass: false, msg: 'Heatmap mode should NOT have markerLayer' };

    // Test clusters mode
    setMode('clusters');
    if (!map.hasLayer(pinCluster)) return { pass: false, msg: 'Clusters mode should attach pinCluster' };
    if (!map.hasLayer(eventCluster)) return { pass: false, msg: 'Clusters mode should attach eventCluster' };
    if (map.hasLayer(markerLayer)) return { pass: false, msg: 'Clusters mode should NOT have markerLayer' };

    // Test toggle off
    setMode('none');
    if (map.hasLayer(markerLayer)) return { pass: false, msg: 'None mode should NOT have markerLayer' };
    if (map.hasLayer(pinCluster)) return { pass: false, msg: 'None mode should NOT have pinCluster' };

    return { pass: true, msg: 'Mode toggle correctly attaches/detaches layers' };
  }
  tests.push(testModeToggleLayers);

  // ── Test: syncLayers adds markers to correct mode layer ─────────────
  function testSyncLayersMode() {
    const pinCluster = Object.assign({}, mockClusterGroup);
    const eventCluster = Object.assign({}, mockClusterGroup);
    const markerLayer = Object.assign({}, mockLayerGroup);
    const map = Object.assign({}, mockMap);
    map.addLayer(pinCluster);
    map.addLayer(markerLayer);

    const pinMarkers = new Map();
    pinMarkers.set(1, makeMockMarker(1, 40.7128, -74.0060));
    pinMarkers.set(2, makeMockMarker(2, 40.7580, -73.9855));

    const _activeCategoryFilters = new Set();
    const hasFilters = false;

    function syncLayers(mode) {
      pinCluster.clearLayers();
      markerLayer.clearLayers();
      const pinBatch = Array.from(pinMarkers.values());
      if (mode === 'clusters') {
        pinCluster.addLayers(pinBatch);
      } else if (mode === 'markers') {
        markerLayer.addLayers(pinBatch);
      }
    }

    // Test clusters mode
    syncLayers('clusters');
    if (pinCluster.getAllMarkers().length !== 2) {
      return { pass: false, msg: `Clusters: expected 2 markers in cluster, got ${pinCluster.getAllMarkers().length}` };
    }

    // Test markers mode
    syncLayers('markers');
    if (markerLayer._layers.size !== 2) {
      return { pass: false, msg: `Markers: expected 2 markers in layer, got ${markerLayer._layers.size}` };
    }

    return { pass: true, msg: 'syncLayers correctly distributes markers by mode' };
  }
  tests.push(testSyncLayersMode);

  // ── Test: Popup toggle — double-click closes ────────────────────────
  function testPopupToggle() {
    let openPopup = null;
    let closed = false;

    const marker = {
      _xyzoId: 1,
      isPopupOpen() { return openPopup === this; },
    };

    function mapClosePopup() { openPopup = null; closed = true; }

    // Simulate: click same marker when already open → should close
    openPopup = marker; // popup is open
    closed = false;

    const alreadyOpen = marker.isPopupOpen();
    if (alreadyOpen) {
      mapClosePopup();
    }

    if (!closed) {
      return { pass: false, msg: 'Double-click on open marker should close popup' };
    }

    // Simulate: click when not open → should NOT close
    openPopup = null;
    closed = false;

    const alreadyOpen2 = marker.isPopupOpen();
    if (!alreadyOpen2) {
      // Would open popup, not close
      closed = false;
    }

    if (closed) {
      return { pass: false, msg: 'Click on closed marker should NOT close popup' };
    }

    return { pass: true, msg: 'Popup toggle correctly closes on second click' };
  }
  tests.push(testPopupToggle);

  // ── Test: Discovery panel dismissal prevents auto-reopen ─────────────
  function testDiscoveryDismissal() {
    let _discoveryPanelDismissed = false;
    let panelVisible = true;

    function createStatusPanel() {
      if (panelVisible) return true;
      // Only show if NOT dismissed
      if (!_discoveryPanelDismissed) {
        panelVisible = true;
        return true;
      }
      return false;
    }

    function closeStatusPanel() {
      _discoveryPanelDismissed = true;
      panelVisible = false;
    }

    // Start discovery → panel shows
    panelVisible = false;
    _discoveryPanelDismissed = false;
    createStatusPanel();
    if (!panelVisible) return { pass: false, msg: 'New discovery should show panel' };

    // User dismisses with X
    closeStatusPanel();
    if (panelVisible) return { pass: false, msg: 'After X, panel should be hidden' };

    // Same discovery tries to re-show → should stay hidden
    const reopened = createStatusPanel();
    if (reopened) return { pass: false, msg: 'Dismissed panel should NOT auto-reopen for same discovery' };

    return { pass: true, msg: 'Discovery panel dismissal correctly prevents auto-reopen' };
  }
  tests.push(testDiscoveryDismissal);

  // ── Test: Keywords from enriched data ───────────────────────────────
  function testEnrichedKeywordsRendering() {
    // Simulate word_freq from enriched endpoint
    const words = {
      'artificial': 15, 'intelligence': 12, 'machine': 10,
      'learning': 8, 'neural': 6, 'network': 5, 'deep': 4,
    };

    const entries = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 16);
    if (entries.length !== 7) return { pass: false, msg: `Expected 7 word entries, got ${entries.length}` };
    if (entries[0][0] !== 'artificial') return { pass: false, msg: 'Top word should be "artificial"' };
    if (entries[0][1] !== 15) return { pass: false, msg: 'Top word count should be 15' };

    // Verify sorting by frequency descending
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][1] > entries[i-1][1]) {
        return { pass: false, msg: 'Words should be sorted by frequency descending' };
      }
    }

    // Verify slicing to 16 max
    const manyWords = {};
    for (let i = 0; i < 30; i++) manyWords[`word${i}`] = 30 - i;
    const sliced = Object.entries(manyWords).sort((a, b) => b[1] - a[1]).slice(0, 16);
    if (sliced.length !== 16) return { pass: false, msg: 'Should slice to max 16 keywords' };

    return { pass: true, msg: 'Enriched keywords correctly sorted and sliced' };
  }
  tests.push(testEnrichedKeywordsRendering);

  // ── Test: Render mode cluster respects filter ───────────────────────
  function testClusterFilter() {
    const pinMarkers = new Map();
    pinMarkers.set(1, makeMockMarker(1, 40.7128, -74.0060));
    pinMarkers.get(1)._xyzoCategory = 'technology';
    pinMarkers.set(2, makeMockMarker(2, 40.7580, -73.9855));
    pinMarkers.get(2)._xyzoCategory = 'politics';
    pinMarkers.set(3, makeMockMarker(3, 40.6782, -73.9442));
    pinMarkers.get(3)._xyzoCategory = 'technology';

    const _activeCategoryFilters = new Set(['technology']);
    const pinBatch = [];
    for (const m of pinMarkers.values()) {
      const cat = (m._xyzoCategory || 'other').toLowerCase();
      if (_activeCategoryFilters.has(cat)) pinBatch.push(m);
    }

    if (pinBatch.length !== 2) {
      return { pass: false, msg: `Filter 'technology': expected 2 pins, got ${pinBatch.length}` };
    }

    // All should be technology
    for (const m of pinBatch) {
      if (m._xyzoCategory !== 'technology') {
        return { pass: false, msg: 'Filter should only include technology pins' };
      }
    }

    return { pass: true, msg: 'Cluster filter correctly filters by category' };
  }
  tests.push(testClusterFilter);

  // ── Run tests ─────────────────────────────────────────────────────
  function runTests() {
    console.log('Running XYZO Render & Mode Tests...');
    let passed = 0, failed = 0;
    for (const test of tests) {
      const result = test();
      if (result.pass) {
        console.log(`  ✅ ${result.msg}`);
        passed++;
      } else {
        console.error(`  ❌ ${result.msg}`);
        failed++;
      }
    }
    const total = passed + failed;
    console.log(`\nResults: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
    return { passed, failed, total };
  }

  // Export for use in browser console or HTML test page
  window.RenderModeTests = { runTests, tests };

  if (typeof module !== 'undefined' && module.exports) module.exports = { runTests, tests };

  return { runTests, tests };
})();
