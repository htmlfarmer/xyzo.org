/**
 * The isobar LINE COLOUR — six choices in a row next to the detail switch.
 *
 * Owner ask: *"can we have a way to select the color of the pressure
 * lines near the detail switch — for example red is easy to see… or
 * various random styles?"*
 *
 * The design, because it decides what the code has to do:
 *
 *   • Two FAMILIES. A single INK (red / white / black) answers "where
 *     are the isobars?" on a basemap that swallows them — the pressure
 *     is then read from the labels and the probe, not from the hue. A
 *     RAMP (by pressure / rainbow / turbo) keeps the pressure encoded
 *     in the colour. Six chips, one row, each with a DOT so the reader
 *     picks by looking rather than by name.
 *
 *   • The colour is part of the STYLE, so it travels: localStorage for
 *     the next visit, and `iso=<step>:<colour>` in the URL for a shared
 *     link — the same segment the detail step already used. A link is a
 *     VIEW, so a colour that arrives in a link never overwrites the
 *     reader's own stored scheme (`persist: false`).
 *
 *   • Changing it REPAINTS, it does not refetch. The geometry does not
 *     move; only the paint does. A colour control that refetches 1 hPa
 *     of global contours on every click is a control nobody clicks
 *     twice.
 *
 *   • The globe means the same thing by the same token, or "share the
 *     exact map" is exact in one view and different in the other.
 *
 * Verified in the browser (Playwright, 2026-11-04): six chips mount
 * under the detail row; clicking Red moves the polyline to #ef4444 and
 * the hash to `iso=4:red`; a second reader opening that URL comes up on
 * the same scheme with a byte-identical hash.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const layerJs = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const presetJs = readFileSync(join(ROOT, "map-presets.js"), "utf8");
const rampJs = readFileSync(join(ROOT, "ramp-styles.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const globeHtml = readFileSync(join(ROOT, "globe.html"), "utf8");

// The slice of source between two markers. Anchored on CODE, never on a
// comment: prose gets reworded, and an assertion anchored on prose ends
// up slicing from -1 and checking the last character of the file.
function between(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const j = rest.indexOf(endMarker);
  return j < 0 ? rest : rest.slice(0, j);
}

// The COLOUR_CHOICES block — everything the reader is offered.
const choicesBlock = between(layerJs, "const COLOUR_CHOICES = [", "function readStoredColour");

describe("the reader picks the line colour", () => {
  test("six choices, in the two families the ask needs", () => {
    const ids = [...choicesBlock.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["pressure", "red", "white", "black", "rainbow", "turbo"]);
    // The single-ink family: a solid colour for every line.
    for (const [id, hex] of [["red", "#ef4444"], ["white", "#f9fafb"], ["black", "#111827"]]) {
      expect(choicesBlock).toContain(`id: "${id}", label:`);
      expect(choicesBlock).toMatch(new RegExp(`id: "${id}",[^}]*ink: "${hex}"`));
    }
    // The ramp family carries no `ink` — it keeps the pressure in the hue.
    for (const id of ["pressure", "rainbow", "turbo"]) {
      const slice = choicesBlock.slice(choicesBlock.indexOf(`id: "${id}"`));
      expect(slice.slice(0, slice.indexOf("},"))).not.toContain("ink:");
    }
  });

  test("every chip says what it DOES, not what it is called", () => {
    // A tooltip that reads "Red" tells a reader nothing they cannot see
    // from the dot. Each choice explains the situation it is for.
    const hints = [...choicesBlock.matchAll(/hint: "([^"]+)"/g)].map((m) => m[1]);
    expect(hints.length).toBe(6);
    for (const h of hints) {
      expect(h.length).toBeGreaterThan(20);
      expect(h).not.toMatch(/^(red|white|black|rainbow|turbo|pressure)$/i);
    }
  });

  test("the choice is persisted, and defaults to the published key", () => {
    expect(layerJs).toContain('const COLOUR_STORE_KEY = "xyzo.isobarColor"');
    expect(layerJs).toContain('const DEFAULT_COLOUR = "pressure"');
    // A remembered value that is no longer offered must fall back to the
    // default rather than paint nothing: a schema that outlives a chip
    // list is how a stale localStorage entry blanks a layer.
    expect(layerJs).toMatch(
      /return COLOUR_CHOICES\.some\(\(c\) => c\.id === v\) \? v : DEFAULT_COLOUR;/);
    // Written only for a value the list actually offers.
    expect(between(layerJs, "function readStoredColour", "const state = {"))
      .toContain("COLOUR_CHOICES.some");
  });

  test("the list is declared ABOVE the state that reads it", () => {
    // `state`'s initialiser CALLS readStoredColour(), which reads this
    // list. A `const` below the object literal is in its temporal dead
    // zone and the WHOLE module fails to evaluate — no layer, no
    // control, no error a reader would report. (This shipped once: the
    // probe found `window.IsobarLayer` undefined with an empty console.)
    const listAt = layerJs.indexOf("const COLOUR_CHOICES = [");
    const stateAt = layerJs.indexOf("const state = {");
    expect(listAt).toBeGreaterThan(-1);
    expect(stateAt).toBeGreaterThan(-1);
    expect(listAt).toBeLessThan(stateAt);
    expect(layerJs).toContain("temporal dead zone");
    // One declaration only — a duplicate is a SyntaxError that kills the
    // file outright.
    expect(layerJs.match(/const COLOUR_CHOICES = \[/g)).toHaveLength(1);
    expect(layerJs.match(/const COLOUR_STORE_KEY = /g)).toHaveLength(1);
  });

  test("the ramps it names all EXIST in the shared palette", () => {
    // A chip that names a scheme RampStyles does not have silently falls
    // back to the published key — the reader picks "Turbo" and gets
    // "By pressure" with nothing saying so.
    const inkIds = [...choicesBlock.matchAll(/id: "([a-z]+)", label: "[^"]+", ink:/g)]
      .map((m) => m[1]);
    const rampIds = [...choicesBlock.matchAll(/id: "([a-z]+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== "pressure" && !inkIds.includes(id));
    expect(rampIds.sort()).toEqual(["rainbow", "turbo"]);
    for (const id of rampIds) {
      expect(rampJs).toMatch(new RegExp(`\\b${id}: \\[`));
    }
    // The shared module offers the hook both views call.
    expect(rampJs).toContain("function recolor(ramp, paletteName)");
    expect(rampJs).toContain("function swatch(paletteName)");
    expect(rampJs).toContain("window.RampStyles = {");
  });
});

describe("the row sits next to the detail switch", () => {
  test("the detail control mounts it — app.js only hands it the row", () => {
    // The two questions about the isobars — how dense, and what colour —
    // live together, and the layer owns both controls (magnetic and soil
    // keep theirs in their modules too).
    const mount = between(layerJs, "function mountStepControl(row)", "\n  function mountColourControl");
    expect(mount).toContain("mountColourControl(stepRow);");
    expect(mount).toContain('stepRow.id = "isobar-step-switch"');
    // app.js must not build a second one (second source of truth).
    expect(appJs).not.toContain("isobar-colour-switch");
    expect(appJs).not.toContain("mountColourControl");
  });

  test("same markup as the detail chips — no new CSS to collide with", () => {
    const body = between(layerJs, "function mountColourControl(anchor)", "\n  window.IsobarLayer = {");
    expect(body).toContain('row.className = "soil-prop-switch"');
    expect(body).toContain('row.id = "isobar-colour-switch"');
    expect(body).toContain('b.className = "soil-prop-btn"');
    expect(body).toContain("b.dataset.colour = choice.id");
    expect(body).toContain('row.setAttribute("aria-label", "Isobar colour")');
    // Idempotent: mounting twice must not stack a second row.
    expect(body).toContain('document.getElementById("isobar-colour-switch")');
  });

  test("each chip carries a DOT showing what it looks like", () => {
    // The reader picks by looking. A solid colour for an ink, the
    // scheme's own gradient for a ramp — a dot that promised a colour
    // the map does not draw would be worse than no dot.
    const swatch = between(layerJs, "function swatchFor(choice)", "function hexToRgb");
    expect(swatch).toContain("if (choice.ink) return choice.ink;");
    expect(swatch).toContain("linear-gradient(to right,");
    expect(swatch).toContain("R.swatch(choice.id)");
    const mount = between(layerJs, "function mountColourControl(anchor)", "\n  window.IsobarLayer = {");
    expect(mount).toContain('dot.className = "soil-legend-swatch"');
    expect(mount).toContain("dot.style.background = swatchFor(choice);");
    expect(mount).toContain('dot.setAttribute("aria-hidden", "true")');
  });
});

describe("changing it repaints, it does not refetch", () => {
  const setColour = between(layerJs, "function setColour(id, opts)", "function getColour");

  test("it persists, drops the cached stops and repaints", () => {
    expect(setColour).toContain("storageSet(COLOUR_STORE_KEY, want)");
    // The resolved stops are DERIVED from the choice. A cached array
    // would make every chip after the first a no-op — the classic
    // "the control does nothing" failure.
    expect(setColour).toContain("state.colourStops = undefined;");
    expect(setColour).toContain("repaintLines();");
    expect(setColour).toContain("paintColourRows();");
  });

  test("it does NOT refetch the contours", () => {
    // The geometry does not move. `refresh()` would re-request the whole
    // viewport's lines on every click.
    expect(setColour).not.toMatch(/\brefresh\(/);
    expect(setColour).not.toMatch(/\bfetch\(/);
    expect(setColour).not.toContain("state.loaded = null");
  });

  test("an unknown id is refused, and a no-op is cheap", () => {
    expect(setColour).toContain("if (!COLOUR_CHOICES.some((c) => c.id === want)) return false;");
    expect(setColour).toContain("if (want === state.colour) return true;");
  });

  test("the repaint reads each line's OWN pressure", () => {
    // The level rides on the polyline, so a colour change can re-paint
    // without refetching: repaintLines() asks every line what it is and
    // re-reads it from the new scheme.
    expect(layerJs).toMatch(/level: level,/);
    const repaint = between(layerJs, "function repaintLines()", "function paintColourRows");
    expect(repaint).toContain("state.group.eachLayer");
    expect(repaint).toContain("layer.options && layer.options.level");
    // The weight comes along with the colour: it depends on how many
    // lines are on screen (weightFor), which does not change when the
    // palette does — but a repaint that dropped it would leave the
    // strokes at whatever the previous density set.
    expect(repaint).toContain("layer.setStyle({ color: isobarColor(level), weight: weight });");
    // `weightFor` lives with render(), not inside this slice — assert
    // it against the module instead.
    expect(layerJs).toMatch(/function weightFor\(count\)/);
  });

  test("the active chip follows a colour that arrived with NO click", () => {
    // A link or a preset sets the colour without a click, so the painter
    // has to be reachable from setColour() itself — a painter living
    // only in the click handler leaves the row saying "By pressure"
    // while the map draws red.
    expect(setColour).toContain("paintColourRows();");
    const paint = between(layerJs, "function paintColourRows()", "function paintStep");
    expect(paint).toContain('b.dataset.colour === state.colour');
    expect(paint).toContain('b.setAttribute("aria-pressed"');
  });

  test("the ink path paints ONE colour for every pressure", () => {
    const colour = between(layerJs, "function isobarColor(hpa)", "\n  // ── lifecycle");
    expect(colour).toContain("if (stops === null)");
    expect(colour).toContain("return (choice && choice.ink) || COLOR_STOPS[0].color;");
  });
});

describe("it is part of the URL", () => {
  test("the writer emits the colour whenever the isobars are on", () => {
    // ALWAYS, not only when it differs from the default — the same
    // reason the step is. Omitting it would leave the RECEIVER's stored
    // scheme to decide, so a sender on "By pressure" would hand a
    // receiver on "red" a link that opened in red: the same map,
    // different lines.
    const emit = between(appJs, "const iso = (isoStep != null && isobarsOn)", ";");
    expect(emit).toContain("`/iso=${isoStep}`");
    expect(emit).toContain("`:${isoColour}`");
    expect(emit).not.toMatch(/pressure|DEFAULT|!== /);
    // And it reaches the address bar.
    expect(appJs).toContain("${overlays}${iso}${isoSrc}${delta}${wind}");
    expect(appJs).toContain("const isoColour = (window.IsobarLayer && typeof window.IsobarLayer.getColour === \"function\")");
  });

  test("the parser reads the suffix back", () => {
    const parse = between(appJs, "const isoMatch = p.match(", "}"); 
    expect(parse).toContain("res.isoStep = n");
    expect(parse).toContain("res.isoColour = isoMatch[2]");
    // The suffix must not break the step: a bare Number("4:red") is NaN
    // and the whole segment would be silently dropped.
    expect(appJs).toMatch(/const isoMatch = p\.match\(\/\^iso=/);
    expect(appJs).toContain("(?::([a-z]+))?");
  });

  test("a link's colour is applied BEFORE the layer is enabled", () => {
    // The slice runs PAST setEnabled(true) (ending on the line after it)
    // so the ordering can be asserted inside the slice rather than
    // against the end marker, which `between()` excludes.
    const apply = between(appJs,
      "if (resolveLayerName(entry.name) !== ISOBAR_LAYER_NAME) continue;",
      "_activeOverlayNames.add(ISOBAR_LAYER_NAME);");
    expect(apply).toContain("setStep(parsed.isoStep, { persist: false });");
    expect(apply).toContain("setColour(parsed.isoColour, { persist: false });");
    expect(apply).toContain("window.IsobarLayer.setEnabled(true);");
    expect(apply.indexOf("setColour(parsed.isoColour")).toBeLessThan(
      apply.indexOf("window.IsobarLayer.setEnabled(true)"));
  });

  test("a link's colour does NOT overwrite the reader's own scheme", () => {
    // A LINK IS A VIEW, NOT A SETTINGS CHANGE — the rule every other
    // layer preference follows at boot.
    expect(appJs).toContain("setColour(parsed.isoColour, { persist: false });");
    const setColour = between(layerJs, "function setColour(id, opts)", "function getColour");
    expect(setColour).toContain("if (!(opts && opts.persist === false))");
    expect(setColour).toContain("storageSet(COLOUR_STORE_KEY, want);");
  });

  test("the layer tells the app when the colour changed", () => {
    // One event between the layer (which owns the control) and the app
    // (which owns the URL) — the same pattern the step and the opacity
    // slider use.
    expect(layerJs).toContain('new window.CustomEvent("xyzo:isobar-colour"');
    expect(layerJs).toContain("detail: { colour: want }");
    expect(appJs).toContain('window.addEventListener("xyzo:isobar-colour"');
  });

  test("a saved style carries it too", () => {
    // "MY STYLE → Save this view" is a snapshot of the EXACT map.
    expect(appJs).toContain("isoColour: (window.IsobarLayer && typeof window.IsobarLayer.getColour === \"function\")");
    expect(appJs).toContain("isoColour: style.isoColour || undefined");
    expect(appJs).toContain("isoColour: s.isoColour,");
    expect(appJs).toContain("isoColour: state.isoColour || undefined");
  });

  test("a preset parses it and sanitises it", () => {
    // The grammar a preset speaks is deliberately the one a shared URL
    // speaks, so a preset, a pasted link and a saved style can never
    // diverge. Plain substrings: a regex asserting a regex over a
    // template literal is unreadable and easy to get subtly wrong.
    expect(presetJs).toContain("const iso = p.match(");
    expect(presetJs).toContain("if (iso[2]) state.isoColour = iso[2];");
    expect(presetJs).toContain("if (Number.isFinite(n) && n > 0) state.isoStep = n;");
    // ...and the sanitiser keeps it, or a preset naming a colour would
    // parse and then be thrown away.
    expect(presetJs).toContain("if (typeof state.isoColour === \"string\" && state.isoColour) {");
    expect(presetJs).toContain("out.isoColour = state.isoColour;");
    // No preset NAMES a colour today (the showcase draws the published
    // key) — what matters is that one could: the parse and the
    // sanitiser above both carry it.
  });
});

describe("the globe means the same thing", () => {
  test("its three inks are the flat map's three inks", () => {
    // The inks are COLOURS, not schemes, so globe.js lists them as
    // three hex values — and a value that drifts from isobar-layer.js
    // means a shared link is red in one view and something else in the
    // other.
    const inks = {};
    for (const m of globeJs.matchAll(/ISO_INKS = \{([^}]*)\}/g)) {
      for (const p of m[1].matchAll(/([a-z]+): "(#[0-9a-f]{6})"/g)) inks[p[1]] = p[2];
    }
    expect(Object.keys(inks).sort()).toEqual(["black", "red", "white"]);
    for (const [id, hex] of Object.entries(inks)) {
      expect(choicesBlock).toContain(`id: "${id}", label:`);
      expect(choicesBlock).toMatch(new RegExp(`id: "${id}",[^}]*ink: "${hex}"`));
    }
  });

  test("it resolves the scheme through the SHARED palette", () => {
    // One `recolor`, two views — a second implementation of the mapping
    // is the one that drifts.
    const resolve = between(globeJs, "function resolveIsoStops(colour)", "function isobarInk");
    expect(resolve).toContain("R.recolor(");
    expect(resolve).toContain("ISOBAR_STOPS.map((s) => ({");
    const build = between(globeJs, "resolveIsoStops(globeIsoColour());", "const res = await fetch");
    expect(build).toContain("resolveIsoStops(globeIsoColour());");
    expect(build).toContain("const ink = isobarInk();");
    // ...and the features actually use it.
    expect(globeJs).toContain("color: ink || isobarColor(item.level_hpa),");
  });

  test("it writes the colour as well as the step", () => {
    // ALWAYS — a segment that changes shape between the two views is a
    // segment that loses something on the way home.
    expect(globeJs).toContain('h += `/iso=${isoStepInUse}:${isoColourInUse || "pressure"}`;');
    // And it reads a colour-suffixed segment without dropping it.
    const parse = between(globeJs, '} else if (p.startsWith("iso="))', "return res;");
    expect(parse).toContain("res.isoStep = n");
    expect(parse).toContain("res.isoColour = m[2]");
    // The reader is read with a REGEX: Number("1:red") is NaN.
    expect(parse).toContain('p.slice(4).match(');
  });

  test("globe.html loads the shared palette", () => {
    // Without ramp-styles.js the globe's `recolor` is missing and every
    // scheme silently falls back to the published key.
    expect(globeHtml).toContain("/ramp-styles.js?v=");
    // ...and the stamp loop knows about it, or the token goes stale.
    const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
    expect(bump).toMatch(/for asset in globe\.js .*ramp-styles\.js/);
  });

  test("the flat map loads it too, before the layer that uses it", () => {
    expect(indexHtml).toMatch(/ramp-styles\.js\?v=\d+/);
    const rampAt = indexHtml.indexOf("ramp-styles.js");
    const layerAt = indexHtml.indexOf("isobar-layer.js");
    expect(rampAt).toBeGreaterThan(-1);
    expect(layerAt).toBeGreaterThan(-1);
    expect(rampAt).toBeLessThan(layerAt);
  });
});
