/* ═══════════════════════════════════════════════════════════════════════
   Tectonic faults & plate boundaries overlay for the Xyzo map.

   TWO SOURCES, TWO LICENCES
   ─────────────────────────
   scripts/faults_build.py writes:

     /data/faults/faults.geojson       USGS — public domain
       • the global tectonic plate boundaries (transform / divergent /
         convergent interfaces and the micro-plate fault zones)
       • the USGS Quaternary Fault and Fold Database: the mapped fault
         traces of the United States, with the age of the most recent
         movement (historic → latest Quaternary → undifferentiated)
     /data/faults/meta.json             counts, colours, the zoom ladder

     /data/gem-faults/gem-faults.geojson  GEM GAF-DB — CC BY-SA 4.0
       • the global active-fault traces. The USGS database covers the
         UNITED STATES only, so without this the overlay would be empty
         over the other six continents.

   The two are kept in separate files on purpose: the USGS half is public
   domain and the GEM half is share-alike, and mixing them would drag the
   ShareAlike term onto the public-domain data.

   WHY THE VIEWPORT FILTER
   ───────────────────────
   There are ~49,000 fault traces. Drawing them all would be a hairball
   at world zoom and a redraw cost the browser cannot afford, so two
   gates apply:

     1. `min_zoom` — the builder assigns each trace the zoom at which it
        is worth showing. It is driven by the LENGTH of the trace and
        adjusted by the AGE of its last movement: a fault that moved in
        the last 150 years appears two zoom levels earlier than a
        Quaternary fault of the same length.
     2. the VIEWPORT — only the traces whose bounding box meets the
        padded viewport are handed to Leaflet at all.

   The second gate is what keeps the layer cheap: at city zoom a few
   hundred traces exist, and the canvas renderer skips the ones outside
   the padded view on every redraw.

   The pane is `pointer-events: none` and every path is
   `interactive: false`, so a fault NEVER swallows a map click.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/faults";
  const GEM_BASE = "/data/gem-faults";
  const BUILD = "202611031";
  const GEOJSON_URL = BASE + "/faults.geojson?v=" + BUILD;
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  const GEM_GEOJSON_URL = GEM_BASE + "/gem-faults.geojson?v=" + BUILD;
  const GEM_META_URL = GEM_BASE + "/meta.json?v=" + BUILD;

  const PANE = "faultPane";
  // 367: above the rivers (365) and the wind-speed wash (366), below the
  // wind animation (370). Fault traces are the structural skeleton under
  // the news, and they must not be buried by a river wash — but they must
  // stay under the wind and, above all, under the pin canvas (400).
  //
  // NOT 366: wind-speed-layer.js took windSpeedPane at 366 (the free-slot
  // list in AGENTS.md predates it).
  const PANE_Z = 367;
  const STORE_KEY = "xyzo.faultLayer";

  // The colour table, mirroring what scripts/faults_build.py writes into
  // meta.json. It is duplicated here so a client that loads before the
  // metadata lands still draws the same picture.
  const FALLBACK_AGE_COLORS = {
    "historic": "#ff4d6d",
    "latest-quaternary": "#ff9f43",
    "late-quaternary": "#ffd166",
    "middle-late-quaternary": "#8ecae6",
    "undifferentiated-quaternary": "#5e8ca8",
    "class-b": "#8b9bb4",
    "unspecified": "#8b9bb4",
  };
  const FALLBACK_PLATE_COLOR = "#ffffff";
  const FALLBACK_SLIP_COLORS = {
    Normal: "#7dd3fc",
    Reverse: "#c4b5fd",
    Dextral: "#5eead4",
    Sinistral: "#5eead4",
    Subduction_Thrust: "#f0abfc",
    Spreading_Ridge: "#86efac",
    Unknown: "#8b9bb4",
  };

  // The age class of a USGS trace, keyed by the raw `age` string the
  // database carries ("latest Quaternary", "historic", …).
  const AGE_CLASS = {
    "historic": "historic",
    "latest quaternary": "latest-quaternary",
    "late quaternary": "late-quaternary",
    "middle and late quaternary": "middle-late-quaternary",
    "undifferentiated quaternary": "undifferentiated-quaternary",
    "class b": "class-b",
  };

  // The GEM slip types that carry a distinct colour. Everything else
  // (the mixed kinematics like "Dextral-Reverse") joins its first
  // component's family.
  const SLIP_FAMILY = {
    normal: "Normal",
    reverse: "Reverse",
    dextral: "Dextral",
    sinistral: "Sinistral",
    subduction_thrust: "Subduction_Thrust",
    spreading_ridge: "Spreading_Ridge",
  };

  // Stroke widths, in CSS pixels, by zoom. A fault trace is a hairline
  // on a satellite basemap at world zoom and a ribbon at street zoom.
  function widthFor(zoom, kind) {
    if (kind === "plate-boundary") {
      return zoom >= 6 ? 2.4 : zoom >= 3 ? 1.8 : 1.4;
    }
    return zoom >= 9 ? 2.4 : zoom >= 6 ? 1.8 : zoom >= 3 ? 1.4 : 1.2;
  }

  // The spatial index cell, in degrees. 2° cells keep the index small
  // (about 9,000 cells for the whole world) while the search radius for
  // the hover probe is a fraction of a degree.
  const CELL = 2;

  const state = {
    map: null,
    layer: null,          // L.geoJSON FeatureGroup
    renderer: null,       // L.canvas renderer — 49,000 SVG paths is not an option
    enabled: false,
    meta: null,
    metaGem: null,
    features: [],         // flat array of prepared features
    grid: null,           // Map<"lon:lat", number[]> — the spatial index
    added: new Map(),     // feature index -> Leaflet layer
    loadPromise: null,
    opacity: 0.9,
    legendMounted: false,
    updateTimer: null,
    pending: false,
  };

  // ── helpers ──────────────────────────────────────────────────────────
  function log(...a) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...a);
  }
  function warn(...a) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...a);
  }
  function error(...a) {
    if (window.XLog && typeof window.XLog.error === "function") window.XLog.error(...a);
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
  function hexToRgb(hex) {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return [255, 255, 255];
    return [
      parseInt(h.slice(0, 2), 16) || 0,
      parseInt(h.slice(2, 4), 16) || 0,
      parseInt(h.slice(4, 6), 16) || 0,
    ];
  }

  // ── the colour of a feature ──────────────────────────────────────────
  function ageClassOf(props) {
    if (!props) return "unspecified";
    if (props.kind === "plate-boundary") return "plate-boundary";
    if (props.kind === "gem-active-fault") return "gem";
    return AGE_CLASS[String(props.age || "").toLowerCase()] || "unspecified";
  }

  function slipFamily(slip) {
    const key = String(slip || "").toLowerCase();
    if (SLIP_FAMILY[key]) return SLIP_FAMILY[key];
    // "Dextral-Reverse" → the family of its first component.
    const first = key.split(/[-_]/)[0];
    return SLIP_FAMILY[first] || "Unknown";
  }

  function colorFor(props) {
    const kind = props && props.kind;
    if (kind === "plate-boundary") {
      const table = (state.meta && state.meta.plate_boundary_colors) || null;
      return (table && table[props.age]) || FALLBACK_PLATE_COLOR;
    }
    if (kind === "gem-active-fault") {
      const table = (state.metaGem && state.metaGem.slip_colors) || null;
      const fam = slipFamily(props.age);
      return (table && table[fam]) || (table && table[props.age]) ||
        FALLBACK_SLIP_COLORS[fam] || FALLBACK_SLIP_COLORS.Unknown;
    }
    const table = (state.meta && state.meta.age_colors) || null;
    const cls = ageClassOf(props);
    return (table && table[cls]) || FALLBACK_AGE_COLORS[cls] ||
      FALLBACK_AGE_COLORS.unspecified;
  }

  // ── styling ──────────────────────────────────────────────────────────
  function styleFor(feature, zoom) {
    const props = (feature && feature.properties) || {};
    const kind = props.kind || "quaternary-fault";
    const visible = zoom >= (props.min_zoom || 0);
    return {
      color: colorFor(props),
      weight: widthFor(zoom, kind),
      opacity: visible ? 0.92 * state.opacity : 0,
      lineCap: "round",
      lineJoin: "round",
      // A fault is scenery, never a control: it must not swallow a click.
      interactive: false,
    };
  }

  function restyle(zoom) {
    if (!state.layer) return;
    state.layer.eachLayer((ly) => {
      const ft = ly.feature;
      if (!ft || typeof ly.setStyle !== "function") return;
      ly.setStyle(styleFor(ft, zoom));
    });
  }

  // ── the prepared features ────────────────────────────────────────────
  // Each feature is flattened once, at load, into what the map actually
  // needs: a style key, a bounding box, a length and a grid cell list.
  // Doing it per frame would be 49,000 objects' worth of work on every
  // mouse move.
  function prepare(fc) {
    const out = [];
    for (const f of fc.features || []) {
      const geom = f.geometry;
      if (!geom || geom.type !== "LineString") continue;
      const coords = geom.coordinates;
      if (!coords || coords.length < 2) continue;
      let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
      let length = 0;
      for (let i = 0; i < coords.length; i++) {
        const lon = Number(coords[i][0]);
        const lat = Number(coords[i][1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (i > 0) {
          const plon = Number(coords[i - 1][0]);
          const plat = Number(coords[i - 1][1]);
          const mid = ((lat + plat) / 2) * Math.PI / 180;
          length += Math.hypot(
            (lon - plon) * 111.32 * Math.cos(mid),
            (lat - plat) * 110.574
          );
        }
      }
      if (!Number.isFinite(length) || length <= 0) continue;
      out.push({
        feature: f,
        props: f.properties || {},
        minLon, maxLon, minLat, maxLat,
        lengthKm: length,
        minZoom: (f.properties && f.properties.min_zoom) || 0,
      });
    }
    return out;
  }

  function buildGrid(features) {
    const grid = new Map();
    for (let i = 0; i < features.length; i++) {
      const ft = features[i];
      const c0 = Math.floor(ft.minLon / CELL);
      const c1 = Math.floor(ft.maxLon / CELL);
      const r0 = Math.floor(ft.minLat / CELL);
      const r1 = Math.floor(ft.maxLat / CELL);
      // A trace that runs half the globe would otherwise be registered in
      // hundreds of cells; clamp the span so the index stays small.
      const lonCells = Math.min(c1 - c0 + 1, 64);
      const latCells = Math.min(r1 - r0 + 1, 64);
      for (let cc = c0; cc <= c0 + lonCells - 1; cc++) {
        for (let rr = r0; rr <= r0 + latCells - 1; rr++) {
          const key = cc + ":" + rr;
          let bucket = grid.get(key);
          if (!bucket) { bucket = []; grid.set(key, bucket); }
          bucket.push(i);
        }
      }
    }
    return grid;
  }

  // The viewport as SPANS INSIDE [-180, 180] — the only space the
  // feature grid is indexed in, so a span that runs past a pole edge
  // never reaches the cells on the other side of the dateline.
  //
  // Three shapes, all measured at #49.1961,175.6055,5:
  //   west > east   Leaflet's wrapped form (west positive, east
  //                 negative) — the case this already handled;
  //   east > 180    Leaflet's CONTINUOUS form: this view reports
  //                 121.82 .. 229.39, and the old single-span branch
  //                 took it — cells at floor(-170 / CELL) are negative
  //                 and were never scanned, so the faults east of the
  //                 dateline were never even candidates;
  //   west < -180   …the same, from the other side.
  //
  // MEASURED: the old code selected **842** features for this viewport
  // where a dateline-aware scan finds **2,143** — **1,301 missing
  // (61 %)**, and none of the added features had a negative longitude
  // at all. Spans may overlap (a whole-world view produces three); the
  // `seen` set below makes that harmless.
  function viewSpans(west, east) {
    if (west > east) return [[west, 180], [-180, east]];
    if (east <= 180 && west >= -180) return [[west, east]];
    const spans = [];
    const piece = (w, e) => {
      const cw = Math.max(-180, w), ce = Math.min(180, e);
      if (cw < ce) spans.push([cw, ce]);
    };
    piece(west, east);
    piece(west - 360, east - 360);
    piece(west + 360, east + 360);
    return spans.length ? spans : [[west, east]];
  }

  // Every feature whose bounding box meets the box, and whose min_zoom
  // has been reached.
  function candidates(bounds, zoom) {
    const out = [];
    if (!state.grid) return out;
    const west = bounds.getWest(), east = bounds.getEast();
    const south = bounds.getSouth(), north = bounds.getNorth();
    const seen = new Set();
    const spans = viewSpans(west, east);
    for (const [w, e] of spans) {
      const c0 = Math.floor(w / CELL), c1 = Math.floor(e / CELL);
      const r0 = Math.floor(south / CELL), r1 = Math.floor(north / CELL);
      for (let cc = c0; cc <= c1; cc++) {
        for (let rr = r0; rr <= r1; rr++) {
          const bucket = state.grid.get(cc + ":" + rr);
          if (!bucket) continue;
          for (const idx of bucket) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const ft = state.features[idx];
            if (!ft) continue;
            if (zoom < ft.minZoom) continue;
            if (ft.maxLon < w || ft.minLon > e) continue;
            if (ft.maxLat < south || ft.minLat > north) continue;
            out.push(idx);
          }
        }
      }
    }
    return out;
  }

  // ── the layer ────────────────────────────────────────────────────────
  function ensurePane(map) {
    if (map.getPane(PANE)) return;
    map.createPane(PANE);
    const pane = map.getPane(PANE);
    pane.style.zIndex = String(PANE_Z);
    // The faults are scenery. A pointer-events-enabled pane would take
    // the click away from the news pins underneath it.
    pane.style.pointerEvents = "none";
  }

  function buildLayer() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    return L.geoJSON(null, {
      pane: PANE,
      style: (ft) => styleFor(ft, state.map ? state.map.getZoom() : 3),
      interactive: false,
      // USGS is public domain and GEM is CC BY-SA 4.0 — both credits
      // belong on the map, not only in the builder's source comment.
      attribution: "USGS Earthquake Hazards Program (public domain) · GEM GAF-DB (CC BY-SA 4.0)",
    });
  }

  // The canvas renderer.
  //
  // Tens of thousands of SVG paths is not a DOM a browser can pan, so the
  // traces go onto ONE canvas. The renderer is pinned to the fault pane
  // (not Leaflet's overlayPane, which is where the pin canvas lives) and
  // the pane is pointer-events: none, so the canvas never takes a click.
  //
  // Leaflet adds the renderer to the map itself the first time a path
  // uses it (Map.getRenderer), so it must not be added twice.
  function ensureRenderer(map) {
    if (state.renderer || !window.L || !window.L.canvas) return state.renderer;
    ensurePane(map);
    state.renderer = window.L.canvas({ padding: 0.3, pane: PANE });
    return state.renderer;
  }

  function getTileLayer() {
    // OverlayOpacity.mount() calls setOpacity() on every WEATHER_OVERLAYS
    // entry, and a raw L.geoJSON has no such method (that throw aborted
    // the rest of app.js once already). Attach the pair here so the
    // GeoJSON group satisfies the same contract as a TileLayer.
    if (!state.layer) {
      state.layer = buildLayer();
      state.layer.setOpacity = (v) => setOpacity(v);
      state.layer.getOpacity = () => getOpacity();
    }
    return state.layer;
  }

  // ── drawing ──────────────────────────────────────────────────────────
  // The visible set is reconciled INCREMENTALLY: the features that are
  // ── THE DATELINE ─────────────────────────────────────────────────────
  //
  // Same defect as the isobars, same cause: Leaflet projects a vertex
  // through a CRS anchored at the map's CENTRE, so a fault at -170
  // with the centre at 175.6 is placed 345° WEST — off the left edge —
  // when it belongs 14° EAST. Selecting the feature (viewSpans, above)
  // and RENDERING it correctly are two separate jobs, and this is the
  // second one.
  //
  // Handles both shapes: the [lat, lng] arrays built in update(), and
  // the LatLng objects Leaflet returns from getLatLngs().
  function wrapLine(pts, centreLng) {
    const n = pts.length;
    if (!n) return false;
    const getLng = (p) => (Array.isArray(p) ? p[1] : p && p.lng);
    const setLng = (p, v) => { if (Array.isArray(p)) p[1] = v; else p.lng = v; };

    let touched = false;
    let prev = getLng(pts[0]);
    if (typeof prev !== "number") return false;

    // Anchor the START to the centre…
    let x = prev;
    while (x - centreLng > 180) x -= 360;
    while (centreLng - x > 180) x += 360;
    if (x !== prev) { setLng(pts[0], x); touched = true; }
    prev = x;

    // …and every later vertex to the one before it. Anchoring EACH
    // vertex to the centre instead splits a dateline-crossing trace
    // into two halves a world apart, and Leaflet then draws the chord
    // between them — a band straight across the map. The isobars had
    // exactly this; see the long comment there.
    for (let i = 1; i < n; i++) {
      const p = pts[i];
      if (!p) continue;
      const raw = getLng(p);
      if (typeof raw !== "number") continue;
      x = raw;
      while (x - prev > 180) x -= 360;
      while (prev - x > 180) x += 360;
      if (x !== raw) { setLng(p, x); touched = true; }
      prev = x;
    }
    return touched;
  }

  // Re-anchor the traces already on the map to the CURRENT centre.
  // update() only ADDS what the viewport gained, so a view panned onto
  // the dateline would otherwise keep the offsets chosen at build time
  // and the traces that should be visible would sit a full turn off
  // the map. The scan is cheap; setLatLngs runs only for traces that
  // actually moved.
  function rewrapLines() {
    if (!state.map || !state.layer) return;
    const centre = state.map.getCenter().lng;
    state.layer.eachLayer((ly) => {
      if (wrapLine(ly.getLatLngs(), centre)) ly.redraw();
    });
  }

  // already on the map stay, the new ones are added and the ones that
  // left the viewport are removed. A full clear-and-rebuild at city zoom
  // would recreate thousands of Leaflet paths on every pan.
  function update() {
    if (!state.enabled || !state.map || !state.features.length) return;
    const zoom = state.map.getZoom();
    const bounds = state.map.getBounds().pad(0.35);
    const wanted = new Set(candidates(bounds, zoom));
    const renderer = ensureRenderer(state.map);

    for (const idx of wanted) {
      if (state.added.has(idx)) continue;
      const ft = state.features[idx];
      if (!ft) continue;
      try {
        const coords = ft.feature.geometry.coordinates;
        const latlngs = new Array(coords.length);
        for (let i = 0; i < coords.length; i++) {
          latlngs[i] = [Number(coords[i][1]), Number(coords[i][0])];
        }
        // …and into the map's continuous longitude, or the half of this
        // trace east of the dateline lands off the left edge. See
        // wrapLine() above.
        wrapLine(latlngs, state.map.getCenter().lng);
        const opts = styleFor(ft.feature, zoom);
        opts.pane = PANE;
        opts.renderer = renderer;
        const ly = L.polyline(latlngs, opts);
        ly.feature = ft.feature;
        state.layer.addLayer(ly);
        state.added.set(idx, ly);
      } catch (e) {
        warn("[faults] could not add a trace", e);
      }
    }

    for (const [idx, ly] of Array.from(state.added.entries())) {
      if (wanted.has(idx)) continue;
      try { state.layer.removeLayer(ly); } catch (_) {}
      state.added.delete(idx);
    }
  }

  function scheduleUpdate(delay) {
    if (state.updateTimer) clearTimeout(state.updateTimer);
    state.updateTimer = setTimeout(() => {
      state.updateTimer = null;
      update();
    }, delay == null ? 120 : delay);
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = Promise.all([
      fetch(META_URL, { cache: "default" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(GEM_META_URL, { cache: "default" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([m, g]) => {
      state.meta = m;
      state.metaGem = g;
      state.metaPromise = null;
      mountLegend();
      return m;
    });
    return state.metaPromise;
  }

  function ensureData() {
    if (state.features.length) return Promise.resolve(state.features);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.all([
      ensureMeta(),
      fetch(GEOJSON_URL, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
      fetch(GEM_GEOJSON_URL, { cache: "default" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
    ])
      .then(([, fc, fcGem]) => {
        const usgs = prepare(fc);
        const gem = prepare(fcGem);
        state.features = usgs.concat(gem);
        state.grid = buildGrid(state.features);
        state.loadPromise = null;
        log("[faults] loaded", state.features.length, "traces");
        return state.features;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[faults] load failed", e);
        throw e;
      });
    return state.loadPromise;
  }

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData().then(() => {
        update();
        mountLegend();
      }).catch((e) => error("[faults] could not load", e));
    } else {
      // Drop every path: a disabled layer must cost nothing.
      for (const [, ly] of Array.from(state.added.entries())) {
        try { state.layer.removeLayer(ly); } catch (_) {}
      }
      state.added.clear();
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
    if (state.map && state.enabled) {
      restyle(state.map.getZoom());
    }
  }
  function getOpacity() { return state.opacity; }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("xyzo:fault-change", { detail: { enabled: state.enabled } })); } catch (_) {}
  }

  // ── the legend ───────────────────────────────────────────────────────
  // Inside the Leaflet layers dropdown, which keeps Leaflet's default
  // WHITE background — so the key is a light-theme block, like the
  // Köppen key beside it.
  function mountLegend() {
    if (state.legendMounted) return true;
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!list) return false;
    const old = document.getElementById("fault-legend");
    if (old) old.remove();

    const ageColors = (state.meta && state.meta.age_colors) || FALLBACK_AGE_COLORS;
    const slipColors = (state.metaGem && state.metaGem.slip_colors) || FALLBACK_SLIP_COLORS;
    const plateColor = FALLBACK_PLATE_COLOR;

    const ageRows = Object.keys(FALLBACK_AGE_COLORS).map((k) => {
      const label = ({
        historic: "Historic (last 150 yr)",
        "latest-quaternary": "Latest Quaternary (15 ka)",
        "late-quaternary": "Late Quaternary (130 ka)",
        "middle-late-quaternary": "Middle &amp; Late Quaternary (750 ka)",
        "undifferentiated-quaternary": "Undifferentiated Quaternary (1.6 My)",
        "class-b": "Class B (various ages)",
        unspecified: "Unspecified age",
      })[k] || k;
      return '<div class="fault-legend-row">' +
        `<span class="fault-legend-swatch" style="background:${ageColors[k] || FALLBACK_AGE_COLORS[k]}"></span>` +
        `<span>${label}</span></div>`;
    }).join("");

    const slipRows = ["Normal", "Reverse", "Dextral", "Sinistral", "Subduction_Thrust", "Spreading_Ridge"]
      .map((k) => '<div class="fault-legend-row">' +
        `<span class="fault-legend-swatch" style="background:${slipColors[k] || FALLBACK_SLIP_COLORS[k]}"></span>` +
        `<span>${k.replace(/_/g, " ")} (GEM)</span></div>`).join("");

    const host = document.createElement("div");
    host.id = "fault-legend";
    host.className = "fault-legend leaflet-control-layers-fault";
    host.innerHTML =
      '<div class="fault-legend-title"><span>Tectonic faults</span></div>' +
      '<div class="fault-legend-sub">Traces appear as you zoom in — the long, ' +
      'recent ones first.</div>' +
      '<div class="fault-legend-rows">' +
      '<div class="fault-legend-row">' +
      `<span class="fault-legend-swatch" style="background:${plateColor}"></span>` +
      '<span>Plate boundary</span></div>' +
      ageRows +
      '</div>' +
      '<div class="fault-legend-sub">Global active faults (GEM)</div>' +
      `<div class="fault-legend-rows">${slipRows}</div>` +
      '<div class="fault-legend-foot">USGS (public domain) · GEM GAF-DB (CC BY-SA 4.0)</div>';

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
    return true;
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);

    // The overlayadd / overlayremove listeners are registered BEFORE any
    // addTo() — the layers control fires overlayadd synchronously, so a
    // listener attached later would never see the restore.
    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });

    map.on("zoomend", () => {
      if (!state.enabled) return;
      rewrapLines();
      restyle(map.getZoom());
      scheduleUpdate(0);
    });
    map.on("moveend", () => {
      if (!state.enabled) return;
      // BEFORE the incremental update: traces already on the map keep
      // the offsets chosen for the old centre, and update() only adds
      // what the viewport gained — it never re-anchors what is there.
      rewrapLines();
      scheduleUpdate(120);
    });

    ensureMeta();
  }

  function blocksClick() {
    // A fault is scenery. It never swallows a map click.
    return false;
  }

  // ── HUD sampling ─────────────────────────────────────────────────────
  // The nearest fault trace within ~0.3° (≈ 33 km). SEGMENT distance,
  // not vertex distance: a cursor in the middle of a long trace is far
  // from every vertex, and a vertex scan would miss the fault running
  // right under it.
  function sampleAt(latlng) {
    if (!state.enabled || !state.features.length || !state.grid) return null;
    const lat = latlng && Number(latlng.lat);
    const lng = latlng && Number(latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const MAX_D2 = 0.3 * 0.3;
    const px = lng * cosLat;
    const py = lat;

    const c0 = Math.floor(lng / CELL), c1 = Math.floor(lng / CELL);
    const r0 = Math.floor(lat / CELL), r1 = Math.floor(lat / CELL);
    const zoom = state.map ? state.map.getZoom() : 18;
    let best = null;
    const seen = new Set();
    for (let cc = c0; cc <= c1; cc++) {
      for (let rr = r0; rr <= r1; rr++) {
        const bucket = state.grid.get(cc + ":" + rr);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const ft = state.features[idx];
          if (!ft) continue;
          // The HUD must agree with the map: a trace that is not drawn
          // at this zoom is not reported either.
          if (zoom < ft.minZoom) continue;
          const coords = ft.feature.geometry.coordinates;
          let d2 = Infinity;
          for (let i = 1; i < coords.length; i++) {
            const a = coords[i - 1], b = coords[i];
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
          if (d2 <= MAX_D2 && (!best || d2 < best.d2)) {
            best = { d2, name: ft.props.name || "Fault trace", kind: ft.props.kind };
          }
        }
      }
    }
    if (!best) return null;
    const km = Math.round(Math.sqrt(best.d2) * 111);
    return best.name + (km >= 1 ? " · " + km + " km" : "");
  }

  // ── export surface ───────────────────────────────────────────────────
  // The USGS half is public domain; the GEM half is CC BY-SA 4.0, so a
  // derivative that contains it is share-alike and the licence travels
  // with the file.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "faults",
      z: 367,   // the map pane order — the export draws in it too
      label: "🪨 Tectonic faults (USGS)",
      kind: "vector",
      attribution: "USGS Earthquake Hazards Program — public domain",
      licence: "Public domain — US Government work (USGS)",
      source: "https://www.usgs.gov/programs/earthquake-hazards/google-earthtmkml-files",
      style: { stroke: "#ff4d6d", width: 1.6, opacity: 0.9 },
      isActive: () => state.enabled && state.features.length > 0,
      async features() {
        const out = [];
        for (const ft of state.features) {
          if (ft.props.kind === "gem-active-fault") continue;
          out.push(ft.feature);
        }
        return { type: "FeatureCollection", features: out };
      },
    });
    window.XYZO_EXPORT.register({
      id: "gem-faults",
      z: 367,
      label: "🌍 Global active faults (GEM)",
      kind: "vector",
      attribution: "GEM Global Active Faults Database (GEM GAF-DB) — Styron & Pagani (2020)",
      licence: "CC BY-SA 4.0",
      source: "https://www.globalquakemodel.org/product/active-faults-database",
      style: { stroke: "#c4b5fd", width: 1.6, opacity: 0.9 },
      isActive: () => state.enabled && state.features.length > 0,
      async features() {
        const out = [];
        for (const ft of state.features) {
          if (ft.props.kind !== "gem-active-fault") continue;
          out.push(ft.feature);
        }
        return { type: "FeatureCollection", features: out };
      },
    });
  }

  window.FaultLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    onLayerToggled: onLayerToggled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    mountLegend: mountLegend,
    sampleAt: sampleAt,
    LAYER_NAME: "🪨 Tectonic faults (USGS)",
    registerExport,
    _state: state,
    _styleFor: styleFor,
    _colorFor: colorFor,
    _prepare: prepare,
    _buildGrid: buildGrid,
    _candidates: candidates,
    _viewSpans: viewSpans,
    _wrapLine: wrapLine,
    _rewrapLines: rewrapLines,
    _ageClassOf: ageClassOf,
    _slipFamily: slipFamily,
  };

  registerExport();
})();
