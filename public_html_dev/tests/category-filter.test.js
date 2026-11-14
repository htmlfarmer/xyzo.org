/**
 * XYZO App Tests - Category Filtering
 * Tests for CATEGORY_ROLLUPS, filter matching, and localStorage persistence
 */

// Mock CATEGORY_ROLLUPS (same as in app.js)
const CATEGORY_ROLLUPS = {
  tech: ["technology", "ai", "cybersecurity", "gaming", "telecom"],
  technology: ["ai", "cybersecurity", "gaming", "telecom"],
  politics: ["elections", "courts", "policy", "diplomacy", "protest"],
  business: ["markets", "banking", "crypto", "realestate", "labor"],
  crime: ["shooting", "terrorism", "cybercrime", "missing", "traffic"],
  weather: ["storm", "floods", "wildfire", "drought", "snow", "heatwave"],
  science: ["space", "biology", "physics", "research"],
  sports: ["soccer", "basketball", "olympics", "racing"],
  culture: ["music", "film", "art", "books"],
  environment: ["climate", "wildlife", "pollution", "energy"],
  health: ["outbreak", "medical", "mental_health"],
  conflict: ["war", "military"],
  disaster: ["earthquake", "volcano"],
  humanitarian: ["refugees", "aid"],
};

// Mock LEGEND_GROUPS keys
const LEGEND_KEYS = [
  "rss", "editorial", "community", "other",
  "politics", "business", "crime", "conflict", "weather", "science",
  "technology", "sports", "culture", "environment", "disaster", "humanitarian", "health",
  "elections", "courts", "policy", "diplomacy", "protest",
  "markets", "banking", "crypto", "realestate", "labor",
  "shooting", "terrorism", "cybercrime", "missing", "traffic",
  "storm", "floods", "wildfire", "drought", "snow", "heatwave",
  "space", "biology", "physics", "research",
  "ai", "cybersecurity", "gaming", "telecom",
  "soccer", "basketball", "olympics", "racing",
  "music", "film", "art", "books",
  "climate", "wildlife", "pollution", "energy",
  "outbreak", "medical", "mental_health",
  "war", "military", "earthquake", "volcano", "refugees", "aid",
];

/**
 * Simulates the matchesFilter logic from app.js syncLayers()
 */
function matchesFilter(markerCategory, activeFilters) {
  if (activeFilters.size === 0) return true;
  const cat = (markerCategory || "other").toLowerCase();
  if (activeFilters.has(cat)) return true;
  for (const f of activeFilters) {
    const fl = f.toLowerCase();
    if (fl === cat) return true;
    if ((fl === "tech" || fl === "technology") && (cat === "tech" || cat === "technology" || cat === "ai" || cat === "cybersecurity" || cat === "gaming" || cat === "telecom")) return true;
    const rollup = CATEGORY_ROLLUPS[fl];
    if (rollup && rollup.includes(cat)) return true;
  }
  return false;
}

/**
 * Simulates loadCategoryFilters with validation from app.js
 */
function loadCategoryFilters(raw) {
  const validKeys = new Set(LEGEND_KEYS);
  const filters = new Set();
  try {
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const k of arr) {
          const lower = String(k).toLowerCase();
          if (validKeys.has(lower)) {
            filters.add(lower);
          }
        }
      }
    }
  } catch (_) {}
  return filters;
}

/**
 * Simulates toggleCategoryFilter from app.js (lowercases key)
 */
function toggleCategoryFilter(key, filters) {
  const lowerKey = key.toLowerCase();
  if (filters.has(lowerKey)) {
    filters.delete(lowerKey);
  } else {
    filters.add(lowerKey);
  }
  return filters;
}

// ─────────────────────────────────────────────────────────────
// TEST SUITES
// ─────────────────────────────────────────────────────────────

const tests = [];

/**
 * Test: CATEGORY_ROLLUPS contains all expected mappings
 */
function testRollupsComplete() {
  const expected = {
    tech: ["technology", "ai", "cybersecurity", "gaming", "telecom"],
    technology: ["ai", "cybersecurity", "gaming", "telecom"],
    politics: ["elections", "courts", "policy", "diplomacy", "protest"],
    business: ["markets", "banking", "crypto", "realestate", "labor"],
  };
  for (const [key, subs] of Object.entries(expected)) {
    const actual = CATEGORY_ROLLUPS[key];
    if (!actual || actual.length !== subs.length) {
      return { pass: false, msg: `CATEGORY_ROLLUPS['${key}'] mismatch` };
    }
  }
  return { pass: true, msg: "CATEGORY_ROLLUPS is complete" };
}
tests.push(testRollupsComplete);

/**
 * Test: loadCategoryFilters validates against LEGEND_KEYS
 */
function testLoadFiltersValidatesKeys() {
  // Invalid key should be rejected
  const filters = loadCategoryFilters(JSON.stringify(["invalid_category_xyz", "politics"]));
  if (filters.has("invalid_category_xyz")) {
    return { pass: false, msg: "Invalid keys should be rejected" };
  }
  if (!filters.has("politics")) {
    return { pass: false, msg: "Valid keys should be accepted" };
  }
  return { pass: true, msg: "loadCategoryFilters validates keys correctly" };
}
tests.push(testLoadFiltersValidatesKeys);

/**
 * Test: loadCategoryFilters lowercases keys
 */
function testLoadFiltersLowercases() {
  const filters = loadCategoryFilters(JSON.stringify(["POLITICS", "Business"]));
  if (!filters.has("politics")) {
    return { pass: false, msg: "Keys should be lowercased" };
  }
  if (!filters.has("business")) {
    return { pass: false, msg: "Keys should be lowercased" };
  }
  return { pass: true, msg: "loadCategoryFilters lowercases keys" };
}
tests.push(testLoadFiltersLowercases);

/**
 * Test: toggleCategoryFilter lowercases key before storing
 */
function testToggleFiltersLowercases() {
  let filters = new Set();
  filters = toggleCategoryFilter("TECH", filters);
  if (!filters.has("tech")) {
    return { pass: false, msg: "toggleCategoryFilter should lowercase key" };
  }
  // Toggle off
  filters = toggleCategoryFilter("tech", filters);
  if (filters.has("tech")) {
    return { pass: false, msg: "toggleCategoryFilter should remove on second call" };
  }
  return { pass: true, msg: "toggleCategoryFilter lowercases correctly" };
}
tests.push(testToggleFiltersLowercases);

/**
 * Test: matchesFilter returns true when no filters active
 */
function testMatchesFilterNoFilters() {
  const filters = new Set();
  const result = matchesFilter("politics", filters);
  if (!result) {
    return { pass: false, msg: "Should return true when no filters active" };
  }
  return { pass: true, msg: "matchesFilter returns true when no filters" };
}
tests.push(testMatchesFilterNoFilters);

/**
 * Test: matchesFilter matches exact category
 */
function testMatchesFilterExact() {
  const filters = new Set(["politics"]);
  if (!matchesFilter("politics", filters)) {
    return { pass: false, msg: "Should match exact category" };
  }
  if (matchesFilter("business", filters)) {
    return { pass: false, msg: "Should not match different category" };
  }
  return { pass: true, msg: "matchesFilter matches exact category" };
}
tests.push(testMatchesFilterExact);

/**
 * Test: matchesFilter uses rollup for parent bucket
 */
function testMatchesFilterRollup() {
  const filters = new Set(["technology"]);
  // AI is in technology's rollup
  if (!matchesFilter("ai", filters)) {
    return { pass: false, msg: "Should match 'ai' via technology rollup" };
  }
  // Gaming is in technology's rollup
  if (!matchesFilter("gaming", filters)) {
    return { pass: false, msg: "Should match 'gaming' via technology rollup" };
  }
  // Politics should NOT match technology
  if (matchesFilter("politics", filters)) {
    return { pass: false, msg: "Should not match unrelated category" };
  }
  return { pass: true, msg: "matchesFilter uses rollup correctly" };
}
tests.push(testMatchesFilterRollup);

/**
 * Test: matchesFilter handles tech/technology alias
 */
function testMatchesFilterTechAlias() {
  const filters = new Set(["tech"]);
  if (!matchesFilter("ai", filters)) {
    return { pass: false, msg: "Should match 'ai' via tech alias" };
  }
  if (!matchesFilter("cybersecurity", filters)) {
    return { pass: false, msg: "Should match 'cybersecurity' via tech alias" };
  }
  return { pass: true, msg: "matchesFilter handles tech/technology alias" };
}
tests.push(testMatchesFilterTechAlias);

/**
 * Test: matchesFilter is case-insensitive
 */
function testMatchesFilterCaseInsensitive() {
  const filters = new Set(["POLITICS"]);
  if (!matchesFilter("politics", filters)) {
    return { pass: false, msg: "Should be case-insensitive (filter stored uppercase)" };
  }
  const filters2 = new Set(["politics"]);
  if (!matchesFilter("POLITICS", filters2)) {
    return { pass: false, msg: "Should be case-insensitive (marker category uppercase)" };
  }
  return { pass: true, msg: "matchesFilter is case-insensitive" };
}
tests.push(testMatchesFilterCaseInsensitive);

/**
 * Test: Multiple filters combined with OR logic
 */
function testMatchesFilterMultiple() {
  const filters = new Set(["politics", "technology"]);
  if (!matchesFilter("politics", filters)) {
    return { pass: false, msg: "Should match first filter" };
  }
  if (!matchesFilter("ai", filters)) {
    return { pass: false, msg: "Should match second filter via rollup" };
  }
  if (!matchesFilter("courts", filters)) {
    return { pass: false, msg: "Should match politics subcategory via rollup" };
  }
  if (matchesFilter("sports", filters)) {
    return { pass: false, msg: "Should not match unrelated category" };
  }
  return { pass: true, msg: "matchesFilter handles multiple filters correctly" };
}
tests.push(testMatchesFilterMultiple);

// ─────────────────────────────────────────────────────────────
// RUN TESTS
// ─────────────────────────────────────────────────────────────

function runTests() {
  console.log("Running Category Filtering Tests...\n");
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    const result = test();
    if (result.pass) {
      console.log(`✅ ${result.msg}`);
      passed++;
    } else {
      console.log(`❌ ${result.msg}`);
      console.log(`   ${result.msg}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

// Export for use in browser console
if (typeof window !== "undefined") {
  window.CategoryFilterTests = { runTests, tests, matchesFilter, loadCategoryFilters, toggleCategoryFilter, CATEGORY_ROLLUPS };
}

// Run if executed directly
if (typeof require !== "undefined" && require.main === module) {
  runTests();
}
