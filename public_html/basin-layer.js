/* ═══════════════════════════════════════════════════════════════════════
   Hydrological basins overlay for the Xyzo map.

   Source: FAO — "Major hydrological basins of the world" (AQUASTAT / SOLAW)
     https://data.apps.fao.org/catalog//iso/7707086d-af3c-41cc-8aa5-323d8609b2d1
   Basin boundaries delineated from hydrologically corrected elevation
   data (WWF HydroSHEDS and Hydro1K). CC BY-SA 4.0.

   scripts/basin_build.py writes ONE basin set at TWO detail levels
   (DETAIL_LEVELS in that script — major 0.05 deg, detailed 0.01 deg):

     /data/basins/basins_major.geojson     one dissolved polygon per
     /data/basins/basins_detailed.geojson  basin: name, kind, area_km2,
                                           n_polys
     /data/basins/meta.json                attribution, legend, area
                                           stats, and the `levels[]`
                                           naming the two files above

   The single-file `basins.geojson` this used to emit is gone: the
   builder deletes a stale copy so it cannot be served next to the
   per-level files. The layer reads the file name from meta.json's
   `levels[].file` (see levelUrl()) rather than hard-coding it.

   The published FAO attribute table (MAJ_BAS / MAJ_NAME / MAJ_AREA /
   SUB_BAS / SUB_NAME / SUB_AREA / TO_BAS) is a separate look-up that is
   NOT distributed with the geometry and is not exposed by the FAO WMS, so
   the overlay carries what the data actually has: the FAO basin name and
   the area computed from the polygons in an equal-area projection.

   The layer is a GeoJSON FeatureGroup in its own pane. The polygons are
   NOT interactive — the pane ignores pointer events — so the basins never
   swallow a map click. The probe does its own point-in-polygon test on
   the raw coordinates, which keeps the click-to-submit flow intact.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/basins";
  const BUILD = "202610281";
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  // The GeoJSON URL depends on which DETAIL LEVEL is selected, so it
  // comes from meta.json's `levels[].file` rather than being fixed here.
  // See DETAIL_LEVELS in scripts/basin_build.py: major (0.05 deg, ~6 MB)
  // and detailed (0.01 deg ~1 km, ~13 MB) — the same 235 basins drawn
  // at two precisions, so switching never changes what is on the map.
  const LEVEL_STORE_KEY = "xyzo.basinLevel";

  function levelUrl(file) {
    return BASE + "/" + file + "?v=" + BUILD;
  }
  const PANE = "basinPane";
  // Above the isobars (360) and the climate wash (350), below the rivers
  // (365) and the wind streamlines (370).
  const PANE_Z = 362;
  const STORE_KEY = "xyzo.basinLayer";
  const PROBE_STORE_KEY = "xyzo.basinProbe";
  const SCHEME_STORE_KEY = "xyzo.basinScheme";

  const FALLBACK_KIND_COLORS = {
    river: "#38bdf8",
    coast: "#22d3ee",
    interior: "#a78bfa",
  };
  const FALLBACK_KIND_LABELS = {
    river: "River basin",
    coast: "Coastal / oceanic drainage",
    interior: "Interior (endorheic) basin",
  };
  // Alternative palettes. "blue" defers to meta.kind_colors (the FAO
  // build's own colours); the others override all three kinds while
  // keeping them distinguishable by shade.
  const SCHEMES = {
    blue: null,
    red: {
      river: "#ef4444",
      coast: "#f87171",
      interior: "#7f1d1d",
    },
    black: {
      river: "#0a0a0a",
      coast: "#1c1c1c",
      interior: "#333333",
    },
  };
  const SCHEME_SWATCHES = {
    blue: "#38bdf8",
    red: "#ef4444",
    black: "#0a0a0a",
  };
  const SCHEME_LABELS = {
    blue: "Blue",
    red: "Red",
    black: "Black",
  };

  const state = {
    map: null,
    layer: null,
    enabled: false,
    probeMode: false,
    scheme: "blue",
    meta: null,
    features: null,
    loadPromise: null,
    opacity: 0.7,
    legendMounted: false,
  };

  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }
  function storageGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  function ensurePane(map) {
    if (map.getPane(PANE)) return;
    map.createPane(PANE);
    const pane = map.getPane(PANE);
    pane.style.zIndex = String(PANE_Z);
    // The basins are a context wash, not something you click on.
    pane.style.pointerEvents = "none";
  }

  function kindColors() {
    const override = SCHEMES[state.scheme];
    if (override) return override;
    return (state.meta && state.meta.kind_colors) || FALLBACK_KIND_COLORS;
  }
  function kindLabels() {
    return (state.meta && state.meta.kind_labels) || FALLBACK_KIND_LABELS;
  }

  // ── styling ──────────────────────────────────────────────────────────
  function styleFor(feature) {
    const p = feature.properties || {};
    const kind = p.kind || "river";
    const base = kindColors()[kind] || FALLBACK_KIND_COLORS.river;
    return {
      color: base,
      weight: 0.8,
      opacity: 0.85 * state.opacity,
      fillColor: base,
      fillOpacity: 0.16 * state.opacity,
      interactive: false,
    };
  }

  function restyle() {
    if (!state.layer || !state.features) return;
    state.layer.eachLayer((ly) => {
      if (ly.feature && typeof ly.setStyle === "function") ly.setStyle(styleFor(ly.feature));
    });
  }

  // ── point in polygon ─────────────────────────────────────────────────
  // Ray casting on the raw GeoJSON rings. The layer itself is not
  // interactive, so this is how the probe finds the basin under a click.
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = (yi > lat) !== (yj > lat) &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(lng, lat, rings) {
    if (!rings || !rings.length) return false;
    if (!pointInRing(lng, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lng, lat, rings[h])) return false;   // in a hole
    }
    return true;
  }

  function basinAt(lng, lat) {
    const feats = (state.features && state.features.features) || [];
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") {
        if (pointInPolygon(lng, lat, g.coordinates)) return f;
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) {
          if (pointInPolygon(lng, lat, poly)) return f;
        }
      }
    }
    return null;
  }

  // ── data ─────────────────────────────────────────────────────────────
  // The legend only needs meta.json (a few hundred bytes). The GeoJSON is
  // 6 MB raw / 1.4 MB gzipped, so it is only fetched when the layer is
  // actually switched on.
  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = fetch(META_URL, { cache: "default" })
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => {
        state.meta = meta;
        state.metaPromise = null;
        if (meta) mountLegend();
        return meta;
      })
      .catch((e) => {
        state.metaPromise = null;
        warn("[basins] meta load failed", e);
        return null;
      });
    return state.metaPromise;
  }

  // The level the user picked, falling back to whatever meta.json says
  // is the default (the fast one).
  function currentLevel(meta) {
    const levels = (meta && meta.levels) || [];
    const wanted = state.level || storageGet(LEVEL_STORE_KEY, "") || (meta && meta.default_level) || "major";
    return levels.find((l) => l.id === wanted) || levels[0] || null;
  }

  function ensureData() {
    if (state.features) return Promise.resolve(state.features);
    if (state.loadPromise) return state.loadPromise;
    // meta first (a few hundred bytes) because it names the file for the
    // selected level; then the GeoJSON.
    state.loadPromise = ensureMeta()
      .then((meta) => {
        const lv = currentLevel(meta);
        if (!lv) throw new Error("meta.json has no levels");
        state.level = lv.id;
        return fetch(levelUrl(lv.file), { cache: "default" }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        });
      })
      .then((fc) => {
        state.features = fc;
        state.loadPromise = null;
        log("[basins] loaded", (fc.features || []).length,
            "basins at level", state.level);
        return fc;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[basins] load failed", e);
        throw e;
      });
    return state.loadPromise;
  }

  // Swap detail level: drop the cached GeoJSON, reload, repaint.
  function setLevel(id) {
    if (!state.meta) return Promise.resolve();
    const lv = (state.meta.levels || []).find((l) => l.id === id);
    if (!lv || lv.id === state.level) return Promise.resolve();
    state.level = lv.id;
    storageSet(LEVEL_STORE_KEY, lv.id);
    state.features = null;
    state.loadPromise = null;
    return ensureData()
      .then(() => {
        // fillLayer() clears and re-adds from state.features, which the
        // reload above has just replaced.
        if (state.enabled) fillLayer();
        hideProbe();
        // Rebuild the legend so the detail chips show the new level.
        // (buildLegend() used to be called here and was never defined —
        // the whole setLevel() path was dead code until the chips
        // existed, so the ReferenceError had never fired.)
        state.legendMounted = false;
        mountLegend();
        refreshLevelButtons();
      })
      .catch(() => {});
  }

  // ── the overlay layer ────────────────────────────────────────────────
  function buildLayer() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    return L.geoJSON(null, {
      pane: PANE,
      style: (ft) => styleFor(ft),
      interactive: false,
      // CC BY-SA 4.0 REQUIRES attribution. Leaflet's attribution control
      // reads options.attribution off any layer (L.Layer.getAttribution)
      // and prints it in the bottom-right corner.
      attribution: "FAO — Major hydrological basins of the world (CC BY-SA 4.0)",
    });
  }

  function getTileLayer() {
    // OverlayOpacity.mount calls setOpacity() on every entry in
    // WEATHER_OVERLAYS, and a raw L.geoJSON has no such method.
    if (!state.layer) {
      state.layer = buildLayer();
      state.layer.setOpacity = (v) => setOpacity(v);
      state.layer.getOpacity = () => getOpacity();
    }
    return state.layer;
  }

  function fillLayer() {
    if (!state.layer || !state.features) return;
    state.layer.clearLayers();
    state.layer.addData(state.features);
    restyle();
  }

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData()
        .then(() => { fillLayer(); mountLegend(); })
        .catch(() => {});
    }
    notifyChange();
  }

  function setEnabled(on) {
    const want = !!on;
    if (!state.layer) state.layer = getTileLayer();
    if (!state.layer || !state.map) return Promise.resolve(false);
    if (want) {
      if (!state.map.hasLayer(state.layer)) state.layer.addTo(state.map);
    } else if (state.map.hasLayer(state.layer)) {
      state.map.removeLayer(state.layer);
    }
    onLayerToggled(state.map.hasLayer(state.layer));
    return Promise.resolve(state.enabled);
  }

  function setOpacity(v) {
    state.opacity = Math.max(0, Math.min(1, Number(v) || 0));
    restyle();
  }
  function getOpacity() { return state.opacity; }

  function setColorScheme(name) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMES, name)) name = "blue";
    state.scheme = name;
    storageSet(SCHEME_STORE_KEY, name);
    restyle();
    refreshLegendSwatches();
  }
  function getColorScheme() { return state.scheme; }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("xyzo:basin-change", { detail: { enabled: state.enabled } })); } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  // Mounted into the layers dropdown, as a SIBLING of the overlay list —
  // Leaflet empties and rebuilds .leaflet-control-layers-overlays on every
  // layer change, so a row inside that list is wiped.
  function mountLegend() {
    if (state.legendMounted) return true;
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!list) return false;
    const old = document.getElementById("basin-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "basin-legend";
    host.className = "basin-legend leaflet-control-layers-basin";
    const colors = kindColors();
    const labels = kindLabels();
    const rows = Object.keys(labels).map((k) => `
      <div class="basin-legend-row">
        <span class="basin-legend-swatch" data-kind="${k}" style="background:${colors[k] || "#38bdf8"}"></span>
        <span>${labels[k]}</span>
      </div>`).join("");
    const n = state.meta && state.meta.basin_count ? state.meta.basin_count : 235;
    const schemeBtns = Object.keys(SCHEMES).map((k) => `
      <button type="button" class="basin-scheme-btn${state.scheme === k ? " active" : ""}" ` +
      `data-scheme="${k}" title="${SCHEME_LABELS[k]}" aria-pressed="${state.scheme === k}">` +
      `<span class="basin-scheme-dot" style="background:${SCHEME_SWATCHES[k]}"></span>` +
      `</button>`).join("");
    // THE TWO DETAIL LEVELS, as a chip row. The builder publishes the
    // SAME 235 basins at two precisions (major 0.05 deg, detailed
    // 0.01 deg), so switching changes the edge detail and nothing
    // else. It used to have no UI at all — and setLevel() called a
    // refreshLevelButtons() that was never defined, so the first click
    // would have thrown a ReferenceError.
    const levels = (state.meta && state.meta.levels) || [];
    const levelBtns = levels.map((lv) => `
      <button type="button" class="basin-level-btn soil-prop-btn${lv.id === state.level ? " active" : ""}" ` +
      `data-level="${lv.id}" aria-pressed="${lv.id === state.level}" ` +
      `title="${lv.label || lv.id}">${lv.label || lv.id}</button>`).join("");
    host.innerHTML =
      '<div class="basin-legend-title"><span>Hydrological basins</span>' +
      '<button type="button" class="basin-probe-toggle" id="ctrl-basin-probe-toggle" ' +
      'aria-pressed="false">Probe</button></div>' +
      (levelBtns ? `<div class="basin-level-row" role="group" aria-label="Basin detail level">${levelBtns}</div>` : "") +
      `<div class="basin-scheme-row" role="group" aria-label="Basin colour">${schemeBtns}</div>` +
      `<div class="basin-legend-rows">${rows}</div>` +
      `<div class="basin-legend-foot">${n} FAO basins · tap to read the basin under the cursor</div>`;

    // Place it between the overlay list and the Story-links row, so the
    // order does not depend on which of the two was inserted last.
    const overlays = list.querySelector(".leaflet-control-layers-overlays");
    const storyRow = list.querySelector(".leaflet-links-row");
    if (storyRow && storyRow.parentNode === list) {
      list.insertBefore(host, storyRow);
    } else if (overlays) {
      overlays.insertAdjacentElement("afterend", host);
    } else {
      list.appendChild(host);
    }
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-basin-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        probeBtn.classList.toggle("active", state.probeMode);
        probeBtn.textContent = state.probeMode ? "Probe: On" : "Probe";
        probeBtn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
      });
    }
    host.querySelectorAll(".basin-scheme-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setColorScheme(btn.getAttribute("data-scheme") || "blue");
      });
    });
    host.querySelectorAll(".basin-level-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute("data-level");
        if (id) setLevel(id);
      });
    });
    return true;
  }

  // Mark the active detail level. Called after a switch and whenever
  // the legend is rebuilt — WITHOUT it the chips would keep showing
  // the level that was loaded first.
  function refreshLevelButtons() {
    if (!state.legendMounted) return;
    const host = document.getElementById("basin-legend");
    if (!host) return;
    host.querySelectorAll(".basin-level-btn").forEach((btn) => {
      const on = (btn.getAttribute("data-level") || "") === state.level;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function refreshLegendSwatches() {
    if (!state.legendMounted) return;
    const host = document.getElementById("basin-legend");
    if (!host) return;
    const colors = kindColors();
    host.querySelectorAll(".basin-legend-swatch").forEach((sw) => {
      const kind = sw.getAttribute("data-kind");
      if (kind && colors[kind]) sw.style.background = colors[kind];
    });
    host.querySelectorAll(".basin-scheme-btn").forEach((btn) => {
      const on = (btn.getAttribute("data-scheme") || "blue") === state.scheme;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // ── probe ────────────────────────────────────────────────────────────
  function showProbe(f, latlng) {
    if (!f) { hideProbe(); return; }
    const p = f.properties || {};
    const kind = p.kind || "river";
    const labels = kindLabels();
    const area = p.area_km2 ? Math.round(p.area_km2).toLocaleString() + " km²" : "—";
    const html =
      '<div class="basin-probe">' +
      `<div class="basin-probe-name">${escapeText(p.name || "Unknown basin")}</div>` +
      `<div class="basin-probe-meta">${labels[kind] || kind} · ${area}</div>` +
      '</div>';
    if (state.probeMarker) {
      state.probeMarker.setLatLng(latlng).setPopupContent(html).openPopup();
    }
  }

  function hideProbe() {
    if (state.probeMarker && state.map && state.map.hasLayer(state.probeMarker)) {
      state.map.removeLayer(state.probeMarker);
    }
  }

  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";
    state.scheme = storageGet(SCHEME_STORE_KEY, "blue");
    if (!Object.prototype.hasOwnProperty.call(SCHEMES, state.scheme)) state.scheme = "blue";
    ensureMeta();

    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });

    // The probe listens on the map's own click event so it never has to
    // make the polygons interactive.
    map.on("click", (e) => {
      if (!state.enabled || !state.probeMode) return;
      const f = basinAt(e.latlng.lng, e.latlng.lat);
      if (!f) { hideProbe(); return; }
      if (!state.probeMarker) {
        state.probeMarker = L.marker(e.latlng, {
          interactive: false,
          icon: L.divIcon({ className: "basin-probe-marker", html: "", iconSize: [0, 0] }),
          zIndexOffset: 1000,
        }).addTo(map);
      }
      state.probeMarker.setLatLng(e.latlng);
      showProbe(f, e.latlng);
    });
  }

  function blocksClick() {
    return state.probeMode;   // only while the probe is armed
  }

  // ── public API ───────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // The 235 FAO drainage basins as polygons.
  //
  // LICENCE NOTE: the FAO basin data is CC BY-SA 4.0. An export that
  // contains these polygons is a DERIVATIVE and carries the same
  // ShareAlike terms — which is why every export writes a licence file
  // naming it. See docs/DATA_LICENCES.md.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "basins",
      z: 362,   // the map pane order — the export draws in it too
      label: "🌊 Hydrological Basins",
      kind: "vector",
      attribution: "FAO AQUASTAT / SOLAW — Major hydrological basins of the world",
      licence: "CC BY-SA 4.0",
      source: "https://www.fao.org/aquastat/en/",
      style: { stroke: "#0a0a0a", fill: "#333333", width: 1, opacity: 0.9 },
      isActive: () => !!state.features,
      async features() {
        const fc = state.features;
        if (!fc) return { type: "FeatureCollection", features: [] };
        return { type: "FeatureCollection", features: (fc.features || []).slice() };
      },
    });
  }


  window.BasinLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    setColorScheme: setColorScheme,
    getColorScheme: getColorScheme,
    setLevel: setLevel,
    getLevel: () => state.level,
    blocksClick: blocksClick,
    mountLegend: mountLegend,
    LAYER_NAME: "🌊 Hydrological Basins",
    registerExport,
    _state: state,
    _styleFor: styleFor,
    _basinAt: basinAt,
    _pointInPolygon: pointInPolygon,
  };

  registerExport();
})();
