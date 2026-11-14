/* ═══════════════════════════════════════════════════════════════════════
   Topography & bathymetry relief overlay for the Xyzo map.

   Source: NOAA NCEI ETOPO 2022 v1, 60 arc-second "surface" (ice surface)
     — the maintained successor to ETOPO1, same 1 arc-minute spec.
     Public domain. The SOS catalog's ETOPO1 PNG is a single globe
     overlay; this is the real pyramid, baked locally.

   scripts/etopo_build.py  →  public_html/data/etopo/{tiles,grid.bin,meta.json}
                                        ↓  static, cached by Caddy
                    public_html/etopo-layer.js  →  tileLayer in etopoPane

   Tiles are paletted PNGs sharing ONE global palette (31 hypsometric
   bins × 8 hillshade steps), so adjacent tiles seam-match exactly and
   each PNG is tiny. Bump BUILD after any rebuild — PNGs are
   Caddy-immutable for a year.

   Probe: with "Probe" armed, the elevation under the cursor is read
   from grid.bin (0.1°, metres) and shown in both metres and feet.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/etopo";
  // Bump whenever scripts/etopo_build.py rewrites the pyramid.
  const BUILD = "202610281";
  const STORE_KEY = "xyzo.etopoLayer";
  const PROBE_STORE_KEY = "xyzo.etopoProbe";
  const PANE = "etopoPane";
  const PANE_Z = 345;
  const OVERLAY_OPACITY = 0.85;
  const MAX_NATIVE_ZOOM = 7;

  const state = {
    map: null,
    tileLayer: null,
    enabled: false,
    probeMode: false,
    meta: null,
    grid: null,          // Int16Array, metres
    loadPromise: null,
    legendMounted: false,
    lastProbe: null,
    opacity: OVERLAY_OPACITY,
  };

  // ── small helpers ─────────────────────────────────────────────────────
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
  function mToFt(m) { return m * 3.28084; }
  function fmtM(m) {
    const a = Math.abs(m);
    const s = a >= 1000 ? Math.round(m).toLocaleString("en-US") : m.toFixed(0);
    return s + " m";
  }
  function fmtFt(m) {
    const ft = mToFt(m);
    const a = Math.abs(ft);
    const s = a >= 1000 ? Math.round(ft).toLocaleString("en-US") : ft.toFixed(0);
    return s + " ft";
  }

  // ── data ──────────────────────────────────────────────────────────────
  function ensureData() {
    if (state.meta && state.grid) return Promise.resolve(state.meta);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.all([
      fetch(BASE + "/meta.json?v=" + BUILD, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("meta HTTP " + r.status);
        return r.json();
      }),
      fetch(BASE + "/grid.bin?v=" + BUILD, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("grid HTTP " + r.status);
        return r.arrayBuffer();
      }),
    ])
      .then(([meta, buf]) => {
        state.meta = meta;
        state.grid = new Int16Array(buf);
        const g = meta.grid || {};
        const expect = (g.width | 0) * (g.height | 0);
        if (state.grid.length !== expect) {
          throw new Error("grid is " + state.grid.length + " values, expected " + expect);
        }
        log("[etopo] data ready,", state.grid.length, "probe cells");
        return meta;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[etopo] data failed to load", e);
        throw e;
      });
    return state.loadPromise;
  }

  // Nearest-neighbour sample of the probe grid, metres, or null.
  function sampleM(lat, lng) {
    const meta = state.meta;
    const grid = state.grid;
    if (!meta || !grid) return null;
    const g = meta.grid || {};
    const w = g.width | 0;
    const h = g.height | 0;
    if (!w || !h) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const ix = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)));
    const iy = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
    const v = grid[iy * w + ix];
    if (v === (g.nodata != null ? g.nodata : -32768)) return null;
    return v;
  }

  // ── the overlay ───────────────────────────────────────────────────────
  function ensurePane(map) {
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      // Relief is basemap-adjacent: above the base tiles (200), below
      // the climate wash (350).
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  function tilesUrl() {
    return BASE + "/tiles/{z}/{x}/{y}.png?v=" + BUILD;
  }

  function buildLayer() {
    if (!window.L) return null;
    return L.tileLayer(tilesUrl(), {
      minZoom: 0,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      opacity: state.opacity,
      pane: PANE,
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: "ETOPO 2022 v1 — NOAA NCEI (public domain)",
      className: "xyzo-etopo-tiles",
    });
  }

  function getTileLayer() {
    if (!state.tileLayer) state.tileLayer = buildLayer();
    return state.tileLayer;
  }

  // ── enable / disable ──────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData().then(buildLegend).catch(() => {});
    } else {
      hideProbe();
    }
    refreshToggleButtons();
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
    state.opacity = Math.max(0, Math.min(1, Number(v) || 0));
    if (state.tileLayer && typeof state.tileLayer.setOpacity === "function") {
      state.tileLayer.setOpacity(state.opacity);
    }
  }
  function getOpacity() { return state.opacity; }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:etopo-change", { detail: { enabled: state.enabled } }));
    } catch (_) {}
  }

  // ── legend: hypsometric gradient bar + probe button ───────────────────
  function buildLegend() {
    const body = document.getElementById("etopo-legend-body");
    if (!body || !state.meta) return;
    const ramp = state.meta.ramp || [];
    if (!ramp.length) return;
    // CSS linear-gradient from the published ramp; stops are cumulative
    // percentages of the elevation span so the bar matches the tiles.
    const lo = ramp[0].c;
    const hi = ramp[ramp.length - 1].c;
    const span = hi - lo || 1;
    const stops = ramp.map((r) => {
      const hex = "#" + r.rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
      const pct = (((r.c - lo) / span) * 100).toFixed(1);
      return hex + " " + pct + "%";
    }).join(", ");
    const ticks = [-10000, -5000, 0, 5000, 8000].filter((m) => m >= lo && m <= hi);
    const tickHtml = ticks.map((m) => {
      const pct = (((m - lo) / span) * 100).toFixed(1);
      return '<span style="left:' + pct + '%">' + esc(m >= 0 ? "+" + (m / 1000) + "k" : (m / 1000) + "k") + "</span>";
    }).join("");
    body.innerHTML =
      '<div class="etopo-ramp" style="background:linear-gradient(to right,' + stops + ')"></div>' +
      '<div class="etopo-ticks">' + tickHtml + "</div>" +
      '<div class="etopo-legend-note">Metres above / below sea level. ' +
      "Shading is a baked hillshade.</div>";
    const foot = document.getElementById("etopo-legend-foot");
    if (foot) foot.textContent = state.meta.attribution || "NOAA NCEI ETOPO";
  }

  function mountLegendIntoLayersControl() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;
    const old = document.getElementById("etopo-legend");
    if (old) old.remove();

    const coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "etopo-legend";
    host.className = "climate-legend leaflet-control-layers-etopo";
    if (coarsePointer) host.classList.add("is-touch");
    host.innerHTML =
      '<div class="climate-legend-title"><span>Relief (ETOPO)</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-etopo-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the elevation">Probe</button>' +
      "</div>" +
      '<div class="climate-legend-body" id="etopo-legend-body">' +
      '<div class="climate-legend-loading">Loading…</div></div>' +
      '<div class="climate-legend-foot" id="etopo-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-etopo-probe-toggle");
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
    const btn = document.getElementById("ctrl-etopo-probe-toggle");
    if (!btn) return;
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
    btn.disabled = !state.enabled;
    btn.style.opacity = state.enabled ? "" : "0.45";
  }

  // ── probe ─────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("etopo-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "etopo-probe";
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
    const el = document.getElementById("etopo-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
  }

  function showProbe(latlng, containerPoint) {
    if (!state.enabled) return;
    const m = sampleM(latlng.lat, latlng.lng);
    const el = probeEl();
    if (m == null) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const sig = String(m);
    if (state.lastProbe !== sig) {
      el.innerHTML =
        '<span class="climate-probe-desc">' + esc(fmtM(m)) + " · " + esc(fmtFt(m)) + "</span>";
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

  // HUD sampling ("Everything" mode) — same grid as the probe, so the
  // number under the cursor always matches the colour.
  function sampleAt(latlng) {
    if (!state.enabled || !latlng) return null;
    const m = sampleM(Number(latlng.lat), Number(latlng.lng));
    if (m == null) return null;
    return fmtM(m) + " · " + fmtFt(m);
  }

  // ── init ──────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);

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
  }

  function blocksClick() {
    return !!(state.enabled && state.probeMode);
  }

  // ── public API ────────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // Elevation in metres, straight out of the probe grid the layer
  // already holds. One band; the sign carries the bathymetry (negative
  // is below sea level), which is what makes the file useful for
  // anything that cares about the sea floor.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "relief",
      z: 345,   // the map pane order — the export draws in it too
      label: "⛰️ Relief (ETOPO)",
      kind: "raster",
      unit: "m",
      attribution: "NOAA NCEI ETOPO 2022 v1",
      licence: "US Government work — public domain",
      source: "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
      period: "2022",
      bands: [{ name: "elevation", unit: "m" }],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 3600, rows: 1800, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
        });
      },
      isActive: () => !!state.grid && !!state.meta,
      sample(lat, lon) {
        const v = sampleM(lat, lon);
        return v == null ? null : v;
      },
    });
  }


  window.EtopoLayer = {
    init,
    getTileLayer,
    setEnabled,
    isEnabled: () => state.enabled,
    setOpacity,
    getOpacity,
    blocksClick,
    updateProbe,
    sampleAt,
    LAYER_NAME: "⛰️ Relief (ETOPO)",
    registerExport,
    // test hooks
    _state: state,
    _sampleM: sampleM,
    _fmtM: fmtM,
  };

  registerExport();
})();
