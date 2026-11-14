/* ═══════════════════════════════════════════════════════════════════════
   Rivers overlay for the Xyzo map — Natural Earth 10m lake centerlines.

   Source: Natural Earth 10m Rivers + Lake Centerlines (public domain)
     https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-rivers-lake-centerlines/

   scripts/river_build.py writes:

     /data/rivers/rivers.geojson   every line, name + scale rank + min_zoom
     /data/rivers/meta.json        rank stroke styles + attribution

   The layer is a GeoJSON FeatureGroup in its own pane. Features are
   filtered by Natural Earth's `min_zoom` (rank-1 arteries always show,
   rank-9 creeks only at street zoom) and styled by `scalerank`. Labels
   appear for rank ≤ 4 named rivers once the map is zoomed in enough
   that the label will not collide with everything else.

   The GeoJSON is loaded once and cached; the same FeatureGroup is
   re-styled on zoomend so stroke widths stay readable without
   refetching.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/rivers";
  const BUILD = "202610271";
  const GEOJSON_URL = BASE + "/rivers.geojson?v=" + BUILD;
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  const PANE = "riverPane";
  const PANE_Z = 365;
  const STORE_KEY = "xyzo.riverLayer";

  // Fallback if meta.json is missing — same table scripts/river_build.py
  // writes, so a client that loads before the data lands still draws.
  // Every rank is on by zoom 6: the drainage network reads as a network.
  const FALLBACK_RANK = {
    1: { width: 3.2, color: "#3b82f6", minZoom: 0 },
    2: { width: 2.6, color: "#3b82f6", minZoom: 0 },
    3: { width: 2.1, color: "#4a90e2", minZoom: 1 },
    4: { width: 1.7, color: "#4a90e2", minZoom: 2 },
    5: { width: 1.4, color: "#5b9bd5", minZoom: 3 },
    6: { width: 1.1, color: "#5b9bd5", minZoom: 4 },
    7: { width: 0.9, color: "#6aa8e8", minZoom: 4 },
    8: { width: 0.7, color: "#6aa8e8", minZoom: 5 },
    9: { width: 0.6, color: "#7ab3ef", minZoom: 5 },
    10: { width: 0.5, color: "#7ab3ef", minZoom: 6 },
    11: { width: 0.5, color: "#8abaf1", minZoom: 6 },
    12: { width: 0.5, color: "#8abaf1", minZoom: 6 },
  };
  const FALLBACK_LABEL_RANK = 4;

  // ── the RIVER NAMES switch ──────────────────────────────────────────
  //
  // Owner ask 2026-11-08: *"not to show any labels if the user doesn't
  // want to see them.. it might already be that way.. so default it
  // without labels"* — and the FAO layer's names turned out to be the
  // reason (they are BASIN names: the 2026 network carries no name on
  // a reach, and the classic layer it borrows them from has none
  // either — only `maj_name` / `sub_name`).
  //
  // This layer's names are the good kind (Natural Earth names its
  // rivers properly), but the RULE is the same and it is the rule the
  // reader asked for: **a name is an option, not the price of
  // admission.** So both river layers now offer the same switch, and
  // both start with the names OFF.
  //
  // The choice is REMEMBERED (`xyzo.rivers.labels`), so this is a
  // default and not a removal — a reader who ticks the box keeps the
  // names on every visit.
  const STORE_LABELS = "xyzo.rivers.labels";

  const state = {
    map: null,
    layer: null,          // L.geoJSON FeatureGroup
    enabled: false,
    probeMode: false,
    meta: null,
    features: null,       // raw FeatureCollection
    labelsLayer: null,    // L.layerGroup of tooltips
    labelsOn: false,      // the names are OFF until the reader asks
    legendMounted: false,
    loadPromise: null,
    lastZoom: null,
    opacity: 0.85,
  };

  // ── helpers ──────────────────────────────────────────────────────────
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
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      // Above the isobars (360) and climate washes, below wind (370)
      // and the pin canvas (400). Rivers are the geography users look
      // for under a flood story, so they sit high.
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  function rankStyle(rank) {
    const table = (state.meta && state.meta.rank_style) || FALLBACK_RANK;
    return table[String(rank)] || table[rank] || FALLBACK_RANK[9] || { width: 0.5, color: "#7ab3ef", minZoom: 9 };
  }

  function labelMinRank() {
    return (state.meta && state.meta.label_min_rank != null)
      ? state.meta.label_min_rank : FALLBACK_LABEL_RANK;
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureData() {
    if (state.features) return Promise.resolve(state.features);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.all([
      fetch(META_URL, { cache: "default" }).then((r) => (r.ok ? r.json() : null)),
      fetch(GEOJSON_URL, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
    ])
      .then(([meta, fc]) => {
        state.meta = meta;
        state.features = fc;
        state.loadPromise = null;
        const n = (fc.features || []).length;
        log("[rivers] loaded", n, "lines");
        return fc;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[rivers] load failed", e);
        throw e;
      });
    return state.loadPromise;
  }

  // ── styling ──────────────────────────────────────────────────────────
  function styleFor(feature, zoom) {
    const rank = (feature.properties && feature.properties.scalerank) || 9;
    const s = rankStyle(rank);
    const visible = zoom >= (s.minZoom || 0);
    return {
      color: s.color,
      weight: Math.max(0.4, (s.width || 1) * (zoom >= 8 ? 1.15 : 1)),
      opacity: visible ? 0.9 * state.opacity : 0,
      interactive: false,
    };
  }

  function restyle(zoom) {
    if (!state.layer) return;
    state.layer.eachLayer((ly) => {
      const ft = ly.feature;
      if (!ft) return;
      const st = styleFor(ft, zoom);
      if (typeof ly.setStyle === "function") ly.setStyle(st);
    });
    updateLabels(zoom);
  }

  // ── labels ───────────────────────────────────────────────────────────
  // Mid-segment anchors for named major rivers. ONE LABEL PER RIVER
  // NAME, placed at a vertex roughly a third along the longest line so
  // the callout does not sit on a headwater or a mouth.
  //
  // "One per FEATURE" (what this did until 2026-11-01) is wrong because
  // Natural Earth SPLITs a single river into several features — the
  // Benue arrives as two, so the map drew "Benue" twice, 43 px apart,
  // and users read it as a glitch ("benue benue", reported live). At
  // the same view 11 names were doubled and 20 of the 40 label slots
  // were spent on anchors that were not even on screen.
  function anchorOf(feature) {
    const geom = feature.geometry;
    if (!geom) return null;
    let line = null;
    if (geom.type === "LineString") line = geom.coordinates;
    else if (geom.type === "MultiLineString" && geom.coordinates && geom.coordinates.length) {
      line = geom.coordinates.reduce((a, b) => (b.length > a.length ? b : a), geom.coordinates[0]);
    }
    if (!line || line.length < 2) return null;
    const i = Math.floor(line.length / 3);
    const pt = line[i] || line[0];
    return [pt[1], pt[0]];   // Leaflet wants [lat, lng]
  }

  // Vertex count = the proxy for "the longest stem of this river". The
  // pieces Natural Earth splits a river into differ in length, and the
  // label belongs on the biggest one, not on a tributary fragment.
  function countVertices(feature) {
    const geom = feature && feature.geometry;
    if (!geom || !geom.coordinates) return 0;
    if (geom.type === "LineString") return geom.coordinates.length;
    if (geom.type === "MultiLineString") {
      return geom.coordinates.reduce((n, line) => n + (line ? line.length : 0), 0);
    }
    return 0;
  }

  // Two label callouts closer together than this overlap into one blur.
  // Same-name pairs are already impossible (one label per name); this
  // catches DIFFERENT rivers whose anchors nearly coincide — Paraná and
  // Paranaíba join, so their anchors sat 42 px apart and the two words
  // collided.
  const LABEL_MIN_GAP_PX = 70;
  const MAX_LABELS = 40;

  /**
   * Pure label selection — the map is the only thing it cannot have, so
   * the tests drive it directly (`_chooseLabels`).
   *
   *   features    GeoJSON features
   *   opts.zoom   current zoom (the rank gate: rank > zoom+2 is hidden)
   *   opts.minRank  the layer's label rank cutoff
   *   opts.contains(latlng)  the padded viewport test
   *   opts.toContainerPoint(latlng)  for the screen-space gap
   *
   * Returns [{ name, anchor, rank }] — at most ONE entry per river name.
   */
  function chooseLabels(features, opts) {
    const zoom = opts.zoom;
    const minRank = opts.minRank;
    const contains = opts.contains;
    const toPoint = opts.toContainerPoint;

    // One candidate per NAME. Same rank gate as before, plus on-screen.
    const byName = new Map();
    for (const f of features || []) {
      const p = f.properties || {};
      const rank = p.scalerank || 9;
      if (rank > minRank) continue;
      if (rank > (zoom + 2)) continue;
      const name = p.label || p.name_en || p.name;
      if (!name) continue;
      const anchor = anchorOf(f);
      if (!anchor) continue;
      if (contains && !contains(anchor)) continue;
      const verts = countVertices(f);
      const cur = byName.get(name);
      if (!cur || verts > cur.verts) byName.set(name, { name, rank, anchor, verts });
    }

    // Priority: the most important river first (rank asc), the longest
    // stem breaking ties. Greedy placement in that order means a name
    // that loses a slot to a collision is a LESS important river, never
    // an arbitrary one.
    const candidates = Array.from(byName.values())
      .sort((a, b) => a.rank - b.rank || b.verts - a.verts);

    const out = [];
    for (const c of candidates) {
      if (out.length >= MAX_LABELS) break;
      const pt = toPoint(c.anchor);
      let clash = false;
      for (const q of out) {
        const dx = pt.x - q.pt.x, dy = pt.y - q.pt.y;
        if (dx * dx + dy * dy < LABEL_MIN_GAP_PX * LABEL_MIN_GAP_PX) { clash = true; break; }
      }
      if (clash) continue;
      out.push({ name: c.name, anchor: c.anchor, rank: c.rank, pt });
    }
    return out.map(({ name, anchor, rank }) => ({ name, anchor, rank }));
  }

  function updateLabels(zoom) {
    if (!state.map || !state.features) return;
    if (!state.labelsLayer) {
      state.labelsLayer = L.layerGroup();
      if (state.enabled && state.map) state.labelsLayer.addTo(state.map);
    }
    state.labelsLayer.clearLayers();
    // Labels only once the map is detailed enough that a name has room —
    // and only when the reader has asked for them.
    if (!state.enabled || !state.labelsOn || zoom < 4) return;
    const map = state.map;

    // Placement is VIEWPORT-DEPENDENT (only on-screen rivers are worth a
    // slot), so the bounds are part of the input. Padded a little so a
    // river just entering the view gets labelled before the user can
    // read the empty edge.
    const bounds = map.getBounds().pad(0.1);

    const chosen = chooseLabels(state.features.features, {
      zoom,
      minRank: labelMinRank(),
      contains: (ll) => bounds.contains(ll),
      toContainerPoint: (ll) => map.latLngToContainerPoint(ll),
    });

    for (const c of chosen) {
      L.tooltip({
        permanent: true,
        direction: "center",
        className: "river-label",
        opacity: 0.9,
      })
        .setContent(c.name)
        .setLatLng(c.anchor)
        .addTo(state.labelsLayer);
    }
  }

  // ── the overlay layer ────────────────────────────────────────────────
  function buildLayer() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    const group = L.geoJSON(null, {
      pane: PANE,
      style: (ft) => styleFor(ft, state.map ? state.map.getZoom() : 3),
      interactive: false,
      // Natural Earth is public domain, so this is a courtesy rather
      // than a licence obligation — but the attribution belongs on the
      // map, not only in the builder's source comment.
      attribution: "Natural Earth (public domain)",
    });
    return group;
  }

  function getTileLayer() {
    // The layers control accepts any Layer — but OverlayOpacity.mount
    // calls setOpacity() on every entry in WEATHER_OVERLAYS, and a raw
    // L.geoJSON has no such method (it threw and aborted the rest of
    // app.js, which then hit the pinMarkers TDZ). Attach the pair here
    // so the GeoJSON group satisfies the same contract as a TileLayer.
    if (!state.layer) {
      state.layer = buildLayer();
      state.layer.setOpacity = (v) => setOpacity(v);
      state.layer.getOpacity = () => getOpacity();
    }
    return state.layer;
  }

  function fillLayer() {
    if (!state.layer || !state.features) return;
    // L.geoJSON(null) then addData is the supported path.
    state.layer.clearLayers();
    state.layer.addData(state.features);
    if (state.map) restyle(state.map.getZoom());
  }

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData().then(() => {
        fillLayer();
        if (state.labelsLayer && state.map) state.labelsLayer.addTo(state.map);
        if (state.map) updateLabels(state.map.getZoom());
      }).catch(() => {});
    } else {
      if (state.labelsLayer && state.map && state.map.hasLayer(state.labelsLayer)) {
        state.map.removeLayer(state.labelsLayer);
      }
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
    if (state.map && state.enabled) restyle(state.map.getZoom());
  }

  function getOpacity() { return state.opacity; }

  // ── the names switch ────────────────────────────────────────────────
  function setLabelsOn(on) {
    const want = !!on;
    state.labelsOn = want;
    storageSet(STORE_LABELS, want ? "1" : "0");
    if (state.map && state.enabled) updateLabels(state.map.getZoom());
    refreshLegend();
    notifyChange();
    return want;
  }

  function getLabelsOn() { return state.labelsOn; }

  // The legend: a "River names" switch, mounted into the layers
  // dropdown — the one place a layer's own options live.
  //
  // It is RETRIED until the control exists: app.js creates the layers
  // control AFTER the layer modules initialise, so a legend that gave up
  // on the first miss would never appear (the climate / soil / FAO
  // rivers pattern).
  function refreshLegend() {
    if (typeof document === "undefined") return;
    const box = document.getElementById("ctrl-rivers-labels");
    if (box) box.checked = !!state.labelsOn;
  }

  function mountLegendIntoLayersControl() {
    if (typeof document === "undefined") return false;
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;
    const old = document.getElementById("rivers-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "rivers-legend";
    host.className = "temp-legend leaflet-control-layers-temp";
    host.innerHTML =
      '<div class="temp-legend-title"><span>💧 Rivers</span></div>' +
      '<label class="mag-wash-row"><input type="checkbox" id="ctrl-rivers-labels"> River names</label>' +
      '<div class="temp-legend-detail">The names are Natural Earth\'s own, and they are off until you ask for them.</div>';
    section.appendChild(host);
    state.legendMounted = true;

    const box = host.querySelector("#ctrl-rivers-labels");
    if (box) {
      box.addEventListener("change", () => setLabelsOn(box.checked));
    }
    refreshLegend();
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

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("xyzo:river-change", { detail: { enabled: state.enabled } })); } catch (_) {}
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    // The reader's own choice about the names (OFF until they ask).
    state.labelsOn = storageGet(STORE_LABELS, "0") !== "0";
    waitForLayersControl();

    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });
    map.on("zoomend", () => {
      if (state.enabled) restyle(map.getZoom());
    });
    // Labels are now placed for ON-SCREEN rivers only (a slot spent on
    // an off-screen anchor is a slot a visible river never gets), so a
    // PAN changes which names deserve one — re-place after the view
    // settles. Throttled because a drag fires moveend once per gesture
    // but animated pans and `fitBounds` can chain several.
    let labelTimer = null;
    map.on("moveend", () => {
      if (!state.enabled) return;
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => {
        labelTimer = null;
        updateLabels(map.getZoom());
      }, 150);
    });
  }

  function blocksClick() {
    return false;   // rivers never swallow a map click
  }

  // HUD sampling ("Everything" mode) — the nearest NAMED river within
  // ~0.35° (≈ 38 km). Beyond that the reading would be a guess, so it
  // returns null rather than naming a river on the far side of a
  // continent. SEGMENT distance, not vertex distance: a cursor in the
  // middle of a long river segment is far from every vertex, and a
  // vertex scan would miss the river running right under it.
  function sampleAt(latlng) {
    if (!state.enabled || !state.features) return null;
    const lat = latlng && Number(latlng.lat);
    const lng0 = latlng && Number(latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng0)) return null;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const px = lng0 * cosLat;
    const py = lat;
    const MAX_D2 = 0.35 * 0.35;
    let best = null;
    const feats = state.features.features || [];
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      const props = f.properties || {};
      const name = props.name_en || props.name;
      if (!name) continue;
      const g = f.geometry;
      if (!g || !g.coordinates) continue;
      const lines = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line || line.length < 1) continue;
        let d2 = Infinity;
        if (line.length === 1) {
          const ex = Number(line[0][0]) * cosLat - px;
          const ey = Number(line[0][1]) - py;
          d2 = ex * ex + ey * ey;
        } else {
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1];
            const b = line[i];
            const ax = Number(a[0]) * cosLat, ay = Number(a[1]);
            const bx = Number(b[0]) * cosLat, by = Number(b[1]);
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
            const d = ex * ex + ey * ey;
            if (d < d2) d2 = d;
          }
        }
        if (d2 <= MAX_D2 && (!best || d2 < best.d2)) best = { d2, name };
      }
    }
    if (!best) return null;
    const km = Math.round(Math.sqrt(best.d2) * 111);
    return best.name + (km >= 1 ? " · " + km + " km" : "");
  }

  // ── public API ───────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // The rivers as vector features — Natural Earth lake centrelines, with
  // their own scalerank so a GIS user can filter the big rivers from
  // the creeks.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "rivers",
      z: 365,   // the map pane order — the export draws in it too
      label: "💧 Rivers",
      kind: "vector",
      attribution: "Natural Earth — 10m Rivers + Lake Centerlines",
      licence: "Public domain",
      source: "https://www.naturalearthdata.com/downloads/10m-physical-vectors/",
      style: { stroke: "#38bdf8", width: 1, opacity: 0.9 },
      isActive: () => !!state.features,
      async features() {
        const fc = state.features;
        if (!fc) return { type: "FeatureCollection", features: [] };
        return { type: "FeatureCollection", features: (fc.features || []).slice() };
      },
    });
  }


  window.RiverLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    setLabelsOn: setLabelsOn,
    getLabelsOn: () => state.labelsOn,
    blocksClick: blocksClick,
    sampleAt,
    LAYER_NAME: "💧 Rivers",
    registerExport,
    _state: state,
    _styleFor: styleFor,
    _rankStyle: rankStyle,
    _anchorOf: anchorOf,
    _chooseLabels: chooseLabels,
  };

  registerExport();
})();
