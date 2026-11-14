/* ═══════════════════════════════════════════════════════════════════════
   Phytoplankton overlay for the Xyzo map — the MIT Darwin Project's
   global ocean ecosystem model, showing WHICH phytoplankton dominates
   each patch of ocean and HOW MUCH of it there is.

   Source: the "Phytoplankton Model" dataset of NOAA's Science On a
   Sphere, which is the MIT Darwin Project's 1994-1999 global simulation
   run inside the MITgcm / ECCO-2 physical model.

   The published distribution is a RENDERING — a daily sequence of
   equirectangular PNG frames plus a colour bar — so the numbers had to
   be recovered by inverting that colour bar. Four types, each on a 0-5
   mmol P m-2 ramp:

     Prochlorococcus  green    small, cannot use nitrate
     Synechococcus    cyan     other small
     Flagellates      yellow   other big
     Diatoms          red      big, needs silica

   scripts/phytoplankton_build.py publishes:

     /data/phytoplankton/meta.json   layout, ramps, periods
     /data/phytoplankton/annual.bin   type + level, annual mean
     /data/phytoplankton/m01.bin ..   type + level, one per month

   Each .bin is two uint8 planes of 1024x2048 in equirectangular
   (plate carree) layout: the dominant type (0-3, 255 = none) and the
   phosphorus biomass (0-255 of 0-5 mmol).

   THE COLOUR IS THE DATASET'S OWN: the ramp for each type is the one
   printed on its published colour bar, so the legend here and the
   source's legend are the same legend.

   WHY NOT PNG TILES: every *.png under public_html is served
   `immutable` for a year, so a rebuilt pyramid is invisible behind a
   stale version token (the bug that hid the Koppen layer on
   2026-10-22). A .bin revalidates.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/phytoplankton";
  const META_URL = BASE + "/meta.json";
  const STORE_KEY = "xyzo.phytoplanktonLayer";
  const PROBE_STORE_KEY = "xyzo.phytoplanktonProbe";
  const PERIOD_STORE_KEY = "xyzo.phytoplanktonPeriod";

  const NONE = 255;

  const state = {
    map: null,
    overlay: null,
    enabled: false,
    probeMode: false,
    meta: null,
    periodId: null,
    period: null,
    types: null,      // Uint8Array (rows*cols)
    levels: null,     // Uint8Array (rows*cols)
    grids: {},        // periodId -> {types, levels}
    loading: {},
    lut: null,        // 4 types x 256 levels -> RGBA
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
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
        warn("phytoplankton: meta failed to load", err);
        state.metaPromise = null;
        throw err;
      });
    return state.metaPromise;
  }

  function loadPeriod(id) {
    if (state.grids[id]) return Promise.resolve(state.grids[id]);
    if (state.loading[id]) return state.loading[id];
    const period = (state.meta.periods || []).find((p) => p.id === id);
    if (!period) return Promise.reject(new Error("unknown period " + id));

    state.loading[id] = fetch(BASE + "/" + period.file, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(period.file + " " + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const g = state.meta.grid;
        const n = g.rows * g.cols;
        if (buf.byteLength !== n * 2) {
          throw new Error(period.file + " is " + buf.byteLength + " bytes, expected " + n * 2);
        }
        // Two planes, written sequentially: type first, then level.
        const grid = {
          types: new Uint8Array(buf, 0, n),
          levels: new Uint8Array(buf, n, n),
        };
        state.grids[id] = grid;
        delete state.loading[id];
        return grid;
      })
      .catch((err) => {
        warn("phytoplankton: grid failed to load", period.file, err);
        delete state.loading[id];
        throw err;
      });
    return state.loading[id];
  }

  function setPeriod(id) {
    if (!state.meta) return Promise.resolve();
    const period = (state.meta.periods || []).find((p) => p.id === id);
    if (!period) return Promise.resolve();
    state.periodId = id;
    state.period = period;
    storageSet(PERIOD_STORE_KEY, id);
    refreshPeriodButtons();
    buildLegend();
    return loadPeriod(id).then((grid) => {
      // The user may have switched period while this grid was in flight.
      if (state.periodId !== id) return;
      state.types = grid.types;
      state.levels = grid.levels;
      if (state.enabled && state.overlay) state.overlay.redraw();
      hideProbe();
    }).catch(() => {});
  }

  // ── colour ────────────────────────────────────────────────────────────
  // The dataset's own ramps: rgb_dark -> rgb_bright over 0-5 mmol, and
  // alpha from the biomass (the source says "opacity indicates
  // concentration of the phytoplankton as carbon biomass").
  function buildLut(meta) {
    const lut = new Uint8Array(4 * 256 * 4);
    const af = (meta.alpha && meta.alpha.floor) || 0.18;
    const ag = (meta.alpha && meta.alpha.gamma) || 0.8;
    for (let t = 0; t < 4; t++) {
      const spec = (meta.types || [])[t];
      if (!spec) continue;
      const d = spec.rgb_dark;
      const b = spec.rgb_bright;
      for (let l = 0; l < 256; l++) {
        const f = l / 255;
        const o = (t * 256 + l) * 4;
        lut[o] = Math.round(d[0] + (b[0] - d[0]) * f);
        lut[o + 1] = Math.round(d[1] + (b[1] - d[1]) * f);
        lut[o + 2] = Math.round(d[2] + (b[2] - d[2]) * f);
        lut[o + 3] = Math.round(255 * (af + (1 - af) * Math.pow(f, ag)));
      }
    }
    state.lut = lut;
  }

  // ── sampling ──────────────────────────────────────────────────────────
  // The TYPE is categorical, so it is read NEAREST. The biomass is a
  // continuous quantity, so it is read bilinearly — but only across
  // neighbours that share the same dominant type, otherwise a cell on
  // the edge of a diatom patch would be averaged with the flagellates
  // next door and report a biomass neither of them has.
  function sample(lat, lon) {
    const meta = state.meta;
    const types = state.types;
    const levels = state.levels;
    if (!types || !levels || !meta) return null;
    const g = meta.grid;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let row = (lat - g.lat_min) / g.lat_step;
    if (row < 0) row = 0;
    else if (row > g.rows - 1) row = g.rows - 1;
    let col = (lon - g.lon_min) / g.lon_step;
    col = ((col % g.cols) + g.cols) % g.cols;

    const r0 = Math.floor(row);
    const r1 = r0 + 1 < g.rows ? r0 + 1 : r0;
    const fr = row - r0;
    const c0 = Math.floor(col);
    const c1 = c0 + 1 < g.cols ? c0 + 1 : 0;
    const fc = col - c0;

    const t00 = types[r0 * g.cols + c0];
    if (t00 === NONE) return { type: NONE, level: 0 };

    const t10 = types[r0 * g.cols + c1];
    const t01 = types[r1 * g.cols + c0];
    const t11 = types[r1 * g.cols + c1];
    const same = t10 === t00 && t01 === t00 && t11 === t00;
    if (!same) {
      // Nearest cell for the biomass too, so the number always belongs
      // to the type being reported.
      const nr = fr < 0.5 ? r0 : r1;
      const nc = fc < 0.5 ? c0 : c1;
      return { type: t00, level: levels[nr * g.cols + nc] };
    }
    const b = g.cols;
    const v00 = levels[r0 * b + c0];
    const v10 = levels[r0 * b + c1];
    const v01 = levels[r1 * b + c0];
    const v11 = levels[r1 * b + c1];
    const top = v00 + (v10 - v00) * fc;
    const bot = v01 + (v11 - v01) * fc;
    return { type: t00, level: top + (bot - top) * fr };
  }

  function mmol(level) {
    const max = (state.meta && state.meta.level_max) || 5;
    return (level / 255) * max;
  }

  // ── rendering ─────────────────────────────────────────────────────────
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  const scratch = { size: 0, img: null };

  function paintTile(canvas, coords) {
    const meta = state.meta;
    const types = state.types;
    const levels = state.levels;
    const lut = state.lut;
    if (!meta || !types || !levels || !lut) return;
    const g = meta.grid;
    const size = canvas.width;
    const ctx = canvas.getContext("2d");
    if (!scratch.img || scratch.img.width !== size) {
      scratch.size = size;
      scratch.img = ctx.createImageData(size, size);
    }
    const out = scratch.img.data;

    const n = 1 << coords.z;
    const x0 = coords.x / n;
    const y0 = coords.y / n;
    // A tile is 1/n of the world, so one pixel of it is 1/(size*n) of
    // the world — not 1/size. Dividing the within-tile offset by
    // `size` alone spreads the whole globe across every tile.
    const invSpan = 1 / (size * n);

    const cols = g.cols;
    const rows = g.rows;
    const latMin = g.lat_min;
    const latStep = g.lat_step;
    const lonMin = g.lon_min;
    const lonStep = g.lon_step;

    for (let py = 0; py < size; py++) {
      const lat = tileLat(y0 + (py + 0.5) * invSpan);
      let row = (lat - latMin) / latStep;
      if (row < 0) row = 0;
      else if (row > rows - 1) row = rows - 1;
      const r0 = Math.floor(row);
      const r1 = r0 + 1 < rows ? r0 + 1 : r0;
      const fr = row - r0;
      const base0 = r0 * cols;
      const base1 = r1 * cols;
      const o = py * size * 4;

      for (let px = 0; px < size; px++) {
        const lon = -180 + 360 * (x0 + (px + 0.5) * invSpan);
        let col = (lon - lonMin) / lonStep;
        col = ((col % cols) + cols) % cols;
        const c0 = Math.floor(col);
        const c1 = c0 + 1 < cols ? c0 + 1 : 0;
        const fc = col - c0;

        const t = types[base0 + c0];
        let li = -1;
        if (t !== NONE) {
          const same = types[base0 + c1] === t && types[base1 + c0] === t && types[base1 + c1] === t;
          let v;
          if (same) {
            const v00 = levels[base0 + c0];
            const v10 = levels[base0 + c1];
            const v01 = levels[base1 + c0];
            const v11 = levels[base1 + c1];
            const top = v00 + (v10 - v00) * fc;
            const bot = v01 + (v11 - v01) * fc;
            v = top + (bot - top) * fr;
          } else {
            const nr = fr < 0.5 ? r0 : r1;
            const nc = fc < 0.5 ? c0 : c1;
            v = levels[nr * cols + nc];
          }
          li = (t * 256 + ((v + 0.5) | 0)) * 4;
        }
        const oi = o + px * 4;
        if (li < 0) {
          out[oi] = 0; out[oi + 1] = 0; out[oi + 2] = 0; out[oi + 3] = 0;
        } else {
          out[oi] = lut[li];
          out[oi + 1] = lut[li + 1];
          out[oi + 2] = lut[li + 2];
          out[oi + 3] = lut[li + 3];
        }
      }
    }
    ctx.putImageData(scratch.img, 0, 0);
  }

  // ── layer ─────────────────────────────────────────────────────────────
  function makeTileLayer() {
    const PhytoGrid = L.GridLayer.extend({
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
    return new PhytoGrid({
      pane: "phytoplanktonPane",
      opacity: 0.9,
      attribution: "MIT Darwin Project / MITgcm / ECCO-2 (NASA MAP)",
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
      ensureMeta().then(() => setPeriod(state.periodId)).catch(() => {});
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

    if (!map.getPane("phytoplanktonPane")) {
      map.createPane("phytoplanktonPane");
      map.getPane("phytoplanktonPane").style.zIndex = "357";
      map.getPane("phytoplanktonPane").style.pointerEvents = "none";
    }

    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";

    if (state.overlay && storageGet(STORE_KEY, "0") === "1") {
      try { state.overlay.addTo(state.map); } catch (_) {}
    }

    map.on("mousemove", (e) => {
      if (state.enabled && !state.probeMode) {
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

    // The META only — the legend needs the class table. The 4 MB grid
    // is fetched by the `add` handler, when the reader asks for it.
    const warm = () => ensureMeta().catch(() => {});
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
    else setTimeout(warm, 3000);
  }

  // ── legend ────────────────────────────────────────────────────────────
  function swatchCss(spec) {
    const d = spec.rgb_dark;
    const b = spec.rgb_bright;
    const mid = [0, 1, 2].map((i) => Math.round((d[i] + b[i]) / 2));
    return "rgb(" + mid.join(",") + ")";
  }

  function mountLegend() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("phytoplankton-legend");
    if (old) old.remove();

    const coarsePointer =
      !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "phytoplankton-legend";
    host.className = "phytoplankton-legend leaflet-control-layers-phytoplankton";
    if (coarsePointer) host.classList.add("is-touch");
    host.innerHTML =
      '<div class="phytoplankton-legend-title"><span>Phytoplankton</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-phytoplankton-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the phytoplankton">Probe</button></div>' +
      '<div class="phytoplankton-period-switch" id="phytoplankton-period-switch" role="group" ' +
      'aria-label="Phytoplankton period"></div>' +
      '<div class="phytoplankton-legend-types" id="phytoplankton-legend-types"></div>' +
      '<div class="phytoplankton-legend-scale">' +
      '<div class="phytoplankton-legend-bar" id="phytoplankton-legend-bar"></div>' +
      '<div class="phytoplankton-legend-row" id="phytoplankton-ticks"></div>' +
      "</div>" +
      '<div class="phytoplankton-legend-detail" id="phytoplankton-legend-detail" hidden></div>' +
      '<div class="phytoplankton-legend-foot" id="phytoplankton-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-phytoplankton-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeToggle();
      });
    }

    ensureMeta().then(() => {
      buildPeriodSwitch();
      buildLegend();
    }).catch(() => {});
    refreshProbeToggle();
    return true;
  }

  function buildPeriodSwitch() {
    const host = document.getElementById("phytoplankton-period-switch");
    if (!host || !state.meta) return;
    let html = "";
    for (const p of state.meta.periods || []) {
      const label = p.id === "annual" ? "Annual" : p.label.slice(0, 3);
      html +=
        '<button type="button" class="phytoplankton-period-btn" data-period="' + esc(p.id) + '" ' +
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
    const host = document.getElementById("phytoplankton-period-switch");
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

    const types = document.getElementById("phytoplankton-legend-types");
    if (types) {
      let html = "";
      for (const t of meta.types || []) {
        html +=
          '<div class="phytoplankton-type-row">' +
          '<span class="phytoplankton-swatch" style="background:' + swatchCss(t) + '"></span>' +
          '<span class="phytoplankton-type-name">' + esc(t.label) + "</span>" +
          '<span class="phytoplankton-type-note">' + esc(t.note || "") + "</span>" +
          "</div>";
      }
      types.innerHTML = html;
    }

    // The biomass bar: the dataset's own ramp, diatom green-cyan
    // yellow-red is per type, so the bar shows the SCALE, not a colour.
    const bar = document.getElementById("phytoplankton-legend-bar");
    if (bar) {
      const t = (meta.types || [])[3] || (meta.types || [])[0];
      if (t) {
        const stops = [];
        for (let i = 0; i <= 10; i++) {
          const f = i / 10;
          const c = [0, 1, 2].map((k) => Math.round(t.rgb_dark[k] + (t.rgb_bright[k] - t.rgb_dark[k]) * f));
          stops.push("rgb(" + c.join(",") + ") " + (f * 100).toFixed(1) + "%");
        }
        bar.style.backgroundImage = "linear-gradient(to right, " + stops.join(", ") + ")";
      }
    }
    const ticks = document.getElementById("phytoplankton-ticks");
    if (ticks) {
      ticks.innerHTML = "";
      const max = meta.level_max || 5;
      for (const v of [0, 1, 2, 3, 4, 5]) {
        if (v > max) continue;
        const s = document.createElement("span");
        s.className = "phytoplankton-legend-tick";
        s.style.left = ((v / max) * 100).toFixed(2) + "%";
        s.textContent = String(v);
        ticks.appendChild(s);
      }
    }

    const foot = document.getElementById("phytoplankton-legend-foot");
    if (foot) {
      const scope = state.period && state.period.id !== "annual"
        ? state.period.label
        : "annual mean";
      foot.textContent = "MIT Darwin Project · 1994-1999 · 19.6 km grid · " +
        scope + " · MIT Licence";
    }
    refreshPeriodButtons();
    const detail = document.getElementById("phytoplankton-legend-detail");
    if (detail) { detail.hidden = true; detail.innerHTML = ""; }
  }

  function applyVisibility() {
    const probeBtn = document.getElementById("ctrl-phytoplankton-probe-toggle");
    if (probeBtn) {
      probeBtn.disabled = !state.enabled;
      probeBtn.style.opacity = state.enabled ? "" : "0.45";
    }
    refreshPeriodButtons();
    if (!state.enabled) hideProbe();
  }

  function refreshProbeToggle() {
    const btn = document.getElementById("ctrl-phytoplankton-probe-toggle");
    if (!btn) return;
    btn.classList.toggle("active", state.probeMode);
    btn.textContent = state.probeMode ? "Probe: On" : "Probe";
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
  }

  // ── probe ─────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("phytoplankton-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "phytoplankton-probe";
      el.className = "phytoplankton-probe";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      const host = (state.map && state.map.getContainer()) || document.body;
      host.appendChild(el);
    }
    return el;
  }

  function hideProbe() {
    const el = document.getElementById("phytoplankton-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
    const detail = document.getElementById("phytoplankton-legend-detail");
    if (detail) { detail.hidden = true; detail.innerHTML = ""; }
  }

  function showProbe(s, containerPoint) {
    const el = probeEl();
    if (!s || s.type === NONE) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const spec = (state.meta.types || [])[s.type];
    const key = s.type + ":" + Math.round(s.level);
    if (state.lastProbe !== key) {
      const value = mmol(s.level).toFixed(2);
      const html =
        '<span class="phytoplankton-probe-type">' + esc(spec ? spec.label : "—") + "</span>" +
        '<span class="phytoplankton-probe-value">' + value + "</span>" +
        '<span class="phytoplankton-probe-unit">mmol P m⁻²</span>';
      el.innerHTML = html;
      state.lastProbe = key;
      const detail = document.getElementById("phytoplankton-legend-detail");
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
    if (!state.enabled || !state.types) return;
    showProbe(sample(latlng.lat, latlng.lng), containerPoint);
  }

  // ── public API ────────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // Two bands: the DOMINANT PHYTOPLANKTON TYPE (categorical, 0-3) and
  // the BIOMASS (mmol P m-2). The type is categorical, so it is read
  // nearest; the biomass is continuous and is read bilinearly.
  //
  // The colour comes from the LAYER'S OWN LUT — the dataset's own four
  // ramps, over its own alpha rule.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "phytoplankton",
      z: 357,   // the map pane order — the export draws in it too
      label: "🦠 Phytoplankton (Darwin)",
      kind: "raster",
      unit: "mmol P m-2",
      attribution: "MIT Darwin Project / MITgcm / ECCO-2 (NASA MAP)",
      licence: "MIT Licence (model and output); NASA imagery public domain",
      source: "https://sos.noaa.gov/catalog/datasets/phytoplankton-model/",
      get period() { return state.period ? (state.period.label || state.periodId) : ""; },
      bands: [
        { name: "dominant_type", unit: "class" },
        { name: "biomass", unit: "mmol P m-2" },
      ],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 2048, rows: 1024, latMin: -89.912109, latMax: 89.912109,
          lonMin: -179.912109, lonMax: 179.912109,
        });
      },
      isActive: () => !!state.types && !!state.levels && !!state.meta,
      sample(lat, lon) {
        const s = sample(lat, lon);
        if (!s || s.type === NONE) return null;
        return [s.type, mmol(s.level)];
      },
      color(v) {
        const lut = state.lut;
        if (!lut || !v) return null;
        const type = v[0];
        const level = v[1];
        if (type == null || !Number.isFinite(level)) return null;
        const max = (state.meta && state.meta.level_max) || 5;
        const l = Math.max(0, Math.min(255, Math.round((level / max) * 255)));
        const o = (type * 256 + l) * 4;
        return [lut[o], lut[o + 1], lut[o + 2]];
      },
      alpha(v) {
        const lut = state.lut;
        if (!lut || !v) return 255;
        const type = v[0];
        const level = v[1];
        if (type == null || !Number.isFinite(level)) return 255;
        const max = (state.meta && state.meta.level_max) || 5;
        const l = Math.max(0, Math.min(255, Math.round((level / max) * 255)));
        const o = (type * 256 + l) * 4;
        return lut[o + 3];
      },
    });
  }


  window.PhytoplanktonLayer = {
    getTileLayer,
    init,
    isEnabled: () => state.enabled,
    setProbeMode: (on) => {
      state.probeMode = !!on;
      storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
      if (!state.probeMode) hideProbe();
      refreshProbeToggle();
    },
    blocksClick: () => state.enabled && state.probeMode,
    sampleAt(latlng) {
      if (!state.enabled || !state.types) return null;
      const s = sample(latlng.lat, latlng.lng);
      if (!s || s.type === NONE) return null;
      const spec = (state.meta.types || [])[s.type];
      return (spec ? spec.label : "—") + " · " + mmol(s.level).toFixed(2) + " mmol P m⁻²";
    },
    LAYER_NAME: "🦠 Phytoplankton (Darwin)",
    DATA_URL: BASE,
    registerExport,
    _test: {
      state,
      sample,
      buildLut,
      mmol,
      pixelLatLon: (coords, px, py, size) => {
        const n = 1 << coords.z;
        const invSpan = 1 / (size * n);
        return {
          lon: -180 + 360 * (coords.x / n + (px + 0.5) * invSpan),
          lat: tileLat(coords.y / n + (py + 0.5) * invSpan),
        };
      },
    },
  };

  registerExport();
})();
