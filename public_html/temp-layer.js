/* ═══════════════════════════════════════════════════════════════════════
   Temperature overlay for the Xyzo map — a filled colour field you can
   read in BOTH °F and °C.

   Source: NOAA NCEP GFS 2 m air temperature, the same 6-hourly analysis
   as the pressure lines, and 100% free (US Government work). There is no
   free temperature *tile* service, and the NASA layers we already show
   are colour composites whose ramp we do not control — so the field is
   rendered here from the grid the worker writes.

   worker/tempmap.py writes two static files:

     /data/temp/meta.json   colour ramp, grid layout, analysis run time
     /data/temp/grid.bin    Int16Array, 0.1 °C per unit, row 0 = -90°

   The grid is fetched once and used twice: painted into a canvas for the
   overlay, and sampled directly for the probe — so what you read IS the
   colour you are looking at.

   The tiles are painted in the browser by a custom L.GridLayer rather
   than written to disk: every *.png under public_html is served
   `immutable` for a year, so a rebuilt tile pyramid would be invisible
   behind a stale version token (the exact bug that hid the Köppen layer
   in 2026-10-22). And unlike a single imageOverlay — which spans one
   copy of the world and leaves a gap past the antimeridian — a grid
   layer repeats.

   Tile rows are linear in MERCATOR y, because these ARE Web Mercator
   tiles; sampling in latitude instead would shift the bands against the
   basemap.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/temp";
  const META_URL = BASE + "/meta.json";
  const GRID_URL = BASE + "/grid.bin";
  const STORE_KEY = "xyzo.tempLayer";
  const PROBE_STORE_KEY = "xyzo.tempProbe";
  const PALETTE_STORE_KEY = "xyzo.tempPalette";

  const state = {
    map: null,
    overlay: null,
    enabled: false,
    probeMode: false,
    meta: null,
    grid: null,
    // The meta and the grid are loaded SEPARATELY — see ensureMeta() /
    // ensureGrid(). A legend mounted at boot needs the meta (2 KB) and
    // must not pull the grid (2 MB).
    metaPromise: null,
    gridPromise: null,
    legendMounted: false,
    lastProbe: null,
    loadPromise: null,
    // Colour style. The ramp is DERIVED on demand from `palette` rather
    // than cached as `rampBase`, because the layer is often OFF when the
    // reader picks a scheme — meta has not loaded yet, and a cached
    // override would be null, so the first paint would fall back to the
    // published colours and quietly disagree with the dropdown.
    palette: "default",
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

  function fOf(c) {
    return c * 9 / 5 + 32;
  }

  // ── data ──────────────────────────────────────────────────────────────
  //
  // **THE META AND THE GRID ARE SEPARATE BECAUSE THEY COST DIFFERENT
  // AMOUNDS.** The meta is a few KB and the LEGEND needs it (the ramp,
  // the range, the run time). The grid is 2 MB and only the MAP needs
  // it. Fetching them together meant that mounting the legend — which
  // happens at BOOT, for every visitor, whether or not the layer is
  // switched on — pulled 2 MB of grid for a layer nobody had asked for.
  // (Measured: with every layer OFF, the page still fetched the
  // temperature, wind, lightning, phytoplankton, wave, CAPE, IVT and
  // magnetic grids — 38 MB.)
  //
  // So: `ensureMeta()` for the legend, `ensureGrid()` for the map, and
  // `ensureData()` for both — which is what the layer's `add` handler
  // wants, because that is the moment the reader has asked for it.
  function ensureMeta() {
    if (state.metaPromise) return state.metaPromise;
    // THE ARCHIVE (the time machine): the archived cycle's own meta,
    // because the live meta describes today's analysis.
    const archiveMeta = window.WeatherArchive && window.WeatherArchive.active()
      ? window.WeatherArchive.metaUrl("temp")
      : null;
    state.metaPromise = fetch(archiveMeta || META_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("meta " + r.status);
        return r.json();
      })
      .then((meta) => {
        state.meta = meta;
        return meta;
      })
      .catch((err) => {
        warn("temperature: meta failed to load", err);
        state.metaPromise = null;
        throw err;
      });
    return state.metaPromise;
  }

  function ensureGrid() {
    if (state.gridPromise) return state.gridPromise;
    // THE ARCHIVE (the time machine): the archived grid for the cycle
    // the reader picked.
    const archiveGrid = window.WeatherArchive && window.WeatherArchive.active()
      ? window.WeatherArchive.gridUrl("temp")
      : null;
    state.gridPromise = fetch(archiveGrid || GRID_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("grid " + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const meta = state.meta;
        state.grid = new Int16Array(buf);
        const expect = meta ? meta.grid.rows * meta.grid.cols : state.grid.length;
        if (state.grid.length !== expect) {
          throw new Error("grid is " + state.grid.length + " values, expected " + expect);
        }
        log("temperature grid loaded", expect, "values, run", meta && meta.run_time);
        return state.grid;
      })
      .catch((err) => {
        warn("temperature: grid failed to load", err);
        state.gridPromise = null;
        throw err;
      });
    return state.gridPromise;
  }

  function ensureData() {
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = ensureMeta()
      .then(() => ensureGrid())
      .then(() => state.meta)
      .catch((err) => {
        warn("temperature: data failed to load", err);
        state.loadPromise = null;
        throw err;
      });
    return state.loadPromise;
  }

  // Bilinear sample of the stored grid, in °C. Longitude wraps, latitude
  // clamps at the poles.
  function sampleC(lat, lon) {
    const meta = state.meta;
    if (!state.grid || !meta) return null;
    const g = meta.grid;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let row = (lat - g.lat_min) / g.lat_step;
    row = Math.max(0, Math.min(g.rows - 1, row));
    const r0 = Math.floor(row);
    const r1 = Math.min(g.rows - 1, r0 + 1);
    const fr = row - r0;

    let col = (lon - g.lon_min) / g.lon_step;
    col = ((col % g.cols) + g.cols) % g.cols;
    const c0 = Math.floor(col);
    const c1 = (c0 + 1) % g.cols;
    const fc = col - c0;

    const at = (r, c) => state.grid[r * g.cols + c];
    const top = at(r0, c0) * (1 - fc) + at(r0, c1) * fc;
    const bot = at(r1, c0) * (1 - fc) + at(r1, c1) * fc;
    return (top * (1 - fr) + bot * fr) / g.scale;
  }

  // ── colour ────────────────────────────────────────────────────────────
  // The canonical ramp lives in field-bake.js — the globe reads the same
  // one, and a second copy of an interpolation is a second source of
  // truth. The local fallback keeps this module usable on its own.
  function rampColor(ramp, c) {
    if (window.XYZO_FIELD_BAKE) return window.XYZO_FIELD_BAKE.rampColor(ramp, c);
    const lo = ramp[0];
    const hi = ramp[ramp.length - 1];
    if (c <= lo.c) return hexToRgb(lo.rgb);
    if (c >= hi.c) return hexToRgb(hi.rgb);
    for (let i = 0; i < ramp.length - 1; i++) {
      const a = ramp[i];
      const b = ramp[i + 1];
      if (c >= a.c && c <= b.c) {
        const t = (c - a.c) / (b.c - a.c);
        const ca = hexToRgb(a.rgb);
        const cb = hexToRgb(b.rgb);
        return [
          Math.round(ca[0] + (cb[0] - ca[0]) * t),
          Math.round(ca[1] + (cb[1] - ca[1]) * t),
          Math.round(ca[2] + (cb[2] - ca[2]) * t),
        ];
      }
    }
    return hexToRgb(hi.rgb);
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // ── rendering ─────────────────────────────────────────────────────────
  // A tile is a Web Mercator tile, so its y axis is Mercator and the
  // latitude of a row comes from the inverse Mercator transform. Painting
  // in latitude instead would shift the bands against the basemap.
  //
  // field-bake.js owns that arithmetic (and the ramp), because the 3D
  // globe bakes the SAME field the same way — one implementation, two
  // views, so they cannot drift. The local fallback keeps this module
  // usable on its own.
  function tileLat(v) {
    if (window.XYZO_FIELD_BAKE) return window.XYZO_FIELD_BAKE.tileLat(v);
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  // Colour lookup table, built once the meta arrives: 0.25 °C per entry,
  // so colouring a pixel is an index into an array, not an interpolation.
  let LUT = null;

  // The active ramp, derived from the chosen palette. Computed rather
  // than cached: recolour() touches ~18 stops, so it costs nothing, and
  // deriving it means the legend, the LUT, the baked canvas and the
  // exporter all read the SAME rule with no stored copy to drift.
  function activeRamp(meta) {
    if (!meta || !meta.ramp) return [];
    if (!state.palette || state.palette === "default") return meta.ramp;
    const R = window.RampStyles;
    if (!R || typeof R.recolor !== "function") return meta.ramp;
    return R.recolor(meta.ramp, state.palette);
  }

  function buildLut(meta) {
    const lo = meta.range_c[0];
    const hi = meta.range_c[1];
    const step = 0.25;
    const n = Math.round((hi - lo) / step) + 1;
    const lut = new Uint8Array(n * 3);
    const ramp = activeRamp(meta);
    for (let i = 0; i < n; i++) {
      const rgb = rampColor(ramp, lo + i * step);
      lut[i * 3] = rgb[0];
      lut[i * 3 + 1] = rgb[1];
      lut[i * 3 + 2] = rgb[2];
    }
    LUT = { data: lut, lo: lo, step: step, n: n };
  }

  // ── the baked field ─────────────────────────────────────────────────
  // The per-pixel sampling loop is expensive: 65k bilinear lookups per
  // tile added up to ~23 ms a tile, half a second for a screenful, and
  // two seconds for a full redraw. So the field is painted ONCE into a
  // single full-world canvas and every tile is then a GPU blit of the
  // right sub-rectangle — about 0 ms.
  //
  // The canvas is square and its rows are linear in Mercator y, because
  // the tile grid is Web Mercator: y covers exactly ±pi over the same
  // width x covers over 2*pi.
  //
  // 1024 is ~2.8 px per degree, which is already finer than the 1° grid
  // the field comes from — a bigger canvas only adds blur-free pixels
  // that hold no information, and the bake is quadratic in the size
  // (68 ms here, 260 ms at 2048).
  const BAKED_W = 1024;
  let BAKED = null;

  function buildBaked() {
    const meta = state.meta;
    const g = meta.grid;
    const W = BAKED_W;
    const H = BAKED_W; // Mercator is a square in these units
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const out = img.data;
    const invStep = 1 / g.scale;

    for (let py = 0; py < H; py++) {
      const lat = tileLat((py + 0.5) / H);
      let row = (lat - g.lat_min) / g.lat_step;
      row = Math.max(0, Math.min(g.rows - 1, row));
      const r0 = Math.floor(row);
      const r1 = Math.min(g.rows - 1, r0 + 1);
      const fr = row - r0;
      const base0 = r0 * g.cols;
      const base1 = r1 * g.cols;

      const o = py * W * 4;
      for (let px = 0; px < W; px++) {
        const lon = -180 + (360 * (px + 0.5)) / W;
        let col = (lon - g.lon_min) / g.lon_step;
        col = ((col % g.cols) + g.cols) % g.cols;
        const c0 = Math.floor(col);
        const c1 = (c0 + 1) % g.cols;
        const fc = col - c0;

        const top = state.grid[base0 + c0] * (1 - fc) + state.grid[base0 + c1] * fc;
        const bot = state.grid[base1 + c0] * (1 - fc) + state.grid[base1 + c1] * fc;
        const tempC = (top * (1 - fr) + bot * fr) * invStep;

        const k = Math.max(0, Math.min(LUT.n - 1, Math.round((tempC - LUT.lo) / LUT.step)));
        const li = k * 3;
        const oi = o + px * 4;
        out[oi] = LUT.data[li];
        out[oi + 1] = LUT.data[li + 1];
        out[oi + 2] = LUT.data[li + 2];
        out[oi + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    BAKED = { canvas: canvas, W: W, H: H };
    return BAKED;
  }

  function ensureBaked() {
    if (BAKED || !state.meta || !state.grid || !LUT) return BAKED;
    const t0 = (typeof performance !== "undefined" ? performance.now() : 0);
    buildBaked();
    log("baked temperature field", BAKED_W + "x" + BAKED_W,
        Math.round((typeof performance !== "undefined" ? performance.now() : 0) - t0) + "ms");
    return BAKED;
  }

  // The colour of a temperature, from the LAYER'S OWN ramp.
  //
  // The exporter uses this so the pixel in the exported PNG is the
  // colour of the temperature under it — the same LUT the tiles are
  // painted from, never a second ramp that could drift.
  function colorFor(c) {
    if (c == null || !Number.isFinite(c)) return null;
    if (!LUT && state.meta) buildLut(state.meta);
    if (!LUT) return null;
    const k = Math.max(0, Math.min(LUT.n - 1, Math.round((c - LUT.lo) / LUT.step)));
    return [LUT.data[k * 3], LUT.data[k * 3 + 1], LUT.data[k * 3 + 2]];
  }

  // Draw the tile's rectangle out of the baked field, wrapping across
  // the antimeridian so a tile that straddles the world edge still
  // shows a continuous field.
  function blitTile(ctx, coords, size) {
    const n = 1 << coords.z;
    const sw = BAKED.W / n;
    const sh = BAKED.H / n;
    let sx = (coords.x / n) * BAKED.W;
    const sy = (coords.y / n) * BAKED.H;

    ctx.imageSmoothingEnabled = true;
    if (sx >= 0 && sx + sw <= BAKED.W) {
      ctx.drawImage(BAKED.canvas, sx, sy, sw, sh, 0, 0, size, size);
      return;
    }
    // Straddles (or is beyond) the world edge — wrap it.
    sx = ((sx % BAKED.W) + BAKED.W) % BAKED.W;
    if (sx + sw <= BAKED.W) {
      ctx.drawImage(BAKED.canvas, sx, sy, sw, sh, 0, 0, size, size);
    } else {
      const first = BAKED.W - sx;
      const dw = size * (first / sw);
      ctx.drawImage(BAKED.canvas, sx, sy, first, sh, 0, 0, dw, size);
      ctx.drawImage(BAKED.canvas, 0, sy, sw - first, sh, dw, 0, size - dw, size);
    }
  }

  function paintTile(canvas, coords) {
    if (!state.grid || !state.meta || !LUT) return;
    const baked = ensureBaked();
    if (!baked) return;
    blitTile(canvas.getContext("2d"), coords, canvas.width);
  }

  // ── layer ─────────────────────────────────────────────────────────────
  // A custom L.GridLayer rather than PNG tiles. Two reasons:
  //   • *.png under public_html is served immutable for a year, so a
  //     rebuilt tile set would be invisible behind a stale version
  //     token — the bug that hid the Köppen layer in 2026-10-22.
  //   • an imageOverlay spans ONE copy of the world and leaves a gap when
  //     you pan past the antimeridian; a GridLayer repeats.
  // Only the tiles actually on screen are ever painted, so the cost is
  // a few milliseconds when the view settles rather than a full-world
  // canvas at load.
  function makeTileLayer() {
    const TempGrid = L.GridLayer.extend({
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
    return new TempGrid({
      pane: "tempPane",
      // Nearly opaque: at lower opacity the basemap bleeds through and
      // flattens the colour differences this scale exists to show. The
      // slider is right there for anyone who wants the geography back.
      opacity: 0.9,
      attribution: "NOAA NCEP GFS",
    });
  }

  function getTileLayer() {
    if (state.overlay) return state.overlay;
    if (typeof L === "undefined") return null;
    state.overlay = makeTileLayer();
    // The layers dropdown's palette picker calls setPalette on the LAYER
    // OBJECT — that is what WEATHER_OVERLAYS holds — not on
    // window.TempLayer. Same distinction that left population's opacity
    // slider reading a stale 1 until setOpacity was wrapped.
    state.overlay.setPalette = (n) => setPalette(n);
    state.overlay.getPalette = () => state.palette;
    state.overlay.on("add", () => {
      state.enabled = true;
      storageSet(STORE_KEY, "1");
      ensureData()
        .then((meta) => {
          if (!LUT) buildLut(meta);
          // One expensive bake (a few hundred ms, once), after which
          // every tile is a blit — and every pan and zoom after that is
          // effectively free.
          ensureBaked();
          // Tiles created before the field was ready were painted blank.
          if (state.enabled) state.overlay.redraw();
        })
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

    if (!map.getPane("tempPane")) {
      map.createPane("tempPane");
      map.getPane("tempPane").style.zIndex = "355";
      map.getPane("tempPane").style.pointerEvents = "none";
    }

    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";
    // The colour scheme is a preference like the probe: it survives a
    // reload and is applied by activeRamp() as soon as meta lands.
    state.palette = storageGet(PALETTE_STORE_KEY, "default") || "default";

    // Restore the previous choice. Like the climate overlay this runs
    // before the layers control is created, so the control picks the
    // checked state up from the map.
    if (state.overlay && storageGet(STORE_KEY, "0") === "1") {
      try { state.overlay.addTo(state.map); } catch (_) {}
    }

    map.on("mousemove", (e) => {
      if (state.enabled && !state.probeMode) {
        // HoverInfo "all" mode aggregates every layer's reading into
        // one card — stand down so two boxes don't fight the cursor.
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

    // Warming the data at idle means switching the layer on is instant.
    //
    // ONLY when the layer is already on. The grid is 2 MB (0.25° since
    // 2026-11-04) and the layer is OFF by default: warming it for
    // every visitor who never switches the temperature on put 2 MB on
    // the first page load for nothing. The wind layer does not warm at
    // all — it fetches in `onAdd`, when the layer is actually added.
    if (state.enabled) {
      const warm = () => ensureData().catch(() => {});
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
      else setTimeout(warm, 3000);
    }
  }

  // ── legend ────────────────────────────────────────────────────────────
  function gradient(meta) {
    const span = meta.range_c[1] - meta.range_c[0];
    // activeRamp, not meta.ramp: the legend bar must show the PALETTE THE
    // TILES ARE PAINTED WITH. Reading meta.ramp here would let the picker
    // change the map while the legend kept promising the published
    // scheme — the same "two sources of truth" trap as the opacity slider.
    const stops = activeRamp(meta)
      .map((r) => r.rgb + " " + (((r.c - meta.range_c[0]) / span) * 100).toFixed(2) + "%")
      .join(", ");
    return "linear-gradient(to right, " + stops + ")";
  }

  function mountLegend() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("temp-legend");
    if (old) old.remove();

    const coarsePointer =
      !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "temp-legend";
    host.className = "temp-legend leaflet-control-layers-temp";
    host.innerHTML =
      '<div class="temp-legend-title"><span>Temperature</span>' +
      '<button type="button" class="temp-probe-toggle" id="ctrl-temp-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the temperature">Probe</button></div>' +
      '<div class="temp-legend-scale">' +
      '<div class="temp-legend-bar" id="temp-legend-bar"></div>' +
      '<div class="temp-legend-row temp-legend-row-c" id="temp-ticks-c"></div>' +
      '<div class="temp-legend-row temp-legend-row-f" id="temp-ticks-f"></div>' +
      "</div>" +
      '<div class="temp-legend-detail" id="temp-legend-detail"></div>' +
      '<div class="temp-legend-foot">Hover the map for an exact reading</div>';
    if (coarsePointer) host.classList.add("is-touch");
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-temp-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeToggle();
      });
    }
    refreshProbeToggle();

    // The legend needs the META — the ramp, the range, the run time.
    // The GRID is 2 MB and only the map needs it, so mounting the
    // legend (which happens at BOOT for every visitor) must not fetch it.
    ensureMeta()
      .then(buildLegend)
      .catch(() => {});
    return true;
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

  function buildLegend(meta) {
    const bar = document.getElementById("temp-legend-bar");
    if (!bar) return;
    bar.style.backgroundImage = gradient(meta);
    const detail = document.getElementById("temp-legend-detail");
    if (detail) detail.innerHTML = "";

    const span = meta.range_c[1] - meta.range_c[0];
    const cRow = document.getElementById("temp-ticks-c");
    const fRow = document.getElementById("temp-ticks-f");
    if (cRow) cRow.innerHTML = "";
    if (fRow) fRow.innerHTML = "";
    for (const t of meta.ticks) {
      const pct = (((t.c - meta.range_c[0]) / span) * 100).toFixed(3) + "%";
      if (cRow) {
        const s = document.createElement("span");
        s.className = "temp-legend-tick";
        s.style.left = pct;
        s.textContent = String(t.c);
        cRow.appendChild(s);
      }
      if (fRow) {
        const s = document.createElement("span");
        s.className = "temp-legend-tick";
        s.style.left = pct;
        s.textContent = String(t.f);
        fRow.appendChild(s);
      }
    }
    const foot = document.querySelector("#temp-legend .temp-legend-foot");
    if (foot && meta.run_time) {
      foot.textContent = "NOAA NCEP GFS · " + meta.variable + " · " + meta.run_time.replace("T", " ").replace("Z", " UTC");
    }
  }

  function applyVisibility() {
    const probeBtn = document.getElementById("ctrl-temp-probe-toggle");
    if (probeBtn) {
      probeBtn.disabled = !state.enabled;
      probeBtn.style.opacity = state.enabled ? "" : "0.45";
    }
    if (!state.enabled) hideProbe();
  }

  function refreshProbeToggle() {
    const btn = document.getElementById("ctrl-temp-probe-toggle");
    if (!btn) return;
    btn.classList.toggle("active", state.probeMode);
    btn.textContent = state.probeMode ? "Probe: On" : "Probe";
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
  }

  // ── probe ─────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("temp-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "temp-probe";
      el.className = "temp-probe";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      const host = (state.map && state.map.getContainer()) || document.body;
      host.appendChild(el);
    }
    return el;
  }

  function hideProbe() {
    const el = document.getElementById("temp-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
    const detail = document.getElementById("temp-legend-detail");
    if (detail) detail.innerHTML = "";
  }

  function showProbe(c, containerPoint) {
    const el = probeEl();
    if (c == null) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const f = fOf(c);
    const key = c.toFixed(1);
    if (state.lastProbe !== key) {
      // Both units, always — that is the point of the layer.
      el.innerHTML =
        '<span class="temp-probe-c">' + key + "&#8451;</span>" +
        '<span class="temp-probe-f">' + f.toFixed(1) + "&#8457;</span>";
      state.lastProbe = key;
      const detail = document.getElementById("temp-legend-detail");
      if (detail) detail.innerHTML = el.innerHTML;
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled || !state.grid) return;
    showProbe(sampleC(latlng.lat, latlng.lng), containerPoint);
  }

  // ── export surface ───────────────────────────────────────────────────
  // The exporter never re-implements a layer: it asks the layer for its
  // own numbers and its own colours. So the temperature in a downloaded
  // GeoTIFF is the temperature the probe reads — same sampler, same
  // ramp, same grid.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "temperature",
      z: 355,   // the map pane order — the export draws in it too
      label: "🌡️ Temperature (GFS)",
      kind: "raster",
      unit: "°C",
      attribution: "NOAA NCEP GFS — 2 m air temperature",
      licence: "US Government work (public domain)",
      source: "https://www.ncei.noaa.gov/products/weather-climatic-modeling-global-system",
      get period() { return state.meta ? state.meta.run_time : ""; },
      bands: [{ name: "air_temperature", unit: "°C" }],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 360, rows: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360,
        });
      },
      isActive: () => !!state.grid,
      sample(lat, lon) {
        const c = sampleC(lat, lon);
        return c == null || !Number.isFinite(c) ? null : c;
      },
      color: colorFor,
    });
  }

  // ── public API ────────────────────────────────────────────────────────
  // ── colour style ─────────────────────────────────────────────────────
  // Swap the ramp's COLOURS, keep its POSITIONS: the stop values are
  // what the probe reads and the legend prints, so only the colour may
  // change — recolour() rewrites `rgb` and copies `c` through untouched.
  //
  // MODULE-LEVEL, not an object method, because the arrow that the tile
  // layer exposes to the dropdown calls it by name (see getTileLayer).
  //
  // The choice is stored even when meta has not loaded: the layer is
  // usually OFF when someone picks a scheme, and activeRamp() derives the
  // ramp on demand, so the first paint after enabling uses exactly what
  // the dropdown shows instead of falling back to the published colours.
  function setPalette(name) {
    const R = window.RampStyles;
    if (!R || typeof R.recolor !== "function") return false;
    const want = name || "default";
    if (want === state.palette) return true;
    state.palette = want;
    try { localStorage.setItem(PALETTE_STORE_KEY, want); } catch (_) {}
    // Repaint only if there is data painted to fix up: before meta
    // arrives there is nothing on screen to correct.
    if (state.meta) {
      LUT = null;
      BAKED = null;
      // The legend bar must be rebuilt too, or it keeps promising the
      // PUBLISHED scheme while the tiles paint the chosen one — a reader
      // reads the bar as the key to what they are looking at.
      buildLegend(state.meta);
      if (state.overlay && typeof state.overlay.redraw === "function") {
        state.overlay.redraw();
      }
    }
    return true;
  }

  window.TempLayer = {
    getTileLayer,
    init,
    // THE ARCHIVE (the time machine): drop the cached grid and meta so
    // the layer fetches again — from the ARCHIVE when a past moment is
    // selected. Without this the layer would keep drawing TODAY's grid
    // while the reader is looking at last March.
    resetForArchive() {
      state.metaPromise = null;
      state.gridPromise = null;
      state.meta = null;
      state.grid = null;
      state.overlay = null;
    },
    isEnabled: () => state.enabled,
    setProbeMode: (on) => {
      state.probeMode = !!on;
      storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
      if (!state.probeMode) hideProbe();
      refreshProbeToggle();
    },
    // The map click handler skips the click-to-submit flow while a probe
    // is armed, so a tap reads the temperature instead of placing a pin.
    blocksClick: () => state.enabled && state.probeMode,
    // HoverInfo "all" mode: a one-line reading for the cursor position.
    sampleAt(latlng) {
      if (!state.enabled || !state.grid) return null;
      const c = sampleC(latlng.lat, latlng.lng);
      if (c == null || !isFinite(c)) return null;
      return (Math.round(c * 10) / 10) + " °C (" +
        (Math.round((c * 9 / 5 + 32) * 10) / 10) + " °F)";
    },
    LAYER_NAME: "🌡️ Temperature (GFS)",
    // ── colour style ─────────────────────────────────────────────────
    // setPalette is a MODULE-LEVEL function, not an object method: the
    // arrow attached to the tile layer calls it by name, and an object
    // property is not in that scope — which threw
    // "ReferenceError: setPalette is not defined" and silently left the
    // picker writing nothing to localStorage.
    setPalette,
    getPalette: () => state.palette,
    DATA_URL: BASE,
    registerExport,
  };

  // Register the export surface as soon as the module loads. The
  // surface reads `state` lazily, so it does not need the data to be
  // loaded yet — `isActive()` reports false until it is.
  registerExport();
})();
