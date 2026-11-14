// new-features.bun.test.js — the contract for everything added on
// 2026-11-04, in ONE place.
//
// The features: the earthQUAKES overlay, the TECTONIC FAULTS overlay,
// the LANGUAGE REGIONS overlay, the LIVE OCEAN CURRENTS animation, the
// globe's WIND + WIND SPEED + CURRENTS + EARTHQUAKES + FAULTS +
// REGIONS, the SHARED HOVER RING, the DISMISSIBLE offline notice, the
// IMAGE-PROXY PLACEHOLDER, the new DEFAULT map, and the isobar
// module's load-order fix.
//
// These are CONTRACT tests — they read the shipped source and the
// published data, so they fail the moment a feature is renamed,
// dropped, or quietly broken. The RUNTIME behaviour is measured by
// the Playwright audits beside them:
//
//   scripts/ocean_current_audit.py   the currents, four ways in
//   scripts/hover_audit.py           the pointer, on every kind of thing
//   scripts/globe_wind_audit.py      the globe's wind
//   scripts/offline_notice_audit.py  the notice's X
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const readUp = (f) => readFileSync(join(ROOT, "..", f), "utf8");

const appJs = read("app.js");
const globeJs = read("globe.js");
const quakeJs = read("earthquake-layer.js");
const faultJs = read("fault-layer.js");
const regionsJs = read("languages-regions-layer.js");
const oceanJs = read("ocean-current-layer.js");
const ringJs = read("hover-ring.js");
const hudJs = read("hover-info.js");
const offlineJs = read("offline.js");
const bakeJs = read("field-bake.js");
const globeWindJs = read("globe-wind.js");
const presetsJs = read("map-presets.js");
const indexHtml = read("index.html");
const globeHtml = read("globe.html");
const proxyTs = readUp("api/src/routes/imageProxy.ts");

/**
 * The APP's own slug function, extracted and evaluated.
 *
 * The slug a layer gets in the URL is `getLayerSlug(displayName)` —
 * the emoji stripped, the rest lower-cased and dash-joined. A test
 * that re-implements that rule is a SECOND source of truth, and the
 * two drift: the app then writes a hash the test cannot read, or the
 * test passes while the app writes a broken link.
 *
 * So the function is lifted out of app.js verbatim and run.
 */
function extractGetLayerSlug(src) {
  const start = src.indexOf("function getLayerSlug(fullName) {");
  expect(start, "app.js must have getLayerSlug()").toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end + 2);

  // The function reads REVERSE_LAYER_SLUGS — the hand-written map
  // from a display name to the slug the URL uses. It is extracted
  // too, so the app's own table decides the answer.
  const revStart = src.indexOf("const REVERSE_LAYER_SLUGS = {");
  expect(revStart, "app.js must have REVERSE_LAYER_SLUGS").toBeGreaterThan(-1);
  const revEnd = src.indexOf("\n};", revStart);
  const revBody = src.slice(revStart, revEnd + 3);

  // eslint-disable-next-line no-new-func
  const fn = new Function(revBody + "\n" + body + "; return getLayerSlug;")();
  return fn;
}

describe("the earthQUAKES overlay", () => {
  test("the layer exists, is registered and is on the globe too", () => {
    expect(quakeJs).toMatch(/window\.EarthquakeLayer\s*=/);
    expect(appJs).toContain('window.EarthquakeLayer.LAYER_NAME');
    expect(appJs).toContain('"earthquakes": "🌐 Earthquakes (USGS)"');
    expect(globeJs).toMatch(/key:\s*"earthquakes"/);
  });

  test("it is served from OUR OWN files, never from USGS", () => {
    // The browser must not poll the USGS feed.
    expect(quakeJs).toContain('const BASE = "/data/earthquakes"');
    expect(quakeJs).not.toMatch(/fetch\(\s*"https:\/\/earthquake\.usgs\.gov/);
    // ...and the four windows are published.
    for (const w of ["hour", "day", "week", "month"]) {
      expect(existsSync(join(ROOT, "data", "earthquakes", w + ".geojson"))).toBe(true);
    }
  });

  test("the circle grows with the magnitude and cools with the age", () => {
    expect(quakeJs).toMatch(/function radiusForMag\(/);
    expect(quakeJs).toMatch(/function colorForAge\(/);
    // red under an hour, orange under a day, yellow under a week
    expect(quakeJs).toMatch(/"#ff2d2d"/);
    expect(quakeJs).toMatch(/"#ff7a1a"/);
    expect(quakeJs).toMatch(/"#ffd21f"/);
  });

  test("the popup links straight to the USGS event page", () => {
    expect(quakeJs).toContain("earthquakes/eventpage");
    expect(quakeJs).toContain("exec");
  });

  test("the published catalogue is real", () => {
    const meta = JSON.parse(read("data/earthquakes/meta.json"));
    expect(meta.license).toBeTruthy();
    expect(meta.attribution).toBeTruthy();
    expect(meta.counts.month).toBeGreaterThan(meta.counts.week);
    expect(meta.counts.week).toBeGreaterThan(meta.counts.day);
    const week = JSON.parse(read("data/earthquakes/week.geojson"));
    expect(week.features.length).toBeGreaterThan(100);
    for (const f of week.features.slice(0, 20)) {
      expect(typeof f.properties.mag).toBe("number");
      expect(typeof f.properties.time).toBe("number");
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("the TECTONIC FAULTS overlay", () => {
  test("the layer exists and is registered", () => {
    expect(faultJs).toMatch(/window\.FaultLayer\s*=/);
    expect(appJs).toContain('window.FaultLayer.LAYER_NAME');
    expect(globeJs).toMatch(/key:\s*"faults"/);
  });

  test("the published fault lines are real and carry the USGS credit", () => {
    const meta = JSON.parse(read("data/faults/meta.json"));
    expect(meta.license).toBeTruthy();
    expect(meta.attribution).toMatch(/USGS/i);
    const fc = JSON.parse(read("data/faults/faults.geojson"));
    expect(fc.features.length).toBeGreaterThan(1000);
    expect(fc.features[0].geometry.type).toMatch(/LineString/);
  });
});

describe("the LANGUAGE REGIONS overlay", () => {
  test("the layer exists and the regions are published", () => {
    expect(regionsJs).toMatch(/window\.LanguagesRegionsLayer\s*=/);
    expect(appJs).toContain('window.LanguagesRegionsLayer.LAYER_NAME');
    expect(globeJs).toMatch(/key:\s*"language-regions"/);
    const meta = JSON.parse(read("data/languages/meta.json"));
    expect(meta.regions).toBeTruthy();
    expect(meta.regions.region_count).toBeGreaterThan(100);
    expect(meta.regions.license).toBeTruthy();
  });

  test("each region carries the languages spoken there", () => {
    const fc = JSON.parse(read("data/languages/regions.geojson"));
    expect(fc.features.length).toBeGreaterThan(100);
    const withLanguages = fc.features.filter((f) => (f.properties.languages || []).length > 0);
    expect(withLanguages.length).toBeGreaterThan(50);
    expect(withLanguages[0].properties.languages[0]).toHaveProperty("name");
  });
});

describe("the LIVE ocean currents", () => {
  test("the grid is published as a u/v PAIR with a ramp", () => {
    const meta = JSON.parse(read("data/ocean/meta.json"));
    expect(meta.grid.layout).toBe("planar_uv");
    expect(meta.grid.cols).toBe(360);
    expect(meta.grid.rows).toBe(161);
    expect(meta.ramp.length).toBeGreaterThan(3);
    // BRIGHT AT BOTH ENDS — a ramp with a dark end is invisible on a
    // dark basemap, and most of the ocean is slow.
    expect(meta.ramp[0].rgb).not.toMatch(/^#0[0-9a-f]{5}$/);
    expect(meta.license).toBeTruthy();
  });

  test("the layer is registered on both views", () => {
    expect(oceanJs).toMatch(/window\.OceanCurrentLayer\s*=/);
    expect(appJs).toContain('window.OceanCurrentLayer.LAYER_NAME');
    expect(globeJs).toMatch(/key:\s*"ocean-current"/);
    expect(globeJs).toMatch(/source:\s*"ocean"/);
  });

  test("the wet-cell list is only cached once it is BUILT", () => {
    // An empty array is truthy, so caching "nothing yet" would poison
    // the list for ever and the layer would seed zero particles.
    expect(oceanJs).toMatch(/if \(wetCells && wetCells\.length\) return wetCells;/);
    expect(oceanJs).toMatch(/wetCells = null;/);
  });

  test("it follows the wind layer's physics", () => {
    expect(oceanJs).toMatch(/const x1 = \(x0 \+ 1\) % g\.cols/);
    expect(oceanJs).toMatch(/cosLat/);
    expect(oceanJs).toMatch(/if \(acc >= TRAIL_PX\)/);
  });
});

describe("the globe's new overlays", () => {
  test("the wind, the speed field and the currents are all there", () => {
    expect(globeJs).toMatch(/key:\s*"wind-speed"/);
    expect(globeJs).toMatch(/key:\s*"wind"/);
    expect(globeJs).toMatch(/key:\s*"ocean-current"/);
    expect(globeJs).toMatch(/key:\s*"earthquakes"/);
    expect(globeJs).toMatch(/key:\s*"faults"/);
    expect(globeJs).toMatch(/key:\s*"language-regions"/);
  });

  test("EACH animation has its own controller", () => {
    // One variable for two animations means the second one wins and the
    // first is unreachable — switching the wind on switched the ocean
    // currents on instead.
    expect(globeJs).toMatch(/const windControllers = \{\}/);
    expect(globeJs).toMatch(/windControllers\[o\.key\] = ctrl/);
    expect(globeJs).not.toMatch(/if \(windController\)/);
  });

  test("the globe HAS a logger", () => {
    // Without console-guard.js every failure in a globe module is
    // completely silent.
    expect(globeHtml).toContain("console-guard.js");
    expect(globeWindJs).toMatch(/window\.XYZO_GLOBE_WIND/);
  });

  test("the globe's gridded fields are baked in MERCATOR", () => {
    expect(bakeJs).toMatch(/const LAT_LIMIT = 85\.051129/);
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.bakeMercator/);
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.mercatorQuad\(\)/);
  });
});

describe("the shared hover ring", () => {
  test("there is ONE ring and every layer asks it to move", () => {
    expect(ringJs).toMatch(/window\.HoverRing\s*=/);
    expect(appJs).toMatch(/window\.HoverRing\.show\(/);
    expect(quakeJs).toMatch(/window\.HoverRing\.show\(/);
    // The pin renderer must not create a SECOND element with the same
    // class — and it must not REMOVE the shared one either, or
    // switching the markers off takes the ring away from the
    // earthquakes and the faults as well.
    expect(appJs).not.toMatch(/className = "xyzo-pin-hover-ghost/);
    expect(appJs).not.toMatch(/this\._ghost\.remove\(\)/);
    expect(appJs).toMatch(/window\.HoverRing\.hide\("pin"\)/);
  });

  test("no Leaflet canvas renderer may swallow the pointer", () => {
    // L.canvas() without a pane lands in the overlay pane — ON TOP of
    // the story-pin canvas — and eats every pointer event on the map.
    for (const f of ["earthquake-layer.js", "languages-layer.js", "fault-layer.js"]) {
      const src = read(f);
      const calls = [...src.matchAll(/L\.canvas\(\{([^}]*)\}/g)];
      expect(calls.length, f + " must have a canvas renderer").toBeGreaterThan(0);
      for (const c of calls) expect(c[1], f).toMatch(/pane:\s*[A-Z_]+/);
    }
  });

  test("the card can say what is under the cursor", () => {
    expect(hudJs).toMatch(/function setTarget\(/);
    expect(hudJs).toMatch(/setTarget: setTarget/);
    expect(quakeJs).toMatch(/HoverInfo\.setTarget\(/);
  });
});

describe("the dismissible offline notice", () => {
  test("the notice carries an X, and dismissing it stops it coming back", () => {
    expect(offlineJs).toMatch(/DISMISS_BUTTON/);
    expect(offlineJs).toMatch(/sessionStorage\.setItem\(DISMISS_KEY, "1"\)/);
    expect(offlineJs).toMatch(/if \(isDismissed\(\)\) return;/);
  });
});

describe("a dead picture is not a console error", () => {
  test("the proxy answers a missing picture with a placeholder", () => {
    expect(proxyTs).toMatch(/function placeholder\(/);
    expect(proxyTs).toMatch(/PLACEHOLDER_PNG/);
    // The client hides a placeholder-sized image.
    expect(appJs).toMatch(/function imgOnLoad\(/);
  });
});

describe("the default map", () => {
  test("the Earth portrait preset is the owner's link, verbatim", () => {
    // Owner spec 2026-11-08: *"might be nice to have a default
    // starting map on 'first load' for normal 'fast computer' users
    // something like this.. or if they click [the 🌍 Earth portrait
    // chip]"* — with their link.
    expect(presetsJs).toContain(
      "#2.1967,16.8750,3/density=max/overlay=wind-gfs@100,basins@100," +
      "koppen@100,soil-soilgrids@65,rivers@100,cropland-esa@50," +
      "population-density-worldpop-1-km@25,land-cover-esa@60,isobars@100," +
      "soil-type-hwsd-v2-2@30,wind-speed-gfs@30,tectonic-faults-usgs@100," +
      "nasa-rain@30,etopo@55/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed");
  });

  test("every overlay in it resolves to a real layer", () => {
    // The hash is a CONTRACT: a slug that no longer resolves is a
    // silent no-op in the URL bar, and the first-visit map quietly
    // loses an overlay.
    //
    // The resolution is NOT "the slug appears in app.js". A slug can
    // be an explicit LAYER_SLUGS key, OR it can be the DERIVED slug
    // of a layer's display name — which is how
    // "population-density-worldpop-1-km" resolves (it is the slug of
    // "🧍 Population density (WorldPop, 1 km)").
    //
    // So the test uses the APP'S OWN slug function (extracted from
    // app.js and evaluated, so there is exactly ONE implementation)
    // over the display names read from the source.
    const getLayerSlug = extractGetLayerSlug(appJs);
    const names = new Set();
    // ...the explicit LAYER_SLUGS values.
    for (const m of appJs.matchAll(/"([a-z0-9-]+)"\s*:\s*"([^"]+)"/g)) {
      names.add(m[2]);
    }
    // ...and every layer module's LAYER_NAME.
    for (const f of readdirSync(join(ROOT)).filter((n) => n.endsWith("-layer.js"))) {
      const src = read(f);
      for (const m of src.matchAll(/LAYER_NAME\s*:\s*"([^"]+)"/g)) names.add(m[1]);
      for (const m of src.matchAll(/LAYER_NAME\s*=\s*"([^"]+)"/g)) names.add(m[1]);
    }
    const known = new Set();
    for (const n of names) known.add(getLayerSlug(n));
    // ...and the explicit slugs themselves.
    for (const m of appJs.matchAll(/"([a-z0-9-]+)"\s*:\s*"([^"]+)"/g)) known.add(m[1]);

    for (const slug of [
      "wind-gfs", "basins", "koppen", "soil-soilgrids", "rivers",
      "cropland-esa", "population-density-worldpop-1-km", "land-cover-esa",
      "isobars", "soil-type-hwsd-v2-2", "wind-speed-gfs",
      "tectonic-faults-usgs", "nasa-rain", "etopo",
    ]) {
      expect(known.has(slug), slug + " must resolve to a real layer").toBe(true);
    }
  });
});

describe("the isobar module EVALUATES", () => {
  test("COLOUR_CHOICES is declared BEFORE the state literal", () => {
    // A `const` below its use is in its temporal dead zone: the whole
    // module throws at load and not one line of it runs — no layer, no
    // isobars, and an error the console-guard let through.
    const src = read("isobar-layer.js");
    const choices = src.indexOf("const COLOUR_CHOICES");
    const state = src.indexOf("const state = {");
    expect(choices).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(-1);
    expect(choices).toBeLessThan(state);
    // ...and declared exactly once (a duplicate is a SyntaxError).
    expect((src.match(/const COLOUR_CHOICES\b/g) || []).length).toBe(1);
  });
});

describe("every new module is LOADED, and STAMPED", () => {
  test("the new files are in index.html", () => {
    for (const f of [
      "field-bake.js", "hover-ring.js", "earthquake-layer.js",
      "fault-layer.js", "languages-regions-layer.js", "ocean-current-layer.js",
    ]) {
      expect(indexHtml, f).toContain(f);
    }
  });

  test("and the globe's own files are in globe.html", () => {
    for (const f of ["field-bake.js", "globe-wind.js", "console-guard.js"]) {
      expect(globeHtml, f).toContain(f);
    }
  });

  test("and bump_frontend.sh stamps them", () => {
    const bump = readUp("scripts/bump_frontend.sh");
    for (const f of [
      "field-bake.js", "hover-ring.js", "earthquake-layer.js",
      "fault-layer.js", "languages-regions-layer.js", "ocean-current-layer.js",
    ]) {
      expect(bump, f).toContain(f);
    }
  });
});
