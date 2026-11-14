// search-country-hijack.bun.test.js — a search for a COUNTRY must not
// land on a CITY.
//
// Reported 2026-11-11, two cases and a generalized complaint:
//
//     "china" -> #12.6283,-87.1326,9   Chinandega, NICARAGUA, zoom 9,
//               status "No news found near Chinandega, Chinandega
//               Department, NI"
//     "india" -> Indianapolis, Indiana
//
// Both are ONE defect: detectCitySearch() prefix-matches, and in both
// cases the query is a prefix of a bigger city's name — "chinandega"
// starts with "china", "indianapolis" with "india". Measured against
// the shipped index (public_html/data/cities.10k.json), the whole
// matrix, before the fix:
//
//     "china"    -> Chinandega, NI          "florida" -> Florida, CUBA
//     "india"    -> Indianapolis, US        "maine"   -> Maine Township, US
//     "peru"     -> Perugia, IT             "korea"   -> Koreatown, US
//                                           "virginia"-> Virginia, SOUTH AFRICA
//
// WHY NO STRUCTURAL RULE CAN FIX IT. "china" -> Chinandega and "chica"
// -> Chicago are both mid-word prefixes of a city name, and prefix
// matching must keep working while the reader types ("new" -> New York
// City, "kansas c" -> Kansas City, "san" -> San Francisco Bay Area).
// The difference between the two is that one query NAMES A COUNTRY —
// so the gazetteer carries the list (BIG_PLACE_NAMES in city-engine.js,
// ISO 3166 names plus the forms people type), the city path refuses it,
// and the query falls through to the two oracles that answer for a
// country: /api/geocode and /api/pins?q=.
//
// THE GEOCODER ANSWERS IN THE LOCAL SCRIPT, so frameSearchRegion()'s
// name gate would reject the country even after the city path steps
// aside. Measured live (2026-11-11):
//
//     "china" -> 中国    "japan" -> 日本     "korea" -> 대한민국
//     "brazil"-> Brasil  "turkey"-> Türkiye  "peru"  -> Perú
//
// None of those display names starts with or equals the query. The
// clause therefore accepts a geocoder answer that is (a) an
// ADMINISTRATIVE area (a country or a state — Nominatim answering
// "turkey" with Turkey, TEXAS is a town and still loses) and (b) for a
// query ON THE LIST. Everything else keeps the strict name gate: the
// point-of-interest rule and the corroboration rule are untouched.
//
// The tests run the SHIPPED city-engine against the real city index,
// and frameSearchRegion against fixtures copied from the live API.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const engineJs = readFileSync(join(ROOT, "city-engine.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// ── the shipped city-engine, run against the real index ───────────────

let Engine = null;
const savedGlobals = {};

beforeAll(async () => {
  for (const k of ["window", "XLog", "fetch", "localStorage", "requestIdleCallback"]) {
    savedGlobals[k] = globalThis[k];
  }
  globalThis.window = globalThis;
  globalThis.XLog = { warn() {}, log() {}, error() {}, debug() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  // No idle scheduling: the test loads explicitly, and a stray timer
  // firing after the globals are restored would touch the real fetch.
  globalThis.requestIdleCallback = () => {};
  const realFetch = savedGlobals.fetch;
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^\//, "").split("?")[0];
    try {
      const buf = readFileSync(join(ROOT, rel));
      return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()) };
    } catch {
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };
  try {
    new Function(engineJs)();
    Engine = globalThis.window.CityEngine;
    expect(Engine, "city-engine did not export window.CityEngine").toBeTruthy();
    await Engine.load();
    expect(Engine.isLoaded(), "cities.10k.json did not load").toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

afterAll(() => {
  for (const k of ["window", "XLog", "fetch", "localStorage", "requestIdleCallback"]) {
    if (savedGlobals[k] === undefined) delete globalThis[k];
    else globalThis[k] = savedGlobals[k];
  }
});

describe("the city path refuses a query that names a country or a state", () => {
  // The measured matrix — every one of these flew to a city on another
  // continent before the fix (see the header).
  test("no hijack: china, india, peru, florida, maine, korea, virginia", () => {
    for (const q of ["china", "india", "peru", "florida", "maine", "korea", "virginia"]) {
      expect(Engine.detectCity(q), `"${q}" must not resolve to a city`).toBe(null);
    }
  });

  test("the guard is case-insensitive and matches whole country names", () => {
    for (const q of ["CHINA", "India", "  japan  ", "turkey", "mexico", "egypt"]) {
      expect(Engine.detectCity(q), `"${q}" must not resolve to a city`).toBe(null);
    }
  });

  test("a CITY query still answers — the guard must not eat prefix matching", () => {
    // These are the typing conveniences the prefix rule exists for; the
    // guard is a list of bigger places, not a ban on prefixes.
    const want = {
      chicago: "Chicago",
      rio: "Rio de Janeiro",
      new: "New York City",
      san: "San Francisco Bay Area",
      "kansas c": "Kansas City",
      spring: "Spring Valley",
      oslo: "Oslo",
      tokyo: "Tokyo",
      london: "London",
    };
    for (const [q, name] of Object.entries(want)) {
      const hit = Engine.detectCity(q);
      expect(hit, `"${q}" should still resolve to a city`).toBeTruthy();
      expect(hit.name).toBe(name);
    }
  });

  test("isBiggerPlace folds accents, case and punctuation", () => {
    // A reader types "cote d ivoire", "st lucia" and "timor-leste";
    // the table stores the forms ISO uses. Both sides are normalised
    // with the same function, so they meet in the middle.
    const yes = ["china", "CHINA", "côte d'ivoire", "cote d ivoire", "st. lucia",
      "timor-leste", "united states", "usa", "drc", "texas", "washington"];
    for (const q of yes) {
      expect(Engine.isBiggerPlace(q), `"${q}" should be a bigger place`).toBe(true);
    }
    const no = ["chicago", "climate", "artificial intelligence", "chinandega",
      "indianapolis", "perugia", "", null, undefined];
    for (const q of no) {
      expect(Engine.isBiggerPlace(q), `"${q}" should not be a bigger place`).toBe(false);
    }
  });

  test("the guard is IN detectCitySearch, not somewhere upstream", () => {
    // All three app.js call sites (runSearch, runTextSearch and the
    // search-mode pin fetch) go through this one function; a guard in
    // one caller would leave the other two hijacked.
    const body = engineJs.slice(engineJs.indexOf("function detectCitySearch(query)"));
    expect(body).toMatch(/if \(isBiggerPlace\(q\)\) return null;/);
    expect(engineJs).toMatch(/isBiggerPlace,/);
  });
});

// ── frameSearchRegion, as the search paths call it ────────────────────

/** A top-level `const NAME = …;` declaration, lifted out of the source. */
function sliceConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  expect(m, `${name} not found`).toBeTruthy();
  return m[0];
}

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

const SRC = [
  sliceConst(appJs, "MIN_REGION_DEG"),
  sliceConst(appJs, "WORLD_SPAN_DEG"),
  sliceConst(appJs, "ANCHOR_AGREE_DEG"),
  sliceFunction(appJs, "storyPoints"),
  sliceFunction(appJs, "pointsExtent"),
  sliceFunction(appJs, "frameSearchRegion"),
].join("\n");

/**
 * Run frameSearchRegion() against a stub map, with the REAL
 * isBiggerPlace from the shipped engine — the clause must be exercised
 * with the list that actually ships, not a hand-written stub.
 */
function frame({ q, geo, bestLoc, points, zoom = "auto" }) {
  const calls = [];
  const map = {
    fitBounds(bounds, opts) { calls.push({ kind: "fitBounds", bounds, opts }); },
    flyTo(center, z, opts) { calls.push({ kind: "flyTo", center, zoom: z, opts }); },
  };
  const zoomToWorld = () => { calls.push({ kind: "world" }); };
  const fn = new Function("map", "zoomToWorld", SRC + "\nreturn frameSearchRegion;")(map, zoomToWorld);
  const result = fn({ q, geo, bestLoc, points, zoom, isBiggerPlace: Engine.isBiggerPlace });
  return { calls, result };
}

// ── fixtures, as the live API answered them on 2026-11-11 ─────────────

// "china" -> 中国, a country: 44.9° × 61.3°.
const CHINA_GEO = {
  lat: 34.5412252, lng: 108.9237067, place_type: "administrative",
  display_name: "中国",
  boundingbox: ["8.6650385", "53.5608154", "73.4997347", "134.7734492"],
};
// "japan" -> 日本: 25.5° × 31.5°.
const JAPAN_GEO = {
  lat: 36.5748441, lng: 139.2394179, place_type: "administrative",
  display_name: "日本",
  boundingbox: ["20.2145811", "45.7112046", "122.7141754", "154.2055410"],
};
// "turkey" answered with Turkey, TEXAS — a town, not an admin area.
const TURKEY_TX_GEO = {
  lat: 33.2184, lng: -95.9058, place_type: "town",
  display_name: "Turkey, Texas, United States",
  boundingbox: ["33.2084", "33.2284", "-95.9158", "-95.8958"],
};
// "united states" -> 86.3° × 360° (Wake, Guam…): must NOT be fitted.
const US_GEO = {
  lat: 39.5, lng: -98.35, place_type: "administrative",
  display_name: "United States",
  boundingbox: ["7.15", "71.40", "-179.90", "179.90"],
};
// An admin area far too small to be a region — a township that happens
// to be called China (China Township, Illinois).
const TOWNSHIP_GEO = {
  lat: 41.5, lng: -87.9, place_type: "administrative",
  display_name: "China Township, Illinois, United States",
  boundingbox: ["41.49", "41.51", "-87.91", "-87.89"],
};
// "artificial intelligence": a topic, never on the list, whatever the
// geocoder answers with.
const TOPIC_GEO = {
  lat: 49.7960534, lng: 9.8987993, place_type: "administrative",
  display_name: "Würzburg, Bayern, Deutschland",
  boundingbox: ["49.55", "49.85", "9.75", "10.05"],
};

const STORY = [[31.2, 121.5], [39.9, 116.4], [22.5, 114.1]];   // inside China
const WORLD_STORY = [[40.7, -74.0], [-33.9, 151.2], [51.5, -0.1]];

describe("a country query is framed by the COUNTRY, in any script", () => {
  test("'china' frames China even though Nominatim answered 中国", () => {
    const { calls, result } = frame({ q: "china", geo: CHINA_GEO, bestLoc: null, points: STORY });
    expect(result.framed).toBe("place");
    expect(result.rejectedAnchor).toBe(false);
    const fit = calls.find((c) => c.kind === "fitBounds");
    expect(fit, "China must be fitted, not left to the stories").toBeTruthy();
    // Nominatim order [south, north, west, east] -> [[S, W], [N, E]].
    expect(fit.bounds).toEqual([[8.6650385, 73.4997347], [53.5608154, 134.7734492]]);
    expect(fit.opts.maxZoom).toBe(10);
  });

  test("'japan' frames Japan (日本) the same way", () => {
    const { calls, result } = frame({ q: "japan", geo: JAPAN_GEO, bestLoc: null, points: STORY });
    expect(result.framed).toBe("place");
    expect(calls.find((c) => c.kind === "fitBounds")).toBeTruthy();
    expect(calls.some((c) => c.kind === "world")).toBe(false);
  });

  test("'china' frames the COUNTRY even when the stories are worldwide", () => {
    // The place wins over the results — that is the whole rule. The
    // worldwide set would otherwise frame the world (its box centre is
    // an empty ocean), which is how "china" degraded before: the city
    // path lost, and nothing but the stories was left.
    const { result } = frame({ q: "china", geo: CHINA_GEO, bestLoc: null, points: WORLD_STORY });
    expect(result.framed).toBe("place");
  });
});

describe("the country clause is narrow", () => {
  test("a TOWN named like a country still loses to the name gate", () => {
    // Turkey, Texas is not an administrative area — place_type is the
    // second half of the clause for exactly this reason. Nothing is
    // resolved at all (rejectedAnchor stays false: no place was ever
    // taken and thrown away), and the map must never go near the town.
    const { calls, result } = frame({ q: "turkey", geo: TURKEY_TX_GEO, bestLoc: null, points: STORY });
    expect(result.framed).not.toBe("place");
    for (const c of calls) {
      if (c.kind === "flyTo") {
        expect(Math.abs(c.center[0] - TURKEY_TX_GEO.lat)).toBeGreaterThan(0.01);
        expect(Math.abs(c.center[1] - TURKEY_TX_GEO.lng)).toBeGreaterThan(0.01);
      }
      if (c.kind === "fitBounds") {
        const [[s, w], [n, e]] = c.bounds;
        expect(Math.max(n - s, e - w)).toBeGreaterThan(0.01); // not the town's box
      }
    }
  });

  test("a query NOT on the list never reaches the clause", () => {
    // An admin-area geocoder answer is not enough on its own: the name
    // gate still decides for every topic query, or "artificial
    // intelligence" could frame Würzburg (its geocoder answer IS an
    // administrative area). Nothing resolves, so the worldwide stories
    // take the map to the world view.
    const { calls, result } = frame({ q: "artificial intelligence", geo: TOPIC_GEO, bestLoc: null, points: WORLD_STORY });
    expect(result.framed).not.toBe("place");
    expect(result.framed).toBe("world");
    expect(calls.some((c) => c.kind === "fitBounds")).toBe(false);
  });

  test("the point-of-interest rule still binds the country clause", () => {
    // An admin box under MIN_REGION_DEG is a township, not a country,
    // however much the query looks like one.
    const { calls, result } = frame({ q: "china", geo: TOWNSHIP_GEO, bestLoc: null, points: WORLD_STORY });
    expect(result.framed).not.toBe("place");
    expect(result.rejectedAnchor).toBe(true);
    expect(calls.some((c) => c.kind === "fitBounds")).toBe(false);
  });

  test("without the predicate the clause is inert (the default)", () => {
    // The tests' own harness and any future caller that forgets the
    // argument fall back to the strict name gate — never to a wider one.
    const fn = new Function("map", "zoomToWorld", SRC + "\nreturn frameSearchRegion;")(
      { fitBounds() {}, flyTo() {} }, () => {});
    const r = fn({ q: "china", geo: CHINA_GEO, bestLoc: null, points: STORY, zoom: "auto" });
    expect(r.framed).not.toBe("place");
  });
});

describe("the extent cap admits countries, rejects the planet", () => {
  test("China's 44.9°×61.3° box is inside the cap and gets fitted", () => {
    // The old 25°×40° cap rejected this box, so a country search fell
    // back to a point at zoom 6 and showed a slice of the country.
    expect(53.5608154 - 8.6650385).toBeGreaterThan(25);
    expect(134.7734492 - 73.4997347).toBeGreaterThan(40);
    const { calls } = frame({ q: "china", geo: CHINA_GEO, bestLoc: null, points: STORY });
    expect(calls.find((c) => c.kind === "fitBounds")).toBeTruthy();
  });

  test("the United States' 86°×360° box is NOT fitted", () => {
    // Fitting it would zoom out to the whole planet — the failure the
    // cap exists for. The point at zoom 6 is the defensible fallback.
    const { calls, result } = frame({ q: "united states", geo: US_GEO, bestLoc: null, points: STORY });
    expect(result.framed).toBe("place");
    expect(calls.some((c) => c.kind === "fitBounds")).toBe(false);
    const fly = calls.find((c) => c.kind === "flyTo");
    expect(fly).toBeTruthy();
    expect(fly.zoom).toBe(6);
  });
});

describe("the wiring: every search path passes the list in", () => {
  test("app.js carries an alias to the gazetteer's list", () => {
    expect(appJs).toMatch(/const isBiggerPlace = \(q\) => window\.CityEngine\?\.isBiggerPlace\?\.\(q\) \?\? false;/);
  });

  test("all four frameSearchRegion call sites pass isBiggerPlace", () => {
    // A call site that forgets it silently loses country framing on its
    // own path (the saved answer, the events fallback…) — the default
    // is safe but it is the OLD behaviour, so all four are pinned.
    expect(appJs).toMatch(/points: storyPoints\(items\), zoom, isBiggerPlace/);
    expect(appJs).toMatch(/zoom: saved\.zoom \|\| "auto",\s*\n\s*isBiggerPlace/);
    expect(appJs).toMatch(/points: pinPoints, zoom, isBiggerPlace/);
    expect(appJs).toMatch(/points: storyPoints\(pins\.pins, events\), zoom,\s*\n\s*isBiggerPlace/);
  });

  test("the framing function takes it as a PARAMETER, not a global", () => {
    // Keeping frameSearchRegion a pure function of its arguments is
    // what lets the tests run it against a stub map with no window.
    expect(appJs).toMatch(/function frameSearchRegion\(\{ q, geo, bestLoc, points, zoom, isBiggerPlace = \(\) => false \}\)/);
  });
});
