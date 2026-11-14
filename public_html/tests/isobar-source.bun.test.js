/**
 * The isobar ANALYSIS picker — which chart is this?
 *
 * WHY IT EXISTS
 * -------------
 * Three analyses are published side by side and they are NOT the same
 * picture of the atmosphere:
 *
 *   ecmwf  ECMWF IFS 0.1°  — the finer grid, ~8.5 h after its run
 *   gfs    NOAA GFS 0.25°  — the fresher global analysis, ~3.5 h after
 *   hrrr   NOAA HRRR 3 km  — hourly, North America only
 *
 * Until now the reader had no say: the API picked ("auto" — the newest
 * analysis that covers the viewport, which is usually GFS). That is
 * the honest answer to "our pressure lines differ from windy.com",
 * which draws ECMWF by default — but a choice the reader cannot make
 * is a mystery, and a mystery is a bug report.
 *
 * So the reader chooses, and the choice travels with the link
 * (`isoSrc=ecmwf`), the saved style and the presets — the same grammar
 * a shared URL speaks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const layerJs = readFileSync(join(root, "isobar-layer.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const presetsJs = readFileSync(join(root, "map-presets.js"), "utf8");
const globeJs = readFileSync(join(root, "globe.js"), "utf8");

describe("the isobar analysis picker", () => {
  test("the layer offers the three analyses plus auto", () => {
    expect(layerJs).toMatch(/const SOURCE_CHOICES = \[/);
    for (const id of ["auto", "ecmwf", "gfs", "hrrr"]) {
      expect(layerJs).toMatch(new RegExp(`\\{ id: "${id}"`));
    }
    expect(layerJs).toMatch(/xyzo\.isobarSource/);
  });

  test("the fetch asks for the chosen analysis", () => {
    expect(layerJs).toMatch(/source=\$\{encodeURIComponent\(state\.requestedSource\)\}/);
  });

  test("the requested analysis and the SERVED one are different things", () => {
    // HRRR only covers North America, and an analysis that is not
    // loaded falls back to the newest global one — so the layer has to
    // keep both: the one the reader asked for, and the one the API
    // actually drew (which is what the attribution must name).
    expect(layerJs).toMatch(/requestedSource: readStoredSource\(\)/);
    expect(layerJs).toMatch(/getRequestedSource/);
    expect(layerJs).toMatch(/getSource: \(\) => state\.source/);
  });

  test("the choice is persisted, and a link's choice is not", () => {
    // A link is a VIEW, not a settings change: opening someone else's
    // map must not overwrite the reader's own stored choice. The same
    // rule every layer preference follows at boot.
    expect(layerJs).toMatch(/storageSet\(SOURCE_STORE_KEY, want\)/);
    expect(layerJs).toMatch(/opts\.persist === false/);
  });

  test("the choice travels with the link: isoSrc=", () => {
    expect(appJs).toContain("const isoSrc = (isoSource && isobarsOn)");
    expect(appJs).toContain("/isoSrc=${encodeURIComponent(isoSource)}");
    expect(appJs).toContain("${overlays}${iso}${isoSrc}${delta}${wind}");
    // And it is read back.
    expect(appJs).toMatch(/const isoSrcMatch = p\.match\(\/\^isoSrc=/);
    expect(appJs).toContain("res.isoSource = isoSrcMatch[1]");
  });

  test("a link's analysis is applied BEFORE the layer is enabled", () => {
    // The step and the colour already work this way: the fetch has to
    // carry the setting, so the setting is applied first and the layer
    // is enabled second — ONE fetch, carrying the right analysis.
    const at = appJs.indexOf("window.IsobarLayer.setSource(parsed.isoSource, { persist: false })");
    expect(at).toBeGreaterThan(-1);
    const enabled = appJs.indexOf("window.IsobarLayer.setEnabled(true);", at);
    expect(enabled).toBeGreaterThan(-1);
    expect(at).toBeLessThan(enabled);
  });

  test("the chips live in the layers dropdown, under the other two rows", () => {
    expect(layerJs).toMatch(/function mountSourceControl/);
    expect(layerJs).toMatch(/isobar-source-switch/);
    // Same markup as the detail and colour rows, so there is no new CSS
    // to collide with.
    expect(layerJs).toMatch(/row\.className = "soil-prop-switch"/);
    expect(layerJs).toMatch(/b\.className = "soil-prop-btn"/);
    // Mounted from the step control, which is mounted from the isobar
    // row — the layer owns all three.
    expect(layerJs).toMatch(/mountSourceControl\(stepRow\)/);
  });

  test("a chip for an analysis that is NOT published is disabled", () => {
    // HRRR is the case that matters: the API has always accepted
    // `source=hrrr`, but there is NO WORKER for it, so nothing has ever
    // published an HRRR isobar row. A chip that offers it and then
    // silently draws something else is a control lying about what is on
    // screen — so the layer asks the API what it actually holds
    // (`/api/weather/isobars/meta`) and greys the chip out.
    expect(layerJs).toMatch(/loadAvailableSources/);
    expect(layerJs).toMatch(/availableSources/);
    expect(layerJs).toMatch(/b\.disabled = missing/);
    expect(layerJs).toMatch(/Not published right now/);
    // And when the API serves something else than was asked for, the
    // chip says so rather than staying silent.
    expect(layerJs).toMatch(/the map is drawing/);
  });

  test("the saved style and the presets carry it too", () => {
    expect(appJs).toContain("isoSource: (window.IsobarLayer &&");
    expect(appJs).toContain("isoSource: style.isoSource || undefined");
    expect(appJs).toContain("isoSource: state.isoSource || undefined");
    // The preset grammar is the shared-URL grammar.
    expect(presetsJs).toMatch(/const isoSrc = p\.match\(\/\^isoSrc=/);
    expect(presetsJs).toContain("out.isoSource = state.isoSource");
  });

  test("the globe reads it too", () => {
    // The handoff passes unknown hash parts through untouched, so a
    // link with `isoSrc=ecmwf` reaches the globe — and the globe has
    // to understand it, or it opens on whichever analysis the API
    // picks.
    expect(globeJs).toMatch(/function globeIsoSource/);
    expect(globeJs).toMatch(/isoSourceInUse = isoSrc/);
    expect(globeJs).toContain("/isoSrc=${encodeURIComponent(isoSourceInUse || \"auto\")}");
  });
});
