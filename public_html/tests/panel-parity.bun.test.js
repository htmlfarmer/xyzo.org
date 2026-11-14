// panel-parity.bun.test.js — the flat map and the 3D globe must offer the
// same layers, under the same names, with the same default opacity.
//
// WHY THIS EXISTS
// ───────────────
// The two views are separate pages with separate overlay tables
// (WEATHER_OVERLAYS in app.js, OVERLAYS in globe.js), and they had
// silently drifted:
//
//   • Two SHARED overlays were renamed in one view only. The globe said
//     "🛰️ NASA Satellite" where the flat map says "🛰️ NASA Satellite
//     (True Color)", and "🌧️ NASA Rain Rate" vs "… (IMERG)". A user
//     comparing the two panels — or comparing a panel to a shared link —
//     saw two different layers.
//   • Three SHARED overlays opened at a different opacity in 3D:
//     temperature 0.9 → 0.55, magnetic 0.9 → 0.8, lightning 0.9 → 0.85.
//     Same overlay, same slider, visibly different result.
//
// Neither is a crash, which is exactly why neither was noticed: the globe
// has always been allowed to have FEWER overlays, so "the globe differs"
// was treated as normal and every difference hid behind it.
//
// WHAT IT ASSERTS
// ───────────────
//   1. Every overlay the globe offers must exist on the flat map, under
//      an IDENTICAL label and with an IDENTICAL default opacity.
//   2. Every flat-map overlay the globe does NOT offer must be listed in
//      NOT_PORTED below, with a reason. An overlay added to the flat map
//      and forgotten here fails the build until someone decides.
//   3. The two hash vocabularies must round-trip for every shared
//      overlay — including the opacity suffix.
//
// The flat-map side is read from the source of truth (app.js registration
// sites + each layer module), not from a hand-copied table, so a new
// overlay is picked up automatically and must then be justified.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const handoffJs = readFileSync(join(ROOT, "view-handoff.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

// ── the globe's table: the one reliable side ────────────────────────────
// Split the array into ENTRIES first, then read key/label/opacity out of
// each. A sliding character window looks simpler but breaks on basins,
// whose entry carries a long comment about its two detail levels — the
// window ran out before it reached `opacity`, so basins silently
// disappeared from the parity check and its real drift hid behind that.
function globeOverlays() {
  const start = globeJs.indexOf("const OVERLAYS");
  const end = globeJs.indexOf("\n  ];", start);
  const block = globeJs.slice(start, end);
  return block
    .split(/\n    \},/)
    .map((entry) => {
      const key = entry.match(/key: "([^"]+)"/);
      const label = entry.match(/label: "([^"]+)"/);
      const opacity = entry.match(/opacity: ([0-9.]+)/);
      if (!key || !label || !opacity) return null;
      return { key: key[1], label: label[1], opacity: Number(opacity[1]) };
    })
    .filter(Boolean);
}

// ── the flat map's table ────────────────────────────────────────────────
// Four registration shapes exist, and each one is load-bearing for a
// different family of overlays:
//   1. the WEATHER_OVERLAYS object literal   → the four tile layers
//   2. WEATHER_OVERLAYS["…literal…"]         → climate, temp
//   3. WEATHER_OVERLAYS[window.X.LAYER_NAME || "…"]  → most modules
//   4. WEATHER_OVERLAYS[mod.LAYER_NAME || name]      → the generic loop
//      (CAPE, IVT, WorldPop), where `mod` is a variable so no literal
//      name appears at the call site at all.
// Plus isobars, which is a SIBLING row injected under the base layers by
// mountIsobarRow() and never enters WEATHER_OVERLAYS — the layers panel
// shows it, so parity has to account for it.
function flatOverlays() {
  const names = new Set();
  // 1. the object literal's own keys
  const lit = appJs.match(/const WEATHER_OVERLAYS = \{([\s\S]*?)\n\};/);
  if (lit) for (const m of lit[1].matchAll(/^\s+"([^"]+)":/gm)) names.add(m[1]);
  // 2 + 3. literal subscripts and the window.X.LAYER_NAME fallbacks
  for (const m of appJs.matchAll(/WEATHER_OVERLAYS\["([^"]+)"\]/g)) names.add(m[1]);
  for (const m of appJs.matchAll(/WEATHER_OVERLAYS\[[^\]]*\|\|\s*"([^"]+)"\]/g)) names.add(m[1]);
  // 4. every LAYER_NAME a layer module publishes — this is what the
  //    generic loop consumes, and it is also the authoritative name list
  //    for the modules registered individually.
  for (const file of readdirSync(ROOT)) {
    if (!file.endsWith("-layer.js") && file !== "city-labels.js") continue;
    const src = readFileSync(join(ROOT, file), "utf8");
    // BOTH declaration forms: `LAYER_NAME: "…"` (object shorthand in
    // the export) and `const LAYER_NAME = "…"` (a module-scope const).
    // Matching only the colon form made hwsd-layer.js — a generic-loop
    // module with no literal registration in app.js — INVISIBLE to this
    // scan, so "added to the flat map but neither ported nor listed in
    // NOT_PORTED" could never fire for it. 2026-11-05.
    for (const m of src.matchAll(/\bLAYER_NAME\s*[:=]\s*"([^"]+)"/g)) names.add(m[1]);
  }
  names.add("⛅ Pressure lines (isobars)");   // sibling row, see above
  return [...names];
}

// The flat map's default opacity for a named overlay. Each module owns its
// own default, so this reads the module app.js registers for that name.
function flatDefaultOpacity(label) {
  const modFor = {
    "🌡️ Temperature (GFS)": "temp-layer.js",
    "🧭 Magnetic Field (WMM)": "mag-layer.js",
    "⚡ Lightning density (WWLLN)": "lightning-layer.js",
    "💧 Rivers": "river-layer.js",
    "🌊 Hydrological Basins": "basin-layer.js",
    "🪨 Geology (Macrostrat)": "geology-layer.js",
    "🌍 Köppen Climate": "climate-layer.js",
    "🟫 Soil": "soil-layer.js",
    "🌾 Cropland (ESA)": "cropland-layer.js",
  };
  const file = modFor[label];
  if (!file) return null;                       // tile layers: in app.js
  const src = readFileSync(join(ROOT, file), "utf8");
  // The module default is its own `opacity:` in the tile options, or an
  // OVERLAY_OPACITY constant. Read whichever the file has.
  const konst = src.match(/OVERLAY_OPACITY\s*=\s*([0-9.]+)/);
  if (konst) return Number(konst[1]);
  const op = src.match(/opacity:\s*([0-9.]+)/);
  return op ? Number(op[1]) : null;
}

const globe = globeOverlays();
const flat = new Set(flatOverlays());

// The flat map's OWN slugifier, extracted from app.js and run here.
// Copying the rule into this file would make the test a second source of
// truth — and the second source of truth is the one that drifts. This is
// the function getMapHash() uses to write `overlay=` into a shared URL,
// so it is literally the vocabulary a link arrives in.
function realGetLayerSlug() {
  const rev = appJs.match(/const REVERSE_LAYER_SLUGS = \{[\s\S]*?\n\};/);
  const fn = appJs.match(/function getLayerSlug\(fullName\) \{[\s\S]*?\n\}/);
  if (!rev || !fn) throw new Error("could not extract getLayerSlug() from app.js");
  return new Function(`${rev[0]}\n${fn[0]}\nreturn getLayerSlug;`)();
}

/**
 * Overlays the flat map has and the globe deliberately does not.
 *
 * Each entry carries the reason it cannot be on the globe, because the
 * reason is the actual contract: if one of these becomes portable (the
 * animation gets a screen-space-free form, MapLibre gains WMS, a pyramid
 * gets baked), the entry must be deleted and the layer ported — which is
 * the point of writing the reason down here rather than in a comment.
 */
const NOT_PORTED = {
  "🗺️ Geologic contacts (USGS)":
    "the layer is WMS (BBOX/GetMap) and MapLibre raster sources need an XYZ {z}/{x}/{y} template",
  "🌍 Languages":
    "SVG circleMarkers on a canvas renderer; the globe has no equivalent point-symbol path",
  "🛰️ Human Transportation":
    "equirectangular PNG drawn by a wrapping L.GridLayer, not a Web Mercator source MapLibre can drape",
  "🧂 Sea surface salinity":
    "same wrapping-L.GridLayer shape as transportation",
  "🌊 Ocean Currents (ECCO)":
    "same wrapping-L.GridLayer shape as transportation",
  "⛰️ Relief (ETOPO)":
    "a baked Mercator pyramid of a global grid; not yet built as a globe-drapable source",
  "🌊 Wave height & power":
    "field-layer family (CAPE/IVT/wave) shares one probe-backed GridLayer that is Leaflet-coupled",
  "⛈️ Convective instability (CAPE)":
    "field-layer family — same reason as wave",
  "🌊 Moisture transport (IVT)":
    "field-layer family — same reason as wave",
  "🦠 Phytoplankton (Darwin)":
    "a wrapping L.GridLayer over two uint8 planes, read by a Leaflet probe",
  "🏙️ City names":
    "drawn on the pin canvas, which is the flat map's own renderer",
  "🧍 Population density (WorldPop, 1 km)":
    "hotlinked FAO WMTS — the globe would need its own GetTile template and a per-tile attribution",
  "🟫 Soil type (HWSD v2.2)":
    "hotlinked FAO WMTS (same shape as WorldPop) — the globe would need its own GetTile template; the 34-class legend and pixel probe are Leaflet-side",
  "🌊 Rivers (FAO 2026)":
    "hotlinked FAO WMS with a per-request dynamic SLD; MapLibre raster sources need an XYZ {z}/{x}/{y} template",
};

describe("the two views offer the same layers under the same names", () => {
  test("both tables were actually read", () => {
    expect(globe.length).toBeGreaterThan(10);
    expect(flat.size).toBeGreaterThan(20);
  });

  test("every globe overlay exists on the flat map with the SAME label", () => {
    // This is the check that catches a rename in one view only.
    const missing = globe.filter((g) => !flat.has(g.label)).map((g) => `${g.key} -> "${g.label}"`);
    expect(missing, `on the globe but not on the flat map: ${missing.join(", ")}`).toEqual([]);
  });

  test("no flat-map overlay is silently missing from the globe", () => {
    const globeLabels = new Set(globe.map((g) => g.label));
    const unaccounted = [...flat].filter((n) => !globeLabels.has(n) && !(n in NOT_PORTED));
    expect(
      unaccounted,
      `added to the flat map but neither ported nor listed in NOT_PORTED: ${unaccounted.join(", ")}`
    ).toEqual([]);
  });

  test("nothing in NOT_PORTED is actually on the globe any more", () => {
    // A ported layer must be deleted from the allowlist, or the list
    // quietly stops meaning "cannot be shown here".
    const globeLabels = new Set(globe.map((g) => g.label));
    const stale = Object.keys(NOT_PORTED).filter((n) => globeLabels.has(n));
    expect(stale, `still listed as NOT_PORTED but IS on the globe: ${stale.join(", ")}`).toEqual([]);
  });

  test("every NOT_PORTED entry names a real flat-map overlay", () => {
    // Otherwise the allowlist rots into a list of things that never
    // existed, which catches nothing.
    const ghost = Object.keys(NOT_PORTED).filter((n) => !flat.has(n));
    expect(ghost, `NOT_PORTED entries the flat map does not have: ${ghost.join(", ")}`).toEqual([]);
  });

  test("every NOT_PORTED entry gives a reason", () => {
    const noReason = Object.entries(NOT_PORTED).filter(([, r]) => !r || r.length < 20)
      .map(([k]) => k);
    expect(noReason, `NOT_PORTED without a usable reason: ${noReason.join(", ")}`).toEqual([]);
  });
});

describe("the two views agree on default opacity for shared overlays", () => {
  // Where the flat map's default lives, per overlay. Tile layers keep it
  // in app.js's WEATHER_OVERLAYS literal; module layers own theirs.
  const FLAT_TILE_DEFAULTS = {
    "🛰️ NASA Satellite (True Color)": 0.85,
    "🌧️ NASA Rain Rate (IMERG)": 0.65,
    "🤝 Facebook Friendships": 0.6,
    "🌌 NASA Earth at Night": 0.8,
    "⛅ Pressure lines (isobars)": 0.85,
    "🗺️ Land Cover (ESA)": 0.55,   // shares cropland-layer's default
  };

  test("shared overlays open at the same opacity in both views", () => {
    const drift = [];
    for (const g of globe) {
      const expected = FLAT_TILE_DEFAULTS[g.label] ?? flatDefaultOpacity(g.label);
      if (expected == null) continue;         // not statically knowable
      if (Math.abs(expected - g.opacity) > 1e-9) {
        drift.push(`${g.label}: flat ${expected} vs globe ${g.opacity}`);
      }
    }
    expect(drift, `default-opacity drift between the two views: ${drift.join("; ")}`).toEqual([]);
  });
});

describe("a shared link means the same thing in both views", () => {
  const w = {};
  new Function("window", handoffJs)(w);
  const H = w.XYZO_HANDOFF;

  test("every shared overlay's hash key survives both directions", () => {
    // The flat map emits its own slug, the globe its own key; the
    // handoff aliases are what make one URL readable by the other.
    const lost = [];
    for (const g of globe) {
      const flatSlug = H.GLOBE_TO_FLAT[g.key] || g.key;
      const back = H.FLAT_TO_GLOBE[flatSlug] || flatSlug;
      if (back !== g.key) lost.push(`${g.key} -> ${flatSlug} -> ${back}`);
    }
    expect(lost, `overlays that do not survive the round trip: ${lost.join(", ")}`).toEqual([]);
  });

  test("the owner's example link keeps its overlays and opacities", () => {
    // https://xyzo.org/globe#-8.0874,-30.0529,3.3/overlay=soil@40,isobars@100
    const globeHash = "#-8.0874,-30.0529,3.3/overlay=soil@40,isobars@100";
    const flatHash = H.toFlatHash(globeHash);
    expect(flatHash).toContain("soil-soilgrids@40");
    expect(flatHash).toContain("isobars@100");
    expect(flatHash).toContain("-8.0874,-30.0529,3.3");
    // …and back again, so a link copied from either view opens the other.
    expect(H.toGlobeHash(flatHash)).toBe(globeHash);
  });

  test("an opacity rides the trip even when the key is aliased", () => {
    // temperature is the flat slug, temp the globe key — the one pair a
    // naive test would miss by checking only the shared-slug majority.
    const h = "#10,20,5/overlay=temperature@55";
    expect(H.toGlobeHash(h)).toContain("overlay=temp@55");
    expect(H.toFlatHash("#10,20,5/overlay=temp@55")).toContain("temperature@55");
  });

  test("each globe overlay's REAL flat-map slug translates back to it", () => {
    // The check below ("every shared overlay's hash key survives both
    // directions") round-trips the GLOBE's key: key -> flat || key ->
    // key, which passes whenever there is NO alias. That is exactly why
    // five divergences shipped — wind-gfs, wind-speed-gfs,
    // ocean-currents-live, earthquakes-usgs and tectonic-faults-usgs
    // are what the flat map's own getLayerSlug() emits, the globe keys
    // them wind / wind-speed / ocean-current / earthquakes / faults,
    // and every one of them is PORTED. The owner's shared link lost
    // three layers in one hop to 3D.
    //
    // So ask the question that can actually fail: what does the SHIPPED
    // getLayerSlug() say about this label? Extracted from app.js rather
    // than copied, so the slugifier cannot drift away from the test.
    const flatSlug = realGetLayerSlug();
    const lost = [];
    for (const g of globe) {
      const slug = flatSlug(g.label);
      const translated = H.FLAT_TO_GLOBE[slug] || slug;
      if (translated !== g.key) lost.push(`${g.key} <- ${slug} -> ${translated}`);
    }
    expect(lost, `flat slugs the globe would not recognise: ${lost.join(", ")}`).toEqual([]);
  });

  test("the owner's own link keeps every overlay it can draw in 3D", () => {
    // https://xyzo.org/#72.3024,12.6563,4/… fifteen overlays, of which
    // the globe can draw twelve. This pins the three that were being
    // dropped DESPITE being ported (wind, wind speed, ocean currents)
    // and the three that are genuinely not portable (which
    // view-handoff now carries home in the back link).
    const link = "wind-gfs@100,basins@100,population-density-worldpop-1-km@45," +
      "koppen@30,cropland-esa@50,land-cover-esa@35,soil-type-hwsd-v2-2@25," +
      "soil-soilgrids@15,ocean-currents-live@100,nasa-rain@30," +
      "rivers-fao-2026@100,geology-macrostrat@25,rivers@100," +
      "wind-speed-gfs@30,isobars@100";
    const globeKeys = new Set(globe.map((g) => g.key));
    const translated = H.toGlobeHash(`#72.3024,12.6563,4/overlay=${link}`)
      .split("/").find((p) => p.startsWith("overlay="))
      .slice(8).split(",").map((e) => e.split("@")[0]);
    const dropped = translated.filter((k) => !globeKeys.has(k));
    // population / hwsd / fao-rivers are the only three the globe has no
    // layer for; anything else being here is the bug again.
    expect(dropped.sort()).toEqual([
      "population-density-worldpop-1-km",
      "rivers-fao-2026",
      "soil-type-hwsd-v2-2",
    ]);
  });

  test("a bare key (no @opacity) survives without inventing an opacity", () => {
    // `mapOverlays` keeps whatever came after the key, so a link written
    // without an opacity must not gain an "@undefined" or "@NaN" — and it
    // must still be translated (soil-soilgrids IS the alias case).
    const h = "#1,2,3/overlay=soil-soilgrids";
    expect(H.toGlobeHash(h)).toBe("#1,2,3/overlay=soil");
    expect(H.toGlobeHash(h)).not.toMatch(/@(undefined|NaN)/);
  });
});

describe("both pages can actually use a shared link", () => {
  test("view-handoff.js is loaded by both pages, before their app script", () => {
    // Without the script tag the translation above is dead code and a
    // shared link silently opens with nothing on it.
    //
    // Compare the SCRIPT TAGS, not indexOf on the bare filename: index.html
    // mentions "app.js" in prose and in the ASSETS list well before the
    // tag that actually loads it, so a raw indexOf said the handoff came
    // last when the tags were in the right order.
    const tagPos = (html, file) => {
      const m = html.match(new RegExp(`<script[^>]+src="[^"]*${file}[^"]*"`));
      return m ? m.index : -1;
    };
    for (const html of [indexHtml, readFileSync(join(ROOT, "globe.html"), "utf8")]) {
      const handoff = tagPos(html, "view-handoff\\.js");
      const app = Math.max(tagPos(html, "app\\.js"), tagPos(html, "globe\\.js"));
      expect(handoff).toBeGreaterThan(-1);
      expect(app).toBeGreaterThan(-1);
      expect(handoff, "view-handoff.js must load before the app script").toBeLessThan(app);
    }
  });

  test("both pages are stamped with a cache token", () => {
    for (const html of [indexHtml, readFileSync(join(ROOT, "globe.html"), "utf8")]) {
      expect(html).toMatch(/view-handoff\.js\?v=\d+/);
    }
  });
});
