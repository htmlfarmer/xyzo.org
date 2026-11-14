/* ═══════════════════════════════════════════════════════════════════════
   Köppen-Geiger climate overlay for the Xyzo map.

   Source: Beck, H.E., Zimmermann, N.E., McVicar, T.R., Vergopolan, N.,
   Berg, A., Wood, E.F. (2018), "Present and future Köppen-Geiger
   climate classification maps at 1-km resolution", Scientific Data 5,
   180214. https://doi.org/10.6084/m9.figshare.6396959 — CC BY 4.0.

   (The previous source was Gerrit Hendriksen's KML digitisation of
   Peel et al. 2007, whose paper is CC BY-NC-SA 2.5 — NonCommercial
   and ShareAlike. Beck et al. is the same classification, peer
   reviewed, under CC BY 4.0, and thirty times finer.)

   scripts/koppen_build.py reads Beck's 1-km GeoTIFF once and publishes:

      /data/koppen/tiles/{z}/{x}/{y}.png   XYZ tile pyramid (EPSG:3857)
      /data/koppen/grid.png                paletted 0.25° lookup grid
      /data/koppen/classes.json            class metadata + grid geometry

   The overlay itself is a plain L.tileLayer in a dedicated pane that sits
   above the base tiles but below the pin canvas, so news pins stay on top.

   Probe mode: hovering the map reads the class under the cursor from the
   lookup grid and shows a small readout. On touch devices, "Probe" mode
   turns a tap into the same readout (and suppresses the click-to-submit
   flow while it is on).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/koppen";
  // Tiles are PNG, which Caddy serves with a 1-year immutable cache
  // (the @staticAssets matcher), so the URL carries a build version.
  const BUILD = "202610292024";
  const TILES_URL = BASE + "/tiles/{z}/{x}/{y}.png?v=" + BUILD;
  const META_URL = BASE + "/classes.json?v=" + BUILD;
  const GRID_URL = BASE + "/grid.png?v=" + BUILD;
  const STORE_KEY = "xyzo.climateLayer";
  const PROBE_STORE_KEY = "xyzo.climateProbe";
  // The deepest level scripts/koppen_build.py publishes. Declaring this
  // LOWER than the pyramid makes Leaflet upscale the shallowest level
  // instead: with it at 5, a map zoomed to 7 fetched z5 tiles and
  // blew them up 4x — three quarters of the data on disk was never used.
  // z7 is 1223 m/px at the equator, within 1.3x of Beck et al.'s 928 m
  // source, and 32768/128 = 256 so those tiles slice the master raster
  // 1:1 with no resampling.
  const MAX_NATIVE_ZOOM = 7;
  const OVERLAY_OPACITY = 0.5;
  const GROUP_ORDER = ["Tropical", "Arid", "Temperate", "Cold", "Polar"];

  const state = {
    map: null,
    tileLayer: null,
    enabled: false,
    probeMode: false,
    meta: null,
    metaPromise: null,
    grid: null,
    gridPromise: null,
    legendBuilt: false,
    legendMounted: false,
    pendingFrame: false,
    lastProbe: null,
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
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function storageGet() {
    try { return localStorage.getItem(STORE_KEY); } catch (_) { return null; }
  }
  function storageSet(v) {
    try { localStorage.setItem(STORE_KEY, String(v)); } catch (_) {}
  }
  function storageGetProbe() {
    try { return localStorage.getItem(PROBE_STORE_KEY); } catch (_) { return null; }
  }
  function storageSetProbe(v) {
    try { localStorage.setItem(PROBE_STORE_KEY, String(v)); } catch (_) {}
  }

  // ── metadata (class table) ───────────────────────────────────────────
  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = fetch(META_URL, { cache: "default" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((json) => {
        state.meta = json;
        state.metaPromise = null;
        return json;
      })
      .catch((e) => {
        state.metaPromise = null;
        warn("[climate] classes.json failed:", e);
        throw e;
      });
    return state.metaPromise;
  }

  // ── lookup grid (for "which climate is at this point?") ─────────────
  function ensureGrid() {
    if (state.grid) return Promise.resolve(state.grid);
    if (state.gridPromise) return state.gridPromise;
    state.gridPromise = (async () => {
      try {
        const meta = await ensureMeta();
        const g = meta.grid || {};
        const w = g.width | 0;
        const h = g.height | 0;
        if (!w || !h) throw new Error("bad grid metadata");

        const resp = await fetch(GRID_URL, { cache: "default" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        if (typeof bmp.close === "function") bmp.close();
        const img = ctx.getImageData(0, 0, w, h);

        // exact palette colours -> class (index 0 = transparent = no data)
        const byColour = new Map();
        for (const c of meta.classes || []) {
          const hex = String(c.color || "").replace("#", "");
          if (hex.length !== 6) continue;
          const r = parseInt(hex.slice(0, 2), 16);
          const gg = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          byColour.set((r << 16) | (gg << 8) | b, c);
        }

        state.grid = { width: w, height: h, degrees: g.degrees || 0.25, data: img.data, byColour };
        state.gridPromise = null;
        log("[climate] lookup grid ready", w + "x" + h);
        return state.grid;
      } catch (e) {
        state.gridPromise = null;
        warn("[climate] grid load failed:", e);
        throw e;
      }
    })();
    return state.gridPromise;
  }

  // Class under a geographic point, or null (ocean / no data).
  function classify(latlng) {
    const grid = state.grid;
    if (!grid || !latlng) return null;
    const lat = Number(latlng.lat);
    const lng = Number(latlng.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < -90 || lat > 90) return null;
    // wrap longitude into [-180, 180]
    let lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const ix = Math.min(grid.width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * grid.width)));
    const iy = Math.min(grid.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * grid.height)));
    const o = (iy * grid.width + ix) * 4;
    const d = grid.data;
    if (d[o + 3] < 8) return null; // transparent
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    return grid.byColour.get(key) || null;
  }

  // ── the overlay layer ────────────────────────────────────────────────
  // The layer is created eagerly (no map needed) so app.js can register it
  // in the Leaflet layers control next to the NASA overlays.
  function buildLayer() {
    if (!window.L) return null;
    if (!state.map || !state.map.getPane("climatePane")) {
      if (state.map) {
        state.map.createPane("climatePane");
        const pane = state.map.getPane("climatePane");
        // tilePane is 200, overlayPane (pin canvas + heatmap) is 400.
        // 350 keeps the climate wash above the base tiles and below the pins.
        pane.style.zIndex = "350";
        pane.style.pointerEvents = "none";
      }
    }
    return L.tileLayer(TILES_URL, {
      minZoom: 0,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      opacity: OVERLAY_OPACITY,
      pane: "climatePane",
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: "Köppen-Geiger: Beck et al. (2018), CC BY 4.0",
      className: "xyzo-climate-tiles",
      crossOrigin: false,
    });
  }

  // The tile layer instance — used by app.js to register the overlay in
  // the Leaflet layers control.
  function getTileLayer() {
    if (!state.tileLayer) state.tileLayer = buildLayer();
    return state.tileLayer;
  }

  // ── enable / disable ─────────────────────────────────────────────────
  // The Leaflet layers control is the single source of truth: the overlay
  // is a normal overlay in that control, so `overlayadd`/`overlayremove`
  // are what actually drive the state (and the URL hash, via app.js).
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(state.enabled);
    if (state.enabled) {
      ensureMeta().then(buildLegend).catch(() => {});
      ensureGrid().catch(() => {});
    } else {
      hideProbe();
    }
    applyVisibility();
    refreshToggleButtons();
    notifyChange();
  }

  function setEnabled(on) {
    const want = !!on;
    if (!state.tileLayer) state.tileLayer = buildLayer();
    if (!state.tileLayer || !state.map) return Promise.resolve(false);
    if (want) {
      if (!state.map.hasLayer(state.tileLayer)) state.tileLayer.addTo(state.map);
    } else if (state.map.hasLayer(state.tileLayer)) {
      state.map.removeLayer(state.tileLayer);
    }
    // The overlayadd/overlayremove handlers do the bookkeeping; call the
    // sync directly too in case the layer was already in the right state.
    onLayerToggled(state.map.hasLayer(state.tileLayer));
    return Promise.resolve(state.enabled);
  }

  // ── quick toggle (a checkbox next to the Layers button) ────────────
  // The overlay is switched from a small control that sits right under
  // the Leaflet layers button — one click, no dropdown, no panel. The
  // 29-class key stays hidden until the user asks for it with the "?"
  // button next to the checkbox.
  // ── the 29-class key lives INSIDE the Leaflet layers dropdown ──────
  // A floating panel was always in the way; the dropdown is collapsed by
  // default, so the key is only on screen while the user is looking at
  // the layer list.
  function mountLegendIntoLayersControl() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;   // the control may not exist yet

    const old = document.getElementById("climate-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "climate-legend";
    host.className = "climate-legend leaflet-control-layers-climate";
    // Probe mode exists for devices without hover. Leaflet's own
    // "leaflet-touch" class cannot be used for that — desktop Chrome also
    // exposes window.TouchEvent, so Leaflet tags every browser with it.
    const coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;
    if (coarsePointer) host.classList.add("is-touch");
    host.innerHTML =
      '<div class="climate-legend-title"><span>Köppen climate classes</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-climate-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the climate class (touch devices)">Probe</button>' +
      "</div>" +
      '<div class="climate-legend-body climate-legend-grid" id="climate-legend-body">' +
      '<div class="climate-legend-loading">Loading…</div></div>' +
      '<div class="climate-legend-detail" id="climate-legend-detail" hidden></div>' +
      '<div class="climate-legend-foot">Beck et al. (2018) · CC BY 4.0 · 1 km</div>';
    section.appendChild(host);
    state.legendMounted = true;

    // Probe mode: tap the map to read the class under the finger.
    const probeBtn = host.querySelector("#ctrl-climate-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSetProbe(state.probeMode);
        if (!state.probeMode) hideProbe();
        refreshToggleButtons();
      });
    }

    // The legend needs the META (the 30-class key is in the dropdown
    // whether or not the overlay is on). **THE GRID IS NOT** — 1 MB,
    // and only the map needs it; `onLayerToggled` fetches it when the
    // reader switches the overlay on.
    ensureMeta().then(buildLegend).catch(() => {});
    return true;
  }

  // app.js creates the layers control AFTER this module is initialised,
  // so the injection is retried until the control is on the page.
  function waitForLayersControl() {
    if (mountLegendIntoLayersControl()) return;
    let tries = 0;
    const tick = () => {
      if (mountLegendIntoLayersControl() || ++tries > 40) return;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }


  function applyVisibility() {
    const probeToggle = document.getElementById("ctrl-climate-probe-toggle");
    if (probeToggle) {
      probeToggle.disabled = !state.enabled;
      probeToggle.style.opacity = state.enabled ? "" : "0.45";
    }
  }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("xyzo:climate-change", { detail: { enabled: state.enabled } })); } catch (_) {}
  }

  // ── probe readout ────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("climate-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "climate-probe";
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
    const el = document.getElementById("climate-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
  }

  function showProbe(cls, containerPoint) {
    const el = probeEl();
    if (!cls) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    // Only touch the DOM when the class actually changed — the mousemove
    // handler runs on every frame.
    if (state.lastProbe !== cls) {
      el.innerHTML =
        '<span class="climate-probe-swatch" style="background:' + esc(cls.color) + '"></span>' +
        '<span class="climate-probe-code">' + esc(cls.code) + '</span>' +
        '<span class="climate-probe-desc">' + esc(cls.description || cls.group || "") + '</span>';
      state.lastProbe = cls;
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled || !state.grid) return;
    const cls = classify(latlng);
    showProbe(cls, containerPoint);
  }

  // ── legend ───────────────────────────────────────────────────────────
  function buildLegend(meta) {
    if (state.legendBuilt) return;
    const body = document.getElementById("climate-legend-body");
    if (!body || !meta) return;
    const classes = meta.classes || [];
    // Grouped order (Tropical → Polar) so the swatches read like the
    // canonical Köppen chart.
    const groups = new Map();
    for (const g of GROUP_ORDER) groups.set(g, []);
    for (const c of classes) {
      const g = groups.has(c.group) ? c.group : "Other";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    let html = "";
    for (const list of groups.values()) {
      for (const c of list) {
        const full = c.description + (c.criteria ? " — " + c.criteria : "");
        html +=
          '<button type="button" class="climate-legend-chip" data-code="' + esc(c.code) + '"' +
          ' data-desc="' + esc(c.description || "") + '" title="' + esc(full) + '">' +
          '<span class="climate-swatch" style="background:' + esc(c.color) + '"></span>' +
          '<span class="climate-code">' + esc(c.code) + "</span>" +
          "</button>";
      }
    }
    body.innerHTML = html;
    state.legendBuilt = true;

    // Hovering / tapping a swatch explains the class.
    const detail = document.getElementById("climate-legend-detail");
    body.querySelectorAll(".climate-legend-chip").forEach((chip) => {
      const show = () => {
        if (!detail) return;
        detail.textContent = chip.dataset.code + " — " + (chip.dataset.desc || "");
        detail.hidden = false;
      };
      chip.addEventListener("mouseenter", show);
      chip.addEventListener("focus", show);
      chip.addEventListener("click", show);
    });
  }
  // ── wiring ───────────────────────────────────────────────────────────
  function refreshToggleButtons() {
    const probeBtn = document.getElementById("ctrl-climate-probe-toggle");
    if (probeBtn) {
      probeBtn.classList.toggle("active", state.probeMode);
      // Keep the word "Probe" — a bare "Off" button next to the legend
      // title reads as "the overlay is off".
      probeBtn.textContent = state.probeMode ? "Probe: On" : "Probe";
      probeBtn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
      probeBtn.disabled = !state.enabled;
      probeBtn.title = state.enabled
        ? "Tap the map to read the climate class (touch devices)"
        : "Turn the Köppen overlay on first";
    }
  }

  function wireMapEvents() {
    if (!state.map) return;
    // The layers control owns the overlay: sync our state to it.
    state.map.on("overlayadd", (e) => {
      if (e && e.layer === state.tileLayer) onLayerToggled(true);
    });
    state.map.on("overlayremove", (e) => {
      if (e && e.layer === state.tileLayer) onLayerToggled(false);
    });
    state.map.on("mousemove", (e) => {
      if (!state.enabled || state.pendingFrame) return;
      // HoverInfo "all" mode aggregates every layer's reading into one
      // card — stand down so two boxes don't fight over the cursor.
      if (window.HoverInfo && typeof HoverInfo.suppressesProbes === "function" && HoverInfo.suppressesProbes()) return;
      state.pendingFrame = true;
      const latlng = e.latlng;
      const cp = e.containerPoint;
      requestAnimationFrame(() => {
        state.pendingFrame = false;
        updateProbe(latlng, cp);
      });
    });
    state.map.on("mouseout", () => {
      if (state.enabled && !state.probeMode) hideProbe();
    });
    // Tap-to-probe (touch devices have no hover)
    state.map.on("click", (e) => {
      if (!state.enabled || !state.probeMode) return;
      updateProbe(e.latlng, e.containerPoint);
    });
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (state.map) return;
    state.map = map || window._xyzoMap;
    if (!state.map || !window.L) return;
    // The pane must exist before the overlay is added to the map.
    if (!state.map.getPane("climatePane")) {
      state.map.createPane("climatePane");
      const pane = state.map.getPane("climatePane");
      pane.style.zIndex = "350";
      pane.style.pointerEvents = "none";
    }
    // app.js registers the layer in the Leaflet layers control; adopt that
    // instance so there is only ever one overlay.
    if (!state.tileLayer) state.tileLayer = getTileLayer();

    const probeSaved = storageGetProbe();
    if (probeSaved === "true" || probeSaved === "1") state.probeMode = true;

    waitForLayersControl();
    wireMapEvents();

    // Restore the persisted preference by putting the layer on the map.
    const saved = storageGet();
    if ((saved === "true" || saved === "1") && state.tileLayer && !state.map.hasLayer(state.tileLayer)) {
      state.tileLayer.addTo(state.map);
    }
    state.enabled = !!(state.tileLayer && state.map.hasLayer(state.tileLayer));
    refreshToggleButtons();
    applyVisibility();

    // Warm the METADATA only, on idle: the 30-class key lives in the
    // layers dropdown whether or not the overlay is on, so it needs the
    // class table. **THE GRID IS NOT WARMED** — it is 1 MB, the layer is
    // OFF by default, and warming it charged every visitor who never
    // switched the Köppen overlay on 1 MB of their first page load for
    // nothing. It is fetched by the `add` handler.
    const warm = () => {
      ensureMeta().then(buildLegend).catch(() => {});
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 2500);

    window.addEventListener("xyzo:climate-change", refreshToggleButtons);
  }

  // ── public API ───────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // The Köppen class as a NUMBER — the class INDEX (1..30, 0 = ocean).
  // A raster band has to be a number, so the export carries the index
  // and the colour comes from the class table the layer already holds.
  // The class CODES (Af, BWh, Cfa …) travel in the file's metadata.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "climate",
      z: 350,   // the map pane order — the export draws in it too
      label: "🌍 Köppen Climate",
      kind: "raster",
      unit: "class",
      attribution: "Köppen-Geiger: Beck et al. (2018)",
      licence: "CC BY 4.0",
      source: "https://doi.org/10.6084/m9.figshare.6396959",
      period: "1980-2016 present-day",
      bands: [{ name: "koppen_class", unit: "class" }],
      // The grid's own geometry — the Köppen product was rebuilt at
      // 0.05° on 2026-10-29, so a hard-coded extent would be wrong.
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 1440, rows: 720, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
        });
      },
      isActive: () => !!state.grid && !!state.meta,
      sample(lat, lon) {
        const cls = classify({ lat: lat, lng: lon });
        if (!cls) return null;
        return cls.index;
      },
      color(v) {
        if (v == null || !Number.isFinite(v)) return null;
        const classes = (state.meta && state.meta.classes) || [];
        const cls = classes.find((c) => c.index === v);
        if (!cls || !cls.color) return null;
        const hex = String(cls.color).replace("#", "");
        if (hex.length !== 6) return null;
        return [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ];
      },
    });
  }


  window.ClimateLayer = {
    init,
    getTileLayer,
    setEnabled,
    isEnabled: () => state.enabled,
    setProbeMode(on) {
      state.probeMode = !!on;
      storageSetProbe(state.probeMode);
      refreshToggleButtons();
    },
    isProbeMode: () => state.probeMode,
    // When probe mode is on, a map click is a climate probe, not a
    // click-to-submit. app.js consults this before opening the submitter.
    blocksClick: () => state.enabled && state.probeMode,
    classify,
    // HoverInfo "all" mode: a one-line reading for the cursor position,
    // or null when the layer is off / the grid isn't loaded.
    sampleAt(latlng) {
      if (!state.enabled || !state.grid) return null;
      const cls = classify(latlng);
      if (!cls) return null;
      return cls.code + (cls.description ? " · " + cls.description : "");
    },
    getClasses: () => (state.meta && state.meta.classes) || [],
    registerExport,
    getLastProbe: () => state.lastProbe,
  };

  registerExport();

  // ── boot ─────────────────────────────────────────────────────────────
  // This module is loaded BEFORE app.js (so app.js can register the
  // overlay in the Leaflet layers control), which means the map does not
  // exist yet when this file executes. app.js calls init(map) explicitly;
  // this is the fallback for the case where it does not.
  function boot() {
    if (window._xyzoMap) {
      init(window._xyzoMap);
      return;
    }
    // app.js is a deferred script: it runs before DOMContentLoaded.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      setTimeout(boot, 0);
    }
  }
  boot();
})();
