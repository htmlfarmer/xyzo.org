// search-state-abbrev.bun.test.js — two-letter state abbreviations.
//
// People type "TX", "CA", "NY" constantly and nothing resolved them —
// worse, both lookups were actively WRONG for it:
//
//   /api/locations/search?q=CA  -> "Careca", "Can", "Car"  (prefix-matched
//                                   the beginnings of words)
//   /api/geocode?q=CA           -> CANADA, not California
//   /api/geocode?q=WA           -> WESTERN AUSTRALIA, not Washington
//
// So the abbreviation is resolved from an explicit table in
// city-engine.js (the gazetteer), offline and instantly, and the state's
// own extent frames it. app.js holds only a thin detectStateSearch()
// delegation — the split the (now removed) 850 KB runaway ceiling
// forced, but one that stands on its own: the gazetteer belongs beside
// the rest of the gazetteer, and each assertion below is therefore
// sourced from the file that actually holds the code.
//
// Playwright-verified (scripts/search_place_check.py):
//   TX  -> 31.32,-100.08 z6  "All news in Texas, TX, US · 92 stories"
//   CA  -> 37.42,-119.30 z6  "All news in California, CA, US · 175 stories"
//   WA  -> 47.30,-120.86 z7  "All news in Washington, WA, US · 20 stories"
//   tx  -> same as TX (case-insensitive)
//   uk  -> the UK, NOT "Ukyō Ward, Kyoto" (see the prefix rule)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const engineJs = readFileSync(join(ROOT, "city-engine.js"), "utf8");

function readStates() {
  const start = engineJs.indexOf("const US_STATES = {");
  expect(start, "US_STATES missing from city-engine.js").toBeGreaterThan(-1);
  const body = engineJs.slice(start, engineJs.indexOf("\n  };", start) + 4);
  return [...body.matchAll(/([A-Z]{2}): \["([^"]+)", (-?[\d.]+), (-?[\d.]+), \[([^\]]+)\]\]/g)]
    .map((m) => ({
      key: m[1], name: m[2], lat: Number(m[3]), lng: Number(m[4]),
      bbox: m[5].split(",").map(Number),
    }));
}

// A top-level (or indented) function body out of either file.
function bodyOf(src, sig, stopAt) {
  const start = src.indexOf(sig);
  expect(start, `${sig} not found`).toBeGreaterThan(-1);
  const end = stopAt ? src.indexOf(stopAt, start) : -1;
  return src.slice(start, end > 0 ? end : start + 4000);
}

describe("the state table (in city-engine.js, the gazetteer)", () => {
  test("covers all 50 states plus DC", () => {
    const s = readStates();
    expect(s.length).toBe(51);
    expect(s.map((e) => e.key)).toContain("DC");
    expect(s.map((e) => e.key)).toContain("TX");
  });

  test("every entry is a two-letter key with a sane point and extent", () => {
    for (const e of readStates()) {
      expect(e.key).toMatch(/^[A-Z]{2}$/);
      expect(e.name.length).toBeGreaterThan(3);
      expect(Math.abs(e.lat)).toBeLessThanOrEqual(72);   // Alaska is the extreme
      expect(Math.abs(e.lng)).toBeLessThanOrEqual(180);
      expect(e.bbox).toHaveLength(4);
      const [s, n, w, ee] = e.bbox;
      // ordered [south, north, west, east] and NOT crossing the
      // antimeridian — a box spanning 349 degrees of longitude would
      // fitBounds straight back to the whole world.
      expect(s).toBeLessThan(n);
      expect(w).toBeLessThan(ee);
      expect(ee - w).toBeLessThan(70);
      expect(s).toBeGreaterThanOrEqual(18);   // Hawaii's southern tip
      expect(n).toBeLessThanOrEqual(72);
    }
  });
});

describe("a bare two-letter query resolves as a state", () => {
  test("app.js exposes a detectStateSearch consulted at EVERY search path", () => {
    expect(appJs).toMatch(/function detectStateSearch\(query\)/);
    const sites = [...appJs.matchAll(/const cityHit = ([^;]+);/g)].map((m) => m[1]);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const expr of sites) {
      expect(expr, `a search path skips state lookup: ${expr}`)
        .toMatch(/detectStateSearch\(q\) \|\| detectCitySearch\(q\)/);
    }
  });

  test("app.js delegates rather than owning the gazetteer data", () => {
    // The table is in city-engine.js, not app.js. (That split was
    // forced by the 850 KB ceiling, which was removed 2026-11-01 — the
    // assertion stands regardless: state extents belong with the rest
    // of the gazetteer, not in the map's entry script.)
    expect(appJs).not.toMatch(/const US_STATES = \{/);
    expect(appJs).toMatch(/window\.CityEngine\.findState\(query\)/);
    expect(engineJs).toMatch(/function findState\(query\)/);
    expect(engineJs).toMatch(/findState,/);
  });

  test("findState is EXACTLY two characters and case-insensitive", () => {
    // Exact, not a prefix: "tx" is Texas, but "tax" and "texas" are not
    // abbreviations and must fall through to the normal search.
    const body = bodyOf(engineJs, "function findState(query)", "\n  function ");
    expect(body).toMatch(/if \(!query \|\| query\.length !== 2\) return null;/);
    expect(body).toMatch(/query\.trim\(\)\.toUpperCase\(\)/);
  });

  test("it returns a synthetic place carrying its framing extent", () => {
    const body = bodyOf(engineJs, "function findState(query)", "\n  function ");
    expect(body).toMatch(/_bbox: s\[3\]/);
    expect(body).toMatch(/_isState: true/);
    // a high population keeps cityZoom() at its widest setting
    expect(body).toMatch(/population: 30_000_000/);
  });

  test("the city branch FITS a state's extent instead of zooming to a point", () => {
    // cityRadius's own cap is 70 km — a circle that size around the
    // centroid of Texas shows a slice of Texas, not Texas.
    expect(appJs).toMatch(/Array\.isArray\(cityHit\._bbox\) && cityHit\._bbox\.length === 4/);
    expect(appJs).toMatch(/map\.fitBounds\(\[\[cityHit\._bbox\[0\], cityHit\._bbox\[2\]\], \[cityHit\._bbox\[1\], cityHit\._bbox\[3\]\]\]/);
  });
});

describe("the two bbox orders must be translated, not assumed", () => {
  // THE BUG TESTING CAUGHT: a state stores Nominatim's
  // [south, north, west, east] so fitBounds can use it directly, but
  // bbox= takes [minLng, minLat, maxLng, maxLat]. Returning the state's
  // tuple unwritten read its latitude as a longitude, gave an inverted
  // box (W > E, S > N), and the API answered "No news found near Texas,
  // TX, US" while the map framed Texas perfectly.
  test("cityToBbox converts [S,N,W,E] to [W,S,E,N] for a state", () => {
    const body = bodyOf(engineJs, "function cityToBbox(city, radiusKm)", "\n  function ");
    expect(body).toMatch(/const \[s, n, w, e\] = city\._bbox;/);
    expect(body).toMatch(/return \[w, s, e, n\];/);
    // and it must NOT return the tuple unwritten
    expect(body).not.toMatch(/return city\._bbox\.slice\(\);/);
  });

  test("the non-state fallback still builds [W,S,E,N]", () => {
    const body = bodyOf(engineJs, "function cityToBbox(city, radiusKm)", "\n  function ");
    expect(body).toMatch(/Math\.max\(-180, lng - dLng\),[\s\S]{0,120}Math\.max\(-85, lat - dLat\),[\s\S]{0,120}Math\.min\(180, lng \+ dLng\),[\s\S]{0,120}Math\.min\(85, lat \+ dLat\),/);
  });

  test("app.js passes the translated box through unchanged", () => {
    // The thin alias must not re-order anything.
    expect(appJs).toMatch(/const cityToBbox = \(city, r\) => window\.CityEngine\?\.cityToBbox\?\.\(city, r\)/);
  });
});

describe("short queries must not prefix-match a city", () => {
  // "uk" is a prefix of "Ukyō Ward, Kyoto", so searching a country code
  // flew to a ward in Japan. Two letters is exactly where people are
  // trying abbreviations, so an exact hit or a state is all they get.
  test("detectCitySearch only prefix-matches from three characters", () => {
    const body = bodyOf(engineJs, "function detectCitySearch(query)", "\n  function ");
    expect(body).toMatch(/if \(q\.length >= 3 && \(cityNameLower\.startsWith\(q\)/);
  });

  test("exact city matching still works at any length", () => {
    const body = bodyOf(engineJs, "function detectCitySearch(query)", "\n  function ");
    expect(body).toMatch(/if \(q === cityNameLower \|\| q === asciiLower\) return best;/);
  });

  test("app.js still reaches it through the alias", () => {
    expect(appJs).toMatch(/const detectCitySearch = \(q\) => window\.CityEngine\?\.detectCity\?\.\(q\)/);
    expect(engineJs).toMatch(/detectCity: detectCitySearch/);
  });
});
