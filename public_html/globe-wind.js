/* ═══════════════════════════════════════════════════════════════════════
   Wind on the 3D globe — the GFS 10 m field, both halves.

   The flat map has two wind overlays and the globe now has the same
   two:

     🌬️ Wind speed (GFS)  a colour wash of |V|, the MAGNITUDE of the
                          published u/v pair. On the globe it is a
                          Mercator-baked picture draped as an image
                          source — the same construction as the
                          temperature field, and the same field the
                          flat map's wind-speed layer paints.

     💨 Wind (GFS)         the ANIMATION: particles that travel along
                          the flow and leave a fading streak.

   WHY THE ANIMATION IS NOT THE FLAT MAP'S
   ---------------------------------------
   The flat map draws its particles on a full-map 2D canvas inside a
   Leaflet pane, in screen space, and Leaflet's CRS converts between
   screen and geography. The globe has no such pane and no such CRS:
   MapLibre owns the projection, and the globe's surface is a SPHERE —
   a particle on the far side has no meaningful screen position, and
   projecting it anyway would draw it over the front of the planet.

   So the globe's animation is its own thing:
     · particles live in GEOGRAPHIC space (lat/lng), exactly like the
       flat map's, so the physics is the same and the field cannot
       drift;
     · each frame they are PROJECTED with map.project() and the streak
       is drawn between the previous and the current screen point;
     · a particle on the far side of the globe is CULLED by a
       back-face test (the dot product of the point's direction vector
       with the camera's), which is the thing the flat map never had to
       think about;
     · the trail is trimmed by LENGTH, never by a frame count;
     · the geographic step is scaled by the CURRENT SCREEN SCALE, so a
       5 m/s wind looks like a 5 m/s wind at every zoom.

   Source: NOAA NCEP GFS 10 m wind (US Government work, public domain),
   the same 6-hourly analysis as the pressure lines and the temperature.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // The field sources. The WIND is the default; the OCEAN currents use
  // the same engine with the same physics, over their own published
  // u/v grid.
  const SOURCES = {
    wind: { meta: "/data/wind/meta-1deg.json", grid: "/data/wind/grid-1deg.bin" },
    ocean: { meta: "/data/ocean/meta.json", grid: "/data/ocean/grid.bin" },
  };

  const M_PER_DEG = 111320;
  // The screen speed a typical wind should have, in pixels per second.
  // The flat map calibrates against its own CRS; the globe does the
  // same thing against map.project().
  const TARGET_PX_PER_SEC = 26;
  // The streak is capped so a particle near the limb (where the globe's
  // screen scale collapses) cannot draw a line across the planet.
  const MAX_STREAK_PX = 18;
  const TRAIL_PX = 54;
  const TRAIL_MAX = 40;
  const PARTICLE_COUNT = 900;

  // ── the STYLE ────────────────────────────────────────────────────────
  // The globe draws two ways: STREAKS (its default, and what `flow` and
  // `arrows` fall back to — the globe has no fibre texture and no arrow
  // renderer) and DOTS, which are the flat map's `particles` style.
  //
  // The owner's ask: "we want to have similar dots for both wind
  // animations 2d or 3d". So a style chosen on the flat map has to mean
  // the same thing here, and it arrives by the two routes the flat map
  // itself uses:
  //
  //   * `wind=particles:speed` in the URL — a SHARED LINK's choice, and
  //     the one that must win: the hash is the promise "share the exact
  //     map". globe.js keeps this segment (it is not in
  //     GLOBE_OWNED_PREFIXES), so it survives the globe's own hash
  //     rewrite on every moveend.
  //   * `localStorage["xyzo.windStyle"]` — the reader's own preference,
  //     written by the flat map's style chips. Chrome and Firefox have
  //     SEPARATE localStorage, so each browser keeps its own.
  //
  // The globe reads it ONCE, at controller creation: it has no style
  // control of its own, and the segment it reads is the one carried by
  // the link it was opened with.
  //
  // THE CONSTANTS BELOW MIRROR wind-layer.js's ON PURPOSE. globe.html
  // does not load that file (it is flat-map only), so the numbers cannot
  // be imported — and a second copy that drifts is exactly the trap the
  // repo's parity tests exist for. tests/globe-wind.bun.test.js asserts
  // them against the source they came from.
  const PARTICLE_R_MIN = 1.9;       // px at a calm wind
  const PARTICLE_R_SPAN = 1.5;      // …up to 3.4 px at the ramp's top
  const PARTICLE_HALO_PX = 4.6;     // ring width, so the mark reads ~7 px
  const SPEED_BUCKETS = 12;         // == RAMP_STOPS.length, as on the flat map
  // Three passes per bucket, the same alphas the flat map's dots use —
  // but MULTIPLIED here rather than baked in: step() sets
  // ctx.globalAlpha to the layer opacity once per frame, and canvas
  // multiplies the two, so 0.45/0.27/0.9 under globalAlpha ==
  // opacity*0.5/0.30/0.9, which is what the flat map paints.
  //
  // THE RINGS ARE FILLED DISCS HERE TOO (2026-11-14), mirroring
  // wind-layer.js: the visible result of a stroke of width w on a
  // circle of radius r is the annulus [r − w/2, r + w/2], and three
  // concentric fills painted halo → bloom → core reproduce it. On the
  // flat map this took the particle renderer from 36.2 ms to 15.3 ms a
  // frame in Firefox (a wide round-capped stroke has to be tessellated
  // into a thick outline; a filled circle is a scanline fill), and the
  // globe's canvas is rasterised the same way on the same machines.
  const PARTICLE_HALO_R = PARTICLE_HALO_PX / 2;
  const PARTICLE_BLOOM_R = (PARTICLE_HALO_PX - 0.8) / 2;
  const DOT_HALO_A = 0.9 * 0.5;
  const DOT_BLOOM_A = 0.9 * 0.30;
  const DOT_CORE_A = 0.9;

  const STYLE_STORE_KEY = "xyzo.windStyle";
  // The flat map's four. Only `particles` changes what the globe draws;
  // the rest keep the streak the globe has always drawn.
  const STYLE_CHOICES = ["streamlines", "flow", "particles", "arrows"];
  const DEFAULT_STYLE = "streamlines";

  function readStyle() {
    try {
      const h = location.hash || "";
      const m = h.match(/(?:^|\/)wind=([^:/]+)/);
      if (m) {
        const s = decodeURIComponent(m[1]);
        if (STYLE_CHOICES.indexOf(s) >= 0) return s;
      }
    } catch (_) { /* no hash, or an unreadable one: fall through */ }
    try {
      const v = localStorage.getItem(STYLE_STORE_KEY);
      if (v && STYLE_CHOICES.indexOf(v) >= 0) return v;
    } catch (_) { /* private mode: the default stands */ }
    return DEFAULT_STYLE;
  }

  // The THIRD field of `wind=`: `wind=particles:speed:200`.
  //
  // Same two routes as the style — a shared link first (the hash is the
  // promise "share the exact map"), then the reader's own stored
  // choice — and the same validation, so a hand-edited
  // `wind=…:banana` falls back to the default instead of multiplying
  // PARTICLE_COUNT by NaN and drawing nothing.
  //
  // The globe has no density control of its own (it has no style or
  // colour controls either): it reads what the flat map wrote. The two
  // views agree because they read one grammar, not because they share
  // a widget.
  function readDensity() {
    const DENSITY_MIN = 25, DENSITY_MAX = 400, DEFAULT_DENSITY = 100;
    try {
      const h = location.hash || "";
      const m = h.match(/(?:^|\/)wind=[^:/]+(?::[^:/]+)?:([0-9]+)/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, Math.round(n)));
      }
    } catch (_) { /* no hash, or an unreadable one: fall through */ }
    try {
      const raw = localStorage.getItem("xyzo.windDensity");
      // GUARD THE ABSENT CASE: Number(null) is 0, and 0 clamps to the
      // 25 MINIMUM — so a reader who had never touched the control
      // would have opened the globe at a quarter of the default
      // density, silently. Measured: readDensity() returned 25 for an
      // empty hash and no stored value. Only a value that is actually
      // there may be read.
      if (raw != null && raw !== "") {
        const v = Number(raw);
        if (Number.isFinite(v)) {
          return Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, Math.round(v)));
        }
      }
    } catch (_) { /* private mode: the default stands */ }
    return DEFAULT_DENSITY;
  }

  // "rgb(r,g,b)" -> a function that returns the same colour at an alpha.
  // colorFor() hands back the un-alphaed form because the streaks carry
  // their opacity in globalAlpha; the dots need it per pass.
  function rgbaOf(rgb) {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgb);
    if (!m) return function (a) { return "rgba(255,255,255," + a + ")"; };
    const r = m[1], g = m[2], b = m[3];
    return function (a) { return "rgba(" + r + "," + g + "," + b + "," + a + ")"; };
  }

  // One cache per source, so the wind and the currents each fetch
  // their own grid exactly once.
  //
  // The wind's COARSE pair: the globe draws 900 streaks on a sphere and
  // shows no numbers at all, so the 0.25° grid (2.8 MB gzipped) buys it
  // nothing. The flat map reads the full-resolution pair.
  // `meta-1deg.json` describes `grid-1deg.bin` — the SAME analysis, the
  // SAME run, subsampled to 1° by the worker, so the two cannot
  // disagree.
  const shared = {};      // source -> { meta, u, v, n, scale }
  const sharedPromises = {};

  function loadRaw(source) {
    const name = source || "wind";
    const spec = SOURCES[name] || SOURCES.wind;
    if (shared[name]) return Promise.resolve(shared[name]);
    if (sharedPromises[name]) return sharedPromises[name];
    sharedPromises[name] = Promise.all([
      fetch(spec.meta, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(name + " meta " + r.status);
        return r.json();
      }),
      fetch(spec.grid, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(name + " grid " + r.status);
        return r.arrayBuffer();
      }),
    ]).then(([meta, buf]) => {
      const g = meta.grid || {};
      const n = (g.rows || 0) * (g.cols || 0);
      if (!n || buf.byteLength !== n * 4) {
        throw new Error("grid.bin is " + buf.byteLength + " bytes, expected " + n * 4);
      }
      const all = new Int16Array(buf);
      shared[name] = {
        meta: meta,
        grid: g,
        n: n,
        scale: g.scale || 100,
        // Planar: u in [0, n), v in [n, 2n).
        u: all.subarray(0, n),
        v: all.subarray(n, 2 * n),
      };
      sharedPromises[name] = null;
      return shared[name];
    }).catch((e) => {
      sharedPromises[name] = null;
      throw e;
    });
    return sharedPromises[name];
  }

  // ── the SPEED field ────────────────────────────────────────────────
  // u and v -> the magnitude, in the grid's own units.
  function speedGrid(raw) {
    const g = raw.grid;
    const n = raw.n;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const u = raw.u[i] / raw.scale;
      const v = raw.v[i] / raw.scale;
      out[i] = Math.round(Math.sqrt(u * u + v * v) * raw.scale);
    }
    return out;
  }

  // The published ramp is keyed by `ms`; the shared bake wants `c`.
  function speedRamp(meta) {
    return (meta.ramp || []).map((s) => ({ c: Number(s.ms), rgb: s.rgb }));
  }

  /**
   * Bake the wind SPEED field and add it as an image source + layer.
   *
   * `getState()` is called AT THE MOMENT the layer is created, not when
   * this function is called: the layer arrives a fetch later, by which
   * time a shared link may have switched it on and moved its slider.
   * Reading the state early left the layer switched off with the wrong
   * opacity — the hash said "on at 60 %" and the layer came up hidden
   * at 40 %.
   *
   * @param {Function} getState () => ({ opacity, enabled })
   * @returns {Promise<boolean>} true when the layer was added.
   */
  function addSpeedLayer(map, key, getState, source) {
    return loadRaw(source).then((raw) => {
      const meta = raw.meta;
      const g = meta.grid;
      const ramp = speedRamp(meta);
      const lo = (meta.range_ms && meta.range_ms[0]) || 0;
      const hi = (meta.range_ms && meta.range_ms[1]) || 1;
      const canvas = window.XYZO_FIELD_BAKE.bakeMercator({
        grid: g,
        data: speedGrid(raw),
        width: 1024,
        height: 1024,
        colorAt: (v) => {
          const ms = v / raw.scale;
          const t = Math.max(0, Math.min(1, (ms - lo) / (hi - lo || 1)));
          const rgb = window.XYZO_FIELD_BAKE.rampColor(ramp, lo + t * (hi - lo));
          return [rgb[0], rgb[1], rgb[2], 255];
        },
      });
      const st = (getState && getState()) || { opacity: 0.4, enabled: false };
      if (map.getLayer(key)) map.removeLayer(key);
      if (map.getSource(key)) map.removeSource(key);
      map.addSource(key, {
        type: "image",
        url: canvas.toDataURL("image/png"),
        coordinates: window.XYZO_FIELD_BAKE.mercatorQuad(),
      });
      map.addLayer({
        id: key,
        type: "raster",
        source: key,
        layout: { visibility: st.enabled ? "visible" : "none" },
        paint: { "raster-opacity": st.opacity },
      });
      return true;
    });
  }

  // ── the ANIMATION ──────────────────────────────────────────────────
  function createAnimation(map, key, opacity, source) {
    const sourceName = source || "wind";
    const state = {
      map: map,
      key: key,
      opacity: opacity,
      enabled: false,
      ready: false,
      particles: [],
      raf: 0,
      lastT: 0,
      canvas: null,
      ctx: null,
      dpr: 1,
      raw: null,
      ramp: null,
      maxMs: 1,
      // STREAKS or DOTS — see readStyle() above. The OCEAN CURRENTS
      // controller shares this engine and gets its own read, so a
      // `wind=particles` link does not silently restyle the currents:
      // the flat map's currents have their own chips and their own
      // default, and one segment must not drive two overlays.
      style: sourceName === "wind" ? readStyle() : DEFAULT_STYLE,
      // …and how much: the same reader, the same two routes, and only
      // for the WIND — the currents are a different overlay with their
      // own default, and one segment must not drive two overlays.
      density: sourceName === "wind" ? readDensity() : 100,
    };

    function log(msg, a, b) {
      if (window.XLog && typeof window.XLog.warn === "function") {
        window.XLog.warn("globe-wind: " + msg, a, b);
      }
    }

    // Bilinear sample of the u/v pair, in geographic space.
    // Longitude WRAPS (it does not reject) and the column past the last
    // one WRAPS too; the latitude axis clamps, because the pole is a
    // real edge. Same rules as the flat map's wind layer.
    function sample(lat, lng) {
      const g = state.raw.grid;
      const lon = ((((lng - g.lon_min) % 360) + 360) % 360) + g.lon_min;
      const gx = (lon - g.lon_min) / g.lon_step;
      const gy = (lat - g.lat_min) / g.lat_step;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const x1 = (x0 + 1) % g.cols, y1 = Math.min(y0 + 1, g.rows - 1);
      const fx = gx - x0, fy = gy - y0;
      const u00 = state.raw.u[y0 * g.cols + x0], u10 = state.raw.u[y0 * g.cols + x1];
      const u01 = state.raw.u[y1 * g.cols + x0], u11 = state.raw.u[y1 * g.cols + x1];
      const v00 = state.raw.v[y0 * g.cols + x0], v10 = state.raw.v[y0 * g.cols + x1];
      const v01 = state.raw.v[y1 * g.cols + x0], v11 = state.raw.v[y1 * g.cols + x1];
      const u = (u00 * (1 - fx) + u10 * fx) * (1 - fy) + (u01 * (1 - fx) + u11 * fx) * fy;
      const v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      return [u / state.raw.scale, v / state.raw.scale];
    }

    // The back-face test. On a globe the camera sits above the point
    // the map is centred on, so the visible hemisphere is the one
    // whose points have a positive dot product with the centre's
    // direction vector. Without it, every particle on the FAR side
    // would be drawn over the front of the planet.
    function visible(lng, lat) {
      try {
        const c = map.getCenter();
        const cl = (c.lat * Math.PI) / 180, cLng = (c.lng * Math.PI) / 180;
        const pl = (lat * Math.PI) / 180, pLng = (lng * Math.PI) / 180;
        const a = Math.cos(pl) * Math.sin(pLng);
        const b = Math.cos(pl) * Math.cos(pLng);
        const c2 = Math.sin(pl);
        const d = Math.cos(cl) * Math.sin(cLng);
        const e = Math.cos(cl) * Math.cos(cLng);
        const f = Math.sin(cl);
        return a * d + b * e + c2 * f > 0.02;
      } catch (_) {
        return true;
      }
    }

    function ensureCanvas() {
      if (state.canvas) return;
      const host = map.getCanvasContainer
        ? map.getCanvasContainer()
        : map.getCanvas().parentNode;
      if (!host) return;
      const canvas = document.createElement("canvas");
      canvas.className = "xyzo-globe-wind";
      canvas.style.position = "absolute";
      canvas.style.left = "0";
      canvas.style.top = "0";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "5";
      host.appendChild(canvas);
      state.canvas = canvas;
      state.ctx = canvas.getContext("2d");
      resize();
    }

    function resize() {
      if (!state.canvas) return;
      const c = map.getCanvas();
      const rect = c.getBoundingClientRect();
      state.dpr = Math.min(2, window.devicePixelRatio || 1);
      state.canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
      state.canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
      state.canvas.style.width = rect.width + "px";
      state.canvas.style.height = rect.height + "px";
      state.w = rect.width;
      state.h = rect.height;
    }

    function seed() {
      // Seed by picking a SCREEN pixel and unprojecting it: that lands
      // the particle where the reader is looking, and the back-face
      // test throws away the ones that unprojected to the far side.
      const p = { lat: 0, lng: 0, hist: [], px: 0, py: 0, has: false, life: 0 };
      for (let tries = 0; tries < 10; tries++) {
        const x = Math.random() * (state.w || 1);
        const y = Math.random() * (state.h || 1);
        let ll = null;
        try { ll = map.unproject([x, y]); } catch (_) { ll = null; }
        if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) continue;
        if (!visible(ll.lng, ll.lat)) continue;
        p.lat = ll.lat;
        p.lng = ll.lng;
        return p;
      }
      return null;
    }

    function ensureParticles() {
      // Density scales the count the same way the flat map's does, and
      // the pool must also SHRINK: this loop only ever grew, so a
      // reader who dropped from 300 % to 50 % would keep the extra
      // particles for the rest of the session.
      const want = Math.max(1, Math.round(PARTICLE_COUNT * state.density / 100));
      while (state.particles.length > want) state.particles.pop();
      while (state.particles.length < want) {
        const p = seed();
        if (!p) break;
        state.particles.push(p);
      }
    }

    // The screen scale at the map centre, so the visual speed of the
    // field does not change with the zoom.
    function pxPerDeg() {
      try {
        const c = map.getCenter();
        const a = map.project([c.lng, c.lat]);
        const b = map.project([c.lng, c.lat + 1]);
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        return d > 0.0001 ? d : 1;
      } catch (_) {
        return 1;
      }
    }

    function step(now) {
      state.raf = 0;
      if (!state.enabled) return;
      if (document.hidden) { state.lastT = 0; return; }
      try {
        const dt = state.lastT ? Math.min((now - state.lastT) / 1000, 0.05) : 1 / 60;
        state.lastT = now;
        const ctx = state.ctx;
        if (!ctx || !state.raw) { schedule(); return; }
        resize();
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.clearRect(0, 0, state.w, state.h);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = Math.max(0.15, Math.min(1, state.opacity));

        const scale = pxPerDeg();
        const speedScale = TARGET_PX_PER_SEC * dt / scale;   // pixels -> degrees
        const maxMs = state.maxMs || 1;

        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i];
          const s = sample(p.lat, p.lng);
          if (!s) continue;
          const u = s[0], v = s[1];
          const sp = Math.sqrt(u * u + v * v);
          if (sp < 0.01) {
            // Dead air: let the particle die and be respawned elsewhere.
            p.life += 1;
            if (p.life > 90) { state.particles.splice(i, 1); i--; }
            continue;
          }
          // Geographic step. A degree of longitude shrinks by cos(lat),
          // so the eastward part is divided by it.
          const cosLat = Math.max(Math.cos((p.lat * Math.PI) / 180), 0.05);
          const frac = Math.min(1, sp / maxMs);
          const stepDeg = speedScale * (0.35 + 0.65 * frac);
          const dLng = ((u / sp) * stepDeg) / cosLat;
          const dLat = (v / sp) * stepDeg;
          const nLat = p.lat + dLat;
          const nLng = p.lng + dLng;

          if (!visible(nLng, nLat)) {
            // The particle went round the back: respawn it in front.
            const np = seed();
            if (np) { state.particles[i] = np; }
            continue;
          }

          let pt = null;
          try { pt = map.project([nLng, nLat]); } catch (_) { pt = null; }
          if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
          if (pt.x < -40 || pt.y < -40 || pt.x > state.w + 40 || pt.y > state.h + 40) {
            const np = seed();
            if (np) { state.particles[i] = np; }
            continue;
          }

          // ── DOTS (the flat map's `particles` style) ────────────────
          // The owner's ask: the same dots in 2D and in 3D. A dot is a
          // DARK HALO disc, under a bloom disc, under the core — the
          // same three passes in the same order the flat map's
          // particles use, because a bright core alone has nothing to
          // separate itself from over a bright satellite basemap (the
          // "i can't see the wind" lesson, paid for once already).
          // Each ring is FILLED rather than stroked — see the constants
          // block for why, and for the measurement.
          //
          // No history is kept: a dot has no tail. Skipping the trail
          // trim below is not just tidiness — it is the per-particle
          // work the streaks exist to do, and 900 particles do not need
          // it here.
          if (state.style === "particles") {
            const rgb = colorFor(sp);
            const toRgba = rgbaOf(rgb);
            // Same radius law as the flat map: 1.9 px at calm, 3.4 px at
            // the ramp's top, so a fast wind reads as a bigger mark and
            // the reader can still see the speed in the size.
            const r = PARTICLE_R_MIN + PARTICLE_R_SPAN * frac;
            // 1: the dark halo, reaching r + PARTICLE_HALO_R.
            ctx.fillStyle = "rgba(8,12,20," + DOT_HALO_A + ")";
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r + PARTICLE_HALO_R, 0, Math.PI * 2);
            ctx.fill();
            // 2: the bloom, inside it.
            ctx.fillStyle = toRgba(DOT_BLOOM_A);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r + PARTICLE_BLOOM_R, 0, Math.PI * 2);
            ctx.fill();
            // 3: the core, exactly to the particle's own radius.
            ctx.fillStyle = toRgba(DOT_CORE_A);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
            ctx.fill();
            p.lat = nLat;
            p.lng = nLng;
            p.life = 0;
            continue;
          }

          // The trail, trimmed by LENGTH.
          p.hist.push(pt.x, pt.y);
          let acc = 0;
          const nh = p.hist.length / 2;
          for (let k = nh - 1; k > 0; k--) {
            acc += Math.hypot(p.hist[k * 2] - p.hist[(k - 1) * 2],
                              p.hist[k * 2 + 1] - p.hist[(k - 1) * 2 + 1]);
            if (acc >= TRAIL_PX) { p.hist.splice(0, (k - 1) * 2); break; }
          }
          while (p.hist.length > TRAIL_MAX * 2) p.hist.splice(0, 2);

          // Draw the streak: the last TRAIL_PX of history.
          const len = p.hist.length;
          if (len >= 4) {
            const x1 = p.hist[len - 2], y1 = p.hist[len - 1];
            const x0 = p.hist[0], y0 = p.hist[1];
            let dx = x1 - x0, dy = y1 - y0;
            const d = Math.hypot(dx, dy);
            if (d > 0.01) {
              const cap = Math.min(d, MAX_STREAK_PX);
              dx = (dx / d) * cap; dy = (dy / d) * cap;
              const rgb = colorFor(sp);
              // A DARK HALO under the bright core, then the core — the
              // same rule the flat map's streaks follow (see the halo
              // block in wind-layer.js). A bloom in the streak's own
              // colour can only brighten the ground around it, which is
              // the one thing that cannot help over a bright satellite
              // basemap; a near-black ring costs nothing on a dark one.
              // The path is built ONCE and stroked twice — rebuilding it
              // per pass would double the per-particle setup for no
              // reason, and this loop runs for every particle every
              // frame (this engine serves BOTH the wind and the ocean
              // currents).
              ctx.lineCap = "round";
              ctx.beginPath();
              ctx.moveTo(x1 - dx, y1 - dy);
              ctx.lineTo(x1, y1);
              ctx.strokeStyle = "rgba(8,12,20,0.5)";
              ctx.lineWidth = 1 + 1.6 * frac + 3.0;
              ctx.stroke();
              ctx.strokeStyle = rgb;
              ctx.lineWidth = 1 + 1.6 * frac;
              ctx.stroke();
            }
          }

          p.lat = nLat;
          p.lng = nLng;
          p.life = 0;
        }
      } catch (err) {
        log("frame failed", err);
      } finally {
        schedule();
      }
    }

    function colorFor(ms) {
      const ramp = state.ramp || [];
      if (!ramp.length) return "#ffffff";
      const lo = ramp[0].c, hi = ramp[ramp.length - 1].c;
      const t = Math.max(0, Math.min(1, (ms - lo) / (hi - lo || 1)));
      const c = lo + t * (hi - lo);
      let a = ramp[0], b = ramp[ramp.length - 1];
      for (let i = 0; i < ramp.length - 1; i++) {
        if (c >= ramp[i].c && c <= ramp[i + 1].c) { a = ramp[i]; b = ramp[i + 1]; break; }
      }
      const f = b.c === a.c ? 0 : (c - a.c) / (b.c - a.c);
      const ca = window.XYZO_FIELD_BAKE.hexToRgb(a.rgb);
      const cb = window.XYZO_FIELD_BAKE.hexToRgb(b.rgb);
      const m = (j) => Math.round(ca[j] + (cb[j] - ca[j]) * f);
      return "rgb(" + m(0) + "," + m(1) + "," + m(2) + ")";
    }

    function schedule() {
      if (!state.enabled) return;
      // A HIDDEN TAB MUST NOT HOLD A FRAME.
      //
      // Firefox KEEPS FIRING requestAnimationFrame in a background tab
      // (throttled to about 1 Hz) where Chrome suspends it, so the
      // `document.hidden` branch in step() used to end the chain on the
      // first background frame and NOTHING ever restarted it: the
      // reader switched tabs, came back, and the animation was frozen
      // for good. The visibilitychange handler below restarts it.
      if (document.hidden) return;
      if (state.raf) return;
      state.raf = requestAnimationFrame(step);
    }

    // Pause WITHOUT disabling: the overlay stays on and the frame
    // chain restarts the moment the tab is seen again.
    function pause() {
      if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
      state.lastT = 0;
    }

    function onVisibility() {
      if (document.hidden) pause();
      else if (state.enabled) { state.lastT = 0; schedule(); }
    }
    document.addEventListener("visibilitychange", onVisibility);

    function start() {
      ensureCanvas();
      if (!state.canvas) return;
      state.enabled = true;
      ensureParticles();
      state.lastT = 0;
      schedule();
    }

    function stop() {
      state.enabled = false;
      pause();
      if (state.ctx) {
        state.ctx.setTransform(1, 0, 0, 1, 0, 0);
        state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
      }
    }

    function setEnabled(on) {
      if (on) {
        loadRaw(sourceName).then((raw) => {
          state.raw = raw;
          state.ramp = speedRamp(raw.meta);
          state.maxMs = (raw.meta.range_ms && raw.meta.range_ms[1]) || 12;
          state.ready = true;
          if (state.wantEnabled) start();
        }).catch((e) => log("load failed", e));
        state.wantEnabled = true;
      } else {
        state.wantEnabled = false;
        stop();
      }
    }

    function setOpacity(v) {
      state.opacity = v;
    }

    // Switch STREAKS <-> DOTS, and how many of them, without rebuilding
    // the animation. The globe has no style or density controls of its
    // own — it reads what the flat map wrote — so these exist for the
    // hash and for the tests; the reader changes style and density on
    // the flat map and the globe follows on the next load through the
    // same `wind=` segment.
    function setStyle(id) {
      if (STYLE_CHOICES.indexOf(id) < 0) return state.style;
      state.style = id;
      // A dot has no tail: drop any streak history so a switch back to
      // streamlines does not paint one long line from the old path.
      for (let i = 0; i < state.particles.length; i++) {
        state.particles[i].hist.length = 0;
      }
      if (state.ctx && state.canvas) {
        state.ctx.setTransform(1, 0, 0, 1, 0, 0);
        state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
      }
      return state.style;
    }

    // How many. Clamped to the flat map's own bounds so the two views
    // cannot disagree about what a link is asking for, and it retunes
    // the pool immediately rather than waiting for the next start() —
    // a reader who arrives with `wind=…:300` and then toggles the
    // overlay off and on must not get the default count back.
    function setDensity(pct) {
      const n = Math.round(Number(pct));
      if (!Number.isFinite(n)) return state.density;
      const want = Math.min(400, Math.max(25, n));
      if (want === state.density) return state.density;
      state.density = want;
      ensureParticles();
      return state.density;
    }

    return {
      setEnabled: setEnabled,
      setOpacity: setOpacity,
      setStyle: setStyle,
      getStyle: () => state.style,
      setDensity: setDensity,
      getDensity: () => state.density,
      isReady: () => state.ready,
      // Test hook: which animation is this, and is it running? The
      // globe has TWO of them (the wind and the ocean currents) and
      // they must not be confused for one another.
      _state: state,
      _source: sourceName,
      destroy: function () {
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        if (state.canvas && state.canvas.parentNode) {
          state.canvas.parentNode.removeChild(state.canvas);
        }
        state.canvas = null;
      },
    };
  }

  window.XYZO_GLOBE_WIND = {
    loadRaw: loadRaw,
    addSpeedLayer: addSpeedLayer,
    createAnimation: createAnimation,
    readStyle: readStyle,
    readDensity: readDensity,
    // The dot geometry, exported so a test can assert it against the
    // flat map's own constants rather than trusting a comment.
    PARTICLES: {
      R_MIN: PARTICLE_R_MIN,
      R_SPAN: PARTICLE_R_SPAN,
      HALO_PX: PARTICLE_HALO_PX,
      SPEED_BUCKETS: SPEED_BUCKETS,
      HALO_A: DOT_HALO_A,
      BLOOM_A: DOT_BLOOM_A,
      CORE_A: DOT_CORE_A,
    },
    STYLE_CHOICES: STYLE_CHOICES.slice(),
    DEFAULT_STYLE: DEFAULT_STYLE,
  };
})();
