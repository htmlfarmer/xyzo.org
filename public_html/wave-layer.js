/* ═══════════════════════════════════════════════════════════════════════
   Wave height & power overlay for the Xyzo map — the sea-state field.

   Source: NOAA NCEP GFS Wave (gfswave) global 0.25° analysis, fetched
   ONCE per 6-hour cycle by worker/wavemap.py into two Int16 grids:

     /data/wave/height.bin   0.01 m (cm) per unit,  row 0 = 90°N, 1440×721
     /data/wave/period.bin   0.1 s  (ds) per unit,  row 0 = 90°N
     /data/wave/meta.json    ramps + layout + power formula + attribution

   POWER IS DERIVED, NOT FETCHED. The browser computes

       P [kW/m] = 0.49 · Hs² · (0.9 · Tp)  =  0.441 · Hs² · Tp

   from the two grids — the same constants the worker publishes in
   meta.json (pinned by tests on both sides). One fetch, two fields,
   no third grid to keep in sync.

   The legend carries a property switcher (Height | Power) exactly like
   the soil overlay's chips: both fields are just a different colouring
   of the same pixels, so one layers-control entry serves both.

   Probe (armed): metres, seconds and kW/m under the cursor, nearest
   cell. Land is nodata from the GRIB and paints transparent.

   An earlier draft used the Open-Meteo Marine point API; its keyless
   tier burns out on a global bake, and the "0p16 global" GRIB is
   secretly a 52.5N..15S band. GFS-wave 0p25 is a true 90N..90S grid —
   free, no key, no quota.

   0.25° cells are painted into tiles by direct bilinear sampling of the
   grids (no pre-bake): the field is smooth, 256² samples a tile in a
   couple of ms, and sampling the NUMBERS avoids the dark coastline
   fringe you get by upscaling an already-coloured canvas across a
   nodata boundary.

   No BUILD token: the inputs are .bin/.json, not Caddy-immutable
   PNGs — they revalidate on every fetch cycle.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/wave";
  const STORE_KEY = "xyzo.waveLayer";
  const PROP_STORE_KEY = "xyzo.waveProp";
  const PROBE_STORE_KEY = "xyzo.waveProbe";
  const PANE = "wavePane";
  const PANE_Z = 346;
  const OVERLAY_OPACITY = 0.9;
  const MAX_NATIVE_ZOOM = 8;    // 1° cells: ~600 m/px at z8, beyond is upscale

  // Mirrors worker/wavemap.py — the tests pin the two against each other.
  const POWER_HS_COEF = 0.49;
  const POWER_TE_OF_TP = 0.9;

  const state = {
    map: null,
    tileLayer: null,
    enabled: false,
    probeMode: false,
    prop: "height",            // "height" | "power"
    meta: null,
    height: null,              // Int16Array cm
    period: null,              // Int16Array ds
    loadPromise: null,
    legendMounted: false,
    lastProbe: null,
    opacity: OVERLAY_OPACITY,
    luts: {},                  // prop -> Uint8Array(256*3) ramp LUT
  };

  // ── helpers ───────────────────────────────────────────────────────────
  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function storageGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function powerOf(hsM, tpS) {
    return POWER_HS_COEF * hsM * hsM * (POWER_TE_OF_TP * tpS);
  }

  // ── data ──────────────────────────────────────────────────────────────
  function ensureData() {
    if (state.meta && state.height && state.period) return Promise.resolve(state.meta);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.all([
      fetch(BASE + "/meta.json", { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("meta HTTP " + r.status);
        return r.json();
      }),
      fetch(BASE + "/height.bin", { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("height HTTP " + r.status);
        return r.arrayBuffer();
      }),
      fetch(BASE + "/period.bin", { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("period HTTP " + r.status);
        return r.arrayBuffer();
      }),
    ])
      .then(([meta, hb, pb]) => {
        state.meta = meta;
        state.height = new Int16Array(hb);
        state.period = new Int16Array(pb);
        const g = meta.grid || {};
        const expect = (g.cols | 0) * (g.rows | 0);
        if (state.height.length !== expect || state.period.length !== expect) {
          throw new Error(
            `grid size: h=${state.height.length} p=${state.period.length} expect ${expect}`);
        }
        log("[wave] grids ready:", expect, "cells, fetched", meta.fetched_at);
        return meta;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[wave] data failed to load", e);
        throw e;
      });
    return state.loadPromise;
  }

  // Nearest cell → {hs: metres|null, tp: seconds|null}
  function sampleCell(lat, lng) {
    const meta = state.meta;
    if (!meta || !state.height) return null;
    const g = meta.grid || {};
    const cols = g.cols | 0;
    const rows = g.rows | 0;
    if (!cols || !rows) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const ix = clamp(Math.floor((lon + 180) / (g.lon_step || 1)), 0, cols - 1);
    const iy = clamp(Math.floor((g.lat_max - lat) / (g.lat_step || 1)), 0, rows - 1);
    const i = iy * cols + ix;
    const nd = g.nodata != null ? g.nodata : -32768;
    const rawH = state.height[i];
    if (rawH === nd) return null;
    const rawT = state.period[i];
    return {
      hs: rawH * (g.height_scale || 0.01),
      tp: rawT === nd ? null : rawT * (g.period_scale || 0.1),
    };
  }

  // Bilinear sample of the height/period PAIR in display units:
  // { hs: metres, tp: seconds }, or null over land.
  //
  // This is the core; sampleBilinear() is the one-property view of it,
  // and the exporter needs both numbers at once.
  function samplePair(lat, lng) {
    const meta = state.meta;
    if (!meta || !state.height) return null;
    const g = meta.grid || {};
    const cols = g.cols | 0;
    const rows = g.rows | 0;
    if (!cols || !rows) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const nd = g.nodata != null ? g.nodata : -32768;
    let lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const fx = (lon + 180) / (g.lon_step || 1) - 0.5;
    const fy = (g.lat_max - lat) / (g.lat_step || 1) - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const hsScale = g.height_scale || 0.01;
    const tpScale = g.period_scale || 0.1;

    let accH = 0, accT = 0, wsum = 0;
    for (let dy = 0; dy <= 1; dy++) {
      const yy = clamp(y0 + dy, 0, rows - 1);
      const wy = dy ? ty : 1 - ty;
      for (let dx = 0; dx <= 1; dx++) {
        const xx = ((x0 + dx) % cols + cols) % cols;
        const w = wy * (dx ? tx : 1 - tx);
        if (w <= 0) continue;
        const i = yy * cols + xx;
        const h = state.height[i];
        if (h === nd) continue;            // nodata corner: drop the weight
        accH += h * w;
        const t = state.period[i];
        accT += (t === nd ? 0 : t) * w;
        wsum += w;
      }
    }
    if (wsum < 0.5) return null;           // majority-land cell
    return {
      hs: (accH / wsum) * hsScale,
      tp: (accT / wsum) * tpScale,
    };
  }

  // Bilinear sample of the height/period pair in display units, or null.
  function sampleBilinear(lat, lng, prop) {
    const meta = state.meta;
    if (!meta || !state.height) return null;
    const g = meta.grid || {};
    const cols = g.cols | 0;
    const rows = g.rows | 0;
    if (!cols || !rows) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const nd = g.nodata != null ? g.nodata : -32768;
    let lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const fx = (lon + 180) / (g.lon_step || 1) - 0.5;
    const fy = (g.lat_max - lat) / (g.lat_step || 1) - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const hsScale = g.height_scale || 0.01;
    const tpScale = g.period_scale || 0.1;

    let accH = 0, accT = 0, wsum = 0;
    for (let dy = 0; dy <= 1; dy++) {
      const yy = clamp(y0 + dy, 0, rows - 1);
      const wy = dy ? ty : 1 - ty;
      for (let dx = 0; dx <= 1; dx++) {
        const xx = ((x0 + dx) % cols + cols) % cols;
        const w = wy * (dx ? tx : 1 - tx);
        if (w <= 0) continue;
        const i = yy * cols + xx;
        const h = state.height[i];
        if (h === nd) continue;            // nodata corner: drop the weight
        accH += h * w;
        const t = state.period[i];
        accT += (t === nd ? 0 : t) * w;
        wsum += w;
      }
    }
    if (wsum < 0.5) return null;           // majority-land cell
    const hs = (accH / wsum) * hsScale;
    const tp = (accT / wsum) * tpScale;
    if (prop === "power") return tp > 0 ? powerOf(hs, tp) : null;
    return hs;
  }

  // ── colour ramps (absolute scales, shared with meta.json) ─────────────
  function buildLut(prop) {
    if (state.luts[prop]) return state.luts[prop];
    const ramp = state.meta && state.meta.ramps ? state.meta.ramps[prop] : null;
    const lut = new Uint8Array(256 * 3);
    if (!ramp || !ramp.length) { state.luts[prop] = lut; return lut; }
    const max = prop === "power"
      ? (state.meta.ranges && state.meta.ranges.power_max) || 250
      : (state.meta.ranges && state.meta.ranges.height_max) || 8;
    for (let i = 0; i < 256; i++) {
      const v = (i / 255) * max;
      // find the segment
      let a = ramp[0], b = ramp[ramp.length - 1];
      for (let k = 0; k < ramp.length - 1; k++) {
        if (v >= ramp[k].v && v <= ramp[k + 1].v) { a = ramp[k]; b = ramp[k + 1]; break; }
      }
      const span = (b.v - a.v) || 1;
      const t = clamp((v - a.v) / span, 0, 1);
      lut[i * 3] = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t);
      lut[i * 3 + 1] = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t);
      lut[i * 3 + 2] = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t);
    }
    state.luts[prop] = lut;
    return lut;
  }

  function colourFor(value, prop) {
    if (value == null) return null;
    const max = prop === "power"
      ? (state.meta.ranges && state.meta.ranges.power_max) || 250
      : (state.meta.ranges && state.meta.ranges.height_max) || 8;
    const lut = buildLut(prop);
    const i = Math.round(clamp(value / max, 0, 1) * 255) * 3;
    return [lut[i], lut[i + 1], lut[i + 2]];
  }

  // ── the overlay: a GridLayer that samples the grids per tile ──────────
  function ensurePane(map) {
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      // Above the relief (345), below climate (350): sea state sits on
      // top of the bathymetry it propagates over.
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  function tilesUrl() {
    // No real URL — the GridLayer draws from the grids. Returning a
    // dummy keeps Leaflet's machinery happy without a network hit.
    return BASE + "/meta.json";
  }

  function buildLayer() {
    if (!window.L) return null;
    const WaveGrid = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        // Async done(): Leaflet inserts the tile only after createTile
        // returns (the temp-layer lesson).
        this._paint(tile, coords, size);
        setTimeout(() => done(null, tile), 0);
        return tile;
      },
      _paint(tile, coords, size) {
        const ctx = tile.getContext("2d");
        const prop = state.prop;
        const meta = state.meta;
        if (!meta || !state.height) return;
        const g = meta.grid;
        const cols = g.cols | 0;
        const nd = g.nodata != null ? g.nodata : -32768;
        const hsScale = g.height_scale || 0.01;
        const tpScale = g.period_scale || 0.1;
        const n = Math.pow(2, coords.z);
        // Geographic bounds of this tile (Web Mercator).
        const x = coords.x, y = coords.y;
        const lonWest = (x / n) * 360 - 180;
        const lonEast = ((x + 1) / n) * 360 - 180;
        const latNorth = rad2deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))));
        const latSouth = rad2deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))));
        const img = ctx.createImageData(size.x, size.y);
        const d = img.data;
        const stepLon = (lonEast - lonWest) / size.x;
        const stepLat = (latNorth - latSouth) / size.y;

        for (let py = 0; py < size.y; py++) {
          const lat = latNorth - (py + 0.5) * stepLat;
          for (let px = 0; px < size.x; px++) {
            const lon = lonWest + (px + 0.5) * stepLon;
            const v = sampleBilinear(lat, lon, prop);
            const o = (py * size.x + px) * 4;
            if (v == null) { d[o + 3] = 0; continue; }
            const rgb = colourFor(v, prop);
            if (!rgb) { d[o + 3] = 0; continue; }
            d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      },
    });
    return new WaveGrid({
      pane: PANE,
      attribution:
        "NOAA NCEP GFS Wave (gfswave) — public domain",
      opacity: state.opacity,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      minZoom: 0,
      updateWhenIdle: true,
      keepBuffer: 1,
    });
  }

  function rad2deg(r) { return (r * 180) / Math.PI; }

  function getTileLayer() {
    if (!state.tileLayer) {
      state.tileLayer = buildLayer();
      // L.GridLayer has NO setOpacity (only TileLayer does) and
      // OverlayOpacity.mount calls it on every WEATHER_OVERLAYS entry —
      // the RiverLayer crash of 2026-10-28 all over again. Attach the
      // pair to the instance so the registry's contract holds.
      state.tileLayer.setOpacity = (v) => setOpacity(v);
      state.tileLayer.getOpacity = () => getOpacity();
    }
    return state.tileLayer;
  }

  // ── enable / disable / opacity ────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData()
        .then(() => { buildLegend(); refreshPropButtons(); if (state.tileLayer) state.tileLayer.redraw(); })
        .catch(() => {});
    } else {
      hideProbe();
    }
    notifyChange();
  }

  function setEnabled(on) {
    const want = !!on;
    if (!state.tileLayer) state.tileLayer = getTileLayer();
    if (!state.tileLayer || !state.map) return Promise.resolve(false);
    if (want) {
      if (!state.map.hasLayer(state.tileLayer)) state.tileLayer.addTo(state.map);
    } else if (state.map.hasLayer(state.tileLayer)) {
      state.map.removeLayer(state.tileLayer);
    }
    onLayerToggled(state.map.hasLayer(state.tileLayer));
    return Promise.resolve(state.enabled);
  }

  function setOpacity(v) {
    state.opacity = clamp(Number(v) || 0, 0, 1);
    if (state.tileLayer) {
      // The GridLayer instance is what the opacity registry calls.
      state.tileLayer.options.opacity = state.opacity;
      const pane = state.map && state.map.getPane(PANE);
      if (pane) pane.style.opacity = String(state.opacity);
      if (state.tileLayer.redraw) state.tileLayer.redraw();
    }
  }
  function getOpacity() { return state.opacity; }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:wave-change", {
        detail: { enabled: state.enabled, prop: state.prop },
      }));
    } catch (_) {}
  }

  // ── property switcher (Height | Power) ────────────────────────────────
  function setProperty(prop) {
    if (prop !== "height" && prop !== "power") return;
    if (prop === state.prop) return;
    state.prop = prop;
    storageSet(PROP_STORE_KEY, prop);
    if (state.tileLayer && state.map && state.map.hasLayer(state.tileLayer)) {
      state.tileLayer.redraw();
    }
    refreshPropButtons();
    buildLegend();
    hideProbe();
    notifyChange();
  }

  function refreshPropButtons() {
    const host = document.getElementById("wave-prop-switch");
    if (!host) return;
    host.querySelectorAll("[data-prop]").forEach((b) => {
      const on = b.getAttribute("data-prop") === state.prop;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("is-active", on);
      b.disabled = !state.enabled;
      b.style.opacity = state.enabled ? "" : "0.45";
    });
  }

  // ── legend ────────────────────────────────────────────────────────────
  function buildLegend() {
    const body = document.getElementById("wave-legend-body");
    if (!body || !state.meta) return;
    const prop = state.prop;
    const ramp = state.meta.ramps && state.meta.ramps[prop];
    if (!ramp || !ramp.length) {
      body.innerHTML = '<div class="climate-legend-loading">Loading…</div>';
      return;
    }
    const max = prop === "power"
      ? (state.meta.ranges && state.meta.ranges.power_max) || 250
      : (state.meta.ranges && state.meta.ranges.height_max) || 8;
    const stops = ramp.map((r) => {
      const hex = "#" + r.rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
      const pct = ((r.v / max) * 100).toFixed(1);
      return hex + " " + pct + "%";
    }).join(", ");
    const unit = prop === "power" ? "kW/m" : "m";
    const ticks = prop === "power" ? [0, 50, 100, 150, 200, 250] : [0, 1, 2, 4, 6, 8];
    const tickHtml = ticks.map((v) =>
      '<span style="left:' + ((v / max) * 100).toFixed(1) + '%">' + v + "</span>"
    ).join("");
    body.innerHTML =
      '<div class="soil-prop-switch" id="wave-prop-switch" role="group" aria-label="Wave field">' +
      '<button type="button" class="soil-prop-btn" data-prop="height" aria-pressed="false">Height</button>' +
      '<button type="button" class="soil-prop-btn" data-prop="power" aria-pressed="false">Power</button>' +
      "</div>" +
      '<div class="wave-ramp" style="background:linear-gradient(to right,' + stops + ')"></div>' +
      '<div class="wave-ticks">' + tickHtml + "</div>" +
      '<div class="etopo-legend-note">' +
      esc(prop === "power"
        ? "kW per metre of wave crest · P ≈ 0.44·Hs²·Tp"
        : "Significant wave height in metres") +
      "</div>";
    refreshPropButtons();
    const foot = document.getElementById("wave-legend-foot");
    if (foot) {
      foot.innerHTML = (state.meta.attribution || "NOAA NCEP GFS Wave") +
        " · fetched " + esc(state.meta.fetched_at || "—");
    }
  }

  function mountLegendIntoLayersControl() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;
    const old = document.getElementById("wave-legend");
    if (old) old.remove();

    const coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "wave-legend";
    host.className = "climate-legend leaflet-control-layers-wave";
    if (coarsePointer) host.classList.add("is-touch");
    host.innerHTML =
      '<div class="climate-legend-title"><span>Waves (height / power)</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-wave-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read sea state">Probe</button>' +
      "</div>" +
      '<div class="climate-legend-body" id="wave-legend-body">' +
      '<div class="climate-legend-loading">Loading…</div></div>' +
      '<div class="climate-legend-foot" id="wave-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-wave-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshToggleButtons();
      });
    }
    refreshToggleButtons();
    if (state.enabled) ensureData().then(buildLegend).catch(() => {});
    return true;
  }

  function waitForLayersControl() {
    if (mountLegendIntoLayersControl()) return;
    let tries = 0;
    const tick = () => {
      if (mountLegendIntoLayersControl() || ++tries > 40) return;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  function refreshToggleButtons() {
    const btn = document.getElementById("ctrl-wave-probe-toggle");
    if (!btn) return;
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
    btn.disabled = !state.enabled;
    btn.style.opacity = state.enabled ? "" : "0.45";
  }

  // ── probe ─────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("wave-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "wave-probe";
      el.className = "climate-probe";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      const host = (state.map && state.map.getContainer()) || document.body;
      host.appendChild(el);
    }
    return el;
  }

  function hideProbe() {
    const el = document.getElementById("wave-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
  }

  function showProbe(latlng, containerPoint) {
    if (!state.enabled) return;
    const cell = sampleCell(latlng.lat, latlng.lng);
    const el = probeEl();
    if (!cell) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const p = cell.tp ? powerOf(cell.hs, cell.tp) : null;
    const sig = cell.hs + "|" + cell.tp;
    if (state.lastProbe !== sig) {
      const parts = ['<span class="climate-probe-desc">' +
        esc(cell.hs.toFixed(1)) + " m"];
      if (cell.tp) parts.push(esc(cell.tp.toFixed(1)) + " s");
      if (p != null) parts.push("<b>" + esc(p.toFixed(0)) + " kW/m</b>");
      parts.push("</span>");
      el.innerHTML = parts.join(" · ");
      state.lastProbe = sig;
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled || !state.probeMode) return;
    showProbe(latlng, containerPoint);
  }

  // HUD sampling ("Everything" mode) — metres, seconds and kW/m from the
  // same grids the probe and the tiles use.
  function sampleAt(latlng) {
    if (!state.enabled || !latlng) return null;
    const cell = sampleCell(Number(latlng.lat), Number(latlng.lng));
    if (!cell || cell.hs == null) return null;
    const parts = [cell.hs.toFixed(1) + " m"];
    if (cell.tp) parts.push(cell.tp.toFixed(1) + " s");
    const p = cell.tp ? powerOf(cell.hs, cell.tp) : null;
    if (p != null) parts.push(p.toFixed(0) + " kW/m");
    return parts.join(" · ");
  }

  // ── init ──────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    state.prop = storageGet(PROP_STORE_KEY, "height") === "power" ? "power" : "height";

    map.on("overlayadd", (e) => {
      if (state.tileLayer && e.layer === state.tileLayer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.tileLayer && e.layer === state.tileLayer) onLayerToggled(false);
    });
    map.on("mousemove", (e) => {
      // "Everything" HUD mode owns the hover — the probe box must stand
      // down or the two stack on the same patch of screen.
      if (window.HoverInfo && typeof HoverInfo.suppressesProbes === "function" &&
          HoverInfo.suppressesProbes()) return;
      updateProbe(e.latlng, e.containerPoint);
    });
    map.on("click", () => { if (state.probeMode) hideProbe(); });

    waitForLayersControl();

    // Warm the grids at idle so the first toggle is instant — **ONLY
    // when the layer is already on.** These are 4 MB (height + period)
    // and the layer is OFF by default, so warming them unconditionally
    // put 4 MB on every first page load for a layer nobody had asked
    // for. The temperature layer's rule.
    if (state.enabled) {
      const warm = () => ensureData().catch(() => {});
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
      else setTimeout(warm, 3000);
    }
  }

  function blocksClick() {
    return !!(state.enabled && state.probeMode);
  }

  // ── public API ────────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // Three bands: significant wave height (m), mean wave period (s) and
  // the derived wave POWER (kW/m). The power is computed from the same
  // formula the layer uses, so the exported number is the number on the
  // map.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "waves",
      z: 346,   // the map pane order — the export draws in it too
      label: "🌊 Wave height & power",
      kind: "raster",
      unit: "m",
      attribution: "NOAA NCEP GFS Wave (gfswave) — global 0.25° analysis",
      licence: "US Government work (public domain)",
      source: "https://www.ncei.noaa.gov/products/weather-climatic-modeling-global-system",
      get period() { return state.meta ? state.meta.run_time : ""; },
      bands: [
        { name: "significant_wave_height", unit: "m" },
        { name: "mean_wave_period", unit: "s" },
        { name: "wave_power", unit: "kW/m" },
      ],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 1440, rows: 721, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
        });
      },
      isActive: () => !!state.height && !!state.meta,
      sample(lat, lon) {
        const p = samplePair(lat, lon);
        if (!p) return null;
        const power = p.tp > 0 ? powerOf(p.hs, p.tp) : null;
        return [p.hs, p.tp, power == null ? NaN : power];
      },
      // The colour comes from the LAYER'S OWN ramp for the ACTIVE
      // property (height or power).
      color(v) {
        if (!v || !Number.isFinite(v[0])) return null;
        const prop = state.prop === "power" ? "power" : "height";
        return colourFor(prop === "power" ? v[2] : v[0], prop);
      },
    });
  }


  window.WaveLayer = {
    init,
    getTileLayer,
    setEnabled,
    isEnabled: () => state.enabled,
    setOpacity,
    getOpacity,
    blocksClick,
    updateProbe,
    sampleAt,
    setProperty,
    LAYER_NAME: "🌊 Wave height & power",
    registerExport,
    // test hooks
    _state: state,
    _sampleCell: sampleCell,
    _sampleBilinear: sampleBilinear,
    _powerOf: powerOf,
    _colourFor: colourFor,
  };

  registerExport();
})();
