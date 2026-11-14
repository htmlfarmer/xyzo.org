/* ═══════════════════════════════════════════════════════════════════════
   Population density overlay — WorldPop Global 2 (1 km).

   Source: WorldPop, University of Southampton — "Human Population
   Density, Global2" (R2025A v1), 2015–2030 annual, 30 arc-second
   (~1 km) cells, people per km², nodata -99999.
   https://www.worldpop.org · DOI 10.5258/SOTON/WP00845
   **CC BY 4.0** — attribution only (row in docs/DATA_LICENSES.md).

   WHY THIS IS HOTLINKED RATHER THAN BAKED
   ----------------------------------------
   The published download path is a multi-GB global 1 km raster: a
   faithful z12+ pyramid would be millions of tiles (cropland, at 10 m
   but only z9, is already 92,066 tiles / 605 MB). FAO publishes the same
   data as a WMTS, and a WMTS GetTile IS an XYZ template — so Leaflet
   reads it directly, we store nothing, and the 1 km detail is available
   at every zoom the service offers. Same trade NASA GIBS and Macrostrat
   already made for their overlays.

   THE PUBLISHED CATALOGUE URL IS WRONG IN TWO WAYS. Verified by asking
   the service itself:

     • tilematrixset=EPSG:900913  -> HTTP 400, the catalogue's value is
       not in the service's list. The working name is **WebMercatorQuad**
       (Leaflet's own grid).
     • no style parameter          -> HTTP 400
       `Missing 'GetTile' parameters: {'style'}`. WMTS always requires
       one; the catalogue omits it. `style=default` is correct.

   Both errors are fast, deterministic and readable — worth recording,
   because the obvious thing is to trust the published URL and conclude
   the service is dead. It is alive: 200 across z0–z15.

   THE TILES ARE PRE-COLOURED BY FAO (blue → purple → warm), so this
   overlay does NOT take part in the per-overlay palette picker — we hold
   no values, only a picture. That is the price of not shipping a
   multi-GB pyramid, and it is the same reason the layer exposes no
   sampleAt()/export surface.

   Latency is ~1.5–2 s per tile cold, so the layer asks Leaflet to fetch
   when idle rather than on every pan frame.

   Tiles are hotlinked, not written under public_html/data/ — no BUILD
   token, no Caddy immutable-cache trap.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Served through OUR OWN mirror — see api/src/routes/tileMirror.ts.
  // The whole WMTS query is fixed server-side (layer, matrix set, style
  // and the TileRow/TileCol order the catalogue actually wants), the
  // copy is revalidated against FAO every 7 days, and no file extension
  // rides in the URL because Caddy stamps `*.png` with a year of
  // `immutable`.
  const WMTS_URL = "/api/tile/mirror/worldpop/{z}/{x}/{y}";

  const PANE = "populationPane";
  // 349: above the physical washes (relief 345, wave 346, ivt 347, cape
  // 348), below climate 350. It is demographic context rather than
  // weather, so it sits low in the stack and never covers a physical
  // field. 349 was a free slot — see AGENTS.md "Overlay Pane Stack".
  const PANE_Z = 349;
  const STORE_KEY = "xyzo.populationLayer";
  // FAO serves PRE-COLOURED tiles, so there is no ramp to rewrite — the
  // colour style is a CSS filter on the pane instead (see setFilter).
  const FILTER_STORE_KEY = "xyzo.populationFilter";

  // NO MINIMUM ZOOM. I originally gated this at 6 on the reasoning that
  // a 1 km cell is sub-pixel below z12 and would smear — that was wrong,
  // and the correction matters: the WMTS renders EACH TILE at its own
  // 256 px, so a z2 tile is a correctly downsampled global view, not a
  // per-pixel average of nothing. Probed: z1 18.7 KB / 4,687 opaque px,
  // z2 45.9 KB / 13,824, z4 62.7 KB / 19,228 — real content at every
  // level, which is what makes the low-zoom global distribution (the
  // thing most people open this layer for) worth having. A gate here
  // also made the checkbox lie: checked, but blank, at z4.
  const MIN_ZOOM = 0;
  // The service answers z0–z15 (probed). Beyond 15 Leaflet upscales,
  // which is right: the data stays 1 km whatever the screen asks for.
  const MAX_NATIVE_ZOOM = 15;

  const state = {
    map: null,
    layer: null,
    enabled: false,
    opacity: 1,
    filter: "none",
  };

  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch (_) {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (_) {}
  }

  function ensurePane(map) {
    let pane = map.getPane(PANE);
    if (!pane) {
      map.createPane(PANE);
      pane = map.getPane(PANE);
      pane.style.zIndex = String(PANE_Z);
      // A wash must never swallow the click-to-submit gesture.
      pane.style.pointerEvents = "none";
    }
    // Re-apply the colour style EVERY time, not only when the pane is
    // first created: the layers dropdown rebuilds its rows, and a pane
    // that survived a layer toggle would otherwise keep the old filter
    // while the select in the rebuilt row showed the new one.
    applyFilterToPane(map);
  }

  function applyFilterToPane(map) {
    const R = window.RampStyles;
    const pane = map && map.getPane(PANE);
    if (!pane) return;
    const spec = R && R.FILTER_STYLES ? R.FILTER_STYLES[state.filter] : null;
    pane.style.filter = spec ? spec.css : "";
  }

  // ── colour style ──────────────────────────────────────────────────────
  // FAO's tiles are pre-coloured, so unlike the value overlays there is
  // no ramp to rewrite — the style is a filter on the pane. It is a real
  // colour change, but it is NOT a value-mapped rainbow: that would need
  // the raw grid, i.e. the multi-GB download this layer exists to avoid.
  // The picker's own labels say "Hue shift" rather than "Rainbow" for
  // that reason.
  function setFilter(name) {
    const R = window.RampStyles;
    if (!R || !R.FILTER_STYLES || !R.FILTER_STYLES[name]) return false;
    state.filter = name;
    storageSet(FILTER_STORE_KEY, name);
    applyFilterToPane(state.map);
    return true;
  }
  function getFilter() {
    return state.filter;
  }

  function buildLayer() {
    if (!window.L) return null;
    const layer = L.tileLayer(WMTS_URL, {
      pane: PANE,
      minZoom: MIN_ZOOM,
      maxZoom: 18,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      // ~2 s a tile: fetch when the pan settles instead of every frame,
      // so dragging does not leave a queue of doomed requests behind.
      updateWhenIdle: true,
      keepBuffer: 1,
      attribution:
        'Population density: <a href="https://www.worldpop.org/" target="_blank" ' +
        'rel="noopener noreferrer">WorldPop</a>, University of Southampton — ' +
        'CC BY 4.0',
    });

    // Keep `state.opacity` truthful.
    //
    // OverlayOpacity mounts the slider by calling setOpacity() on the
    // object sitting in WEATHER_OVERLAYS — which is THIS TileLayer, not
    // window.PopulationLayer. Without this wrapper the layer visibly
    // faded while PopulationLayer.getOpacity() kept returning 1, so two
    // sources of truth disagreed: anything reading the module (the URL
    // hash, a later restore, a test) saw the pre-slider value.
    const leafletSetOpacity = layer.setOpacity;
    layer.setOpacity = function (v) {
      state.opacity = Math.max(0, Math.min(1, Number(v) || 0));
      return leafletSetOpacity.call(this, state.opacity);
    };
    // Same reason as setOpacity above: the palette picker is handed THIS
    // TileLayer (WEATHER_OVERLAYS holds it), never window.PopulationLayer.
    layer.setFilter = (n) => setFilter(n);
    layer.getFilter = () => state.filter;
    return layer;
  }

  function getTileLayer() {
    if (!state.layer) state.layer = buildLayer();
    return state.layer;
  }

  function isEnabled() {
    return !!state.enabled;
  }

  function setEnabled(on) {
    const want = !!on;
    state.enabled = want;
    storageSet(STORE_KEY, want ? "1" : "0");
    const layer = getTileLayer();
    if (!state.map || !layer) return Promise.resolve(want);
    if (want) {
      if (!state.map.hasLayer(layer)) layer.addTo(state.map);
    } else if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
    }
    return Promise.resolve(state.map.hasLayer(layer));
  }

  function setOpacity(v) {
    const o = Math.max(0, Math.min(1, Number(v) || 0));
    state.opacity = o;
    if (state.layer && typeof state.layer.setOpacity === "function") {
      state.layer.setOpacity(o);
    }
  }
  function getOpacity() {
    return state.opacity;
  }

  // Never swallows a click: there is no probe (the tiles carry no
  // readable value — see the header) and nothing to arm.
  function blocksClick() {
    return false;
  }

  function notifyChange() {
    try {
      if (typeof window.updateUrlHash === "function") window.updateUrlHash();
    } catch (_) {}
  }

  function init(map) {
    if (!map || state.map) return;
    state.map = map;
    state.filter = storageGet(FILTER_STORE_KEY, "none");
    ensurePane(map);

    // Listeners BEFORE the restore below. `overlayadd` is fired by the
    // layers control, which does not exist yet at init time — waiting
    // for it leaves state.enabled false while the checkbox looks checked
    // (the "checkbox on, layer missing" class of bug the magnetic layer
    // shipped with).
    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) {
        state.enabled = true;
        notifyChange();
      }
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) {
        state.enabled = false;
        notifyChange();
      }
    });

    if (storageGet(STORE_KEY, "0") === "1") {
      const layer = getTileLayer();
      try {
        if (layer && !map.hasLayer(layer)) layer.addTo(map);
      } catch (_) {}
      // Flip DIRECTLY: the layers control does not exist yet, so there
      // is no overlayadd to catch.
      state.enabled = !!(state.layer && map.hasLayer(state.layer));
    }
  }

  window.PopulationLayer = {
    init,
    getTileLayer,
    setEnabled,
    isEnabled,
    setOpacity,
    getOpacity,
    setFilter,
    getFilter,
    blocksClick,
    LAYER_NAME: "🧍 Population density (WorldPop, 1 km)",
    MIN_ZOOM,
    _state: state,
    _url: WMTS_URL,
  };
})();
