/* ═══════════════════════════════════════════════════════════════════════
   Cropland / land-cover overlay for the Xyzo map — ESA WorldCover.

   Source: ESA WorldCover 10 m v200 (2021) — CC BY 4.0
     https://esa-worldcover.esa.int/

   scripts/cropland_build.py writes:

     /data/cropland/cropland/tiles/{z}/{x}/{y}.png   class 40 only
     /data/cropland/landcover/tiles/{z}/{x}/{y}.png  the full classification
     /data/cropland/grid.bin                         cropland share per 0.1°
     /data/cropland/class.bin                        dominant class per 0.1°
     /data/cropland/meta.json                        class table + grid geometry

   Two layers-control entries share one module:

     🌾 Cropland (ESA)      the farmland extent only
     🗺️ Land Cover (ESA)    every ESA class

   Both read the same meta + grids for the probe. Tiles are PNG, so the
   URL carries a BUILD token that must be bumped when the data changes.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/cropland";
  // Bump whenever the tiles change — also busts pre-fallback 404s that
  // browsers cached under the *.png immutable rule.
  const BUILD = "202610281";
  const SHARE_URL = BASE + "/grid.bin?v=" + BUILD;
  const CLASS_URL = BASE + "/class.bin?v=" + BUILD;
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  const PANE = "croplandPane";
  const PANE_Z = 353;
  const CROP_STORE = "xyzo.croplandLayer";
  const COVER_STORE = "xyzo.landcoverLayer";
  const PROBE_STORE = "xyzo.croplandProbe";

  // maxNativeZoom MUST EQUAL THE PUBLISHED PYRAMID'S DEPTH.
  //
  // The build wrote cropland to z9 and land cover to z8, but these
  // constants said 8 and 7 — so the two deepest levels were DEAD BYTES:
  // Leaflet never asked for them and the map upscaled the z8/z7 tiles
  // instead. A city-level view was a blurry z7 tile when a real z9
  // tile was sitting on disk. Leaflet clamps the tile zoom to
  // maxNativeZoom and scales the result up, so the fix is the constant,
  // not the build.
  const MODES = {
    cropland: {
      storeKey: CROP_STORE,
      layerName: "🌾 Cropland (ESA)",
      attribution: "ESA WorldCover 10 m v200 (2021) — CC BY 4.0",
      maxNativeZoom: 9,
      opacity: 0.55,
    },
    landcover: {
      storeKey: COVER_STORE,
      layerName: "🗺️ Land Cover (ESA)",
      attribution: "ESA WorldCover 10 m v200 (2021) — CC BY 4.0",
      maxNativeZoom: 8,
      opacity: 0.5,
    },
  };

  const state = {
    map: null,
    layers: {},           // mode -> L.tileLayer
    enabled: { cropland: false, landcover: false },
    probeMode: false,
    meta: null,
    metaPromise: null,
    share: null,          // Uint8Array 0..100
    cls: null,            // Uint8Array ESA class codes
    gridPromise: null,
    legendMounted: false,
    lastProbe: null,
    opacity: { cropland: MODES.cropland.opacity, landcover: MODES.landcover.opacity },
  };

  // ── helpers ──────────────────────────────────────────────────────────
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

  function ensurePane(map) {
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  // ── data ──────────────────────────────────────────────────────────────
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
        warn("[cropland] meta failed:", e);
        throw e;
      });
    return state.metaPromise;
  }

  function ensureGrids() {
    if (state.share && state.cls) return Promise.resolve(true);
    if (state.gridPromise) return state.gridPromise;
    state.gridPromise = (async () => {
      const meta = await ensureMeta();
      const g = meta.grid || {};
      const w = g.width | 0;
      const h = g.height | 0;
      if (!w || !h) throw new Error("bad grid metadata");
      const [shareBuf, classBuf] = await Promise.all([
        fetch(SHARE_URL, { cache: "default" }).then((r) => {
          if (!r.ok) throw new Error("share HTTP " + r.status);
          return r.arrayBuffer();
        }),
        fetch(CLASS_URL, { cache: "default" }).then((r) => {
          if (!r.ok) throw new Error("class HTTP " + r.status);
          return r.arrayBuffer();
        }),
      ]);
      state.share = new Uint8Array(shareBuf);
      state.cls = new Uint8Array(classBuf);
      const expect = w * h;
      if (state.share.length !== expect || state.cls.length !== expect) {
        throw new Error("grid size mismatch: " + state.share.length + "/" + state.cls.length + " vs " + expect);
      }
      state.gridPromise = null;
      log("[cropland] grids ready", w + "x" + h);
      return true;
    })().catch((e) => {
      state.gridPromise = null;
      throw e;
    });
    return state.gridPromise;
  }

  function gridSample(arr, lat, lng) {
    if (!arr || !state.meta) return null;
    const g = state.meta.grid || {};
    const w = g.width | 0;
    const h = g.height | 0;
    if (!w || !h) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const ix = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)));
    const iy = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
    return arr[iy * w + ix];
  }

  function classMeta(code) {
    const classes = (state.meta && state.meta.classes) || [];
    return classes.find((c) => c.code === code) || null;
  }

  // ── layers ───────────────────────────────────────────────────────────
  function tilesUrl(mode) {
    return BASE + "/" + mode + "/tiles/{z}/{x}/{y}.png?v=" + BUILD;
  }

  function buildLayer(mode) {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    const cfg = MODES[mode];
    return L.tileLayer(tilesUrl(mode), {
      minZoom: 0,
      maxNativeZoom: cfg.maxNativeZoom,
      opacity: state.opacity[mode],
      pane: PANE,
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: cfg.attribution,
      className: "xyzo-cropland-tiles xyzo-" + mode + "-tiles",
    });
  }

  function getLayerFor(mode) {
    if (!state.layers[mode]) state.layers[mode] = buildLayer(mode);
    return state.layers[mode];
  }

  function setEnabledMode(mode, on) {
    const want = !!on;
    const layer = getLayerFor(mode);
    if (!layer || !state.map) return Promise.resolve(false);
    if (want) {
      if (!state.map.hasLayer(layer)) layer.addTo(state.map);
    } else if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
    }
    onToggled(mode, state.map.hasLayer(layer));
    return Promise.resolve(state.enabled[mode]);
  }

  function onToggled(mode, on) {
    state.enabled[mode] = !!on;
    storageSet(MODES[mode].storeKey, state.enabled[mode] ? "1" : "0");
    const any = state.enabled.cropland || state.enabled.landcover;
    if (any) {
      ensureMeta().then(buildLegend).catch(() => {});
      ensureGrids().catch(() => {});
    } else if (!state.enabled.cropland && !state.enabled.landcover) {
      hideProbe();
    }
    refreshProbeBtn();
    notifyChange();
  }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:cropland-change", {
        detail: { cropland: state.enabled.cropland, landcover: state.enabled.landcover },
      }));
    } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  function buildLegend() {
    const body = document.getElementById("cropland-legend-body");
    if (!body) return;
    const classes = (state.meta && state.meta.classes) || [];
    if (!classes.length) {
      body.innerHTML = '<div class="climate-legend-loading">Loading…</div>';
      return;
    }
    let html = '<div class="soil-legend-grid">';
    // Cropland mode: just the crop swatch + share scale note.
    if (state.enabled.cropland && !state.enabled.landcover) {
      const cropColor = (state.meta && state.meta.cropland_color) || "#56BE4A";
      html +=
        '<div class="soil-legend-row">' +
        '<span class="soil-legend-swatch" style="background:' + esc(cropColor) + '"></span>' +
        '<span class="soil-legend-label">Cropland ( ESA class 40 )</span>' +
        "</div>" +
        '<div class="soil-legend-note">Share of each 0.1° cell under crops, 0–100%.</div>';
    } else {
      for (const c of classes) {
        // Water stays transparent on the map; keep it out of the key.
        if (c.code === 80) continue;
        html +=
          '<div class="soil-legend-row">' +
          '<span class="soil-legend-swatch" style="background:' + esc(c.color) + '"></span>' +
          '<span class="soil-legend-label">' + esc(c.title) + "</span>" +
          "</div>";
      }
    }
    html += "</div>";
    body.innerHTML = html;
    const foot = document.getElementById("cropland-legend-foot");
    if (foot) foot.textContent = (state.meta && state.meta.attribution) || "ESA WorldCover";
  }

  function mountLegendIntoLayersControl() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("cropland-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "cropland-legend";
    host.className = "climate-legend leaflet-control-layers-cropland";
    host.innerHTML =
      '<div class="climate-legend-title"><span>Cropland &amp; land cover</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-cropland-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read cropland share / land-cover class">Probe</button>' +
      "</div>" +
      '<div class="climate-legend-body" id="cropland-legend-body">' +
      '<div class="climate-legend-loading">Loading…</div></div>' +
      '<div class="climate-legend-foot" id="cropland-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-cropland-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeBtn();
      });
    }
    if (state.enabled.cropland || state.enabled.landcover) {
      ensureMeta().then(buildLegend).catch(() => {});
    }
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

  function refreshProbeBtn() {
    const btn = document.getElementById("ctrl-cropland-probe-toggle");
    if (!btn) return;
    const any = state.enabled.cropland || state.enabled.landcover;
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
    btn.disabled = !any;
    btn.style.opacity = any ? "" : "0.45";
  }

  // ── probe ────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("cropland-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "cropland-probe";
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
    const el = document.getElementById("cropland-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
  }

  function updateProbe(latlng, containerPoint) {
    const any = state.enabled.cropland || state.enabled.landcover;
    if (!any || !state.probeMode || !state.share) return;
    const lat = latlng && latlng.lat;
    const lng = latlng && latlng.lng;
    const share = gridSample(state.share, lat, lng);
    const code = gridSample(state.cls, lat, lng);
    const el = probeEl();
    if (share == null || !code) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const cm = classMeta(code);
    const isCrop = code === 40;
    const sig = share + "|" + code;
    if (state.lastProbe !== sig) {
      el.innerHTML =
        '<span class="climate-probe-swatch" style="background:' +
        esc((cm && cm.color) || "#888") + '"></span>' +
        '<span class="climate-probe-desc">' +
        esc(cm ? cm.title : "class " + code) +
        (isCrop || state.enabled.cropland ? " · " + share + "% cropland" : "") +
        "</span>";
      state.lastProbe = sig;
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  // HUD sampling ("Everything" mode) — same grids as the probe, so the
  // class and the cropland share always match the tiles.
  function sampleAt(latlng) {
    const any = state.enabled.cropland || state.enabled.landcover;
    if (!any || !state.share || !latlng) return null;
    const share = gridSample(state.share, Number(latlng.lat), Number(latlng.lng));
    const code = gridSample(state.cls, Number(latlng.lat), Number(latlng.lng));
    if (share == null || !code) return null;
    const cm = classMeta(code);
    const title = cm ? cm.title : "class " + code;
    if (code === 40 || state.enabled.cropland) {
      return title + " · " + share + "% cropland";
    }
    return title;
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);

    map.on("overlayadd", (e) => {
      for (const mode of Object.keys(MODES)) {
        const layer = state.layers[mode];
        if (layer && e.layer === layer) onToggled(mode, true);
      }
    });
    map.on("overlayremove", (e) => {
      for (const mode of Object.keys(MODES)) {
        const layer = state.layers[mode];
        if (layer && e.layer === layer) onToggled(mode, false);
      }
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
    return !!((state.enabled.cropland || state.enabled.landcover) && state.probeMode);
  }

  // ── public API ───────────────────────────────────────────────────────
  // ── export surfaces ──────────────────────────────────────────────────
  // Two surfaces from one grid: the CROPLAND SHARE (a percentage) and
  // the LAND COVER CLASS (the ESA WorldCover class code). A GIS user
  // wants both — the share is the analysis, the class is the context.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;

    window.XYZO_EXPORT.register({
      id: "cropland",
      z: 353,   // the map pane order — the export draws in it too
      label: "🌾 Cropland (ESA)",
      kind: "raster",
      unit: "%",
      attribution: "ESA WorldCover 10 m v200 (2021)",
      licence: "CC BY 4.0",
      source: "https://esa-worldcover.esa.int/",
      period: "2021",
      bands: [{ name: "cropland_share", unit: "%" }],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 3600, rows: 1800, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
        });
      },
      isActive: () => !!(state.share && state.meta),
      sample(lat, lon) {
        const v = gridSample(state.share, lat, lon);
        return v == null ? null : v;
      },
    });

    window.XYZO_EXPORT.register({
      id: "landcover",
      z: 353,   // the map pane order — the export draws in it too
      label: "🗺️ Land Cover (ESA)",
      kind: "raster",
      unit: "class",
      attribution: "ESA WorldCover 10 m v200 (2021)",
      licence: "CC BY 4.0",
      source: "https://esa-worldcover.esa.int/",
      period: "2021",
      bands: [{ name: "land_cover_class", unit: "class" }],
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 3600, rows: 1800, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
        });
      },
      isActive: () => !!(state.cls && state.meta),
      sample(lat, lon) {
        const v = gridSample(state.cls, lat, lon);
        return v == null ? null : v;
      },
    });
  }


  window.CroplandLayer = {
    init: init,
    getTileLayer: () => getLayerFor("cropland"),
    getLandCoverLayer: () => getLayerFor("landcover"),
    setEnabled: (on) => setEnabledMode("cropland", on),
    setLandCoverEnabled: (on) => setEnabledMode("landcover", on),
    // Either mode counts as "on" — the HUD checks isEnabled before
    // calling sampleAt, and a landcover-only view must still read out.
    isEnabled: () => state.enabled.cropland || state.enabled.landcover,
    isLandCoverEnabled: () => state.enabled.landcover,
    blocksClick: blocksClick,
    updateProbe: updateProbe,
    sampleAt,
    LAYER_NAME: "🌾 Cropland (ESA)",
    LANDCOVER_LAYER_NAME: "🗺️ Land Cover (ESA)",
    registerExport,
    _state: state,
    _gridSample: gridSample,
  };

  registerExport();
})();
