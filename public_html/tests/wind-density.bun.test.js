// wind-density.bun.test.js — how MUCH wind: the density control, and
// the `wind=<style>:<colour>:<density>` grammar that shares it.
//
// Owner ask (2026-11-09): *"can we create something to control how many
// wind dots or elements we have like a slider or some way to type it in
// whatever you think is best… it might be nice to be able to control
// this and also have the URL updated so you can share exactly what you
// want"*.
//
// The three things that make this feature work, and the three ways it
// breaks:
//
//   1. THREE READERS must agree on one grammar — app.js, map-presets.js
//      and globe-wind.js. The old regex was `$`-anchored with two
//      fields, so a third field matched NOTHING and the whole segment
//      (style and colour included) was silently dropped. This suite
//      asserts the two flat readers carry the SAME regex literal, and
//      executes the globe's reader against the same inputs.
//   2. The URL must be WRITTEN whenever the wind is on — omitting it
//      hands the receiver's stored density back at the sender.
//   3. Every renderer must honour it, and the flow pool must GROW —
//      it is allocated for the default count, so >100 % would index
//      past the end of it and kill the frame.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import "../map-presets.js";

const ROOT = join(import.meta.dir, "..");
const windJs = readFileSync(join(ROOT, "wind-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const presetsJs = readFileSync(join(ROOT, "map-presets.js"), "utf8");
const globeWindJs = readFileSync(join(ROOT, "globe-wind.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

const MP = globalThis.MapPresets;

// ── the globe's reader, actually executed ──────────────────────────────
// readStyle()/readDensity() read `location.hash` and localStorage, so
// the module is loaded against stubs and each input is run through it.
// Grepping globe-wind.js for the regex would only prove the regex is
// THERE, not that it extracts the right group.
let globeWind = null;
beforeAll(() => {
  const win = {};
  const factory = new Function("window", "location", "localStorage", globeWindJs);
  factory(win, { hash: "" }, { getItem: () => null, setItem: () => {} });
  globeWind = win.XYZO_GLOBE_WIND;
});

function globeDensity(hash) {
  const stub = { hash };
  const factory = new Function("window", "location", "localStorage", globeWindJs);
  const win = {};
  factory(win, stub, { getItem: () => null, setItem: () => {} });
  return win.XYZO_GLOBE_WIND.readDensity();
}

describe("one grammar, three readers", () => {
  test("app.js and map-presets.js carry the SAME regex literal", () => {
    // The rule the repo states for `iso=`: "the grammar a preset speaks
    // is deliberately the same one a shared URL speaks". Two hand-copied
    // regexes is two regexes, and the drift between them is exactly how
    // a link opens differently in two places.
    //
    // Compared as LITERALS, not extracted: the pattern contains `/`
    // inside a character class, so no "grab the regex between slashes"
    // expression can find its own end.
    const GRAMMAR = "^wind=([^:/]+)(?::([^:/]+))?(?::([^:/]+))?$";
    expect(appJs, "app.js does not carry the three-field grammar").toContain(GRAMMAR);
    expect(presetsJs, "map-presets.js does not carry it either").toContain(GRAMMAR);
    // …and it must be the THREE-field form. Two fields was the bug: `$`
    // after the second group made a third field fail the whole match,
    // dropping style and colour along with it.
    expect(GRAMMAR.match(/\(\?::\(\[\^:\/\]\+\)\)\?/g)?.length).toBe(2);
    expect(GRAMMAR.endsWith("$")).toBe(true);
  });

  test("the legacy two-field and bare forms still parse", () => {
    // Every link written before this change has to keep opening, and
    // so does every preset hash already in the file.
    expect(MP.parseHash("#1,2,3/wind=particles:speed").wind)
      .toEqual({ style: "particles", colour: "speed" });
    expect(MP.parseHash("#1,2,3/wind=flow").wind).toEqual({ style: "flow" });
    // The presets shipped in map-presets.js must all still parse.
    for (const p of MP.PRESETS || []) {
      const w = MP.parseHash(p.hash);
      expect(w.wind, `preset ${p.id} lost its wind segment`).toBeTruthy();
      expect(typeof w.wind.style).toBe("string");
    }
  });

  test("three fields parse, and a junk density is dropped not NaN'd", () => {
    expect(MP.parseHash("#1,2,3/wind=particles:speed:250").wind)
      .toEqual({ style: "particles", colour: "speed", density: 250 });
    // A NaN density would multiply every count to NaN and draw nothing
    // at all — the layer would go silently blank.
    expect(MP.parseHash("#1,2,3/wind=particles:speed:banana").wind)
      .toEqual({ style: "particles", colour: "speed" });
    // `wind=particles:200` — colour omitted. A purely numeric second
    // field is a DENSITY, because the globe's reader already reads it
    // that way and two readers disagreeing about one link is the bug
    // the shared grammar exists to prevent.
    expect(MP.parseHash("#1,2,3/wind=particles:200").wind)
      .toEqual({ style: "particles", density: 200 });
  });

  test("an ABSENT stored density is 100, not the 25 minimum", () => {
    // Number(null) is 0, and 0 clamps to the MINIMUM — so a reader who
    // had never touched the control would have opened the globe at a
    // QUARTER of the default density, with nothing on screen saying so.
    // Measured: readDensity() returned 25 for an empty hash with no
    // stored value. Both readers must guard the absent case, and the
    // flat map's readStoredDensity has the same hazard with "".
    expect(globeDensity("")).toBe(100);
    expect(globeDensity("#1,2,3/wind=particles:speed")).toBe(100);
    // A blank stored value is the same trap on the flat map.
    const factory = new Function("window", "location", "localStorage", globeWindJs);
    const win = {};
    factory(win, { hash: "" }, { getItem: () => "", setItem: () => {} });
    expect(win.XYZO_GLOBE_WIND.readDensity()).toBe(100);
    // The flat map's guard…
    expect(windJs).toMatch(/if \(raw == null \|\| raw === ""\) return DEFAULT_DENSITY/);
    // …and the globe's, which lives in the OTHER file.
    expect(globeWindJs).toMatch(/if \(raw != null && raw !== ""\)/);
  });

  test("the globe's reader extracts the same density from the same links", () => {
    expect(globeDensity("#1,2,3/wind=particles:speed:250")).toBe(250);
    expect(globeDensity("#1,2,3/wind=particles:200")).toBe(200);
    // …and falls back rather than propagating junk or a missing field.
    expect(globeDensity("#1,2,3/wind=particles:speed")).toBe(100);
    expect(globeDensity("#1,2,3/wind=particles:speed:banana")).toBe(100);
    expect(globeDensity("")).toBe(100);
    // Out of range is CLAMPED at read time, because the globe writes it
    // straight into state with no setDensity() in between.
    expect(globeDensity("#1,2,3/wind=particles:speed:9999")).toBe(400);
    expect(globeDensity("#1,2,3/wind=particles:speed:1")).toBe(25);
  });

  test("the globe reads the reader's STORED density when no link says", () => {
    const factory = new Function("window", "location", "localStorage", globeWindJs);
    const win = {};
    factory(win, { hash: "" }, {
      getItem: (k) => (k === "xyzo.windDensity" ? "300" : null),
      setItem: () => {},
    });
    expect(win.XYZO_GLOBE_WIND.readDensity()).toBe(300);
    // …and the URL WINS over the stored value: a shared link is a view,
    // not a suggestion.
    const win2 = {};
    factory(win2, { hash: "#1,2,3/wind=particles:speed:150" }, {
      getItem: () => "300",
      setItem: () => {},
    });
    expect(win2.XYZO_GLOBE_WIND.readDensity()).toBe(150);
  });
});

describe("the URL carries it, and is written whenever the wind is on", () => {
  test("the writer emits THREE fields", () => {
    expect(appJs).toMatch(/wind = `\/wind=\$\{st\}:\$\{co\}:\$\{Math\.round\(dn\)\}`/);
    // It reads all three back off the layer rather than hardcoding, so
    // the URL can only ever describe the map that is on screen.
    expect(appJs).toMatch(/WL\.getDensity\(\)/);
  });

  test("it is written on the DEFAULT too — the iso= rule", () => {
    // Omitting at the default hands the RECEIVER's stored density back
    // at the sender: a sender on 100 % would open for a reader who had
    // once chosen 300 % at 300 %. Same link, different picture.
    // The old condition is gone, and this test is what stops it coming
    // back.
    expect(appJs).not.toMatch(/\(st && st !== defSt\) \|\| \(co && co !== defCo\)/);
    expect(appJs).toMatch(/const windOn = _activeOverlayNames\.has\(WIND_LAYER_NAME\)/);
    // …but only when the wind is actually ON: there is nothing to
    // reproduce if the layer is off.
    const writer = appJs.slice(appJs.indexOf("let wind = \"\";"),
                               appJs.indexOf("let wind = \"\";") + 900);
    expect(writer).toMatch(/if \(windOn && WL/);
  });

  test("a change announces itself, so the address bar keeps up", () => {
    // The share button copies location.href VERBATIM. Without this,
    // changing the density and pressing Share without panning first
    // hands over the PREVIOUS density — which is the whole point of
    // asking for the URL to be updated.
    expect(windJs).toMatch(/xyzo:wind-style/);
    expect(appJs).toMatch(/addEventListener\("xyzo:wind-style"/);
    expect(appJs).toMatch(/try \{ updateUrlHash\(\); \} catch/);
    // All three setters announce: they are one segment, and a hash
    // carrying two of the three is a hash that lies.
    for (const fn of ["setStyle", "setColorMode", "setDensity"]) {
      const at = windJs.indexOf(`function ${fn}(`);
      expect(at, `${fn} not found`).toBeGreaterThan(-1);
      const body = windJs.slice(at, at + 900);
      expect(body, `${fn} does not announce itself`).toMatch(/notifyWindChanged\(\)/);
    }
  });

  test("a link's density is applied but does not overwrite the reader's", () => {
    // "A LINK IS A VIEW, NOT A SETTINGS CHANGE" — setDensity persists,
    // so _restoreMapView must snapshot and restore it, exactly as it
    // already does for the style and colour.
    expect(appJs).toMatch(/window\.WindLayer\.setDensity\(parsed\.wind\.density\)/);
    expect(appJs).toMatch(/_prefSnapshot/);
    expect(appJs).toMatch(/parsed\.wind\.style && typeof window\.WindLayer\.setStyle/);
  });
});

describe("every renderer honours the density", () => {
  test("particles: the automatic count is scaled, and its FLOOR with it", () => {
    const at = windJs.indexOf("function ensureParticles(");
    const body = windJs.slice(at, at + 1400);
    expect(body).toMatch(/state\.density \/ 100/);
    // The floor has to scale too. Left at a flat 400, 25 % on a small
    // screen would compute below it and be rounded straight back up —
    // the slider would do nothing at the bottom of its range, which is
    // the one place a reader goes to check the control works.
    expect(body).toMatch(/Math\.round\(400 \* state\.density \/ 100\)/);
    // …and 100 % must be byte-for-byte the count this always produced.
    expect(body).toMatch(/clamp\(\(size\.x \* size\.y\) \/ 420, 900, 8000\) \* state\.qscale/);
  });

  test("flow: the pool GROWS, or >100 % indexes past its end", () => {
    // FLOW_STREAKLETS entries are allocated once, for the DEFAULT
    // count. At 200 % the loop asks for twice that and reads
    // `state.flowPool[i].age` on undefined — the frame throws and the
    // animation stops dead. This is the crash the growth prevents.
    const at = windJs.indexOf("function renderFlow(");
    const body = windJs.slice(at, at + 2600);
    expect(body).toMatch(/state\.flowPool\.length < n/);
    expect(body).toMatch(/while \(state\.flowPool\.length < n\)/);
    expect(body).toMatch(/FLOW_STREAKLETS \* state\.qscale \* state\.density \/ 100/);
    // The pool's own pre-fill stays at the DEFAULT size — growing it
    // up front would cost 4x the memory for readers at 100 %.
    expect(body).toMatch(/for \(let i = 0; i < FLOW_STREAKLETS; i\+\+\)/);
  });

  test("arrows: cell size uses the SQUARE ROOT, and the key carries it", () => {
    // Arrows are a GRID, so the count goes as 1/cell². Taking density
    // at face value would make "200 %" draw FOUR times as many arrows
    // where the particle styles draw twice as many — the same slider
    // meaning two different things depending on the style selected.
    const at = windJs.indexOf("function renderArrows(");
    const body = windJs.slice(at, at + 1200);
    expect(body).toMatch(/ARROW_MIN_PX \/ Math\.sqrt\(state\.density \/ 100\)/);
    // The redraw key must include density, or a density change with no
    // view change would leave the OLD grid on screen — the slider would
    // appear to do nothing in arrows style specifically.
    expect(body).toMatch(/":" \+ state\.density/);
  });

  test("the globe scales PARTICLE_COUNT and can shrink as well as grow", () => {
    const at = globeWindJs.indexOf("function ensureParticles(");
    const body = globeWindJs.slice(at, at + 700);
    expect(body).toMatch(/PARTICLE_COUNT \* state\.density \/ 100/);
    // The globe's loop only ever GREW, so dropping the density left the
    // extra particles running for the rest of the session.
    expect(body).toMatch(/state\.particles\.length > want/);
    expect(body).toMatch(/state\.particles\.pop\(\)/);
    // Only the WIND reads the density: the currents are a different
    // overlay with their own default, and one segment must not drive
    // two overlays.
    expect(globeWindJs).toMatch(
      /density: sourceName === "wind" \? readDensity\(\) : 100/);
  });

  test("the globe's setDensity is exported and retunes immediately", () => {
    expect(globeWindJs).toMatch(/setDensity: setDensity/);
    expect(globeWindJs).toMatch(/getDensity: \(\) => state\.density/);
    // Clamped to the flat map's bounds, so the two views cannot
    // disagree about what one link is asking for.
    const at = globeWindJs.indexOf("function setDensity(");
    const body = globeWindJs.slice(at, at + 500);
    expect(body).toMatch(/Math\.min\(400, Math\.max\(25, n\)\)/);
    expect(body).toMatch(/ensureParticles\(\)/);
  });
});

describe("the control itself", () => {
  test("a slider AND a number box, both driving ONE writer", () => {
    // "a slider or some way to type it in whatever you think is best" —
    // both, because they answer two different questions: drag to find a
    // look, type to set one. One writer (setDensity) is what stops the
    // two disagreeing.
    expect(windJs).toMatch(/id="wind-density"/);
    expect(windJs).toMatch(/id="wind-density-num"/);
    expect(windJs).toMatch(/densSlider\.addEventListener\("input"/);
    expect(windJs).toMatch(/densNum\.addEventListener\("change"/);
    // Matched FROM the `type=` attribute, because `type` precedes the
    // id in the markup — a window starting at the id looks forward and
    // never sees it.
    const slider = windJs.match(/<input type="range" id="wind-density"[\s\S]{0,240}/)[0];
    const num = windJs.match(/<input type="number" id="wind-density-num"[\s\S]{0,240}/)[0];
    expect(slider).toMatch(/type="range"/);
    expect(num).toMatch(/type="number"/);
    // BOTH must be wired to setDensity — a control wired to nothing is
    // the "a button that is in the legend must do something" trap.
    const sliderHandler = windJs.match(/densSlider\.addEventListener\("input", \(\) => \{[^}]*\}/)[0];
    const numHandler = windJs.match(/densNum\.addEventListener\("change", \(\) => \{[\s\S]*?\n        \}\);/)[0];
    expect(sliderHandler).toMatch(/setDensity\(/);
    expect(numHandler).toMatch(/setDensity\(/);
  });

  test("STEP IS 1 ON BOTH — a step of 5 makes the two controls disagree", () => {
    // A range input SNAPS its value to the nearest step when it is set
    // programmatically. With step 5, typing 27 sets state.density to 27
    // and then paintChoiceRows() writes "27" back into a slider that
    // rounds it to 25 — two controls showing different values for one
    // setting, which is the exact thing having both is supposed to
    // prevent.
    const slider = windJs.match(/<input type="range" id="wind-density"[\s\S]{0,240}/)[0];
    const num = windJs.match(/<input type="number" id="wind-density-num"[\s\S]{0,240}/)[0];
    expect(slider).toMatch(/step="1"/);
    expect(num).toMatch(/step="1"/);
    expect(slider).not.toMatch(/step="5"/);
    expect(num).not.toMatch(/step="5"/);
  });

  test("the bounds come from the layer, not from retyped literals", () => {
    // One source of truth: a slider whose min/max is typed into the
    // markup drifts from the clamp in setDensity() the moment either
    // moves, and the reader gets a slider that cannot reach the value
    // the layer will accept.
    expect(windJs).toMatch(/const DENSITY_MIN = 25/);
    expect(windJs).toMatch(/const DENSITY_MAX = 400/);
    expect(windJs).toMatch(/const DEFAULT_DENSITY = 100/);
    expect(windJs).toMatch(/'min="' \+ DENSITY_MIN \+ '" max="' \+ DENSITY_MAX/);
    expect(windJs).toMatch(/DEFAULT_DENSITY,\s*\n\s*DENSITY_MIN,\s*\n\s*DENSITY_MAX,/);
  });

  test("setDensity clamps, persists, repaints and announces", () => {
    const at = windJs.indexOf("function setDensity(");
    const body = windJs.slice(at, at + 900);
    expect(body).toMatch(/Number\(pct\)/);
    expect(body).toMatch(/Number\.isFinite/);        // NaN never reaches the counts
    expect(body).toMatch(/clamp\(n, DENSITY_MIN, DENSITY_MAX\)/);
    expect(body).toMatch(/storageSet\(DENSITY_STORE_KEY/);
    expect(body).toMatch(/ensureParticles\(\)/);      // particles/streamlines
    expect(body).toMatch(/state\.arrowsDirty = true/); // arrows
    expect(body).toMatch(/paintChoiceRows\(\)/);       // the slider's own value
    expect(body).toMatch(/notifyWindChanged\(\)/);     // the URL
    // Exported with its bounds, so the URL grammar and the slider's
    // limits come from the layer rather than being retyped in app.js.
    expect(windJs).toMatch(/setDensity,\s*\n\s*getDensity,/);
    expect(windJs).toMatch(/DEFAULT_DENSITY,/);
  });

  test("a corrupt stored density falls back instead of blanking the map", () => {
    // Number("banana") is NaN, and NaN * any count is NaN — the layer
    // would spawn nothing and draw nothing with no error to explain it.
    const at = windJs.indexOf("function readStoredDensity(");
    const body = windJs.slice(at, at + 500);
    expect(body).toMatch(/Number\.isFinite\(n\)/);
    expect(body).toMatch(/return DEFAULT_DENSITY/);
    expect(body).toMatch(/clamp\(Math\.round\(n\), DENSITY_MIN, DENSITY_MAX\)/);
  });

  test("the readout shows the REAL count for the current style", () => {
    // The owner asked "how many wind dots" — so the row says how many.
    // It reads the layer's own state rather than recomputing the
    // formula, so it can never claim more marks than the map draws.
    expect(windJs).toMatch(/function paintDensityReadout\(\)/);
    expect(windJs).toMatch(/state\.particles\.length/);
    expect(windJs).toMatch(/FLOW_STREAKLETS \* state\.qscale \* pct \/ 100/);
    // …and it names the unit, because "1,200" is not an answer.
    expect(windJs).toMatch(/"arrows"/);
    expect(windJs).toMatch(/"streaks"/);
    expect(windJs).toMatch(/"dots"/);
    // Refreshed from ensureParticles(), which is what runs on resize and
    // on the FPS guard — otherwise the count goes stale the moment the
    // window changes shape.
    const ep = windJs.slice(windJs.indexOf("function ensureParticles("),
                            windJs.indexOf("function ensureParticles(") + 1400);
    expect(ep).toMatch(/paintDensityReadout\(\)/);
  });

  test("the readout DEGRADES — it can never kill the animation", () => {
    // It is called from ensureParticles(), which is on the path that
    // SPAWNS the field. The first version threw on a document with no
    // getElementById, ensureParticles() unwound, and the layer shipped
    // with zero particles and a dead probe. A cosmetic readout must not
    // be able to take the animation down with it.
    for (const fn of ["paintDensityReadout", "paintChoiceRows"]) {
      const at = windJs.indexOf(`function ${fn}(`);
      expect(at, `${fn} not found`).toBeGreaterThan(-1);
      // The window has to clear the function's own comment — the
      // explanation of WHY it is guarded is longer than the guard.
      const head = windJs.slice(at, at + 900);
      expect(head, `${fn} is not guarded`).toMatch(/typeof document === "undefined"/);
      expect(head, `${fn} is not guarded`).toMatch(/typeof document\.getElementById !== "function"/);
    }
  });

  test("the two controls are always written together — no focus guard", () => {
    // A focus guard here protected a path that does not exist (the box
    // commits on `change`, never on `input`) and CAUSED two bugs found
    // by driving the live control: typing 250 then dragging the slider
    // left the box at 250 while the slider said 400, and clearing the
    // box left it EMPTY while 400 was still in effect — because the
    // empty-value branch returns through this function, which then
    // refused to write. Two controls disagreeing about one value is
    // the exact thing having both is supposed to prevent.
    const at = windJs.indexOf("function paintChoiceRows(");
    expect(at).toBeGreaterThan(-1);
    // Slice to the END OF THE FUNCTION, not a fixed width: the
    // comment explaining why the guard is gone is longer than the code
    // it describes, so a fixed window either cuts the writes off or
    // runs into the next function and asserts about that instead.
    const end = windJs.indexOf("\n  }", at);
    expect(end).toBeGreaterThan(at);
    const body = windJs.slice(at, end);
    expect(body).toMatch(/if \(densSlider\) densSlider\.value = String\(state\.density\)/);
    expect(body).toMatch(/if \(densNum\) densNum\.value = String\(state\.density\)/);
    expect(body, "a focus guard is back, and with it the staleness bugs")
      .not.toMatch(/document\.activeElement/);
  });

  test("the number box normalises on commit, even when nothing changed", () => {
    // setDensity() early-returns when the clamped value equals the
    // current one, and paintChoiceRows() deliberately skips a FOCUSED
    // box — so typing 999 while already at 400 would leave "999" on
    // screen. Neither path normalises; the commit handler must.
    const at = windJs.indexOf('densNum.addEventListener("change"');
    const body = windJs.slice(at, at + 1600);
    expect(body).toMatch(/densNum\.value = String\(state\.density\)/);
    expect(body).toMatch(/densSlider\.value = String\(state\.density\)/);
    // …and an EMPTY box must not become 0 -> clamped to the 25 minimum.
    expect(body).toMatch(/densNum\.value\)\.trim\(\) === ""/);
  });

  test("the density row is styled, and reaches 44 px on touch", () => {
    // It sits in the layers dropdown, which a phone user opens with a
    // thumb. A default range thumb is 12–16 px — far under the floor.
    expect(stylesCss).toMatch(/\.wind-density-row/);
    expect(stylesCss).toMatch(/\.wind-density-slider/);
    expect(stylesCss).toMatch(/\.wind-density-num/);
    expect(stylesCss).toMatch(/\.wind-density-count/);
    const coarse = stylesCss.slice(stylesCss.indexOf("@media (pointer: coarse)"),
                                  stylesCss.indexOf("@media (pointer: coarse)") + 400);
    expect(coarse).toMatch(/\.wind-density-slider/);
    expect(coarse).toMatch(/height: 44px/);
    // iOS zooms the page when an input's font is below 16 px.
    expect(coarse).toMatch(/font-size: 16px/);
  });

  test("the saved style carries the density too", () => {
    // A curated wind map is not the same map at a different density —
    // the same argument that put style and colour in the preset hash.
    const at = presetsJs.indexOf("if (state.wind && typeof state.wind === \"object\")");
    const body = presetsJs.slice(at, at + 700);
    expect(body).toMatch(/Number\.isFinite\(state\.wind\.density\)/);
    expect(body).toMatch(/if \(w\.style \|\| w\.colour \|\| w\.density != null\) out\.wind = w/);
    // …and it is replayed through the same path a shared URL uses.
    expect(appJs).toMatch(/wind: style\.wind \|\| undefined/);
  });
});
