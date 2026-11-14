/* ═══════════════════════════════════════════════════════════════════════
   Language REGIONS overlay for the Xyzo map — countries coloured by how
   many Glottolog languages are spoken in them.

   Source: Glottolog — the free, authoritative database of the world's
     languages (Max Planck Institute for Geoanthropology). CC BY-SA 4.0.
   Boundaries: Natural Earth 50m admin-0 countries (public domain).

   scripts/languages_regions_build.py writes:

     /data/languages/regions.geojson   one polygon per country
     /data/languages/meta.json          attribution, counts, and the
                                        `regions` block that names the file

   WHAT THIS IS, AND WHAT IT IS NOT
   ────────────────────────────────
   Glottolog records a language's TERRITORY — the countries it is spoken
   in — and never an EXTENT. There is no boundary of a speech community
   in the data, so this overlay draws the COUNTRY and says honestly what
   that means: the fill is the number of Glottolog languages listed for
   that country, and the probe lists them.

   It is NOT a replacement for the POINTS overlay
   (/data/languages/languages.geojson, `languages-layer.js`), which draws
   one dot per language with a coordinate. A one-polygon-per-language-area
   map could only ever show ONE language per area — where several share
   a territory (Papua New Guinea, the Amazon, the Caucasus) the topmost
   polygon hides the rest. The points layer answers "which languages are
   here, one dot each"; this one answers "how dense is this country, and
   what is in it". Both are published; they are different questions.

   The polygons are NOT interactive — the pane ignores pointer events —
   so a country never swallows a map click. The probe does its own
   point-in-polygon test on the raw coordinates, exactly like the basins
   layer, which keeps the click-to-submit flow intact.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/languages";
  const BUILD = "202611031";
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  const REGIONS_URL = BASE + "/regions.geojson?v=" + BUILD;
  const PANE = "langRegionsPane";
  // Immediately BELOW the language dots (langPane, 364) and above the
  // basins (362): the regions wash is the backdrop the dots read on.
  const PANE_Z = 363;
  const STORE_KEY = "xyzo.langRegionsLayer";
  const PROBE_STORE_KEY = "xyzo.langRegionsProbe";

  // Sequential ramp on the number of languages: cool for a few, hot for
  // the dense ones. The scale is LOGARITHMIC — the counts run from 1 to
  // 928, so a linear ramp would paint every country but the biggest ten
  // the same shade.
  const RAMP = [
    { t: 0.00, c: "#0d3b5e" },   // deep navy — one language
    { t: 0.28, c: "#15699b" },   // blue
    { t: 0.52, c: "#1f9fc4" },   // cyan-blue
    { t: 0.74, c: "#38d0d0" },   // cyan
    { t: 0.88, c: "#a78bfa" },   // violet
    { t: 1.00, c: "#f59e0b" },   // amber — the densest regions
  ];

  // How many languages the probe lists before it says "+N more".
  const PROBE_ROWS = 12;

  const state = {
    map: null,
    layer: null,
    enabled: false,
    probeMode: false,
    meta: null,
    features: null,
    loadPromise: null,
    opacity: 0.75,
    legendMounted: false,
    // Per-feature bounding boxes, so the probe's ray cast only runs
    // against the handful of countries that can contain the cursor.
    boxes: null,
    maxCount: 0,
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

  // ── the ramp ──────────────────────────────────────────────────────────
  // t is the position on the scale; colourAt() interpolates between the
  // two stops that bracket it. The stops are NOT evenly spaced, so the
  // lookup scans — the same trap the temperature ramp walked into.
  function colourAt(t) {
    const x = Math.max(0, Math.min(1, Number(t) || 0));
    let lo = RAMP[0], hi = RAMP[RAMP.length - 1];
    for (let i = 0; i < RAMP.length - 1; i++) {
      if (x >= RAMP[i].t && x <= RAMP[i + 1].t) { lo = RAMP[i]; hi = RAMP[i + 1]; break; }
    }
    const span = hi.t - lo.t;
    const f = span <= 0 ? 0 : (x - lo.t) / span;
    return mix(lo.c, hi.c, f);
  }

  function mix(a, b, f) {
    const pa = hex(a), pb = hex(b);
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * f);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * f);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * f);
    return "rgb(" + r + "," + g + "," + bl + ")";
  }

  function hex(c) {
    const s = String(c || "").replace("#", "");
    const n = parseInt(s.length === 3
      ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
      : s.slice(0, 6), 16);
    if (!Number.isFinite(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Where a count sits on the ramp. LOG scale: the counts run 1..928, so
  // a linear ramp would flatten everything but the largest ten.
  function countT(count, max) {
    const n = Math.max(0, Number(count) || 0);
    const m = Math.max(1, Number(max) || state.maxCount || 1);
    return Math.log(1 + n) / Math.log(1 + m);
  }

  function gradientCss() {
    return "linear-gradient(90deg," + RAMP.map((s) =>
      s.c + " " + Math.round(s.t * 100) + "%").join(",") + ")";
  }

  // ── styling ──────────────────────────────────────────────────────────
  function styleFor(feature) {
    const p = (feature && feature.properties) || {};
    const fill = colourAt(countT(p.count, state.maxCount));
    return {
      color: "#dbeafe",
      weight: 0.6,
      opacity: 0.55 * state.opacity,
      fillColor: fill,
      fillOpacity: 0.62 * state.opacity,
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
  // Ray casting on the raw GeoJSON rings, exactly like the basins layer.
  // The polygons themselves are not interactive, so this is how the probe
  // finds the country under a click — and how the Hover HUD samples.
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

  // The bounding box of a geometry, cached per feature.
  function bboxOf(geometry) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === "number") {
        if (c[0] < x0) x0 = c[0];
        if (c[0] > x1) x1 = c[0];
        if (c[1] < y0) y0 = c[1];
        if (c[1] > y1) y1 = c[1];
        return;
      }
      for (const part of c) walk(part);
    };
    walk(geometry.coordinates || []);
    return [x0, y0, x1, y1];
  }

  // The country under a point, or null.
  function regionAt(lng, lat) {
    const feats = (state.features && state.features.features) || [];
    const boxes = state.boxes;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const g = f.geometry;
      if (!g) continue;
      if (boxes) {
        const b = boxes[i];
        if (!b || lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      }
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
  // meta.json is a few kilobytes; the GeoJSON is 1.5 MB, so the legend
  // mounts on meta alone and the polygons only fetch when the layer is
  // actually switched on.
  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = fetch(META_URL, { cache: "default" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        state.meta = m;
        state.metaPromise = null;
        if (m) mountLegend();
        return m;
      })
      .catch((e) => {
        state.metaPromise = null;
        warn("[lang-regions] meta load failed", e);
        return null;
      });
    return state.metaPromise;
  }

  function ensureData() {
    if (state.features) return Promise.resolve(state.features);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = fetch(REGIONS_URL, { cache: "default" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((fc) => {
        const feats = fc.features || [];
        state.features = fc;
        state.boxes = feats.map((f) => bboxOf(f.geometry || {}));
        let max = 0;
        for (const f of feats) {
          const n = Number((f.properties || {}).count) || 0;
          if (n > max) max = n;
        }
        state.maxCount = max;
        state.loadPromise = null;
        log("[lang-regions] loaded", feats.length, "regions, max",
            max, "languages");
        return fc;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[lang-regions] load failed", e);
        throw e;
      });
    return state.loadPromise;
  }

  // ── the overlay layer ────────────────────────────────────────────────
  function ensurePane(map) {
    if (map.getPane(PANE)) return;
    map.createPane(PANE);
    const pane = map.getPane(PANE);
    pane.style.zIndex = String(PANE_Z);
    // A country is a backdrop, not something you click on.
    pane.style.pointerEvents = "none";
  }

  function buildLayer() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    return L.geoJSON(null, {
      pane: PANE,
      style: (ft) => styleFor(ft),
      interactive: false,
      // CC BY-SA 4.0 REQUIRES attribution. Leaflet's attribution control
      // reads options.attribution off any layer (L.Layer.getAttribution)
      // and prints it in the bottom-right corner. Natural Earth is
      // public domain, Glottolog is not — so both are named.
      attribution: "Glottolog (CC BY-SA 4.0) · Natural Earth (public domain)",
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

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:lang-regions-change",
        { detail: { enabled: state.enabled } }));
    } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  // Mounted into the layers dropdown, as a SIBLING of the overlay list —
  // Leaflet empties and rebuilds .leaflet-control-layers-overlays on every
  // layer change, so a row inside that list is wiped.
  function mountLegend() {
    if (state.legendMounted) return true;
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!list) return false;
    const old = document.getElementById("lang-regions-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "lang-regions-legend";
    host.className = "lang-regions-legend leaflet-control-layers-langregions";
    const regions = (state.meta && state.meta.regions) || {};
    const n = regions.region_count || 234;
    const max = regions.max_count || state.maxCount || 928;
    // Legend ticks on the LOG scale the ramp uses, so the bar and the
    // numbers agree.
    const ticks = [1, 10, 100, 1000].filter((t) => t <= max);
    if (ticks[ticks.length - 1] !== max) ticks.push(max);
    const tickHtml = ticks.map((t) => {
      const pos = Math.round(countT(t, max) * 100);
      return '<span class="langregions-legend-tick" style="left:' + pos + '%">' +
        t.toLocaleString() + "</span>";
    }).join("");

    host.innerHTML =
      '<div class="langregions-legend-title"><span>Language regions</span>' +
      '<button type="button" class="langregions-probe-toggle" ' +
      'id="ctrl-lang-regions-probe-toggle" aria-pressed="false">Probe</button></div>' +
      `<div class="langregions-legend-sub">${Number(n).toLocaleString()} countries · ` +
      "colour = Glottolog languages spoken</div>" +
      '<div class="langregions-legend-scale">' +
      `<div class="langregions-legend-bar" style="background:${gradientCss()}"></div>` +
      `<div class="langregions-legend-ticks">${tickHtml}</div></div>` +
      '<div class="langregions-legend-foot">Tap Probe, then tap a country to list its languages</div>';

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

    const probeBtn = host.querySelector("#ctrl-lang-regions-probe-toggle");
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
    return true;
  }

  // ── probe ────────────────────────────────────────────────────────────
  function showProbe(f, latlng) {
    if (!f) { hideProbe(); return; }
    const p = f.properties || {};
    const langs = p.languages || [];
    const total = Number(p.languages_total != null ? p.languages_total : p.count) || langs.length;
    const rows = langs.slice(0, PROBE_ROWS).map((lg) => {
      const bits = [];
      if (lg.iso) bits.push(escapeHtml(lg.iso));
      bits.push(escapeHtml(lg.level || "language"));
      if (lg.macroarea) bits.push(escapeHtml(lg.macroarea));
      return (
        '<div class="langregions-probe-row">' +
        `<span class="langregions-probe-name">${escapeHtml(lg.name)}</span>` +
        `<span class="langregions-probe-meta">${bits.join(" · ")}</span>` +
        "</div>"
      );
    }).join("");
    const more = total > langs.length || langs.length > PROBE_ROWS
      ? `<div class="langregions-probe-more">+${Math.max(0, total - Math.min(langs.length, PROBE_ROWS))} more in this region</div>`
      : "";
    const head = `<div class="langregions-probe-head">${escapeHtml(p.name || "Unknown region")} · ` +
      `${total.toLocaleString()} language${total === 1 ? "" : "s"}</div>`;
    const html = `<div class="langregions-probe">${head}${rows}${more}</div>`;
    if (state.probeMarker && state.map) {
      state.probeMarker.setLatLng(latlng).setPopupContent(html).openPopup();
    }
  }

  function hideProbe() {
    if (state.probeMarker && state.map && state.map.hasLayer(state.probeMarker)) {
      state.map.removeLayer(state.probeMarker);
    }
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";
    ensureMeta();

    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });

    // The probe listens on the map's own click event, so the polygons
    // never have to become interactive.
    map.on("click", (e) => {
      if (!state.enabled || !state.probeMode) return;
      const f = regionAt(e.latlng.lng, e.latlng.lat);
      if (!f) { hideProbe(); return; }
      if (!state.probeMarker) {
        state.probeMarker = L.marker(e.latlng, {
          interactive: false,
          icon: L.divIcon({ className: "langregions-probe-marker", html: "", iconSize: [0, 0] }),
          zIndexOffset: 1000,
        }).addTo(map);
      }
      state.probeMarker.setLatLng(e.latlng);
      showProbe(f, e.latlng);
    });
  }

  // The probe owns the click ONLY while it is armed — otherwise the
  // click-to-submit flow must reach the map.
  function blocksClick() {
    return state.probeMode;
  }

  // ── HUD sampling ─────────────────────────────────────────────────────
  // The country under the cursor and how many languages are spoken in
  // it. The bounding-box pre-filter keeps this cheap: only the few
  // countries that can contain the cursor are ray-cast.
  function sampleAt(latlng) {
    if (!state.enabled || !state.features) return null;
    const lat = latlng && Number(latlng.lat);
    const lng = latlng && Number(latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const f = regionAt(lng, lat);
    if (!f) return null;
    const p = f.properties || {};
    const n = Number(p.count) || 0;
    return (p.name || "unknown") + " — " + n.toLocaleString() +
      (n === 1 ? " language" : " languages");
  }

  // ── export surface ───────────────────────────────────────────────────
  // The country regions as polygons.
  //
  // LICENCE NOTE: Glottolog is CC BY-SA 4.0, so a derivative carries the
  // same ShareAlike terms. Natural Earth is public domain.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "language-regions",
      z: 363,   // the map pane order — the export draws in it too
      label: "🌍 Language regions",
      kind: "vector",
      attribution: "Glottolog — Max Planck Institute for Geoanthropology; Natural Earth (public domain)",
      licence: "CC BY-SA 4.0 (Glottolog) · Public domain (Natural Earth)",
      source: "https://glottolog.org/",
      style: { stroke: "#dbeafe", fill: "#1f9fc4", width: 0.6, opacity: 0.75 },
      isActive: () => !!state.features,
      async features() {
        const fc = state.features;
        if (!fc) return { type: "FeatureCollection", features: [] };
        return { type: "FeatureCollection", features: (fc.features || []).slice() };
      },
    });
  }

  window.LanguagesRegionsLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    get enabled() { return state.enabled; },
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    mountLegend: mountLegend,
    sampleAt: sampleAt,
    LAYER_NAME: "🌍 Language regions",
    registerExport,
    _state: state,
    _styleFor: styleFor,
    _regionAt: regionAt,
    _pointInPolygon: pointInPolygon,
    _countT: countT,
    _colourAt: colourAt,
  };

  registerExport();
})();
