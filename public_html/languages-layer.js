/* ═══════════════════════════════════════════════════════════════════════
   World languages overlay for the Xyzo map.

   Source: Glottolog — the free, authoritative database of the world's
     languages (Max Planck Institute for Geoanthropology). CC BY-SA 4.0.
     https://glottolog.org/meta/downloads

   scripts/languages_build.py writes:

     /data/languages/languages.geojson   one Point per language
     /data/languages/meta.json           attribution, counts, macroareas

   POINTS, NOT POLYGONS — and that is the whole point of this layer.
   The previous overlay (Native Land Digital) drew one polygon per
   language area. A polygon can only ever show one language: where
   several languages share a territory — Papua New Guinea, the Amazon,
   the Caucasus, much of Africa — the topmost polygon hides the rest.
   Points overlap, so a cluster reads as "many languages here" and the
   probe can list EVERY language under the cursor.

   Glottolog also reaches languages the Indigenous-territories dataset
   does not: Aasax, Wintu, Ainu, Yaghan and thousands of others, plus
   585 dialects. 8,889 points against 1,473 polygons.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/languages";
  const BUILD = "202610291";
  const GEOJSON_URL = BASE + "/languages.geojson?v=" + BUILD;
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  const PANE = "langPane";
  // Above climate (350) and temperature (355), below the rivers (365) and
  // pins (400): languages are a human layer and should sit over the
  // physical ones, but never over the news itself.
  // 364, NOT 357 or 358. 358 is magPane, and 357 turned out to be
  // phytoplanktonPane — the "357 was freed by the indigenous → languages
  // rename" assumption was wrong, and it shipped a collision (two washes
  // on one pane fight for the same slot; the same class of bug as the
  // lightning/indigenous collision of 2026-10-28).
  // 364 puts the dots just under the rivers (365): above every raster
  // wash, so no wash can bury a language dot, and still under the news.
  const PANE_Z = 364;
  const STORE_KEY = "xyzo.langLayer";

  // One colour per Glottolog macroarea. The same language in two places
  // gets the same colour, so a colour reads as a region, not a random id.
  const AREA_COLORS = {
    Africa: "#f59e0b",
    Papunesia: "#22d3ee",
    Eurasia: "#a78bfa",
    "North America": "#4ade80",
    "South America": "#f472b6",
    Australia: "#facc15",
    Other: "#94a3b8",
  };
  const AREA_FALLBACK = "#94a3b8";

  const state = {
    map: null,
    layer: null,
    enabled: false,
    probeMode: false,
    namesOn: false,
    meta: null,
    features: null,
    loadPromise: null,
    opacity: 0.8,
    legendMounted: false,
    renderer: null,
  };

  function log(...a) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...a);
  }
  function warn(...a) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...a);
  }
  function storageGet(k, f) {
    try { const v = localStorage.getItem(k); return v == null ? f : v; }
    catch (_) { return f; }
  }
  function storageSet(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function areaColor(a) {
    return AREA_COLORS[a] || AREA_FALLBACK;
  }

  // ── styling ──────────────────────────────────────────────────────────
  // A point is sized by how many languages sit on it: one language is a
  // dot, nine is a stack. That is what makes the overlay legible at low
  // zoom instead of a smear of equal-sized dots.
  function radiusFor(props) {
    const n = props && props.colocated ? props.colocated : 1;
    return 2.5 + Math.min(6, Math.log2(n) * 1.6);
  }

  function styleFor(feature) {
    const p = feature.properties || {};
    return {
      renderer: state.renderer,
      radius: radiusFor(p),
      color: "#0b1220",
      weight: 0.7,
      fillColor: areaColor(p.macroarea),
      fillOpacity: 0.9 * state.opacity,
      opacity: 0.9 * state.opacity,
      interactive: false,
    };
  }

  function restyle() {
    if (!state.layer || !state.features) return;
    state.layer.eachLayer((ly) => {
      if (ly.feature && typeof ly.setStyle === "function") ly.setStyle(styleFor(ly.feature));
    });
  }

  // ── probe: every language at a point ─────────────────────────────────
  // This is the feature a polygon map cannot offer: when several
  // languages share a territory the polygons hide each other, but a
  // point probe can list all of them.
  function languagesNear(lng, lat, radiusDeg) {
    const feats = (state.features && state.features.features) || [];
    const r2 = radiusDeg * radiusDeg;
    const out = [];
    for (const f of feats) {
      const c = f.geometry && f.geometry.coordinates;
      if (!c) continue;
      const dx = c[0] - lng;
      const dy = c[1] - lat;
      if (dx * dx + dy * dy <= r2) out.push(f);
    }
    out.sort((a, b) => (b.properties.colocated || 1) - (a.properties.colocated || 1));
    return out;
  }

  function showProbe(feats, latlng) {
    if (!feats || !feats.length) { hideProbe(); return; }
    const rows = feats.slice(0, 14).map((f) => {
      const p = f.properties;
      const bits = [];
      if (p.iso) bits.push(escapeHtml(p.iso));
      bits.push(escapeHtml(p.level || "language"));
      if (p.macroarea) bits.push(escapeHtml(p.macroarea));
      return (
        '<div class="lang-probe-row">' +
        `<span class="lang-probe-dot" style="background:${areaColor(p.macroarea)}"></span>` +
        `<span class="lang-probe-name">${escapeHtml(p.name)}</span>` +
        `<span class="lang-probe-meta">${bits.join(" · ")}</span>` +
        "</div>"
      );
    }).join("");
    const more = feats.length > 14
      ? `<div class="lang-probe-more">+${feats.length - 14} more here</div>` : "";
    const head = `<div class="lang-probe-head">${feats.length} language${feats.length === 1 ? "" : "s"} here</div>`;
    const html = `<div class="lang-probe">${head}${rows}${more}</div>`;
    if (state.probeMarker && state.map) {
      state.probeMarker.setLatLng(latlng).setPopupContent(html).openPopup();
    }
  }

  function hideProbe() {
    if (state.probeMarker && state.map && state.map.hasLayer(state.probeMarker)) {
      state.map.removeLayer(state.probeMarker);
    }
  }

  // ── data ─────────────────────────────────────────────────────────────
  // meta.json is a few hundred bytes; the GeoJSON is 1.8 MB, so the
  // legend mounts on meta alone and the points only fetch on enable.
  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = fetch(META_URL, { cache: "default" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { state.meta = m; state.metaPromise = null; if (m) mountLegend(); return m; })
      .catch((e) => { state.metaPromise = null; warn("[languages] meta load failed", e); return null; });
    return state.metaPromise;
  }

  function ensureData() {
    if (state.features) return Promise.resolve(state.features);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.all([
      ensureMeta(),
      fetch(GEOJSON_URL, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
    ])
      .then(([, fc]) => {
        state.features = fc;
        state.loadPromise = null;
        log("[languages] loaded", (fc.features || []).length, "points");
        return fc;
      })
      .catch((e) => { state.loadPromise = null; warn("[languages] load failed", e); throw e; });
    return state.loadPromise;
  }

  // ── the overlay layer ────────────────────────────────────────────────
  function buildLayer() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    // Canvas, not SVG: 8,889 SVG circles is a lot of DOM, and the canvas
    // renderer keeps the map responsive while panning.
    if (!state.renderer && window.L.canvas) {
      // The renderer MUST be told which pane it lives in. Leaflet's
    // L.canvas() puts its container in the DEFAULT overlay pane, and the
    // overlay pane is where the STORY PIN canvas lives — so a renderer
    // without a pane is appended AFTER the pin canvas and sits ON TOP
    // of it. It is a full-map element with pointer-events: auto, so it
    // swallowed EVERY pointer event over the map and the story pins'
    // own hover (the ring, the card) died the moment this layer was
    // switched on. The layer's pane is pointer-events: none, so putting
    // the canvas there makes it invisible to the pointer while still
    // painting.
    state.renderer = window.L.canvas({ padding: 0.3, pane: PANE });
    }
    return L.geoJSON(null, {
      pane: PANE,
      pointToLayer: (feature, latlng) =>
        L.circleMarker(latlng, styleFor(feature)),
      style: (ft) => styleFor(ft),
      interactive: false,
    });
  }

  function ensurePane(map) {
    if (map.getPane(PANE)) return;
    map.createPane(PANE);
    const pane = map.getPane(PANE);
    pane.style.zIndex = String(PANE_Z);
    // The probe owns the click; the dots never do.
    pane.style.pointerEvents = "none";
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
  }

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData().then(() => { fillLayer(); mountLegend(); }).catch(() => {});
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

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("xyzo:lang-change", { detail: { enabled: state.enabled } })); } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  // Inside the Leaflet layers dropdown, which keeps Leaflet's default
  // WHITE background — so hardcoded light-theme colours, like the Köppen
  // key beside it.
  function mountLegend() {
    if (state.legendMounted) return true;
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!list) return false;
    const old = document.getElementById("lang-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "lang-legend";
    host.className = "lang-legend leaflet-control-layers-lang";
    const counts = (state.meta && state.meta.macroareas) || {};
    const rows = Object.keys(AREA_COLORS)
      .filter((k) => k !== "Other")
      .map((k) => {
        const n = counts[k] != null ? ` <span class="lang-legend-count">${counts[k]}</span>` : "";
        return (
          '<div class="lang-legend-row">' +
          `<span class="lang-legend-swatch" style="background:${AREA_COLORS[k]}"></span>` +
          `<span>${k}${n}</span></div>`
        );
      }).join("");
    const n = state.meta && state.meta.language_count ? state.meta.language_count : 8889;
    host.innerHTML =
      '<div class="lang-legend-title"><span>Languages</span>' +
      '<button type="button" class="lang-probe-toggle" id="ctrl-lang-probe-toggle" ' +
      'aria-pressed="false">Probe</button></div>' +
      `<div class="lang-legend-sub">${n.toLocaleString()} Glottolog languages · by macroarea</div>` +
      `<div class="lang-legend-rows">${rows}</div>` +
      '<div class="lang-legend-foot">Dot size = how many languages share a spot · tap Probe to list every language here</div>';

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

    const probeBtn = host.querySelector("#ctrl-lang-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.probeMode = !state.probeMode;
        storageSet("xyzo.langProbe", state.probeMode ? "1" : "0");
        probeBtn.classList.toggle("active", state.probeMode);
        probeBtn.textContent = state.probeMode ? "Probe: On" : "Probe";
        probeBtn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
      });
    }
    return true;
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    state.probeMode = storageGet("xyzo.langProbe", "0") === "1";
    ensureMeta();

    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });

    // The probe reads its own coordinates off the raw coordinates, so the
    // dots stay non-interactive and never swallow a click.
    map.on("click", (e) => {
      if (!state.enabled || !state.probeMode) return;
      const feats = languagesNear(e.latlng.lng, e.latlng.lat, probeRadius());
      if (!feats.length) { hideProbe(); return; }
      if (!state.probeMarker) {
        state.probeMarker = L.marker(e.latlng, {
          interactive: false,
          icon: L.divIcon({ className: "lang-probe-marker", html: "", iconSize: [0, 0] }),
          zIndexOffset: 1000,
        }).addTo(map);
      }
      state.probeMarker.setLatLng(e.latlng);
      showProbe(feats, e.latlng);
    });
  }

  // Degrees of search radius: wide enough to catch a cluster of co-spoken
  // languages, tight enough to read as "here".
  function probeRadius() {
    const z = state.map ? state.map.getZoom() : 2;
    return z >= 7 ? 0.15 : z >= 5 ? 0.5 : z >= 3 ? 1.5 : 6;
  }

  function blocksClick() {
    return state.probeMode;
  }

  // HUD sampling ("Everything" mode) — the nearest language point within
  // ~0.25° (≈ 28 km). Co-spoken languages share a coordinate, so the
  // nearest one is a representative name, not "the only" language here
  // (the click-Probe still lists them all). 8,889 points, ~0.2 ms per
  // scan, rAF-throttled by the HUD.
  function sampleAt(latlng) {
    if (!state.enabled || !state.features) return null;
    const lat = latlng && Number(latlng.lat);
    const lng0 = latlng && Number(latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng0)) return null;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const MAX_D2 = 0.25 * 0.25;
    let best = null;
    const feats = state.features.features || [];
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const g = f.geometry;
      if (!g || g.type !== "Point" || !g.coordinates) continue;
      const dx = (Number(g.coordinates[0]) - lng0) * cosLat;
      const dy = (Number(g.coordinates[1]) - lat);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > MAX_D2) continue;
      if (!best || d2 < best.d2) {
        const name = f.properties && f.properties.name;
        if (name) best = { d2, name };
      }
    }
    return best ? best.name : null;
  }

  // ── public API ───────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // The 8,889 Glottolog language POINTS. Points, not polygons: a
  // polygon overlay could only ever show ONE language per territory,
  // and the dataset's own value is that co-spoken languages overlap.
  //
  // LICENCE NOTE: Glottolog is CC BY-SA 4.0, so a derivative carries
  // the same ShareAlike terms.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "languages",
      z: 364,   // the map pane order — the export draws in it too
      label: "🌍 Languages",
      kind: "vector",
      attribution: "Glottolog 5.0 — Max Planck Institute for Geoanthropology",
      licence: "CC BY-SA 4.0",
      source: "https://glottolog.org/",
      style: { stroke: "#f59e0b", fill: "#f59e0b", radius: 2.5, opacity: 0.9 },
      isActive: () => !!state.features,
      async features() {
        const fc = state.features;
        if (!fc) return { type: "FeatureCollection", features: [] };
        return { type: "FeatureCollection", features: (fc.features || []).slice() };
      },
    });
  }


  window.LanguagesLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    mountLegend: mountLegend,
    sampleAt,
    LAYER_NAME: "🌍 Languages",
    registerExport,
    _state: state,
    _styleFor: styleFor,
    _languagesNear: languagesNear,
  };

  registerExport();
})();
