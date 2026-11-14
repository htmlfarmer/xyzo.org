/**
 * The wind overlay's styles, colour modes and the wind-SPEED field.
 *
 * The owner ask: *"they don't seem to be correct and are not very
 * visible… maybe we can select the color and type of wind animation?
 * maybe come up with some really revolutionary ideas for showing wind…
 * we also have a base map showing wind speed calculated? that we can
 * control the opacity of as well?"*
 *
 * These pin the four things that answer it:
 *   1. FOUR ways to draw the same field, and the reader can pick.
 *   2. TWO ways to colour it, plus the site's own palette picker.
 *   3. The trail is trimmed by LENGTH — the reason the old one was
 *      invisible: a fixed frame count made every calm wind a 4-pixel
 *      dot, because a slow particle moves a quarter as far a frame.
 *   4. A wind-SPEED field with its own opacity, computed from the SAME
 *      u/v grid the animation uses (one download, two layers).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const js = readFileSync(join(ROOT, "wind-layer.js"), "utf8");
const speedJs = readFileSync(join(ROOT, "wind-speed-layer.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const fieldJs = readFileSync(join(ROOT, "field-layer.js"), "utf8");
const genericJs = readFileSync(join(ROOT, "generic-layers.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const windMeta = JSON.parse(readFileSync(join(ROOT, "data", "wind", "meta.json"), "utf8"));
const windmapPy = readFileSync(join(ROOT, "..", "worker", "windmap.py"), "utf8");

// Perceived brightness of a hex colour (ITU-R BT.601).
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return -1;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe("the wind can be drawn four ways", () => {
  test("the four styles are offered and persisted", () => {
    expect(js).toMatch(/const STYLE_CHOICES = \[/);
    for (const id of ["streamlines", "flow", "particles", "arrows"]) {
      expect(js).toMatch(new RegExp(`id: "${id}"`));
    }
    expect(js).toMatch(/const STYLE_STORE_KEY = "xyzo\.windStyle"/);
    expect(js).toMatch(/storageSet\(STYLE_STORE_KEY, want\)/);
  });

  test("each style has its own renderer", () => {
    for (const fn of ["renderStreamlines", "renderFlow", "renderParticles", "renderArrows"]) {
      expect(js).toMatch(new RegExp(`function ${fn}\\(`));
    }
    // And the frame loop dispatches to them.
    const step = js.match(/function step\(now\) \{[\s\S]*?\n  \}/);
    expect(step).toBeTruthy();
    expect(step[0]).toMatch(/renderFlow\(ctx, map, dt\)/);
    expect(step[0]).toMatch(/renderParticles\(ctx, map, dt\)/);
    expect(step[0]).toMatch(/renderArrows\(ctx, map\)/);
    expect(step[0]).toMatch(/renderStreamlines\(ctx, map, dt\)/);
  });

  test("switching style CLEARS the canvas", () => {
    // The flow renderer accumulates into the canvas; the others clear it
    // every frame. A leftover fibre texture would sit under the new
    // style until the first frame erased it.
    expect(js).toMatch(/state\.style = want;[\s\S]{0,200}clearCanvas\(\);/);
  });

  test("every animated renderer strokes a DARK halo — particles was the last one filling bare", () => {
    // The owner's link pins `wind=particles:speed`, and on that link
    // (fifteen overlays on) the bare dots lit **1.47 % of the screen**
    // against 9.30 % for streamlines and 47.9 % for flow: the animation
    // ran perfectly and the reader reported that there was no wind on
    // the map at all. A bloom in the core's own colour can only make the
    // GROUND brighter around the mark, which is the one thing that
    // cannot help over a light basemap — so the ring is near-black, the
    // same trick as text with a stroke.
    for (const fn of ["renderStreamlines", "renderFlow", "renderParticles"]) {
      const body = js.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n  \\}`));
      expect(body, `${fn} not found`).toBeTruthy();
      expect(body[0], `${fn} draws no dark halo`).toMatch(/rgba\(8,12,20,/);
    }
    // …and for a FILLED mark the halo has to be drawn before the core,
    // or it paints over the dot it is supposed to outline.
    //
    // THE HALO IS A FILL SINCE 2026-11-14. The particles are painted as
    // three CONCENTRIC DISCS instead of two wide strokes and a fill,
    // because a wide round-capped stroke is the most expensive thing
    // this layer does: measured at 1,234 dots, **36.2 ms a frame**
    // against **15.3 ms** for the same picture as fills (Firefox), and
    // instrumenting the live page showed `stroke()` was 80 % of every
    // frame the wind spent inside canvas calls. So the search accepts
    // either verb — what it will not accept is NO halo, which is the
    // defect this assertion was written for.
    const particles = js.match(/function renderParticles\([\s\S]*?\n  \}/)[0];
    const halo = Math.max(particles.indexOf('strokeStyle = "rgba(8,12,20,'),
                           particles.indexOf('fillStyle = "rgba(8,12,20,'));
    const core = particles.indexOf("ctx.fillStyle = paintColor");
    expect(halo).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(-1);
    expect(halo, "the halo must be painted before the core").toBeLessThan(core);
    // The rings are CONCENTRIC: the halo disc reaches widest from the
    // particle's own radius, the bloom inside it, the core exactly to
    // it. That is the property that makes three filled discs reproduce
    // the annuli two strokes used to draw — if the radii drift apart
    // the dot grows a fat dark rim nobody designed.
    expect(particles).toMatch(/r \+ PARTICLE_HALO_R/);
    expect(particles).toMatch(/r \+ PARTICLE_BLOOM_R/);
    expect(js).toMatch(/const PARTICLE_HALO_R = PARTICLE_HALO_PX \/ 2/);
    // The dot is sized in CONTAINER pixels and named, not inlined — a
    // magic number here is how the next "you can't see it" ships.
    expect(js).toMatch(/const PARTICLE_R_MIN = /);
    expect(js).toMatch(/const PARTICLE_HALO_PX = /);
  });

  test("the arrows carry the speed in the LENGTH and the direction in the HEAD", () => {
    // The synoptic reading: an arrow is a speed-and-direction glyph, not
    // an animation. Both have to be IN the glyph.
    expect(js).toMatch(/const L = cell \* \(0\.22 \+ 0\.46 \* f\)/);
    expect(js).toMatch(/const ux = dx \/ len, uy = dy \/ len/);
    // The screen direction of a ground vector on Web Mercator is (u, -v).
    expect(js).toMatch(/const dx = u, dy = -v;/);
  });

  test("the flow renderer FADES the canvas instead of clearing it", () => {
    // The whole point of "flow": strokes accumulate into fibres over a
    // second or two. Clearing the canvas every frame would leave only
    // one frame's worth — a scatter, not a texture.
    expect(js).toMatch(/globalCompositeOperation = "destination-out"/);
    expect(js).toMatch(/FLOW_FADE/);
    // And it must NOT clear the canvas in this mode.
    const flow = js.match(/function renderFlow\([\s\S]*?\n  \}/);
    expect(flow).toBeTruthy();
    expect(flow[0]).not.toMatch(/clearRect/);
  });

  test("the flow's marks TRAVEL along the wind, not just churn", () => {
    // The first version drew fresh strokes at RANDOM positions every
    // frame: the picture dissolved and reformed faster than the eye
    // could follow it ("the flow is too fast — we can't really see the
    // details"), and the fibres never went anywhere.
    //
    // Now each mark is a STREAKLET that advances along the local wind
    // every frame and leaves a trail. Its step is PROPORTIONAL to the
    // wind, so a fast wind draws a long fast streak and a slow one a
    // short slow one.
    expect(js).toMatch(/function respawnFlow\(s, size\)/);
    expect(js).toMatch(/const step = FLOW_SEG_PX \* clamp\(sp \/ MEAN_SPEED_MS/);
    expect(js).toMatch(/s\.x = nx;/);
    expect(js).toMatch(/s\.y = ny;/);
    // And it must NOT be placing strokes at random positions any more.
    const flow = js.match(/function renderFlow\([\s\S]*?\n  \}/);
    expect(flow).toBeTruthy();
    expect(flow[0]).not.toMatch(/Math\.random\(\) \* size\.x/);
  });

  test("the flow's marks get a dark halo, a bloom and a core", () => {
    // A hairline over a busy satellite is invisible however bright its
    // colour is. The bloom is what makes a fibre read as a streak of
    // air rather than a scratch — and the HALO is what makes it read
    // over a BRIGHT one, where a bloom in the mark's own colour can
    // only brighten the ground around it (owner report: "i click on it
    // doent see anything"; AGENTS, wind rules).
    const flow = js.match(/function renderFlow\([\s\S]*?\n  \}/);
    expect(flow).toBeTruthy();
    expect(flow[0]).toMatch(/lineWidth = 4\.6/);   // dark halo
    expect(flow[0]).toMatch(/lineWidth = 4\.2/);   // bloom
    expect(flow[0]).toMatch(/lineWidth = 1\.6/);   // core
    // The halo is a DARK ink, never the ramp colour.
    expect(flow[0]).toMatch(/rgba\(8,12,20,/);
    // And the halo is drawn FIRST: a halo over the core is a smudge.
    const halo = flow[0].indexOf("rgba(8,12,20,");
    const core = flow[0].indexOf("paintColor(repSpeed, FLOW_ALPHA)");
    expect(halo).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(-1);
    expect(halo).toBeLessThan(core);
  });

  test("the streamlines carry a DARK halo, and it is drawn first", () => {
    // The default style — and the one the owner was looking at when he
    // reported he could not see anything. Over brown-green satellite
    // terrain a pale cyan hairline has nothing to separate it from,
    // and a bloom in the SAME colour as the core only brightens the
    // ground around the line, so what the streak needs is an edge
    // DARKER than the ground: a near-black halo under the light.
    const sl = js.match(/function renderStreamlines\([\s\S]*?\n  \}/);
    expect(sl).toBeTruthy();
    expect(sl[0]).toMatch(/lineWidth = 5\.4/);   // dark halo
    expect(sl[0]).toMatch(/lineWidth = 4\.8/);   // bloom
    expect(sl[0]).toMatch(/lineWidth = 1\.6/);   // core
    // The core's alpha FLOOR: the slow half of the field used to be
    // drawn at 0.52 and vanished first.
    expect(sl[0]).toMatch(
      /0\.62 \+ \(\(sb \+ 0\.5\) \/ SPEED_BUCKETS\) \* 0\.38/
    );
    const halo = sl[0].indexOf("rgba(8,12,20,");
    const bloom = sl[0].indexOf("repBase * 0.30");
    const core = sl[0].indexOf("paintColor(repSpeed, core)");
    expect(halo).toBeGreaterThan(-1);
    expect(bloom).toBeGreaterThan(halo);
    expect(core).toBeGreaterThan(bloom);
  });

  test("the flow renderer does not ask Leaflet for thousands of points", () => {
    // map.containerPointToLatLng() goes through the map's CRS every
    // time, and the flow renderer asks for thousands of them a frame.
    const flow = js.match(/function renderFlow\([\s\S]*?\n  \}/);
    expect(flow).toBeTruthy();
    expect(flow[0]).toMatch(/screenToLatLng\(/);
    expect(flow[0]).not.toMatch(/containerPointToLatLng/);
  });
});

describe("the wind can be coloured three ways", () => {
  test("the colour modes are offered and persisted", () => {
    expect(js).toMatch(/const COLOR_CHOICES = \[/);
    for (const id of ["colourful", "speed", "mono"]) {
      expect(js).toMatch(new RegExp(`id: "${id}"`));
    }
    expect(js).toMatch(/const COLOR_STORE_KEY = "xyzo\.windColor"/);
  });

  test("COLOURFUL is the default — the wind should be findable", () => {
    // The owner ask: *"i like 'colorful' wind"*. The published ramp
    // starts near-black (#0b1020 at 0 m/s), so the default was the
    // least visible option on the map.
    expect(js).toMatch(/const DEFAULT_COLOR = "colourful"/);
  });

  test("the PUBLISHED ramp is visible at its low end too", () => {
    // The owner report: *"the wind isn't always working"*.
    //
    // The wind was running and animating perfectly and the reader
    // could not see most of it: the published ramp started at #0b1020 —
    // near-black — so everything below 3.6 m/s (13 km/h) was painted in
    // a colour that vanishes against the dark satellite basemap.
    // Measured on the live map at the reader's own URL: of the wind's
    // lit pixels, **60 % were painted in that near-black end** (and
    // 91 % on a phone).
    //
    // This is the same defect the ocean currents had, and the same fix
    // (the ramp is bright at both ends). The HUE SEQUENCE and every
    // stop's m/s are unchanged — only the three darkest stops were
    // lifted, so the key still reads "blue = calm, cyan = fast".
    const ramp = windMeta.ramp;
    expect(ramp.length).toBeGreaterThan(6);
    // The calm end has to be VISIBLE: brighter than the basemap it is
    // drawn over (a dark satellite tile is around 15-30).
    expect(luminance(ramp[0].rgb)).toBeGreaterThan(60);
    expect(luminance(ramp[1].rgb)).toBeGreaterThan(60);
    // And it must not be brighter than the middle, or "calm" would
    // shout and "gale" would whisper.
    const mid = ramp[Math.floor(ramp.length / 2)];
    expect(luminance(ramp[0].rgb)).toBeLessThan(luminance(mid.rgb));
  });

  test("the published ramp IS the worker's ramp — they cannot drift", () => {
    // worker/windmap.py::RAMP_STOPS is the source of truth; the file
    // in public_html/data/wind/ is what the map, the globe, the legend
    // and the export all read. A hand-edited published file would leave
    // the next worker run silently reverting it.
    const block = windmapPy.slice(
      windmapPy.indexOf("RAMP_STOPS = ["),
      windmapPy.indexOf("]", windmapPy.indexOf("RAMP_STOPS = [")) + 1);
    const stops = [...block.matchAll(/\(\s*([\d.]+)\s*,\s*"(#[0-9a-f]{6})"\s*\)/gi)]
      .map((m) => ({ frac: Number(m[1]), rgb: m[2].toLowerCase() }));
    expect(stops.length).toBe(windMeta.ramp.length);
    for (let i = 0; i < stops.length; i++) {
      expect(windMeta.ramp[i].rgb.toLowerCase(), `stop ${i}`).toBe(stops[i].rgb);
    }
  });

  test("the colourful ramp is bright at BOTH ends", () => {    // A scheme with a dark end has the same problem as the published
    // ramp: the slow half disappears against the night ocean. So the
    // sweep starts on a bright cyan and ends on a hot yellow.
    expect(js).toMatch(/const COLORFUL_RAMP = \[/);
    const ramp = js.match(/const COLORFUL_RAMP = \[([\s\S]*?)\];/);
    expect(ramp).toBeTruthy();
    const hexes = ramp[1].match(/#[0-9a-f]{6}/gi) || [];
    expect(hexes.length).toBeGreaterThanOrEqual(5);
    const lum = (h) => {
      const r = parseInt(h.slice(1, 3), 16);
      const g = parseInt(h.slice(3, 5), 16);
      const b = parseInt(h.slice(5, 7), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Neither end may be near-black.
    expect(lum(hexes[0])).toBeGreaterThan(120);
    expect(lum(hexes[hexes.length - 1])).toBeGreaterThan(120);
  });

  test("the colourful ramp keeps the SPEED POSITIONS and only moves the colour", () => {
    // The speed is what the legend prints and the probe reads, so only
    // the colour may change.
    expect(js).toMatch(/function rampFromStops\(ramp, paletteStops\)/);
    expect(js).toMatch(/return \{ \.\.\.s, rgb: "#" \+ rgb \}/);
  });

  test("the LUT is built from the ACTIVE ramp, not from the published meta", () => {
    // REGRESSION: parseRamp() takes the STOPS, but it used to read
    // `meta.ramp` — so handing it the active ramp (an ARRAY) left the
    // LUT empty, and every wind on the map fell back to a flat grey
    // whatever the reader chose. The wind looked monochrome and nobody
    // could tell why.
    expect(js).toMatch(/function parseRamp\(rampStops\)/);
    expect(js).toMatch(/const stops = \(rampStops \|\| \[\]\)\.map/);
    expect(js).not.toMatch(/function parseRamp\(meta\)/);
    // And every call site passes the active ramp.
    const calls = js.match(/parseRamp\([^)]*\)/g) || [];
    const uses = calls.filter((c) => !/rampStops/.test(c));
    expect(uses.length).toBeGreaterThan(1);
    for (const c of uses) {
      expect(c, `parseRamp called with ${c}`).toMatch(/parseRamp\(activeRamp\(/);
    }
  });

  test("mono is ONE ink with the SPEED in its brightness", () => {
    // The published ramp starts near-black (#0b1020 at 0 m/s), so a calm
    // wind is invisible on a dark satellite AND on a bright one. A single
    // bright ink with the speed in the alpha reads over any basemap.
    expect(js).toMatch(/const MONO_INK = \[255, 255, 255\]/);
    expect(js).toMatch(/function paintColor\(speedMs, alpha\)/);
    expect(js).toMatch(/state\.colorMode === "mono"/);
    expect(js).toMatch(/0\.30 \+ 0\.70 \* f/);
  });

  test("the site's own palette picker is offered", () => {
    // The wind's ramp is a VALUE ramp (speed), so it opts into the
    // same picker every other value overlay uses.
    expect(js).toMatch(/state\.overlay\.setPalette = \(n\) => setPalette\(n\)/);
    expect(js).toMatch(/function setPalette\(name\)/);
    expect(js).toMatch(/RampStyles/);
  });

  test("picking a scheme switches the mode, so the control is not lying", () => {
    // The picker applies to the "by speed" ramp. Left on "colourful",
    // the select would say one thing and the map another — which is
    // exactly the lie the "Published" option was added to end.
    expect(js).toMatch(/if \(state\.colorMode === "colourful"\) \{[\s\S]{0,240}state\.colorMode = "speed";/);
  });

  test("the palette is DERIVED at use time, never copied into the meta", () => {
    // A stored copy of the recoloured ramp is a second source of truth,
    // and it drifts the moment the palette changes.
    expect(js).toMatch(/function activeRamp\(meta\)/);
    expect(js).not.toMatch(/state\.meta\.ramp = /);
  });

  test("the picker tells the TRUTH about what is painted", () => {
    // The picker used to claim "Rainbow" while every value overlay was
    // painting the source's own colours. "Published" is now the first
    // option, so the select says what the map is doing.
    const ramp = readFileSync(join(ROOT, "ramp-styles.js"), "utf8");
    expect(ramp).toMatch(/var RAMP_ORDER = \["published", "rainbow"/);
    expect(ramp).toMatch(/published: "Published"/);
  });
});

describe("the trail is trimmed by LENGTH, not by frame count", () => {
  test("a fixed frame count made every calm wind invisible", () => {
    // The particle's speed decides how far it moves per frame, so a
    // fixed FRAME count meant a 2 m/s wind drew a four-pixel dot: the
    // slow half of the map simply was not there.
    expect(js).toMatch(/const TRAIL_PX = \d+/);
    expect(js).toMatch(/const TRAIL_MAX = \d+/);
    expect(js).toMatch(/if \(acc >= TRAIL_PX\)/);
    // The old fixed-frame trim must be gone.
    expect(js).not.toMatch(/p\.hist\.length > TRAIL \* 2/);
  });

  test("the particle pool is dense enough to read as a field", () => {
    // One particle per 850 px² is one every 29 px: sparse enough that
    // the field read as confetti.
    expect(js).toMatch(/size\.x \* size\.y\) \/ 420/);
  });
});

describe("the wind SPEED field", () => {
  test("it is its own entry in the layers dropdown", () => {
    expect(speedJs).toMatch(/layerName: "🌬️ Wind speed \(GFS\)"/);
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.WindSpeedLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/"wind-speed": "🌬️ Wind speed \(GFS\)"/);
  });

  test("it is computed from the SAME u/v grid the animation uses", () => {
    // The speed is the magnitude of the pair, so it is derived from the
    // bytes already in the browser — one download, two layers.
    expect(speedJs).toMatch(/function deriveSpeed\(raw, meta\)/);
    expect(speedJs).toMatch(/Math\.sqrt\(u \* u \+ v \* v\)/);
    expect(js).toMatch(/async ensureRawData\(\)/);
    expect(js).toMatch(/state\.rawAll = all;/);
  });

  test("it reads the wind module's data instead of fetching it again", () => {
    expect(speedJs).toMatch(/loadData: async \(\) =>/);
    expect(speedJs).toMatch(/await W\.ensureRawData\(\)/);
    expect(fieldJs).toMatch(/opts\.loadData/);
  });

  test("it has its own opacity, and it is a WASH not a wall", () => {
    // At 100 % the field hides the basemap AND the animation that is
    // supposed to sit on top of it. The default has to leave the
    // satellite visible through it.
    const m = speedJs.match(/defaultOpacity: ([0-9.]+)/);
    expect(m, "the speed field has no default opacity").toBeTruthy();
    expect(Number(m[1])).toBeGreaterThan(0);
    expect(Number(m[1])).toBeLessThan(0.5);
  });

  test("it lives in its own pane, below the animation", () => {
    // 366 is free; the wind ANIMATION is at 370 and the pins at 400.
    expect(speedJs).toMatch(/pane: "windSpeedPane"/);
    expect(speedJs).toMatch(/paneZ: 366/);
  });

  test("the module is registered so it is initialised", () => {
    // A module that is not in the registry never gets init(map), so its
    // pane is never created and Leaflet throws when the layer is added.
    expect(genericJs).toMatch(/"WindSpeedLayer"/);
    expect(indexHtml).toMatch(/wind-speed-layer\.js\?v=\d+/);
  });
});
