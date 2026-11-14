/**
 * World languages overlay — Glottolog.
 *
 * The invariant that matters: the overlay is POINTS, not polygons. A
 * polygon per language area can only ever show one language — where
 * several languages share a territory (Papua New Guinea, the Amazon, the
 * Caucasus) the topmost polygon hides the rest. Points overlap, so a
 * cluster reads as "many languages here" and the probe can list every
 * one of them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const langJs = readFileSync(join(ROOT, "languages-layer.js"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const builder = readFileSync(join(ROOT, "..", "scripts", "languages_build.py"), "utf8");
const DATA = join(ROOT, "data", "languages");

describe("languages overlay — registration", () => {
  test("is called Languages, not Indigenous Languages", () => {
    expect(langJs).toMatch(/LAYER_NAME:\s*"🌍 Languages"/);
    // The polygon-based overlay is gone.
    expect(langJs).not.toMatch(/Indigenous Languages/);
    expect(appJs).not.toMatch(/IndigenousLayer/);
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/window\.LanguagesLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.LanguagesLayer\.init\(map\)/);
  });

  test("loads BEFORE app.js and is stamped", () => {
    const at = indexHtml.indexOf("languages-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(bump).toMatch(/languages-layer\.js/);
    // The dead polygon overlay must not linger in either file.
    expect(indexHtml).not.toMatch(/indigenous-layer\.js/);
    expect(bump).not.toMatch(/indigenous-layer\.js/);
  });

  test("has a URL-hash slug", () => {
    expect(appJs).toMatch(/"languages"/);
  });
});

describe("languages overlay — the probe owns the click", () => {
  test("blocksClick gates the click-to-submit flow", () => {
    expect(langJs).toMatch(/function blocksClick\(\)\s*\{\s*return state\.probeMode/);
    expect(appJs).toMatch(/window\.LanguagesLayer\.blocksClick\(\)/);
  });

  test("the probe lists EVERY language at a point, not just one", () => {
    // This is the whole reason the overlay is points: several languages
    // can share a coordinate and the probe must list them all.
    expect(langJs).toMatch(/function languagesNear\(/);
    expect(langJs).toMatch(/languages here/);
    expect(langJs).toMatch(/more here/);
  });

  test("the probe radius scales with zoom", () => {
    expect(langJs).toMatch(/function probeRadius\(/);
    expect(langJs).toMatch(/getZoom\(\)/);
  });
});

describe("languages overlay — points, sized by co-location", () => {
  test("points are rendered, not polygons", () => {
    expect(langJs).toMatch(/pointToLayer/);
    expect(langJs).toMatch(/L\.circleMarker/);
    // The old polygon approach must not come back.
    expect(langJs).not.toMatch(/fillColor:\s*\(f/);
  });

  test("a point is sized by how many languages share it", () => {
    expect(langJs).toMatch(/colocated/);
    expect(langJs).toMatch(/radiusFor/);
  });

  test("colours come from the macroarea, not a per-language hash", () => {
    expect(langJs).toMatch(/macroarea/);
    expect(langJs).toMatch(/Papunesia/);
    expect(langJs).toMatch(/areaColor/);
  });

  test("renders on a canvas, not SVG (8,889 points is a lot of DOM)", () => {
    expect(langJs).toMatch(/L\.canvas/);
    expect(langJs).toMatch(/renderer:\s*state\.renderer/);
  });

  test("the layer is not interactive — the probe owns the click", () => {
    expect(langJs).toMatch(/interactive:\s*false/);
    expect(langJs).toMatch(/pointerEvents\s*=\s*"none"/);
  });
});

describe("languages overlay — the build", () => {
  test("the source is Glottolog, free and attributed", () => {
    expect(builder).toMatch(/glottolog\.org/);
    expect(builder).toMatch(/CC BY-SA 4\.0/);
    expect(builder).toMatch(/Max Planck/);
  });

  test("verify() probes known languages — a gate, not a checkpoint", () => {
    expect(builder).toMatch(/def verify\(/);
    expect(builder).toMatch(/refusing to publish/);
    // A flipped axis puts every language in the wrong ocean.
    expect(builder).toMatch(/Basque/);
    expect(builder).toMatch(/Ainu/);
    // Rare / extinct languages the old overlay could not reach.
    expect(builder).toMatch(/Aasax/);
    expect(builder).toMatch(/Yaghan/);
  });

  test("the output is a point per language, not a polygon per area", () => {
    expect(builder).toMatch(/"type":\s*"Point"/);
    expect(builder).toMatch(/colocated/);
    expect(builder).not.toMatch(/MultiPolygon/);
  });
});

describe("languages overlay — published assets", () => {
  test("meta.json carries the attribution, licence and counts", () => {
    const p = join(DATA, "meta.json");
    expect(existsSync(p)).toBe(true);
    const m = JSON.parse(readFileSync(p, "utf8"));
    expect(m.attribution).toMatch(/Glottolog/);
    expect(m.license).toMatch(/CC BY-SA/);
    expect(m.language_count).toBeGreaterThan(8000);
    expect(m.colocated_coords).toBeGreaterThan(0);
  });

  test("the geojson is one point per language", () => {
    const p = join(DATA, "languages.geojson");
    expect(existsSync(p)).toBe(true);
    const fc = JSON.parse(readFileSync(p, "utf8"));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBeGreaterThan(8000);
    for (const f of fc.features.slice(0, 200)) {
      expect(f.geometry.type).toBe("Point");
      const [lng, lat] = f.geometry.coordinates;
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
      expect(typeof f.properties.name).toBe("string");
      expect(f.properties.name.length).toBeGreaterThan(0);
    }
  });

  test("rare languages are present (the reason for switching source)", () => {
    const fc = JSON.parse(readFileSync(join(DATA, "languages.geojson"), "utf8"));
    const isos = new Set(fc.features.map((f) => f.properties.iso));
    for (const iso of ["eus", "ain", "aas", "yag", "wit"]) {
      expect(isos, `language ${iso} missing`).toContain(iso);
    }
  });
});

describe("languages layer — HUD sampling", () => {
  function loadLangs() {
    const win = {};
    const fn = new Function("window", langJs);
    fn(win);
    return win.LanguagesLayer;
  }

  test("sampleAt names the nearest language within ~28 km", () => {
    const layer = loadLangs();
    layer._state.enabled = true;
    layer._state.features = {
      features: [
        { properties: { name: "Aari" }, geometry: { type: "Point", coordinates: [36.5, 6.0] } },
        { properties: { name: "Yaghan" }, geometry: { type: "Point", coordinates: [-69.0, -55.0] } },
      ],
    };
    expect(layer.sampleAt({ lat: 6.01, lng: 36.51 })).toBe("Aari");
    expect(layer.sampleAt({ lat: -55.0, lng: -69.0 })).toBe("Yaghan");
  });

  test("sampleAt returns null beyond the threshold and when disabled", () => {
    const layer = loadLangs();
    layer._state.features = {
      features: [
        { properties: { name: "Aari" }, geometry: { type: "Point", coordinates: [36.5, 6.0] } },
      ],
    };
    layer._state.enabled = true;
    expect(layer.sampleAt({ lat: 20, lng: 20 })).toBeNull();
    layer._state.enabled = false;
    expect(layer.sampleAt({ lat: 6.0, lng: 36.5 })).toBeNull();
    expect(layer.sampleAt(null)).toBeNull();
  });
});
