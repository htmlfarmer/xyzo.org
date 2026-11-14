// layers-dropdown.bun.test.js — what lives inside the Leaflet layers
// dropdown (the top-right stack icon).
//
// The dropdown is the single place for map layers:
//   • base layers (Street / Satellite / …)
//   • overlays — NASA imagery + the Köppen climate wash, each with an
//     opacity slider (overlay-opacity.js)
//   • "Story links" — the connection arcs (app.js mountLinksRow)
//   • the Köppen class key (climate-layer.js mountLegendIntoLayersControl)
//
// Nothing about the climate or the links may float over the map any
// more: both used to be permanent panels in the right column.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const climateJs = readFileSync(join(ROOT, "climate-layer.js"), "utf8");
const opacityJs = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("layers dropdown — contents", () => {
  test("the Story links toggle is injected into the layers dropdown", () => {
    expect(appJs).toMatch(/function mountLinksRow\(\)/);
    expect(appJs).toMatch(/leaflet-control-layers-overlays/);
    expect(appJs).toMatch(/insertAdjacentElement\("afterend", row\)/);
    expect(appJs).toMatch(/id="ctrl-links-toggle"/);
    // It is no longer a row in the bottom-bar control menu.
    expect(indexHtml).not.toMatch(/id="ctrl-links-toggle"/);
  });

  test("the Story links row is a sibling of the overlay list, not a child", () => {
    // Leaflet rebuilds the overlays list on every layer change — a row
    // INSIDE it would be wiped on the first overlay toggle.
    expect(appJs).toMatch(/overlays\.insertAdjacentElement\("afterend", row\)/);
    expect(appJs).not.toMatch(/overlays\.appendChild\(row\)/);
  });

  test("the Köppen class key is injected into the layers dropdown", () => {
    expect(climateJs).toMatch(/function mountLegendIntoLayersControl\(\)/);
    expect(climateJs).toMatch(/\.leaflet-control-layers-list/);
    expect(indexHtml).not.toMatch(/id="climate-legend"/);
  });

  test("no floating climate / links panel is left in the markup", () => {
    expect(indexHtml).not.toMatch(/climate-legend/);
    expect(indexHtml).not.toMatch(/ctrl-links-toggle/);
    expect(stylesCss).not.toMatch(/^\.climate-legend\s*\{/m);
  });

  test("every overlay gets an opacity slider", () => {
    expect(opacityJs).toMatch(/\.leaflet-control-layers-overlays/);
    expect(opacityJs).toMatch(/Object\.keys\(overlays\)/);
    expect(appJs).toMatch(/OverlayOpacity\.mount\(WEATHER_OVERLAYS\)/);
  });
});
