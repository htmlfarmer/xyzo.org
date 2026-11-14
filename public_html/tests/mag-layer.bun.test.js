/**
 * Magnetic-field overlay — NOAA NCEI / BGS World Magnetic Model 2025.
 *
 * Pins the module contract (name, registration, load order), the
 * house rules that broke other overlays before (setOpacity shim for the
 * GeoJSON group, async tile callback, blocksClick gate, no .png under
 * public_html), and the published data assets.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const magJs = readFileSync(join(root, "mag-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("mag-layer module", () => {
  test("exposes MagLayer with a stable name", () => {
    expect(magJs).toMatch(/window\.MagLayer\s*=/);
    expect(magJs).toMatch(/const LAYER_NAME = "🧭 Magnetic Field \(WMM\)"/);
    expect(magJs).toMatch(/LAYER_NAME:\s*LAYER_NAME/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity", "setComponent", "setWash"]) {
      expect(magJs).toMatch(new RegExp(`\\b${fn}\\s*:`));
    }
  });

  test("is registered in WEATHER_OVERLAYS and initialized", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.MagLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.MagLayer\.init\(map\)/);
  });

  test("loads before app.js and is stamped", () => {
    const magAt = indexHtml.indexOf("mag-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(magAt).toBeGreaterThan(-1);
    expect(magAt).toBeLessThan(appAt);
    expect(bump).toMatch(/mag-layer\.js/);
  });

  test("serves static data, never PNG tiles", () => {
    // Caddy serves *.png under public_html immutable for a year — the
    // bug that hid the Köppen layer. The magnetic data must be .bin /
    // .geojson / .json, which revalidate.
    expect(magJs).toMatch(/\/data\/mag/);
    expect(magJs).toMatch(/isogonics\.geojson/);
    expect(magJs).toMatch(/isoclinics\.geojson/);
    expect(magJs).toMatch(/grid_d\.bin/);
    expect(magJs).not.toMatch(/\.png/);
    expect(magJs).not.toMatch(/BUILD\s*=/); // no immutable token needed
  });

  test("the GeoJSON group carries the setOpacity shim", () => {
    // OverlayOpacity.mount calls setOpacity() on every WEATHER_OVERLAYS
    // entry; a raw L.geoJSON has no such method and its absence aborted
    // the rest of app.js (the river layer shipped this bug).
    expect(magJs).toMatch(/state\.lines\.setOpacity\s*=/);
    expect(magJs).toMatch(/state\.lines\.getOpacity\s*=/);
  });

  test("wash tiles call done() asynchronously", () => {
    // Leaflet inserts a tile only after createTile returns; a
    // synchronous done() leaves every tile at visibility:hidden.
    expect(magJs).toMatch(/setTimeout\(\(\)\s*=>\s*done\(null,\s*tile\),\s*0\)/);
  });

  test("the wash GridLayer provides setOpacity", () => {
    // A bare L.GridLayer has no setOpacity, unlike L.TileLayer.
    const washBlock = magJs.match(/const MagWash = L\.GridLayer\.extend\(\{[\s\S]*?\}\);/);
    expect(washBlock).toBeTruthy();
    expect(washBlock[0]).toMatch(/setOpacity\(value\)/);
    expect(washBlock[0]).toMatch(/getOpacity\(\)/);
  });

  test("the pane sits between climate and isobars", () => {
    expect(magJs).toMatch(/const PANE_Z = 358/);
  });

  test("the probe gates map clicks while armed", () => {
    // app.js skips the click-to-submit flow while a probe owns clicks.
    expect(magJs).toMatch(/function blocksClick\(\)\s*\{\s*return state\.enabled && state\.probeMode/);
    expect(appJs).toMatch(/window\.MagLayer\.blocksClick\(\)\)/);
  });

  test("blackout cells are masked in both the wash and the probe", () => {
    // H < 2000 nT: the compass needle stands vertical and declination
    // is undefined. NOAA's charts blank those caps; so do we.
    expect(magJs).toMatch(/mask\.bin/);
    expect(magJs).toMatch(/isMasked/);
    expect(magJs).toMatch(/Blackout zone/);
    // The wash leaves masked pixels transparent.
    expect(magJs).toMatch(/out\[oi \+ 3\] = 0/);
  });

  test("the probe reads e.latlng, never offsetX/offsetY", () => {
    // The pin canvas is 300px wider than the map and offset by -300;
    // offsetX there is 300px too big (the wind probe shipped that bug).
    expect(magJs).toMatch(/updateProbe\(e\.latlng,\s*e\.containerPoint\)/);
    expect(magJs).not.toMatch(/offsetX/);
    expect(magJs).not.toMatch(/offsetY/);
  });

  test("uses XLog, never raw console", () => {
    expect(magJs).toMatch(/window\.XLog/);
    expect(magJs).not.toMatch(/console\.(log|warn|error|debug)/);
  });

  test("declares four components × two modes and defaults to declination", () => {
    // The selector is TWO-DIMENSIONAL: D / F / H / I, each with a main
    // field and a secular-variation rate — the two chart series NCEI
    // publishes as its Miller "Main Field" and "Secular Variation" maps.
    // `sv` used to be a whole component of its own; it is a MODE now.
    expect(magJs).toMatch(/d:\s*\{[^}]*label:\s*"Declination"/);
    expect(magJs).toMatch(/f:\s*\{[^}]*label:\s*"Total force"/);
    // "Horizontal force", not "Horizontal": the globe reads its chip
    // text from meta.fields[k].label and the two views must agree word
    // for word or the same button says different things on each.
    expect(magJs).toMatch(/h:\s*\{[^}]*label:\s*"Horizontal force"/);
    expect(magJs).toMatch(/i:\s*\{[^}]*label:\s*"Inclination"/);
    expect(magJs).toMatch(/component:\s*"d"/);
    expect(magJs).toMatch(/mode:\s*"main"/);
    expect(magJs).toMatch(/COMPONENT_ORDER = \["d", "f", "h", "i"\]/);
    expect(magJs).toMatch(/MODE_ORDER = \["main", "sv"\]/);

    // Both selector rows are built, one chip group per dimension —
    // eight checkboxes would drown the layers dropdown. The attribute is
    // built by concatenation (`data-comp="' + c + '"`), so assert the
    // construction, not a literal that never appears in the source —
    // and stop at the `+`, because the closing quote arrives on the
    // next line of the template.
    expect(magJs).toMatch(/id="mag-comp-switch"/);
    expect(magJs).toMatch(/id="mag-mode-switch"/);
    expect(magJs).toMatch(/data-comp="' \+ c/);
    expect(magJs).toMatch(/data-mode="' \+ m/);

    // Every field the worker publishes has an entry with its own plane
    // file and its own contour family, so the two can never drift.
    for (const key of ["d", "f", "h", "i", "ddot", "fdot", "hdot", "idot"]) {
      expect(magJs).toMatch(
        new RegExp(`${key}:\\s*\\{[^}]*gridFile:\\s*"grid_${key}\\.bin"`)
      );
      expect(magJs).toMatch(new RegExp(`${key}:\\s*\\{[^}]*lines:\\s*"[^"]+\\.geojson"`));
    }

    // Per-field Int16 scales: one scale cannot serve a ±180° angle and
    // a 67,000 nT magnitude, and meta.grid.scale stays 100 only for the
    // four fields that shipped first.
    expect(magJs).toMatch(/function fieldScale\(key\)/);
    expect(magJs).toMatch(/fieldScale\(key \|\| fieldKey\(\)\)/);

    // The blackout mask is PER FIELD: exactly D and ΔD are undefined
    // where the compass needle stands vertical, and blanketing the
    // others would erase the poles from the charts that show them.
    expect((magJs.match(/boz: true/g) || []).length).toBe(2);
    expect((magJs.match(/boz: false/g) || []).length).toBe(6);

    // The old single-key preference ("d" | "i" | "sv") migrates rather
    // than being silently dropped — "sv" is a mode now.
    expect(magJs).toMatch(/savedComp === "sv" \? "sv" : "main"/);
    expect(magJs).toMatch(/MODE_STORE_KEY/);
  });

  test("hides intermediate contours below zoom 4", () => {
    // The minor (2°) lines are the thin fill-in rank; showing them at
    // world view turns the chart into a hairball.
    expect(magJs).toMatch(/p\.major === false/);
    expect(magJs).toMatch(/zoom < 4/);
    // And never labels them.
    expect(magJs).toMatch(/if \(p\.major === false\) return;/);
  });

  test("the legend lives in the layers list, not a floating panel", () => {
    // Rows injected into a list Leaflet empties are wiped by the first
    // layer change; a floating panel violates the no-floating-rules.
    expect(magJs).toMatch(/querySelector\("\.leaflet-control-layers-list"\)/);
    expect(magJs).toMatch(/host\.id = "mag-legend"/);
  });

  test("labels the agonic and aclinic lines as specials", () => {
    expect(magJs).toMatch(/mag-label-special/);
    expect(magJs).toMatch(/special/);
  });
});

describe("mag data assets", () => {
  const dataDir = join(root, "data", "mag");
  const metaPath = join(dataDir, "meta.json");

  test("meta.json is well formed when built", () => {
    if (!existsSync(metaPath)) return;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.model).toBe("WMM-2025");
    expect(meta.epoch).toBe(2025.0);
    expect(meta.license.toLowerCase()).toContain("public domain");
    expect(meta.grid.scale).toBe(100);
    expect(meta.grid.rows).toBe(181);
    expect(meta.grid.cols).toBe(360);
    // The GFS/torus longitude convention — a -180 origin shifts every
    // contoured line by 180 degrees.
    expect(meta.grid.lon_min).toBe(0);
    expect(meta.blackout_nt).toBe(2000);
    expect(meta.contours.isogonics).toBe("isogonics.geojson");
    expect(meta.contours.isoclinics).toBe("isoclinics.geojson");
    expect(meta.contours.isoporics).toBe("isoporics.geojson");
    expect(meta.contours.major_interval_deg).toBe(10);
    expect(meta.contours.minor_interval_deg).toBe(2);
    // Every field carries a ramp now — the SV washes need one too.
    for (const key of ["d", "i", "ddot", "idot"]) {
      expect(meta.fields[key].file).toMatch(/\.bin$/);
      expect(Array.isArray(meta.fields[key].ramp)).toBe(true);
      expect(meta.fields[key].range).toHaveLength(2);
      // The ramps diverge: blue-dominant negative end, red-dominant
      // positive end...
      const ramp = meta.fields[key].ramp;
      const [rn, , bn] = [1, 3, 5].map((i) => parseInt(ramp[0].rgb.slice(i, i + 2), 16));
      const [rp, , bp] = [1, 3, 5].map((i) => parseInt(ramp[ramp.length - 1].rgb.slice(i, i + 2), 16));
      expect(bn).toBeGreaterThan(rn);
      expect(rp).toBeGreaterThan(bp);
      // ...the centre plateau is the CYAN glow (#00e5ff) — zero still
      // lights up against a dark basemap AND stays a saturated colour,
      // because half the map sits inside the plateau and an ice-white
      // centre rendered as a washed-out sheet (2026-10-30). And NO stop
      // on a ramp is green-dominant: the old ramp put a pale green and
      // a yellow-green either side of its neon plateau, so the chart read
      // "green on both sides of zero" and the ΔD wash made the globe a
      // green ball.
      const glow = ramp.filter((s) => s.rgb.toLowerCase() === "#00e5ff");
      expect(glow.length).toBe(2);
      for (const s of ramp) {
        const r = parseInt(s.rgb.slice(1, 3), 16);
        const g = parseInt(s.rgb.slice(3, 5), 16);
        const b = parseInt(s.rgb.slice(5, 7), 16);
        expect(g > r && g > b).toBe(false);
        expect(s.rgb.toLowerCase()).not.toBe("#39ff14");
      }
    }
    // Every field publishes a human label — the globe builds its
    // component chips from meta and renders them EMPTY without it.
    for (const key of Object.keys(meta.fields)) {
      expect(typeof meta.fields[key].label).toBe("string");
      expect(meta.fields[key].label.length).toBeGreaterThan(2);
    }
    // No PNG anywhere in the contract.
    expect(JSON.stringify(meta)).not.toMatch(/\.png/);
  });

  test("the line sets carry the full circle and the special lines", () => {
    const isoPath = join(dataDir, "isogonics.geojson");
    if (!existsSync(isoPath)) return;
    const iso = JSON.parse(readFileSync(isoPath, "utf8"));
    expect(iso.type).toBe("FeatureCollection");
    const levels = new Set(iso.features.map((f) => f.properties.level));
    // Index (major) contours every 10°...
    for (let lvl = -180; lvl < 180; lvl += 10) {
      expect(levels.has(lvl)).toBe(true);
    }
    // ...and intermediate (minor) contours filling in at 2°.
    for (let lvl = -178; lvl < 180; lvl += 2) {
      if (lvl % 10 === 0) continue;
      expect(levels.has(lvl)).toBe(true);
    }
    const specials = new Set(
      iso.features.filter((f) => f.properties.special).map((f) => f.properties.special)
    );
    expect(specials.has("agonic")).toBe(true);
    // Every feature is tagged major/minor, consistent with its level.
    for (const f of iso.features) {
      expect(f.properties.major).toBe(Math.abs(f.properties.level % 10) < 1e-9);
    }

    const iclPath = join(dataDir, "isoclinics.geojson");
    const icl = JSON.parse(readFileSync(iclPath, "utf8"));
    const ilevels = new Set(icl.features.map((f) => f.properties.level));
    for (let lvl = -80; lvl <= 80; lvl += 10) {
      expect(ilevels.has(lvl)).toBe(true);
    }
    const ispecials = new Set(
      icl.features.filter((f) => f.properties.special).map((f) => f.properties.special)
    );
    expect(ispecials.has("aclinic")).toBe(true);

    // Isoporics: equal annual change, with the no-change line flagged.
    const svPath = join(dataDir, "isoporics.geojson");
    expect(existsSync(svPath)).toBe(true);
    const sv = JSON.parse(readFileSync(svPath, "utf8"));
    const svLevels = new Set(sv.features.map((f) => f.properties.level));
    expect(svLevels.has(0)).toBe(true);
    for (const lvl of [-1.5, -1, -0.5, 0.5, 1, 1.5]) {
      expect([...svLevels].some((s) => Math.abs(s - lvl) < 1e-9)).toBe(true);
    }
    const svSpecials = new Set(
      sv.features.filter((f) => f.properties.special).map((f) => f.properties.special)
    );
    expect(svSpecials.has("nochange")).toBe(true);
  });

  test("the grid planes match the meta shape", () => {
    if (!existsSync(metaPath)) return;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const expectLen = meta.grid.rows * meta.grid.cols;
    const sizes = { "grid_d.bin": 2, "grid_i.bin": 2, "grid_ddot.bin": 2, "grid_idot.bin": 2, "mask.bin": 1 };
    for (const [file, width] of Object.entries(sizes)) {
      const buf = readFileSync(join(dataDir, file));
      expect(buf.length).toBe(expectLen * width);
    }
    // The blackout caps must actually be marked somewhere.
    const mask = readFileSync(join(dataDir, "mask.bin"));
    let marked = 0;
    for (const b of mask) if (b === 1) marked++;
    const frac = marked / mask.length;
    expect(frac).toBeGreaterThan(0.0005);
    expect(frac).toBeLessThan(0.05);
  });

  test("isogonic lines sit on the field they claim (placement spot-check)", () => {
    // A line labelled level L must actually be where D ~ L: sample the
    // published coordinates and confirm the label is not shifted. The
    // 180-degree-shift bug shipped lines at the wrong place while still
    // looking plausible.
    const isoPath = join(dataDir, "isogonics.geojson");
    if (!existsSync(isoPath)) return;
    const iso = JSON.parse(readFileSync(isoPath, "utf8"));
    const agonics = iso.features.filter((f) => f.properties.special === "agonic");
    expect(agonics.length).toBeGreaterThan(0);
    // The agonic line (D = 0) runs down the Atlantic / through the
    // Americas in the modern field. At least one of its pieces must
    // land in the western hemisphere at mid-latitudes — a global 180°
    // shift would put every piece in the eastern hemisphere instead.
    const hasAtlantic = agonics.some((f) =>
      f.geometry.coordinates.some(([lon, lat]) => lon > -120 && lon < -30 && lat > -60 && lat < 70)
    );
    expect(hasAtlantic).toBe(true);
    // And the pieces must be real polylines, not single points.
    for (const f of agonics) {
      expect(f.geometry.type).toBe("LineString");
      expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── hash restore: the layer must actually load, not just check the box ──
//
// 2026-10-28: MagLayer.init() restored from localStorage by calling
// state.lines.addTo(map) BEFORE registering the overlayadd listener.
// The addTo fired overlayadd synchronously, the listener was not yet
// attached, onLayerToggled never ran, state.enabled stayed false, and
// fillLines() never happened — while the layers-control checkbox still
// looked checked (Leaflet only checks map.hasLayer). Reloading a shared
// link that DID include magnetic@100 then skipped the addTo entirely
// (hasLayer was already true) and _activeOverlayNames never recorded
// the name, so the next hash rewrite dropped it.

describe("mag layer — hash/localStorage restore", () => {
  test("init registers overlayadd BEFORE the localStorage addTo", () => {
    const js = readFileSync(join(import.meta.dir, "..", "mag-layer.js"), "utf8");
    const initStart = js.indexOf("function init(map)");
    const initEnd = js.indexOf("function blocksClick");
    const init = js.slice(initStart, initEnd);
    const listenerAt = init.indexOf('map.on("overlayadd"');
    const addToAt = init.indexOf("state.lines.addTo");
    expect(listenerAt).toBeGreaterThan(-1);
    expect(addToAt).toBeGreaterThan(-1);
    expect(listenerAt, "overlayadd listener must be registered before the restore addTo")
      .toBeLessThan(addToAt);
  });

  test("app.js records overlay names from e.layer, not the nonexistent e.name", () => {
    // Leaflet fires overlayadd with {layer}, never {name}. The old
    // `e.name` check was always false, so overlays checked by hand fell
    // out of the next hash rewrite.
    const appJs = readFileSync(join(import.meta.dir, "..", "app.js"), "utf8");
    expect(appJs).toMatch(/_overlayNameFor/);
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[key\] === layer/);
    // The old buggy form must not come back.
    expect(appJs).not.toMatch(/if \(e && e\.name\) \{\s*\n\s*_activeOverlayNames\.add/);
  });

  test("applyLayersFromParsedHash records the name even when hasLayer is true", () => {
    // If a module's init already put the layer on the map from
    // localStorage, the hash restore used to skip BOTH the addTo AND
    // the _activeOverlayNames.add — so the next hash rewrite dropped
    // the overlay. The add must happen unconditionally.
    const appJs = readFileSync(join(import.meta.dir, "..", "app.js"), "utf8");
    // _activeOverlayNames.add must appear BEFORE the hasLayer guard
    // inside the overlay restore loop.
    const restoreAt = appJs.indexOf("function applyLayersFromParsedHash");
    // The window is generous because the boot path now carries the
    // STAGED-OVERLAY block (the overlays are added after the markers
    // are painted — see flushDeferredOverlays in app.js), which sits
    // between the function and the two lines this test looks for.
    const block = appJs.slice(restoreAt, restoreAt + 6000);
    const addAt = block.indexOf("_activeOverlayNames.add(ovName)");
    const hasLayerAt = block.indexOf("map.hasLayer(WEATHER_OVERLAYS[ovName])");
    expect(addAt).toBeGreaterThan(-1);
    expect(hasLayerAt).toBeGreaterThan(-1);
    expect(addAt, "_activeOverlayNames.add must run even if the layer is already on the map")
      .toBeLessThan(hasLayerAt);
  });
});


// ══════════════════════════════════════════════════════════════════════
// The four components × two modes (D / F / H / I × main field / change
// per year), and the per-field rules that only make sense once a field
// can be picked: the blackout mask, the label spacing, the legend ticks
// and the export band list.
// ══════════════════════════════════════════════════════════════════════
describe("mag-layer — picking a field", () => {
  test("the wash blanks only the fields that are undefined there", () => {
    // H < 2000 nT is where a compass needle stands vertical: D has no
    // answer and ΔD divides by H², but F is at its STRONGEST there, H
    // is merely small and I runs smoothly to ±90°. Gating the
    // transparency on the field's own `boz` flag is what keeps the two
    // poles on the F and H charts — blanket masking would delete the
    // most interesting part of both.
    expect(magJs).toMatch(/const maskThis = !!\(def && def\.boz\) && !!mask;/);
  });

  test("the probe reads the four values of the ACTIVE mode", () => {
    // It must wait for every plane of that mode, or the card shows a
    // partial reading while the rest is still downloading.
    expect(magJs).toMatch(/function probeText\(lat, lon\)/);
    expect(magJs).toMatch(/if \(!state\.planes\[k\]\) return null;/);
    expect(magJs).toMatch(/const keys = fieldsOfMode\(state\.mode\);/);
    // In blackout the note names the ONE value with no reading instead
    // of blanking three good ones.
    expect(magJs).toMatch(/missing\.short \+ " undefined here"/);
    expect(magJs).toMatch(/"Blackout zone — compass unreliable"/);
    // Both units the probe prints: nT magnitudes and nT/yr rates.
    expect(magJs).toMatch(/function fmtNt\(v\)/);
    expect(magJs).toMatch(/function fmtRate\(v, unit\)/);
  });

  test("label spacing comes from the field, not a hardcoded 30", () => {
    // 30° is right for D and I and meaningless for a 23,000–67,000 nT
    // field, where NO level is a multiple of 30 — a single hardcoded
    // step would leave F and H contoured but unlabelled.
    expect(magJs).toMatch(/function labelStep\(key\)/);
    expect(magJs).toMatch(/f\.label_step/);
    expect(magJs).toMatch(/Math\.abs\(lvl % labelStep\(\)\) > 1e-6/);
  });

  test("legend ticks stay on the bar for one-sided ranges", () => {
    // F and H never contain zero, so the old unconditional [lo, 0, hi]
    // would put a tick at −14 % hanging off the left edge. The signed
    // fields keep their zero landmark; the magnitudes get a rounded
    // midpoint instead.
    expect(magJs).toMatch(/lo < 0 && hi > 0 \? \[lo, 0, hi\] : \[lo, roundNice/);
    expect(magJs).toMatch(/function roundNice\(v, span\)/);
    // And the caption names which field and which unit the bar shows —
    // "22,000 … 67,000" means nothing until you know it is nanoteslas.
    expect(magJs).toMatch(/id="mag-legend-unit"/);
    expect(magJs).toMatch(/unitRow\.textContent/);
  });

  test("the export bands are a getter that matches what sample returns", () => {
    // The engine reads surface.bands when the user EXPORTS, not when
    // the module loads — so a literal 8-band list beside a 4-value
    // sampler would ship four silently empty bands. Naming the bands
    // dynamically keeps the two halves of the contract in lockstep.
    expect(magJs).toMatch(/get bands\(\) \{ return activeBands\(\); \}/);
    expect(magJs).toMatch(/for \(const k of fieldsOfMode\(state\.mode\)\) \{/);
    expect(magJs).toMatch(/isActive: activePlanesReady/);
    // NODATA is NaN per BAND — the blackout zone invalidates D, not the
    // whole cell, so F/H/I still export there.
    expect(magJs).toMatch(
      /if \(FIELDS\[k\]\.boz && masked\) \{ out\.push\(NaN\); continue; \}/
    );
    expect(magJs).toMatch(/return any \? out : null;/);
  });

  test("switching a field drops the cached wash bake", () => {
    // Otherwise the new component paints the OLD field's colours —
    // the bake is keyed on the field, so the key has to go too.
    expect(magJs).toMatch(/state\.bake = null;\s*\n\s*state\.bakeKey = null;/);
    expect(magJs).toMatch(/state\.lutKey = null;/);
  });

  test("only the active field's line family is fetched and drawn", () => {
    // One GeoJSON at a time rather than all eight, and fillLines()
    // reads the FIELD key (component × mode), not the component.
    expect(magJs).toMatch(/ensureFeatures\(fieldKey\(\)\)/);
    expect(magJs).toMatch(/const fc = state\.features\[fieldKey\(\)\];/);
  });
});

// ── the opacity slider must move BOTH halves of the overlay ────────────
//
// 2026-10-30, found with Playwright: `MagLayer.setOpacity()` (what the
// layers-control slider calls) only restyled the GeoJSON contours, while
// the colour wash — the visually dominant half — kept its creation
// value. With the wash on, dragging the slider across its whole range
// moved the picture's mean luminance from 190.5 to 190.8. The user
// report was "can't adjust the opacity for magnetic field".
describe("mag-layer — opacity drives the wash", () => {
  test("setOpacity applies to the wash layer, not just the lines", () => {
    expect(magJs).toMatch(/function setOpacity\(v\)/);
    // It must reach the wash...
    expect(magJs).toMatch(/state\.washLayer\.setOpacity\(state\.opacity\)/);
    // ...guarded on the wash actually being on the map, or an
    // off-but-created layer would be mutated for nothing.
    expect(magJs).toMatch(
      /if \(state\.washLayer && state\.map\.hasLayer\(state\.washLayer\)\) \{\s*\n\s*state\.washLayer\.setOpacity/
    );
    // And it still restyles the contours.
    expect(magJs).toMatch(/if \(state\.enabled\) restyle\(\);/);
  });

  test("the wash is created at the SLIDER's value, not a hardcoded one", () => {
    // makeWashLayer() used to pass a literal 0.55 while the slider read
    // 90 % — one knob, two truths.
    expect(magJs).toMatch(/opacity: state\.opacity,/);
    expect(magJs).not.toMatch(/opacity: 0\.55,/);
    // Leaflet does not push a GridLayer's opacity option onto its
    // container the way TileLayer does, so it is applied after addTo.
    expect(magJs).toMatch(/state\.washLayer\.setOpacity\(state\.opacity\);\s*\n\s*\}/);
  });

  test("every wash entry point goes through addWashToMap", () => {
    // setWash() and the field switch both add the layer; a bare addTo
    // anywhere else would re-introduce the un-opacity'd wash.
    expect(magJs).toMatch(/function addWashToMap\(\)/);
    expect(magJs).toMatch(/addWashToMap\(\);\s*\n\s*refreshWashToggle\(\);/);
    // The field switch nulls the per-field layer before re-adding.
    expect(magJs).toMatch(/state\.washLayer = null;\s*\n\s*addWashToMap\(\);/);
    // No stray bare addTo of the wash outside the helper.
    const adds = magJs.match(/state\.washLayer\.addTo\(/g) || [];
    expect(adds.length).toBe(1); // only inside addWashToMap
  });
});

// 2026-10-31, the "make it cooler, more transparent, more colourful"
// pass. Two root causes, both fixed with contracts this repo already
// had elsewhere:
//
//  1. THE WASH WAS OPAQUE EVERYWHERE. buildLut() published RGB only and
//     the bake wrote alpha=255, so the zero plateau — ~52 % of the globe
//     for ΔD — painted a flat cyan SHEET over the basemap. The wash now
//     reads a per-field {t, a} alpha table (the contract the LIGHTNING
//     meta has always published): nearly clear where nothing is
//     happening, solid where the signal is. The worker's
//     check_alpha_tables() gates it — a client that receives a broken
//     table silently paints over the map, which no screenshot catches.
//
//  2. THE "HERO" LINES WERE INK-BLACK. AGENTS.md calls the contours the
//     hero of this overlay and they shipped #111827 — invisible on the
//     dark satellite basemap the site opens on. They now take the
//     field's OWN ramp colour at their own level, lifted toward white
//     so they still read ON their own wash band.
describe("mag-layer — the wash breathes and the lines carry the spectrum", () => {
  test("the LUT is RGBA and the bake writes the table's alpha", () => {
    // Four bytes per entry, not three...
    expect(magJs).toMatch(/const lut = new Uint8Array\(n \* 4\);/);
    // ...filled with the alpha interpolated from field.alpha...
    expect(magJs).toMatch(/lut\[i \* 4 \+ 3\] = alphaAt\(alphaStops,/);
    // ...and the bake copies THAT, never a literal 255.
    expect(magJs).toMatch(/out\[oi \+ 3\] = lut\.data\[li \+ 3\];/);
    expect(magJs).not.toMatch(/out\[oi \+ 3\] = 255;/);
  });

  test("a stale meta without an alpha table still paints (255)", () => {
    // alphaAt() falls back to fully opaque — the old look, not a
    // transparent void where the wash should be.
    expect(magJs).toMatch(/function alphaAt\(stops, t\)/);
    expect(magJs).toMatch(/if \(!stops \|\| !stops\.length\) return 255;/);
  });

  test("the transparent core is derived from the SAME plateau as the colour", () => {
    // The see-through band and the flat cyan band must be the same
    // width, or the map shows a clear zone with a colour step inside
    // it (or a coloured zone that is opaque at its own centre).
    const worker = readFileSync(join(root, "..", "worker", "magmap.py"), "utf8");
    expect(worker).toMatch(/def diverging_alpha\(span: float, plateau: float\)/);
    // The zero core is nearly clear...
    expect(worker).toMatch(/\(0\.5, 40\),\s*# the zero core — nearly clear/);
    // ...and the gate can fail an opaque core.
    expect(worker).toMatch(/def check_alpha_tables\(fields_meta/);
    expect(worker).toMatch(/the\s+"plateau must let the basemap through \(< 80\)"|plateau must let the basemap through/);
  });

  test("the contour lines take the ramp's colour, not ink", () => {
    expect(magJs).toMatch(/function lineColorFor\(level, lift\)/);
    // The colour comes from the FIELD's ramp at the line's own level...
    expect(magJs).toMatch(/rampColor\(field\.ramp, level\)/);
    // ...lifted toward white so a line at level L still reads on a wash
    // of ≈ ramp(L) — the same hue underneath it.
    expect(magJs).toMatch(/function liftTowardWhite\(rgb, f\)/);
    // styleFor must use it for the visible ranks.
    const style = magJs.slice(magJs.indexOf("function styleFor("));
    const body = style.slice(0, style.indexOf("\n  }"));
    expect(body).toMatch(/lineColorFor\(Number\(p\.level\), special \? 0\.2 : 0\.35\)/);
    // The hidden-minor early return may keep the inert ink colour.
    expect(body).toMatch(/color: "#111827", weight: 0, opacity: 0/);
  });

  test("the globe wash and lines follow the same contracts", () => {
    const globeJs = readFileSync(join(root, "globe.js"), "utf8");
    // RGBA LUT + table alpha in bakeMag...
    expect(globeJs).toMatch(/const lut = new Uint8Array\(1025 \* 4\);/);
    expect(globeJs).toMatch(/lut\[i \* 4 \+ 3\] = alphaAt\(i \/ 1024\);/);
    // The wash's PIXELS are painted by the shared bake now
    // (field-bake.js), so the alpha travels through colourAt() and the
    // blackout mask through the bake's own mask hook.
    expect(globeJs).toMatch(/mask: mask,/);
    expect(globeJs).toMatch(/maskValue: 1,/);
    expect(globeJs).toMatch(/return \[lut\[k \* 4\], lut\[k \* 4 \+ 1\], lut\[k \* 4 \+ 2\], lut\[k \* 4 \+ 3\]\];/);
    const fieldBakeJs = readFileSync(join(root, "field-bake.js"), "utf8");
    expect(fieldBakeJs).toMatch(/out\[oi \+ 3\] = c\.length > 3 \? c\[3\] : 255;/);
    expect(fieldBakeJs).toMatch(/mask\[base0 \+ c0\] === maskValue/);
    // ...and the mag lines are data-driven from the ramp, with the
    // level-0 landmarks on the cyan glow.
    expect(globeJs).toMatch(/\["interpolate", \["linear"\], \["get", "level"\]\]/);
    expect(globeJs).toMatch(/\["case", \["==", \["get", "level"\], 0\], "rgb\(102,242,255\)", rampExpr\]/);
  });

  test("the legend bar shows the alpha it paints", () => {
    // An opaque bar promises a sheet the map does not draw; the
    // lightning legend has been honest the same way.
    expect(magJs).toMatch(/"rgba\(" \+ \(\(hex >> 16\) & 255\)/);
  });
});
