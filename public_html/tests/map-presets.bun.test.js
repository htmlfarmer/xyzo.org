// map-presets.bun.test.js — curated "cool map" presets, the first-visit
// showcase load, and the ⭐ default / last-used map. (Owner spec
// 2026-10-30.)
//
// The module is pure state + storage (it never touches the live map —
// app.js owns applyMapState/captureMapState), so most of this suite
// EXECUTES it against a stubbed localStorage rather than grepping.
// The static checks cover the app.js half: boot precedence, the
// auto-save hook and the layers-panel Clear/Reset buttons.
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import "../map-presets.js";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const opacityJs = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");

const MP = globalThis.MapPresets;

// ── a throwaway localStorage ──────────────────────────────────────────
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    _map: m,
  };
}
const realStorage = globalThis.localStorage;
beforeEach(() => {
  globalThis.localStorage = makeStorage();
});

// Capability stubs for deviceTier.
const BIG_DESKTOP = { hardwareConcurrency: 16, deviceMemory: 32 };
const THIN_LAPTOP = { hardwareConcurrency: 4, deviceMemory: 8 };
const OLD_PHONE = { hardwareConcurrency: 4, deviceMemory: 2 };
const TWO_CORE = { hardwareConcurrency: 2, deviceMemory: 8 };
const SAVE_DATA = { hardwareConcurrency: 16, deviceMemory: 32, connection: { saveData: true } };
const THREE_G = { hardwareConcurrency: 8, deviceMemory: 8, connection: { effectiveType: "3g" } };
const IPHONE = { hardwareConcurrency: 6 }; // no deviceMemory — Safari hides it

describe("deviceTier — who gets the cool map", () => {
  test("a capable desktop is high tier", () => {
    expect(MP.deviceTier(BIG_DESKTOP)).toBe("high");
    expect(MP.deviceTier(THIN_LAPTOP)).toBe("high");
  });
  test("little RAM, few cores, save-data or 2G/3G demote to low", () => {
    expect(MP.deviceTier(OLD_PHONE)).toBe("low");
    expect(MP.deviceTier(TWO_CORE)).toBe("low");
    expect(MP.deviceTier(SAVE_DATA)).toBe("low");
    expect(MP.deviceTier(THREE_G)).toBe("low");
  });
  test("an iPhone (no deviceMemory) on a narrow screen is low", () => {
    const wide = { ...IPHONE };
    // Wide screen, no RAM info: benefit of the doubt.
    expect(MP.deviceTier(wide)).toBe("high");
  });
  test("no navigator at all is low — never gamble blind", () => {
    expect(MP.deviceTier(null)).toBe("low");
    // `undefined` means "work it out from the environment" — in a real
    // browser that is `navigator`, here bun's own global one.
    expect(MP.deviceTier(undefined)).toBe(MP.deviceTier(globalThis.navigator));
  });
});

describe("presets — the hashes are real app hashes", () => {
  test("every preset parses into a full state", () => {
    for (const p of MP.presets()) {
      const state = MP.presetState(p);
      expect(state, p.id).toBeTruthy();
      expect(Number.isFinite(state.lat), p.id).toBe(true);
      expect(Number.isFinite(state.zoom), p.id).toBe(true);
      // A preset EITHER names overlays or deliberately names none — the
      // satellite view is the second kind (owner spec 2026-11-14), and
      // "no overlays" is a real state, not a broken one.
      //
      // It must NOT be normalised into an empty array, because that is
      // how a CORRUPTED state (`{}`) would slip past the guard below
      // and be handed to applyMapState(), which strips every overlay.
      if (p.hash.includes("overlay=")) {
        expect(Array.isArray(state.overlays), p.id).toBe(true);
        expect(state.overlays.length, p.id).toBeGreaterThan(0);
      } else {
        expect(state.overlays, p.id).toBeUndefined();
      }
      for (const ov of state.overlays || []) {
        expect(typeof ov.slug).toBe("string");
        expect(ov.slug.length).toBeGreaterThan(0);
      }
    }
  });

  test("the owner's showcase hash is preset 'portrait', verbatim", () => {
    // Owner spec 2026-11-03: *"i really like having the wind and also
    // all the other base maps when we first load xyzo.org unless they
    // already have selected something else — use whatever they had for
    // their last view."* The second half is bootPlan()'s precedence
    // (below); this test pins the FIRST-VISIT view itself.
    //
    // Superseded 2026-11-08 by the map the owner pasted: FIFTEEN
    // overlays, the isobars at 0.25 hPa off GFS and the wind on the
    // published speed ramp. The geology and the (2014) ocean currents
    // are gone; the soil TYPE, the relief and the tectonic faults came
    // in, with the wind-speed field under the animation.
    const p = MP.presetById("portrait");
    expect(p).toBeTruthy();
    expect(p.hash).toBe(
      "#2.1967,16.8750,3/density=max/overlay=wind-gfs@100,basins@100," +
      "koppen@100,soil-soilgrids@65,rivers@100,cropland-esa@50," +
      "population-density-worldpop-1-km@25,land-cover-esa@60,isobars@100," +
      "soil-type-hwsd-v2-2@30,wind-speed-gfs@30,tectonic-faults-usgs@100," +
      "nasa-rain@30,etopo@55/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed");
    const s = MP.presetState(p);
    expect(s.lat).toBeCloseTo(2.1967, 3);
    expect(s.lng).toBeCloseTo(16.8750, 3);
    // Owner rule 2026-11-01: cool maps are GLOBAL views. The showcase
    // chip shipped at zoom 4 and was pulled to 3 like the rest — at
    // this centre zoom 3 shows -134°..91° (the Americas, the Atlantic,
    // Africa and Europe), where zoom 4 shows only the Atlantic.
    expect(s.zoom).toBe(3);
    expect(s.density).toBe("max");
    expect(s.overlays.map((o) => o.slug)).toEqual([
      "wind-gfs", "basins", "koppen", "soil-soilgrids", "rivers",
      "cropland-esa", "population-density-worldpop-1-km", "land-cover-esa",
      "isobars", "soil-type-hwsd-v2-2", "wind-speed-gfs",
      "tectonic-faults-usgs", "nasa-rain", "etopo"]);
    // And it carries the style settings the hash grammar now knows —
    // all FOUR of them, because this map names a fractional isobar
    // step, a ramp, an analysis and a wind rendering.
    expect(s.isoStep).toBe(0.25);
    expect(s.isoColour).toBe("pressure");
    expect(s.isoSource).toBe("gfs");
    expect(s.wind).toEqual({ style: "particles", colour: "speed" });
  });

  test("a returning reader keeps THEIR map; only a first visit gets the showcase", () => {
    // The owner's ask, literally: *"unless they already have selected
    // something else — use whatever they had for their last view."*
    // That is bootPlan()'s precedence, and it is what makes this a
    // change to ONE hash rather than to everyone's map.
    globalThis.localStorage.setItem(MP.MODE_KEY, "auto");
    globalThis.localStorage.setItem(MP.LAST_KEY, JSON.stringify({
      lat: 10, lng: 20, zoom: 7, base: "dark",
      overlays: [{ slug: "rivers", pct: 60 }], density: "medium",
    }));
    const plan = MP.bootPlan(BIG_DESKTOP);
    expect(plan.source).toBe("auto");
    expect(plan.state.zoom).toBe(7);                 // NOT the showcase's 3
    expect(plan.state.overlays).toEqual([{ slug: "rivers", pct: 60 }]);
    // A saved ⭐ default wins over the last-used one.
    globalThis.localStorage.setItem(MP.DEFAULT_KEY, JSON.stringify({
      lat: 1, lng: 2, zoom: 5, overlays: [{ slug: "waves" }],
    }));
    expect(MP.bootPlan(BIG_DESKTOP).source).toBe("saved");
    expect(MP.bootPlan(BIG_DESKTOP).state.zoom).toBe(5);
    // Only a machine with NOTHING stored gets the showcase — and then
    // it is the wind map, not the old satellite/rain one.
    globalThis.localStorage.clear();
    const first = MP.bootPlan(BIG_DESKTOP);
    expect(first.source).toBe("cool");
    expect(first.presetId).toBe("portrait");
    expect(first.state.overlays.some((o) => o.slug === "wind-gfs")).toBe(true);
  });

  test("the owner's street-mode hash is preset 'street', verbatim", () => {
    // Shared by the owner 2026-11-01 as a favourite "street mode" view —
    // the only preset that carries a non-satellite BASE layer.
    const p = MP.presetById("street");
    expect(p).toBeTruthy();
    expect(p.hash).toBe(
      "#30.2211,-22.3242,3/density=max/base=street/overlay=etopo@45," +
      "soil-soilgrids@30,cropland-esa@45,land-cover-esa@20,koppen@5");
    const s = MP.presetState(p);
    expect(s.lat).toBeCloseTo(30.2211, 3);
    expect(s.lng).toBeCloseTo(-22.3242, 3);
    expect(s.zoom).toBe(3);
    expect(s.density).toBe("max");
    expect(s.base).toBe("street");
    expect(s.overlays.map((o) => o.slug)).toEqual([
      "etopo", "soil-soilgrids", "cropland-esa", "land-cover-esa", "koppen"]);
    expect(s.overlays.find((o) => o.slug === "etopo").pct).toBe(45);
    expect(s.overlays.find((o) => o.slug === "koppen").pct).toBe(5);
  });

  test("every preset slug resolves DETERMINISTICALLY, never by substring luck", () => {
    // resolveLayerName() ends in a substring scan, which resolves by
    // LUCK: a preset pinned to a future rename would silently apply
    // nothing. So every slug a preset names must resolve through one of
    // the two DETERMINISTIC routes instead:
    //
    //   1. an explicit key in LAYER_SLUGS (the preferred route), or
    //   2. the slugified LAYER_NAME of a registered module — the exact
    //      comparison getLayerSlug() does. This is the only door left
    //      for overlays that cannot be pinned in LAYER_SLUGS. That
    //      route used to be *forced* by app.js's 850,000-byte runaway
    //      ceiling (adding a key there failed CI for a reason unrelated
    //      to the change itself) — the ceiling was removed 2026-11-01,
    //      but exact-match resolution is the better design anyway, and
    //      generic-layers.js stays the right shape for the same reason.
    //
    // Both routes are exact string equality against a name the code
    // actually carries; neither can silently miss after a rename.
    const start = appJs.indexOf("const LAYER_SLUGS = {");
    const end = appJs.indexOf("\n};", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = appJs.slice(start, end);

    // Route 1: the explicit table.
    const explicit = new Set();
    for (const m of block.matchAll(/"([a-z0-9-]+)":/g)) explicit.add(m[1]);

    // Route 2: every registered module's LAYER_NAME, slugified with the
    // SAME arithmetic getLayerSlug() uses.
    const slugify = (name) => name
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, "")
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const derived = new Set();
    for (const f of readdirSync(ROOT).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // BOTH spellings: the direct `LAYER_NAME: "…"` declaration, and
      // the field-layer factory's `layerName: "…"` argument (CAPE and
      // IVT are built that way — matching only the first spelling
      // would have failed the storm preset's two hardest slugs while
      // they resolved fine in the browser).
      //
      // …and BOTH ASSIGNMENTS. A module may declare its name either
      // way — `LAYER_NAME: "…"` (an object literal) or
      // `const LAYER_NAME = "…"` (a module constant) — and the
      // scanner used to see only the first. HWSD is the second kind
      // (`const LAYER_NAME = "🟫 Soil type (HWSD v2.2)"`), so the
      // owner's own portrait preset — which carries
      // `soil-type-hwsd-v2-2` — failed this gate even though the
      // slug resolves deterministically in the browser through
      // getLayerSlug()'s exact comparison. The same hole was found and
      // fixed in `panel-parity.bun.test.js` on 11-05; it was left here.
      for (const m of src.matchAll(/(?:LAYER_NAME|layerName)\s*[:=]\s*"([^"]+)"/g)) {
        derived.add(slugify(m[1]));
      }
    }
    // The routes must actually be different doors — a test that only
    // checked the explicit table would have passed while the table
    // silently stopped being the thing that resolves a slug.
    expect(derived.has("population-density-worldpop-1-km")).toBe(true);
    // …and the second spelling must be visible too (HWSD).
    expect(derived.has("soil-type-hwsd-v2-2")).toBe(true);
    expect(derived.has("tectonic-faults-usgs")).toBe(true);

    const slugs = new Set();
    for (const p of MP.presets()) {
      for (const ov of (MP.presetState(p) || {}).overlays || []) slugs.add(ov.slug);
    }
    expect(slugs.size).toBeGreaterThan(10);
    for (const slug of slugs) {
      const ok = explicit.has(slug) || derived.has(slug);
      expect(ok, `neither an explicit LAYER_SLUGS key nor a derived ` +
        `LAYER_NAME slug resolves "${slug}"`).toBe(true);
    }
  });

  test("the geology preset is the owner's revised hash, verbatim", () => {
    // Owner spec 2026-11-01, second draft: the first ran geology@75 at
    // zoom 3; "we might need to go slightly lighter" → geology@40 at
    // zoom 7. Third revision: "cool maps must not zoom in" → zoom 3.
    // Kept byte-for-byte.
    const p = MP.presetById("geology");
    expect(p).toBeTruthy();
    expect(p.hash).toBe(
      "#0.1923,15.5896,3/overlay=magnetic@100,etopo@55," +
      "geology-macrostrat@40,basins@80,rivers@100,soil-soilgrids@100");
    const s = MP.presetState(p);
    expect(s.zoom).toBe(3);
    // No density= segment: the preset must not touch pin density.
    expect(s.density).toBeUndefined();
    expect(s.overlays.length).toBe(6);
    const geo = s.overlays.find((o) => o.slug === "geology-macrostrat");
    expect(geo.pct).toBe(40);          // the "lighter" the owner asked for
    expect(p.tier).toBe("high");       // six overlays incl. soil + magnetic
  });

  test("every Cool maps preset is a GLOBAL view — never zoomed in", () => {
    // Owner rule 2026-11-01: "we don't want the geological maps or any
    // of the cool maps to zoom in, we just want global views." Every
    // chip opens at zoom ≤ 3 — near-global, continents readable, the
    // world filling the screen. A preset at zoom 7 (which is what
    // shipped once) shows one basin and hides the rest of the planet,
    // which is the opposite of what a showcase chip is for.
    //
    // The gate is ≤ 3, not == 3: a future FARTHER-out preset (zoom 2,
    // the whole globe) is more global, not less, and must pass.
    for (const p of MP.presets()) {
      const s = MP.presetState(p);
      expect(s, `${p.id} parsed`).toBeTruthy();
      expect(Number.isFinite(s.zoom), `${p.id} has a zoom`).toBe(true);
      expect(s.zoom, `${p.id} zoom ${s.zoom} is not a global view`)
        .toBeLessThanOrEqual(3);
    }
  });

  test("the storm preset is the owner's pasted weather hash, verbatim", () => {
    // Owner spec 2026-11-01: the ⛈️ Storm watch chip upgraded to their
    // fuller weather view — eleven overlays including the two whose
    // LAYER_NAME reaches them through the field-layer factory.
    const p = MP.presetById("storm");
    expect(p).toBeTruthy();
    expect(p.hash).toBe(
      "#3.4257,15.9961,3/density=high/overlay=temperature@30,wind-gfs@100," +
      "lightning@60,isobars@90,nasa-rain@100,nasa-sat@100,koppen@35," +
      "moisture-transport-ivt@45,rivers@100,basins@100," +
      "convective-instability-cape@45");
    const s = MP.presetState(p);
    expect(s.density).toBe("high");
    expect(s.zoom).toBe(3);
    expect(s.overlays.length).toBe(11);
    // The two factory-built names must be in the derived set — the slug
    // scan has to see `layerName:` as well as `LAYER_NAME:`.
    expect(s.overlays.map((o) => o.slug)).toContain("moisture-transport-ivt");
    expect(s.overlays.map((o) => o.slug)).toContain("convective-instability-cape");
    expect(p.tier).toBe("high");
  });

  test("the population preset is the owner's pasted hash, verbatim", () => {
    // Owner spec 2026-10-01: "population overlay default of something
    // like this", pasted as a live URL. Kept byte-for-byte so the chip
    // and the shared link stay the same map.
    const p = MP.presetById("population");
    expect(p).toBeTruthy();
    expect(p.hash).toBe(
      "#14.0087,14.9414,3/density=max/base=light/overlay=soil-soilgrids@45," +
      "population-density-worldpop-1-km@100,isobars@100,cropland-esa@45," +
      "koppen@30,basins@100,rivers@100,land-cover-esa@10,etopo@30");
    const s = MP.presetState(p);
    expect(s.base).toBe("light");
    expect(s.density).toBe("max");
    expect(s.zoom).toBe(3);
    expect(s.overlays.map((o) => o.slug)).toContain("population-density-worldpop-1-km");
    // Nine overlays — the heaviest preset, hence tier "high" so a thin
    // phone never auto-loads it.
    expect(s.overlays.length).toBe(9);
    expect(p.tier).toBe("high");
  });

  test("the low tier opens the SATELLITE view, and the high tier the showcase", () => {
    expect(MP.coolPreset(BIG_DESKTOP).id).toBe("portrait");
    expect(MP.coolPreset(OLD_PHONE).id).toBe("plain");
    // The light preset must not carry a binary-grid overlay: it is the
    // one a thin phone downloads on a first visit.
    const light = MP.presetState(MP.coolPreset(OLD_PHONE));
    const heavy = ["soil-soilgrids", "temperature", "wind", "lightning",
                   "phytoplankton", "salinity", "magnetic"];
    for (const ov of light.overlays || []) expect(heavy).not.toContain(ov.slug);
  });

  test("the LOW TIER carries NO OVERLAYS AT ALL — satellite and nothing else", () => {
    // Owner spec (2026-11-14): *"a low rez version without any overlays
    // except the satellite view"*.
    //
    // IT WAS NOT THAT BEFORE: the low tier was the "🌱 Climate skin",
    // and the city-name layer alone pulls the 1.16 MB city index — so
    // the "light" map was not light.
    const low = MP.presetState(MP.coolPreset(OLD_PHONE));
    expect(low.overlays).toBeUndefined();
    // The wind and the isobars — the two layers that made the old
    // default map "too slow on some computers" — are not in it either.
    expect(low.wind).toBeUndefined();
    expect(low.isoStep).toBeUndefined();
    expect(MP.coolPreset(OLD_PHONE).hash).not.toContain("overlay=");
  });

  test("the low tier is a GLOBAL view, like every other cool map", () => {
    // The cool maps are global views (zoom ≤ 3, an owner rule) and the
    // guard test walks every preset.
    const low = MP.presetState(MP.coolPreset(OLD_PHONE));
    expect(low.zoom).toBeLessThanOrEqual(3);
    // ...and its pins are MEDIUM, not max: the pins are the heaviest
    // thing a slow machine fetches (3,000 at max, 1,500 at medium).
    expect(low.density).toBe("medium");
  });
});

describe("bootPlan — what opens next visit", () => {
  const STATE = { lat: 1, lng: 2, zoom: 5, base: "dark",
                  overlays: [{ slug: "rivers", pct: 60 }], density: "high" };

  test("first visit ever → the cool map for this device", () => {
    const plan = MP.bootPlan(BIG_DESKTOP);
    expect(plan.source).toBe("cool");
    expect(plan.presetId).toBe("portrait");
    // A slow machine gets the SATELLITE view, not the showcase.
    expect(MP.bootPlan(OLD_PHONE).presetId).toBe("plain");
    const low = MP.bootPlan(OLD_PHONE).state;
    expect(low.overlays).toBeUndefined();
  });

  test("a saved ⭐ default beats the auto-saved last state", () => {
    MP.autoSave(STATE);
    expect(MP.bootPlan(BIG_DESKTOP).source).toBe("auto");
    MP.saveDefault({ ...STATE, base: "topo" });
    const plan = MP.bootPlan(BIG_DESKTOP);
    expect(plan.source).toBe("saved");
    expect(plan.state.base).toBe("topo");
  });

  test("no default yet → the last-used state", () => {
    MP.autoSave(STATE);
    const plan = MP.bootPlan(BIG_DESKTOP);
    expect(plan.source).toBe("auto");
    expect(plan.state.base).toBe("dark");
    expect(plan.state.overlays).toEqual([{ slug: "rivers", pct: 60 }]);
  });

  test('mode "cool" re-opens the preset even with a saved default', () => {
    MP.saveDefault(STATE);
    MP.setMode("cool");
    const plan = MP.bootPlan(BIG_DESKTOP);
    expect(plan.source).toBe("cool");
    expect(plan.presetId).toBe("portrait");
  });

  test('mode "saved" with a vanished default falls back to last-used', () => {
    MP.autoSave(STATE);
    MP.setMode("saved");
    const plan = MP.bootPlan(BIG_DESKTOP);
    expect(plan.source).toBe("auto");
  });

  test("an unknown stored mode reads as auto", () => {
    globalThis.localStorage.setItem(MP.MODE_KEY, "banana");
    expect(MP.getMode()).toBe("auto");
    MP.autoSave(STATE);
    expect(MP.bootPlan(BIG_DESKTOP).source).toBe("auto");
  });

  test("clearing the ⭐ default leaves last-used in charge", () => {
    MP.autoSave(STATE);
    MP.saveDefault(STATE);
    expect(MP.bootPlan(BIG_DESKTOP).source).toBe("saved");
    MP.clearDefault();
    expect(MP.bootPlan(BIG_DESKTOP).source).toBe("auto");
  });
});

describe("storage hygiene", () => {
  test("a corrupted default is discarded, not applied", () => {
    globalThis.localStorage.setItem(MP.DEFAULT_KEY, "{not json");
    expect(MP.getDefault()).toBeNull();
    globalThis.localStorage.setItem(MP.DEFAULT_KEY, JSON.stringify({ lat: "x", junk: 1 }));
    // A state with nothing usable in it must not reach applyMapState —
    // its removal half would strip every overlay off the map.
    expect(MP.getDefault()).toBeNull();
  });

  test("sanitizeState keeps only what applyMapState knows", () => {
    const clean = MP.sanitizeState({
      lat: 10, lng: 20, zoom: 4, base: "dark", density: "max",
      overlays: [{ slug: "rivers", pct: 55 }, { slug: "" }, null,
                 { slug: "waves", pct: 999 }],
      search: "should not survive", pinId: 42,
    });
    expect(clean.search).toBeUndefined();
    expect(clean.pinId).toBeUndefined();
    expect(clean.overlays).toEqual([{ slug: "rivers", pct: 55 }, { slug: "waves", pct: 100 }]);
  });

  test("a fractional isobar step survives the round trip unchanged", () => {
    // sanitizeState used to do `Math.round(isoStep)`, which cannot
    // represent any step on the ladder below 1 hPa:
    //   Math.round(0.5)  -> 1   (saved as 1, then APPLIED as 1 — a
    //                            wrong step, not a dropped one)
    //   Math.round(0.25) -> 0   (setStep(0) is rejected, so the value
    //                            was quietly ignored)
    //   Math.round(0.1)  -> 0   (same, for the 0.10 chip)
    // The stored default, the last-used state and every preset hash go
    // through here, so the reader's chosen detail must come back exactly.
    for (const step of [0.1, 0.25, 0.5, 1, 2, 4, 8, 16]) {
      const clean = MP.sanitizeState({ lat: 1, lng: 2, zoom: 3, isoStep: step });
      expect(clean.isoStep, `sanitizeState(${step})`).toBe(step);
    }
    // And the same through the hash parser a preset uses.
    for (const step of ["0.1", "0.25", "0.5", "16"]) {
      const s = MP.parseHash(`#1,2,3/iso=${step}`);
      expect(s && s.isoStep, `iso=${step}`).toBe(Number(step));
    }
  });

  test("a bare slug in a hash still parses (old links mean 100%)", () => {
    const s = MP.parseHash("#1,2,3/overlay=rivers,basins@40");
    expect(s.overlays).toEqual([{ slug: "rivers" }, { slug: "basins", pct: 40 }]);
  });

  test("an impossible hash drops the coordinates, keeps nothing harmful", () => {
    const s = MP.parseHash("#999,999,99/overlay=rivers");
    expect(s).toBeTruthy();
    expect(s.lat).toBeUndefined();
    expect(s.zoom).toBeUndefined();
    // A hash with no usable part at all is null.
    expect(MP.parseHash("#zzz")).toBeNull();
  });
});

describe("app.js — boot order, auto-save and the panel buttons", () => {
  test("the module loads before app.js and both name the same global", () => {
    const at = indexHtml.indexOf('src="map-presets.js');
    const appAt = indexHtml.indexOf('src="app.js');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(appJs).toMatch(/window\.MapPresets/);
  });

  test("a URL hash wins: the boot plan is consulted AFTER the hash paths", () => {
    const restoreAt = appJs.indexOf("function _restoreMapView()");
    const hashApply = appJs.indexOf("applyLayersFromParsedHash(hashView)", restoreAt);
    const queryApply = appJs.indexOf('urlParams.has("overlay")', restoreAt);
    const planAt = appJs.indexOf("MapPresets.bootPlan", restoreAt);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(hashApply).toBeGreaterThan(restoreAt);
    expect(queryApply).toBeGreaterThan(hashApply);
    expect(planAt).toBeGreaterThan(queryApply);
    // …and before the bare position-only restore.
    const viewKey = appJs.indexOf('"xyzo-map-view"', planAt);
    expect(viewKey).toBeGreaterThan(planAt);
  });

  test("applyMapState goes through the saved-style path (one route)", () => {
    expect(appJs).toMatch(/function applyMapState\(/);
    expect(appJs).toMatch(/function captureMapState\(/);
    const at = appJs.indexOf("function applyMapState(");
    const body = appJs.slice(at, at + 1600);
    expect(body).toMatch(/applySavedStyle\(/);
    // The removal half is what makes "Clear" survive a module that
    // restores itself from its own localStorage key.
    expect(body).toMatch(/keepView/);
  });

  test("every state change auto-saves the last-used map, flushed on pagehide", () => {
    expect(appJs).toMatch(/function scheduleMapStateSave\(/);
    // Hooked at the single choke point every change already goes
    // through — not to a partial list of map events.
    const updAt = appJs.indexOf("function updateUrlHash()");
    expect(appJs.slice(updAt, updAt + 600)).toMatch(/scheduleMapStateSave\(\)/);
    expect(appJs).toMatch(/addEventListener\("pagehide"/);
    expect(appJs).toMatch(/MapPresets\.autoSave\(captureMapState\(\)\)/);
  });

  test("the layers panel carries ✨ presets, ↺ Clear and ⤢ Reset", () => {
    expect(appJs).toMatch(/function mountMapPresetRow\(/);
    expect(appJs).toMatch(/function clearAllOverlays\(/);
    expect(appJs).toMatch(/function resetMap\(/);
    // The row must be a SIBLING of the lists Leaflet rebuilds.
    const at = appJs.indexOf("function mountMapPresetRow(");
    // 2600 was enough until the map-settings telemetry hook went into
    // the preset click handler (`_lastPresetId` + `sendMapSettings`) —
    // it pushed the Clear and Reset buttons past the window. The window
    // is a heuristic for "the body of this function"; widen it rather
    // than narrow the function.
    const body = appJs.slice(at, at + 4200);
    expect(body).toMatch(/insertAdjacentElement\("afterend"/);
    expect(body).toMatch(/data-preset/);
    expect(body).toMatch(/xyzo-clear-overlays/);
    expect(body).toMatch(/xyzo-reset-map/);
    // Clear must not move the camera.
    expect(appJs.slice(appJs.indexOf("function clearAllOverlays("),
                       appJs.indexOf("function resetMap("))).toMatch(/keepView:\s*true/);
    // Reset returns opacities to the layers' own defaults and lands on
    // the factory view.
    expect(appJs.slice(appJs.indexOf("function resetMap("),
                       appJs.indexOf("function mountMapPresetRow(")))
      .toMatch(/OverlayOpacity\.reset/);
  });

  test("a Cool-maps chip swaps the LAYERS and leaves the camera alone", () => {
    // Owner ask (2026-11-01): "when you select various cool maps can you
    // keep the perspective and zoom level and just update the
    // selections... often people want to change the settings but keep
    // the zoom and perspective."
    //
    // This is a trap because a preset is stored as a FULL app hash —
    // `#lat,lng,zoom/density=…/overlay=slug@pct,…` — and deliberately
    // runs through the same parse/apply path a shared URL uses (so a
    // preset, a pasted link and a saved style can never diverge).
    // presetState() therefore hands back lat/lng/zoom, and
    // applyMapState() calls map.setView() whenever all three are
    // finite. Without keepView, clicking a chip TELEPORTS the camera to
    // the preset's own hard-coded centre and zoom.
    //
    // Note what this does and does not replace: the earlier rule that
    // presets must be a GLOBAL view (zoom <= 3, see the test above)
    // only narrowed WHERE a chip flung you — it never stopped the
    // flinging. keepView is what stops it.
    //
    // keepView is the same flag Clear already passes for the same
    // reason, and it is deliberately NOT passed by Reset — whose entire
    // job is to go back to the world view. Hence both assertions.
    const at = appJs.indexOf("function mountMapPresetRow(");
    const body = appJs.slice(at, appJs.indexOf("function mountIsobarRow("));

    const chipApply = body.match(
      /chip\.addEventListener\("click"[\s\S]{0,400}?applyMapState\([^;]*;/,
    );
    expect(chipApply, "the chip click handler must reach applyMapState").toBeTruthy();
    expect(chipApply[0]).toMatch(/keepView:\s*true/);

    // Reset must still MOVE the camera, or the button stops doing the
    // one thing its label promises ("Back to the start: world view").
    const resetBody = appJs.slice(appJs.indexOf("function resetMap("),
                                  appJs.indexOf("function mountMapPresetRow("));
    expect(resetBody).not.toMatch(/keepView/);
    expect(resetBody).toMatch(/WORLD_VIEW/);
  });

  test("MY STYLE offers ⭐ Save as default and the next-visit picker", () => {
    expect(indexHtml).toMatch(/id="ctrl-save-default"/);
    expect(indexHtml).toMatch(/id="default-mode-picker"/);
    for (const mode of ["auto", "saved", "cool"]) {
      expect(indexHtml).toMatch(new RegExp(`data-next-map="${mode}"`));
    }
    expect(indexHtml).toMatch(/id="default-style-status"/);
    expect(appJs).toMatch(/ctrl-save-default/);
    // The wiring aliases MapPresets to MP inside the block.
    expect(appJs).toMatch(/MP\.saveDefault\(captureMapState\(\)\)/);
    expect(appJs).toMatch(/data-next-map/);
  });

  test("the panel row is styled for Leaflet's LIGHT card", () => {
    for (const sel of [".leaflet-presets-row", ".leaflet-preset-chip",
                       ".leaflet-preset-action", ".leaflet-presets-actions"]) {
      expect(stylesCss).toMatch(new RegExp(sel.replace(".", "\\.")));
    }
  });

  test("map-presets.js and overlay-opacity.js move via bump_asset_token.sh", () => {
    // AGENTS.md: these two are DELIBERATELY not in bump_frontend.sh's
    // ASSETS — a per-asset token keeps a one-file change from busting
    // the whole page's cache. The tool must exist and must name them.
    const bumpSh = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
    const assetsLine = (bumpSh.match(/^ASSETS=".*"$/m) || [""])[0];
    expect(assetsLine).not.toContain("map-presets.js");
    expect(assetsLine).not.toContain("overlay-opacity.js");
    const perAsset = readFileSync(
      join(ROOT, "..", "scripts", "bump_asset_token.sh"), "utf8");
    expect(perAsset).toMatch(/index\.html/);
    // …and the page must actually carry a stamped token for both.
    expect(indexHtml).toMatch(/map-presets\.js\?v=\d+/);
    expect(indexHtml).toMatch(/overlay-opacity\.js\?v=\d+/);
  });
});

describe("overlay-opacity reset", () => {
  test("reset() is exported and restores the CAPTURED defaults", () => {
    expect(opacityJs).toMatch(/function reset\(overlays\)/);
    expect(opacityJs).toMatch(/reset \}/);
    // The default must be captured before any slider can clobber it —
    // Leaflet's setOpacity writes into options.opacity, so at reset
    // time the layer itself has forgotten.
    expect(opacityJs).toMatch(/function captureDefaults\(overlays\)/);
    expect(opacityJs).toMatch(/captureDefaults\(overlays\);\s*\n\s*const stored = loadStored\(\)/);
  });
});

describe("the WIND MAP preset (owner, 2026-11-03)", () => {
  test("it exists, with the owner's layers", () => {
    const p = MP.presetById("wind");
    expect(p).toBeTruthy();
    expect(p.icon).toBe("🌬️");
    expect(p.name).toBe("🌬️ Wind map");
    const s = MP.presetState(p);
    expect(s).toBeTruthy();
    const slugs = s.overlays.map((o) => o.slug);
    // The wind animation over the wind SPEED field, the isobars at their
    // finest, and the land for context.
    expect(slugs).toContain("wind-gfs");
    expect(slugs).toContain("wind-speed-gfs");
    expect(slugs).toContain("isobars");
    expect(slugs).toContain("basins");
    expect(slugs).toContain("koppen");
    expect(slugs).toContain("etopo");
    expect(s.overlays.find((o) => o.slug === "wind-speed-gfs").pct).toBe(35);
  });

  test("it is a GLOBAL view like every other chip", () => {
    // The owner's rule: "cool maps are GLOBAL views — never zoomed in".
    const s = MP.presetState(MP.presetById("wind"));
    expect(s.zoom).toBeLessThanOrEqual(3);
  });

  test("it carries the isobar DETAIL and the wind's STYLE and COLOUR", () => {
    // These are part of the style, so a preset that names them must
    // carry them — otherwise the curated view is not the view that was
    // curated.
    const p = MP.presetById("wind");
    expect(p.hash).toContain("/iso=1");
    expect(p.hash).toContain("wind=flow:colourful");
    const s = MP.presetState(p);
    expect(s.isoStep).toBe(1);
    expect(s.wind).toEqual({ style: "flow", colour: "colourful" });
  });
});

describe("the preset grammar carries the style settings", () => {
  test("`iso=` and `wind=` are parsed", () => {
    // They used to be silently DROPPED, so a preset (or a saved style)
    // that named them opened the isobars at the reader's own step and
    // the wind in the reader's own rendering.
    const s = MP.parseHash(
      "#10,20,3/density=max/overlay=isobars@90/iso=1/wind=flow:colourful");
    expect(s.isoStep).toBe(1);
    expect(s.wind).toEqual({ style: "flow", colour: "colourful" });
  });

  test("a bare `wind=flow` still parses (the colour is optional)", () => {
    const s = MP.parseHash("#10,20,3/overlay=wind-gfs@100/wind=flow");
    expect(s.wind).toEqual({ style: "flow" });
  });

  test("a corrupt step is dropped, not passed on", () => {
    expect(MP.parseHash("#10,20,3/iso=0").isoStep).toBeUndefined();
    expect(MP.parseHash("#10,20,3/iso=abc").isoStep).toBeUndefined();
  });

  test("app.js writes both segments", () => {
    expect(appJs).toMatch(/res\.isoStep = n;/);
    expect(appJs).toMatch(/res\.wind = \{\};/);
    expect(appJs).toMatch(/const iso = \(isoStep != null && isobarsOn\)/);
    // THREE fields — style, colour AND density. The old two-field
    // template this test used to pin is exactly what the density change
    // replaced: a writer emitting two fields cannot carry a third, and
    // the reader's own stored density would then decide what the sender
    // was looking at.
    expect(appJs).toMatch(/wind = `\/wind=\$\{st\}:\$\{co\}:\$\{Math\.round\(dn\)\}`/);
    // Written whenever the wind is ON, defaults and all — the iso= rule.
    // The old "omit when both are the default" condition must be gone,
    // or a link from a sender on the default hands the receiver's
    // stored style, colour and density back at them.
    expect(appJs).not.toMatch(/\(st && st !== defSt\) \|\| \(co && co !== defCo\)/);
  });

  test("app.js APPLIES both — a link that names them is honoured", () => {
    expect(appJs).toMatch(/window\.WindLayer\.setStyle\(parsed\.wind\.style\)/);
    expect(appJs).toMatch(/window\.WindLayer\.setColorMode\(parsed\.wind\.colour\)/);
    expect(appJs).toMatch(/window\.WindLayer\.setDensity\(parsed\.wind\.density\)/);
    expect(appJs).toMatch(/window\.IsobarLayer\.setStep\(parsed\.isoStep, \{ persist: false \}\)/);
  });

  test("the wind segment parses THREE fields — style, colour, density", () => {
    // The old `^wind=([^:/]+)(?::([^:/]+))?$` is anchored at the end,
    // so a third field matched NOTHING and the whole segment — style
    // and colour included — was silently dropped. That is the trap the
    // iso= colour suffix had, one field further along.
    const full = MP.parseHash("#10,20,3/overlay=wind-gfs@100/wind=particles:speed:250");
    expect(full.wind).toEqual({ style: "particles", colour: "speed", density: 250 });
    // The two-field form still parses, with no density — every link
    // written before this change has to keep opening.
    const legacy = MP.parseHash("#10,20,3/overlay=wind-gfs@100/wind=particles:speed");
    expect(legacy.wind).toEqual({ style: "particles", colour: "speed" });
    // Bare style still parses (the colour was always optional).
    const bare = MP.parseHash("#10,20,3/overlay=wind-gfs@100/wind=flow");
    expect(bare.wind).toEqual({ style: "flow" });
    // `wind=particles:200` — colour omitted, density present. Read as a
    // DENSITY, because globe-wind.js's reader already reads it that way
    // and two readers disagreeing about one link is the bug the shared
    // grammar exists to prevent.
    const numericSecond = MP.parseHash("#10,20,3/overlay=wind-gfs@100/wind=particles:200");
    expect(numericSecond.wind).toEqual({ style: "particles", density: 200 });
    // A non-numeric density is dropped rather than becoming NaN — a NaN
    // would multiply every count to NaN and draw nothing at all.
    const junk = MP.parseHash("#10,20,3/overlay=wind-gfs@100/wind=particles:speed:banana");
    expect(junk.wind).toEqual({ style: "particles", colour: "speed" });
  });

  test("a saved style and the last-used map carry them too", () => {
    expect(appJs).toMatch(/isoStep: style\.isoStep != null \? style\.isoStep : undefined/);
    expect(appJs).toMatch(/wind: style\.wind \|\| undefined/);
    expect(appJs).toMatch(/isoStep: state\.isoStep != null \? state\.isoStep : undefined/);
  });
});

describe("the isobar chips tell the truth when the step comes from a link", () => {
  test("setStep repaints the chips itself", () => {
    // A step that arrives in a link or a preset changes the step with
    // no click, so the click handler cannot be the only place that
    // repaints — the dropdown would say "4 hPa" while the map drew
    // 1 hPa.
    const js = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
    const fn = js.slice(js.indexOf("function setStep("));
    const body = fn.slice(0, fn.indexOf("\n  function getStep"));
    expect(body).toMatch(/paintStep\(\)/);
    // And the painter must be reachable from setStep — i.e. at module
    // scope, not buried inside the mount function.
    expect(js).toMatch(/^  function paintStep\(\)/m);
  });
});

afterAll(() => {
  if (realStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = realStorage;
});
