/**
 * wind-layer module — pane-translate anchoring.
 *
 * The streamlines are drawn at latLngToContainerPoint on a canvas
 * inside windPane, and Leaflet's pane translate PERSISTS after every
 * drag-pan (only setView/zoom zeroes it) — the same bug that shipped
 * city labels off-centre (city-labels.bun.test.js pins that side).
 * These tests pin the wind side: canvas re-anchored per pan, probe
 * attached to the map CONTAINER (never the transformed pane).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const js = readFileSync(join(ROOT, "wind-layer.js"), "utf8");

describe("wind-layer — the particle guard is RELATIVE to the view", () => {
  test("there is NO fixed -180..185 longitude window", () => {
    // Owner report 2026-11-08: *"notice the right side has the wind
    // but the left doesn't"* at #18.9998,-168.2666,5.
    //
    // LEAFLET'S LONGITUDE SPACE IS CONTINUOUS: a view centred west of
    // the antimeridian runs from -199.9 to -136.6, and the particles
    // on the far side of the dateline are legitimately at -199. A fixed
    // window killed them EVERY FRAME — and `spawn()` picks the next
    // longitude from `map.getBounds()`, so the replacement died at once
    // too. The western Pacific was blank: the measured ink was 1,393
    // samples on the left half of the canvas against 3,832 on the
    // right (100 % after the fix).
    expect(js).not.toMatch(/p\.lng\s*<\s*-180\s*\|\|\s*p\.lng\s*>\s*185/);
    expect(js).not.toMatch(/p\.lng\s*<\s*-180/);
    expect(js).not.toMatch(/p\.lng\s*>\s*185/);
  });

  test("the guard is measured against the view's window", () => {
    expect(js).toMatch(/function offWorld\(p\)/);
    expect(js).toMatch(/state\.viewWest\s*-\s*360/);
    expect(js).toMatch(/state\.viewEast\s*\+\s*360/);
    // …and the window is refreshed once per frame from the map itself.
    expect(js).toMatch(/state\.viewWest\s*=\s*vb\.getWest\(\)/);
    expect(js).toMatch(/state\.viewEast\s*=\s*vb\.getEast\(\)/);
    // Both renderers use it.
    const uses = js.match(/offWorld\(p\)/g) || [];
    expect(uses.length, "both the streamline and the particle renderer must use it")
      .toBeGreaterThanOrEqual(3);   // the definition + two call sites
  });
});

describe("wind-layer — pane translate", () => {
  test("anchorCanvas() pins the canvas origin to the screen origin", () => {
    expect(js).toMatch(/function anchorCanvas\(\)/);
    expect(js).toMatch(/map\.containerPointToLayerPoint\(\[0, 0\]\)/);
    expect(js).toMatch(/canvas\.style\.left = a\.x/);
    expect(js).toMatch(/canvas\.style\.top = a\.y/);
  });

  test("re-anchored on every moveend/zoomend, not only on resize", () => {
    // The pane translate changes with EVERY pan; a resize-only anchor
    // leaves the field shifted after a drag.
    const moveHandler = js.match(/map\.on\("moveend zoomend", function \(\) \{[\s\S]*?\}\);/);
    expect(moveHandler, "moveend/zoomend handler not found").toBeTruthy();
    expect(moveHandler[0]).toMatch(/anchorCanvas\(\)/);
    // And resize() anchors too, so the first layout is correct.
    const resizeFn = js.match(/function resize\(\) \{[\s\S]*?\n  \}/);
    expect(resizeFn).toBeTruthy();
    expect(resizeFn[0]).toMatch(/anchorCanvas\(\)/);
  });

  test("particles are drawn in container coordinates", () => {
    // That is the contract the anchor makes safe — if this ever moves
    // to layer points, the anchor becomes dead weight (and wrong).
    expect(js).toMatch(/latLngToContainerPoint\.bind\(map\)/);
  });

  test("the probe attaches to the map container, never the pane", () => {
    // The probe is positioned at containerPoint + 14; inside the
    // transformed mapPane it sat paneOffset from the cursor. The host
    // chain must START at the container and only degrade from there.
    expect(js).toMatch(/host = state\.map\.getContainer\(\)/);
    expect(js).toMatch(/host\.appendChild\(probeEl\)/);
    expect(js).not.toMatch(/\(state\.pane && state\.pane\.parentNode \|\| document\.body\)\.appendChild\(probeEl\)/);
  });
});
