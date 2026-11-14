// default-map-button.bun.test.js — the 🛰️ "Default map" button in the
// bottom bar. (Owner spec 2026-11-13.)
//
// OWNER ASK: *"can you have a easy way to 'clear the map to a default
// satellite only view' maybe down near [the ⚙ button]"* — and then, with
// a map of their own: *"maybe this default map is wiser?"*.
//
// AND THEN (owner, 2026-11-14): *"its just too slow on some
// computers"* — so the button went BACK to what the first ask said it
// was. The owner's own map carried the WIND ANIMATION over the pressure
// lines, and an animated canvas that repaints every frame over a field
// that has to be fetched and contoured first is the most expensive thing
// on the page. **THE BUTTON IS THE SATELLITE VIEW AGAIN** — the world on
// the satellite basemap, the pin density at max, and no overlays at all.
//
// THE CONTRACT THIS FILE PINS
//   1. THE BUTTON IS THERE, in the bottom bar, next to the ⚙ — and it
//      says what it does (an accessible name, not an icon alone).
//   2. IT IS ONE BUTTON, not two copies of the view. The default map is
//      a HASH, parsed by the same parser a preset and a shared link use
//      and applied through the same applyMapState() — a button that
//      assembled the map by hand would be a second implementation of
//      "what a map is", and the second implementation is the one that
//      drifts.
//   3. THE HASH IS THE OWNER'S, VERBATIM — the satellite view they
//      linked to: #19.9733,0.0000,2/density=max.
//   4. IT LANDS ON THE SATELLITE BASEMAP, WITH NO OVERLAYS. The hash
//      names no base layer, so the button states the base itself: a
//      reader who is on the street map and presses it gets the default
//      BASEMAP too. And the hash names no overlay either — which is the
//      POINT: the hash-apply path only ADDS, but applySavedStyle()
//      REMOVES every overlay the state does not contain first, so a
//      hash with no overlays list is a hash that says "none" and the
//      button CLEARS the map rather than adding to it.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import "../map-presets.js";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const presetsJs = readFileSync(join(ROOT, "map-presets.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

const MP = globalThis.MapPresets;

describe("the button itself", () => {
  test("it is in the BOTTOM BAR, beside the ⚙ control menu", () => {
    expect(indexHtml).toContain('id="default-map-btn"');
    // It must be INSIDE #bottom-bar, and it must come BEFORE the ⚙
    // (the ⚙ is the last thing in the bar, so the new button sits at
    // the right-hand end next to it).
    const barStart = indexHtml.indexOf('id="bottom-bar"');
    const barEnd = indexHtml.indexOf("<!-- /bottom-bar -->");
    const btn = indexHtml.indexOf('id="default-map-btn"');
    const gear = indexHtml.indexOf('id="control-menu-btn"');
    expect(barStart).toBeGreaterThan(-1);
    expect(btn).toBeGreaterThan(barStart);
    expect(btn).toBeLessThan(barEnd);
    expect(gear).toBeGreaterThan(btn);
  });

  test("it says what it does — an icon alone is not a label", () => {
    const tag = indexHtml.slice(indexHtml.indexOf('id="default-map-btn"'),
                               indexHtml.indexOf('id="default-map-btn"') + 400);
    expect(tag).toMatch(/aria-label="[^"]{6,}"/);
    expect(tag).toMatch(/title="[^"]{6,}"/);
  });

  test("it is wired to applyDefaultMap()", () => {
    expect(appJs).toMatch(/function applyDefaultMap\(\)/);
    expect(appJs).toContain('document.getElementById("default-map-btn")');
  });

  test("the ⚙ menu carries the same action — the BAR has no room on a phone", () => {
    // MEASURED on a 393 px phone: the language switcher takes 157 px
    // and each button is 44 px (the WCAG floor), so a sixth button
    // pushes the ⚙ — the LAST item in the bar — 29 px off the right
    // edge, and the whole control menu with it.
    expect(indexHtml).toContain('id="ctrl-default-map-btn"');
    expect(appJs).toContain('document.getElementById("ctrl-default-map-btn")');
    // …and the bar button is hidden below 560 px.
    expect(stylesCss).toMatch(/@media \(max-width: 559px\)[\s\S]{0,200}?#default-map-btn\s*\{\s*display:\s*none;/);
  });
});

describe("it is ONE implementation, not a second", () => {
  test("applyDefaultMap() goes through MapPresets + applyMapState()", () => {
    const fn = appJs.slice(appJs.indexOf("function applyDefaultMap()"),
                           appJs.indexOf("function applyDefaultMap()") + 700);
    expect(fn).toContain("defaultMapState");
    expect(fn).toContain("applyMapState(state)");
    // It must NOT name layers of its own: the default map is a hash, and
    // the hash is the map's vocabulary.
    expect(fn).not.toMatch(/WEATHER_OVERLAYS\[/);
    expect(fn).not.toMatch(/IsobarLayer\.setEnabled|WindLayer\.setStyle/);
  });

  test("the default map is a HASH in map-presets.js, parsed by the shared parser", () => {
    expect(presetsJs).toMatch(/const DEFAULT_MAP = \{/);
    expect(presetsJs).toContain("parseHash(DEFAULT_MAP.hash)");
    // The state is built by parseHash — the same function a preset uses.
    expect(presetsJs).toMatch(/function defaultMapState\(\)[\s\S]{0,400}parseHash\(/);
  });
});

describe("the default map itself — the satellite view, verbatim", () => {
  test("the hash is the owner's, character for character", () => {
    // The link the owner pasted for the view they want the button to
    // restore: the world, the satellite basemap, the pins at max.
    expect(MP.DEFAULT_MAP.hash).toBe("#19.9733,0.0000,2/density=max");
  });

  test("it parses into a complete state", () => {
    const s = MP.defaultMapState();
    expect(s).toBeTruthy();
    expect(s.lat).toBeCloseTo(19.9733, 6);
    expect(s.lng).toBeCloseTo(0.0000, 6);
    expect(s.zoom).toBe(2);
    expect(s.density).toBe("max");
  });

  test("it carries NO OVERLAYS — the button CLEARS the map", () => {
    // THE POINT OF THE WHOLE CHANGE. The owner's own map (the wind
    // animation over the pressure lines) was "too slow on some
    // computers", and the wind animation is the reason: a canvas that
    // repaints every frame over a field that has to be fetched and
    // contoured first.
    //
    // The hash names no `overlay=` segment, and that is not an omission:
    // `applySavedStyle()` REMOVES every overlay the state does not
    // contain before it adds the ones it does, so a state with no
    // overlays list is a state that says "none".
    const s = MP.defaultMapState();
    expect(s.overlays).toBeUndefined();
    // ...and nothing about the wind or the isobars, which are the two
    // layers that made the old default map expensive.
    expect(s.wind).toBeUndefined();
    expect(s.isoStep).toBeUndefined();
    expect(s.isoColour).toBeUndefined();
    expect(s.isoSource).toBeUndefined();
    // The hash itself must not name an overlay either.
    expect(MP.DEFAULT_MAP.hash).not.toContain("overlay=");
    expect(MP.DEFAULT_MAP.hash).not.toContain("wind=");
    expect(MP.DEFAULT_MAP.hash).not.toContain("iso=");
  });

  test("it lands on the SATELLITE basemap", () => {
    // The hash names no base layer, so the button states it — otherwise
    // a reader on the street map would keep the street map.
    expect(MP.defaultMapState().base).toBe("satellite");
  });

  test("it is NOT one of the ✨ Cool presets", () => {
    // The cool maps are GLOBAL views (zoom ≤ 3, an owner rule) and they
    // are a different thing: a curated showcase. The default map must
    // not sneak into that list — the guard test for the cool maps would
    // (rightly) fail on it.
    for (const p of MP.presets()) {
      expect(p.hash).not.toBe(MP.DEFAULT_MAP.hash);
    }
  });

  test("defaultMap() hands out a COPY — a caller cannot edit the constant", () => {
    const a = MP.defaultMap();
    a.hash = "#0,0,3";
    expect(MP.DEFAULT_MAP.hash).not.toBe("#0,0,3");
    expect(MP.defaultMap().hash).toBe(MP.DEFAULT_MAP.hash);
  });
});
