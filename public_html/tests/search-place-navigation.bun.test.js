// search-place-navigation.bun.test.js — searching a PLACE must go there.
//
// Reported: searching "el salvador" did not move the map to the country.
// Measured before the fix, from Sydney (-33.87,151.21 z10): the search
// ended at 20,0 ZOOM 2 — the whole world — while the status line read
// "… · El Salvador · 82 stories", i.e. the place WAS resolved and then
// thrown away.
//
// Cause: both the search button and the Enter key call
// runSearch({ zoom: "world" }), and the branch order was
//
//     if (zoom === "world") { zoomToWorld(); }          // always taken
//     else if (bestLoc)     { map.flyTo(...); }         // dead on submit
//
// so the fly-to-the-place code existed but was unreachable on every real
// submit. World view is right for a TOPIC whose results are spread over
// the globe; it is wrong when the query IS a country, region or city.
//
// The gate is deliberately strict, and the tests below pin why: neither
// lookup is a safe oracle on its own. /api/locations/search?q="climate
// change" ranks "Climate" (a place in Seattle) first with 23 events, and
// Nominatim answers the same query with a California trail sign literally
// named "Climate Change". Verified end-to-end with Playwright
// (scripts/search_place_check.py):
//
//     el salvador  -> 13.70,-88.91 z9   (framed to the country)
//     chile        -> -31.76,-71.32 z6
//     tokyo        ->  35.69,139.69 z7  (the city path, unchanged)
//     climate change -> world view      (not Seattle, not California)
//     ukraine war  -> world view        (a topic that mentions a place)
//
// WHERE THE LOGIC LIVES (2026-11-09): the gate, the framing and the
// region calculation moved into frameSearchRegion(), ONE function shared
// by runSearch() and runTextSearch(). They used to carry their own copy
// of the gate and they had already drifted — one read `geoMatchesQuery`,
// the other `geoStrong`, and one read `event_count` while the other read
// `events_count`. The behaviour these tests pin is unchanged; the place
// it lives in is not. See search-region.bun.test.js for the rules that
// were added on top (a point of interest is not a region; the region
// comes from the stories).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// The body of a named top-level function, up to the next one.
function bodyOf(name, span = 60_000) {
  const start = appJs.indexOf(`async function ${name}`);
  const startSync = appJs.indexOf(`function ${name}`);
  const at = start >= 0 ? start : startSync;
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = appJs.slice(at + 1);
  const next = rest.search(/\n(?:async )?function [A-Za-z_]/);
  const end = next === -1 ? at + span : at + 1 + next;
  return appJs.slice(at, end);
}

// The shared implementation both search paths call.
const frameBody = bodyOf("frameSearchRegion");

describe("a resolved place outranks the world view", () => {
  test("both search paths go through the one shared implementation", () => {
    // Two copies of the gate is how they drifted apart in the first
    // place; the fix for "the map zoomed to a building" was written once
    // and is used once.
    for (const fn of ["runSearch", "runTextSearch"]) {
      expect(bodyOf(fn), `${fn} does not call frameSearchRegion`).toMatch(/frameSearchRegion\(\{/);
    }
  });

  test("the place check comes BEFORE zoomToWorld", () => {
    const placeAt = frameBody.indexOf("const anchor = geoIsThePlace");
    const worldAt = frameBody.indexOf('zoom === "world"');
    expect(placeAt, "frameSearchRegion lost its place branch").toBeGreaterThan(-1);
    expect(worldAt, "frameSearchRegion lost its world branch").toBeGreaterThan(-1);
    // Reversed, this is the whole bug: world wins and the place is dead.
    expect(placeAt).toBeLessThan(worldAt);
  });

  test("zoomToWorld is the FALLBACK, not the first branch", () => {
    expect(frameBody).toMatch(/zoomToWorld\(\);/);
    // and the fallback frames the STORIES — a topic with no place.
    expect(frameBody).toMatch(/map\.fitBounds\(\[\[ext\.south, ext\.west\], \[ext\.north, ext\.east\]\]/);
  });

  test("both submits pass zoom:'world', which is why ordering is load-bearing", () => {
    expect(appJs).toMatch(/searchBtn\.addEventListener\("click", \(\) => runSearch\(\{ zoom: "world" \}\)\)/);
    expect(appJs).toMatch(/runSearch\(\{ zoom: "world" \}\);\s*\/\/ explicit submit/);
  });
});

describe("a place only counts when it accounts for the WHOLE query", () => {
  test("the gate compares the normalised place name to the whole query", () => {
    expect(frameBody).toMatch(/const norm = \(s\) => String\(s \|\| ""\)\.toLowerCase\(\)\.trim\(\)/);
    // Both oracles, not just one: the geocoder AND the location search.
    expect(frameBody).toMatch(/norm\(geo\.display_name\) === qNorm/);
    expect(frameBody).toMatch(/norm\(bestLoc\.place_name\) === qNorm/);
  });

  test("it does NOT fly on a partial place match", () => {
    // The weak version was "the top location with events", which sent
    // "climate change" to Seattle because a place called Climate tops
    // that list. A startsWith test would still match it, so the gate
    // must be equality.
    expect(frameBody).not.toMatch(/bestLoc && \(\(bestLoc\.events_count[\s\S]{0,60}map\.flyTo\(\[bestLoc\.lat/);
  });

  test("the location count accepts either field name", () => {
    // The two copies of this gate disagreed: one read `event_count`, the
    // other `events_count`. The API sends `events_count`; the fallback
    // keeps the older name working.
    expect(frameBody).toMatch(/bestLoc\.events_count \?\? bestLoc\.event_count/);
  });
});

describe("the place is framed by its extent, with a sane cap", () => {
  test("uses fitBounds on the geocoder box, Nominatim order", () => {
    expect(frameBody).toMatch(/map\.fitBounds\(\[\[bb\[0\], bb\[2\]\], \[bb\[1\], bb\[3\]\]\]/);
    // Nominatim's box is [south, north, west, east]; the corners must
    // be built as [[south, west], [north, east]] or the bounds invert.
    expect(frameBody).toMatch(/padding: \[48, 48\], maxZoom: 10/);
  });

  test("the box is capped so a huge extent cannot zoom out past the ask", () => {
    // The cap is the LARGEST REAL COUNTRY, not a city's (measured
    // 2026-11-11): 25°×40° rejected China (44.9°×61.3°), India, Brazil,
    // Canada (41.7°×88.7°) and Australia (46.2°×96°), so a country
    // search fell back to a point at zoom 6. 60°×100° still rejects the
    // United States (86°×360° — Wake and Guam), Russia (360° across the
    // antimeridian), continents and the world. Note the cap was NEVER
    // what protected against Tokyo PREFECTURE (15.7°×18.4° passes any
    // sane cap) — the box-centre agreement below is what sends "tokyo"
    // to the point instead.
    expect(frameBody).toMatch(/\(bb\[1\] - bb\[0\]\) < 60 && \(bb\[3\] - bb\[2\]\) < 100/);
    expect(frameBody).not.toMatch(/\(bb\[1\] - bb\[0\]\) < 25 &&/);
  });

  test("the box centre must agree with the anchor", () => {
    // Guards against framing a box the geocoder answered for a
    // DIFFERENT place than the one we are navigating to.
    expect(frameBody).toMatch(/Math\.abs\(\(bb\[0\] \+ bb\[1\]\) \/ 2 - anchor\.lat\) < 6/);
    expect(frameBody).toMatch(/Math\.abs\(\(bb\[2\] \+ bb\[3\]\) \/ 2 - anchor\.lng\) < 6/);
  });

  test("falls back to the point when the box is unusable", () => {
    expect(frameBody).toMatch(/map\.flyTo\(\[anchor\.lat, anchor\.lng\], 6/);
  });

  test("neither search path leaks the other's helper", () => {
    // `geoMatchesQuery` used to live in runTextSearch only, and
    // referencing it from runSearch threw a ReferenceError that killed
    // the handler before any branch ran — the map then did not move AT
    // ALL (measured: still at -33.87,151.21 z10 after the search
    // finished). There is one copy now, and it has no such dependency.
    const code = bodyOf("runSearch")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/geoMatchesQuery/);
    expect(frameBody).toMatch(/const geoStrong = !!\(geo && geo\.display_name/);
  });
});
