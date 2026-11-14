/* ═══════════════════════════════════════════════════════════════════════
   Soil overlay for the Xyzo map — SoilGrids 2.0 topsoil properties.

   Source: ISRIC World Soil Information — SoilGrids 2.0 (CC BY 4.0)
     https://soilgrids.org/

   scripts/soil_build.py writes, for each property:

     /data/soil/{key}/tiles/{z}/{x}/{y}.png   XYZ tile pyramid (EPSG:3857)
     /data/soil/{key}/grid.bin                Int16 probe grid, 0.1 deg
     /data/soil/{key}/meta.json               class table + grid geometry

   Properties: clay, sand, silt, phh2o (pH), soc, bdod, cec, texture.
   "texture" is the USDA soil-texture class derived from sand/silt/clay.

   The overlay is ONE layers-control entry with a property switcher in
   the legend — eight separate checkboxes would drown the dropdown.
   Changing the property swaps the tile URL and the probe grid in place.

   Tiles are PNG, which Caddy serves `immutable` for a year, so the URL
   carries a BUILD token that must be bumped whenever the data changes
   (same rule as the Köppen layer).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/soil";
  // Bump whenever scripts/soil_build.py rewrites any pyramid — and when
  // bumping to bust stale 404s: pre-fallback 404s were sent with the
  // *.png `immutable` rule and stayed cached in browsers for a year.
  const BUILD = "202610281";
  const STORE_KEY = "xyzo.soilLayer";
  const PROP_STORE_KEY = "xyzo.soilProp";
  const PROBE_STORE_KEY = "xyzo.soilProbe";
  const OVERLAY_OPACITY = 0.55;
  const PANE = "soilPane";
  const PANE_Z = 352;

  // Preferred order in the switcher. The two CLASSIFICATION maps come
  // first — WRB soil groups (the colour "major soil groups of the
  // world" map, the modern successor to FAO/UNESCO FGGD) and the USDA
  // orders — because they are what people mean by a soil-type map.
  // Then texture (USDA classes without a unit), then the seven
  // continuous properties.
  const PROP_ORDER = ["wrb", "usda", "texture", "clay", "sand", "silt", "phh2o", "soc", "bdod", "cec"];
  const PROP_FALLBACK = {
    wrb: { title: "Soil groups (WRB)", unit: "class" },
    usda: { title: "Soil orders (USDA)", unit: "class" },
    texture: { title: "Soil texture", unit: "class" },
    clay: { title: "Clay", unit: "%" },
    sand: { title: "Sand", unit: "%" },
    silt: { title: "Silt", unit: "%" },
    phh2o: { title: "pH", unit: "pH" },
    soc: { title: "Organic carbon", unit: "% OC" },
    bdod: { title: "Bulk density", unit: "g/cm³" },
    cec: { title: "CEC", unit: "cmol/kg" },
  };

  const state = {
    map: null,
    tileLayer: null,
    enabled: false,
    probeMode: false,
    prop: null,           // active property key
    metas: {},            // key -> meta.json
    grids: {},            // key -> Int16Array
    loadPromises: {},
    legendMounted: false,
    legendBuilt: false,
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

  function defaultProp() {
    const saved = storageGet(PROP_STORE_KEY, "wrb");
    return PROP_ORDER.indexOf(saved) >= 0 ? saved : "wrb";
  }

  // If the preferred property has no published pyramid yet (build still
  // running), fall back through the list rather than sitting on a dead
  // "Loading…" legend forever.
  function firstLoadableProp() {
    const start = PROP_ORDER.indexOf(state.prop || defaultProp());
    const order = start >= 0
      ? PROP_ORDER.slice(start).concat(PROP_ORDER.slice(0, start))
      : PROP_ORDER.slice();
    return order;
  }

  // ── data ──────────────────────────────────────────────────────────────
  function ensureProp(key) {
    if (state.metas[key] && state.grids[key]) return Promise.resolve(key);
    if (state.loadPromises[key]) return state.loadPromises[key];
    const metaUrl = BASE + "/" + key + "/meta.json?v=" + BUILD;
    const gridUrl = BASE + "/" + key + "/grid.bin?v=" + BUILD;
    state.loadPromises[key] = Promise.all([
      fetch(metaUrl, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("meta HTTP " + r.status);
        return r.json();
      }),
      fetch(gridUrl, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("grid HTTP " + r.status);
        return r.arrayBuffer();
      }),
    ])
      .then(([meta, buf]) => {
        const g = meta.grid || {};
        const expect = (g.width | 0) * (g.height | 0);
        const arr = new Int16Array(buf);
        if (expect && arr.length !== expect) {
          throw new Error("grid is " + arr.length + " values, expected " + expect);
        }
        state.metas[key] = meta;
        state.grids[key] = arr;
        state.loadPromises[key] = null;
        log("[soil] loaded", key, arr.length, "values");
        return key;
      })
      .catch((e) => {
        state.loadPromises[key] = null;
        warn("[soil]", key, "failed to load", e);
        throw e;
      });
    return state.loadPromises[key];
  }

  // Nearest-neighbour sample of the probe grid. Returns the raw stored
  // value (class index for texture, scaled integer otherwise) or null.
  function sampleRaw(key, lat, lng) {
    const meta = state.metas[key];
    const grid = state.grids[key];
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

  function formatValue(key, raw) {
    const meta = state.metas[key] || PROP_FALLBACK[key] || {};
    if (raw == null || raw === 0) return null;   // 0 = no soil / nodata for class layers
    if (key === "texture" || key === "wrb" || meta.unit === "class") {
      const cls = (meta.classes || []).find((c) => c.index === raw);
      return cls ? cls.label || cls.code : null;
    }
    const scale = meta.scale != null ? meta.scale : 1;
    const dec = meta.decimals != null ? meta.decimals : 1;
    const unit = meta.unit || "";
    const v = (raw * scale).toFixed(dec);
    return unit && unit !== "class" ? v + " " + unit : v;
  }

  function classColor(key, raw) {
    const meta = state.metas[key];
    if (!meta || raw == null) return null;
    const cls = (meta.classes || []).find((c) => c.index === raw);
    return cls ? cls.color : null;
  }

  // ── the overlay layer ────────────────────────────────────────────────
  function tilesUrl(key) {
    return BASE + "/" + key + "/tiles/{z}/{x}/{y}.png?v=" + BUILD;
  }

  function ensurePane(map) {
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      // Above the base tiles, around the climate wash, below pins.
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  // The map-corner credit must name the publisher of the tiles actually
  // ON SCREEN — nine properties are SoilGrids', the USDA orders are
  // OpenGeoHub's, and crediting ISRIC for OpenGeoHub data would be a
  // licence breach in the most visible place on the page. The tile
  // layer is rebuilt on every property switch, so the credit follows.
  const PROP_ATTRIBUTION = {
    usda: "OpenLandMap-soildb (OpenGeoHub Foundation) — CC BY 4.0",
  };
  function attributionFor(key) {
    return PROP_ATTRIBUTION[key] || "SoilGrids 2.0 (ISRIC) — CC BY 4.0";
  }

  function buildLayer(key) {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    return L.tileLayer(tilesUrl(key), {
      minZoom: 0,
      maxNativeZoom: 7,
      opacity: state.opacity,
      pane: PANE,
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: attributionFor(key),
      className: "xyzo-soil-tiles",
    });
  }

  function getTileLayer() {
    if (!state.tileLayer) {
      state.prop = state.prop || defaultProp();
      state.tileLayer = buildLayer(state.prop);
    }
    return state.tileLayer;
  }

  function setProperty(key) {
    if (PROP_ORDER.indexOf(key) < 0 || key === state.prop) return;
    state.prop = key;
    storageSet(PROP_STORE_KEY, key);
    if (state.tileLayer) {
      // Swap the URL on the SAME layer object — never remove + rebuild.
      // The layers control is constructed with ONE object per overlay:
      // removing it fires `overlayremove`, which our own listener turns
      // into state.enabled = false (and that flag GATES ensureProp),
      // while the freshly built replacement fires NO `overlayadd`
      // because the control has never seen it. Net effect, measured
      // live on the pre-existing wrb→clay switch: the new property's
      // meta/grid is never fetched, the legend stays on the previous
      // property, refreshPropButtons() disables every chip — and
      // onLayerToggled(false) writes localStorage["xyzo.soilLayer"]="0",
      // so the next visit loses the layer entirely. setUrl() keeps
      // object identity, so no layer event fires at all.
      const oldAttr = state.tileLayer.options.attribution;
      const newAttr = attributionFor(key);
      state.tileLayer.setUrl(tilesUrl(key));
      if (oldAttr !== newAttr) {
        // The corner credit must follow the tiles, and setUrl fires no
        // layer events for the attribution control to hear about — so
        // push the change through its own API (only while the layer is
        // actually on the map; the chips are disabled when it is off,
        // so this is belt-and-braces).
        state.tileLayer.options.attribution = newAttr;
        const ctl = state.map && state.map.attributionControl;
        if (ctl && state.map.hasLayer(state.tileLayer)) {
          if (oldAttr) ctl.removeAttribution(oldAttr);
          if (newAttr) ctl.addAttribution(newAttr);
        }
      }
    }
    if (state.enabled) ensureProp(key).then(refreshLegendBody).catch(() => {});
    refreshPropButtons();
  }

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      loadWithFallback()
        .then(() => { buildLegend(); refreshLegendBody(); })
        .catch(() => {});
    } else {
      hideProbe();
    }
    refreshPropButtons();
    notifyChange();
  }

  function loadWithFallback() {
    const attempt = (i) => {
      const keys = firstLoadableProp();
      if (i >= keys.length) return Promise.reject(new Error("no soil layer published"));
      const key = keys[i];
      return ensureProp(key).then(() => {
        if (key !== state.prop) setProperty(key);
      }).catch(() => attempt(i + 1));
    };
    return attempt(0);
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
    try { window.dispatchEvent(new CustomEvent("xyzo:soil-change", { detail: { enabled: state.enabled, prop: state.prop } })); } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  function buildLegend() {
    const body = document.getElementById("soil-legend-body");
    if (!body) return;
    const meta = state.metas[state.prop] || PROP_FALLBACK[state.prop] || {};
    const classes = meta.classes || [];
    let html = "";
    if (!classes.length) {
      html = '<div class="climate-legend-loading">Loading…</div>';
    } else if (state.prop === "texture" || state.prop === "wrb" || meta.unit === "class") {
      html = '<div class="soil-legend-grid">';
      for (const c of classes) {
        html +=
          '<div class="soil-legend-row">' +
          '<span class="soil-legend-swatch" style="background:' + esc(c.color) + '"></span>' +
          '<span class="soil-legend-label">' + esc(c.label || c.code) + "</span>" +
          "</div>";
      }
      html += "</div>";
    } else {
      const unit = meta.unit || "";
      html = '<div class="soil-legend-scale">';
      for (const c of classes) {
        const lo = c.min != null ? c.min : "";
        const hi = c.max != null ? c.max : "";
        html +=
          '<div class="soil-legend-row">' +
          '<span class="soil-legend-swatch" style="background:' + esc(c.color) + '"></span>' +
          '<span class="soil-legend-label">' + esc(lo) + "–" + esc(hi) +
          (unit && unit !== "class" ? " " + esc(unit) : "") + "</span>" +
          "</div>";
      }
      html += "</div>";
    }
    const foot = document.getElementById("soil-legend-foot");
    if (foot) {
      const blurb = meta.blurb || meta.title || "";
      foot.innerHTML = esc(blurb) + (meta.attribution ? " · " + esc(meta.attribution) : "");
    }
    body.innerHTML = html;
    state.legendBuilt = true;
  }

  function refreshLegendBody() {
    if (state.enabled) buildLegend();
  }

  function refreshPropButtons() {
    const host = document.getElementById("soil-prop-switch");
    if (!host) return;
    const btns = host.querySelectorAll("[data-prop]");
    btns.forEach((b) => {
      const on = b.getAttribute("data-prop") === state.prop;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("is-active", on);
      b.disabled = !state.enabled;
      b.style.opacity = state.enabled ? "" : "0.45";
    });
  }

  function mountLegendIntoLayersControl() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("soil-legend");
    if (old) old.remove();

    const coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "soil-legend";
    host.className = "climate-legend leaflet-control-layers-soil";
    if (coarsePointer) host.classList.add("is-touch");

    let chips = "";
    for (const key of PROP_ORDER) {
      const t = (PROP_FALLBACK[key] || {}).title || key;
      chips +=
        '<button type="button" class="soil-prop-btn" data-prop="' + esc(key) + '" ' +
        'aria-pressed="false" title="' + esc(t) + '">' + esc(t) + "</button>";
    }

    host.innerHTML =
      '<div class="climate-legend-title"><span>Soil</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-soil-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the soil value (touch devices)">Probe</button>' +
      "</div>" +
      '<div class="soil-prop-switch" id="soil-prop-switch" role="group" aria-label="Soil property">' +
      chips + "</div>" +
      '<div class="climate-legend-body" id="soil-legend-body">' +
      '<div class="climate-legend-loading">Loading…</div></div>' +
      '<div class="climate-legend-foot" id="soil-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    host.querySelectorAll("[data-prop]").forEach((b) => {
      b.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        setProperty(b.getAttribute("data-prop"));
      });
    });

    const probeBtn = host.querySelector("#ctrl-soil-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshToggleButtons();
      });
    }

    refreshPropButtons();
    if (state.enabled) {
      loadWithFallback()
        .then(() => { buildLegend(); refreshLegendBody(); })
        .catch(() => {});
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

  function refreshToggleButtons() {
    const probeToggle = document.getElementById("ctrl-soil-probe-toggle");
    if (probeToggle) {
      probeToggle.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
      probeToggle.disabled = !state.enabled;
      probeToggle.style.opacity = state.enabled ? "" : "0.45";
    }
  }

  // ── probe ────────────────────────────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("soil-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "soil-probe";
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
    const el = document.getElementById("soil-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
  }

  function showProbe(latlng, containerPoint) {
    if (!state.enabled) return;
    const key = state.prop;
    const raw = sampleRaw(key, latlng.lat, latlng.lng);
    const text = formatValue(key, raw);
    const color = classColor(key, raw);
    const el = probeEl();
    if (text == null) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    const sig = key + "|" + text;
    if (state.lastProbe !== sig) {
      const meta = state.metas[key] || {};
      el.innerHTML =
        (color ? '<span class="climate-probe-swatch" style="background:' + esc(color) + '"></span>' : "") +
        '<span class="climate-probe-desc">' + esc(meta.title || key) + ": " + esc(text) + "</span>";
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

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    state.prop = defaultProp();

    // restore enabled state from localStorage only if the layers control
    // has not already decided (app.js owns overlayadd/remove).
    map.on("overlayadd", (e) => {
      if (state.tileLayer && e.layer === state.tileLayer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.tileLayer && e.layer === state.tileLayer) onLayerToggled(false);
    });

    map.on("mousemove", (e) => {
      // HoverInfo "all" mode aggregates every layer's reading into one
      // card — stand down so two boxes don't fight over the cursor.
      if (window.HoverInfo && typeof HoverInfo.suppressesProbes === "function" && HoverInfo.suppressesProbes()) return;
      updateProbe(e.latlng, e.containerPoint);
    });
    map.on("click", () => { if (state.probeMode) hideProbe(); });

    waitForLayersControl();
  }

  function blocksClick() {
    return !!(state.enabled && state.probeMode);
  }

  // ── public API ───────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // The ACTIVE property is exported (the one the property switcher in
  // the legend has selected), because that is the layer the user is
  // looking at. A class property (WRB groups, USDA texture) exports
  // its class INDEX, not its label — a label is a string, and a
  // raster band has to be a number. The class table travels in the
  // file's metadata.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "soil",
      z: 352,   // the map pane order — the export draws in it too
      label: "🟫 Soil",
      kind: "raster",
      unit: "",
      // Getters, not literals: the export contract PRESERVES accessors
      // (export-contract.js copies descriptors, it does not evaluate
      // them), and the exported file must carry the source of the
      // property that was on screen — SoilGrids for nine of them,
      // OpenGeoHub for the USDA orders. Both are CC BY 4.0, so the
      // licence itself is static.
      get attribution() {
        return state.prop === "usda"
          ? "OpenLandMap-soildb (OpenGeoHub Foundation)"
          : "SoilGrids 2.0 (ISRIC World Soil Information)";
      },
      licence: "CC BY 4.0",
      get source() {
        return state.prop === "usda"
          ? "https://doi.org/10.5194/essd-18-989-2026"
          : "https://soilgrids.org/";
      },
      period: "",
      // The unit follows the ACTIVE property (g/kg of organic carbon,
      // % sand, …), which is a getter because the property switcher
      // can change it at any time.
      get bands() {
        const meta = state.metas[state.prop] || {};
        return [{ name: "soil_" + state.prop, unit: meta.unit && meta.unit !== "class" ? meta.unit : "" }];
      },
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.metas[state.prop], {
          cols: 3600, rows: 1800, latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
        });
      },
      isActive: () => !!(state.grids[state.prop] && state.metas[state.prop]),
      sample(lat, lon) {
        const key = state.prop;
        const raw = sampleRaw(key, lat, lon);
        if (raw == null) return null;
        const meta = state.metas[key] || {};
        const scale = meta.scale != null ? meta.scale : 1;
        const isClass = key === "texture" || key === "wrb" || meta.unit === "class";
        // A class index is the class itself; a continuous property is
        // stored scaled, so it is scaled back to its published unit.
        return isClass ? raw : raw * scale;
      },
    });
  }


  window.SoilLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    updateProbe: updateProbe,
    // HoverInfo "all" mode: a one-line reading for the cursor position,
    // using whichever property the switcher has selected.
    sampleAt(latlng) {
      if (!state.enabled) return null;
      const key = state.prop;
      const raw = sampleRaw(key, latlng.lat, latlng.lng);
      const text = formatValue(key, raw);
      if (text == null) return null;
      const meta = state.metas[key] || {};
      return (meta.title || key) + " · " + text;
    },
    // "Soil (SoilGrids)" would now be FALSE for the USDA-orders chip:
    // nine properties are ISRIC's, one is OpenGeoHub's. The slug stays
    // `soil-soilgrids` (REVERSE_LAYER_SLUGS below) so every shared link
    // and preset keeps working byte-identically — a slug is an
    // identifier, not a claim.
    LAYER_NAME: "🟫 Soil",
    registerExport,
    // test hooks
    _state: state,
    _sampleRaw: sampleRaw,
    _formatValue: formatValue,
    _defaultProp: defaultProp,
    _setProperty: setProperty,
  };

  registerExport();
})();
