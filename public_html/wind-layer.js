/* Wind overlay — animated streamlines over the basemap.
 *
 *     /data/wind/meta.json   grid layout, speed ramp, analysis run time
 *     /data/wind/grid.bin    Int16Array, planar: u in [0, n), v in [n, 2n),
 *                            0.01 m/s per unit, row 0 = -90° latitude
 *
 * The worker (`worker/windmap.py`) fetches NOAA NCEP GFS 10 m u/v once
 * per 6-hourly analysis and writes those two files. This module never
 * talks to a weather API and never re-requests per user — the browser
 * downloads ~260 KB once, cached, and revalidates only when the cycle
 * advances.
 *
 * THE ANIMATION, AND WHY IT IS FAST
 * ─────────────────────────────────
 * Each frame moves ~N particles by sampling the grid at their own
 * latitude/longitude (bilinear, ~10 ops) and projecting through Leaflet.
 * Nothing heavier runs in the frame loop: no canvas compositing tricks,
 * no per-frame field reconstruction, no DOM. That is what lets 3,000
 * particles hold 60 fps.
 *
 * Sampling in GEOGRAPHIC space rather than screen space is deliberate.
 * A screen-space vector field has to be rebuilt after every pan and
 * zoom, and is briefly wrong during the drag; the grid is already
 * geographic, so a particle's flow is correct at every moment and costs
 * the same.
 *
 * The physics is in advance(), a pure function of (lat, lng, dt): it
 * is what moves the particles, and it is exported as _advance() so the
 * test suite can check that an easterly wind sends a particle east and
 * that a degree of longitude shrinks by cos(lat) without dragging a
 * map into the test.
 *
 * Look: particles are drawn as comet trails — a short history polyline
 * with a fading alpha, plus a wide low-alpha bloom pass so fast wind
 * glows. Colour comes from the speed ramp in meta.json, so a jet stream
 * reads as magenta energy and a calm ocean stays almost invisible.
 *
 * Wired by app.js:
 *     WEATHER_OVERLAYS["💨 Wind (GFS)"] = window.WindLayer.getTileLayer();
 *     window.WindLayer.init(map);
 *
 * No build step. Same pattern as public_html/temp-layer.js.
 */
(function () {
  "use strict";

  const BASE = "/data/wind";
  const META_URL = BASE + "/meta.json";
  const GRID_URL = BASE + "/grid.bin";

  // Layers dropdown keys. The overlay is registered under a name that
  // starts with an emoji like the other weather overlays, so it sorts
  // with them.
  const LAYER_NAME = "💨 Wind (GFS)";

  // ── how the wind is DRAWN ─────────────────────────────────────────────
  //
  // Four ways to see the same field, because they answer different
  // questions:
  //
  //   streamlines  trailing streaks — the flow reads as motion over time
  //   flow         a texture of fibres that builds up over a second or
  //                two — the classic wind-map look, and the only one
  //                that reads as a CONTINUOUS field
  //   particles    moving dots — cheap, clean, and honest about being
  //                samples rather than a field
  //   arrows       static arrow glyphs on a grid — a synoptic reading:
  //                speed AND direction at a glance, no animation
  const STYLE_CHOICES = [
    { id: "streamlines", label: "Streamlines", hint: "Trailing streaks — the flow reads as motion" },
    { id: "flow", label: "Flow", hint: "Fibres that build up over a second — the classic wind map" },
    { id: "particles", label: "Particles", hint: "Moving dots, no trails" },
    { id: "arrows", label: "Arrows", hint: "Static arrows — speed and direction at a glance" },
  ];
  const STYLE_STORE_KEY = "xyzo.windStyle";
  const DEFAULT_STYLE = "streamlines";

  // ── how the wind is COLOURED ──────────────────────────────────────────
  //
  //   colourful  the site's own vivid TURBO scheme — every wind is
  //              findable against a satellite basemap, and the hue
  //              still says "warmer = faster"
  //   speed      the published ramp — the scientific key, and the one
  //              the legend's colour bar is drawn from
  //   mono       ONE colour, brightness by speed — reads over any
  //              basemap, including one the ramp cannot compete with
  const COLOR_CHOICES = [
    { id: "colourful", label: "Colourful", hint: "Vivid — every wind easy to find" },
    { id: "speed", label: "By speed", hint: "The published speed ramp" },
    { id: "mono", label: "Mono", hint: "One colour, brightness by speed" },
  ];
  const COLOR_STORE_KEY = "xyzo.windColor";
  const DEFAULT_COLOR = "colourful";
  // The single ink the mono mode paints with. Bright, because the map's
  // own basemaps are mostly dark satellite and a white streak reads on
  // all of them.
  const MONO_INK = [255, 255, 255];
  // The vivid scheme the "colourful" mode paints with.
  //
  // It is a full hue sweep — cyan → blue → violet → magenta → red →
  // orange → yellow — and it is BRIGHT AT BOTH ENDS on purpose. The
  // site's TURBO palette starts at #30123b, a deep violet that vanishes
  // against the night ocean the map opens on; a colour scheme with a
  // dark end has the same problem as the published ramp, which starts
  // near-black (#0b1020 at 0 m/s). Here even a calm wind is a bright
  // cyan streak you can pick out of the satellite.
  const COLORFUL_RAMP = [
    "#22d3ee", // 0    cyan
    "#3b82f6", //      blue
    "#8b5cf6", //      violet
    "#ec4899", //      magenta
    "#f43f5e", //      red
    "#fb923c", //      orange
    "#fbbf24", //      yellow — the hot end
  ];

  // ── how MUCH wind ────────────────────────────────────────────────────
  //
  // A PERCENTAGE of the automatic count, not an absolute number of
  // particles. The automatic count is derived from the screen area —
  // "one particle per ~420 px² keeps density even across screen sizes"
  // — and an absolute count would break exactly that: 5,000 dots is
  // sparse on a 4K monitor and sluggish on a phone. A percentage scales
  // each screen's OWN baseline, so a shared link reproduces the same
  // LOOK everywhere, which is what "share the exact map" means for a
  // field of dots.
  //
  // It travels as the THIRD field of `wind=`
  // (`wind=particles:speed:200`) rather than as its own segment,
  // because the URL already has a `density=` segment and it means
  // something else entirely — PIN density (`density=max`). Two settings
  // called density in one hash is how a reader ends up with the wrong
  // one; one segment carrying everything about how the wind is drawn
  // cannot diverge from itself.
  //
  // Written whenever the wind is ON, not only when it differs from the
  // default — the same rule `iso=` follows. Omitting it would leave the
  // READER's stored density to decide, so a sender on the default would
  // hand a reader who had once chosen 300 % a map opening at 300 %:
  // the same link, a different picture.
  const DENSITY_STORE_KEY = "xyzo.windDensity";
  const DEFAULT_DENSITY = 100;
  const DENSITY_MIN = 25;
  const DENSITY_MAX = 400;
  // Below this the legend says so (see paintDensityReadout): 30 fps is
  // where motion stops reading as smooth on a 60 Hz display, and it is
  // the threshold at which "lower the density" stops being advice and
  // starts being the answer.
  const SLOW_FPS = 30;

  // Particle behaviour. MAX_AGE is in frames at 60 fps; particles are
  // respawned sooner if they leave the map or pile up on a pole.
  const MAX_AGE = 130;
  // The trail is trimmed by LENGTH, not by frame count — see
  // renderStreamlines(). TRAIL_MAX is only the cap on how many points
  // that may need.
  const TRAIL_MAX = 80;
  const TRAIL_PX = 64;
  const TARGET_PX_PER_FRAME = 1.15; // how far a "typical" wind moves a particle

  // ── THE dt CAP, AND WHY IT IS 0.25 s ─────────────────────────────────
  //
  // `step()` advances the field by the time that actually elapsed — but
  // only up to this cap. The cap exists for one reason: a stall (tab
  // frozen, a long GC pause, a breakpoint) would otherwise advance the
  // field by SECONDS on the next frame, and a trail would be drawn as a
  // single slash across the map.
  //
  // It was 0.1 s, which silently made it a SPEED LIMIT: below 10 fps
  // the animation lost display time on every frame and ran slower than
  // real time. Measured on the owner's fifteen-overlay link
  // (2026-11-14): Firefox ran 3.7–6.5 fps, so 60–75 % of every second
  // was thrown away and the dots crawled at 15.6 px/s against the
  // 39 px/s the same field manages at 17 fps. **That is the whole of
  // "the wind dots don't move around very fast on Firefox"** — the
  // frame rate was one problem, and this cap was the other.
  //
  // 0.25 s keeps the motion at real-time pace down to 4 fps, which is
  // slower than anything this site should ever reach anyway, while
  // still bounding a genuine stall to a ~17 px step at the target
  // speed — a step, not a slash.
  const MAX_DT_S = 0.25;

  // A grid cell is ~111 km across at 1°, so real-time motion would be
  // sub-pixel and invisible. This is the multiplier that makes it read
  // as flow; it is recomputed on zoom so the feel is the same at z2 and
  // z11.
  const MEAN_SPEED_MS = 6.0;
  // Metres per degree of latitude at the equator (WGS84). Both the
  // u → east and v → north conversions use this, since a degree of
  // longitude is the same length *at the equator*.
  const M_PER_DEG = 111320;

  const state = {
    meta: null,
    grid: null,      // Int16Array, length 2 * rows * cols
    u: null,
    v: null,
    n: 0,
    enabled: false,
    map: null,
    pane: null,
    canvas: null,
    ctx: null,
    particles: [],
    raf: 0,
    lastT: 0,
    speedScale: 1,
    opacity: 0.95,
    dpr: 1,
    // The view's longitude window, refreshed once per frame (see
    // step()). It is CONTINUOUS, like Leaflet's own longitude space —
    // a view west of the antimeridian runs from -200 to -136 — and the
    // particle guard below is relative to it.
    viewWest: -180,
    viewEast: 180,
    ramp: null,
    rampMax: 18,
    // How the wind is drawn, how it is coloured and how MUCH of it.
    // All three are the READER's choice, so all three persist.
    style: readStoredStyle(),
    colorMode: readStoredColor(),
    density: readStoredDensity(),
    palette: "default",
    // The flow renderer accumulates into the canvas instead of clearing
    // it, so it needs a flag to know the canvas is holding an image.
    flowStrokes: 0,
    // The streaklets the flow renderer moves along the wind.
    flowPool: [],
    // The arrows are STATIC: they are redrawn only when the view moves
    // or the reader changes something, so the key is the view itself.
    arrowKey: null,
    arrowsDirty: true,
    // The live screen calibration — see screenToLatLng(). It lives in
    // the state because it is measured, not derived: it is what the
    // view is right now.
    screen: null,
    // 0.4..1 — shaves particles on devices that cannot keep up, and
    // grows back when there is headroom. Set by the FPS guard below.
    qscale: 1,
    qLocked: false,   // true while setQuality() holds it (tests only)
    // Diagnostics for the debug page / tests.
    frameCount: 0,
    lastFps: 0,
    _fpsT: 0,
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ── the reader's choices ──────────────────────────────────────────────
  //
  // The style, the colour mode and the palette are all the READER's
  // choice, so all three persist. A corrupt or hand-edited value falls
  // back to the default rather than reaching the API.
  function storageGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  function readStoredStyle() {
    const v = storageGet(STYLE_STORE_KEY, DEFAULT_STYLE);
    return STYLE_CHOICES.some((s) => s.id === v) ? v : DEFAULT_STYLE;
  }
  function readStoredColor() {
    const v = storageGet(COLOR_STORE_KEY, DEFAULT_COLOR);
    return COLOR_CHOICES.some((c) => c.id === v) ? v : DEFAULT_COLOR;
  }
  // A corrupt or hand-edited density falls back to the default rather
  // than reaching ensureParticles() — a `NaN` here would multiply every
  // count to NaN and the layer would draw nothing at all.
  //
  // The EMPTY string is guarded too: Number("") is 0, and 0 clamps to
  // the 25 MINIMUM rather than to the default, so a blank stored value
  // would quietly open the map at a quarter density. Only a value that
  // is actually there may be read.
  function readStoredDensity() {
    const raw = storageGet(DENSITY_STORE_KEY, DEFAULT_DENSITY);
    if (raw == null || raw === "") return DEFAULT_DENSITY;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_DENSITY;
    return clamp(Math.round(n), DENSITY_MIN, DENSITY_MAX);
  }

  // ── Data ──────────────────────────────────────────────────────────────

  // Build a lookup from m/s → "#rrggbb" by walking the stops.
  // Interpolating per particle would cost more than it is worth, so the
  // stops are quantised into a 256-entry LUT once.
  //
  // It takes the STOPS, not the meta: the ramp it is given is already
  // the ACTIVE one (published, vivid, or the palette's), and reading
  // `meta.ramp` here would throw the choice away and leave the LUT
  // empty — which falls back to a flat grey, so every wind on the map
  // would be painted in the same colour whatever the reader chose.
  function parseRamp(rampStops) {
    const stops = (rampStops || []).map((s) => ({
      t: Number(s.ms), r: parseInt(s.rgb.slice(1, 3), 16),
      g: parseInt(s.rgb.slice(3, 5), 16), b: parseInt(s.rgb.slice(5, 7), 16),
    }));
    if (!stops.length) return null;
    const lut = [];
    const hi = state.rampMax;
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * hi;
      let a = stops[0], b = stops[stops.length - 1];
      for (let j = 0; j < stops.length - 1; j++) {
        if (t >= stops[j].t && t <= stops[j + 1].t) { a = stops[j]; b = stops[j + 1]; break; }
      }
      const span = b.t - a.t;
      const f = span > 0 ? clamp((t - a.t) / span, 0, 1) : 0;
      lut.push([
        Math.round(a.r + (b.r - a.r) * f),
        Math.round(a.g + (b.g - a.g) * f),
        Math.round(a.b + (b.b - a.b) * f),
      ]);
    }
    return lut;
  }

  // Drawing batches: speed × fade buckets. A wide stroke on a software
  // canvas is the expensive part of this layer, and doing two per
  // particle (1,000+ per frame) is what capped the frame rate. Neighbouring
  // particles share almost the same colour and phase, so a small grid of
  // buckets reproduces the image while collapsing ~1,100 stroke() calls
  // into ~100 — geometry is traced once per bucket, then stroked twice
  // (bloom + core) with that bucket's representative style.
  const SPEED_BUCKETS = 12;   // == RAMP_STOPS.length
  const FADE_BUCKETS = 4;

  function rampColor(speedMs, alpha) {
    const lut = state.ramp;
    if (!lut) return `rgba(148,163,184,${alpha})`;
    const i = clamp(Math.round((speedMs / state.rampMax) * 255), 0, 255);
    const c = lut[i];
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }

  // The colour a mark of this speed is painted in, honouring the
  // reader's colour mode.
  //
  // "speed" is the published ramp. "mono" is ONE ink with the brightness
  // carrying the speed — and it exists because the published ramp starts
  // near-black (#0b1020 at 0 m/s), so a calm wind is invisible on a dark
  // satellite AND on a bright one. A single bright ink with the SPEED in
  // its alpha reads over any basemap, which is the whole point of a
  // basemap underneath it.
  function paintColor(speedMs, alpha) {
    if (state.colorMode === "mono") {
      // The alpha carries the speed: a calm wind is a faint streak, a
      // gale is a solid one. The floor keeps even the calmest wind
      // visible rather than fading to nothing.
      const f = clamp(speedMs / Math.max(1, state.rampMax), 0, 1);
      const a = clamp(alpha * (0.30 + 0.70 * f), 0, 1);
      return `rgba(${MONO_INK[0]},${MONO_INK[1]},${MONO_INK[2]},${a})`;
    }
    return rampColor(speedMs, alpha);
  }

  // The RGB of a wind vector, for the exporter and the legend. It uses
  // the same LUT the marks are painted from, so the PNG and the map
  // cannot disagree.
  function speedRgb(speedMs) {
    const lut = state.ramp;
    if (!lut) return [148, 163, 184];
    const i = clamp(Math.round((speedMs / state.rampMax) * 255), 0, 255);
    return lut[i];
  }

  // Bilinear sample of the u/v field at a geographic point.
  // Returns null off the grid (over the poles).
  function sample(lat, lng) {
    const g = state.meta && state.meta.grid;
    if (!g || !state.u) return null;
    if (lat < g.lat_min || lat > g.lat_max) return null;

    // Longitude is stored 0..360 in whole degrees; wrap rather than
    // reject, so a particle crossing the antimeridian keeps flowing
    // instead of dying at the edge.
    const lon = ((((lng - g.lon_min) % 360) + 360) % 360) + g.lon_min;

    const gx = (lon - g.lon_min) / g.lon_step;
    const gy = (lat - g.lat_min) / g.lat_step;

    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    // The column past the last one wraps back to column 0: at 359.5°E
    // the two neighbours are 359° and 0°, not 359° and 359°. Clamping
    // instead leaves a one-degree stripe at the dateline where the
    // wind is stale — and the particle visibly stalls there.
    const x1 = (x0 + 1) % g.cols, y1 = Math.min(y0 + 1, g.rows - 1);
    const fx = gx - x0, fy = gy - y0;

    const i00 = y0 * g.cols + x0, i10 = y0 * g.cols + x1;
    const i01 = y1 * g.cols + x0, i11 = y1 * g.cols + x1;
    const n = state.n;

    const u = (1 - fy) * ((1 - fx) * state.u[i00] + fx * state.u[i10]) +
              fy * ((1 - fx) * state.u[i01] + fx * state.u[i11]);
    const v = (1 - fy) * ((1 - fx) * state.v[i00] + fx * state.v[i10]) +
              fy * ((1 - fx) * state.v[i01] + fx * state.v[i11]);

    // Stored as 0.01 m/s.
    return [u / state.scale, v / state.scale];
  }

  // Where a particle at (lat, lng) ends up after dt seconds of display
  // time, and how fast it is travelling there.
  //
  // Pure, and separate from the drawing, so the physics can be tested
  // without a map: an easterly wind has to move the particle east, a
  // southerly one south, and the ground distance has to come out the
  // same whatever the latitude.
  //
  // Meteorological convention: u is eastward, v is northward. A degree
  // of longitude is 111320 * cos(lat) metres, so the same ground
  // distance covers fewer degrees of longitude the further north you
  // go — without the cos(lat) the flow near the poles races sideways
  // across the screen.
  function advance(lat, lng, dt) {
    const s = sample(lat, lng);
    if (!s) return null;
    const u = s[0], v = s[1];
    const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.05);
    const degPerSec = state.speedScale;
    const dLng = (u * degPerSec * dt) / cosLat;
    const dLat = v * degPerSec * dt;
    return {
      lat: lat + dLat,
      lng: lng + dLng,
      u: u,
      v: v,
      speed: Math.sqrt(u * u + v * v),
      // Ground distance in metres — the length of the step on the
      // Earth's surface, which is what makes the cos(lat) correction
      // testable.
      metres: Math.hypot(dLat * M_PER_DEG, dLng * M_PER_DEG * cosLat),
    };
  }

  // m/s → "14 mph · 22 km/h · 12 kt", for the probe and the legend.
  //
  // Owner ask (2026-11-04): *"remove m/s and add miles/hr and kt and
  // km/hr"*. So m/s is GONE from every reader-facing wind readout —
  // m/s stays as the DATA unit (the published grid, the export band
  // names and the colour ramp are all in m/s, and they must stay in the
  // unit the source speaks) and only the DISPLAY converts.
  //
  // The three units are all integers, which is what every weather
  // service prints (and what windy.com prints): a rounded number is a
  // number a reader can compare against a forecast. A calm wind still
  // reads "0 mph · 1 km/h · 1 kt", so the light air is never lost.
  function fmtSpeed(ms) {
    return `${Math.round(ms * 2.23694)} mph · ${Math.round(ms * 3.6)} km/h · ${Math.round(ms * 1.94384)} kt`;
  }

  // Compass name for a meteorological direction (the way it comes FROM).
  function compass(deg) {
    const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return names[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }

  // ── Particles ─────────────────────────────────────────────────────────

  function spawn(p) {
    const map = state.map;
    if (!map) return;
    const b = map.getBounds();
    // Keep a margin so a particle born at the edge does not immediately
    // die, and avoid the extreme latitudes where a 1° cell is
    // degenerate and the projection stretches a step into a smear.
    const pad = (b.getNorth() - b.getSouth()) * 0.06;
    p.lat = b.getSouth() + pad + Math.random() * Math.max(0.001, (b.getNorth() - b.getSouth()) - 2 * pad);
    p.lng = b.getWest() + Math.random() * Math.max(0.001, b.getEast() - b.getWest());
    p.age = 0;
    p.maxAge = MAX_AGE * (0.6 + Math.random() * 0.8);
    p.speed = 0;
    p.px = null;
    p.py = null;
    p.hist = p.hist || [];
    p.hist.length = 0;
  }

  function ensureParticles() {
    const map = state.map;
    if (!map) return;
    const size = map.getSize();
    // One particle per ~420 px² keeps density even across screen
    // sizes, with hard floors/ceilings so a phone is not sluggish and a
    // wide monitor is not sparse. It was 850 px², which is one particle
    // every 29 px — sparse enough that the field read as confetti.
    //
    // state.density is a PERCENTAGE of that automatic count, applied
    // last so the screen-adaptive base and the FPS guard both keep
    // their meaning: 100 % is byte-for-byte the count this always
    // produced, and a reader who wants twice as many gets twice as
    // many ON THEIR SCREEN rather than a number tuned on someone
    // else's. The floor scales with it too, or 25 % would be rounded
    // straight back up to the 400 floor and the slider would do
    // nothing at the bottom of its range.
    const auto = Math.max(400, Math.round(
      clamp((size.x * size.y) / 420, 900, 8000) * state.qscale));
    const want = Math.max(Math.round(400 * state.density / 100),
      Math.round(auto * state.density / 100));
    const ps = state.particles;
    while (ps.length < want) { const p = {}; spawn(p); ps.push(p); }
    if (ps.length > want) ps.length = want;
    paintDensityReadout();
  }

  // Set the flow rate so a "typical" wind moves TARGET_PX_PER_FRAME
  // pixels per frame, whatever the zoom — real-time motion at 1°
  // resolution is sub-pixel and looks frozen, while a fixed factor
  // either crawls at z11 or smears at z2.
  //
  // Units matter here. `speedScale` is consumed by step() as
  //     dLat = v(m/s) * speedScale * dt(s)
  // so it must be DEGREES of latitude per second per (m/s) — i.e.
  // SPEEDUP / 111320, not the dimensionless multiplier itself. Reading
  // the old version at world zoom gave 118.8 where 4.1 was correct, and
  // particles travelled ~13° per frame: continent-spanning streaks
  // instead of streamlines.
  function recalibrate() {
    const map = state.map;
    if (!map) return;
    const a = map.latLngToContainerPoint([0, 0]);
    const b = map.latLngToContainerPoint([0, 1]);
    const pxPerDeg = Math.abs(b.x - a.x) || 1;

    // px per frame that 1 m/s of wind covers in REAL time at 60 fps.
    // (1 m/s = 1/111320 °/s; × pxPerDeg; ÷ 60 frames per second.)
    const pxPerFramePerMs = pxPerDeg / (M_PER_DEG * 60);
    const realPxPerFrame = Math.max(pxPerFramePerMs * MEAN_SPEED_MS, 1e-9);
    const speedup = TARGET_PX_PER_FRAME / realPxPerFrame;

    state.speedScale = speedup / M_PER_DEG;

    // The screen -> geographic conversion, done directly.
    //
    // map.containerPointToLatLng() goes through the map's CRS every
    // time, and the flow renderer asks for thousands of them a frame —
    // at 5,000 strokes that was the most expensive thing in the layer.
    // The Mercator inverse is two Math calls.
    //
    // K is the pixels per unit of Mercator y: the container y of a
    // latitude is y0 - mercY(latitude)·K, and one degree of latitude
    // is mercY(1°) = 0.0174533 in those units.
    const mercY1 = Math.log(Math.tan(Math.PI / 4 + Math.PI / 360));
    state.screen = {
      x0: a.x, y0: a.y, pxPerDeg,
      K: pxPerDeg / mercY1,
    };
  }

  // A screen point -> [lat, lng], without Leaflet.
  function screenToLatLng(x, y) {
    const o = state.screen;
    if (!o) return null;
    const merc = (o.y0 - y) / o.K;
    const lat = (2 * Math.atan(Math.exp(merc)) - Math.PI / 2) * 180 / Math.PI;
    const lng = (x - o.x0) / o.pxPerDeg;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return [lat, lng];
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  function resize() {
    const map = state.map, canvas = state.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();
    // Cap the backing-store scale: a 3x retina canvas triples the fill
    // cost of every frame for no visible gain on streaks this thin.
    state.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(size.x * state.dpr);
    canvas.height = Math.round(size.y * state.dpr);
    canvas.style.width = size.x + "px";
    canvas.style.height = size.y + "px";
    anchorCanvas();
  }

  // The canvas lives inside windPane, and Leaflet's pane translate
  // PERSISTS after every drag-pan (measured 2026-10-28:
  // panBy([150,80]) → translate3d(-150,-80,0); only a setView/zoom
  // zeroes it — the city-labels bug, same shape). Particles are drawn
  // at latLngToContainerPoint, so unless the canvas origin is pinned
  // to the screen origin the whole field sits paneOffset away from its
  // geography. The translate changes with every pan → re-anchor there
  // too, not just on resize.
  function anchorCanvas() {
    const map = state.map, canvas = state.canvas;
    // Degrade, never throw: a partial map (test stub) without the
    // inverse transform keeps the canvas at its last anchor instead of
    // killing resize()/start() with a TypeError.
    if (!map || !canvas || typeof map.containerPointToLayerPoint !== "function") return;
    const a = map.containerPointToLayerPoint([0, 0]);
    canvas.style.left = a.x + "px";
    canvas.style.top = a.y + "px";
    // inset:0 set right/bottom to 0 at creation; with an explicit
    // width they are over-constrained — pin them to auto anyway.
    canvas.style.right = "auto";
    canvas.style.bottom = "auto";
  }

  // Has the particle left the world?
  //
  // **THE TEST IS RELATIVE TO THE VIEW, AND IT HAS TO BE.**
  //
  // Leaflet's longitude space is CONTINUOUS: a view centred west of
  // the antimeridian runs from about -200 to -136, and the particles
  // on the far side of the dateline are legitimately at -199. A FIXED
  // window (-180 … 185) killed them EVERY FRAME — and `spawn()` picks
  // the next longitude from `map.getBounds()`, so the replacement died
  // at once too. **The western Pacific was blank for exactly that
  // reason**: the owner saw "the right side has the wind and the left
  // doesn't", and the measured ink was 1,393 samples on the left half
  // of the canvas against 3,832 on the right.
  //
  // A whole turn outside the visible range is a runaway (the screen
  // check recycles everything nearer than that), so that is the test.
  function offWorld(p) {
    return p.lng < state.viewWest - 360 || p.lng > state.viewEast + 360;
  }

  function step(now) {
    state.raf = 0;
    if (!state.enabled) return;
    if (document.hidden) { state.lastT = 0; return; }

    const map = state.map, ctx = state.ctx;
    if (!map || !ctx || !state.u) { schedule(); return; }

    // A frame must never be able to end the animation. `schedule()` runs
    // from `finally`, so one bad particle — or a Leaflet signature drift,
    // which is exactly how this loop froze once — logs a warning and the
    // next frame happens anyway, instead of a layer that sits there
    // looking broken.
    try {

    const dt = state.lastT
      ? Math.min((now - state.lastT) / 1000, MAX_DT_S)
      : 1 / 60;
    state.lastT = now;

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // The view's longitude window, ONCE PER FRAME. It is what the
    // particle guard is measured against (see offWorld()), and it must
    // not be a fixed -180…185 window: Leaflet's longitude space is
    // continuous, so a view west of the antimeridian legitimately runs
    // from -200 to -136.
    try {
      const vb = map.getBounds();
      state.viewWest = vb.getWest();
      state.viewEast = vb.getEast();
    } catch (_) {
      // A map without bounds (a test stub) keeps the whole world.
      state.viewWest = -180;
      state.viewEast = 180;
    }

    // The four ways to draw the same field.
    if (state.style === "flow") {
      renderFlow(ctx, map, dt);
    } else if (state.style === "particles") {
      renderParticles(ctx, map, dt);
    } else if (state.style === "arrows") {
      renderArrows(ctx, map);
    } else {
      renderStreamlines(ctx, map, dt);
    }

    state.frameCount++;
    if (!state._fpsT) state._fpsT = now;
    if (now - state._fpsT > 1000) {
      state.lastFps = Math.round(state.frameCount * 1000 / (now - state._fpsT));
      state.frameCount = 0;
      state._fpsT = now;

      // The legend's live fps — see paintDensityReadout(). It is once a
      // second and it is a textContent comparison, so it costs nothing,
      // and it is the number a reader needs in order to act on the
      // density slider: "1,234 dots · 6 fps" says what "lower the
      // density for smoother motion" is an answer to.
      paintDensityReadout();

      // Shed and regrow. Canvas here is software-rendered with no GPU,
      // so the same 1,482 particles are 22 fps in headless and 60 on a
      // laptop — the pool has to follow the device instead of guessing.
      // Hysteresis (40 / 56) keeps it from oscillating.
      const prev = state.qscale;
      if (state.qLocked) { /* setQuality() pinned it — leave it alone */ }
      else if (state.lastFps < 40 && state.qscale > 0.4) state.qscale = Math.max(0.4, state.qscale * 0.85);
      else if (state.lastFps > 56 && state.qscale < 1) state.qscale = Math.min(1, state.qscale * 1.06);
      if (Math.abs(state.qscale - prev) > 0.01) ensureParticles();
    }

    } catch (err) {
      if (typeof XLog !== "undefined" && XLog && XLog.warn) XLog.warn("WindLayer.step", err);
    } finally {
      schedule();
    }
  }

  // ── the four renderers ────────────────────────────────────────────────

  // 1. STREAMLINES — a trail behind each particle.
  //
  // The trail is what carries the direction. A dot moving is hard to
  // read (you cannot tell which way it went); a streak is unmistakable.
  // The price is that the streaks are isolated, and a field of isolated
  // streaks does NOT read as a field — which is why "flow" exists.
  function renderStreamlines(ctx, map, dt) {
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);

    const px = map.latLngToContainerPoint.bind(map);
    const stepS = dt;
    const paths = [];   // index = speedBucket * FADE_BUCKETS + fadeBucket

    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      const a = advance(p.lat, p.lng, stepS);
      if (!a) { spawn(p); continue; }

      const sp = a.speed;
      p.speed = sp;

      const prev = px([p.lat, p.lng]);
      p.lat = a.lat;
      p.lng = a.lng;
      p.age += dt * 60;

      // Life over.
      if (p.age > p.maxAge ||
          p.lat < -85 || p.lat > 85 ||
          offWorld(p)) { spawn(p); continue; }

      const cur = px([p.lat, p.lng]);
      // Outside the viewport: recycle rather than draw, so the frame
      // budget is spent on what you can see.
      if (cur.x < -40 || cur.y < -40 ||
          cur.x > size.x + 40 || cur.y > size.y + 40) {
        spawn(p); continue;
      }

      p.hist.push(prev.x, prev.y);
      // Trim the trail by LENGTH, not by frame count.
      //
      // The particle's speed decides how far it moves per frame, so a
      // fixed FRAME count made every calm wind a four-pixel dot: the
      // slow half of the map was simply not there, and the wind looked
      // like a scatter of confetti rather than a field. A fixed LENGTH
      // means every streak is long enough to read; the SPEED is
      // carried by the colour, which is what the ramp is for.
      let acc = 0;
      const nHist = p.hist.length / 2;
      for (let k = nHist - 1; k > 0; k--) {
        acc += Math.hypot(p.hist[k * 2] - p.hist[(k - 1) * 2],
                          p.hist[k * 2 + 1] - p.hist[(k - 1) * 2 + 1]);
        if (acc >= TRAIL_PX) { p.hist.splice(0, (k - 1) * 2); break; }
      }
      if (p.hist.length > TRAIL_MAX * 2) {
        p.hist.splice(0, p.hist.length - TRAIL_MAX * 2);
      }

      const h = p.hist;
      const nPts = h.length / 2;
      if (nPts < 2) continue;
      const fadeIn = clamp(p.age / 18, 0, 1);
      const fadeOut = clamp((p.maxAge - p.age) / 25, 0, 1);
      const fade = fadeIn * fadeOut;               // 0..1
      const speedFrac = clamp(sp / state.rampMax, 0, 0.9999);

      const sb = (speedFrac * SPEED_BUCKETS) | 0;
      const fb = (fade * FADE_BUCKETS) | 0;
      const key = sb * FADE_BUCKETS + fb;

      let path = paths[key];
      if (!path) { path = paths[key] = new Path2D(); }
      path.moveTo(h[0], h[1]);
      for (let k = 1; k < nPts; k++) path.lineTo(h[k * 2], h[k * 2 + 1]);
    }

    // Flush per bucket: a DARK contrast halo, then the bloom, then the
    // core.
    //
    // The halo is the answer to the owner's report — *"i click on it,
    // i don't see anything"* — measured at his own coordinates
    // (#46.73,-117,7: brown-green satellite terrain). The animation was
    // running all along (1,234 particles, 228,554 pixels changing per
    // 400 ms) and the colour was right; what was missing was CONTRAST.
    // A pale cyan line on pale ground has nothing to separate it from,
    // and the bloom — which is the SAME colour as the core — can only
    // ever make the ground brighter around it, so over a bright basemap
    // it does nothing at all. A near-black halo costs nothing on a dark
    // basemap (it is invisible against black) and gives the bright core
    // an edge on a light one: the same trick as text with a stroke.
    //
    // Thicker and brighter besides: the core went 1.15 → 1.6 px, the
    // bloom 4 → 4.8 px at 0.22 → 0.30 alpha, and the core's alpha FLOOR
    // 0.52 → 0.62 — the slow half of the field was drawn at half alpha
    // and disappeared first. Measured before/after on the live map:
    // wind-on against wind-off changed 4.7 % of the screen; see the
    // README row for the after figure.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let sb = 0; sb < SPEED_BUCKETS; sb++) {
      for (let fb = 0; fb < FADE_BUCKETS; fb++) {
        const path = paths[sb * FADE_BUCKETS + fb];
        if (!path) continue;
        const repSpeed = ((sb + 0.5) / SPEED_BUCKETS) * state.rampMax;
        const repFade = (fb + 0.5) / FADE_BUCKETS;
        const repBase = state.opacity * repFade;
        const core = repBase * (0.62 + ((sb + 0.5) / SPEED_BUCKETS) * 0.38);

        ctx.strokeStyle = "rgba(8,12,20," + (repBase * 0.5).toFixed(3) + ")";
        ctx.lineWidth = 5.4;
        ctx.stroke(path);

        ctx.strokeStyle = paintColor(repSpeed, repBase * 0.30);
        ctx.lineWidth = 4.8;
        ctx.stroke(path);

        ctx.strokeStyle = paintColor(repSpeed, core);
        ctx.lineWidth = 1.6;
        ctx.stroke(path);
      }
    }
  }

  // 2. PARTICLES — a dot per sample, no trail.
  //
  // Cheapest of the four and the least ambiguous about what it is: these
  // are samples of the field, not a claim to be a field. Good on a phone.
  //
  // THE DOT NEEDS A DARK HALO — this was the last renderer in the file
  // still filling BARE. The streaks and the flow both stroke a
  // near-black ring under their bright core, because a bloom in the same
  // colour as the core can only make the ground brighter around it,
  // which is the one thing that cannot help over a light basemap. A
  // shared link can pin this style (`wind=particles:speed`), and on such
  // a link — the owner's own, fifteen overlays on — the bare dots lit
  // **1.47 % of the screen**, against 9.30 % for streamlines and 47.9 %
  // for flow: the animation was running perfectly and the reader saw a
  // map with no wind on it. Same defect, same cause, same fix as the
  // streaks' "i click on it and i don't see anything".
  const PARTICLE_R_MIN = 1.9;       // container px at a calm wind
  const PARTICLE_R_SPAN = 1.5;      // …up to 3.4 px at rampMax
  const PARTICLE_HALO_PX = 4.6;     // ring width, so the mark reads ~7 px
  // THE THREE RINGS ARE FILLED DISCS, NOT STROKES (2026-11-14).
  //
  // The visible result of a stroke of width w on a circle of radius r
  // is the annulus [r − w/2, r + w/2] — and three CONCENTRIC FILLS
  // painted halo → bloom → core reproduce that exactly, because every
  // inner disc paints over the part of the outer one it covers: the
  // core shows in [0, r], the bloom in (r, r + 1.9], the dark halo in
  // (r + 1.9, r + 2.3] — the same three bands the strokes produced.
  //
  // Why it matters: measured on this site's own machines, a wide
  // round-capped STROKE is the single most expensive thing this layer
  // does. The shipped strokes cost **36.2 ms a frame** for 1,234 dots
  // in Firefox against **15.3 ms** for the same picture as fills (and
  // 28–51 ms depending on pass count), and instrumenting the live page
  // showed `stroke()` was **80 % of every frame the wind layer spent
  // inside canvas calls**. A stroked circle has to be tessellated into
  // a thick outline with round joins; a filled circle is a scanline
  // fill. Chromium rasterises either way in well under a millisecond,
  // so fills cost it ~3.7 ms a frame — a price worth paying for the
  // browser that was actually struggling.
  //
  // One deliberate difference: the core's fill is translucent
  // (opacity × 0.9), so a little of what is UNDER it shows through.
  // Under the strokes that was bare basemap; under the discs it is the
  // dark halo, which makes each dot a touch more solid — in the
  // direction the dark-halo contrast fix was already pushing.
  const PARTICLE_HALO_R = PARTICLE_HALO_PX / 2;            // 2.3 px out from r
  const PARTICLE_BLOOM_R = (PARTICLE_HALO_PX - 0.8) / 2;   // 1.9 px out from r
  function renderParticles(ctx, map, dt) {
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);

    const px = map.latLngToContainerPoint.bind(map);
    // Three path sets, one per ring, bucketed by speed for colour —
    // see the constants above for why they are fills.
    const halos = [];
    const blooms = [];
    const cores = [];
    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      const a = advance(p.lat, p.lng, dt);
      if (!a) { spawn(p); continue; }
      p.speed = a.speed;
      p.lat = a.lat;
      p.lng = a.lng;
      p.age += dt * 60;
      if (p.age > p.maxAge || p.lat < -85 || p.lat > 85 ||
          offWorld(p)) { spawn(p); continue; }
      const cur = px([p.lat, p.lng]);
      if (cur.x < -20 || cur.y < -20 ||
          cur.x > size.x + 20 || cur.y > size.y + 20) { spawn(p); continue; }

      const fadeIn = clamp(p.age / 18, 0, 1);
      const fadeOut = clamp((p.maxAge - p.age) / 25, 0, 1);
      const fade = fadeIn * fadeOut;
      const sb = (clamp(a.speed / state.rampMax, 0, 0.9999) * SPEED_BUCKETS) | 0;
      if (!cores[sb]) {
        halos[sb] = new Path2D();
        blooms[sb] = new Path2D();
        cores[sb] = new Path2D();
      }
      const r = PARTICLE_R_MIN +
        PARTICLE_R_SPAN * clamp(a.speed / Math.max(1, state.rampMax), 0, 1);
      const halo = halos[sb], bloom = blooms[sb], core = cores[sb];
      halo.moveTo(cur.x + r + PARTICLE_HALO_R, cur.y);
      halo.arc(cur.x, cur.y, r + PARTICLE_HALO_R, 0, Math.PI * 2);
      bloom.moveTo(cur.x + r + PARTICLE_BLOOM_R, cur.y);
      bloom.arc(cur.x, cur.y, r + PARTICLE_BLOOM_R, 0, Math.PI * 2);
      core.moveTo(cur.x + r, cur.y);
      core.arc(cur.x, cur.y, r, 0, Math.PI * 2);
    }
    // Flush per bucket: DARK halo, then the bloom, then the core — the
    // same three passes the streaks use and in the same order, so a dot
    // gets an edge on a bright basemap and costs nothing on a dark one.
    for (let sb = 0; sb < SPEED_BUCKETS; sb++) {
      const halo = halos[sb];
      if (!halo) continue;
      const repSpeed = ((sb + 0.5) / SPEED_BUCKETS) * state.rampMax;
      const base = state.opacity * 0.9;

      ctx.fillStyle = "rgba(8,12,20," + (base * 0.5).toFixed(3) + ")";
      ctx.fill(halo);

      ctx.fillStyle = paintColor(repSpeed, base * 0.30);
      ctx.fill(blooms[sb]);

      ctx.fillStyle = paintColor(repSpeed, base);
      ctx.fill(cores[sb]);
    }
  }

  // 3. ARROWS — a static field of arrow glyphs.
  //
  // Not an animation at all, and that is the point: it is the synoptic
  // reading. An arrow's LENGTH carries the speed and its HEAD carries
  // the direction, so a chart shows both at a glance without the reader
  // having to follow a moving thing. Redrawn only when the view moves.
  const ARROW_MIN_PX = 74;    // one arrow per this many pixels
  function renderArrows(ctx, map) {
    const size = map.getSize();
    const key = Math.round(size.x) + "x" + Math.round(size.y) + ":" +
      Math.round(map.getZoom() * 100) + ":" +
      Math.round(map.getCenter().lat * 1000) + "," +
      Math.round(map.getCenter().lng * 1000) + ":" + state.opacity.toFixed(3) +
      // …and the density, or dragging the slider would leave the OLD
      // grid on screen: the key is what decides whether to redraw, and
      // a density change does not move the view or the opacity.
      ":" + state.density;
    if (key === state.arrowKey && !state.arrowsDirty) return;
    state.arrowKey = key;
    state.arrowsDirty = false;

    ctx.clearRect(0, 0, size.x, size.y);
    // Arrows are a GRID, so the count goes as the SQUARE of the cell:
    // halving the cell gives four times as many arrows. Taking the
    // square root of the density is what makes "200 %" mean twice as
    // many arrows rather than four times as many — the same physical
    // change the particle styles get from the same number.
    const cell = ARROW_MIN_PX / Math.sqrt(state.density / 100);
    const paths = [];
    for (let y = cell / 2; y < size.y; y += cell) {
      for (let x = cell / 2; x < size.x; x += cell) {
        const ll = map.containerPointToLatLng([x, y]);
        if (!ll) continue;
        const s = sample(ll.lat, ((ll.lng % 360) + 360) % 360);
        if (!s) continue;
        const u = s[0], v = s[1];
        const sp = Math.hypot(u, v);
        if (sp < 0.2) continue;
        // On a Web Mercator screen the direction of a ground vector is
        // (u, -v): east is right, north is up.
        const dx = u, dy = -v;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        // Length carries the speed, on a scale that keeps a calm wind
        // short and a gale nearly fills the cell.
        const f = clamp(sp / Math.max(1, state.rampMax), 0, 1);
        const L = cell * (0.22 + 0.46 * f);
        const hx = x + ux * L * 0.5, hy = y + uy * L * 0.5;
        const tx = x - ux * L * 0.5, ty = y - uy * L * 0.5;
        const sb = (clamp(sp / state.rampMax, 0, 0.9999) * SPEED_BUCKETS) | 0;
        let path = paths[sb];
        if (!path) { path = paths[sb] = new Path2D(); }
        // The shaft.
        path.moveTo(tx, ty);
        path.lineTo(hx, hy);
        // The head: two barbs back from the tip.
        const bl = L * 0.34;
        path.moveTo(hx, hy);
        path.lineTo(hx - ux * bl + uy * bl * 0.62, hy - uy * bl - ux * bl * 0.62);
        path.moveTo(hx, hy);
        path.lineTo(hx - ux * bl - uy * bl * 0.62, hy - uy * bl + ux * bl * 0.62);
      }
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let sb = 0; sb < SPEED_BUCKETS; sb++) {
      const path = paths[sb];
      if (!path) continue;
      const repSpeed = ((sb + 0.5) / SPEED_BUCKETS) * state.rampMax;
      ctx.strokeStyle = paintColor(repSpeed, state.opacity * 0.85);
      ctx.lineWidth = 1.6;
      ctx.stroke(path);
    }
  }

  // 4. FLOW — the field as a texture of fibres.
  //
  // This is the one that reads as a FIELD rather than as samples.
  //
  // The first version drew a few thousand short strokes at RANDOM
  // positions every frame and let the canvas fade slowly. That churns:
  // the picture dissolved and reformed faster than the eye could follow
  // it, the fibres never went anywhere, and there was no detail to
  // read ("the flow is too fast — we can't really see the details").
  //
  // So the strokes TRAVEL. Each is a streaklet that advances along the
  // local wind every frame and leaves a trail on the slowly-fading
  // canvas. The trail is the fibre; the advance is the motion. The
  // streaklet's speed is PROPORTIONAL to the wind, so a fast wind
  // draws a long fast streak and a slow one a short slow one — the
  // length of the fibre says what the colour says, and the two agree.
  //
  // The fade is what sets how long a fibre lives (about 1/FLOW_FADE
  // frames), so it is the dial for "how much detail do I see" — and
  // it is deliberately slow.
  const FLOW_STREAKLETS = 7000;
  const FLOW_SEG_PX = 3.0;     // pixels per frame at the MEAN wind speed
  const FLOW_ALPHA = 0.28;
  const FLOW_FADE = 0.018;     // per frame: a fibre lives ~55 frames
  const FLOW_LIFE = 240;       // frames before a streaklet respawns
  function respawnFlow(s, size) {
    s.x = Math.random() * size.x;
    s.y = Math.random() * size.y;
    s.age = 0;
    s.maxAge = FLOW_LIFE * (0.5 + Math.random() * 0.8);
  }

  function renderFlow(ctx, map, dt) {
    const size = map.getSize();

    // Age the image: erase a slice of the alpha everywhere.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0," + (FLOW_FADE * Math.min(3, dt * 60)).toFixed(4) + ")";
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.restore();

    if (!state.flowPool.length) {
      for (let i = 0; i < FLOW_STREAKLETS; i++) {
        state.flowPool.push({ x: 0, y: 0, age: 0, maxAge: 0 });
      }
    }

    const paths = [];
    // The pool is sized for the DEFAULT count, so a reader who asks for
    // more than 100 % would index past the end of it and crash the
    // frame (`s.age` on undefined). Grow it on demand instead: the
    // entries start at maxAge 0, which the age test below treats as
    // dead, so each one respawns itself on its first frame — the same
    // path the initial fill relies on.
    const n = Math.round(FLOW_STREAKLETS * state.qscale * state.density / 100);
    while (state.flowPool.length < n) {
      state.flowPool.push({ x: 0, y: 0, age: 0, maxAge: 0 });
    }
    for (let i = 0; i < n; i++) {
      const s = state.flowPool[i];
      // Age in frame-equivalents at 60 fps, so a fibre's lifetime is a
      // wall-clock figure on every device — the same dt rule the
      // particles follow (`p.age += dt * 60`).
      s.age += dt * 60;
      if (s.age > s.maxAge || s.x < -30 || s.x > size.x + 30 ||
          s.y < -30 || s.y > size.y + 30) {
        respawnFlow(s, size);
        continue;
      }
      const ll = screenToLatLng(s.x, s.y);
      if (!ll) { respawnFlow(s, size); continue; }
      const v = sample(ll[0], ((ll[1] % 360) + 360) % 360);
      if (!v) { respawnFlow(s, size); continue; }
      const u = v[0], w = v[1];
      const sp = Math.hypot(u, w);
      if (sp < 0.12) { respawnFlow(s, size); continue; }
      // (u, -v) is the screen direction of a ground vector.
      const dx = u, dy = -w;
      const len = Math.hypot(dx, dy) || 1;
      // The streaklet moves with the wind: a fast wind draws a fast,
      // long streak, a slow one a short slow streak.
      //
      // It is scaled by dt for the same reason advance() takes a dt:
      // this is a distance PER FRAME at 60 fps, so on a device drawing
      // 4 frames a second the flow would otherwise crawl at a fifteenth
      // of its real pace — the third place in this file where a
      // per-frame constant silently became a speed limit (the dt cap
      // and the particle aging are the other two). Bounded at 3× so a
      // long stall steps the fibres forward instead of teleporting
      // them across the map.
      const step = FLOW_SEG_PX * clamp(sp / MEAN_SPEED_MS, 0.25, 3) *
        Math.min(3, dt * 60);
      const nx = s.x + (dx / len) * step;
      const ny = s.y + (dy / len) * step;
      const sb = (clamp(sp / state.rampMax, 0, 0.9999) * SPEED_BUCKETS) | 0;
      let path = paths[sb];
      if (!path) { path = paths[sb] = new Path2D(); }
      path.moveTo(s.x, s.y);
      path.lineTo(nx, ny);
      s.x = nx;
      s.y = ny;
    }
    ctx.lineCap = "round";
    for (let sb = 0; sb < SPEED_BUCKETS; sb++) {
      const path = paths[sb];
      if (!path) continue;
      const repSpeed = ((sb + 0.5) / SPEED_BUCKETS) * state.rampMax;
      // A dark contrast halo, then a wide bloom, then the core — the
      // same three-pass treatment the streamlines get (see the flush
      // there for why: a pale line on pale ground has nothing to
      // separate it from, and a same-coloured bloom only brightens the
      // ground around it). The flow canvas ages with `destination-out`,
      // so the halo fades away with everything else it cannot
      // accumulate into a dark sheet.
      ctx.strokeStyle = "rgba(8,12,20," + (FLOW_ALPHA * 1.6).toFixed(3) + ")";
      ctx.lineWidth = 4.6;
      ctx.stroke(path);
      ctx.strokeStyle = paintColor(repSpeed, FLOW_ALPHA * 0.30);
      ctx.lineWidth = 4.2;
      ctx.stroke(path);
      ctx.strokeStyle = paintColor(repSpeed, FLOW_ALPHA);
      ctx.lineWidth = 1.6;
      ctx.stroke(path);
    }
  }

  // ── the reader's choices: style, colour, palette ──────────────────────
  //
  // Each one is a real change to the picture, so each one repaints.
  // Switching the style has to CLEAR the canvas: the flow renderer
  // accumulates into it and the others clear it every frame, so a
  // leftover fibre texture would sit under the new style until the first
  // frame erased it.

  function setStyle(id) {
    const want = String(id);
    if (!STYLE_CHOICES.some((s) => s.id === want)) return false;
    if (want === state.style) return true;
    state.style = want;
    storageSet(STYLE_STORE_KEY, want);
    clearCanvas();
    state.arrowsDirty = true;
    paintChoiceRows();
    notifyWindChanged();
    return true;
  }
  function getStyle() {
    return state.style;
  }

  function setColorMode(id) {
    const want = String(id);
    if (!COLOR_CHOICES.some((c) => c.id === want)) return false;
    if (want === state.colorMode) return true;
    state.colorMode = want;
    storageSet(COLOR_STORE_KEY, want);
    clearCanvas();
    state.arrowsDirty = true;
    paintChoiceRows();
    notifyWindChanged();
    return true;
  }
  function getColorMode() {
    return state.colorMode;
  }

  // How MUCH wind. A percentage of the automatic count — see the block
  // above DENSITY_STORE_KEY for why it is not an absolute number.
  //
  // Every path that changes it repaints the marks AND the readout, and
  // announces itself so app.js can rewrite the URL: the share button
  // copies location.href verbatim, so a density that is not in the hash
  // is a density the receiver never asked for.
  function setDensity(pct) {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n)) return false;
    const want = clamp(n, DENSITY_MIN, DENSITY_MAX);
    if (want === state.density) return false;
    state.density = want;
    storageSet(DENSITY_STORE_KEY, String(want));
    ensureParticles();          // particles/streamlines: retune the pool
    state.arrowsDirty = true;   // arrows: the grid key now differs
    paintChoiceRows();          // the slider's own readout
    notifyWindChanged();
    return true;
  }

  function getDensity() {
    return state.density;
  }

  // "The wind changed" — one event for style, colour and density, so
  // app.js needs ONE listener to keep the URL honest. Mirrors the
  // isobar layer's xyzo:isobar-step / -colour / -source trio.
  function notifyWindChanged() {
    try {
      window.dispatchEvent(new window.CustomEvent("xyzo:wind-style"));
    } catch (_) { /* no window (tests): nothing to notify */ }
  }

  // The ramp the wind is painted from, DERIVED at use time (never a
  // stored copy — a copy is a second source of truth and it drifts the
  // moment the palette changes).
  //
  //   colourful  the vivid TURBO scheme, whatever the palette picker
  //              says — the whole point of the mode is that the wind
  //              is findable
  //   speed      the published ramp, recoloured by the palette picker
  //   mono       one ink; the ramp is not used at all (the speed is in
  //              the alpha instead)
  const PALETTE_STORE_KEY = "xyzo.windPalette";

  function recolourWith(ramp, palette) {
    const R = window.RampStyles;
    if (!R || typeof R.recolor !== "function") return ramp;
    // RampStyles.recolor() works on stops keyed by `c`; the wind's are
    // keyed by `ms`. Convert, recolour, and keep the wind's own keys.
    const stops = ramp.map((s) => ({ c: Number(s.ms), rgb: s.rgb }));
    const out = R.recolor(stops, palette);
    return ramp.map((s, i) => ({
      ...s, rgb: (out[i] && out[i].rgb) || s.rgb,
    }));
  }

  // Map the wind's speed stops onto another scheme, keeping their
  // POSITIONS — the speed is what the legend prints and the probe
  // reads, so only the colour may move.
  function rampFromStops(ramp, paletteStops) {
    if (!ramp || !ramp.length || !paletteStops || paletteStops.length < 2) return ramp;
    const hex = (h) => [
      parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
    ];
    const n = paletteStops.length - 1;
    const lo = Number(ramp[0].ms);
    const hi = Number(ramp[ramp.length - 1].ms);
    return ramp.map((s) => {
      const t = hi === lo ? 0 : (Number(s.ms) - lo) / (hi - lo);
      const x = Math.max(0, Math.min(1, t)) * n;
      const i = Math.min(n - 1, Math.floor(x));
      const f = x - i;
      const a = hex(paletteStops[i]);
      const b = hex(paletteStops[i + 1]);
      const rgb = a.map((v, k) =>
        Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("");
      return { ...s, rgb: "#" + rgb };
    });
  }

  function activeRamp(meta) {
    if (!meta || !meta.ramp) return [];
    if (state.colorMode === "colourful") {
      return rampFromStops(meta.ramp, COLORFUL_RAMP);
    }
    if (!state.palette || state.palette === "default" || state.palette === "published") {
      return meta.ramp;
    }
    return recolourWith(meta.ramp, state.palette);
  }

  function setPalette(name) {
    const R = window.RampStyles;
    if (!R || typeof R.recolor !== "function") return false;
    const want = name || "default";
    if (want === state.palette) return true;
    state.palette = want;
    try { localStorage.setItem(PALETTE_STORE_KEY, want); } catch (_) {}
    // Picking a scheme means the reader wants to SEE that scheme, so
    // the mode switches to the one that honours the picker. Leaving it
    // on "colourful" would make the picker look broken: the select
    // would say one thing and the map another.
    if (state.colorMode === "colourful") {
      state.colorMode = "speed";
      storageSet(COLOR_STORE_KEY, "speed");
    }
    if (state.meta) {
      state.ramp = parseRamp(activeRamp(state.meta));
      paintLegendBar(state.meta);
    }
    clearCanvas();
    state.arrowsDirty = true;
    paintChoiceRows();
    return true;
  }
  function getPalette() {
    return state.palette;
  }

  function clearCanvas() {
    if (!state.ctx || !state.map) return;
    const size = state.map.getSize();
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    state.ctx.clearRect(0, 0, size.x, size.y);
  }

  // ── the legend: the speed key, and the two chip rows ─────────────────
  //
  // It lives in `.leaflet-control-layers-list` — the PARENT of the
  // overlay list — because Leaflet empties and rebuilds that list on
  // every layer change, and a legend inside it would be wiped by the
  // first overlay toggle. (The soil and magnetic layers do the same.)
  const LEGEND_ID = "wind-legend";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function buildLegend(meta) {
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return;
    let host = document.getElementById(LEGEND_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = LEGEND_ID;
      host.className = "temp-legend leaflet-control-layers-temp";
      const styleChips = STYLE_CHOICES.map((s) =>
        '<button type="button" class="soil-prop-btn" data-style="' + esc(s.id) +
        '" aria-pressed="false" title="' + esc(s.hint) + '">' + esc(s.label) +
        "</button>").join("");
      const colorChips = COLOR_CHOICES.map((c) =>
        '<button type="button" class="soil-prop-btn" data-color="' + esc(c.id) +
        '" aria-pressed="false" title="' + esc(c.hint) + '">' + esc(c.label) +
        "</button>").join("");
      host.innerHTML =
        '<div class="temp-legend-title"><span>Wind — 10 m, GFS</span></div>' +
        '<div class="mag-switch-label">Style</div>' +
        '<div class="soil-prop-switch" id="wind-style-switch" role="group" ' +
        'aria-label="Wind animation style">' + styleChips + "</div>" +
        '<div class="mag-switch-label">Colour</div>' +
        '<div class="soil-prop-switch" id="wind-color-switch" role="group" ' +
        'aria-label="Wind colour">' + colorChips + "</div>" +
        '<div class="mag-switch-label">Density</div>' +
        '<div class="wind-density-row">' +
        '<input type="range" id="wind-density" class="wind-density-slider" ' +
        'min="' + DENSITY_MIN + '" max="' + DENSITY_MAX + '" step="1" ' +
        'value="' + state.density + '" aria-label="Wind density, percent">' +
        '<input type="number" id="wind-density-num" class="wind-density-num" ' +
        'min="' + DENSITY_MIN + '" max="' + DENSITY_MAX + '" step="1" ' +
        'value="' + state.density + '" aria-label="Wind density, percent">' +
        '<span class="wind-density-unit">%</span>' +
        '<span class="wind-density-count" id="wind-density-count"></span>' +
        "</div>" +
        // The speed tip — populated by paintDensityReadout() only while
        // the animation is struggling. It sits directly under the two
        // controls it is advising about (and under the readout that
        // says WHY: "1,234 dots · 6 fps").
        '<div class="wind-perf-hint" id="wind-perf-hint"></div>' +
        '<div class="temp-legend-scale">' +
        '<div class="temp-legend-bar" id="wind-legend-bar"></div>' +
        "</div>" +
        '<div class="temp-legend-detail" id="wind-legend-detail"></div>' +
        '<div class="temp-legend-foot" id="wind-legend-foot"></div>';
      section.appendChild(host);
      host.querySelectorAll("#wind-style-switch .soil-prop-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          setStyle(btn.getAttribute("data-style"));
        });
      });
      host.querySelectorAll("#wind-color-switch .soil-prop-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          setColorMode(btn.getAttribute("data-color"));
        });
      });
      // DENSITY: a slider AND a number box, because they answer two
      // different questions. The slider is for finding a look by eye —
      // drag until the map reads right. The number is for precision and
      // for typing, which the owner asked for ("a slider or some way to
      // type it in"). Both drive setDensity(), which is the single
      // writer, so the two can never disagree: whatever you type is
      // what the slider shows and what the URL carries.
      //
      // `input` on the range fires per pixel of drag; `change` on the
      // number fires on commit (blur/Enter), not per keystroke — so
      // typing "2" does not immediately clamp to the 25 minimum and
      // eat the rest of the number.
      //
      // STEP IS 1, NOT 5, ON BOTH: a range input SNAPS its value to the
      // nearest step when it is set programmatically, so a step of 5
      // would silently turn a typed 27 into 25 on the slider while the
      // number box still said 27 — two controls disagreeing about one
      // value, which is the exact thing having both is supposed to
      // prevent. One unit of granularity over a 25–400 range is finer
      // than a drag can use anyway; the number box is the precise one.
      const densSlider = host.querySelector("#wind-density");
      const densNum = host.querySelector("#wind-density-num");
      if (densSlider) {
        densSlider.addEventListener("input", () => { setDensity(densSlider.value); });
      }
      if (densNum) {
        densNum.addEventListener("change", () => {
          // An empty box is `Number("") === 0`, which would clamp to
          // the 25 minimum — clearing the field would silently set the
          // lowest density instead of leaving it alone. Put back what
          // is actually in effect.
          if (String(densNum.value).trim() === "") { paintChoiceRows(); return; }
          setDensity(densNum.value);
          // Write the CANONICAL value back unconditionally.
          // setDensity() early-returns when the clamped value equals
          // the current one — so typing 999 while already at 400 would
          // leave "999" on screen — and paintChoiceRows() deliberately
          // skips a focused box (it is called on every keystroke path
          // too). Neither normalises here; this does.
          densNum.value = String(state.density);
          if (densSlider) densSlider.value = String(state.density);
        });
      }
      state.legendMounted = true;
    }
    paintChoiceRows();
    paintDensityReadout();
    paintLegendBar(meta);
  }

  // The density row's live count — the number the owner actually asked
  // for ("how many wind dots"). It reads the REAL count for the current
  // style rather than recomputing the formula, so it can never claim
  // more marks than the map is drawing.
  //
  // Refreshed from ensureParticles() (particles/streamlines, and on
  // resize) and from setDensity(); the arrows and flow branches are
  // derived here because neither keeps a countable pool.
  function paintDensityReadout() {
    // DEGRADE, NEVER THROW. This is a cosmetic readout and it is called
    // from ensureParticles(), which is on the path that SPAWNS the
    // field — so a missing or partial document (a test sandbox, an
    // early call before the DOM exists) must not be able to take the
    // animation down with it. The first version did exactly that: the
    // readout threw, ensureParticles() unwound, and the layer shipped
    // zero particles and a dead probe in a sandbox whose document
    // stub has no getElementById.
    if (typeof document === "undefined" ||
        typeof document.getElementById !== "function") return;
    const el = document.getElementById("wind-density-count");
    if (!el) return;
    const pct = state.density;
    let n;
    if (state.style === "arrows") {
      const size = state.map ? state.map.getSize() : { x: 0, y: 0 };
      const cell = ARROW_MIN_PX / Math.sqrt(pct / 100);
      n = Math.max(0, Math.floor(size.x / cell)) * Math.max(0, Math.floor(size.y / cell));
    } else if (state.style === "flow") {
      n = Math.round(FLOW_STREAKLETS * state.qscale * pct / 100);
    } else {
      n = state.particles.length;
    }
    const animated = state.style !== "arrows";
    const txt = n.toLocaleString() + " " +
      (state.style === "arrows" ? "arrows"
        : state.style === "flow" ? "streaks" : "dots") +
      // …and the frame rate it is managing. This is the number that
      // makes the tip below actionable, and it is the layer's OWN
      // measurement (state.lastFps, recomputed once a second in step()),
      // not a guess. Arrows do not animate, so a fps there would only
      // report the display refresh rate and mislead.
      (animated && state.lastFps > 0 ? " · " + state.lastFps + " fps" : "");
    if (el.textContent !== txt) el.textContent = txt;

    // The tip. Only while it is true: a hint that stays on after the
    // reader has acted is worse than no hint at all.
    const hint = document.getElementById("wind-perf-hint");
    if (hint) {
      const slow = animated && state.lastFps > 0 && state.lastFps < SLOW_FPS;
      const msg = slow
        ? "Slow here — turn overlays off or lower the density for smoother motion."
        : "";
      if (hint.textContent !== msg) hint.textContent = msg;
      hint.classList.toggle("is-on", slow);
    }
  }

  // The active chip in each row, and the density inputs' value.
  //
  // The slider and the number box are BOTH written here rather than
  // each updating itself, so a change made through either one (or
  // through a shared link at boot) leaves them agreeing. setDensity()
  // calls this, and so does buildLegend() on first mount.
  function paintChoiceRows() {
    // Same guard as paintDensityReadout(): this is a repaint of the
    // legend's chrome, and it must never be the reason a style change
    // fails to reach the map.
    if (typeof document === "undefined" ||
        typeof document.getElementById !== "function") return;
    const host = document.getElementById(LEGEND_ID);
    if (!host) return;
    for (const btn of host.querySelectorAll("#wind-style-switch .soil-prop-btn")) {
      const on = btn.getAttribute("data-style") === state.style;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const btn of host.querySelectorAll("#wind-color-switch .soil-prop-btn")) {
      const on = btn.getAttribute("data-color") === state.colorMode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    // The slider and the number box are BOTH written here, so a change
    // made through either one (or through a shared link at boot) leaves
    // them agreeing. setDensity() calls this, and so does buildLegend()
    // on first mount.
    //
    // NO FOCUS GUARD. The first version skipped a focused number box,
    // to protect against being called on every keystroke — but the box
    // commits on `change` (blur/Enter), never on `input`, so there is
    // no per-keystroke path to protect. What the guard actually did was
    // two measurable bugs, both found driving the live control: typing
    // 250 and then dragging the slider left the box saying 250 while
    // the slider said 400 (the commit leaves focus in the box, so the
    // slider's repaint was skipped), and clearing the box left it EMPTY
    // while 400 was still in effect — because the empty-value branch
    // returns through this function, which then refused to write. Two
    // controls disagreeing about one value is the exact thing having
    // both is supposed to prevent.
    const densSlider = host.querySelector("#wind-density");
    const densNum = host.querySelector("#wind-density-num");
    if (densSlider) densSlider.value = String(state.density);
    if (densNum) densNum.value = String(state.density);
  }

  // The speed key. In "mono" mode the marks are ONE colour and the
  // SPEED is in their brightness, so a colour bar would promise a key
  // the map is not using — the legend says so instead.
  //
  // The bar is drawn from the ACTIVE ramp, so it always shows the
  // colours the wind is being painted in: the published one, the vivid
  // one, or whatever the palette picker chose.
  function paintLegendBar(meta) {
    const host = document.getElementById(LEGEND_ID);
    if (!host || !meta) return;
    const bar = host.querySelector("#wind-legend-bar");
    const detail = host.querySelector("#wind-legend-detail");
    const foot = host.querySelector("#wind-legend-foot");
    if (state.colorMode === "mono") {
      if (bar) bar.style.background = "";
      if (detail) {
        detail.textContent = "One colour — the brightness is the speed.";
      }
      if (foot) {
        foot.textContent = "Slow " + Math.round((meta.range_ms ? meta.range_ms[0] : 0) * 2.23694) +
          " mph · fast " + Math.round((meta.range_ms ? meta.range_ms[1] : 0) * 2.23694) + " mph";
      }
      return;
    }
    const stops = (activeRamp(meta) || []).map((s) => s.rgb);
    if (bar && stops.length) {
      bar.style.background = "linear-gradient(to right, " + stops.join(", ") + ")";
    }
    if (detail) {
      detail.textContent = state.colorMode === "colourful"
        ? "Wind speed (mph) — vivid"
        : "Wind speed (mph)";
    }
    if (foot) {
      foot.textContent = "Slow " + Math.round((meta.range_ms ? meta.range_ms[0] : 0) * 2.23694) +
        " mph · fast " + Math.round((meta.range_ms ? meta.range_ms[1] : 0) * 2.23694) + " mph";
    }
  }

  function schedule() {
    if (state.raf || !state.enabled || document.hidden) return;
    state.raf = requestAnimationFrame(step);
  }

  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.lastT = 0;
  }

  // ── Probe ─────────────────────────────────────────────────────────────

  let probeEl = null;
  function ensureProbeEl() {
    if (probeEl && probeEl.isConnected) return probeEl;
    probeEl = document.createElement("div");
    probeEl.className = "wind-probe";
    probeEl.hidden = true;
    probeEl.setAttribute("aria-hidden", "true");
    // The MAP CONTAINER, never the pane: the probe is positioned at
    // latLngToContainerPoint, and a pane child rides Leaflet's pane
    // translate (it persisted after pans → the tooltip sat paneOffset
    // from the cursor — same shape as the city-labels bug). Geology's
    // probe attaches to the container for the same reason. Fall back
    // through pane → body when the host is partial (test stubs) —
    // degrade, never throw.
    let host = null;
    if (state.map && typeof state.map.getContainer === "function") {
      host = state.map.getContainer();
    }
    if (!host || typeof host.appendChild !== "function") {
      host = (state.pane && state.pane.parentNode) || document.body;
    }
    host.appendChild(probeEl);
    return probeEl;
  }

  function updateProbe(latlng, containerPoint) {
    const el = ensureProbeEl();
    const s = sample(latlng.lat, latlng.lng);
    if (!s) { el.hidden = true; return; }
    const sp = Math.sqrt(s[0] * s[0] + s[1] * s[1]);
    // Direction the wind comes FROM, in compass terms.
    const from = (Math.atan2(-s[0], -s[1]) * 180 / Math.PI + 360) % 360;
    el.innerHTML =
      `<strong>${fmtSpeed(sp)}</strong><br>` +
      `<span>from ${compass(from)} (${Math.round(from)}°)</span>`;
    el.style.left = (containerPoint.x + 14) + "px";
    el.style.top = (containerPoint.y + 14) + "px";
    el.hidden = false;
  }
  function hideProbe() { if (probeEl) probeEl.hidden = true; }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  function ensurePane() {
    const map = state.map;
    if (!map.getPane("windPane")) {
      map.createPane("windPane");
      // Above isobars (360) and the temp field (355), below the pin
      // canvas in overlayPane (400) — the flow sits under the news.
      // 379, not 370. The pane stack was full from 345 to 370, so a
      // new GROUND layer (the HWSD soil map) had nowhere to go below
      // the weather animation — anything at 371+ would have drawn OVER
      // the wind streaks. The animation is the topmost weather layer
      // and is already above the earthquake/fault/ocean-current
      // markers, so moving it to 379 (just under the city labels at
      // 380) changes nothing it is already above and frees 370 for a
      // map that belongs in the ground band.
      map.getPane("windPane").style.zIndex = "379";
      map.getPane("windPane").style.pointerEvents = "none";
    }
    if (!state.canvas) {
      const c = document.createElement("canvas");
      c.className = "wind-canvas";
      c.style.position = "absolute";
      c.style.inset = "0";
      c.style.pointerEvents = "none";
      map.getPane("windPane").appendChild(c);
      state.canvas = c;
      state.ctx = c.getContext("2d", { alpha: true });
      state.pane = map.getPane("windPane");
    } else {
      // onRemove hides the canvas rather than destroying it (keeping it
      // avoids a re-allocate on every toggle). Without this line the
      // second time the layer is switched on nothing is drawn and the
      // animation runs against an invisible surface.
      state.canvas.style.display = "";
    }
  }

  function start() {
    if (!state.grid) return;
    ensurePane();
    ensureParticles();
    resize();
    recalibrate();
    schedule();
  }

  // The META alone — 1 KB. The wind-speed field's legend needs the
  // ramp, and asking for it through `ensureRawData()` would drag the
  // 4 MB grid in with it, at boot, for a layer that is OFF by default.
  async function ensureMeta() {
    if (state.meta) return state.meta;
    if (state._metaPromise) return state._metaPromise;
    // THE ARCHIVE (the time machine): when the reader has picked a past
    // moment, the meta comes from the ARCHIVED cycle — the live meta
    // describes today's analysis and its grid says nothing about the
    // field's layout (the archive's own meta does).
    const archiveMeta = window.WeatherArchive && window.WeatherArchive.active()
      ? window.WeatherArchive.metaUrl("wind")
      : null;
    state._metaPromise = fetch(archiveMeta || META_URL)
      .then((r) => { if (!r.ok) throw new Error("meta " + r.status); return r.json(); })
      .then((m) => { state.meta = m; return m; })
      .catch((err) => { state._metaPromise = null; throw err; });
    return state._metaPromise;
  }

  /**
   * THE GRID'S VERSION RIDES ON meta.json — and this is the whole of
   * the "the wind only shows after a hard refresh" report.
   *
   * The grid used to be asked for at a CONSTANT url. The worker wrote it
   * in two steps (truncate + write `u`, then APPEND `v`), so a fetch
   * landing inside that window received a file of exactly HALF the size
   * the check below expects. The check threw, `onAdd`'s catch set
   * `state.enabled = false`, and the wind never started — while that
   * half-file settled into the browser's HTTP cache AND the service
   * worker's data cache under the same unversioned URL, so every later
   * visit was served it again. Only bypassing the cache ever produced a
   * good copy, which is precisely what a hard refresh does.
   *
   * Two defences, because there are two things to beat:
   *
   *  · THE VERSION. meta.json is the one `.json` under /data/, so it is
   *    fetched NETWORK-first even through the service worker — `built`
   *    is therefore current, and `grid.bin?v=<built>` is a new URL on
   *    every publish. A bad copy at the old URL can never be asked for
   *    again, which is what repairs browsers already holding one.
   *  · THE RELOAD. If the size is still wrong, refetch once with every
   *    cache bypassed — that covers a truncated copy that arrived at
   *    THIS version (a writer that was mid-update when we read it).
   *
   * The worker is fixed too (windmap.write_grid now writes a temp file
   * and renames it), but a client that disables itself for the day on a
   * bad byte count is a client that will meet a bad byte count again.
   */
  async function load() {
    if (state.grid) return true;
    if (state._loading) return state._loading;
    state._loading = (async () => {
      const meta = await ensureMeta();
      const g = meta.grid || {};
      const n = (g.rows || 0) * (g.cols || 0);
      if (!n) throw new Error("meta.json carries no grid dimensions");
      const ver = String(meta.built || meta.run_time || "");
      // The archive's grid is immutable and already carries its cycle in
      // the URL, so it needs no ?v= token.
      const archiveGrid = window.WeatherArchive && window.WeatherArchive.active()
        ? window.WeatherArchive.gridUrl("wind")
        : null;
      const gridUrl = archiveGrid || (GRID_URL + (ver ? `?v=${encodeURIComponent(ver)}` : ""));
      const fetchGrid = (opts) =>
        fetch(gridUrl, opts).then((r) => {
          if (!r.ok) throw new Error("grid " + r.status);
          return r.arrayBuffer();
        });

      let buf = await fetchGrid();
      if (buf.byteLength !== n * 4) {
        buf = await fetchGrid({ cache: "reload" });
      }
      if (buf.byteLength !== n * 4) {
        throw new Error(`grid.bin is ${buf.byteLength} bytes, expected ${n * 4}`);
      }
      state.meta = meta;
      state.scale = g.scale || 100;
      state.n = n;
      const all = new Int16Array(buf);
      // Planar: u in [0, n), v in [n, 2n).
      state.u = all.subarray(0, n);
      state.v = all.subarray(n, 2 * n);
      // The whole grid, kept: the wind-SPEED field is the magnitude of
      // this pair, and it reads the same bytes rather than fetching
      // them again.
      state.rawAll = all;
      state.rampMax = (meta.range_ms && meta.range_ms[1]) || 18;
      state.ramp = parseRamp(activeRamp(meta));
      // The legend: the speed key and the two chip rows. It goes in the
      // layers dropdown, so the reader can change the style without
      // hunting for a control.
      try { buildLegend(meta); } catch (_) {}
      // Publish the load only once every field above is in place.
      // `start()` and `_stats()` gate on this, so setting it before the
      // subslices would let the animation begin on a half-built grid.
      state.grid = meta;
      return true;
    })();
    try { return await state._loading; } finally { state._loading = null; }
  }

  function init(map) {
    state.map = map;

    // Layer on/off is driven by the layers-dropdown checkbox, which
    // adds/removes the GridLayer — so hooking add/remove is all the
    // wiring the animation needs.
    map.on("moveend zoomend", function () {
      if (!state.enabled) return;
      anchorCanvas();   // the pane translate changed with the pan
      recalibrate();
      ensureParticles();
    });
    map.on("resize", function () {
      if (!state.enabled) return;
      resize();
      // The screen calibration moves with the viewport, and the flow
      // renderer reads it every stroke.
      recalibrate();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stop();
      else if (state.enabled) schedule();
    });

    // Hover reads the point.
    //
    // Use Leaflet's own mouse event, not a raw listener with
    // offsetX/offsetY. Those are relative to whatever element the
    // event happened on — and the pin canvas is 300 px WIDER than the
    // map and offset by -300, so it is the event target over most of
    // the map. Reading offsetX there gave the wind for a point a third
    // of a screen away from the cursor: the probe said "from WNW" where
    // the field said "from N".
    //
    // Leaflet's event already carries the resolved latlng and the
    // container point.
    map.on("mousemove", function (e) {
      if (!state.enabled) return;
      // HoverInfo "all" mode aggregates every layer's reading into one
      // card — stand down so two boxes don't fight over the cursor.
      if (window.HoverInfo && typeof HoverInfo.suppressesProbes === "function" && HoverInfo.suppressesProbes()) return;
      updateProbe(e.latlng, e.containerPoint);
    });
    map.on("mouseout", hideProbe);
    map.on("movestart", hideProbe);
    if (map.getContainer()) {
      map.getContainer().addEventListener("mouseleave", hideProbe);
    }
  }

  function getTileLayer() {
    if (state.overlay) return state.overlay;
    if (typeof L === "undefined") return null;

    // A transparent GridLayer: it exists to be a citizen of the layers
    // dropdown — it gets the checkbox, the opacity slider and the URL
    // hash for free — while the actual drawing happens on the single
    // full-map canvas in windPane. An overlay that drew its own tiles
    // would pay Leaflet's tile machinery for a field that has no tiles.
    const WindGrid = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        // Call back ASYNCHRONOUSLY. Leaflet inserts the tile only after
        // createTile returns and `_tileReady` only marks it loaded if it
        // already knows about it — a synchronous callback leaves every
        // tile at visibility: hidden (see temp-layer.js).
        setTimeout(() => done(null, tile), 0);
        return tile;
      },
      // L.TileLayer supplies setOpacity; a bare GridLayer does not, and
      // the layers dropdown calls it for every overlay.
      setOpacity(value) {
        const v = clamp(Number(value), 0, 1);
        if (!Number.isFinite(v)) return;
        this.options.opacity = v;
        state.opacity = v;
      },
      onAdd(m) {
        L.GridLayer.prototype.onAdd.call(this, m);
        state.enabled = true;
        load().then((ok) => { if (ok && state.enabled) start(); })
          .catch((e) => { state.enabled = false; if (window.XLog) XLog.warn("WindLayer", e); });
      },
      onRemove(m) {
        state.enabled = false;
        stop();
        hideProbe();
        if (state.canvas) state.canvas.style.display = "none";
        L.GridLayer.prototype.onRemove.call(this, m);
      },
    });

    state.overlay = new WindGrid({
      pane: "tilePane",   // never paints anything; the pane is irrelevant
      opacity: 0.95,
      attribution: "NOAA NCEP GFS",
    });
    // The site's standard palette picker mounts on a layer that offers
    // `setPalette`. The wind's ramp is a VALUE ramp (speed), so it opts
    // in like every other value overlay — the reader picks the colour
    // from the same list they use everywhere else.
    state.overlay.setPalette = (n) => setPalette(n);
    state.overlay.getPalette = () => state.palette;
    return state.overlay;
  }

  // The colour of a wind vector, from the LAYER'S OWN ramp — the same
  // LUT the streamlines are painted from. The exporter uses it so the
  // PNG and the map agree.
  function colorFor(vec) {
    if (!vec) return null;
    const sp = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]);
    const lut = state.ramp;
    if (!lut) return [148, 163, 184];
    const i = clamp(Math.round((sp / state.rampMax) * 255), 0, 255);
    const c = lut[i];
    return [c[0], c[1], c[2]];
  }

  // ── export surface ───────────────────────────────────────────────────
  // Two bands: the eastward (u) and northward (v) components, in m/s.
  // A GIS user wants the components, not the speed — the speed is
  // derivable from them, and the components are what a vector layer in
  // QGIS actually wants.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "wind",
      label: "💨 Wind (GFS)",
      kind: "raster",
      unit: "m/s",
      attribution: "NOAA NCEP GFS — 10 m wind",
      licence: "US Government work (public domain)",
      source: "https://www.ncei.noaa.gov/products/weather-climatic-modeling-global-system",
      get period() { return state.meta ? state.meta.run_time : ""; },
      bands: [
        { name: "wind_u", unit: "m/s" },
        { name: "wind_v", unit: "m/s" },
      ],
      get native() {
        // The META is the source of the grid's shape — it is 0.25° now
        // (721 x 1440), and a hardcoded 360 x 181 here would export a
        // wind field at the wrong resolution with the right values in
        // it. The fallback is only for a meta that says nothing.
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 360, rows: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360,
        });
      },
      isActive: () => !!state.u && !!state.meta,
      sample(lat, lon) {
        const s = sample(lat, lon);
        if (!s) return null;
        return s;
      },
      color: colorFor,
    });
  }

  window.WindLayer = {
    getTileLayer,
    init,
    // THE ARCHIVE (the time machine): drop the cached grid and meta so
    // the layer fetches again — from the ARCHIVE when a past moment is
    // selected.
    resetForArchive() {
      state._metaPromise = null;
      state.gridPromise = null;
      state.meta = null;
      state.grid = null;
    },
    isEnabled: () => state.enabled,
    LAYER_NAME,
    DATA_URL: BASE,
    // Diagnostics for the debug page and the tests: the live particle
    // count, the frame rate and the adaptive quality, so a screenshot
    // can be read as a measurement rather than a guess.
    _state: state,
    // ── how the wind is drawn and coloured ─────────────────────────────
    // The reader's choices, persisted, and each one repaints.
    setStyle,
    getStyle,
    STYLE_CHOICES,
    // How MUCH wind — a percentage of the automatic count. Exported
    // with its bounds and default so the URL grammar and the legend's
    // slider bounds come from the layer rather than being retyped, the
    // same reason DEFAULT_STYLE and DEFAULT_COLOR are exported.
    setDensity,
    getDensity,
    DEFAULT_DENSITY,
    DENSITY_MIN,
    DENSITY_MAX,
    // The defaults, so a reader can tell what a link is NOT saying.
    //
    // NOTE on omission: unlike the other segments, `wind=` is written
    // whenever the wind layer is ON, defaults and all — the same rule
    // `iso=` follows, for the same reason. Omitting it here would leave
    // the READER's stored style, colour or density to decide what the
    // sender was looking at, so a sender on the default would hand a
    // reader who had once chosen "particles" a map opening in particles.
    DEFAULT_STYLE,
    DEFAULT_COLOR,
    setColorMode,
    getColorMode,
    COLOR_CHOICES,
    // The site's standard palette picker. It recolours a VALUE ramp and
    // the wind's ramp is one (speed), so the wind opts into the same
    // picker every other value overlay uses.
    setPalette,
    getPalette,
    // The raw u/v grid, for the wind-SPEED field: it is the same bytes
    // the animation is using, and the speed is their magnitude — so the
    // field is computed from what is ALREADY in the browser rather than
    // published and fetched twice.
    getRawData() {
      if (!state.meta || !state.u || !state.v) return null;
      return {
        meta: state.meta,
        u: state.u,
        v: state.v,
        scale: state.scale,
        n: state.n,
      };
    },
    // The same, but it LOADS the grid first if it has not been loaded
    // — the speed field can be switched on before the animation has
    // ever run, and there is still only ever ONE fetch of grid.bin.
    async ensureMeta() { return ensureMeta(); },
    async ensureRawData() {
      if (!state.rawAll) await load();
      if (!state.rawAll || !state.meta) {
        throw new Error("wind data unavailable");
      }
      return { meta: state.meta, raw: state.rawAll };
    },
    // HoverInfo "all" mode: a one-line reading for the cursor position.
    sampleAt(latlng) {
      if (!state.enabled || !state.meta) return null;
      const s = sample(latlng.lat, latlng.lng);
      if (!s) return null;
      const sp = Math.sqrt(s[0] * s[0] + s[1] * s[1]);
      const from = (Math.atan2(-s[0], -s[1]) * 180 / Math.PI + 360) % 360;
      return fmtSpeed(sp) + " from " + compass(from);
    },
    // Pin the adaptive quality — the guard sheds particles on a device
    // that cannot keep up, which is correct in production but makes a
    // headless screenshot unrepresentative of what a GPU browser shows.
    setQuality: (q) => {
      state.qscale = clamp(Number(q) || 1, 0.4, 1);
      state.qLocked = true;
      ensureParticles();
      return state.qscale;
    },
    autoQuality: () => { state.qLocked = false; },
    registerExport,
    // The wind VECTOR at a point, in m/s: [eastward, northward].
    //
    // The wind-SPEED field is the magnitude of this same pair, and it
    // used to compute that magnitude on a PRE-DERIVED grid — which is
    // not the same number: bilinear(u,v) then hypot is not the same as
    // bilinear(hypot(u,v)). The two layers printed 2.3 m/s and 2.4 m/s
    // for the same air on the same screen. The speed field now reads
    // the vector through this sampler, so there is ONE number.
    sampleVector: (lat, lng) => sample(lat, lng),
    // Diagnostics: used by public_html/tests and the debug page.
    _sample: (lat, lng) => sample(lat, lng),
    // The motion, without the drawing — the physics the particles are
    // supposed to follow. _advance() returns where a particle ends up
    // after dt seconds and how far it travelled on the ground.
    _advance: (lat, lng, dt) => advance(lat, lng, dt),
    _speedScale: () => state.speedScale,
    _stats: () => ({
      enabled: state.enabled,
      particles: state.particles.length,
      fps: state.lastFps,
      quality: +state.qscale.toFixed(2),
      loaded: !!state.grid,
      runTime: state.meta && state.meta.run_time,
      speedScale: state.speedScale,
    }),
  };

  // Register the export surface on load. It reads `state` lazily, so
  // the module does not need the grid to have arrived yet.
  registerExport();
})();
