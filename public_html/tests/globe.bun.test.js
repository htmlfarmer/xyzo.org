/**
 * 3D globe view (globe.html) — a separate MapLibre view with the same
 * overlays and the same pins as the flat map.
 *
 * The flat map is Leaflet and stays Leaflet: the canvas pin renderer, the
 * isobar layer, the basins probe and the layers dropdown are all deeply
 * Leaflet-coupled. The globe is additive, not a port.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const globeHtml = readFileSync(join(root, "globe.html"), "utf8");
const globeJs = readFileSync(join(root, "globe.js"), "utf8");
const globeCss = readFileSync(join(root, "globe.css"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");

const VENDOR = join(root, "vendor", "maplibre-gl");

describe("3D globe view", () => {
  test("MapLibre is vendored, not loaded from a CDN at runtime", () => {
    expect(existsSync(join(VENDOR, "maplibre-gl.js"))).toBe(true);
    expect(existsSync(join(VENDOR, "maplibre-gl.css"))).toBe(true);
    expect(globeHtml).toMatch(/vendor\/maplibre-gl\/maplibre-gl\.js/);
    expect(globeHtml).toMatch(/vendor\/maplibre-gl\/maplibre-gl\.css/);
    // No script tag may point at an external origin.
    const srcs = [...globeHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(1);
    for (const s of srcs) {
      expect(s.includes("://")).toBe(false);
      expect(s.startsWith("//")).toBe(false);
    }
  });

  test("the globe projection is set after the style loads", () => {
    // MapLibre 5.6 IGNORES the constructor's `projection` option —
    // getProjection() stays null — so it has to be set in the load
    // handler, or the map silently renders flat.
    expect(globeJs).toMatch(/map\.setProjection\(\{ type: "globe" \}\)/);
    // Sources and layers must be added after the style is loaded
    // ("Style is not done loading" otherwise), so the calls have to sit
    // inside the load handler.
    const loadIdx = globeJs.indexOf('map.on("load"');
    const callIdx = globeJs.indexOf("for (const o of OVERLAYS) addOverlay(o);");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(loadIdx);
    expect(globeJs.slice(loadIdx, loadIdx + 400)).toMatch(/addOverlay\(o\)/);
  });

  test("it carries the same overlays as the flat map", () => {
    expect(globeJs).toMatch(/\/data\/koppen\/tiles/);
    expect(globeJs).toMatch(/\/data\/soil\//);
    expect(globeJs).toMatch(/\/data\/cropland\/cropland\//);
    expect(globeJs).toMatch(/\/data\/cropland\/landcover\//);
    expect(globeJs).toMatch(/\/data\/rivers\/rivers\.geojson/);
    // Basins must NOT be a hardcoded path. The single basins.geojson
    // stopped being built when that layer split into two detail levels
    // (basins_major / basins_detailed, named in meta.levels[]), so the
    // assertion that used to live here pinned a URL which 404'd on every
    // page load — the globe's basins overlay silently drew nothing
    // (found by console audit, 2026-10-30). The filename comes from
    // meta.levels[] + default_level, exactly as the flat map's
    // levelUrl() does. Pin the loader AND the absence of the dead path,
    // or a tidy-up puts the 404 straight back.
    expect(globeJs).not.toMatch(/data\/basins\/basins\.geojson/);
    expect(globeJs).toMatch(/async function loadBasins\(\)/);
    expect(globeJs).toMatch(/l\.id === meta\.default_level/);
    expect(globeJs).toMatch(/loadBasins\(\);\s*\n\s*loadTemp\(\);/);
    // The mag URL is built from the file meta.json names for the
    // SELECTED field. The globe must not carry its own list of contour
    // families: a hardcoded one lagged the flat map twice already (it
    // shipped with two, missed isoporics for a day), and there are now
    // EIGHT families — meta.fields[k].lines is the only place they live.
    expect(globeJs).toMatch(/q\("\/data\/mag\/" \+ field\.lines\)/);
    expect(globeJs).toMatch(/q\("\/data\/mag\/meta\.json"\)/);
    // And only the index (major) contours are drawn there: the globe's
    // fixed world view would turn the 2° intermediate mesh into a
    // hairball, the same rank the flat map hides below zoom 4. Written
    // as `!= false` so a GeoJSON cached from BEFORE the major flag
    // existed still renders (every feature was an index line then) —
    // `== true` would blank the layer on a stale cache.
    expect(globeJs).toMatch(/\["!=",\s*\["get",\s*"major"\],\s*false\]/);
    expect(globeJs).not.toMatch(/\["==",\s*\["get",\s*"major"\]/);
    expect(globeJs).toMatch(/\/api\/weather\/isobars/);
    // The globe PINS its own density (2 hPa) but lets a SHARED LINK
    // override it — the flat map writes the detail into the URL as
    // `iso=1`, and the handoff passes the segment through untouched.
    expect(globeJs).toMatch(/\/api\/weather\/isobars\?bbox=[^"'`]*step=\$\{step\}/);
    expect(globeJs).toMatch(/const step = globeIsoStep\(\) \|\| GLOBE_ISO_STEP/);
    // The globe bakes the temperature into an equirectangular picture,
    // so it reads the COARSE pair — the same field, subsampled to 1°
    // by the worker, from the same run. The flat map reads the 0.25°
    // pair.
    expect(globeJs).toMatch(/\/data\/temp\/grid-1deg\.bin/);
    expect(globeJs).toMatch(/\/data\/temp\/meta-1deg\.json/);
    expect(globeJs).toMatch(/\/data\/lightning\/grid_annual\.bin/);
    // Macrostrat comes through OUR tile mirror, not hotlinked — the same
    // rule the NASA lines below state for the GIBS proxies. The
    // upstream URL is built server-side from a whitelist and
    // revalidated every 30 days (api/src/routes/tileMirror.ts).
    expect(globeJs).toMatch(/\/api\/tile\/mirror\/macrostrat\/\{z\}\/\{x\}\/\{y\}/);
    expect(globeJs).not.toMatch(/tiles\.macrostrat\.org/);
    // The NASA overlays come through OUR tile proxy, not straight from
    // GIBS. GIBS answers 404 for a tile where the product has no value
    // (the open ocean, the poles), and a 404 on a tile is a browser-
    // logged console error that no JavaScript can suppress — the
    // proxy answers 200 with a 1x1 transparent PNG instead, and it
    // resolves the most recent PUBLISHED date (GIBS publishes the
    // true-colour satellite a day or two behind, so "yesterday" was a
    // whole layer of 404s and the overlay silently drew NOTHING).
    expect(globeJs).toMatch(/\/api\/tile\/satellite\//);
    expect(globeJs).toMatch(/\/api\/tile\/rain\//);
    expect(globeJs).toMatch(/\/api\/tile\/night\//);
    expect(globeJs).not.toMatch(/gibs\.earthdata\.nasa\.gov/);
  });

  test("the lightning density overlay ports to the globe", () => {
    // It is a baked equirectangular image source, like the temperature
    // field — a globe has no tiles to hang a GridLayer on.
    expect(globeJs).toMatch(/key:\s*"lightning"/);
    expect(globeJs).toMatch(/type:\s*"lightning"/);
    expect(globeJs).toMatch(/loadLightning/);
    expect(globeJs).toMatch(/addSource\("lightning"/);
    // The opacity slider must reach it, or the layer is stuck at 100%.
    expect(globeJs).toMatch(/o\.type === "lightning"/);
    // The picture is MERCATOR, so its quad is the mercator world: the
    // corners stop at the mercator limit, and ±90° would project to
    // y=Infinity and the source silently never renders.
    expect(globeJs).toMatch(/XYZO_FIELD_BAKE\.mercatorQuad\(\)/);
  });

  test("the WIND ports to the globe, and the WMS overlay does not", () => {
    // The wind used to be listed as not portable ("a screen-space
    // canvas animation tied to Leaflet's 2D projection"). It IS
    // portable: the globe's animation keeps its particles in
    // GEOGRAPHIC space, projects them with map.project() and culls the
    // far side of the sphere with a back-face test. Geologic contacts
    // still cannot: a WMS layer needs BBOX/GetMap and MapLibre's
    // raster sources need an XYZ template.
    expect(globeJs).toMatch(/key:\s*"wind"/);
    expect(globeJs).toMatch(/key:\s*"wind-speed"/);
    expect(globeJs).toMatch(/XYZO_GLOBE_WIND/);
    expect(globeJs).toMatch(/Geologic contacts/);
    expect(globeJs).toMatch(/WMS/);
  });

  test("soil has a property switcher with the same ten properties", () => {
    expect(globeJs).toMatch(/props:\s*\["texture"/);
    for (const p of ["wrb", "usda", "clay", "sand", "silt", "phh2o", "soc", "bdod", "cec"]) {
      expect(globeJs).toContain('"' + p + '"');
    }
    // The switcher swaps the source's tiles in place (no setTiles API).
    expect(globeJs).toMatch(/removeSource\(o\.key\)/);
    expect(globeJs).toMatch(/globe-ov-props/);
  });

  test("the pins come from the same API the flat map uses", () => {
    expect(globeJs).toMatch(/\/api\/pins\/map\?bbox=-180,-85,180,85/);
    // The endpoint caps the limit at 2000 — a larger one is a 400.
    expect(globeJs).toMatch(/limit=2000/);
  });

  test("the isobars are fetched for the WHOLE WORLD, never a viewport", () => {
    // The globe always asks for the whole field. That is what keeps it
    // out of the flat map's dateline bug: a bbox whose east edge runs
    // past 180 is exactly what threw 127,530 vertices off the LEFT edge
    // of the Pacific view, and a spherical renderer would not save us —
    // the wrong box is still the wrong box. Changing this to a
    // viewport-derived bbox reintroduces the class of bug the flat map
    // needed a wrap() to escape.
    expect(globeJs).toMatch(/\/api\/weather\/isobars\?bbox=-180,-85,180,85/);
    // …and it pins its own step, so a worker publishing a finer
    // interval cannot silently double the globe's line count and
    // payload (the reason the globe carries `iso=` at all).
    expect(globeJs).toMatch(/weather\/isobars\?bbox=[^"`]*step=\$\{step\}/);
  });

  test("a pin opens the story and links back to the flat map", () => {
    expect(globeJs).toMatch(/Open on the flat map/);
    expect(globeJs).toMatch(/xyzo\.org\/#/);
    expect(globeJs).toMatch(/pin=/);
  });

  test("every overlay has an opacity slider with a real default", () => {
    // A missing default renders "NaN%" in the readout.
    // Take the OVERLAYS array out of the source and check every entry.
    const arr = globeJs.slice(
      globeJs.indexOf("const OVERLAYS = ["),
      globeJs.indexOf("];", globeJs.indexOf("const OVERLAYS = [")));
    const entries = arr.split(/key:\s*"/).slice(1);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const e of entries) {
      expect(e).toMatch(/type:\s*"(raster|line|fill|mag|isobars|temp|lightning|wind-speed|wind|quake|faults|langregions)"/);
      // A missing default renders "NaN%" in the readout.
      expect(e).toMatch(/opacity:\s*0\.\d+/);
    }
  });

  test("the projection switcher offers globe, vertical and mercator", () => {
    expect(globeJs).toMatch(/\["globe", "vertical-perspective", "mercator"\]/);
    expect(globeJs).toMatch(/setProjection/);
  });

  test("the flat map links to the globe", () => {
    expect(appJs).toMatch(/globe\.html/);
    expect(appJs).toMatch(/Open the 3D globe/);
  });

  test("the globe page has its own styles and a way back", () => {
    expect(globeHtml).toMatch(/globe\.css/);
    expect(globeHtml).toMatch(/Back to the map/);
    expect(globeCss).toMatch(/#globe-panel/);
    // The panel covers the left third on a wide screen, so the canvas
    // starts after it and the globe lands in the free space.
    expect(globeCss).toMatch(/@media \(min-width: 1100px\)/);
  });

  test("popups are dark-styled — MapLibre's default is white", () => {
    // MapLibre ships a white popup; our text colours are for a dark bg,
    // so without the override the popup is light-on-white and unreadable.
    expect(globeCss).toMatch(/\.maplibregl-popup-content/);
    expect(globeCss).toMatch(/background: rgba\(11, 15, 20/);
    expect(globeCss).toMatch(/\.maplibregl-popup-tip/);
    expect(globeCss).toMatch(/\.maplibregl-popup-close-button/);
  });

  test("overlay settings and projection persist across reloads", () => {
    expect(globeJs).toMatch(/xyzo\.globe\.settings/);
    expect(globeJs).toMatch(/loadSettings/);
    expect(globeJs).toMatch(/saveSettings/);
    expect(globeJs).toMatch(/persistOverlay/);
    // Restored state must drive the initial visibility and slider value.
    expect(globeJs).toMatch(/startEnabled/);
    expect(globeJs).toMatch(/startOpacity/);
  });

  test("the globe shares its state in the URL", () => {
    expect(globeJs).toMatch(/function parseGlobeHash\(/);
    expect(globeJs).toMatch(/function writeGlobeHash\(/);
    expect(globeJs).toMatch(/overlay=/);
    expect(globeJs).toMatch(/proj=/);
  });

  test("a bare slug in the hash still works (no @pct)", () => {
    expect(globeJs).toMatch(/at <= 0/);
    expect(globeJs).toMatch(/opacity:\s*null/);
  });

  test("the hash is written on moveend and on overlay/projection changes", () => {
    expect(globeJs).toMatch(/map\.on\("moveend", writeGlobeHash\)/);
    expect(globeJs).toMatch(/writeGlobeHash\(\)/);
  });

  test("the globe is reachable at /globe, not just /globe.html", () => {
    expect(globeHtml).toMatch(/\/vendor\/maplibre-gl\/maplibre-gl\.js/);
    expect(globeHtml).toMatch(/\/globe\.js/);
    expect(globeHtml).toMatch(/\/globe\.css/);
  });

  test("the vendored bundle is a real MapLibre build", () => {
    const js = readFileSync(join(VENDOR, "maplibre-gl.js"), "utf8");
    expect(js.length).toBeGreaterThan(500_000);
    expect(js).toMatch(/globe/);
    expect(js).toMatch(/setProjection/);
    // Under a megabyte raw / ~250 KB gzipped — it is only loaded by the
    // globe page, never by the flat map.
    expect(statSync(join(VENDOR, "maplibre-gl.js")).size).toBeLessThan(1_200_000);
  });

  test("bump_frontend.sh stamps globe.html assets AND globe.js's V constant", () => {
    // The globe page has its own ?v= tokens that index.html's stamp
    // loop never touches. A stale token on globe.js kept cached
    // browsers on the old overlay code. The script must cover:
    const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");
    expect(bump).toMatch(/GLOBE_HTML/);
    expect(bump).toMatch(/globe\.js/);
    expect(bump).toMatch(/globe\.css/);
    expect(bump).toMatch(/maplibre-gl\.js/);
    // globe.js's internal V constant busts its own data URLs — it must
    // be rewritten too, or the ?v= on the <script> tag is not enough.
    expect(bump).toMatch(/const V = /);
    // And mag-layer.js must be in the index.html ASSETS list (it was
    // missing, so its ?v= token went stale on every deploy).
    expect(bump).toMatch(/mag-layer\.js/);
  });

  test("the 3D globe button is a ringed planet, distinct from the world-view globe", () => {
    // Both buttons used near-identical globe SVGs — unreadable at a
    // glance. The 3D button is now a Saturn-style ringed planet.
    expect(appJs).toMatch(/Open the 3D globe/);
    // The ringed-planet icon: a small circle plus a tilted ellipse ring.
    const globeIdx = appJs.indexOf("Open the 3D globe");
    const snippet = appJs.slice(globeIdx, globeIdx + 600);
    expect(snippet).toMatch(/<circle cx="12" cy="12" r="6"\/>/);
    expect(snippet).toMatch(/<ellipse[^>]*rx="10\.5"/);
  });

  test("the zoom bar's height is measured so the live panel cannot cover the 3D button", () => {
    // The bar grew to 4 buttons (+, −, world, 3D globe) but
    // --zoom-stack was still a hand-tuned 3-button height, so the live
    // panel sat on top of the 3D globe button.
    expect(appJs).toMatch(/syncZoomStack/);
    expect(appJs).toMatch(/--zoom-stack/);
    // It must observe the bar, not just run once — font loading and
    // touch-vs-desktop button sizes change the height after boot.
    expect(appJs).toMatch(/ResizeObserver.*syncZoomStack|new ResizeObserver\(syncZoomStack\)/);
  });

  test("the --zoom-stack CSS fallback is tall enough for four buttons", () => {
    // syncZoomStack measures the real bar, but the CSS fallback is what
    // paints before JS runs (and what survives if ResizeObserver is
    // missing). Four 30px touch buttons + a 10px margin is ~130px; the
    // fallback must not be the old 3-button 116px.
    const styles = readFileSync(join(root, "styles.css"), "utf8");
    const m = styles.match(/--zoom-stack:\s*(\d+)px/);
    expect(m, "--zoom-stack fallback missing").toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(130);
  });
});

describe("globe mag filter is stale-cache tolerant", () => {
  // Regression for the 2026-10-28 sweep: the published GeoJSON gained a
  // `major` flag when intermediate contours shipped. A browser holding
  // the OLD file (no flag on any feature) must still render the globe's
  // magnetic layers — `["==", ["get","major"], true]` is false for a
  // missing property, which would blank the whole layer until the cache
  // expired. `["!=", ["get","major"], false]` treats "absent" as major,
  // which is what every pre-flag feature actually was.
  const globeJs = readFileSync(join(root, "globe.js"), "utf8");

  test("the index-only filter tolerates features without the flag", () => {
    expect(globeJs).toMatch(/\["!=",\s*\["get",\s*"major"\],\s*false\]/);
  });

  test("one line layer plus one wash carry the selected field", () => {
    // The globe used to build THREE per-family line layers from a list
    // written out TWICE (layerIdsFor and the adder), which is how
    // isoporics shipped invisible for a day — two places to forget.
    // Now there is one line layer and one wash, both with STATIC ids,
    // and a field switch swaps data through them: nothing to enumerate,
    // so no family can be left out of a list.
    expect(globeJs).toMatch(
      /if \(o\.type === "mag"\) return \[o\.key \+ "-lines", o\.key \+ "-wash"\]/
    );
    expect(globeJs).toMatch(/map\.addSource\(o\.key \+ "-lines"/);
    expect(globeJs).toMatch(/id: o\.key \+ "-lines"/);
    // The opacity loop must cover the SAME two ids, or the slider would
    // stop at the contours once the wash is painted.
    expect(globeJs).toContain('for (const id of [o.key + "-lines", o.key + "-wash"])');
    // The wash is a raster layer, so its knob is raster-opacity.
    expect(globeJs).toMatch(/id === o\.key \+ "-wash" \? "raster-opacity" : "line-opacity"/);
    // And the old per-family list must not come back.
    expect(globeJs).not.toMatch(/"isogonics",\s*"isoclinics",\s*"isoporics"/);
  });

  test("the field set comes from meta.json, never a second table", () => {
    // globe.html loads only maplibre + globe.js — no Leaflet, so
    // mag-layer.js cannot come along (see the file's own note). The
    // published meta.fields table is therefore the ONLY description of
    // a field this page is allowed to keep; a second one drifts, and
    // the two views start disagreeing about what a colour means.
    expect(globeJs).toMatch(/meta\.fields|m\.fields/);
    // The chips are built from meta.components / meta.modes...
    expect(globeJs).toMatch(/magState\.meta\.components/);
    // ...and so are the things that vary with the model: the contour
    // file, the Int16 scale, the ramp range and the blackout flag.
    expect(globeJs).toMatch(/field\.lines/);
    expect(globeJs).toMatch(/field\.scale/);
    expect(globeJs).toMatch(/field\.ramp/);
    expect(globeJs).toMatch(/field\.range/);
    expect(globeJs).toMatch(/field\.boz/);
    // No field file names and no contour family names of its own:
    expect(globeJs).not.toMatch(/grid_[dfhi][a-z]*\.bin/);
    expect(globeJs).not.toMatch(/isodynamics|isohorizontals|isoclinics/);
  });
});

// ── the magnetic FIELD SWITCHER (component × value, with one opacity) ──
//
// The globe used to show all three contour families at once with no way
// to choose. It now carries one line layer + one colour wash, swapped to
// whichever field the chips pick, under the same checkbox and opacity
// slider as every other overlay.
describe("globe mag field switcher", () => {
  const globeJs = readFileSync(join(root, "globe.js"), "utf8");

  test("the panel gets a switcher container under the mag row", () => {
    expect(globeJs).toMatch(/id = "mag-field-switch"/);
    expect(globeJs).toMatch(/setAttribute\("aria-label", "Magnetic field shown"\)/);
  });

  test("clicking a chip persists the view and repaints both halves", () => {
    // Persisted under its own key so it survives a reload without
    // touching the per-overlay {enabled, opacity} record.
    expect(globeJs).toMatch(/settings\.magView = \{/);
    // Repaint BOTH the contours and the wash — a chip that moved only
    // one of them would leave the colours disagreeing with the lines.
    expect(globeJs).toMatch(/renderMagSelector\(\);\s*\n\s*renderMagField\(\);/);
  });

  test("a field switch cannot be undone by a slow first fetch", () => {
    // Two quick clicks: the second fetch may resolve FIRST, so the
    // first must notice it has been superseded and stand down —
    // otherwise the field the user just LEFT is the one that paints.
    const gens = globeJs.match(/if \(gen !== magState\.gen\) return;/g) || [];
    expect(gens.length).toBeGreaterThanOrEqual(2);
    expect(globeJs).toMatch(/const gen = \+\+magState\.gen;/);
  });

  test("the projection listener is wired once however often the panel rebuilds", () => {
    // loadMag() re-renders the panel after meta.json lands, and `proj`
    // survives that rebuild — a listener added each round would fire N
    // times per click and stack N saveSettings() calls.
    expect(globeJs).toMatch(/if \(!proj\._xyzoWired\)/);
    expect(globeJs).toMatch(/proj\._xyzoWired = true;/);
  });

  test("the wash image source is replaced, never left stale", () => {
    // MapLibre image sources have no setData, so a field switch has to
    // remove + re-add. Leaving the old one would keep painting the
    // previous field's colours under the new lines.
    expect(globeJs).toMatch(/if \(map\.getLayer\("mag-wash"\)\) map\.removeLayer\("mag-wash"\);/);
    expect(globeJs).toMatch(/if \(map\.getSource\("mag-wash"\)\) map\.removeSource\("mag-wash"\);/);
    // The picture is MERCATOR, so the quad is the mercator world —
    // ±90 projects to y=Infinity and the source silently never renders.
    expect(globeJs).toMatch(/coordinates: XYZO_FIELD_BAKE\.mercatorQuad\(\)/);
  });
});

// ── the selector's component chips must not render empty ───────────────
//
// 2026-10-30, found with Playwright: all FOUR component chips came back
// as "" because the globe reads the chip text from meta.fields[k].label
// and the worker never published one — magEsc(undefined) === "".
describe("globe mag chips are labelled", () => {
  const globeJs = readFileSync(join(root, "globe.js"), "utf8");

  test("magComponentLabel falls back instead of returning undefined", () => {
    // The `&& f.label` guard is what makes the function reach its
    // uppercase fallback when an older meta.json has no label at all.
    expect(globeJs).toMatch(
      /if \(f\.component === c && f\.mode === "main" && f\.label\) return f\.label;/
    );
    expect(globeJs).toMatch(/return String\(c\)\.toUpperCase\(\);/);
  });

  test("the worker publishes the label the globe reads", () => {
    const worker = readFileSync(join(root, "..", "worker", "magmap.py"), "utf8");
    expect(worker).toMatch(/"label": FIELDS_SPEC\[key\]\["label"\]/);
    for (const name of ["Declination", "Total force", "Horizontal force", "Inclination"]) {
      expect(worker).toMatch(new RegExp(`label="${name}"`));
    }
  });
});
