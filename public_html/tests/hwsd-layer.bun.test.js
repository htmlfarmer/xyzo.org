// hwsd-layer.bun.test.js — FAO/IIASA Harmonized World Soil Database v2.2
// (34 WRB soil groups, ~1 km, hotlinked WMTS).
//
// Why each of these is pinned rather than assumed: this is the second
// overlay hotlinked from data.apps.fao.org, and its catalogue URL is
// wrong in THREE ways (population-layer's is wrong in two) — all three
// were found by asking the service, and all three come back as HTTP 400
// with a body that names the missing piece. The obvious reaction is to
// trust the catalogue and conclude the service is dead. It is not.
//
//   tilematrixset=EPSG:900913 -> HTTP 400 (the catalogue's value).
//                                WebMercatorQuad is correct.
//   (no style parameter)       -> HTTP 400
//                                `Missing 'GetTile' parameters: {'style'}`
//   TileCol={y}&TileRow={x}    -> SWAPPED in the catalogue. The tiles are
//                                ordinary XYZ: TileCol={x}&TileRow={y}.
//
// Verified live 2026-11-05: HTTP 200 across z3-z6 (256x256 RGBA PNGs,
// 32 colours — a classification, not a photograph), CORS
// `access-control-allow-origin: https://xyzo.org`, and in a browser 35
// tiles on the pane at z=370 with pointer-events:none, the legend
// rendering all 34 rows un-hidden, and the probe reading "Cambisols"
// at 48N,10E — a real WRB class for the Alpine foreland. Zero console
// errors, zero 4xx.
//
// Like population-layer.js this module is wired through
// generic-layers.js's registry loop, so it is deliberately NOT in
// overlay-contracts.bun.test.js's OVERLAYS table (that table demands
// literal `window.X.init(map)` wiring, which a registry layer can never
// satisfy) — its contracts live here instead.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const src = readFileSync(join(ROOT, "hwsd-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
const registry = readFileSync(join(ROOT, "generic-layers.js"), "utf8");
const overlayTest = readFileSync(join(ROOT, "tests", "overlay-contracts.bun.test.js"), "utf8");

// Negative assertions must run against CODE, not prose: this file
// documents the broken catalogue values in its header, so matching the
// raw source would fire on the documentation.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const code = stripComments(src);
// The WMTS query now lives SERVER-SIDE: tileMirror.ts builds it from a
// whitelist and hands Leaflet a plain XYZ template. These facts still
// have to hold — in the file that owns them, or a test pointed at the
// wrong file passes forever while the real URL drifts back to the
// catalogue's broken one.
const mirrorTs = readFileSync(
  join(ROOT, "..", "api", "src", "routes", "tileMirror.ts"),
  "utf8",
);

describe("the WMTS request is the WORKING one, not the catalogue's", () => {
  test("the layer asks our mirror, and the mirror builds the real URL", () => {
    expect(code).toMatch(/\/api\/tile\/mirror\/hwsd\/\{z\}\/\{x\}\/\{y\}/);
    expect(code).not.toMatch(/data\.apps\.fao\.org/);
    expect(mirrorTs).toMatch(/fao-gismgr\/GAEZ-V5\/maps\/HWSDV22/);
  });

  test("uses WebMercatorQuad — the catalogue's EPSG:900913 returns 400", () => {
    expect(mirrorTs).toMatch(/tilematrixset=WebMercatorQuad/);
    // the header note in this file mentions EPSG:900913 only as the
    // catalogue's BROKEN value — match the code, not the note
    expect(mirrorTs).not.toMatch(/EPSG:900913/);
  });

  test("carries style=default — omitting it is the other 400", () => {
    expect(mirrorTs).toMatch(/style=default/);
    // and the fact is recorded in this file so nobody "simplifies" it away
    expect(src).toMatch(/Missing 'GetTile' parameters/);
  });

  test("is a genuine XYZ template — TileCol={x}, TileRow={y}", () => {
    // The catalogue writes them SWAPPED (TileCol={y}&TileRow={x}),
    // which renders transposed tiles: a plausible-looking map of the
    // wrong places, so no error catches it. The mirror substitutes
    // z/x/y itself, so the template is a literal now.
    expect(mirrorTs).toMatch(/TileMatrix=\$\{z\}&TileCol=\$\{x\}&TileRow=\$\{y\}/);
    expect(src).toMatch(/SWAPPED/); // the trap stays documented
  });

  test("is an XYZ grid, so tiles must NOT be marked 512", () => {
    // The Macrostrat trap: tileSize:512 on a standard XYZ grid doubles
    // the spacing and shifts the whole overlay.
    expect(src).not.toMatch(/tileSize:\s*512/);
  });

  test("the layer id is the full FAO path", () => {
    expect(mirrorTs).toMatch(/layer=fao-gismgr\/GAEZ-V5\/maps\/HWSDV22/);
  });
});

describe("the layer exists where a wash should be", () => {
  test("own pane at 370, click-transparent", () => {
    expect(src).toMatch(/const PANE = "hwsdPane"/);
    // Unquoted on purpose: overlay-contracts's Z_RE reads
    // `PANE_Z = <digits>` and a quoted "370" does not match it.
    expect(src).toMatch(/const PANE_Z = 370/);
    expect(src).toMatch(/pane\.style\.zIndex = String\(PANE_Z\)/);
    expect(src).toMatch(/pane\.style\.pointerEvents = "none"/);
  });

  test("370 is the slot the wind animation vacated (370 -> 379)", () => {
    // The stack was full 345-370; the wind moved up so a ground-level
    // layer could take 370 instead of drawing over the wind streaks at
    // 371+. If wind goes back to 370 the two collide and this fails.
    const wind = readFileSync(join(ROOT, "wind-layer.js"), "utf8");
    expect(wind).toMatch(/zIndex = "379"/);
    // hwsd is off the OVERLAYS table (registry route), so the binding
    // is: wind says 379 here, hwsd says 370 above, and the SOURCE
    // scan in overlay-contracts proves no third file claims either.
    expect(overlayTest).toMatch(/readdirSync\(ROOT\)/);
  });

  test("a classification must NOT be interpolated", () => {
    // Bilinear blending between two soil units paints a colour that is
    // neither unit — the boundary becomes a lie.
    expect(src).toMatch(/className: "xyzo-hwsd-tiles"/);
    const css = readFileSync(join(ROOT, "styles.css"), "utf8");
    expect(css).toMatch(/\.xyzo-hwsd-tiles\s*\{\s*\n?\s*image-rendering: pixelated/);
  });

  test("exposes the layers-control surface app.js's loop expects", () => {
    expect(src).toMatch(/window\.HWSDLayer = \{/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "isEnabled",
                      "setOpacity", "getOpacity", "blocksClick", "sampleAt"]) {
      expect(src, `missing ${fn}`).toMatch(new RegExp(`\\b${fn}\\s*[:,]`));
    }
    expect(src).toMatch(/const LAYER_NAME = "🟫 Soil type \(HWSD v2\.2\)"/);
    // A hover reading, never a click owner.
    expect(src).toMatch(/blocksClick: function \(\) \{\s*return false/);
  });
});

describe("registration", () => {
  test("generic-layers.js lists it, and it loads BEFORE app.js", () => {
    expect(registry).toMatch(/"HWSDLayer"/);
    const at = indexHtml.indexOf("hwsd-layer.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
  });

  test("app.js reads the registry instead of naming the module inline", () => {
    // Registration AND init through the one loop — one without the
    // other is a layer that appears in the dropdown but never gets a
    // map. (The literal `window.HWSDLayer.init(map)` the overlay boot
    // contract wants can never appear for a registry layer, which is
    // why this module is not in that test's OVERLAYS table.)
    expect(appJs).toMatch(/for \(const name of window\.XYZO_GENERIC_LAYERS\)/);
    expect((appJs.match(/window\.XYZO_GENERIC_LAYERS/g) || []).length).toBe(2);
    expect(appJs).not.toMatch(/window\.HWSDLayer\.init\(map\)/);
    expect(appJs).not.toMatch(/HWSDLayer && typeof window\.HWSDLayer\.getTileLayer/);
    // and it must not be wired TWICE (registry + inline), which would
    // double-register the same layer object in WEATHER_OVERLAYS.
    expect((appJs.match(/HWSDLayer/g) || []).length).toBe(0);
  });

  test("it is deliberately absent from the OVERLAYS table, with the reason", () => {
    // The table drives tests that demand literal app.js wiring; a
    // registry layer cannot satisfy them, and silent absence would be
    // indistinguishable from a forgotten layer — so the absence carries
    // a comment naming this file.
    expect(overlayTest).not.toMatch(/\{ file: "hwsd-layer\.js"/);
    expect(overlayTest).toMatch(/hwsd-layer\.bun\.test\.js/);
    // ...but the SOURCE-SCANNING pane test still finds it on its own.
    expect(overlayTest).toMatch(/readdirSync\(ROOT\)/);
  });

  test("stamped by bump_frontend.sh, exactly one script tag", () => {
    expect(bump).toMatch(/hwsd-layer\.js/);
    expect(indexHtml.match(/<script src="hwsd-layer\.js/g).length).toBe(1);
    expect(indexHtml.match(/<script src="generic-layers\.js/g).length).toBe(1);
  });
});

describe("the state follows the layer, not the other way round", () => {
  // The bug this file was written around: init() set state.enabled from
  // localStorage but registered no overlayadd/overlayremove listeners,
  // so a URL hash that added the layer left state.enabled false — the
  // legend stayed hidden and the probe returned null over a map that
  // WAS showing the tiles. Exactly what the first live probe showed:
  // 35 tiles, legend hidden: true, probe: None.
  test("overlayadd/overlayremove listeners are registered in init()", () => {
    expect(src).toMatch(/map\.on\("overlayadd"/);
    expect(src).toMatch(/map\.on\("overlayremove"/);
    // Both must toggle the legend and the probe follows the layer.
    expect(src).toMatch(/setLegendVisible\(true\)/);
    expect(src).toMatch(/setLegendVisible\(false\)/);
    expect(src).toMatch(/hideProbe\(\)/);
  });

  test("LISTENERS are wired BEFORE the stored-preference restore", () => {
    // The population-layer rule: the layers control does not exist at
    // init time, so a hash that adds the layer fires overlayadd with
    // nobody listening — state.enabled stays false while the checkbox
    // looks checked.
    const listeners = src.indexOf('map.on("overlayadd"');
    const restore = src.indexOf('storageGet(STORE_KEY, "0") === "1"');
    expect(listeners).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(-1);
    expect(listeners, "listeners must precede the restore").toBeLessThan(restore);
    // and the restore flips state directly (no overlayadd to catch yet)
    expect(src).toMatch(/state\.enabled = !!\(state\.layer && map\.hasLayer\(state\.layer\)\)/);
  });

  test("mountLegend() reports FAILURE when the list does not exist yet", () => {
    // Returning true there told waitForLayersControl the key was
    // mounted and stopped the retry — the legend never appeared.
    // app.js's layer-init loop runs BEFORE L.control.layers() creates
    // .leaflet-control-layers-list, so the first attempt always fails.
    expect(src).toMatch(/function mountLegend\(\)/);
    expect(src).toMatch(/if \(!list\) return false;/);
    // ...and the retry loop exists and is bounded.
    expect(src).toMatch(/function waitForLayersControl\(\)/);
    expect(src).toMatch(/\+\+tries > 40/);
  });

  test("the legend is a CHILD of the section, never a sibling of it", () => {
    // THREE ELEMENTS, ONLY ONE SAFE TO ADD TO. Leaflet empties
    // `.leaflet-control-layers-base` and `.leaflet-control-layers-overlays`
    // on every layer change, so a row inside either is wiped — but the
    // <section class="leaflet-control-layers-list"> WRAPS them and
    // persists, and it is also the element Leaflet hides when the
    // dropdown collapses.
    //
    // THE BUG (owner: *"its kinda showing up on the side when it
    // shouldnt"*): `list.insertAdjacentElement("afterend", box)` put the
    // key AFTER the section — i.e. straight into `.leaflet-control-layers`.
    // MEASURED on the live map with the panel CLOSED (the state every
    // first visit starts in): section 0 × 0 (`display:none`), yet the
    // legend was **221 × 329 at (1207, 64)**, hanging under the stack
    // button — while `#soil-legend`, mounted correctly, was 0 × 0. With
    // the panel open it sat outside the scroll box: list bottom 843,
    // legend 843 → 1172, against a `scrollHeight` of 5118 that carried
    // on inside the section.
    //
    // Assert on `code` (comments stripped): this file's header and the
    // fix note both quote the broken call, exactly like the catalogue
    // values above.
    expect(code).toMatch(/list\.appendChild\(box\)/);
    expect(code).not.toMatch(/insertAdjacentElement\("afterend", box\)/);
    // still the SECTION (not the overlays list Leaflet wipes)
    expect(code).toMatch(/querySelector\("\.leaflet-control-layers-list"\)/);
    expect(code).toMatch(/getElementById\("hwsd-legend"\)/);
    // and it still reports failure when the control does not exist yet,
    // so the retry loop keeps its meaning.
    expect(code).toMatch(/if \(!list\) return false;/);
  });
});

describe("the probe reads the tile's own pixel, honestly", () => {
  test("crossOrigin is on — without it the canvas is tainted", () => {
    // getImageData throws on a tainted canvas; FAO answers
    // Access-Control-Allow-Origin for our origin (verified live).
    expect(src).toMatch(/crossOrigin:\s*true/);
    expect(src).toMatch(/Access-Control-Allow-Origin/);
  });

  test("decoded tiles are CACHED, not re-decoded per mousemove", () => {
    // drawImage + getImageData on every frame would cost a tile decode
    // per mousemove; the cache is keyed by URL and hard-capped.
    expect(src).toMatch(/const _decoded = new Map\(\)/);
    expect(src).toMatch(/_decoded\.size > 400/);
  });

  test("an unmatched colour is reported, never guessed", () => {
    // A wrong soil unit is worse than no reading: the threshold turns
    // a tile-boundary blend or a re-coloured legend into "unknown
    // colour" instead of a confident lie.
    expect(src).toMatch(/bestD > 900/);
    expect(src).toMatch(/unknown colour/);
    expect(src).toMatch(/no data/);
  });

  test("the probe hides when the layer is off or nothing is under it", () => {
    expect(src).toMatch(/if \(!state\.enabled\) return;/);
    expect(src).toMatch(/if \(!hit\) \{ el\.hidden = true; return; \}/);
    // positioned from container points, never a pane (a pane child
    // rides Leaflet's translate and ends up paneOffset from cursor)
    expect(src).toMatch(/containerPoint\.x \+ 14/);
  });

  test("sampleAt feeds the HUD but only when enabled", () => {
    expect(src).toMatch(/sampleAt: function \(latlng\)/);
    expect(src).toMatch(/if \(!state\.enabled\) return null;/);
    // "reading…" and "no data" are not readings
    expect(src).toMatch(/hit\.name === "reading…"/);
  });
});

describe("the 34-class key", () => {
  test("every FAO legend class is present, in the legend's own order", () => {
    // Extracted from the service's own GetLegendGraphic (221x1154 PNG,
    // one swatch per text row) on 2026-11-05. If FAO re-colours the
    // legend this table goes stale — which is why the probe reports
    // "unknown colour" rather than guessing when nothing matches.
    const CLASSES = [
      "Acrisols", "Alisols", "Andosols", "Arenosols", "Anthrosols",
      "Chernozems", "Calcisols", "Cambisols", "Cryosols", "Durisol",
      "Fluvisols", "Ferralsols", "Gleysols", "Gypsisols", "Histosols",
      "Kastanozems", "Leptosols", "Luvisols", "Lixisols", "Nitisols",
      "Phaeozems", "Planosols", "Plinthosols", "Podzols", "Regosols",
      "Retisols", "Solonchaks", "Solonetz", "Stagnosols", "Technosols",
      "Umbrisols", "Vertisols", "Open inland water", "Glaciers",
    ];
    const table = src.slice(src.indexOf("const CLASSES = ["),
                            src.indexOf("];", src.indexOf("const CLASSES = [")));
    let last = -1;
    for (const name of CLASSES) {
      const at = table.indexOf(`"${name}"`);
      expect(at, `missing class ${name}`).toBeGreaterThan(-1);
      expect(at, `${name} out of legend order`).toBeGreaterThan(last);
      last = at;
    }
    // all 34 carry a hex swatch
    const swatches = table.match(/#[0-9a-f]{6}/g) || [];
    expect(swatches.length).toBe(34);
    expect(new Set(swatches).size).toBe(34);
  });

  test("the legend renders all 34 rows with their dots", () => {
    expect(src).toMatch(/CLASSES\[i\]\[1\]/); // the swatch colour
    expect(src).toMatch(/className = "hwsd-legend-row"/);
    expect(src).toMatch(/className = "hwsd-legend-dot"/);
    const css = readFileSync(join(ROOT, "styles.css"), "utf8");
    expect(css).toMatch(/\.hwsd-legend-row/);
    expect(css).toMatch(/\.hwsd-probe/);
  });
});

describe("the key can be READ — it lives on a WHITE panel", () => {
  const css = readFileSync(join(ROOT, "styles.css"), "utf8");

  test("it must not paint itself with the DARK theme's foreground", () => {
    // The key is injected INTO the layers dropdown, which is WHITE.
    // `var(--fg)` is the DARK theme's foreground (#e6edf3), and painted
    // on white it measures **1.18:1** — the thirty-four soil names were
    // effectively INVISIBLE. The owner reported it as "its difficult to
    // see the soil types on the drop down".
    //
    // The same trap the languages legend already had (AGENTS.md:
    // "`var(--fg)` renders it invisible there"). Measured with
    // scripts/legend_contrast_check.py, which now guards every key in
    // the dropdown, not just this one.
    const block = css.slice(css.indexOf(".hwsd-legend {"));
    const legendBlock = block.slice(0, block.indexOf("}"));
    expect(legendBlock).not.toMatch(/var\(--fg\)/);
    expect(legendBlock).toMatch(/color: #333;/);
  });

  test("the names are at least 12px, like every other key", () => {
    const i = css.indexOf(".hwsd-legend-row {");
    const block = css.slice(i, css.indexOf("}", i));
    expect(block).toMatch(/font-size: 13px;/);
  });

  test("the swatches are big enough, with an edge for the pale ones", () => {
    // Several WRB colours are pale (Alisols #ffffbe, Gypsisols #fef6a4,
    // Regosols #fee3a4) and would vanish into a white panel without a
    // border.
    const i = css.indexOf(".hwsd-legend-dot {");
    const block = css.slice(i, css.indexOf("}", i));
    expect(block).toMatch(/width: 13px;/);
    expect(block).toMatch(/height: 13px;/);
    expect(block).toMatch(/border: 1px solid rgba\(0, 0, 0, 0\.45\)/);
  });

  test("no name is cut off", () => {
    // The grid column must fit the longest name ("Open inland water"),
    // which was cut to "Open inland w…".
    const i = css.indexOf(".hwsd-legend-grid {");
    const block = css.slice(i, css.indexOf("}", i));
    const m = block.match(/minmax\((\d+)px/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(140);
  });

  test("the key is brought into view when the layer is switched on", () => {
    // It sits 3,200 px down a 5,000 px dropdown, so a reader who ticks
    // "Soil type" used to see the map change and NO key at all.
    expect(src).toMatch(/function revealLegend\(\)/);
    expect(src).toMatch(/box\.scrollIntoView\(\{ block: "nearest"/);
    // …but only when it is not already on screen.
    expect(src).toMatch(/if \(b\.top >= l\.top - 2 && b\.bottom <= l\.bottom \+ 2\) return;/);
  });
});

describe("attribution is on the map, not just in a file", () => {
  test("the Leaflet options carry a printable attribution", () => {
    expect(src).toMatch(/attribution:\s*ATTRIBUTION/);
    expect(src).toMatch(/FAO & IIASA/);
    expect(src).toMatch(/CC BY 4\.0/);
    // the dataset, not merely the tile server that renders it
    expect(src).toMatch(/Harmonized World Soil Database v2\.2/);
  });
});

describe("it reads values it CAN read, and no others", () => {
  test("no export registration — a class is not a number", () => {
    // The export engine samples numeric lattices; a categorical class
    // id has no meaning outside this client's own colour table.
    expect(src).toMatch(/registerExport: function \(\) \{ \/\* a picture of classes/);
    expect(code).not.toMatch(/XYZO_EXPORT\.register\(/);
  });

  test("the hover HUD is consulted before the probe paints", () => {
    // "Everything" mode replaces the layers' own hover boxes; without
    // the check two boxes fight for the same patch of screen.
    expect(src).toMatch(/HoverInfo\.suppressesProbes/);
  });
});
