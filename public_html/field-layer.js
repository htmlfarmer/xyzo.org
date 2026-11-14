/* ═══════════════════════════════════════════════════════════════════════
   A reusable scalar-field overlay for the Xyzo map.

   One factory, several layers. Each instance paints a filled colour
   field from a grid the worker baked, and reads a point out of the same
   grid — so what the probe reads IS the colour you are looking at.

   The contract for the meta.json / grid.bin pair:

     /data/<name>/meta.json
         source, variable, run_time, license, attribution, unit
         grid   { file, cols, rows, lat_min, lat_max, lon_min,
                  lat_step, lon_step, scale, dtype }
         range  [lo, hi]        the display scale
         ramp   [{ v, rgb }]    absolute value -> colour
         ticks  [number]        the legend's labels

     /data/<name>/grid.bin
         a Uint16Array, `scale` units per value, row-major,
         row 0 = the southernmost latitude, column 0 = longitude 0.

   The tiles are painted in the browser by a custom L.GridLayer rather
   than written to disk: every *.png under public_html is served
   `immutable` for a year, so a rebuilt tile pyramid would be invisible
   behind a stale version token (the exact bug that hid the Köppen layer
   in 2026-10-22). And unlike a single imageOverlay — which spans one
   copy of the world and leaves a gap past the antimeridian — a grid
   layer repeats.

   Tile rows are linear in MERCATOR y, because these ARE Web Mercator
   tiles; sampling in latitude instead would shift the bands against
   the basemap.

   Usage:
     const layer = window.createFieldLayer({
       id: "cape",
       layerName: "⛈️ Convective instability (CAPE)",
       base: "/data/cape",
       pane: "capePane",
       paneZ: 346,
       storeKey: "xyzo.capeLayer",
       probeStoreKey: "xyzo.capeProbe",
       legendTitle: "Convective instability",
       format: (v) => Math.round(v) + " J/kg",
     });
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  function createFieldLayer(opts) {
    const BASE = opts.base;
    const META_URL = BASE + "/meta.json";
    const GRID_URL = BASE + "/" + (opts.gridFile || "grid.bin");
    const STORE_KEY = opts.storeKey;
    const PROBE_STORE_KEY = opts.probeStoreKey;
    const LEGEND_ID = opts.id + "-legend";
    const PROBE_ID = opts.id + "-probe";
    const PROBE_TOGGLE_ID = "ctrl-" + opts.id + "-probe-toggle";

    const state = {
      map: null,
      overlay: null,
      enabled: false,
      probeMode: false,
      meta: null,
      grid: null,
      // The meta and the grid load SEPARATELY — see ensureMeta() /
      // ensureGrid(). A legend mounted at boot needs the meta (a few
      // KB) and must not pull the grid (megabytes).
      metaPromise: null,
      gridPromise: null,
      legendMounted: false,
      lastProbe: null,
      loadPromise: null,
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

    // ── data ──────────────────────────────────────────────────────────────
    //
    // **THE META AND THE GRID ARE SEPARATE.** The meta is a few KB and
    // the LEGEND needs it; the grid is megabytes and only the MAP needs
    // it. Fetching them together made every legend mount — which happens
    // at BOOT for every visitor, whether or not the layer is switched on
    // — pull the grid as well. Measured: with every layer OFF the page
    // still fetched the temperature, wind, lightning, phytoplankton,
    // wave, CAPE, IVT and magnetic grids — 38 MB.
    function ensureMeta() {
      if (state.metaPromise) return state.metaPromise;
      // `opts.loadMeta` — the meta is ANOTHER MODULE'S FILE (the
      // wind-speed field's meta is the WIND's meta, reshaped). Fetching
      // it directly is 1 KB; getting it through `loadData()` would drag
      // the 4 MB grid in with it, at boot, for a layer that is OFF.
      if (opts.loadMeta) {
        state.metaPromise = Promise.resolve()
          .then(() => opts.loadMeta())
          .then((meta) => adoptMeta(meta))
          .catch((err) => {
            warn(opts.id + ": meta failed to load", err);
            state.metaPromise = null;
            throw err;
          });
        return state.metaPromise;
      }
      // A layer whose data comes from elsewhere (the wind-speed field
      // reads WindLayer's own grid) already has its meta in hand.
      if (opts.data && opts.data.meta) {
        state.metaPromise = Promise.resolve(adoptMeta(opts.data.meta));
        return state.metaPromise;
      }
      // And a layer with no BASE of its own has nothing to fetch one
      // from — asking would be `undefined/meta.json`, a 404 on every
      // page load. Its meta arrives with the data.
      if (!BASE) {
        state.metaPromise = Promise.resolve(state.meta || null);
        return state.metaPromise;
      }
      state.metaPromise = fetch(META_URL, { cache: "no-cache" })
        .then((r) => {
          if (!r.ok) throw new Error("meta " + r.status);
          return r.json();
        })
        .then((meta) => adoptMeta(meta))
        .catch((err) => {
          warn(opts.id + ": meta failed to load", err);
          state.metaPromise = null;
          throw err;
        });
      return state.metaPromise;
    }

    // The grid half of ensureData(), for the case where the bytes are
    // ours to fetch. The hooks (`opts.loadData`, `opts.data`) are the
    // layers whose grid is owned by another module — those fetch through
    // ensureData() as before, because their grid is already on its way.
    function ensureGrid() {
      if (opts.loadData || opts.data) return ensureData();
      // No BASE and no hook: there is no grid of ours to fetch. Reject
      // rather than ask for `undefined/grid.bin` — and reject rather
      // than call ensureData(), which would come straight back here.
      if (!BASE) return Promise.reject(new Error("no data source"));
      if (state.gridPromise) return state.gridPromise;
      state.gridPromise = Promise.all([ensureMeta(), fetch(GRID_URL, { cache: "no-cache" })])
        .then(([, r]) => {
          if (!r.ok) throw new Error("grid " + r.status);
          return r.arrayBuffer();
        })
        .then((buf) => {
          const meta = state.meta;
          const dtype = (meta.grid && meta.grid.dtype) || "uint16";
          const Ctor = dtype === "int16" ? Int16Array : Uint16Array;
          return adoptData(meta, new Ctor(buf));
        })
        .catch((err) => {
          warn(opts.id + ": grid failed to load", err);
          state.gridPromise = null;
          throw err;
        });
      return state.gridPromise;
    }

    function ensureData() {
      if (state.loadPromise) return state.loadPromise;
      // `opts.loadData` — the data comes from somewhere else.
      //
      // The wind layer loads ONE grid.bin and both its animation and
      // its speed field read it: the speed is the magnitude of the u/v
      // pair, so publishing and fetching the same bytes twice would be
      // pure waste. The hook hands over the raw grid and the meta.
      if (opts.loadData) {
        state.loadPromise = Promise.resolve()
          .then(() => opts.loadData())
          .then((d) => adoptData(d.meta, d.raw))
          .catch((err) => {
            warn(opts.id + ": data failed to load", err);
            state.loadPromise = null;
            throw err;
          });
        return state.loadPromise;
      }
      // `opts.data` — the data is ALREADY loaded by the module that
      // owns it.
      if (opts.data && opts.data.meta && opts.data.grid) {
        state.loadPromise = Promise.resolve(adoptData(opts.data.meta, opts.data.grid));
        return state.loadPromise;
      }
      state.loadPromise = ensureGrid()
        .then(() => adoptData(state.meta, state.grid))
        .catch((err) => {
          warn(opts.id + ": data failed to load", err);
          state.loadPromise = null;
          throw err;
        });
      return state.loadPromise;
    }

    // Take the published grid and turn it into the ONE number per cell
    // this layer bakes.
    //
    // `opts.derive` is how a layer with more than one value per cell
    // uses the factory: the wind publishes u AND v (two planes), and the
    // speed field wants the magnitude of the pair. The derivation is the
    // LAYER's business — the factory only knows how to bake and drape a
    // scalar field, and it must not grow a second notion of what a wind
    // is.
    // The META only. Storing it is enough for the legend and the probe
    // to describe the field; the grid comes later, when the layer is
    // actually switched on.
    function adoptMeta(meta) {
      state.meta = meta;
      return meta;
    }

    function adoptData(meta, raw) {
      state.meta = meta;
      const g = meta.grid;
      const grid = opts.derive ? opts.derive(raw, meta) : raw;
      const expect = g.rows * g.cols;
      if (grid.length !== expect) {
        throw new Error("grid is " + grid.length + " values, expected " + expect);
      }
      state.grid = grid;
      log(opts.id + " grid loaded", expect, "values, run", meta.run_time);
      return meta;
    }

    // Bilinear sample of the stored grid. Longitude wraps, latitude
    // clamps at the poles.
    //
    // A layer may hand in its OWN sampler (`opts.sampleValue`) when the
    // number it prints has to come from somewhere else — the wind-speed
    // field prints the magnitude of the wind animation's u/v pair, and
    // it has to read THAT pair rather than a magnitude grid derived
    // from it, or the two layers print two different numbers for the
    // same air. Returning `undefined` falls back to this grid.
    function sampleDefault(lat, lon) {
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

    function sampleValue(lat, lon) {
      if (typeof opts.sampleValue === "function") {
        const v = opts.sampleValue(lat, lon);
        if (v !== undefined) return v;
      }
      return sampleDefault(lat, lon);
    }

    // ── colour ────────────────────────────────────────────────────────────
    function hexToRgb(hex) {
      const v = parseInt(hex.slice(1), 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    // The ramp is keyed by ABSOLUTE value, so the stops can be spaced
    // unevenly — which is what lets a colour land exactly on a
    // meaningful threshold (an atmospheric-river category, say) rather
    // than at a round fraction of the range.
    function rampColor(ramp, v) {
      if (!ramp || !ramp.length) return [0, 0, 0];
      const lo = ramp[0];
      const hi = ramp[ramp.length - 1];
      if (v <= lo.v) return hexToRgb(lo.rgb);
      if (v >= hi.v) return hexToRgb(hi.rgb);
      for (let i = 0; i < ramp.length - 1; i++) {
        const a = ramp[i];
        const b = ramp[i + 1];
        if (v >= a.v && v <= b.v) {
          const span = b.v - a.v;
          const t = span > 0 ? (v - a.v) / span : 0;
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

    // ── rendering ─────────────────────────────────────────────────────────
    // A tile is a Web Mercator tile, so its y axis is Mercator and the
    // latitude of a row comes from the inverse Mercator transform.
    function tileLat(v) {
      return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
    }

    // Colour lookup table, built once the meta arrives: one entry per
    // step of the display range, so colouring a pixel is an index into
    // an array rather than an interpolation.
    let LUT = null;

    function buildLut(meta) {
      const lo = meta.range[0];
      const hi = meta.range[1];
      const step = (hi - lo) / 2048;
      const n = 2049;
      const lut = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        const rgb = rampColor(meta.ramp, lo + i * step);
        lut[i * 3] = rgb[0];
        lut[i * 3 + 1] = rgb[1];
        lut[i * 3 + 2] = rgb[2];
      }
      LUT = { data: lut, lo: lo, step: step, n: n };
    }

    // ── the baked field ─────────────────────────────────────────────────
    // The per-pixel sampling loop is expensive: 65k bilinear lookups per
    // tile added up to ~23 ms a tile, half a second for a screenful.
    // So the field is painted ONCE into a single full-world canvas and
    // every tile is then a GPU blit of the right sub-rectangle.
    //
    // The canvas is square and its rows are linear in Mercator y,
    // because the tile grid is Web Mercator: y covers exactly ±pi over
    // the same width x covers over 2*pi.
    const BAKED_W = 1024;
    let BAKED = null;

    function buildBaked() {
      const meta = state.meta;
      const g = meta.grid;
      const W = BAKED_W;
      const H = BAKED_W;
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
          const value = (top * (1 - fr) + bot * fr) * invStep;

          const k = Math.max(0, Math.min(LUT.n - 1, Math.round((value - LUT.lo) / LUT.step)));
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
      log("baked " + opts.id + " field", BAKED_W + "x" + BAKED_W,
        Math.round((typeof performance !== "undefined" ? performance.now() : 0) - t0) + "ms");
      return BAKED;
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
    //   • an imageOverlay spans ONE copy of the world and leaves a gap
    //     when you pan past the antimeridian; a GridLayer repeats.
    function makeTileLayer() {
      const FieldGrid = L.GridLayer.extend({
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
        // L.TileLayer supplies setOpacity; a bare GridLayer does not,
        // and the layers dropdown calls it for every overlay.
        setOpacity(value) {
          const v = Math.max(0, Math.min(1, Number(value)));
          if (!Number.isFinite(v)) return;
          this.options.opacity = v;
          if (this._container) this._container.style.opacity = String(v);
        },
        getOpacity() {
          return this.options.opacity;
        },
      });
      return new FieldGrid({
        pane: opts.pane,
        // Nearly opaque: at lower opacity the basemap bleeds through
        // and flattens the colour differences this scale exists to show.
        opacity: opts.defaultOpacity != null ? opts.defaultOpacity : 0.85,
        attribution: opts.attribution || "NOAA NCEP GFS",
      });
    }

    function getTileLayer() {
      if (state.overlay) return state.overlay;
      if (typeof L === "undefined") return null;
      state.overlay = makeTileLayer();
      state.overlay.on("add", () => {
        state.enabled = true;
        storageSet(STORE_KEY, "1");
        ensureData()
          .then((meta) => {
            if (!LUT) buildLut(meta);
            // One expensive bake (a few hundred ms, once), after which
            // every tile is a blit.
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

      if (!map.getPane(opts.pane)) {
        map.createPane(opts.pane);
        map.getPane(opts.pane).style.zIndex = String(opts.paneZ);
        map.getPane(opts.pane).style.pointerEvents = "none";
      }

      state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";

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

      // Warming the data at idle means switching the layer on is
      // instant — **ONLY when the layer is already on.** A grid is
      // megabytes and the layer is OFF by default: warming it for every
      // visitor who never switches it on put those megabytes on their
      // first page load for nothing (measured: with every layer OFF the
      // page still fetched 38 MB of overlay data). The legend, which
      // DOES need the meta at boot, fetches that separately — see
      // ensureMeta(). This is the temperature layer's rule.
      if (state.enabled) {
        const warm = () => ensureData().catch(() => {});
        if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
        else setTimeout(warm, 3000);
      }
    }

    // ── legend ────────────────────────────────────────────────────────────
    function gradient(meta) {
      const span = meta.range[1] - meta.range[0];
      const stops = meta.ramp
        .map((r) => r.rgb + " " + (((r.v - meta.range[0]) / span) * 100).toFixed(2) + "%")
        .join(", ");
      return "linear-gradient(to right, " + stops + ")";
    }

    function mountLegend() {
      if (state.legendMounted) return true;
      const section = document.querySelector(".leaflet-control-layers-list");
      if (!section) return false;

      const old = document.getElementById(LEGEND_ID);
      if (old) old.remove();

      const coarsePointer =
        !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
        (navigator.maxTouchPoints || 0) > 0;

      const host = document.createElement("div");
      host.id = LEGEND_ID;
      host.className = "field-legend leaflet-control-layers-" + opts.id;
      host.innerHTML =
        '<div class="field-legend-title"><span>' + escapeHtml(opts.legendTitle) + "</span>" +
        '<button type="button" class="field-probe-toggle" id="' + PROBE_TOGGLE_ID + '" ' +
        'aria-pressed="false" title="Tap the map to read the value">Probe</button></div>' +
        '<div class="field-legend-scale">' +
        '<div class="field-legend-bar" id="' + LEGEND_ID + '-bar"></div>' +
        '<div class="field-legend-row" id="' + LEGEND_ID + '-ticks"></div>' +
        "</div>" +
        '<div class="field-legend-detail" id="' + LEGEND_ID + '-detail"></div>' +
        '<div class="field-legend-foot">Hover the map for an exact reading</div>';
      if (coarsePointer) host.classList.add("is-touch");
      section.appendChild(host);
      state.legendMounted = true;

      const probeBtn = host.querySelector("#" + PROBE_TOGGLE_ID);
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

      // The legend needs the META — the ramp, the range. The GRID is
      // megabytes and only the map needs it, so a legend mounted at boot
      // must not fetch it. The `add` handler fetches both.
      //
      // A layer whose data comes from ANOTHER module (the wind-speed
      // field reads WindLayer's own grid) has no BASE of its own to
      // fetch a meta from — asking for `undefined/meta.json` is a 404
      // on every page load. Its meta arrives WITH the data, so that one
      // builds its legend when the data lands, as it always did.
      ensureMeta()
        .then(buildLegend)
        .catch(() => {});
      return true;
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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
      const bar = document.getElementById(LEGEND_ID + "-bar");
      if (!bar) return;
      bar.style.backgroundImage = gradient(meta);
      const detail = document.getElementById(LEGEND_ID + "-detail");
      if (detail) detail.innerHTML = "";

      const span = meta.range[1] - meta.range[0];
      const row = document.getElementById(LEGEND_ID + "-ticks");
      if (row) row.innerHTML = "";
      for (const t of meta.ticks || []) {
        const pct = (((t - meta.range[0]) / span) * 100).toFixed(3) + "%";
        if (row) {
          const s = document.createElement("span");
          s.className = "field-legend-tick";
          s.style.left = pct;
          s.textContent = String(t);
          row.appendChild(s);
        }
      }

      // The layer's own extra explanation — an atmospheric-river
      // category key, say.
      if (opts.legendNote) {
        const note = document.createElement("div");
        note.className = "field-legend-note";
        note.innerHTML = opts.legendNote(meta);
        if (detail) detail.appendChild(note);
      }

      const foot = document.querySelector("#" + LEGEND_ID + " .field-legend-foot");
      if (foot && meta.run_time) {
        const src = meta.source || "";
        foot.textContent = src + " · " + (meta.variable || "") + " · " +
          meta.run_time.replace("T", " ").replace("Z", " UTC");
      }
    }

    function applyVisibility() {
      const probeBtn = document.getElementById(PROBE_TOGGLE_ID);
      if (probeBtn) {
        probeBtn.disabled = !state.enabled;
        probeBtn.style.opacity = state.enabled ? "" : "0.45";
      }
      if (!state.enabled) hideProbe();
    }

    function refreshProbeToggle() {
      const btn = document.getElementById(PROBE_TOGGLE_ID);
      if (!btn) return;
      btn.classList.toggle("active", state.probeMode);
      btn.textContent = state.probeMode ? "Probe: On" : "Probe";
      btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
    }

    // ── probe ─────────────────────────────────────────────────────────────
    function probeEl() {
      let el = document.getElementById(PROBE_ID);
      if (!el) {
        el = document.createElement("div");
        el.id = PROBE_ID;
        el.className = "field-probe";
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        el.hidden = true;
        const host = (state.map && state.map.getContainer()) || document.body;
        host.appendChild(el);
      }
      return el;
    }

    function hideProbe() {
      const el = document.getElementById(PROBE_ID);
      if (el) el.hidden = true;
      state.lastProbe = null;
      const detail = document.getElementById(LEGEND_ID + "-detail");
      if (detail && !opts.legendNote) detail.innerHTML = "";
    }

    function showProbe(v, containerPoint) {
      const el = probeEl();
      if (v == null) {
        el.hidden = true;
        state.lastProbe = null;
        return;
      }
      const text = opts.format(v);
      if (state.lastProbe !== text) {
        el.innerHTML = '<span class="field-probe-value">' + escapeHtml(text) + "</span>";
        state.lastProbe = text;
        const detail = document.getElementById(LEGEND_ID + "-detail");
        if (detail) {
          const note = detail.querySelector(".field-legend-note");
          detail.innerHTML = el.innerHTML;
          if (note) detail.appendChild(note);
        }
      }
      el.hidden = false;
      if (containerPoint) {
        el.style.left = containerPoint.x + 14 + "px";
        el.style.top = containerPoint.y + 14 + "px";
      }
    }

    function updateProbe(latlng, containerPoint) {
      // A layer whose reading is ALREADY on screen stands down. The wind
      // SPEED field is the magnitude of the wind animation's u/v pair:
      // with both on, the reader was shown "2.3 m/s · 8 km/h" and
      // "2.4 m/s · 9 km/h" in two boxes at the same spot — two numbers
      // for the same air, one of them from a different interpolation.
      if (typeof opts.readingGuard === "function" && opts.readingGuard()) {
        hideProbe();
        return;
      }
      if (!state.enabled || !state.grid) return;
      showProbe(sampleValue(latlng.lat, latlng.lng), containerPoint);
    }

    // ── public API ────────────────────────────────────────────────────────
    const api = {
      getTileLayer,
      init,
      isEnabled: () => state.enabled,
      setProbeMode: (on) => {
        state.probeMode = !!on;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeToggle();
      },
      // The map click handler skips the click-to-submit flow while a
      // probe is armed, so a tap reads the value instead of placing a
      // pin.
      blocksClick: () => state.enabled && state.probeMode,
      // HoverInfo "all" mode: a one-line reading for the cursor position.
      sampleAt(latlng) {
        // The same guard the probe uses: a reading that is already on
        // screen does not get a second row in the hover card.
        if (typeof opts.readingGuard === "function" && opts.readingGuard()) return null;
        if (!state.enabled || !state.grid) return null;
        const v = sampleValue(latlng.lat, latlng.lng);
        if (v == null || !isFinite(v)) return null;
        return opts.format(v);
      },
      getMeta: () => state.meta,
      LAYER_NAME: opts.layerName,
      DATA_URL: BASE,
      registerExport,
      _state: state,
    };

    // ── export surface ───────────────────────────────────────────────────
    // The factory serves every "field" layer (CAPE, IVT, …), so the
    // export surface is registered here once and every field gets it.
    //
    // The colour comes from the LAYER'S OWN ramp, keyed by absolute
    // value — so a threshold-coloured field (an atmospheric river
    // category, say) exports with the same colour it has on screen.
    function registerExport() {
      if (!window.XYZO_EXPORT) return;
      const g = () => (state.meta && state.meta.grid) || {};
      window.XYZO_EXPORT.register({
        id: opts.id,
        label: opts.layerName,
        kind: "raster",
        // The unit, the attribution and the grid geometry all come from
        // meta.json — which has NOT been fetched yet when the layer is
        // created. So they are GETTERS, read at export time, when the
        // data is in memory. A snapshot taken now would export the
        // defaults (a blank unit, a 1° grid guess).
        get unit() { return (state.meta && state.meta.unit) || opts.unit || ""; },
        get attribution() {
          return (state.meta && state.meta.attribution) || opts.attribution || "NOAA NCEP GFS";
        },
        get licence() {
          return (state.meta && state.meta.license) || "US Government work (public domain)";
        },
        source: "https://www.ncei.noaa.gov/products/weather-climatic-modeling-global-system",
        get period() { return state.meta ? state.meta.run_time : ""; },
        get bands() { return [{ name: opts.id, unit: (state.meta && state.meta.unit) || opts.unit || "" }]; },
        get native() {
          const grid = g();
          return {
            cols: grid.cols || 360,
            rows: grid.rows || 181,
            latMin: grid.lat_min != null ? grid.lat_min : -90,
            latMax: grid.lat_max != null ? grid.lat_max : 90,
            lonMin: grid.lon_min != null ? grid.lon_min : 0,
            lonMax: 360,
          };
        },
        // The map's pane order — the export draws in it too.
        z: opts.paneZ || 356,
        isActive: () => !!state.grid,
        sample(lat, lon) {
          const v = sampleValue(lat, lon);
          return v == null || !isFinite(v) ? null : v;
        },
        color(v) {
          if (v == null || !isFinite(v)) return null;
          const ramp = state.meta && state.meta.ramp;
          if (!ramp) return null;
          return rampColor(ramp, v);
        },
      });
    }

    registerExport();
    return api;
  }

  window.createFieldLayer = createFieldLayer;
})();
