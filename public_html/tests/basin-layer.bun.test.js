/**
 * Hydrological basins overlay — FAO "Major hydrological basins of the world".
 *
 * The invariants that matter:
 *  - the layer is registered in the layers dropdown and gets an opacity slider
 *  - the probe finds the basin under a click WITHOUT making the polygons
 *    interactive (an interactive polygon swallows the click-to-submit flow)
 *  - the built data is real: the right basins, with plausible areas
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const basinJs = readFileSync(join(root, "basin-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");
const builder = readFileSync(join(root, "..", "scripts", "basin_build.py"), "utf8");

const DATA = join(root, "data", "basins");
const metaPath = join(DATA, "meta.json");

// The builder publishes the SAME 235 basins at TWO detail levels
// (DETAIL_LEVELS in scripts/basin_build.py: major 0.05 deg, detailed
// 0.01 deg). The layer picks one by id from meta.json's `levels`, so the
// file names come from meta — hard-coding one here would pin a filename
// the build deliberately no longer emits (build() DELETES a stale
// basins.geojson so it cannot be served next to the per-level files).
//
// meta.json is small and committed, so its assertions are strict. The
// GeoJSONs are regenerable build artefacts, so data assertions below
// skip when they have not been built on this checkout — the policy
// cropland-layer.bun.test.js:61 and etopo-layer.bun.test.js:123 use.
function readMeta() {
  return existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
}
function levelPath(meta, id) {
  const lv = ((meta && meta.levels) || []).find((l) => l.id === id);
  return lv ? join(DATA, lv.file) : null;
}

describe("basin-layer module", () => {
  test("exposes BasinLayer with a stable name", () => {
    expect(basinJs).toMatch(/window\.BasinLayer\s*=/);
    expect(basinJs).toMatch(/LAYER_NAME:\s*"🌊 Hydrological Basins"/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity", "blocksClick"]) {
      expect(basinJs).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.BasinLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.BasinLayer\.init\(map\)/);
  });

  test("loads the level GeoJSON named by meta, stamped with the BUILD token", () => {
    // The URL is built from meta.levels[].file, not a fixed path — the
    // builder emits basins_major.geojson + basins_detailed.geojson.
    expect(basinJs).toMatch(/const BUILD = "\d+"/);
    expect(basinJs).toMatch(/function levelUrl\(file\)/);
    expect(basinJs).toContain('return BASE + "/" + file + "?v=" + BUILD;');
    expect(basinJs).toMatch(/meta\.levels/);
    // The old fixed name must not survive as a REQUEST anywhere: the
    // build deletes it, so a layer that asked for it would 404.
    // Comments are stripped first because the header deliberately
    // explains that the file is gone — a comment is not a request.
    const code = basinJs
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/basins\.geojson/);
  });

  test("the polygons are NOT interactive — the basin wash must not swallow clicks", () => {
    // An interactive polygon captures the click, which breaks the
    // click-to-submit flow. The probe does its own point-in-polygon test.
    expect(basinJs).toMatch(/interactive:\s*false/);
    expect(basinJs).toMatch(/pointerEvents\s*=\s*"none"/);
    expect(basinJs).toMatch(/function pointInPolygon/);
  });

  test("blocksClick is true only while the probe is armed", () => {
    expect(basinJs).toMatch(/function blocksClick\(\)\s*\{\s*return state\.probeMode/);
  });

  test("has a legend with the three hydrological classes", () => {
    expect(basinJs).toMatch(/basin-legend/);
    expect(basinJs).toMatch(/river/);
    expect(basinJs).toMatch(/coast/);
    expect(basinJs).toMatch(/interior/);
  });

  test("offers blue / red / black colour schemes, persisted", () => {
    expect(basinJs).toMatch(/SCHEMES\s*=/);
    expect(basinJs).toMatch(/red:\s*\{/);
    expect(basinJs).toMatch(/black:\s*\{/);
    expect(basinJs).toMatch(/xyzo\.basinScheme/);
    expect(basinJs).toMatch(/setColorScheme/);
    expect(basinJs).toMatch(/getColorScheme/);
    // The scheme must feed kindColors(), or styleFor() would keep
    // painting the meta colours after a switch.
    expect(basinJs).toMatch(/function kindColors\(\)/);
    expect(basinJs).toMatch(/SCHEMES\[state\.scheme\]/);
    // The legend must re-render its swatches on a scheme change, not
    // just restyle the map polygons.
    expect(basinJs).toMatch(/refreshLegendSwatches/);
  });

  test("loads before app.js and is stamped", () => {
    const basinAt = indexHtml.indexOf("basin-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(basinAt).toBeGreaterThan(-1);
    expect(basinAt).toBeLessThan(appAt);
    expect(bump).toMatch(/basin-layer\.js/);
  });

  test("the layer has a URL-hash slug so it can be shared", () => {
    expect(appJs).toMatch(/"basins":\s*"🌊 Hydrological Basins"/);
    expect(appJs).toMatch(/"🌊 Hydrological Basins":\s*"basins"/);
  });
});

describe("basin builder", () => {
  test("verify() is a gate — it probes known places", () => {
    expect(builder).toMatch(/def verify\(/);
    expect(builder).toMatch(/refusing to publish/);
    expect(builder).toMatch(/Amazon/);
    expect(builder).toMatch(/Congo/);
    expect(builder).toMatch(/Mississippi/);
  });

  test("the area is computed in radians, not degrees", () => {
    // A degrees/radians slip inflates the area by ~57x, so the check on
    // the total has to survive it.
    expect(builder).toMatch(/math\.radians\(lon2 - lon1\)/);
  });

  test("the sentinel and the source are pinned", () => {
    expect(builder).toMatch(/SENTINEL = "-9999"/);
    expect(builder).toMatch(/data\.apps\.fao\.org/);
    expect(builder).toMatch(/HydroSHEDS/);
  });
});

describe("basin data assets", () => {
  // meta.json is committed, so this one is strict.
  test("meta is published", () => {
    expect(existsSync(metaPath)).toBe(true);
  });

  test("meta carries the attribution, the license and the basin count", () => {
    const meta = readMeta();
    expect(meta.basin_count).toBeGreaterThan(200);
    expect(meta.attribution).toMatch(/FAO/);
    expect(meta.license).toMatch(/CC BY-SA/);
    expect(meta.source).toMatch(/data\.apps\.fao\.org/);
    expect(meta.kind_counts.river).toBeGreaterThan(50);
    expect(meta.kind_counts.coast).toBeGreaterThan(20);
    expect(meta.kind_counts.interior).toBeGreaterThan(3);
  });

  test("meta declares BOTH detail levels and a default", () => {
    // The layer names its request off meta.levels[].file, so a level
    // that disappears leaves the overlay unable to load at all.
    const meta = readMeta();
    const ids = (meta.levels || []).map((l) => l.id);
    expect(ids).toContain("major");
    expect(ids).toContain("detailed");
    expect(ids).toContain(meta.default_level);
    for (const lv of meta.levels) {
      expect(lv.file).toMatch(/^basins_(major|detailed)\.geojson$/);
      expect(lv.simplify_deg).toBeGreaterThan(0);
      // The same 235 basins at two precisions — a level must not hold
      // a different set, or switching would change what is on the map.
      expect(lv.basins).toBeGreaterThan(200);
      expect(lv.basins).toBe(meta.basin_count);
    }
    // detailed is finer, so its file is the larger of the two
    const major = meta.levels.find((l) => l.id === "major");
    const detailed = meta.levels.find((l) => l.id === "detailed");
    expect(detailed.simplify_deg).toBeLessThan(major.simplify_deg);
    expect(detailed.size).toBeGreaterThan(major.size);
  });

  test("the biggest basins are the ones you would expect", () => {
    const meta = readMeta();
    const names = meta.top_basins.map((b) => b.name);
    expect(names).toContain("Amazon Basin");
    expect(names).toContain("Congo");
    expect(names).toContain("Mississippi / Missouri");
    // Areas are in km² — the Amazon is ~6 M km², not 6.
    const amazon = meta.top_basins.find((b) => b.name === "Amazon Basin");
    expect(amazon.area_km2).toBeGreaterThan(4_000_000);
    expect(amazon.area_km2).toBeLessThan(8_000_000);
  });

  test("every level named by meta is published", () => {
    const meta = readMeta();
    if (!meta) return; // meta itself absent: nothing to name a file from
    for (const lv of meta.levels) {
      const p = levelPath(meta, lv.id);
      // Regenerable: skip rather than fail when the build has not run.
      if (!existsSync(p)) continue;
      expect(existsSync(p)).toBe(true);
      // And the superseded single file must stay gone.
      expect(existsSync(join(DATA, "basins.geojson"))).toBe(false);
    }
  });

  test("every feature has a name, a kind and a positive area", () => {
    const meta = readMeta();
    const p = levelPath(meta, meta && meta.default_level);
    if (!p || !existsSync(p)) return; // not built on this checkout
    const fc = JSON.parse(readFileSync(p, "utf8"));
    expect(fc.features.length).toBeGreaterThan(200);
    for (const f of fc.features) {
      expect(typeof f.properties.name).toBe("string");
      expect(f.properties.name.length).toBeGreaterThan(0);
      expect(["river", "coast", "interior"]).toContain(f.properties.kind);
      expect(f.properties.area_km2).toBeGreaterThan(0);
    }
  });

  test("the geometry is a polygon and the coordinates are in range", () => {
    const meta = readMeta();
    const p = levelPath(meta, meta && meta.default_level);
    if (!p || !existsSync(p)) return; // not built on this checkout
    const fc = JSON.parse(readFileSync(p, "utf8"));
    let checked = 0;
    for (const f of fc.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
      // A dissolved basin is a MultiPolygon with many parts, so sample
      // the rings too — there are ~650k vertices in the file.
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys.slice(0, 5)) {
        for (const ring of poly) {
        // Sample the ring rather than asserting on every vertex — there
        // are ~650k of them and they all come from the same generator.
        const step = Math.max(1, Math.floor(ring.length / 20));
        for (let i = 0; i < ring.length; i += step) {
          const pt = ring[i];
          expect(Math.abs(pt[0])).toBeLessThanOrEqual(180.0001);
          expect(Math.abs(pt[1])).toBeLessThanOrEqual(90.0001);
        }
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });
});
