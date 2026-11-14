// search-region.bun.test.js — a search must frame the STORIES.
//
// Reported 2026-11-09: searching "artificial intelligence" found the
// articles and then zoomed in to an empty field. The URL the reader sent
// ended at #49.7961,9.8988,10 — Würzburg, Germany, zoom 10 — and a
// second run ended at #34.1618,-33.3984,2, the middle of the South
// Atlantic. Neither place had a story in it.
//
// Two causes, both measured against the live API:
//
//   1. THE ANCHOR WAS A BUILDING. /api/geocode?q="artificial
//      intelligence" answers with the front door of the "Center for
//      Artificial Intelligence and Robotics" in Würzburg — an ELEVEN METRE
//      bounding box — and /api/locations/search answers with a junk row
//      named exactly "Artificial Intelligence" pointing at that same
//      door. The old gate was NAME EQUALITY, so the query "is" that
//      place, and the map flew to it and zoomed to 10. The same is true
//      of "climate" (the Climate Pledge Arena in Seattle — a stadium)
//      and "nvidia" (the headquarters, ~100 m across).
//
//   2. THE REGION WAS THE BOUNDING BOX OF A WORLDWIDE SET. The stories
//      for "artificial intelligence" are in San Mateo, Kyiv, Quito,
//      Perth and Paris; their bounding box has its centre in the South
//      Atlantic, 2,300 km from the nearest story. A box that wide is
//      not a region — it is the world.
//
// The rules this pins:
//
//   * A place may only frame the map when it is a REGION. Below
//     MIN_REGION_DEG (0.05°, about 5.5 km) a box is a point of interest
//     — a building, a campus, a stadium — and a topic search must never
//     be dropped on one.
//
//   * Otherwise the region is computed from the RESULTS.
//
//   * A result set that spans the world is framed by the WORLD VIEW, not
//     by the middle of an ocean.
//
//   * A place that IS a region still wins: "el salvador" goes to the
//     country, "tokyo" to the city. That behaviour predates this fix
//     and must survive it.
//
// ONE implementation: runSearch() and runTextSearch() both call
// frameSearchRegion(). They used to carry their own copy of the gate and
// they had already drifted (one read `geoMatchesQuery`, the other
// `geoStrong`; one read `event_count`, the other `events_count`).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// ── slice helpers ──────────────────────────────────────────────────────

/** The body of `function name(...) { … }`, braces balanced. */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  let i = src.indexOf("(", start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") { paren--; if (paren === 0) { i++; break; } }
  }
  const bodyStart = src.indexOf("{", i);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) { end = j + 1; break; }
    }
  }
  return src.slice(start, end);
}

/** A top-level `const NAME = …;` declaration, lifted out of the source. */
function sliceConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  expect(m, `${name} not found`).toBeTruthy();
  return m[0];
}

const SRC = [
  sliceConst(appJs, "MIN_REGION_DEG"),
  sliceConst(appJs, "WORLD_SPAN_DEG"),
  sliceConst(appJs, "ANCHOR_AGREE_DEG"),
  sliceFunction(appJs, "storyPoints"),
  sliceFunction(appJs, "pointsExtent"),
  sliceFunction(appJs, "frameSearchRegion"),
].join("\n");

/**
 * Run frameSearchRegion() against a stub map and report what it did.
 * `zoom` is what the caller asked for: "world" for an explicit submit
 * (the button / Enter), "auto" for the ?q= boot path and the keystroke
 * path.
 */
function frame({ q, geo, bestLoc, points, zoom = "auto" }) {
  const calls = [];
  const map = {
    fitBounds(bounds, opts) { calls.push({ kind: "fitBounds", bounds, opts }); },
    flyTo(center, z, opts) { calls.push({ kind: "flyTo", center, zoom: z, opts }); },
  };
  const zoomToWorld = () => { calls.push({ kind: "world" }); };
  const fn = new Function("map", "zoomToWorld", SRC + "\nreturn frameSearchRegion;")(map, zoomToWorld);
  const result = fn({ q, geo, bestLoc, points, zoom });
  return { calls, result };
}

// ── the fixtures, as the live API answered them on 2026-11-09 ─────────

// "artificial intelligence" → the research centre's front door.
const AI_GEO = {
  lat: 49.7960534, lng: 9.8987993, place_type: "university",
  display_name: "Center for Artificial Intelligence and Robotics, 2, Franz-Horn-Straße, Zellerau, Würzburg, Bayern, 97082, Deutschland",
  boundingbox: ["49.7960034", "49.7961034", "9.8987493", "9.8988493"],
};
// …and the junk location row with the same name, on the same spot.
const AI_LOC = {
  id: 17353, place_name: "Artificial Intelligence", event_count: 3,
  lat: 49.7960534, lng: 9.8987993,
};

// "climate" → the Climate Pledge Arena in Seattle. A stadium.
const CLIMATE_GEO = {
  lat: 47.6219014, lng: -122.3539905, place_type: "stadium",
  display_name: "Climate Pledge Arena, 334, 1st Avenue North, Uptown, Belltown, Seattle, King County, Washington, 98109, United States",
  boundingbox: ["47.6212779", "47.6227955", "-122.3549900", "-122.3529640"],
};
const CLIMATE_LOC = {
  id: 17354, place_name: "Climate", event_count: 28,
  lat: 47.6219014, lng: -122.3539905,
};

// "el salvador" → the country. A REAL region, 1.5° × 2.6°.
const SV_GEO = {
  lat: 13.8000382, lng: -88.9140683, place_type: "administrative",
  display_name: "El Salvador",
  boundingbox: ["12.9518017", "14.4510488", "-90.2209042", "-87.5971467"],
};

// "tokyo" → the prefecture, 15.7° × 18.4°, whose centre does NOT agree
// with the anchor (so the point is the fallback).
const TOKYO_GEO = {
  lat: 35.6768601, lng: 139.7638947, place_type: "administrative",
  display_name: "東京都, 日本",
  boundingbox: ["20.2145811", "35.8984245", "135.8536855", "154.2055410"],
};
const TOKYO_LOC = {
  id: 73474, place_name: "Tokyo", events_count: 3183,
  lat: 35.6762, lng: 139.6503,
};

// The stories of "artificial intelligence", as measured: San Mateo
// (a source-fallback pile), London, Perth, Quito, Kyiv, Paris.
const AI_STORIES = [
  [37.3541, -121.9552], [37.3541, -121.9552], [51.5085, -0.1257],
  [-31.9522, 115.8614], [-0.22985, -78.52495], [50.4501, 30.5234],
  [48.8042, 2.3518], [29.5603, 106.5577], [38.8951, -77.0364],
  [13.68935, -89.18718],
];

// A regional set: one country.
const REGIONAL_STORIES = [
  [13.69, -89.19], [13.80, -88.91], [12.95, -90.22], [14.45, -87.60],
];

// ── the rules ──────────────────────────────────────────────────────────

describe("a point of interest is not a region", () => {
  test("'artificial intelligence' does not fly to the Würzburg research centre", () => {
    const { calls, result } = frame({
      q: "artificial intelligence",
      geo: AI_GEO,
      bestLoc: AI_LOC,
      points: AI_STORIES,
    });
    // No call may put the reader inside the 11 m box.
    for (const c of calls) {
      if (c.kind === "flyTo") {
        expect(Math.abs(c.center[0] - AI_GEO.lat)).toBeGreaterThan(0.01);
      }
      if (c.kind === "fitBounds") {
        const [[s, w], [n, e]] = c.bounds;
        expect(Math.max(n - s, e - w)).toBeGreaterThan(0.01);
      }
    }
    expect(result.rejectedAnchor).toBe(true);
    expect(result.framed).not.toBe("place");
  });

  test("'climate' does not fly to the Climate Pledge Arena", () => {
    const { calls, result } = frame({
      q: "climate",
      geo: CLIMATE_GEO,
      bestLoc: CLIMATE_LOC,
      points: AI_STORIES,
    });
    for (const c of calls) {
      if (c.kind === "flyTo") {
        expect(Math.abs(c.center[0] - CLIMATE_GEO.lat)).toBeGreaterThan(0.01);
      }
    }
    expect(result.rejectedAnchor).toBe(true);
  });

  test("the threshold is a REGION, not a place name", () => {
    // The rule is about the SIZE of the box, not about whether the name
    // matched. A name that matches a building loses; a name that matches
    // a country wins.
    expect(appJs).toMatch(/const MIN_REGION_DEG = 0\.05;/);
    expect(appJs).toMatch(/Math\.max\(bb\[1\] - bb\[0\], bb\[3\] - bb\[2\]\) < MIN_REGION_DEG/);
  });
});

describe("a real place still wins", () => {
  test("'el salvador' is framed by the country's extent", () => {
    const { calls, result } = frame({
      q: "el salvador",
      geo: SV_GEO,
      bestLoc: null,
      points: AI_STORIES,
    });
    expect(result.framed).toBe("place");
    expect(result.rejectedAnchor).toBe(false);
    const fit = calls.find((c) => c.kind === "fitBounds");
    expect(fit).toBeTruthy();
    // Nominatim's box is [south, north, west, east].
    expect(fit.bounds).toEqual([[12.9518017, -90.2209042], [14.4510488, -87.5971467]]);
    expect(fit.opts.maxZoom).toBe(10);
  });

  test("'tokyo' falls back to the point when the box centre disagrees", () => {
    const { calls, result } = frame({
      q: "tokyo",
      geo: TOKYO_GEO,
      bestLoc: TOKYO_LOC,
      points: REGIONAL_STORIES,
    });
    expect(result.framed).toBe("place");
    const fly = calls.find((c) => c.kind === "flyTo");
    expect(fly).toBeTruthy();
    expect(fly.center[0]).toBeCloseTo(TOKYO_LOC.lat, 3);
    expect(fly.zoom).toBe(6);
  });

  test("the box centre must still agree with the anchor", () => {
    // Guards against framing a box the geocoder answered for a
    // DIFFERENT place than the one we are navigating to.
    expect(appJs).toMatch(/Math\.abs\(\(bb\[0\] \+ bb\[1\]\) \/ 2 - anchor\.lat\) < 6/);
    expect(appJs).toMatch(/Math\.abs\(\(bb\[2\] \+ bb\[3\]\) \/ 2 - anchor\.lng\) < 6/);
  });

  test("the box is capped so a huge extent cannot zoom out past the ask", () => {
    // The cap is the LARGEST REAL COUNTRY (measured 2026-11-11): the old
    // 25°×40° rejected China (44.9°×61.3°), India (29.1°×29.5°), Brazil
    // (39.1°×45.4°), Canada (41.7°×88.7°) and Australia (46.2°×96°), so
    // a country search fell back to a point at zoom 6. 60°×100° still
    // rejects the United States (86°×360° — it includes Wake and Guam),
    // Russia (360° across the antimeridian), continents and the world —
    // fitting THOSE would zoom out to the whole planet, which is the
    // failure the cap exists for.
    expect(appJs).toMatch(/\(bb\[1\] - bb\[0\]\) < 60 && \(bb\[3\] - bb\[2\]\) < 100/);
    // and the old, too-tight cap must be gone
    expect(appJs).not.toMatch(/\(bb\[1\] - bb\[0\]\) < 25 && \(bb\[3\] - bb\[2\]\) < 40/);
  });
});

describe("the region comes from the stories", () => {
  test("a regional result set is framed by ITS extent", () => {
    const { calls, result } = frame({
      q: "volcano",
      geo: null,
      bestLoc: null,
      points: REGIONAL_STORIES,
    });
    expect(result.framed).toBe("stories");
    const fit = calls.find((c) => c.kind === "fitBounds");
    expect(fit).toBeTruthy();
    expect(fit.bounds[0][0]).toBeCloseTo(12.95, 2);
    expect(fit.bounds[1][0]).toBeCloseTo(14.45, 2);
    expect(fit.opts.maxZoom).toBe(12);
  });

  test("a worldwide result set is framed by the WORLD, not by the middle of an ocean", () => {
    const { calls, result } = frame({
      q: "artificial intelligence",
      geo: null,
      bestLoc: null,
      points: AI_STORIES,
    });
    expect(result.framed).toBe("world");
    // Exactly one move, and it is the world view.
    expect(calls.filter((c) => c.kind === "world").length).toBe(1);
    expect(calls.filter((c) => c.kind === "fitBounds").length).toBe(0);
  });

  test("the world threshold is a threshold, not a special case", () => {
    expect(appJs).toMatch(/const WORLD_SPAN_DEG = 90;/);
    expect(appJs).toMatch(/ext\.latSpan >= WORLD_SPAN_DEG \|\| ext\.lngSpan >= WORLD_SPAN_DEG/);
  });

  test("the points are the RAW story locations, never the spread positions", () => {
    // A spread position is a lie about where a story happened — the
    // exporter keeps _rawPins for the same reason.
    expect(appJs).toMatch(/points: storyPoints\(pins\.pins, events\)/);
    expect(appJs).not.toMatch(/collectAllLatLngs/);
  });
});

describe("a location row must be corroborated by the geocoder", () => {
  // "ai" is the measured case: /api/locations/search answers with a junk
  // row named "AI" on Long Island, New York (353 events) and
  // /api/geocode answers with ANGUILLA — 2,700 km apart. The name-match
  // was a coincidence and the map flew to a place called "AI".
  const AI_GEO = {
    lat: 18.1954947, lng: -63.0750234, place_type: "administrative",
    display_name: "Anguilla",
    boundingbox: ["18.0615454", "18.7951194", "-63.6391992", "-62.7125449"],
  };
  const AI_LOC = {
    id: 48308, place_name: "AI", event_count: 353,
    lat: 40.871, lng: -73.829,
  };

  test("'ai' does not fly to the junk 'AI' row on Long Island", () => {
    const { calls, result } = frame({
      q: "ai",
      geo: AI_GEO,
      bestLoc: AI_LOC,
      points: AI_STORIES,
    });
    for (const c of calls) {
      if (c.kind === "flyTo") {
        expect(Math.abs(c.center[0] - AI_LOC.lat)).toBeGreaterThan(0.01);
        expect(Math.abs(c.center[1] - AI_LOC.lng)).toBeGreaterThan(0.01);
      }
    }
    expect(result.framed).not.toBe("place");
    expect(result.rejectedAnchor).toBe(true);
  });

  test("the rejected row is not named in the status line either", () => {
    // The status line says "… · El Salvador · 84 stories" — it names the
    // place the map went to. Naming a place the map refused would be
    // naming the thing the reader just saw ignored.
    const { result } = frame({
      q: "ai", geo: AI_GEO, bestLoc: AI_LOC, points: AI_STORIES,
    });
    expect(result.rejectedAnchor).toBe(true);
    expect(appJs).toMatch(/const showPlace = !framing\.rejectedAnchor;/);
  });

  test("a row the geocoder agrees with still wins", () => {
    // "el salvador": the geocoder and the location table both answer
    // El Salvador. The corroboration must not throw that away.
    const { result } = frame({
      q: "el salvador",
      geo: SV_GEO,
      bestLoc: { id: 1, place_name: "El Salvador", event_count: 34, lat: 13.8, lng: -88.91 },
      points: AI_STORIES,
    });
    expect(result.framed).toBe("place");
    expect(result.rejectedAnchor).toBe(false);
  });

  test("no geocode answer means nothing to contradict the row", () => {
    const { result } = frame({
      q: "wurzburg",
      geo: null,
      bestLoc: { id: 2, place_name: "Würzburg", event_count: 9, lat: 49.79, lng: 9.94 },
      points: AI_STORIES,
    });
    expect(result.framed).toBe("place");
    expect(result.rejectedAnchor).toBe(false);
  });

  test("the name comparison folds the accents", () => {
    // A reader types "wurzburg" or "sao paulo", not "Würzburg" and
    // "São Paulo" — the row in the table carries the accents.
    const body = sliceFunction(appJs, "frameSearchRegion");
    expect(body).toMatch(/normalize\("NFD"\)/);
    expect(body).toMatch(/replace\(\/\[\\u0300-\\u036f\]\/g, ""\)/);
    const { result } = frame({
      q: "sao paulo",
      geo: null,
      bestLoc: { id: 3, place_name: "São Paulo", event_count: 12, lat: -23.55, lng: -46.63 },
      points: AI_STORIES,
    });
    expect(result.framed).toBe("place");
  });

  test("the threshold is a constant, not a magic number", () => {
    expect(appJs).toMatch(/const ANCHOR_AGREE_DEG = 6;/);
  });
});

describe("the region is framed QUICKLY", () => {
  /** The body of a named top-level function, up to the next one. */
  function bodyOf(name, span = 60_000) {
    const at = appJs.indexOf(`async function ${name}`) >= 0
      ? appJs.indexOf(`async function ${name}`)
      : appJs.indexOf(`function ${name}`);
    expect(at, `${name} not found`).toBeGreaterThan(-1);
    const rest = appJs.slice(at + 1);
    const next = rest.search(/\n(?:async )?function [A-Za-z_]/);
    const end = next === -1 ? at + span : at + 1 + next;
    return appJs.slice(at, end);
  }

  test("the event search is STARTED before the map moves", () => {
    // The event search spawns a Python worker and can take 30–90 s
    // (measured: 6 s warm, 90 s cold). It must be IN FLIGHT while the
    // map is being framed, not started after it.
    const body = bodyOf("runSearch");
    const startAt = body.indexOf("const searchRespPromise = fetch(searchUrl");
    const frameAt = body.indexOf("framing = frameSearchRegion(");
    expect(startAt).toBeGreaterThan(-1);
    expect(frameAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(frameAt);
  });

  test("the event search is AWAITED after the map has moved", () => {
    // The pins, the geocode and the location match decide where the map
    // looks and come back in about a second; the events land in the same
    // places. Waiting for the events first is what left the reader
    // staring at the old view for a minute and a half.
    const body = bodyOf("runSearch");
    const frameAt = body.indexOf("framing = frameSearchRegion(");
    const awaitAt = body.indexOf("await searchRespPromise");
    expect(frameAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(frameAt).toBeLessThan(awaitAt);
  });

  test("an aborted search leaves no unhandled rejection behind", () => {
    // The promise must never reject: an abort comes back as an object and
    // the guard after the await drops it.
    const body = bodyOf("runSearch");
    expect(body).toMatch(/if \(e\?\.name === "AbortError" \|\| ctrl\.signal\.aborted\) return \{ error: "aborted", detail: null \};/);
  });

  test("a search with no pins still frames, once the events arrive", () => {
    const body = bodyOf("runSearch");
    // No pins = no region to frame, so the framing waits for the events.
    expect(body).toMatch(/if \(!framing\) \{\s*\n\s*framing = frameSearchRegion\(\{/);
  });
});

describe("the helpers the framing rests on", () => {
  /** storyPoints + pointsExtent, run against the shipped source. */
  function helpers() {
    const fn = new Function(
      "window", "map", "zoomToWorld",
      SRC + "\nreturn { storyPoints, pointsExtent };")({}, { fitBounds() {}, flyTo() {} }, () => {});
    return fn;
  }

  test("the points are the RAW story locations", () => {
    const { storyPoints } = helpers();
    const pts = storyPoints(
      [{ location: { lat: 1, lng: 2 } }],
      [{ location: { lat: 3, lng: 4 } }],
    );
    expect(pts).toEqual([[1, 2], [3, 4]]);
  });

  test("a story with no location, or a broken one, is skipped", () => {
    const { storyPoints } = helpers();
    const pts = storyPoints([
      { title: "no location" },
      { location: null },
      { location: { lat: "x", lng: 2 } },
      { location: { lat: 5, lng: 6 } },
      null,
      "not a story",
    ]);
    expect(pts).toEqual([[5, 6]]);
  });

  test("a group that is not a list is ignored, not a crash", () => {
    const { storyPoints } = helpers();
    expect(storyPoints(null, undefined, "nope", [{ location: { lat: 1, lng: 1 } }]))
      .toEqual([[1, 1]]);
  });

  test("the extent is the bounding box, with both spans", () => {
    const { pointsExtent } = helpers();
    const ext = pointsExtent([[10, -20], [-5, 30], [40, 0]]);
    expect(ext.south).toBe(-5);
    expect(ext.north).toBe(40);
    expect(ext.west).toBe(-20);
    expect(ext.east).toBe(30);
    expect(ext.latSpan).toBe(45);
    expect(ext.lngSpan).toBe(50);
  });

  test("no points means no extent", () => {
    const { pointsExtent } = helpers();
    expect(pointsExtent([])).toBeNull();
    expect(pointsExtent(null)).toBeNull();
  });
});

describe("ONE implementation", () => {
  test("both search paths call frameSearchRegion", () => {
    expect(appJs).toMatch(/frameSearchRegion\(\{\s*\n\s*q, geo, bestLoc, points: storyPoints\(items\), zoom,/);
    expect(appJs).toMatch(/frameSearchRegion\(\{\s*\n\s*q, geo, bestLoc, points: storyPoints\(pins\.pins, events\), zoom,/);
  });

  test("the place check comes BEFORE the world view inside it", () => {
    const body = sliceFunction(appJs, "frameSearchRegion");
    const placeAt = body.indexOf("const anchor = geoIsThePlace");
    const worldAt = body.indexOf('zoom === "world"');
    expect(placeAt).toBeGreaterThan(-1);
    expect(worldAt).toBeGreaterThan(-1);
    expect(placeAt).toBeLessThan(worldAt);
  });

  test("the gate compares the normalised place name to the whole query", () => {
    const body = sliceFunction(appJs, "frameSearchRegion");
    expect(body).toMatch(/const norm = \(s\) => String\(s \|\| ""\)\.toLowerCase\(\)\.trim\(\)/);
    // Both oracles, not just one: the geocoder AND the location search.
    expect(body).toMatch(/norm\(geo\.display_name\) === qNorm/);
    expect(body).toMatch(/norm\(bestLoc\.place_name\) === qNorm/);
  });

  test("it does NOT fly on a partial place match", () => {
    const body = sliceFunction(appJs, "frameSearchRegion");
    expect(body).not.toMatch(/bestLoc && \(\(bestLoc\.events_count[\s\S]{0,60}map\.flyTo\(\[bestLoc\.lat/);
  });
});
