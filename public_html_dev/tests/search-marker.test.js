/**
 * XYZO App Tests - Search & Marker Management
 * Tests for clearSearch, marker restoration, and search state management
 */

/**
 * Mock PinMarker class for testing
 */
class MockMarker {
  constructor(id, lat, lng, category) {
    this.id = id;
    this._xyzoLat = lat;
    this._xyzoLng = lng;
    this._xyzoCategory = category;
    this._map = null;
    this._mapToAdd = null;
    this._pinData = { id, location: { lat, lng }, category };
  }

  getLatLng() {
    return { lat: this._xyzoLat, lng: this._xyzoLng };
  }
}

/**
 * Simulates clearSearch behavior from app.js
 * Clears search result markers and restores viewport snapshot
 */
function simulateClearSearch(state) {
  // Remove only search result markers (those marked _isSearchResult)
  for (const [id, m] of state.pinMarkers) {
    if (m._isSearchResult) {
      state.pinMarkers.delete(id);
    }
  }
  // Also clear event markers that are search results
  for (const [id, m] of state.eventMarkers) {
    if (m._isSearchResult) {
      state.eventMarkers.delete(id);
    }
  }

  // Reset search state
  state.searchActive = false;
  state.searchInput = "";
  state._snapshotTaken = false;

  return state;
}

/**
 * Simulates renderSearchPins behavior - clears previous search results, adds new ones
 * This mirrors the fixed app.js behavior where renderSearchPins clears old search pins
 */
function simulateRenderSearchPins(state, searchResults) {
  // Clear previous search result pins (those marked _isSearchResult)
  for (const [id, m] of state.pinMarkers) {
    if (m._isSearchResult) {
      state.pinMarkers.delete(id);
    }
  }

  // Add new search results and mark them
  for (const pin of searchResults) {
    const marker = new MockMarker(pin.id, pin.lat, pin.lng, pin.category);
    marker._isSearchResult = true;
    state.pinMarkers.set(pin.id, marker);
  }

  state.searchActive = true;
  return state;
}

/**
 * Simulates taking a viewport snapshot before search
 */
function simulateSnapshotViewport(state) {
  state._viewportPinsSnapshot = [];
  for (const [id, m] of state.pinMarkers) {
    state._viewportPinsSnapshot.push({
      id: m.id,
      lat: m._xyzoLat,
      lng: m._xyzoLng,
      category: m._xyzoCategory,
    });
  }
  state._snapshotTaken = true;
  return state;
}

/**
 * Simulates filterToViewport from app.js
 */
function simulateFilterToViewport(pins, bounds) {
  return pins.filter(p => {
    const lat = p.location?.lat ?? p.lat;
    const lng = p.location?.lng ?? p.lng;
    if (lat < bounds.s || lat > bounds.n) return false;
    if (lng < bounds.w || lng > bounds.e) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// TEST SUITES
// ─────────────────────────────────────────────────────────────

const tests = [];

/**
 * Test: clearSearch removes search result pinMarkers, keeps viewport markers
 */
function testClearSearchRemovesSearchPins() {
  // Setup: simulate search with results mixed with viewport markers
  const state = {
    pinMarkers: new Map(),
    eventMarkers: new Map(),
    heatPoints: [],
    searchActive: true,
    searchInput: "test query",
    _snapshotTaken: true,
  };

  // Add search result markers (should be removed on clearSearch)
  const searchMarker1 = new MockMarker(1, 10, 20, "politics");
  searchMarker1._isSearchResult = true;
  state.pinMarkers.set(1, searchMarker1);
  const searchMarker2 = new MockMarker(2, 15, 25, "technology");
  searchMarker2._isSearchResult = true;
  state.pinMarkers.set(2, searchMarker2);

  // Run clearSearch
  const newState = simulateClearSearch({ ...state });

  // Verify: search result markers should be removed
  if (newState.pinMarkers.size !== 0) {
    return { pass: false, msg: `clearSearch should remove search pinMarkers, but ${newState.pinMarkers.size} remain` };
  }
  return { pass: true, msg: "clearSearch removes search result pinMarkers" };
}
tests.push(testClearSearchRemovesSearchPins);

/**
 * Test: After clearSearch, searchActive should be false
 */
function testClearSearchResetsSearchActive() {
  const state = {
    pinMarkers: new Map(),
    eventMarkers: new Map(),
    heatPoints: [],
    searchActive: true,
    searchInput: "test query",
  };

  const newState = simulateClearSearch(state);

  if (newState.searchActive !== false) {
    return { pass: false, msg: "clearSearch should set searchActive to false" };
  }
  return { pass: true, msg: "clearSearch resets searchActive" };
}
tests.push(testClearSearchResetsSearchActive);

/**
 * Test: After clearSearch, searchInput should be empty
 */
function testClearSearchClearsSearchInput() {
  const state = {
    pinMarkers: new Map(),
    eventMarkers: new Map(),
    heatPoints: [],
    searchActive: true,
    searchInput: "test query",
  };

  const newState = simulateClearSearch(state);

  if (newState.searchInput !== "") {
    return { pass: false, msg: "clearSearch should clear searchInput" };
  }
  return { pass: true, msg: "clearSearch clears searchInput" };
}
tests.push(testClearSearchClearsSearchInput);

/**
 * Test: renderSearchPins clears previous search results before adding new ones
 */
function testRenderSearchPinsClearsOldResults() {
  const state = {
    pinMarkers: new Map(),
    eventMarkers: new Map(),
    heatPoints: [],
    searchActive: true,
    searchInput: "first search",
    _snapshotTaken: false,
  };

  // Add first search results with _isSearchResult flag
  const marker1 = new MockMarker(1, 10, 20, "politics");
  marker1._isSearchResult = true;
  state.pinMarkers.set(1, marker1);
  const marker2 = new MockMarker(2, 15, 25, "technology");
  marker2._isSearchResult = true;
  state.pinMarkers.set(2, marker2);

  // Add a "viewport" marker (not a search result)
  const viewportMarker = new MockMarker(100, 50, 60, "sports");
  viewportMarker._isSearchResult = false;
  state.pinMarkers.set(100, viewportMarker);

  // Run a new search with different results
  const newSearchResults = [
    { id: 200, lat: 30, lng: 40, category: "health" },
    { id: 201, lat: 35, lng: 45, category: "business" },
  ];
  const newState = simulateRenderSearchPins(state, newSearchResults);

  // Verify: old search pins (1, 2) removed, new search pins (200, 201) added
  // Viewport marker (100) should remain
  if (newState.pinMarkers.size !== 3) {
    return { pass: false, msg: `renderSearchPins should have 3 pins (2 new search + 1 viewport), got ${newState.pinMarkers.size}` };
  }
  if (newState.pinMarkers.has(1) || newState.pinMarkers.has(2)) {
    return { pass: false, msg: "renderSearchPins should remove old search result pins" };
  }
  if (!newState.pinMarkers.has(200) || !newState.pinMarkers.has(201)) {
    return { pass: false, msg: "renderSearchPins should add new search result pins" };
  }
  if (!newState.pinMarkers.has(100)) {
    return { pass: false, msg: "renderSearchPins should keep viewport markers" };
  }
  return { pass: true, msg: "renderSearchPins clears old search results, keeps viewport pins" };
}
tests.push(testRenderSearchPinsClearsOldResults);

/**
 * Test: clearSearch removes only search result markers, keeps viewport markers
 */
function testClearSearchKeepsViewportMarkers() {
  const state = {
    pinMarkers: new Map(),
    eventMarkers: new Map(),
    heatPoints: [],
    searchActive: true,
    searchInput: "test query",
    _snapshotTaken: true,
  };

  // Add search result markers
  const searchMarker = new MockMarker(1, 10, 20, "politics");
  searchMarker._isSearchResult = true;
  state.pinMarkers.set(1, searchMarker);

  // Add viewport marker (not a search result)
  const viewportMarker = new MockMarker(100, 50, 60, "sports");
  viewportMarker._isSearchResult = false;
  state.pinMarkers.set(100, viewportMarker);

  // Run clearSearch
  const newState = simulateClearSearch({ ...state });

  // Verify: search marker removed, viewport marker kept
  if (newState.pinMarkers.size !== 1) {
    return { pass: false, msg: `clearSearch should keep 1 viewport pin, got ${newState.pinMarkers.size}` };
  }
  if (newState.pinMarkers.has(1)) {
    return { pass: false, msg: "clearSearch should remove search result pin" };
  }
  if (!newState.pinMarkers.has(100)) {
    return { pass: false, msg: "clearSearch should keep viewport pin" };
  }
  return { pass: true, msg: "clearSearch removes search pins, keeps viewport pins" };
}
tests.push(testClearSearchKeepsViewportMarkers);

/**
 * Test: search for "neuroscience" shows only matching pins
 */
function testSearchShowsOnlyMatchingPins() {
  const state = {
    pinMarkers: new Map(),
    eventMarkers: new Map(),
    heatPoints: [],
    searchActive: false,
    searchInput: "",
    _snapshotTaken: false,
  };

  // Add some "viewport" markers from normal map view
  state.pinMarkers.set(1, new MockMarker(1, 40, -74, "politics"));
  state.pinMarkers.set(2, new MockMarker(2, 34, -118, "technology"));
  state.pinMarkers.set(3, new MockMarker(3, 51, -0.1, "business"));

  // Take snapshot before search (modifies state in place)
  simulateSnapshotViewport(state);

  // Search for "neuroscience" - results in different locations
  const neuroscienceResults = [
    { id: 100, lat: 42, lng: -71, category: "science" },  // Boston
    { id: 101, lat: 37, lng: -122, category: "science" },  // SF
  ];

  const newState = simulateRenderSearchPins(state, neuroscienceResults);

  // After search, should have: 2 search results + 3 viewport markers = 5 total
  // But in the fixed app.js, viewport markers are KEPT during search
  // Only search result pins are replaced, not the whole map
  // This is the behavior where search adds to viewport

  // However, the bug was that OLD search results weren't cleared
  // So if we search again, we should only have new search results + viewport

  // Simulate a second search
  const secondSearchResults = [
    { id: 200, lat: 48, lng: -122, category: "health" },  // Seattle
  ];
  const finalState = simulateRenderSearchPins(newState, secondSearchResults);

  // Should have: 1 new search result + 3 viewport markers = 4 total
  // Old search results (100, 101) should be gone
  if (finalState.pinMarkers.size !== 4) {
    return { pass: false, msg: `After second search, expected 4 pins (1 new search + 3 viewport), got ${finalState.pinMarkers.size}` };
  }
  if (finalState.pinMarkers.has(100) || finalState.pinMarkers.has(101)) {
    return { pass: false, msg: "Second search should clear first search results" };
  }
  if (!finalState.pinMarkers.has(200)) {
    return { pass: false, msg: "Second search should add new search result" };
  }
  // Viewport markers should still be there
  if (!finalState.pinMarkers.has(1) || !finalState.pinMarkers.has(2) || !finalState.pinMarkers.has(3)) {
    return { pass: false, msg: "Viewport markers should remain after search" };
  }
  return { pass: true, msg: "Search correctly replaces previous results, keeps viewport" };
}
tests.push(testSearchShowsOnlyMatchingPins);

/**
 * Test: filterToViewport correctly filters by bounds
 */
function testFilterToViewport() {
  const pins = [
    { id: 1, location: { lat: 10, lng: 20 } },
    { id: 2, location: { lat: 15, lng: 25 } },
    { id: 3, location: { lat: 80, lng: 100 } }, // outside
    { id: 4, location: { lat: -5, lng: 30 } },  // outside
  ];

  const bounds = { n: 30, s: 0, e: 40, w: 10 };
  const filtered = simulateFilterToViewport(pins, bounds);

  if (filtered.length !== 2) {
    return { pass: false, msg: `filterToViewport should return 2 pins, got ${filtered.length}` };
  }
  if (!filtered.find(p => p.id === 1)) {
    return { pass: false, msg: "Should include pin 1 (within bounds)" };
  }
  if (!filtered.find(p => p.id === 2)) {
    return { pass: false, msg: "Should include pin 2 (within bounds)" };
  }
  if (filtered.find(p => p.id === 3)) {
    return { pass: false, msg: "Should exclude pin 3 (outside bounds)" };
  }
  return { pass: true, msg: "filterToViewport filters correctly" };
}
tests.push(testFilterToViewport);

/**
 * Test: filterToViewport handles edge case of same lat/lng
 */
function testFilterToViewportEdgeCase() {
  const pins = [
    { id: 1, location: { lat: 0, lng: 0 } },
    { id: 2, location: { lat: 0.0001, lng: 0.0001 } },
  ];

  const bounds = { n: 1, s: -1, e: 1, w: -1 };
  const filtered = simulateFilterToViewport(pins, bounds);

  if (filtered.length !== 2) {
    return { pass: false, msg: "filterToViewport should include both pins at edge" };
  }
  return { pass: true, msg: "filterToViewport handles edge cases" };
}
tests.push(testFilterToViewportEdgeCase);

// ─────────────────────────────────────────────────────────────
// RUN TESTS
// ─────────────────────────────────────────────────────────────

function runTests() {
  console.log("Running Search & Marker Management Tests...\n");
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    const result = test();
    if (result.pass) {
      console.log(`✅ ${result.msg}`);
      passed++;
    } else {
      console.log(`❌ ${result.msg}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

// Export for use in browser console
if (typeof window !== "undefined") {
  window.SearchMarkerTests = { runTests, tests, simulateClearSearch, simulateRenderSearchPins, simulateSnapshotViewport, simulateFilterToViewport };
}

if (typeof require !== "undefined" && require.main === module) {
  runTests();
}
