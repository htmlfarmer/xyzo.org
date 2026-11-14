/* ═══════════════════════════════════════════════════════════════════════
   LIVE ocean currents — the field ANIMATED, not a picture.

   The site already ships a static frame of the NOAA SOS "Perpetual
   Ocean" current field. That is a PICTURE: it shows where the warm
   water is, but it cannot show FLOW, because a picture carries no
   direction. This layer carries the DIRECTION — the published u/v pair
   from OSCAR (scripts/ocean_currents_build.py) — and advects
   particles along it, so the map shows the current running.

   The physics are the wind layer's physics, and they are not
   interchangeable by accident:
     · longitude WRAPS, it does not reject;
     · the column past the last one WRAPS, it does not clamp;
     · a degree of longitude shrinks by cos(lat), so the eastward part
       of the step is divided by it;
     · the trail is trimmed by LENGTH, never by a frame count;
     · `schedule()` runs from `finally`, so one bad particle can never
       freeze the animation;
     · the canvas is re-anchored on every pan (the pane's translate
       persists after a drag, which would otherwise carry the whole
       field off its geography).

   Source: OSCAR Sea Surface Velocity (ESR / NASA PO.DAAC), public
   domain, served through NOAA CoastWatch.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/ocean";
  const META_URL = BASE + "/meta.json";
  const GRID_URL = BASE + "/grid.bin";
  const PANE = "oceanCurrentPane";
  // Above the rivers (365), the wind-speed wash (366), the faults (367)
  // and the earthquakes (368), below the wind ANIMATION (370) and the
  // pins (400).
  const PANE_Z = 369;
  const STORE_KEY = "xyzo.oceanCurrentLayer";
  const PROBE_STORE_KEY = "xyzo.oceanCurrentProbe";
  // THE NAME SAYS WHAT IT IS.
  //
  // It used to read "Ocean currents (live)", and the published field
  // was a composite from **26 September 2014** — the ERDDAP mirror
  // that serves OSCAR was loaded in February 2015 and carries nothing
  // newer, so a daily timer had been re-publishing the same twelve-
  // year-old field since the overlay shipped. The legend now shows
  // the composite's own date, so the name does not have to make a
  // claim the data cannot support.
  //
  // The URL SLUG is still "ocean-currents-live": it is the published
  // contract (the owner's own links and the Earth-portrait preset use
  // it) and an identifier is not a claim of freshness.
  const LAYER_NAME = "🌊 Ocean currents (OSCAR)";
  // MUST MATCH MAX_AGE_DAYS in scripts/ocean_currents_build.py — the
  // build refuses to publish a composite older than this, and the
  // legend says the same thing when one is already published.
  const MAX_AGE_DAYS = 45;

  const M_PER_DEG = 111320;
  const TARGET_PX_PER_SEC = 22;
  const MAX_STREAK_PX = 34;
  const TRAIL_PX = 60;
  const TRAIL_MAX = 44;
  const PARTICLE_COUNT = 1400;
  // The ARROWS style: one static glyph per cell — the synoptic reading,
  // length = speed, head = direction. The wind layer draws the same
  // way, and the physics is identical, so it is the same code.
  const ARROW_CELL_PX = 46;
  // The MEDIAN ocean surface current is 0.11 m/s, so the wind layer's
  // 0.2 m/s cut-off would leave the whole ocean blank. Anything that
  // is moving at all gets an arrow.
  const ARROW_MIN_MS = 0.02;
  const STYLE_CHOICES = [
    { id: "streamlines", label: "Streamlines", hint: "Trailing streaks — the flow reads as motion" },
    { id: "arrows", label: "Arrows", hint: "Static arrows — speed and direction at a glance" },
  ];
  const DEFAULT_STYLE = "streamlines";
  const STYLE_STORE_KEY = "xyzo.oceanCurrentStyle";

  const state = {
    map: null,
    layer: null,
    canvas: null,
    ctx: null,
    enabled: false,
    opacity: 0.85,
    style: DEFAULT_STYLE,
    particles: [],
    raf: 0,
    lastT: 0,
    grid: null,
    meta: null,
    u: null,
    v: null,
    n: 0,
    scale: 100,
    maxMs: 1.5,
    ramp: null,
    dpr: 1,
    probeMode: false,
    probeEl: null,
  };

  function log(msg, a, b) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn("ocean-current: " + msg, a, b);
  }
  function storageGet(key, dflt) {
    try { return localStorage.getItem(key) ?? dflt; } catch (_) { return dflt; }
  }
  function storageSet(key, val) {
    try { localStorage.setItem(key, val); } catch (_) {}
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── data ────────────────────────────────────────────────────────────
  let loadPromise = null;
  function loadData() {
    if (state.grid) return Promise.resolve(state.grid);
    if (loadPromise) return loadPromise;
    loadPromise = Promise.all([
      fetch(META_URL, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error("meta " + r.status);
        return r.json();
      }),
      fetch(GRID_URL, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error("grid " + r.status);
        return r.arrayBuffer();
      }),
    ]).then(([meta, buf]) => {
      const g = meta.grid || {};
      const n = (g.rows || 0) * (g.cols || 0);
      if (!n || buf.byteLength !== n * 4) {
        throw new Error("grid.bin is " + buf.byteLength + " bytes, expected " + n * 4);
      }
      const all = new Int16Array(buf);
      state.meta = meta;
      state.n = n;
      state.scale = g.scale || 100;
      state.u = all.subarray(0, n);
      state.v = all.subarray(n, 2 * n);
      state.maxMs = (meta.range_ms && meta.range_ms[1]) || 1.5;
      // The ramp comes from the published meta when there is one, and
      // otherwise falls back to a speed ramp of our own.
      state.ramp = (meta.ramp || []).map((s) => ({ c: Number(s.ms != null ? s.ms : s.c), rgb: s.rgb }));
      if (!state.ramp.length) {
        // BRIGHT AT BOTH ENDS — the same lesson the WIND taught: a ramp
        // that starts near-black is invisible on a dark satellite, and
        // the SLOW half of an ocean is most of it (the median surface
        // current is 0.11 m/s). A ramp whose first stop is #0b1020
        // painted the great majority of the ocean in a colour that is
        // indistinguishable from the background, so the animation ran
        // and the reader saw nothing.
        state.ramp = [
          { c: 0.0, rgb: "#22d3ee" }, { c: 0.12, rgb: "#0ea5e9" },
          { c: 0.3, rgb: "#4ade80" }, { c: 0.6, rgb: "#a3e635" },
          { c: 1.0, rgb: "#facc15" }, { c: 1.6, rgb: "#f97316" },
          { c: 2.4, rgb: "#ef4444" }, { c: 3.3, rgb: "#f0abfc" },
        ];
      }
      state.grid = g;
      // The wet-cell list is built from the grid, so a stale one (or
      // an empty one cached before the data arrived) must go.
      wetCells = null;
      // The legend's speed key is built from the PUBLISHED ramp, so it
      // is re-mounted now that the ramp is here.
      mountLegend();
      loadPromise = null;
      return g;
    }).catch((e) => { loadPromise = null; throw e; });
    return loadPromise;
  }

  // ── sampling ────────────────────────────────────────────────────────
  // Bilinear in geographic space. Longitude wraps; the column past the
  // last one wraps too; the latitude axis clamps, because the pole is
  // a real edge.
  function sample(lat, lng) {
    const g = state.grid;
    if (!g) return null;
    const lon = ((((lng - g.lon_min) % 360) + 360) % 360) + g.lon_min;
    const gx = (lon - g.lon_min) / g.lon_step;
    const gy = (lat - g.lat_min) / g.lat_step;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = (x0 + 1) % g.cols, y1 = Math.min(y0 + 1, g.rows - 1);
    const fx = gx - x0, fy = gy - y0;
    const u00 = state.u[y0 * g.cols + x0], u10 = state.u[y0 * g.cols + x1];
    const u01 = state.u[y1 * g.cols + x0], u11 = state.u[y1 * g.cols + x1];
    const v00 = state.v[y0 * g.cols + x0], v10 = state.v[y0 * g.cols + x1];
    const v01 = state.v[y1 * g.cols + x0], v11 = state.v[y1 * g.cols + x1];
    const u = (u00 * (1 - fx) + u10 * fx) * (1 - fy) + (u01 * (1 - fx) + u11 * fx) * fy;
    const v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    return [u / state.scale, v / state.scale];
  }

  function colorFor(ms) {
    const ramp = state.ramp || [];
    if (!ramp.length) return "#ffffff";
    const lo = ramp[0].c, hi = ramp[ramp.length - 1].c;
    const c = Math.max(lo, Math.min(hi, ms));
    let a = ramp[0], b = ramp[ramp.length - 1];
    for (let i = 0; i < ramp.length - 1; i++) {
      if (c >= ramp[i].c && c <= ramp[i + 1].c) { a = ramp[i]; b = ramp[i + 1]; break; }
    }
    const f = b.c === a.c ? 0 : (c - a.c) / (b.c - a.c);
    const hx = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const ca = hx(a.rgb), cb = hx(b.rgb);
    const m = (j) => Math.round(ca[j] + (cb[j] - ca[j]) * f);
    return "rgb(" + m(0) + "," + m(1) + "," + m(2) + ")";
  }

  // ── canvas ──────────────────────────────────────────────────────────
  function ensurePane(map) {
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
    return map.getPane(PANE);
  }

  function ensureCanvas(map) {
    if (state.canvas) return;
    const pane = ensurePane(map);
    const canvas = document.createElement("canvas");
    canvas.className = "xyzo-ocean-current";
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    pane.appendChild(canvas);
    state.canvas = canvas;
    state.ctx = canvas.getContext("2d");
    resize(map);
  }

  // The pane's translate PERSISTS after a drag (only a setView/zoom
  // zeroes it), so the canvas has to be re-anchored on every move or
  // the whole field rides away from its geography.
  function anchorCanvas(map) {
    const canvas = state.canvas;
    if (!canvas || !map || typeof map.containerPointToLayerPoint !== "function") return;
    const a = map.containerPointToLayerPoint([0, 0]);
    canvas.style.left = a.x + "px";
    canvas.style.top = a.y + "px";
    canvas.style.right = "auto";
    canvas.style.bottom = "auto";
  }

  function resize(map) {
    if (!state.canvas) return;
    const size = map.getSize();
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    state.canvas.width = Math.max(1, Math.round(size.x * state.dpr));
    state.canvas.height = Math.max(1, Math.round(size.y * state.dpr));
    state.canvas.style.width = size.x + "px";
    state.canvas.style.height = size.y + "px";
    state.w = size.x;
    state.h = size.y;
  }

  // The WET cells — the grid positions where the current is actually
  // moving. Built once from the grid.
  //
  // Seeding by picking a random SCREEN pixel and unprojecting it was
  // hopeless: the pointer's view is often mostly land, and a particle
  // seeded on land (or in a still patch) was rejected — so a view over
  // a continent seeded almost nothing and the animation looked broken
  // while running perfectly.
  let wetCells = null;
  function buildWetCells() {
    // ONLY a BUILT list may be cached. An EMPTY array is truthy, so
    // caching "nothing yet" would poison the list FOREVER: the first
    // call comes from the moveend handler, which fires BEFORE the grid
    // has loaded, and every later call would return the empty list —
    // so the layer switched on by a preset or a link seeded NO
    // particles at all, while the same layer switched on by a click
    // (after the data had arrived) worked.
    if (wetCells && wetCells.length) return wetCells;
    const g = state.grid;
    if (!g || !state.u) return [];
    wetCells = [];
    for (let row = 0; row < g.rows; row++) {
      for (let col = 0; col < g.cols; col++) {
        const i = row * g.cols + col;
        const u = state.u[i] / state.scale;
        const v = state.v[i] / state.scale;
        if (Math.hypot(u, v) < 0.02) continue;
        wetCells.push(i);
      }
    }
    return wetCells;
  }

  function seed(map) {
    const p = { lat: 0, lng: 0, hist: [], life: 0 };
    const cells = buildWetCells();
    if (!cells.length) return null;
    // Prefer a wet cell that is ON SCREEN; fall back to any wet cell
    // (the wind layer's field is global, so a particle off screen still
    // animates and comes into view when the reader pans).
    for (let tries = 0; tries < 24; tries++) {
      const i = cells[(Math.random() * cells.length) | 0];
      const g = state.grid;
      const row = Math.floor(i / g.cols);
      const col = i % g.cols;
      const lat = g.lat_min + row * g.lat_step;
      const lng = g.lon_min + col * g.lon_step;
      let pt = null;
      try { pt = map.latLngToContainerPoint([lat, lng]); } catch (_) { pt = null; }
      if (!pt) continue;
      const onScreen = pt.x > -60 && pt.y > -60 &&
        pt.x < (state.w || 0) + 60 && pt.y < (state.h || 0) + 60;
      if (!onScreen && tries < 16) continue;
      p.lat = lat;
      p.lng = lng;
      return p;
    }
    return null;
  }

  function ensureParticles(map) {
    const want = PARTICLE_COUNT;
    let guard = 0;
    while (state.particles.length < want && guard < want * 3) {
      const p = seed(map);
      guard++;
      if (!p) break;
      state.particles.push(p);
    }
  }

  // The screen scale, so the visual speed of the field does not change
  // with the zoom.
  function pxPerDeg(map) {
    try {
      const c = map.getCenter();
      const a = map.latLngToContainerPoint([c.lat, c.lng]);
      const b = map.latLngToContainerPoint([c.lat + 1, c.lng]);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      return d > 0.0001 ? d : 1;
    } catch (_) { return 1; }
  }

  // ── the ARROWS style ────────────────────────────────────────────────
  // A static glyph per cell: the shaft's LENGTH carries the speed and
  // its HEAD the direction, so the picture reads the way a synoptic
  // chart does. The wind layer draws it the same way.
  function renderArrows(ctx, map) {
    const size = map.getSize();
    const cell = ARROW_CELL_PX;
    for (let y = cell / 2; y < size.y; y += cell) {
      for (let x = cell / 2; x < size.x; x += cell) {
        const ll = map.containerPointToLatLng([x, y]);
        if (!ll) continue;
        const s = sample(ll.lat, ll.lng);
        if (!s) continue;
        const u = s[0], v = s[1];
        const sp = Math.hypot(u, v);
        if (sp < ARROW_MIN_MS) continue;
        // On a Web Mercator screen the direction of a ground vector is
        // (u, -v): east is right, north is up.
        const dx = u, dy = -v;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const f = Math.max(0, Math.min(1, sp / (state.maxMs || 1.5)));
        const L = cell * (0.30 + 0.55 * f);
        const hx = x + ux * L * 0.5, hy = y + uy * L * 0.5;
        const tx = x - ux * L * 0.5, ty = y - uy * L * 0.5;
        ctx.strokeStyle = colorFor(sp);
        ctx.lineWidth = 1 + 1.8 * f;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        // The head: two barbs back from the tip.
        const bl = L * 0.36;
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - ux * bl + uy * bl * 0.62, hy - uy * bl - ux * bl * 0.62);
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - ux * bl - uy * bl * 0.62, hy - uy * bl + ux * bl * 0.62);
        ctx.stroke();
      }
    }
  }

  function step(now) {
    state.raf = 0;
    if (!state.enabled) return;
    if (document.hidden) { state.lastT = 0; return; }
    const map = state.map;
    const ctx = state.ctx;
    if (!map || !ctx || !state.grid) { schedule(); return; }
    try {
      const dt = state.lastT ? Math.min((now - state.lastT) / 1000, 0.05) : 1 / 60;
      state.lastT = now;
      resize(map);
      anchorCanvas(map);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, state.w, state.h);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = Math.max(0.15, Math.min(1, state.opacity));

      if (state.style === "arrows") {
        // The ARROWS style is a STATIC reading of the field — no
        // particles and no trails. The legend has offered the chip
        // since the layer landed and it used to do NOTHING, because
        // nothing ever read state.style.
        renderArrows(ctx, map);
      } else {
        renderStreamlines(ctx, map, dt);
      }
    } catch (err) {
      log("frame failed", err);
    } finally {
      schedule();
    }
  }

  // The STREAMLINES style: particles advected along the field, each
  // leaving a trail trimmed by LENGTH.
  function renderStreamlines(ctx, map, dt) {
    const scale = pxPerDeg(map);
    const speedScale = TARGET_PX_PER_SEC * dt / scale;
    const maxMs = state.maxMs || 1.5;

    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      const s = sample(p.lat, p.lng);
      if (!s) continue;
      const u = s[0], v = s[1];
      const sp = Math.hypot(u, v);
      if (sp < 0.005) {
        p.life += 1;
        if (p.life > 120) { state.particles.splice(i, 1); i--; }
        continue;
      }
      const cosLat = Math.max(Math.cos((p.lat * Math.PI) / 180), 0.05);
      const frac = Math.min(1, sp / maxMs);
      const stepDeg = speedScale * (0.3 + 0.7 * frac);
      const dLng = ((u / sp) * stepDeg) / cosLat;
      const dLat = (v / sp) * stepDeg;
      const nLat = p.lat + dLat;
      const nLng = p.lng + dLng;

      let pt = null;
      try { pt = map.latLngToContainerPoint([nLat, nLng]); } catch (_) { pt = null; }
      if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
      if (pt.x < -60 || pt.y < -60 || pt.x > state.w + 60 || pt.y > state.h + 60) {
        const np = seed(map);
        if (np) state.particles[i] = np;
        continue;
      }

      p.hist.push(pt.x, pt.y);
      let acc = 0;
      const nh = p.hist.length / 2;
      for (let k = nh - 1; k > 0; k--) {
        acc += Math.hypot(p.hist[k * 2] - p.hist[(k - 1) * 2],
                          p.hist[k * 2 + 1] - p.hist[(k - 1) * 2 + 1]);
        if (acc >= TRAIL_PX) { p.hist.splice(0, (k - 1) * 2); break; }
      }
      while (p.hist.length > TRAIL_MAX * 2) p.hist.splice(0, 2);

      const len = p.hist.length;
      if (len >= 4) {
        const x1 = p.hist[len - 2], y1 = p.hist[len - 1];
        const x0 = p.hist[0], y0 = p.hist[1];
        let dx = x1 - x0, dy = y1 - y0;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) {
          const cap = Math.min(d, MAX_STREAK_PX);
          dx = (dx / d) * cap; dy = (dy / d) * cap;
          ctx.strokeStyle = colorFor(sp);
          ctx.lineWidth = 1.4 + 2.2 * frac;
          ctx.beginPath();
          ctx.moveTo(x1 - dx, y1 - dy);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }

      p.lat = nLat;
      p.lng = nLng;
      p.life = 0;
    }
  }

  function schedule() {
    if (!state.enabled) return;
    // A HIDDEN TAB MUST NOT HOLD A FRAME.
    //
    // Firefox KEEPS FIRING requestAnimationFrame in a background tab —
    // throttled to about 1 Hz — where Chrome suspends it entirely. So
    // the `document.hidden` branch in step() used to run on the first
    // background frame, RETURN WITHOUT CALLING schedule(), and the rAF
    // chain was DEAD for good: the reader switched tabs, came back, and
    // the currents were frozen forever. Chrome never noticed, because
    // its suspended rAF means step() never runs at all while hidden.
    //
    // The wind layer has had this guard and a visibilitychange handler
    // since 2026-10-29; this layer was written later and missed both.
    if (document.hidden) return;
    if (state.raf) return;
    state.raf = requestAnimationFrame(step);
  }

  // Pause WITHOUT disabling: the layer stays on, the canvas keeps its
  // last picture, and the frame chain restarts the moment the tab is
  // seen again.
  function pause() {
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    state.lastT = 0;
  }

  function start(map) {
    ensureCanvas(map);
    if (!state.canvas) return;
    state.enabled = true;
    ensureParticles(map);
    state.lastT = 0;
    schedule();
  }

  function stop() {
    state.enabled = false;
    pause();
    // The probe reads a layer that is no longer on the map — it must
    // go with it.
    hideProbe();
    if (state.ctx && state.canvas) {
      state.ctx.setTransform(1, 0, 0, 1, 0, 0);
      state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    }
  }

  // ── the layers-control citizen ──────────────────────────────────────
  // A transparent L.Layer that owns the pane and the canvas: the
  // checkbox, the opacity slider and the URL hash all come from it for
  // free, and the drawing happens on the one canvas.
  function getTileLayer() {
    if (state.layer) return state.layer;
    if (typeof L === "undefined") return null;
    const NullLayer = L.Layer.extend({
      onAdd(map) {
        state.map = map;
        ensurePane(map);
        ensureCanvas(map);
        state.enabled = true;
        storageSet(STORE_KEY, "1");
        loadData().then(() => {
          if (state.enabled) start(map);
        }).catch((e) => log("load failed", e));
      },
      onRemove() {
        state.enabled = false;
        stop();
        storageSet(STORE_KEY, "0");
      },
      setOpacity(v) { setOpacity(v); },
      getOpacity() { return getOpacity(); },
    });
    state.layer = new NullLayer();
    state.layer.setOpacity = (v) => setOpacity(v);
    state.layer.getOpacity = () => getOpacity();
    return state.layer;
  }

  function setOpacity(v) {
    state.opacity = v;
    if (state.ctx) state.ctx.globalAlpha = Math.max(0.15, Math.min(1, v));
  }
  function getOpacity() { return state.opacity; }

  function init(map) {
    state.map = map;
    ensurePane(map);
    if (map.on) {
      map.on("moveend zoomend resize", () => {
        anchorCanvas(map);
        if (state.enabled) ensureParticles(map);
      });
      // The PROBE. The legend has shipped a "Probe" button since the
      // layer landed, but nothing ever CALLED showProbe() — arming it
      // did nothing at all, and the button was a lie in the UI. It is
      // wired here, to Leaflet's own mouse event, so it reads the
      // point under the cursor and not the offsets of whatever element
      // the event happened on.
      map.on("mousemove", (e) => {
        if (!state.probeMode || !state.enabled) return;
        // The hover HUD owns the cursor in "Everything" mode; two boxes
        // must not fight over the same patch of screen.
        if (window.HoverInfo && typeof window.HoverInfo.suppressesProbes === "function" &&
            window.HoverInfo.suppressesProbes()) return;
        showProbe(e.latlng, e.containerPoint);
      });
      map.on("click", (e) => {
        if (!state.probeMode || !state.enabled) return;
        showProbe(e.latlng, e.containerPoint);
      });
      map.on("mouseout", () => { if (state.probeMode) hideProbe(); });
    }
    // THE TAB CAME BACK. Firefox keeps firing requestAnimationFrame in
    // a background tab (throttled to ~1 Hz), so the frame chain used to
    // die there and never restart: the reader switched tabs, came back,
    // and the currents were frozen for good. Chrome suspends rAF
    // entirely, which is why only Firefox showed it.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pause();
      else if (state.enabled) { state.lastT = 0; schedule(); }
    });
    const saved = storageGet(STYLE_STORE_KEY, DEFAULT_STYLE);
    state.style = saved || DEFAULT_STYLE;
    // The reader's choice is remembered — the style AND the armed
    // probe — because an overlay that resets itself on every reload is
    // an overlay nobody switches.
    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";
    // The legend (the speed key, the Probe button, the style chips).
    waitForLayersControl();
    try {
      const s = storageGet(STORE_KEY, "0");
      if (s === "1") {
        const layer = getTileLayer();
        if (layer && map.hasLayer) map.addLayer(layer);
      }
    } catch (_) {}
  }

  function setEnabled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, on ? "1" : "0");
    if (on) { loadData().then(() => start(state.map)).catch(() => {}); }
    else stop();
  }

  // An ARMED probe owns the click, exactly like the temperature and
  // magnetic probes: a tap reads the current under the cursor instead
  // of opening the submitter. app.js's click-to-submit guard checks
  // this.
  function blocksClick() { return !!(state.enabled && state.probeMode); }

  // ── the probe ───────────────────────────────────────────────────────
  // It must read Leaflet's `e.latlng`, never `e.offsetX/offsetY`: the
  // pin canvas is 300 px wider than the map and offset by -300, so the
  // offsets read 300 px too big.
  function sampleAt(latlng) {
    if (!state.grid || !latlng) return null;
    const s = sample(latlng.lat, latlng.lng);
    if (!s) return null;
    const u = s[0], v = s[1];
    const sp = Math.hypot(u, v);
    if (sp < 0.005) return null;
    // METRES PER SECOND, and the direction it is going TOWARDS.
    const bearing = (Math.atan2(u, v) * 180) / Math.PI;
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const dir = dirs[Math.round(((bearing + 360) % 360) / 22.5) % 16];
    return "Current " + sp.toFixed(2) + " m/s (" + (sp * 3.6).toFixed(1) +
      " km/h) towards " + dir;
  }

  function showProbe(latlng, containerPoint) {
    if (!state.probeMode) return;
    const text = sampleAt(latlng);
    if (!state.probeEl) {
      state.probeEl = document.createElement("div");
      state.probeEl.className = "ocean-current-probe";
      document.body.appendChild(state.probeEl);
    }
    if (!text) { state.probeEl.style.display = "none"; return; }
    state.probeEl.textContent = text;
    // The card is `position: fixed` and its CSS offsets it from the
    // cursor, so it needs the CURSOR's position, not the container's.
    if (containerPoint) {
      state.probeEl.style.left = containerPoint.x + "px";
      state.probeEl.style.top = containerPoint.y + "px";
    }
    state.probeEl.style.display = "block";
  }
  function hideProbe() {
    if (state.probeEl) state.probeEl.style.display = "none";
  }

  // ── legend ──────────────────────────────────────────────────────────
  //
  // THE PROVENANCE, IN THE LEGEND.
  //
  // The field's date is the reader's business: an overlay that says
  // "live" must be able to show how live it is. The published meta
  // carries the composite's own date, and the AGE is computed HERE
  // rather than read from the meta — so a meta published days ago
  // still tells the truth today.
  function ageInDays(iso) {
    const t = Date.parse(iso + "T00:00:00Z");
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function humanAge(days) {
    if (days == null) return "unknown age";
    if (days <= 0) return "today";
    if (days === 1) return "1 day";
    if (days < 60) return days + " days";
    if (days < 730) return Math.round(days / 30.44) + " months";
    return (days / 365.25).toFixed(1).replace(/\.0$/, "") + " years";
  }

  function provenanceHtml() {
    const m = state.meta || {};
    const iso = m.source_date;
    if (!iso) return "";
    const days = ageInDays(iso);
    const stale = days == null || days > MAX_AGE_DAYS;
    return (
      '<div class="oc-legend-date' + (stale ? " is-stale" : "") + '"' +
      ' title="The published composite is from ' + escapeHtml(iso) + '">' +
      escapeHtml(iso) + " · " + escapeHtml(humanAge(days)) +
      (stale ? " old — NOT live" : " old — current") +
      "</div>"
    );
  }

  // THE COASTAL CAVEAT.
  //
  // The currents stop short of the coast — the owner saw it off
  // Africa — and it is the SOURCE, not this layer: OSCAR is an
  // altimetry inversion, and satellite altimetry has no valid
  // solution in shallow, river-influenced water. Every altimetry-
  // based surface-current product carries the same hole (the daily
  // NOAA CoastWatch geostrophic product was measured on 2026-11-04
  // and its Gulf of Guinea coverage is cell-for-cell identical), so
  // the note belongs in the legend rather than in a bug report.
  const COASTAL_NOTE =
    "The currents stop short of the coast: satellite altimetry has no " +
    "solution in shallow water.";

  function mountLegend() {
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!list) return false;
    const old = document.getElementById("ocean-current-legend");
    if (old) old.remove();
    const host = document.createElement("div");
    host.id = "ocean-current-legend";
    host.className = "ocean-current-legend";
    const stops = (state.ramp || []).map((s) =>
      '<span class="oc-stop" style="background:' + s.rgb + '" title="' +
      s.c + ' m/s"></span>').join("");
    host.innerHTML =
      '<div class="oc-legend-title"><span>' +
      escapeHtml(LAYER_NAME.replace(/^[^A-Za-z0-9]+/, "")) + '</span>' +
      '<button type="button" class="oc-probe-toggle' + (state.probeMode ? " active" : "") +
      '" id="ctrl-oc-probe-toggle" aria-pressed="' + (state.probeMode ? "true" : "false") + '">' +
      (state.probeMode ? "Probe: On" : "Probe") + "</button></div>" +
      provenanceHtml() +
      '<div class="oc-style-row" role="group" aria-label="Current style">' +
      STYLE_CHOICES.map((c) =>
        '<button type="button" class="oc-style-btn soil-prop-btn' + (state.style === c.id ? " active" : "") +
        '" data-style="' + c.id + '" title="' + escapeHtml(c.hint) + '">' + c.label + "</button>").join("") +
      "</div>" +
      '<div class="oc-ramp">' + stops + "</div>" +
      '<div class="oc-legend-foot">OSCAR surface currents · the colour is the speed</div>' +
      '<div class="oc-legend-note">' + escapeHtml(COASTAL_NOTE) + "</div>";

    const overlays = list.querySelector(".leaflet-control-layers-overlays");
    if (overlays) overlays.insertAdjacentElement("afterend", host);
    else list.appendChild(host);

    const probeBtn = host.querySelector("#ctrl-oc-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        probeBtn.classList.toggle("active", state.probeMode);
        probeBtn.textContent = state.probeMode ? "Probe: On" : "Probe";
        probeBtn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
        if (!state.probeMode) hideProbe();
      });
    }
    host.querySelectorAll(".oc-style-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.style = btn.getAttribute("data-style") || DEFAULT_STYLE;
        storageSet(STYLE_STORE_KEY, state.style);
        host.querySelectorAll(".oc-style-btn").forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
    return true;
  }

  // THE LEGEND WAS NEVER MOUNTED.
  //
  // The layer shipped a legend — the speed key, the Probe button and
  // the Streamlines/Arrows chips — and mountLegend() was written and
  // exported, but NOTHING EVER CALLED IT. So the reader had no legend
  // for this overlay at all: no speed key, and the two controls that
  // live in it (the probe and the style chips) were simply not on the
  // page. The CSS for the legend has been in styles.css since the
  // layer landed.
  //
  // app.js creates the layers control AFTER this module is initialised,
  // so the injection is retried until the control is on the page — the
  // same pattern the climate, soil, cropland, geology and etopo layers
  // use.
  function waitForLayersControl() {
    if (mountLegend()) return;
    let tries = 0;
    const tick = () => {
      if (mountLegend() || ++tries > 40) return;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  function registerExport() {
    if (!window.XYZO_EXPORT || typeof window.XYZO_EXPORT.register !== "function") return;
    window.XYZO_EXPORT.register({
      id: "ocean-current",
      label: LAYER_NAME,
      kind: "raster",
      attribution: "OSCAR Sea Surface Velocity (ESR / NASA PO.DAAC) via NOAA CoastWatch",
      licence: "Public domain — US Government work (NOAA / NASA / ESR)",
      z: PANE_Z,
      bands: [{ name: "ocean_surface_current_speed", unit: "m/s" }],
      native: { cols: 360, rows: 161, latMin: -80, latMax: 80, lonMin: 0, lonMax: 360 },
      isActive: () => !!state.grid,
      sample(lat, lon) {
        const s = sample(lat, lon);
        if (!s) return null;
        return [Math.hypot(s[0], s[1])];
      },
      color(value) {
        const rgb = colorFor(Array.isArray(value) ? value[0] : value);
        return [
          parseInt(rgb.slice(4, 6), 16),
          parseInt(rgb.slice(7, 9), 16),
          parseInt(rgb.slice(10, 12), 16),
        ];
      },
    });
  }

  window.OceanCurrentLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    mountLegend: mountLegend,
    sampleAt: sampleAt,
    setStyle: (id) => { state.style = id; storageSet(STYLE_STORE_KEY, id); },
    getStyle: () => state.style,
    LAYER_NAME: LAYER_NAME,
    registerExport: registerExport,
    _state: state,
    _sample: sample,
  };

  registerExport();
})();
