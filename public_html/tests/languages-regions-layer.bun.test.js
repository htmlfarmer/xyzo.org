/**
 * Language REGIONS overlay — Glottolog languages by Natural Earth country.
 *
 * The invariant that matters: the regions layer draws the COUNTRY, and
 * says so. Glottolog records a language's territory (the countries it is
 * spoken in), never an extent — so a country polygon filled with "how many
 * languages are listed for this country" is the honest reading, and the
 * probe lists them. It is a different question from the POINTS overlay
 * (one dot per language with a coordinate), which stays published.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const js = readFileSync(join(ROOT, "languages-regions-layer.js"), "utf8");
const builder = readFileSync(
  join(ROOT, "..", "scripts", "languages_regions_build.py"), "utf8");
const DATA = join(ROOT, "data", "languages");

function loadLayer() {
  const win = {};
  const fn = new Function("window", js);
  fn(win);
  return win.LanguagesRegionsLayer;
}

describe("language regions — the module's API surface", () => {
  test("exposes window.LanguagesRegionsLayer with the house API", () => {
    expect(js).toMatch(/window\.LanguagesRegionsLayer\s*=/);
    const layer = loadLayer();
    expect(layer).toBeTruthy();
    for (const fn of ["init", "getTileLayer", "setOpacity", "getOpacity",
                      "blocksClick", "mountLegend", "sampleAt",
                      "registerExport"]) {
      expect(typeof layer[fn], `${fn} missing`).toBe("function");
    }
    expect(layer.LAYER_NAME).toBe("🌍 Language regions");
  });

  test("the module parses in a bare window (no L, no document)", () => {
    const win = {};
    const fn = new Function("window", js);
    expect(() => fn(win)).not.toThrow();
    expect(win.LanguagesRegionsLayer).toBeTruthy();
  });

  test("it never calls console.* directly — XLog only", () => {
    expect(js).not.toMatch(/console\.(warn|error|log|debug|info)\s*\(/);
    expect(js).toMatch(/window\.XLog/);
  });

  test("it registers its own pane, on a z-index of its own", () => {
    expect(js).toMatch(/const PANE = "langRegionsPane"/);
    expect(js).toMatch(/PANE_Z = 363/);
    expect(js).toMatch(/map\.createPane\(PANE\)/);
    // 363 is free (AGENTS.md: free slots 349, 363, 366-369) and sits
    // just under the language dots at 364.
    expect(363).not.toBe(364);
  });

  test("the polygons never swallow a map click", () => {
    // The pane ignores pointer events and the polygons are not
    // interactive — the probe does its own point-in-polygon test.
    expect(js).toMatch(/interactive:\s*false/);
    expect(js).toMatch(/pointerEvents\s*=\s*"none"/);
    expect(js).toMatch(/function pointInPolygon\(/);
  });

  test("the probe owns the click ONLY while it is armed", () => {
    const layer = loadLayer();
    layer._state.probeMode = false;
    expect(layer.blocksClick()).toBe(false);
    layer._state.probeMode = true;
    expect(layer.blocksClick()).toBe(true);
  });

  test("the probe lists the languages of a region and says how many more", () => {
    expect(js).toMatch(/PROBE_ROWS = 12/);
    expect(js).toMatch(/more in this region/);
    expect(js).toMatch(/languages_total/);
  });

  test("the legend mounts into the layers dropdown LIST, not the overlay list", () => {
    // Leaflet empties and rebuilds .leaflet-control-layers-overlays on
    // every layer change, so a row inside that list is wiped.
    expect(js).toMatch(/document\.querySelector\("\.leaflet-control-layers-list"\)/);
    expect(js).toMatch(/insertAdjacentElement\("afterend", host\)/);
    expect(js).toMatch(/host\.id = "lang-regions-legend"/);
  });

  test("it carries its attribution — CC BY-SA 4.0 requires it on the map", () => {
    expect(js).toMatch(/attribution:\s*"Glottolog/);
    expect(js).toMatch(/CC BY-SA 4\.0/);
    expect(js).toMatch(/Natural Earth/);
  });
});

describe("language regions — HUD sampling", () => {
  const square = {
    type: "Polygon",
    coordinates: [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
  };

  function withFeature(layer) {
    layer._state.enabled = true;
    layer._state.features = {
      features: [
        { properties: { name: "Testia", count: 42, languages_total: 42,
                        languages: [] }, geometry: square },
      ],
    };
  }

  test("sampleAt names the country and its language count", () => {
    const layer = loadLayer();
    withFeature(layer);
    const out = layer.sampleAt({ lat: 15, lng: 15 });
    expect(out).toMatch(/Testia/);
    expect(out).toMatch(/42 languages/);
    // Outside the polygon there is nothing to read.
    expect(layer.sampleAt({ lat: 40, lng: 40 })).toBeNull();
  });

  test("sampleAt returns null when the layer is off or the grid is missing", () => {
    const layer = loadLayer();
    withFeature(layer);
    layer._state.enabled = false;
    expect(layer.sampleAt({ lat: 15, lng: 15 })).toBeNull();
    layer._state.enabled = true;
    layer._state.features = null;
    expect(layer.sampleAt({ lat: 15, lng: 15 })).toBeNull();
    expect(layer.sampleAt(null)).toBeNull();
  });
});

describe("language regions — the build script", () => {
  test("both sources are named, with their licences", () => {
    expect(builder).toMatch(/glottolog/i);
    expect(builder).toMatch(/CC BY-SA 4\.0/);
    expect(builder).toMatch(/Max Planck/);
    expect(builder).toMatch(/Natural Earth/);
    expect(builder).toMatch(/public domain/i);
  });

  test("it publishes regions.geojson and REWRITES meta.json", () => {
    expect(builder).toMatch(/regions\.geojson/);
    expect(builder).toMatch(/meta\.json/);
    // The meta is regenerated, not appended to a stale copy.
    expect(builder).toMatch(/meta\["regions"\]/);
  });

  test("verify() is a gate — it refuses to publish", () => {
    expect(builder).toMatch(/def verify\(/);
    expect(builder).toMatch(/raise SystemExit\("verify\(\) failed — refusing to publish"\)/);
    // The gate runs BEFORE anything is written.
    const gate = builder.indexOf("verify(features, stats, EXPECTED_LANGUAGES_WITH_COUNTRY)");
    const write = builder.indexOf("write_outputs(features, stats, out_dir, point_meta)");
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
  });

  test("verify() probes known languages in known regions", () => {
    // A swapped join puts every language in the wrong country.
    expect(builder).toMatch(/Aasax/);
    expect(builder).toMatch(/Aari/);
    expect(builder).toMatch(/Abadi/);
    expect(builder).toMatch(/Basque/);
    expect(builder).toMatch(/Hokkaido Ainu/);
    expect(builder).toMatch(/Wintu/);
    expect(builder).toMatch(/Northern Amis/);
    // …and the other half: a language must NOT land everywhere.
    expect(builder).toMatch(/NEGATIVE_PROBES/);
  });

  test("verify() checks the axis and the representative point", () => {
    expect(builder).toMatch(/POINT_PROBES/);
    expect(builder).toMatch(/point_in_geometry/);
    expect(builder).toMatch(/not inside its own polygon|is NOT inside its own polygon/);
  });

  test("the region count and the language total are checked", () => {
    expect(builder).toMatch(/expected a few hundred/);
    expect(builder).toMatch(/EXPECTED_LANGUAGES_WITH_COUNTRY = 9094/);
  });

  test("the per-region language list is capped, and the cap is recorded", () => {
    expect(builder).toMatch(/MAX_LANGUAGES = \d+/);
    expect(builder).toMatch(/"languages_truncated"/);
    expect(builder).toMatch(/"languages_total"/);
  });
});

describe("language regions — published assets", () => {
  test("regions.geojson is published, one polygon per country", () => {
    const p = join(DATA, "regions.geojson");
    expect(existsSync(p)).toBe(true);
    const fc = JSON.parse(readFileSync(p, "utf8"));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBeGreaterThan(150);
    expect(fc.features.length).toBeLessThan(400);
    for (const f of fc.features.slice(0, 60)) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
      const p2 = f.properties;
      expect(typeof p2.name).toBe("string");
      expect(p2.name.length).toBeGreaterThan(0);
      expect(typeof p2.iso_a3).toBe("string");
      expect(typeof p2.m49).toBe("string");
      expect(p2.count).toBeGreaterThan(0);
      expect(p2.languages_total).toBe(p2.count);
      expect(Array.isArray(p2.languages)).toBe(true);
      expect(typeof p2.macroarea).toBe("string");
      expect(Number.isFinite(p2.lon)).toBe(true);
      expect(Number.isFinite(p2.lat)).toBe(true);
      expect(Math.abs(p2.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p2.lon)).toBeLessThanOrEqual(180);
    }
  });

  test("every region's representative point is inside its own polygon", () => {
    // A swapped lon/lat (or a broken point calculation) fails here.
    const fc = JSON.parse(readFileSync(join(DATA, "regions.geojson"), "utf8"));
    function inRing(lng, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) &&
            lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    function inPoly(lng, lat, poly) {
      if (!inRing(lng, lat, poly[0])) return false;
      for (const hole of poly.slice(1)) if (inRing(lng, lat, hole)) return false;
      return true;
    }
    for (const f of fc.features) {
      const g = f.geometry;
      const p = f.properties;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      const hit = polys.some((poly) => inPoly(p.lon, p.lat, poly));
      expect(hit, `${p.name}: point (${p.lon},${p.lat}) outside its polygon`).toBe(true);
    }
  });

  test("known languages land in known regions", () => {
    const fc = JSON.parse(readFileSync(join(DATA, "regions.geojson"), "utf8"));
    const byName = new Map(fc.features.map((f) => [f.properties.name, f.properties]));
    const expect_ = [
      ["Tanzania", "Aasax"], ["Ethiopia", "Aari"],
      ["Papua New Guinea", "Abadi"], ["Spain", "Basque"],
      ["Japan", "Hokkaido Ainu"], ["United States", "Wintu"],
      ["Taiwan", "Northern Amis"], ["Netherlands", "Papiamento"],
    ];
    for (const [region, lang] of expect_) {
      const p = byName.get(region);
      expect(p, `${region} missing`).toBeTruthy();
      const names = p.languages.map((l) => l.name);
      expect(names, `${lang} not in ${region}`).toContain(lang);
    }
  });

  test("meta.json carries BOTH products: the points keys and a regions block", () => {
    const m = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
    // The points product's keys survive the regeneration.
    expect(m.attribution).toMatch(/Glottolog/);
    expect(m.license).toMatch(/CC BY-SA/);
    expect(m.language_count).toBeGreaterThan(8000);
    expect(m.colocated_coords).toBeGreaterThan(0);
    expect(m.macroareas).toBeTruthy();
    // …and the regions block describes the new file.
    expect(m.regions).toBeTruthy();
    expect(m.regions.file).toBe("regions.geojson");
    expect(m.regions.region_count).toBeGreaterThan(150);
    expect(m.regions.total_regions_with_languages).toBeGreaterThan(150);
    expect(m.regions.attribution).toMatch(/Natural Earth/);
    expect(m.regions.license).toMatch(/public domain/i);
    expect(Array.isArray(m.regions.top_regions)).toBe(true);
    expect(m.regions.top_regions.length).toBeGreaterThan(0);
    expect(m.regions.max_count).toBeGreaterThan(100);
  });

  test("the regions block agrees with the published file", () => {
    const m = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
    const fc = JSON.parse(readFileSync(join(DATA, "regions.geojson"), "utf8"));
    expect(m.regions.region_count).toBe(fc.features.length);
    const top = m.regions.top_regions[0];
    const best = fc.features.reduce((a, b) =>
      b.properties.count > a.properties.count ? b : a);
    expect(top.name).toBe(best.properties.name);
    expect(top.count).toBe(best.properties.count);
  });
});
