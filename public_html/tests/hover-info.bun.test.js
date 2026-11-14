/**
 * Hover HUD (hover-info.js) — one cursor-following card, three modes.
 *
 * Study: docs/TOOLTIP_STUDY_2026-10-28.md
 *
 * The invariants that matter:
 *  - the module is loaded BEFORE app.js and is stamped by bump_frontend.sh
 *  - the canvas renderer feeds it via the xyzo:pin-hover CustomEvent
 *  - "all" mode suppresses the layers' own hover boxes so nothing stacks
 *  - every aggregating layer exposes sampleAt(latlng)
 *  - the mode is user-selectable in the control menu and persisted
 *  - the HUD never steals clicks (pointer-events: none)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const hoverJs = readFileSync(join(root, "hover-info.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const stylesCss = readFileSync(join(root, "styles.css"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("hover-info module", () => {
  test("exposes HoverInfo with the three-mode API", () => {
    expect(hoverJs).toMatch(/window\.HoverInfo\s*=/);
    for (const fn of ["init", "getMode", "setMode", "suppressesProbes"]) {
      expect(hoverJs).toMatch(new RegExp(`\\b${fn}\\s*[:(]`));
    }
  });

  test("modes are off / pins / all, default pins, persisted", () => {
    expect(hoverJs).toMatch(/\["off", "pins", "all"\]/);
    expect(hoverJs).toMatch(/xyzo\.hoverMode/);
    // A fresh visitor gets the pin preview, not nothing and not chaos.
    expect(hoverJs).toMatch(/storageGet\(STORE_KEY,\s*"pins"\)/);
  });

  test("suppressesProbes is true only in all mode", () => {
    expect(hoverJs).toMatch(/function suppressesProbes\(\)\s*\{\s*return state\.mode === "all"/);
  });

  test("the HUD never steals clicks", () => {
    expect(stylesCss).toMatch(/\.hover-hud\s*\{[^}]*pointer-events:\s*none/s);
  });

  test("the card flips away from screen edges", () => {
    expect(hoverJs).toMatch(/EDGE_PAD/);
    expect(hoverJs).toMatch(/CURSOR_OFFSET/);
    expect(hoverJs).toMatch(/innerWidth/);
    expect(hoverJs).toMatch(/innerHeight/);
  });

  test("hides while the map is being dragged", () => {
    expect(hoverJs).toMatch(/map\.on\("movestart",\s*hide\)/);
    expect(hoverJs).toMatch(/mouseleave/);
  });
});

describe("canvas renderer feeds the HUD", () => {
  test("mousemove dispatches xyzo:pin-hover with the hit pin", () => {
    expect(appJs).toMatch(/xyzo:pin-hover/);
    // The event carries the already-computed hit pin — no second hit-test.
    expect(appJs).toMatch(/detail:\s*\{\s*pin:\s*hitPin\s*\}/);
  });

  test("mouseleave clears the hovered pin", () => {
    expect(appJs).toMatch(/_handleMouseLeave/);
    expect(appJs).toMatch(/detail:\s*\{\s*pin:\s*null\s*\}/);
  });

  test("the leave listener has a stable reference for removeEventListener", () => {
    // An anonymous arrow would leak on disable() — the bound method
    // is stored on the instance and removed in disable().
    expect(appJs).toMatch(/this\._onMouseLeave\s*=\s*this\._handleMouseLeave\.bind\(this\)/);
    expect(appJs).toMatch(/removeEventListener\("mouseleave",\s*this\._onMouseLeave\)/);
  });
});

describe("all mode aggregates layer readings", () => {
  // Every module that feeds the HUD's readings block. Each must expose
  // sampleAt(latlng) and (where the module has an on/off state the HUD
  // can consult) isEnabled.
  const LAYERS = [
    "isobar-layer.js",
    "climate-layer.js",
    "temp-layer.js",
    "wind-layer.js",
    "wave-layer.js",
    "soil-layer.js",
    "cropland-layer.js",
    "mag-layer.js",
    "lightning-layer.js",
    "phytoplankton-layer.js",
    "etopo-layer.js",
    "river-layer.js",
    "languages-layer.js",
  ];

  test("every aggregating layer exposes sampleAt(latlng)", () => {
    for (const f of LAYERS) {
      const js = readFileSync(join(root, f), "utf8");
      expect(js, `${f} must expose sampleAt`).toMatch(/sampleAt\s*[:(]/);
    }
  });

  test("every aggregating layer checks suppressesProbes on mousemove", () => {
    // Without the check, "all" mode stacks the layer's own box on the
    // HUD — the exact problem the HUD exists to solve. Layers without
    // their own hover box (isobars, rivers) have nothing to suppress.
    const WITH_PROBES = LAYERS.filter((f) =>
      ["climate-layer.js", "temp-layer.js", "wind-layer.js", "soil-layer.js",
       "mag-layer.js", "cropland-layer.js", "etopo-layer.js", "wave-layer.js",
       "lightning-layer.js", "phytoplankton-layer.js"].includes(f));
    for (const f of WITH_PROBES) {
      const js = readFileSync(join(root, f), "utf8");
      expect(js, `${f} must check HoverInfo.suppressesProbes`).toMatch(/suppressesProbes/);
    }
  });

  test("the HUD only samples enabled layers", () => {
    expect(hoverJs).toMatch(/isEnabled/);
    // And one bad sampler must not kill the card.
    expect(hoverJs).toMatch(/one bad sampler must not kill the card/);
  });

  test("expensive layers (geology, basins) are NOT sampled", () => {
    // Geology is a network fetch; basins are a 650k-vertex ray-cast.
    // Both keep their click-Probe flow — they must not be in SAMPLERS.
    expect(hoverJs).not.toMatch(/GeologyLayer/);
    expect(hoverJs).not.toMatch(/BasinLayer/);
  });

  test("the isobars — the field everything rides on — are sampled", () => {
    // The user's #1 ask: pressure under the cursor in the HUD card.
    expect(hoverJs).toMatch(/\["⛅",\s*"IsobarLayer"\]/);
    const isobars = readFileSync(join(root, "isobar-layer.js"), "utf8");
    expect(isobars).toMatch(/function sampleAt\(latlng\)/);
    expect(isobars).toMatch(/hPa/);
  });

  test("the HWSD soil-TYPE layer is sampled — its own box stands down", () => {
    // The owner ask: *"the popup for soil isn't helpful, put that with
    // all the other details — maybe have the mouse pointer show what the
    // soil type is"*.
    //
    // The HWSD layer's own hover box STANDS DOWN in "Everything" mode
    // (every probe does, so the card never has two things saying the
    // same thing). With no HUD row to replace it, the soil type simply
    // VANISHED: measured on the live map, the box read "Technosols"
    // and the card — coordinates, pin, nothing else — had no soil in
    // it at all.
    expect(hoverJs).toMatch(/\["🟫",\s*"HWSDLayer"\]/);
    const hwsd = readFileSync(join(root, "hwsd-layer.js"), "utf8");
    expect(hwsd).toMatch(/sampleAt: function \(latlng\)/);
    // And it must stand down where the card takes over.
    expect(hwsd).toMatch(/suppressesProbes/);
  });

  test("a probe that stands down GOES AWAY — it does not freeze on screen", () => {
    // A box that merely STOPS updating keeps the last text it was
    // given, so it goes on saying the same thing the card now says.
    // The HUD announces the mode change, and the layer hides its box.
    expect(hoverJs).toMatch(/xyzo:hover-mode/);
    const hwsd = readFileSync(join(root, "hwsd-layer.js"), "utf8");
    expect(hwsd).toMatch(/xyzo:hover-mode/);
    // The box must be hidden, not just skipped.
    const at = hwsd.indexOf("suppressesProbes");
    expect(at).toBeGreaterThan(-1);
    const body = hwsd.slice(at, at + 400);
    expect(body).toMatch(/hideProbe\(\)/);
  });

  test("every SAMPLERS entry names a real window export", () => {
    // A typo'd layer name would silently never render.
    const names = [...hoverJs.matchAll(/\["[^"]+",\s*"(\w+Layer)"\]/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const n of names) {
      // The module name is not always the file name:
      // LanguagesRegionsLayer → languages-regions-layer.js.
      const file = n
        .replace(/Layer$/, "-layer.js")
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase();
      // CroplandLayer → cropland-layer.js; IsobarLayer → isobar-layer.js
      const js = readFileSync(join(root, file), "utf8");
      expect(js, `${file} must export window.${n}`).toMatch(new RegExp(`window\\.${n}\\s*=`));
    }
  });
});

describe("per-layer HUD toggles", () => {
  test("disabled layers persist in xyzo.hoverHudOff", () => {
    expect(hoverJs).toMatch(/xyzo\.hoverHudOff/);
    expect(hoverJs).toMatch(/function isSamplerEnabled/);
    expect(hoverJs).toMatch(/function setSamplerEnabled/);
  });

  test("readingsBlock skips a disabled sampler", () => {
    expect(hoverJs).toMatch(/if \(!isSamplerEnabled\(name\)\) continue;/);
  });

  test("the checkbox list lives under the Hover picker", () => {
    expect(indexHtml).toMatch(/id="hover-sampler-list"/);
    expect(hoverJs).toMatch(/getElementById\("hover-sampler-list"\)/);
    // The list is only meaningful in "all" mode.
    expect(hoverJs).toMatch(/host\.hidden = state\.mode !== "all"/);
  });

  test("the list wires its checkboxes once (delegated)", () => {
    expect(hoverJs).toMatch(/host\._xyzoWired/);
    expect(hoverJs).toMatch(/addEventListener\("change"/);
  });

  test("a disabled layer's checkbox round-trips through storage", () => {
    // setSamplerEnabled writes the JSON array; getOffSet reads it back.
    expect(hoverJs).toMatch(/storageSet\(OFF_KEY,\s*JSON\.stringify/);
    expect(hoverJs).toMatch(/JSON\.parse\(storageGet\(OFF_KEY/);
  });

  test("the sampler list has styles", () => {
    expect(stylesCss).toMatch(/\.hover-sampler-list\b/);
    expect(stylesCss).toMatch(/\.hover-sampler-row\b/);
    // The HUD itself must stay click-transparent even though the
    // control-menu list has real checkboxes.
    expect(stylesCss).toMatch(/\.hover-hud\s*\{[^}]*pointer-events:\s*none/s);
  });
});

describe("boot wiring", () => {
  test("hover-info.js loads before app.js and is stamped", () => {
    const at = indexHtml.indexOf("hover-info.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(bump).toMatch(/hover-info\.js/);
  });

  test("app.js inits HoverInfo with the map", () => {
    expect(appJs).toMatch(/HoverInfo\.init\(map\)/);
  });

  test("the control menu offers Off / Pins / All", () => {
    expect(indexHtml).toMatch(/id="hover-mode-picker"/);
    for (const m of ["off", "pins", "all"]) {
      expect(indexHtml).toMatch(new RegExp(`data-hover="${m}"`));
    }
  });

  test("the picker buttons call HoverInfo.setMode", () => {
    expect(appJs).toMatch(/HoverInfo\.setMode\(/);
  });

  test("the HUD has styles", () => {
    expect(stylesCss).toMatch(/\.hover-hud\b/);
    expect(stylesCss).toMatch(/\.hover-hud-title/);
    expect(stylesCss).toMatch(/\.hover-hud-coords/);
    expect(stylesCss).toMatch(/\.hover-hud-readings/);
  });
});
