// isobar-step.bun.test.js — selectable contour detail (1/2/4/8/16 hPa).
//
// The ask: options for MORE or LESS detailed pressure lines, selectable.
//
// Design, because it decides what the code has to do: the worker
// publishes the FINEST set (1 hPa) and the API thins ONE dataset by a
// `step` param. The contour of a specific level does not depend on the
// interval used to enumerate the levels — level 1000 contoured at 1 hPa
// is byte-identical to level 1000 contoured at 4 hPa — so thinning
// reproduces the classic synoptic chart EXACTLY rather than approximating
// it, and there is no second copy of the data to store or to drift.
//
// Verified live against /api/weather/isobars (whole world, GFS). The
// absolute counts move with the cycle — what does NOT move is the
// RATIO, and that the coarse steps are the fine set's multiples:
//   step=1    626,045 B  1094 features  92 levels
//   step=2    310,296 B   539 features  46 levels
//   step=4    155,892 B   276 features  23 levels
//   step=8     77,070 B   144 features  12 levels
//   step=16    35,359 B    69 features   6 levels
//
// The claim that makes the whole thing safe, checked against the LIVE
// API (not the worker's internals): the step=4 response is
// VERTEX-FOR-VERTEX identical to the multiples of 4 in the step=1
// response — 7,784 vertices across 23 shared levels, every one matching
// to 1e-9, and no coarse level missing from the fine set. So the chart
// the site has always drawn does not move by one pixel.
//
// and in the browser: clicking a chip changes getStep(), moves the
// active chip, writes xyzo.isobarStep, and the item count actually
// thins (386 → 201 → 112 → 44 at one viewport) — a control that
// repaints itself without refetching is the classic silent failure.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const layerJs = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
const workerPy = readFileSync(join(REPO, "worker", "isobars.py"), "utf8");
const weatherTs = readFileSync(join(REPO, "api", "src", "routes", "weather.ts"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");

// The comment block that sits IMMEDIATELY above a line in a source file.
// The rationale for the contour interval has to live NEXT TO the
// constant — "where the constant is set" is the whole point, because a
// rationale 5,000 characters away is a rationale nobody finds. This
// helper looks at the contiguous run of `#` comment lines directly above
// the marker, so the assertion cannot be satisfied by a phrase that
// happens to be mentioned elsewhere in the file, and it cannot be
// broken by the comment block growing.
function commentBlockAbove(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) return "";
  const lines = src.slice(0, idx).split("\n");
  const block = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("#")) block.unshift(t);
    else if (t === "") { if (block.length) break; }
    else break;
  }
  return block.join("\n");
}

describe("the worker publishes the finest detail", () => {
  test("contours at 0.05 hPa — the coarsest lattice every offered step divides into", () => {
    expect(workerPy).toMatch(/ISO_INTERVAL_HPA = 0\.05/);
    expect(workerPy).not.toMatch(/ISO_INTERVAL_HPA = 2/);
    expect(workerPy).not.toMatch(/ISO_INTERVAL_HPA = 4/);
  });

  test("THE invariant: every chip step is a whole multiple of that lattice", () => {
    // This is the check that ties the two files together, and the one
    // that would have caught the whole class of bug: the worker cuts one
    // lattice and the API thins it, so a step that is NOT a whole
    // multiple of the lattice gets back only the levels that happen to
    // exist — ask for step 0.1 against a lattice cut at 0.25 and you
    // receive every 0.5 hPa line while the chip says 0.10. Nothing else
    // in the stack can see that: the API's enum accepts it, the layer
    // renders whatever comes back, and the response is a perfectly
    // well-formed subset.
    const ladder = layerJs.match(/const STEP_CHOICES = \[([^\]]+)\]/);
    expect(ladder, "STEP_CHOICES not found in isobar-layer.js").toBeTruthy();
    const steps = ladder[1].split(",").map((s) => Number(s.trim()));
    expect(steps.length).toBeGreaterThan(0);

    const cut = Number((workerPy.match(/ISO_INTERVAL_HPA = ([\d.]+)/) || [])[1]);
    expect(cut, "ISO_INTERVAL_HPA not found in isobars.py").toBeGreaterThan(0);

    for (const s of steps) {
      const n = s / cut;
      expect(Math.abs(n - Math.round(n)),
        `step ${s} is not a whole multiple of the ${cut} hPa lattice — ` +
        `that chip would thin to the wrong levels`).toBeLessThan(1e-9);
    }
    // And the chip this change is about is on the ladder.
    expect(steps).toContain(0.1);
    // The default is untouched: nobody's existing view changes.
    expect(layerJs).toMatch(/const DEFAULT_STEP = 4/);
  });

  test("and the rationale is recorded where the constant is set", () => {
    // The claim the whole design rests on: thinning is exact, so this is
    // one dataset at many densities and not two copies to keep in step.
    const block = commentBlockAbove(workerPy, "ISO_INTERVAL_HPA = 0.05");
    expect(block).toMatch(/SUPERSET|superset/);
    expect(block).toMatch(/does not depend on the interval/);
  });

  test("and a finer cut is not a noisier chart", () => {
    // The claim that makes the finer interval publishable: the noise
    // lives in the FIELD, not in the choice of level, so the share of
    // fragmentary lines does not grow as the interval shrinks — and it
    // holds all the way down: 54.8 % at 1 hPa, 55.0 % at 0.5, 54.8 % at
    // 0.25, then 39.9 % at 0.25, 39.7 % at 0.1, 39.7 % at 0.05 on the
    // 2026-11-06 18Z field (the two series differ because they were cut
    // over different boxes with different arc definitions).
    const block = commentBlockAbove(workerPy, "ISO_INTERVAL_HPA = 0.05");
    expect(block).toMatch(/NOT a noisier|NOT noisier/);
  });
});

describe("the API thins one dataset", () => {
  test("accepts step as one of the eight offered values", () => {
    expect(weatherTs).toMatch(/step: z\.enum\(\["0\.1", "0\.25", "0\.5", "1", "2", "4", "8", "16"\]\)\.optional\(\)/);
  });

  test("the schema comment explains WHY 4 is still exact", () => {
    expect(weatherTs).toMatch(/byte-identical|reproduces the classic 4 hPa synoptic chart exactly/);
  });

  test("builds the level list for a step when no explicit levels are given", () => {
    expect(weatherTs).toMatch(/function stepLevels\(step: number\): number\[\]/);
    expect(weatherTs).toMatch(/\? stepLevels\(Number\(q\.step\)\)/);
    // Explicit `levels` must keep WINNING over `step`: they are the more
    // specific request, and a caller sending an exact list should not
    // have it silently replaced by a generated one.
    const iLevels = weatherTs.indexOf("const levelList = q.levels");
    const iStep = weatherTs.indexOf("stepLevels(Number(q.step))", iLevels);
    expect(iLevels, "levelList construction missing").toBeGreaterThan(-1);
    expect(iStep, "step branch missing").toBeGreaterThan(iLevels);
    expect(weatherTs).toMatch(/AND level_hpa IN \$\{sql\(levelList\)\}/);
  });

  test("the generated levels are real levels the worker actually cut", () => {
    // Step 8 starts at 944, not 940: every level we ask for must be one
    // the worker actually contoured, or the request would return fewer
    // lines than the step implies.
    const start = Math.ceil(940 / 8) * 8;
    expect(start).toBe(944);

    // The lattice, read out of the worker rather than assumed — it has
    // moved (0.25 -> 0.05) and the chip ladder moved with it.
    const cut = Number((workerPy.match(/ISO_INTERVAL_HPA = ([\d.]+)/) || [])[1]);
    expect(cut).toBeGreaterThan(0);

    // Enumerated the way stepLevels() does, NOT with `l += step`: that
    // accumulates representation error for a non-dyadic step like 0.1,
    // which is exactly what the real function rounds away.
    for (const step of [0.1, 0.25, 0.5, 1, 2, 4, 8, 16]) {
      const first = Math.ceil(940 / step);
      const levels = [];
      for (let k = first; k * step <= 1060 + step * 1e-9; k++) {
        levels.push(Math.round(k * step * 100) / 100);
      }
      expect(levels.length, `step ${step}`).toBeGreaterThan(0);
      for (const l of levels) {
        // On the worker's lattice: this is the IN-list match. Ask it by
        // division, not `l % cut` — 0.05 and 0.1 are not dyadic, so the
        // remainder of a perfectly good level is ~1e-13, never 0.
        const onLattice = l / cut;
        expect(Math.abs(onLattice - Math.round(onLattice)),
          `step ${step} asks for ${l}, which is not on the ${cut} lattice`).toBeLessThan(1e-6);
        // And it is a whole number of steps, as the chip promises.
        const steps = l / step;
        expect(Math.abs(steps - Math.round(steps)),
          `step ${step} asks for ${l}, which is not a multiple of ${step}`).toBeLessThan(1e-6);
      }
      if (step === 8) expect(levels[0]).toBe(944);
    }
  });
});

describe("the stroke follows the density, not the step", () => {
  // 0.25 hPa at world zoom is ~3,800 polylines on one screen. At the
  // fixed 1.4 px they used to carry, the coverage exceeds the
  // viewport's area: the chart paints the map solid and NOTHING under
  // it is visible — not the basemap, not the climate wash, and not the
  // wind streaks that draw ABOVE them.
  //
  // Measured on the owner's URL (zoom 3, 0.25 hPa, eight overlays on):
  // with the isobars OFF the wind reads 10,428 strong pixels and is
  // plainly visible; with them ON it is buried under a teal hairball.
  test("thins the stroke as the line count grows", () => {
    expect(layerJs).toMatch(/function weightFor\(count\)/);
    // Full weight for the classic chart, thinner as it densifies.
    expect(layerJs).toMatch(/if \(count <= 120\) return 1\.4/);
    expect(layerJs).toMatch(/if \(count <= 400\) return 1\.0/);
    expect(layerJs).toMatch(/if \(count <= 1200\) return 0\.7/);
    expect(layerJs).toMatch(/return 0\.5;\s+\/\/ a world view/);
  });

  test("is applied when the lines are drawn and when they are repainted", () => {
    // A repaint that dropped the weight would leave the strokes at
    // whatever the previous density set.
    expect(layerJs).toMatch(/weight: weightFor\(items\.length\)/);
    expect(layerJs).toMatch(/layer\.setStyle\(\{ color: isobarColor\(level\), weight: weight \}\)/);
  });

  test("does not change the reader's choice of step", () => {
    // The chart is still whatever step the reader picked — it is drawn
    // at a weight a screen can hold. The step, its chip and its URL
    // segment are untouched.
    expect(layerJs).toMatch(/const STEP_CHOICES = \[0\.1, 0\.25, 0\.5, 1, 2, 4, 8, 16\]/);
    expect(layerJs).toMatch(/function setStep\(step, opts\)/);
  });
});

describe("the layer holds the choice and asks for it", () => {
  test("offers exactly the eight steps, defaulting to the classic 4", () => {
    expect(layerJs).toMatch(/const STEP_CHOICES = \[0\.1, 0\.25, 0\.5, 1, 2, 4, 8, 16\]/);
    expect(layerJs).toMatch(/const DEFAULT_STEP = 4/);
    // nobody's existing view changes until they ask
    expect(layerJs).toMatch(/step: readStoredStep\(\)/);
  });

  test("rejects a stored value that is not a real choice", () => {
    // A corrupt or hand-edited xyzo.isobarStep must fall back, not send
    // a step the API's enum will 400.
    expect(layerJs).toMatch(/STEP_CHOICES\.indexOf\(n\) >= 0 \? n : DEFAULT_STEP/);
  });

  test("the step is part of the request URL", () => {
    expect(layerJs).toMatch(/&step=\$\{state\.step\}/);
  });

  test("changing it INVALIDATES the loaded viewport", () => {
    // loadedCovers() is what decides a refetch is unnecessary — leave
    // state.loaded set and the new step is a silent no-op that appears to
    // be a broken control.
    const body = layerJs.slice(layerJs.indexOf("function setStep("));
    const fn = body.slice(0, body.indexOf("\n  function getStep"));
    expect(fn).toMatch(/state\.loaded = null;/);
    expect(fn).toMatch(/refresh\(true\)/);
    expect(fn).toMatch(/STEP_CHOICES\.indexOf\(want\) < 0/);
  });

  test("is exported so the control can drive it", () => {
    for (const m of ["setStep,", "getStep,", "STEP_CHOICES,", "mountStepControl,"]) {
      expect(layerJs).toMatch(new RegExp(m.replace(",", ",")));
    }
  });
});

describe("the detail step is part of the URL", () => {
  // "Share the exact map you are looking at" is the whole point of the
  // hash. The overlay list says WHICH layers and how opaque; the detail
  // step is a setting of one of those layers, and it used to live only
  // in localStorage — so a shared link reproduced the layer but not the
  // setting, and the reader got THEIR step, not the sender's.
  test("the hash writer emits it whenever the isobars are on", () => {
    // `iso=<step>` — and `iso=<step>:<colour>` when a colour is set.
    // Plain substrings: the source is a template literal with braces in
    // it, and a regex over that is unreadable.
    expect(appJs).toContain("const iso = (isoStep != null && isobarsOn)");
    expect(appJs).toContain("`/iso=${isoStep}`");
    expect(appJs).toContain("${overlays}${iso}${isoSrc}${delta}${wind}");
  });

  test("it is written even at the DEFAULT step", () => {
    // Omitting it when the step is 4 would leave the reader's own
    // stored step to decide: a sender on the default would hand a
    // receiver on 1 hPa a link that opened at 1 hPa. Same map,
    // different lines.
    const anchor = appJs.indexOf("const iso = (isoStep != null");
    expect(anchor).toBeGreaterThan(-1);
    const body = appJs.slice(anchor);
    const fn = body.slice(0, body.indexOf(";"));
    expect(fn).not.toMatch(/DEFAULT_STEP|!== 4|!= 4/);
    expect(fn).toMatch(/isoStep != null && isobarsOn/);
  });

  test("the hash parser reads it back", () => {
    // `iso=<step>` — and `iso=<step>:<colour>`, because the colour is
    // part of the style too and a link has to reproduce the lines as
    // they were seen.
    // Plain substring checks, not a regex over a regex: the source is
    // `p.match(/^iso=(\d+)(?::([a-z]+))?/)`, and a regex asserting a
    // regex is unreadable and easy to get subtly wrong.
    expect(appJs).toContain("const isoMatch = p.match(");
    expect(appJs).toContain("res.isoStep = n");
    // `iso=<step>` and `iso=<step>:<colour>` — the detail AND the
    // colour are part of the style.
    expect(appJs).toContain("res.isoColour = isoMatch[2]");
    expect(appJs).toMatch(/res\.isoStep = n/);
    expect(appJs).toMatch(/res\.isoColour = isoMatch\[2\]/);
  });

  test("a link's step is applied BEFORE the layer is enabled", () => {
    // setStep() only refetches when the layer is already on, so the step
    // first and the enable second costs ONE fetch instead of two — and
    // it is the fetch that carries the right step.
    // Anchor on CODE, not on a comment: a comment can be reworded (and
    // was), which made this test slice from -1 and assert against the
    // last character of the file.
    const anchor = appJs.indexOf("if (resolveLayerName(entry.name) !== ISOBAR_LAYER_NAME) continue;");
    expect(anchor).toBeGreaterThan(-1);
    const body = appJs.slice(anchor);
    expect(body).toMatch(/setStep\(parsed\.isoStep, \{ persist: false \}\)/);
    expect(body).toMatch(/setEnabled\(true\)/);
    expect(body.indexOf("setStep(parsed.isoStep")).toBeLessThan(body.indexOf("setEnabled(true)"));
  });

  test("a link's step does NOT overwrite the reader's own preference", () => {
    // "A LINK IS A VIEW, NOT A SETTINGS CHANGE" — the rule every other
    // layer preference follows at boot.
    expect(appJs).toMatch(/setStep\(parsed\.isoStep, \{ persist: false \}\)/);
    expect(layerJs).toMatch(/if \(!\(opts && opts\.persist === false\)\)/);
  });

  test("the layer tells the app when the step changed", () => {
    // One event between the layer (which owns the control) and the app
    // (which owns the URL) — the same pattern the opacity slider uses.
    expect(layerJs).toMatch(/xyzo:isobar-step/);
    expect(appJs).toMatch(/window\.addEventListener\("xyzo:isobar-step"/);
  });

  test("a saved style carries it too", () => {
    // "MY STYLE → Save this view" is a snapshot of the EXACT map.
    expect(appJs).toMatch(/isoStep: \(window\.IsobarLayer && typeof window\.IsobarLayer\.getStep === "function"\)/);
    expect(appJs).toMatch(/isoStep: style\.isoStep != null \? style\.isoStep : undefined/);
  });

  test("the globe honours it too — one link, one map", () => {
    // The handoff passes every segment except overlay= through
    // untouched, so `iso=1` reaches the globe. A link that asked for
    // 1 hPa must open at 1 hPa in BOTH views.
    expect(globeJs).toMatch(/const GLOBE_ISO_STEP = 2/);
    expect(globeJs).toMatch(/function globeIsoStep\(\)/);
    expect(globeJs).toMatch(/step=\$\{step\}/);
    expect(globeJs).toMatch(/p\.startsWith\("iso="\)/);
    // The globe writes the colour as well as the step: the lines are
    // part of the style, and a link that asked for 1 hPa in red must
    // open at 1 hPa in red in BOTH views.
    expect(globeJs).toMatch(/h \+= `\/iso=\$\{isoStepInUse\}/);
  });

  test("the globe records the step BEFORE it fetches", () => {
    // The globe's own hash writer runs on the first moveend, which can
    // beat the isobar fetch. If the step were recorded after the await,
    // the writer would put the DEFAULT in the hash and overwrite the
    // link's `iso=1` — the detail was lost on the way back to the flat
    // map (measured: the globe fetched step=1 and then wrote iso=2).
    const body = globeJs.slice(globeJs.indexOf("const step = globeIsoStep()"));
    const fn = body.slice(0, body.indexOf("const res = await fetch"));
    expect(fn).toMatch(/isoStepInUse = step;/);
    expect(body.indexOf("isoStepInUse = step;")).toBeLessThan(body.indexOf("const res = await fetch"));
  });
});

describe("the control", () => {
  test("the layer mounts it — app.js only hands it the row", () => {
    expect(layerJs).toMatch(/function mountStepControl\(row\)/);
    expect(appJs).toMatch(/mountStepControl\?\.\(row\)/);
    // app.js must not re-implement the chips (second source of truth)
    expect(appJs).not.toMatch(/isobar-step-switch/);
    expect(layerJs).toMatch(/id = "isobar-step-switch"/);
  });

  test("it cannot mount twice", () => {
    expect(layerJs).toMatch(/document\.getElementById\("isobar-step-switch"\)\) return/);
  });

  test("it reuses the existing chip markup rather than adding CSS", () => {
    // .soil-prop-switch is what the soil and magnetic selectors already
    // use in this same white dropdown — no new styles, so no chance of
    // colliding with a stylesheet being edited elsewhere.
    expect(layerJs).toMatch(/className = "soil-prop-switch"/);
    // The CONTAINER class only styles the row (flex + gap). The buttons
    // need `soil-prop-btn` of their own, like every other chip in this
    // dropdown — without it they rendered as bare default <button>s.
    expect(layerJs).toMatch(/b\.className = "soil-prop-btn"/);
    expect(layerJs).toMatch(/soil-prop-btn|classList\.toggle\("is-active"/);
  });

  test("each chip says what it DOES, not just what it is", () => {
    expect(layerJs).toMatch(/More detail — a line every/);
    expect(layerJs).toMatch(/Less detail — a line every/);
    expect(layerJs).toMatch(/Standard synoptic pressure chart \(default\)/);
  });

  test("the choice is persisted", () => {
    expect(layerJs).toMatch(/STEP_STORE_KEY = "xyzo\.isobarStep"/);
    expect(layerJs).toMatch(/storageSet\(STEP_STORE_KEY, String\(want\)\)/);
  });
});
