/* ═══════════════════════════════════════════════════════════════════════
   Lightning density overlay for the Xyzo map — where on Earth the
   lightning is, and WHEN.

   Source: the WWLLN Global Lightning Climatology (WGLC), the finest
   global lightning climatology in the public domain — a 5 arc-minute
   grid, about 9.3 km per cell. (The NASA LIS/OTD map everybody shares
   is 0.5 degrees, six times coarser, and is twenty years old.)

   scripts/lightning_build.py publishes:

     /data/lightning/meta.json       layout, colour ramp, ticks, periods
     /data/lightning/grid_annual.bin the annual mean, 2160 x 4320 uint16
     /data/lightning/grid_m01.bin .. monthly means, same layout

   The grids are uint16 at 1e-4 strokes km-2 d-1 per unit — a plain
   raster of the published variable, linear, so nothing about the data
   is hidden in the encoding. The COLOUR is a power law (t = (v/v_max)^
   0.4) and the client does that transform once, into a lookup table,
   so painting a pixel is an array read and not a pow().

   The wash is painted tile by tile straight out of the grid rather than
   baked into one world-sized canvas: at 9.3 km per cell a canvas big
   enough to hold the data would be 67 MB of ImageData, and the bake
   would cost a second of jank. A 256 px tile costs about a millisecond.

   Alpha is separate from the ramp on purpose — 40 % of the globe has no
   lightning at all, and painting that opaque black would bury the
   coastlines under a black rectangle.

   WHY NOT PNG TILES: every *.png under public_html is served
   `immutable` for a year, so a rebuilt pyramid is invisible behind a
   stale version token (the bug that hid the Koppen layer on 2026-10-22).
   A .bin revalidates. And the field has to be resampled into a Mercator
   wash anyway, which is cheaper here than on the server.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/lightning";
  const META_URL = BASE + "/meta.json";
  const STORE_KEY = "xyzo.lightningLayer";
  const PROBE_STORE_KEY = "xyzo.lightningProbe";
  const PERIOD_STORE_KEY = "xyzo.lightningPeriod";

  // The lookup table is indexed by the STORED value (uint16 units of
  // 1e-4 strokes km-2 d-1). The dataset peaks at 0.4197, so 8192 entries
  // cover everything with room to spare.
  const LUT_SIZE = 8192;

  const state = {
    map: null,
    overlay: null,
    enabled: false,
    probeMode: false,
    meta: null,
    periodId: null,
    period: null,
    grid: null,
    grids: {},          // periodId -> Uint16Array
    loading: {},        // periodId -> Promise
    lut: null,
    legendMounted: false,
    lastProbe: null,
    metaPromise: null,
  };

  // ── small helpers ─────────────────────────────────────────────────────
  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }

  function storageGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── data ──────────────────────────────────────────────────────────────
  function ensureMeta() {
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = fetch(META_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("meta " + r.status);
        return r.json();
      })
      .then((meta) => {
        state.meta = meta;
        buildLut(meta);
        const ids = (meta.periods || []).map((p) => p.id);
        const wanted = storageGet(PERIOD_STORE_KEY, meta.default_period || "annual");
        state.periodId = ids.indexOf(wanted) >= 0 ? wanted : (meta.default_period || "annual");
        state.period = (meta.periods || []).find((p) => p.id === state.periodId) || null;
        return meta;
      })
      .catch((err) => {
        warn("lightning: meta failed to load", err);
        state.metaPromise = null;
        throw err;
      });
    return state.metaPromise;
  }

  function loadPeriod(id) {
    if (state.grids[id]) return Promise.resolve(state.grids[id]);
    if (state.loading[id]) return state.loading[id];
    const meta = state.meta;
    const period = (meta.periods || []).find((p) => p.id === id);
    if (!period) return Promise.reject(new Error("unknown period " + id));

    const url = BASE + "/" + period.file;
    state.loading[id] = fetch(url, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(period.file + " " + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const grid = new Uint16Array(buf);
        const expect = period.rows * period.cols;
        if (grid.length !== expect) {
          throw new Error(period.file + " is " + grid.length + " values, expected " + expect);
        }
        state.grids[id] = grid;
        delete state.loading[id];
        return grid;
      })
      .catch((err) => {
        warn("lightning: grid failed to load", period.file, err);
        delete state.loading[id];
        throw err;
      });
    return state.loading[id];
  }

  function setPeriod(id, redraw) {
    if (!state.meta) return Promise.resolve();
    const period = (state.meta.periods || []).find((p) => p.id === id);
    if (!period) return Promise.resolve();
    state.periodId = id;
    state.period = period;
    storageSet(PERIOD_STORE_KEY, id);
    refreshPeriodButtons();
    buildLegend();
    return loadPeriod(id).then((grid) => {
      // The user may have switched period while this grid was in
      // flight. A stale response must not overwrite the field that is
      // on screen now.
      if (state.periodId !== id) return;
      state.grid = grid;
      if (state.enabled && redraw !== false && state.overlay) state.overlay.redraw();
      hideProbe();
    }).catch(() => {});
  }

  // ── colour ────────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // The ramp is defined in ramp POSITION (0..1), not in value: the value
  // -> position transform is the power law, and it happens once, here.
  function rampColor(ramp, t) {
    if (t <= ramp[0].t) return hexToRgb(ramp[0].rgb);
    const last = ramp[ramp.length - 1];
    if (t >= last.t) return hexToRgb(last.rgb);
    for (let i = 0; i < ramp.length - 1; i++) {
      const a = ramp[i];
      const b = ramp[i + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t);
        const ca = hexToRgb(a.rgb);
        const cb = hexToRgb(b.rgb);
        return [
          Math.round(ca[0] + (cb[0] - ca[0]) * f),
          Math.round(ca[1] + (cb[1] - ca[1]) * f),
          Math.round(ca[2] + (cb[2] - ca[2]) * f),
        ];
      }
    }
    return hexToRgb(last.rgb);
  }

  function alphaAt(stops, t) {
    if (!stops || !stops.length) return 255;
    if (t <= stops[0].t) return stops[0].a;
    const last = stops[stops.length - 1];
    if (t >= last.t) return last.a;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t);
        return Math.round(a.a + (b.a - a.a) * f);
      }
    }
    return last.a;
  }

  // One table, built once: stored value -> RGBA. Painting a pixel is
  // then a single array read instead of a pow() and a ramp walk.
  function buildLut(meta) {
    const lut = new Uint8Array(LUT_SIZE * 4);
    const scale = meta.grid.scale;
    const vmax = meta.v_max;
    const power = meta.power;
    for (let i = 0; i < LUT_SIZE; i++) {
      const v = i * scale;
      let t = 0;
      if (v > 0) {
        t = Math.pow(v / vmax, power);
        if (t > 1) t = 1;
      }
      const rgb = rampColor(meta.ramp, t);
      lut[i * 4] = rgb[0];
      lut[i * 4 + 1] = rgb[1];
      lut[i * 4 + 2] = rgb[2];
      lut[i * 4 + 3] = alphaAt(meta.alpha, t);
    }
    state.lut = lut;
  }

  // ── sampling ──────────────────────────────────────────────────────────
  // Bilinear, longitude wraps, latitude clamps. Returns the STORED
  // value (uint16 units) so the colour and the probe read the same
  // number.
  function sampleStored(lat, lon) {
    const meta = state.meta;
    const grid = state.grid;
    if (!grid || !meta) return null;
    const g = meta.grid;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let row = (lat - g.lat_min) / g.lat_step;
    if (row < 0) row = 0;
    else if (row > g.rows - 1) row = g.rows - 1;
    const r0 = Math.floor(row);
    const r1 = r0 + 1 < g.rows ? r0 + 1 : r0;
    const fr = row - r0;

    let col = (lon - g.lon_min) / g.lon_step;
    col = ((col % g.cols) + g.cols) % g.cols;
    const c0 = Math.floor(col);
    const c1 = c0 + 1 < g.cols ? c0 + 1 : 0;
    const fc = col - c0;

    const base0 = r0 * g.cols;
    const base1 = r1 * g.cols;
    const a = grid[base0 + c0];
    const b = grid[base0 + c1];
    const c = grid[base1 + c0];
    const d = grid[base1 + c1];
    const top = a + (b - a) * fc;
    const bot = c + (d - c) * fc;
    return top + (bot - top) * fr;
  }

  function dailyOf(stored) {
    return stored * state.meta.grid.scale;
  }

  // Strokes per km2 per YEAR for the active period: a day's mean rate
  // times the number of days the period covers.
  function yearlyOf(stored) {
    const days = state.period ? state.period.days : 365;
    return dailyOf(stored) * days;
  }

  function fmt(n, digits) {
    if (!isFinite(n)) return "—";
    return n.toFixed(digits);
  }

  function fmtCount(n) {
    if (!isFinite(n)) return "—";
    if (n >= 1000) return Math.round(n).toLocaleString("en-US");
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(3);
  }

  // ── rendering ─────────────────────────────────────────────────────────
  // A tile is a Web Mercator tile, so its y axis is Mercator and the
  // latitude of a row comes from the inverse Mercator transform.
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  const scratch = { size: 0, cIdx: null, cFrac: null, img: null };

  function getScratch(size) {
    if (scratch.size === size) return scratch;
    scratch.size = size;
    scratch.cIdx = new Int32Array(size);
    scratch.cFrac = new Float32Array(size);
    scratch.img = null;
    return scratch;
  }

  function paintTile(canvas, coords) {
    const meta = state.meta;
    const grid = state.grid;
    const lut = state.lut;
    if (!meta || !grid || !lut) return;
    const g = meta.grid;
    const size = canvas.width;
    const sc = getScratch(size);
    const ctx = canvas.getContext("2d");
    if (!sc.img || sc.img.width !== size) sc.img = ctx.createImageData(size, size);
    const out = sc.img.data;

    const n = 1 << coords.z;
    const x0 = coords.x / n;
    const y0 = coords.y / n;
    // A tile is 1/n of the world, so ONE PIXEL of it is 1/(size*n) of
    // the world — not 1/size. Dividing the within-tile offset by
    // `size` alone spreads the whole globe across every tile, which at
    // zoom 0 is invisible (n = 1) and at zoom 7 throws the field
    // hundreds of degrees away from where it belongs.
    const invSpan = 1 / (size * n);

    // Column positions are the same for every row, so they are worked
    // out once per tile.
    for (let px = 0; px < size; px++) {
      const lon = -180 + (360 * (x0 + (px + 0.5) * invSpan));
      let col = (lon - g.lon_min) / g.lon_step;
      col = ((col % g.cols) + g.cols) % g.cols;
      const c0 = Math.floor(col);
      sc.cIdx[px] = c0;
      sc.cFrac[px] = col - c0;
    }

    const rows = g.rows;
    const cols = g.cols;
    for (let py = 0; py < size; py++) {
      const lat = tileLat(y0 + (py + 0.5) * invSpan);
      let row = (lat - g.lat_min) / g.lat_step;
      if (row < 0) row = 0;
      else if (row > rows - 1) row = rows - 1;
      const r0 = Math.floor(row);
      const r1 = r0 + 1 < rows ? r0 + 1 : r0;
      const fr = row - r0;
      const base0 = r0 * cols;
      const base1 = r1 * cols;
      const o = py * size * 4;

      for (let px = 0; px < size; px++) {
        const c0 = sc.cIdx[px];
        const c1 = c0 + 1 < cols ? c0 + 1 : 0;
        const fc = sc.cFrac[px];
        const a = grid[base0 + c0];
        const b = grid[base0 + c1];
        const cc = grid[base1 + c0];
        const d = grid[base1 + c1];
        const top = a + (b - a) * fc;
        const bot = cc + (d - cc) * fc;
        let s = top + (bot - top) * fr;
        let li = ((s + 0.5) | 0) * 4;
        if (li < 0) li = 0;
        else if (li >= lut.length) li = lut.length - 4;
        const oi = o + px * 4;
        out[oi] = lut[li];
        out[oi + 1] = lut[li + 1];
        out[oi + 2] = lut[li + 2];
        out[oi + 3] = lut[li + 3];
      }
    }
    ctx.putImageData(sc.img, 0, 0);
  }

  // The geographic position of a pixel inside a tile. Exported because
  // this mapping is the one thing in the renderer that can be wrong in
  // a way the picture still looks like a plausible map: a tile that
  // samples the whole globe across its own width is a garbled field,
  // not an obviously broken one.
  function pixelLatLon(coords, px, py, size) {
    const n = 1 << coords.z;
    const invSpan = 1 / (size * n);
    return {
      lon: -180 + 360 * (coords.x / n + (px + 0.5) * invSpan),
      lat: tileLat(coords.y / n + (py + 0.5) * invSpan),
    };
  }

  // ── layer ─────────────────────────────────────────────────────────────
  function makeTileLayer() {
    const LightningGrid = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        paintTile(tile, coords);
        // Call back ASYNCHRONOUSLY. Leaflet registers and inserts the
        // tile only after createTile returns, and `_tileReady` marks a
        // tile loaded only if it already knows about it — calling back
        // synchronously left every tile with visibility: hidden, i.e.
        // painted but invisible.
        setTimeout(() => done(null, tile), 0);
        return tile;
      },
      // L.TileLayer supplies setOpacity; a bare GridLayer does not, and
      // the layers dropdown calls it for every overlay.
      setOpacity(value) {
        const v = Math.max(0, Math.min(1, Number(value)));
        if (!Number.isFinite(v)) return;
        this.options.opacity = v;
        if (this._container) this._container.style.opacity = String(v);
      },
    });
    return new LightningGrid({
      pane: "lightningPane",
      opacity: 0.9,
      attribution: "WWLLN / ARVE Research",
      updateWhenIdle: false,
      keepBuffer: 1,
    });
  }

  function getTileLayer() {
    if (state.overlay) return state.overlay;
    if (typeof L === "undefined") return null;
    state.overlay = makeTileLayer();
    state.overlay.on("add", () => {
      state.enabled = true;
      storageSet(STORE_KEY, "1");
      ensureMeta()
        .then(() => setPeriod(state.periodId))
        .catch(() => {});
      applyVisibility();
    });
    state.overlay.on("remove", () => {
      state.enabled = false;
      storageSet(STORE_KEY, "0");
      hideProbe();
      applyVisibility();
    });
    return state.overlay;
  }

  function init(map) {
    if (!map || state.map) return;
    state.map = map;

    if (!map.getPane("lightningPane")) {
      map.createPane("lightningPane");
      map.getPane("lightningPane").style.zIndex = "356";
      map.getPane("lightningPane").style.pointerEvents = "none";
    }

    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";

    if (state.overlay && storageGet(STORE_KEY, "0") === "1") {
      try { state.overlay.addTo(state.map); } catch (_) {}
    }

    map.on("mousemove", (e) => {
      if (state.enabled && !state.probeMode) {
        // HoverInfo "all" mode aggregates every layer's reading into
        // one card — stand down so two boxes fight over the cursor.
        if (window.HoverInfo && typeof HoverInfo.suppressesProbes === "function" && HoverInfo.suppressesProbes()) return;
        updateProbe(e.latlng, e.containerPoint);
      }
    });
    map.on("mouseout", () => {
      if (!state.probeMode) hideProbe();
    });
    map.on("click", (e) => {
      if (state.enabled && state.probeMode) updateProbe(e.latlng, e.containerPoint);
    });

    waitForLayersControl();

    // Warming the META at idle means the legend is ready when the
    // reader opens the dropdown. **THE GRID IS NEVER WARMED** — it is
    // 17.8 MB, the layer is OFF by default, and warming it charged
    // every visitor who never switched the lightning on 17.8 MB of
    // their first page load for nothing. The `add` handler fetches it
    // the moment the reader asks for it.
    const warm = () => ensureMeta().catch(() => {});
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
    else setTimeout(warm, 3000);
  }

  // ── legend ────────────────────────────────────────────────────────────
  function gradientCss(meta) {
    const stops = meta.ramp.map((r) => {
      const rgb = hexToRgb(r.rgb);
      return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," +
        (alphaAt(meta.alpha, r.t) / 255).toFixed(3) + ") " + (r.t * 100).toFixed(2) + "%";
    });
    return "linear-gradient(to right, " + stops.join(", ") + ")";
  }

  function mountLegend() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("lightning-legend");
    if (old) old.remove();

    const coarsePointer =
      !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "lightning-legend";
    host.className = "lightning-legend leaflet-control-layers-lightning";
    if (coarsePointer) host.classList.add("is-touch");
    host.innerHTML =
      '<div class="lightning-legend-title"><span>Lightning density</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-lightning-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the lightning density">Probe</button></div>' +
      '<div class="lightning-period-switch" id="lightning-period-switch" role="group" ' +
      'aria-label="Lightning climatology period"></div>' +
      '<div class="lightning-legend-scale">' +
      '<div class="lightning-legend-bar" id="lightning-legend-bar"></div>' +
      '<div class="lightning-legend-row lightning-legend-row-year" id="lightning-ticks-year"></div>' +
      "</div>" +
      '<div class="lightning-legend-detail" id="lightning-legend-detail" hidden></div>' +
      '<div class="lightning-legend-foot" id="lightning-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-lightning-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeToggle();
      });
    }

    ensureMeta()
      .then(() => {
        buildPeriodSwitch();
        buildLegend();
      })
      .catch(() => {});
    refreshProbeToggle();
    return true;
  }

  function buildPeriodSwitch() {
    const host = document.getElementById("lightning-period-switch");
    if (!host || !state.meta) return;
    let html = "";
    for (const p of state.meta.periods || []) {
      const label = p.id === "annual" ? "Annual" : p.label.slice(0, 3);
      html +=
        '<button type="button" class="lightning-period-btn" data-period="' + esc(p.id) + '" ' +
        'aria-pressed="false" title="' + esc(p.label) + '">' + esc(label) + "</button>";
    }
    host.innerHTML = html;
    host.querySelectorAll("[data-period]").forEach((b) => {
      b.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        setPeriod(b.getAttribute("data-period"));
      });
    });
    refreshPeriodButtons();
  }

  function refreshPeriodButtons() {
    const host = document.getElementById("lightning-period-switch");
    if (!host) return;
    host.querySelectorAll("[data-period]").forEach((b) => {
      const on = b.getAttribute("data-period") === state.periodId;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("is-active", on);
      b.disabled = !state.enabled;
      b.style.opacity = state.enabled ? "" : "0.45";
    });
  }

  function waitForLayersControl() {
    if (mountLegend()) return;
    let tries = 0;
    const tick = () => {
      if (mountLegend() || ++tries > 40) return;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  function buildLegend() {
    const meta = state.meta;
    if (!meta) return;
    const bar = document.getElementById("lightning-legend-bar");
    if (bar) bar.style.backgroundImage = gradientCss(meta);

    // The ticks sit at their RAMP position, not at a linear fraction of
    // the value range: the scale is a power law, so 5 and 10 strokes are
    // not evenly spaced across the bar.
    //
    // ONE row of ticks, in the annual-equivalent rate. The colour is a
    // function of the DAILY rate, but the annual rate is a fixed
    // multiple of it, so the two share every position — and the annual
    // numbers are short enough to read. The per-day rate and the total
    // for the selected period are in the probe, where there is room for
    // them.
    const yRow = document.getElementById("lightning-ticks-year");
    if (yRow) yRow.innerHTML = "";
    for (const t of meta.ticks || []) {
      if (!yRow) break;
      const s = document.createElement("span");
      s.className = "lightning-legend-tick";
      s.style.left = (t.t * 100).toFixed(3) + "%";
      s.textContent = String(t.year);
      yRow.appendChild(s);
    }

    const foot = document.getElementById("lightning-legend-foot");
    if (foot) {
      const scope = state.period && state.period.id !== "annual"
        ? state.period.label
        : "annual mean";
      foot.textContent = "WWLLN · " + (meta.years || "") + " · 9.3 km grid · " +
        scope + " · CC BY 4.0";
    }
    refreshPeriodButtons();
    const detail = document.getElementById("lightning-legend-detail");
    if (detail) detail.hidden = true;
  }

  function applyVisibility() {
    const probeBtn = document.getElementById("ctrl-lightning-probe-toggle");
    if (probeBtn) {
      probeBtn.disabled = !state.enabled;
      probeBtn.style.opacity = state.enabled ? "" : "0.45";
    }
    refreshPeriodButtons();
    if (!state.enabled) hideProbe();
  }

  function refreshProbeToggle() {
    const btn = document.getElementById("ctrl-lightning-probe-toggle");
    if (!btn) return;
    btn.classList.toggle("active", state.probeMode);
    btn.textContent = state.probeMode ? "Probe: On" : "Probe";
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
  }

  // ── probe ─────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("lightning-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "lightning-probe";
      el.className = "lightning-probe";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      const host = (state.map && state.map.getContainer()) || document.body;
      host.appendChild(el);
    }
    return el;
  }

  function hideProbe() {
    const el = document.getElementById("lightning-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
    const detail = document.getElementById("lightning-legend-detail");
    if (detail) {
      detail.hidden = true;
      detail.innerHTML = "";
    }
  }

  function showProbe(stored, containerPoint) {
    const el = probeEl();
    if (stored == null || !isFinite(stored)) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const daily = dailyOf(stored);
    const total = yearlyOf(stored);
    const key = daily.toFixed(5);
    if (state.lastProbe !== key) {
      // The unit follows the period: an annual field is a rate per year,
      // a monthly field is a total for that month — and the month has
      // its own length, so "per day" is the only figure that compares
      // two months honestly. It is in the readout for that reason.
      const isAnnual = !state.period || state.period.days === 365;
      const unit = isAnnual ? "strokes/km²/yr" : "strokes/km² in " + state.period.label;
      const html =
        '<span class="lightning-probe-year">' + fmtCount(total) + "</span>" +
        '<span class="lightning-probe-unit">' + esc(unit) + "</span>" +
        '<span class="lightning-probe-daily">' + fmt(daily, 4) + " /km²/day</span>";
      el.innerHTML = html;
      state.lastProbe = key;
      const detail = document.getElementById("lightning-legend-detail");
      if (detail) {
        detail.innerHTML = html;
        detail.hidden = false;
      }
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled || !state.grid) return;
    showProbe(sampleStored(latlng.lat, latlng.lng), containerPoint);
  }

  // ── export surface ───────────────────────────────────────────────────
  // The exported number is the DAILY stroke density in the PUBLISHED
  // unit (strokes km-2 d-1) — the same unit the ramp's power law is
  // defined against, and the unit the legend ticks use.
  //
  // These are STROKE densities, not NASA flash densities: WWLLN sees
  // cloud-to-ground strokes, and the numbers run lower. The exported
  // file says so in its units.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "lightning",
      z: 356,   // the map pane order — the export draws in it too
      label: "⚡ Lightning density (WWLLN)",
      kind: "raster",
      unit: "strokes km-2 d-1",
      attribution: "WWLLN / ARVE Research — Global Lightning Climatology v2",
      licence: "CC BY 4.0",
      source: "https://doi.org/10.5281/zenodo.20277101",
      get period() { return state.period ? (state.period.label || state.periodId) : ""; },
      bands: [{ name: "lightning_density", unit: "strokes km-2 d-1" }],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 4320, rows: 2160, latMin: -89.958333, latMax: 89.958333,
          lonMin: -179.958333, lonMax: 179.958333,
        });
      },
      isActive: () => !!state.grid && !!state.meta,
      sample(lat, lon) {
        const stored = sampleStored(lat, lon);
        if (stored == null || !isFinite(stored)) return null;
        return dailyOf(stored);
      },
      // The colour comes from the LAYER'S OWN LUT — the one the tiles
      // are painted from, so the exported PNG and the map agree.
      color(daily) {
        const lut = state.lut;
        const scale = state.meta && state.meta.grid ? state.meta.grid.scale : 1;
        if (!lut || !scale) return null;
        const idx = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(daily / scale)));
        return [lut[idx * 4], lut[idx * 4 + 1], lut[idx * 4 + 2]];
      },
      alpha(daily) {
        const lut = state.lut;
        const scale = state.meta && state.meta.grid ? state.meta.grid.scale : 1;
        if (!lut || !scale) return 255;
        const idx = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(daily / scale)));
        return lut[idx * 4 + 3];
      },
    });
  }

  // ── public API ────────────────────────────────────────────────────────
  window.LightningLayer = {
    getTileLayer,
    init,
    isEnabled: () => state.enabled,
    setProbeMode: (on) => {
      state.probeMode = !!on;
      storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
      if (!state.probeMode) hideProbe();
      refreshProbeToggle();
    },
    // The map click handler skips the click-to-submit flow while a probe
    // is armed, so a tap reads the density instead of placing a pin.
    blocksClick: () => state.enabled && state.probeMode,
    // HoverInfo "all" mode: a one-line reading for the cursor position.
    sampleAt(latlng) {
      if (!state.enabled || !state.grid) return null;
      const s = sampleStored(latlng.lat, latlng.lng);
      if (s == null || !isFinite(s)) return null;
      return fmtCount(yearlyOf(s)) + " strokes/km²/yr";
    },
    LAYER_NAME: "⚡ Lightning density (WWLLN)",
    DATA_URL: BASE,
    registerExport,
    // Internals exported for the test suite, the way WindLayer exports
    // _advance and setQuality: the sampling and the colour transform
    // are the two things that can be wrong in a way no screenshot shows.
    _test: {
      state,
      sampleStored,
      rampColor,
      alphaAt,
      tileLat,
      pixelLatLon,
      buildLut,
      dailyOf,
      yearlyOf,
      // Inject a published grid without going near the network, so the
      // test can drive the real maths over the real data.
      useGrid(periodId, uint16) {
        state.grids[periodId] = uint16;
        state.periodId = periodId;
        const periods = (state.meta && state.meta.periods) || [];
        state.period = periods.find((p) => p.id === periodId) || null;
        state.grid = uint16;
      },
    },
  };

  registerExport();
})();
