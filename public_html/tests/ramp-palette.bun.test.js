// ramp-palette.bun.test.js — selectable colour styles for data overlays.
//
// The ask: "various rainbow color styles we can use for any of the data
// overlays", and "i can't seem to find it" — so the controls must exist,
// be reachable, and actually change the picture.
//
// Verified in a browser before these were written (scripts/palette_check.py):
//   temperature row -> <select> with rainbow/viridis/turbo/inferno/warm/cool/greyscale
//   population row  -> <select> with none/rainbow/vivid/thermal/mono/sepia
//   Köppen + Soil   -> NO select (categorical: their colours are meaning)
//   picking rainbow -> legend gradient CHANGES, localStorage written,
//                      and after a reload getPalette() is still 'rainbow'
//   greyscale -> rainbow gives different screenshot hashes, i.e. the MAP
//                repaints and not just the control
//
// Three bugs this pins, all found by running it rather than reading it:
//   1. ramp-styles.js was never added to index.html, so window.RampStyles
//      was undefined and OverlayPalette returned silently — no controls
//      anywhere, with no error.
//   2. setPalette was an object method inside the export, but the arrow
//      attached to the tile layer calls it by name → ReferenceError,
//      swallowed by applyTo's catch, so nothing was written.
//   3. the legend bar kept the PUBLISHED gradient after a palette change,
//      promising one scheme while the tiles painted another.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const src = readFileSync(join(ROOT, "ramp-styles.js"), "utf8");
const paletteJs = readFileSync(join(ROOT, "overlay-palette.js"), "utf8");
const opacityJs = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");
const tempJs = readFileSync(join(ROOT, "temp-layer.js"), "utf8");
const popJs = readFileSync(join(ROOT, "population-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

// Run the real module.
const w = {};
new Function("window", src)(w);
const R = w.RampStyles;

describe("the palettes", () => {
  test("a rainbow plus the usual scientific alternatives", () => {
    for (const p of ["rainbow", "viridis", "turbo", "inferno", "warm", "cool", "greyscale"]) {
      expect(R.RAMPS[p], `missing palette ${p}`).toBeTruthy();
      expect(R.RAMPS[p].length).toBeGreaterThanOrEqual(2);
      for (const hex of R.RAMPS[p]) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(R.RAMP_ORDER).toContain("rainbow");
    expect(Object.keys(R.RAMP_LABELS).length).toBe(R.RAMP_ORDER.length);
    expect(Object.keys(R.RAMP_HINTS).length).toBe(R.RAMP_ORDER.length);
  });

  test("every swatch is a CSS gradient a legend can print", () => {
    for (const p of R.RAMP_ORDER) {
      expect(R.swatch(p)).toMatch(/^linear-gradient\(to right, #/);
    }
  });
});

describe("recolor keeps the DATA and changes only the COLOUR", () => {
  const ramp = [
    { c: -40, rgb: "#0a0316", f: -40 },
    { c: 0, rgb: "#4ade80", f: 32 },
    { c: 30, rgb: "#450a0a", f: 86 },
  ];

  test("stop positions (c) survive — they are what the probe reads", () => {
    for (const name of R.RAMP_ORDER) {
      const out = R.recolor(ramp, name);
      expect(out.map((o) => o.c)).toEqual(ramp.map((o) => o.c));
    }
  });

  test("sibling fields (f) are copied through, not dropped", () => {
    const out = R.recolor(ramp, "turbo");
    expect(out.map((o) => o.f)).toEqual([-40, 32, 86]);
  });

  test("it is pure — the published ramp is never mutated", () => {
    const before = ramp.map((o) => o.rgb).join(",");
    R.recolor(ramp, "rainbow");
    expect(ramp.map((o) => o.rgb).join(",")).toBe(before);
  });

  test("the first and last stops land on the palette's ends", () => {
    const out = R.recolor(ramp, "greyscale");
    expect(out[0].rgb).toBe(R.RAMPS.greyscale[0]);
    expect(out[out.length - 1].rgb).toBe(
      R.RAMPS.greyscale[R.RAMPS.greyscale.length - 1]);
  });

  test("sample() interpolates rather than stepping", () => {
    const g = R.RAMPS.greyscale;
    const mid = R.sample(g, 0.5);
    // a step function would return one of the stops exactly
    expect(mid).toMatch(/^#[0-9a-f]{6}$/i);
    expect(R.sample(g, 0)).toBe(g[0]);
    expect(R.sample(g, 1)).toBe(g[g.length - 1]);
  });

  test("an unknown palette leaves the ramp alone (never renders black)", () => {
    expect(R.recolor(ramp, "nope")).toEqual(ramp);
    expect(R.recolor(null, "rainbow")).toBeNull();
    expect(R.recolor([], "rainbow")).toEqual([]);
  });
});

describe("categorical overlays are refused, not recoloured", () => {
  test("their colours are their meaning", () => {
    for (const f of ["climate-layer.js", "soil-layer.js", "cropland-layer.js",
                     "phytoplankton-layer.js", "basin-layer.js", "languages-layer.js"]) {
      expect(R.isCategorical(f), `${f} should be categorical`).toBe(true);
      expect(R.hasPalette(f)).toBe(false);
    }
    expect(R.isCategorical("temp-layer.js")).toBe(false);
  });

  test("the filter styles are honest about being a rendering shift", () => {
    // No value data, so no value-mapped rainbow: the label says BOTH
    // what a reader will reach for ("Rainbow") and what it actually is
    // (a hue shift), so nobody is misled into reading a colour order the
    // data does not have.
    expect(R.FILTER_ORDER).toContain("rainbow");
    expect(R.FILTER_STYLES.rainbow.label).toMatch(/Rainbow/);
    expect(R.FILTER_STYLES.rainbow.label).toMatch(/hue shift/i);
    expect(R.FILTER_STYLES.none.css).toBe("none");
    expect(Object.keys(R.FILTER_STYLES).length).toBe(R.FILTER_ORDER.length);
  });
});

describe("the picker mounts where it can and nowhere else", () => {
  test("it is capability-driven, not a filename list", () => {
    // A list of "which files get a picker" is a second source of truth
    // that goes stale the moment a layer is added.
    expect(paletteJs).toMatch(/function modeFor\(layer\)/);
    expect(paletteJs).toMatch(/typeof layer\.setPalette === "function"/);
    expect(paletteJs).toMatch(/typeof layer\.setFilter === "function"/);
    expect(paletteJs).not.toMatch(/climate-layer\.js|soil-layer\.js/);
  });

  test("and it double-checks the categorical guard", () => {
    expect(paletteJs).toMatch(/styles\(\)\.isCategorical/);
  });

  test("OverlayOpacity drives it — app.js never mentions it", () => {
    // The row-walking machinery lives in overlay-opacity.js; app.js
    // never names it. (Its comment used to cite "8 bytes under the
    // 850,000 ceiling" as the reason — the size ceilings were all
    // removed 2026-11-01; see code-splitting.bun.test.js. The split
    // itself still stands and is asserted just below.)
    expect(opacityJs).toMatch(/OverlayPalette\.mountRow\(row, key, layer\)/);
    // Reached as a GLOBAL through this file's own scope alias `G`
    // (which IS `window` in a browser) — never handed in by app.js,
    // which is what makes this a real split rather than a wire-up.
    // A bare `window` inside mount() instead made the function throw
    // ReferenceError outside a browser, so the module's own resilience
    // test only passed when another test file had leaked a `window`
    // into the global scope first.
    expect(opacityJs).toMatch(/\bG\.OverlayPalette\b/);
    expect(opacityJs).not.toMatch(/window\.OverlayPalette/);
    expect(appJs).not.toMatch(/OverlayPalette/);
  });

  test("both scripts load before app.js and are stamped", () => {
    const appAt = indexHtml.indexOf("app.js?");
    for (const f of ["ramp-styles.js", "overlay-palette.js"]) {
      const at = indexHtml.indexOf(f);
      expect(at, `${f} missing from index.html`).toBeGreaterThan(-1);
      expect(at, `${f} must load before app.js`).toBeLessThan(appAt);
      expect(indexHtml.match(new RegExp(`<script src="${f}`)).length, `${f} twice`).toBe(1);
      expect(bump, `${f} not in ASSETS`).toMatch(new RegExp(f.replace(".", "\\.")));
    }
    // ramp-styles FIRST: without it window.RampStyles is undefined and
    // the picker returns silently — no controls, no error.
    expect(indexHtml.indexOf("ramp-styles.js"))
      .toBeLessThan(indexHtml.indexOf("overlay-palette.js"));
  });
});

describe("a layer must expose the hook on the LAYER OBJECT", () => {
  // The dropdown is handed what WEATHER_OVERLAYS holds — the TileLayer /
  // GridLayer returned by getTileLayer() — never window.TempLayer. A hook
  // defined only as an object method is invisible to it.
  test("temperature attaches setPalette to the instance it returns", () => {
    expect(tempJs).toMatch(/state\.overlay\.setPalette = \(n\) => setPalette\(n\)/);
  });

  test("and setPalette is a MODULE-LEVEL function it can name", () => {
    // An object method is not in the arrow's scope: this threw
    // "ReferenceError: setPalette is not defined", which applyTo caught
    // and swallowed, so the picker wrote nothing at all.
    expect(tempJs).toMatch(/\n  function setPalette\(name\) \{/);
    // ...and it is exported, not re-defined inline in the object
    expect(tempJs).toMatch(/\n    setPalette,\n/);
  });

  test("population attaches setFilter the same way", () => {
    expect(popJs).toMatch(/layer\.setFilter = \(n\) => setFilter\(n\)/);
    expect(popJs).toMatch(/function setFilter\(name\)/);
    expect(popJs).toMatch(/\n    setFilter,\n/);
  });
});

describe("the choice is a PREFERENCE, not a session accident", () => {
  test("temperature stores it even while the layer is off", () => {
    // The layer is usually OFF when someone picks a scheme, so meta has
    // not loaded — a guard on state.meta would refuse the choice and the
    // dropdown would appear to do nothing.
    expect(tempJs).toMatch(/function setPalette\(name\)[\s\S]{0,400}localStorage\.setItem\(PALETTE_STORE_KEY, want\)/);
    expect(tempJs).not.toMatch(/if \(!R \|\| !state\.meta/);
  });

  test("and restores it on init", () => {
    expect(tempJs).toMatch(/state\.palette = storageGet\(PALETTE_STORE_KEY, "default"\)/);
  });

  test("the ramp is DERIVED on demand so no cached copy can drift", () => {
    expect(tempJs).toMatch(/function activeRamp\(meta\)/);
    expect(tempJs).toMatch(/return R\.recolor\(meta\.ramp, state\.palette\)/);
    // no rampBase cache left over from an earlier attempt
    expect(tempJs).not.toMatch(/rampBase =/);
  });

  test("population persists its filter too", () => {
    expect(popJs).toMatch(/const FILTER_STORE_KEY = "xyzo\.populationFilter"/);
    expect(popJs).toMatch(/storageSet\(FILTER_STORE_KEY, name\)/);
    expect(popJs).toMatch(/state\.filter = storageGet\(FILTER_STORE_KEY, "none"\)/);
  });
});

describe("the legend cannot promise one scheme while the map paints another", () => {
  test("the gradient reads the ACTIVE ramp, not the published one", () => {
    expect(tempJs).toMatch(/const stops = activeRamp\(meta\)/);
    expect(tempJs).not.toMatch(/const stops = meta\.ramp/);
  });

  test("and a palette change rebuilds the legend bar", () => {
    expect(tempJs).toMatch(/buildLegend\(state\.meta\)/);
  });

  test("both caches are invalidated so the old scheme cannot be blitted", () => {
    const fn = tempJs.slice(tempJs.indexOf("function setPalette(name)"));
    const body = fn.slice(0, fn.indexOf("\n  window.TempLayer"));
    expect(body).toMatch(/LUT = null/);
    expect(body).toMatch(/BAKED = null/);
    expect(body).toMatch(/state\.overlay\.redraw\(\)/);
  });
});
