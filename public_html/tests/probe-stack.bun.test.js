/**
 * The probe stack (probe-stack.js) — ONE positioner for every readout.
 *
 * THE DEFECT IT FIXES
 * -------------------
 * Every layer that has a number under the cursor drew its OWN box, and
 * every one of them placed itself at `containerPoint + 14px` — the same
 * 14px. With the wind, the wind speed and the climate all on, three
 * boxes landed on the same spot and covered each other: the reader saw
 * the top box and the other two were hidden underneath it.
 *
 * Measured on the live map before the fix (2026-11-04, pointer at
 * 800,500):
 *
 *     .wind-probe        [814, 514, 196, 44]
 *     #wind-speed-probe  [814, 514, 139, 26]    <- exactly on top
 *     .climate-probe     [914, 574, 205, 30]    <- exactly on top
 *
 * The stacker lays them out in ONE column instead, and the hover card
 * is part of the same column so it never covers a layer's reading
 * either.
 *
 * The live measurement is `scripts/probe_audit.py` — it drives a real
 * browser, sweeps the pointer over the map and checks that no two
 * readouts overlap and that every wind reading matches the published
 * grid.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const stackJs = readFileSync(join(root, "probe-stack.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const hoverJs = readFileSync(join(root, "hover-info.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const bump = readFileSync(join(root, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("probe-stack module", () => {
  test("exposes ProbeStack with the API the app uses", () => {
    expect(stackJs).toMatch(/window\.ProbeStack\s*=/);
    for (const fn of ["init", "place", "schedule"]) {
      expect(stackJs).toMatch(new RegExp(`\\b${fn}\\s*[:(]`));
    }
  });

  test("it knows EVERY probe box on the map", () => {
    // A probe class the stacker does not know about is a probe box that
    // is never stacked — and a probe box that is never stacked is a
    // probe box that covers the one below it. The list is the contract.
    for (const sel of [
      ".climate-probe",
      ".temp-probe",
      ".field-probe",
      ".wind-probe",
      ".lightning-probe",
      ".phytoplankton-probe",
      ".ocean-current-probe",
    ]) {
      expect(stackJs).toContain(JSON.stringify(sel).slice(1, -1));
    }
    // And the hover card, which lives on <body> rather than in the map.
    expect(stackJs).toContain(".hover-hud");
  });

  test("it stacks downward from the cursor and flips at the edges", () => {
    expect(stackJs).toMatch(/const OFFSET = 14/);
    expect(stackJs).toMatch(/const GAP = /);
    expect(stackJs).toMatch(/const EDGE = /);
    // A box that would run off the right edge flips to the LEFT of the
    // cursor rather than being clipped.
    expect(stackJs).toMatch(/anchor\.cp\.x - OFFSET - b\.w/);
    // A column that would run off the bottom flips ABOVE the cursor.
    expect(stackJs).toMatch(/anchor\.cp\.y - OFFSET - total/);
  });

  test("it handles the two coordinate systems", () => {
    // The layer probes are absolute inside the MAP CONTAINER (container
    // points); the hover card is fixed on <body> (viewport points). A
    // stacker that used one system for both would put the card a
    // container-width off from where it belongs.
    expect(stackJs).toMatch(/hostRect\.left \+ x/);
    expect(stackJs).toMatch(/hostRect\.top \+ top/);
  });

  test("it is initialised with the map, before the hover HUD", () => {
    expect(appJs).toMatch(/window\.ProbeStack\.init\(map\)/);
    // The HUD is part of the same column, so the stacker has to exist
    // first — otherwise the card's first paint lands at its own
    // coordinates and then jumps.
    const stackAt = appJs.indexOf("ProbeStack.init(map)");
    const hudAt = appJs.indexOf("HoverInfo.init(map)");
    expect(stackAt).toBeGreaterThan(-1);
    expect(hudAt).toBeGreaterThan(-1);
    expect(stackAt).toBeLessThan(hudAt);
  });

  test("the hover card hands its position to the stacker", () => {
    // The card used to place ITSELF at "cursor + 14px" — the same 14px
    // every layer probe uses — so hovering a story pin showed the card
    // ON TOP of the wind and climate readings.
    expect(hoverJs).toMatch(/window\.ProbeStack\.place\(el\)/);
  });

  test("it loads before the layer modules and is stamped", () => {
    // The `<script src=` form, not the bare file name: the comments
    // around the tags mention these files too, and a comment is not a
    // load order.
    const tag = indexHtml.indexOf('src="probe-stack.js');
    expect(tag).toBeGreaterThan(-1);
    // Before the layers that draw probe boxes.
    for (const layer of ["temp-layer.js", "wind-layer.js", "field-layer.js"]) {
      expect(indexHtml.indexOf(`src="${layer}`)).toBeGreaterThan(tag);
    }
    // And it has a cache token, or a cached browser never loads it.
    expect(indexHtml).toMatch(/probe-stack\.js\?v=\d+/);
    expect(bump).toContain("probe-stack.js");
  });
});

describe("one wind reading, not two", () => {
  const windJs = readFileSync(join(root, "wind-layer.js"), "utf8");
  const speedJs = readFileSync(join(root, "wind-speed-layer.js"), "utf8");
  const fieldJs = readFileSync(join(root, "field-layer.js"), "utf8");

  test("the wind SPEED field reads the animation's own vector", () => {
    // It used to compute the magnitude on a PRE-DERIVED grid, and
    // bilinear(u,v) then hypot is not bilinear(hypot(u,v)) — so the two
    // layers printed 2.3 m/s and 2.4 m/s for the same air on the same
    // screen.
    expect(speedJs).toMatch(/sampleValue:/);
    expect(speedJs).toMatch(/WindLayer/);
    expect(speedJs).toMatch(/sampleVector/);
    expect(windJs).toMatch(/sampleVector:/);
  });

  test("the wind SPEED field stands down when the animation speaks", () => {
    // The animation's probe already carries the speed AND the
    // direction, so a second box with the same number is how the
    // probes ended up fighting.
    expect(speedJs).toMatch(/readingGuard:/);
    expect(fieldJs).toMatch(/opts\.readingGuard/);
  });

  test("the wind SPEED field is in the hover card's sampler list", () => {
    // It was missing, so with the animation off and the speed field on,
    // "Everything" mode said nothing about the wind at all.
    expect(readFileSync(join(root, "hover-info.js"), "utf8"))
      .toMatch(/\["🌬️",\s*"WindSpeedLayer"\]/);
  });
});
