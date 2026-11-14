/* ═══════════════════════════════════════════════════════════════════════
   Rivers overlay — FAO AQUASTAT "Rivers (Global, edition 2026)".

   Source: FAO AQUASTAT / AQUAMAPS, the 2026 edition of the global river
   network, derived from HydroRIVERS (HydroSHEDS). CC BY 4.0.
     https://data.apps.fao.org/catalog/iso/e22667af-3977-4e9f-b58b-67fb91b0fa87

   WHY THIS IS NOT THE OTHER RIVERS LAYER
   ──────────────────────────────────────
   public_html/river-layer.js draws Natural Earth's 1,473 lake
   centrelines — a client-side GeoJSON, fast, but a cartographic
   simplification. This one is the real network: **every river reach on
   Earth with a catchment of 10 km² or an average flow of 0.1 m³/s** —
   more than a million reaches, of which the world's great rivers are
   only the first few hundred.

   THE LINES COME FROM OUR OWN CACHING PROXY
   ─────────────────────────────────────────
   The publisher renders this network in ~2 s a tile whatever the zoom
   (the cost is the query, not the rasterising) and 25-48 s for a
   whole-world tile, so the browser cannot fetch it directly and stay
   quick. `api/src/routes/faoRiversProxy.ts` sits in front:
     /api/tile/fao-rivers/<level>/{z}/{y}/{x}
   and it (a) builds the upstream URL itself, so the 4.3 KB SLD and the
   discharge filter never ride in a tile request, (b) caches the tile ON
   DISK, so the second reader of a view is a local file, and (c)
   answers a tile the publisher cannot produce with 200 and a
   transparent PNG, so the console stays clean.
   Measured at the reader's own URL: 36 tiles still streaming at 64 s
   before; 8 tiles, all loaded after ~2 s, after.

   THE TWO OPTIONS THE READER GETS
   ───────────────────────────────
   1. DETAIL — a server-side filter on the long-term average discharge
      (`dis_av_cms`), so the thinning happens on the publisher's side and
      the tiles stay small. Four levels: Major (≥100 m³/s), Medium
      (≥10), Fine (≥1) and Full detail (every reach, down to 0.1 m³/s).
      The level is IN THE TILE URL — it is a different picture and a
      different cache entry.
   2. RIVER NAMES — on or off. The 2026 network carries NO names on its
      reaches, so the names come from the FAO's own CLASSIC rivers layer
      (`rivers_world_47950`), published by scripts/river_network_build.py
      as one anchor point per name.

   WHY THE CARTOGRAPHY IS OURS
   ───────────────────────────
   The publisher's published style is DARK-ON-LIGHT: order 1 is
   #042946 (near-black navy) and the pale classes carry the fine
   network. Over this site's default dark satellite basemap the main
   stems therefore VANISH — the layer draws and the reader sees almost
   nothing. So the PROXY sends its own SLD (GeoServer's `sld_body`
   vendor parameter), built from the SAME attributes the published style
   uses (`ord_flow`, `smooth_200`) but BRIGHT AT BOTH ENDS.

   It also fixes a GAP in the published style: that style has rules for
   `ord_flow` 1..6 only, so **every reach of order 7 and finer is not
   drawn by it at all** — 59 % of the network (42,610 of 71,687 reaches
   over the lower Amazon). Our SLD draws them, which is what makes
   "Full detail" mean anything.

   THE SLD IS BUILT BY THE BUILDER, NOT HERE
   ─────────────────────────────────────────
   scripts/river_network_build.py publishes the SLD and the class table
   in `meta.json`, and the PROXY sends the SLD and draws the map from
   it, while this module draws the legend key from the same table — so
   the KEY AND THE MAP CANNOT DISAGREE. A second implementation of the
   SLD anywhere else would be a second source of truth, and the one
   that drifts is the one nobody checks.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/rivers/fao";
  // The BUILD token moves when the published FILES move. 2026-11-09: the
  // labels were rebuilt (the publisher's mangled accents repaired, the
  // area DESCRIPTIONS and the one-and-two-letter abbreviations dropped —
  // see scripts/river_network_build.py) — and a URL is the cache key, so
  // a rebuilt file behind an unchanged token would be invisible.
  const BUILD = "20261109";
  const META_URL = BASE + "/meta.json?v=" + BUILD;
  const LABELS_URL = BASE + "/labels.geojson?v=" + BUILD;

  // The tiles come from OUR proxy, not from the publisher's WMS.
  //
  // The publisher renders this network in ~2 s a tile whatever the zoom
  // (the cost is the query, not the rasterising) and 25-48 s for a
  // whole-world tile. Measured at the reader's own URL: 36 tiles for
  // one screen, still streaming at 64 s.
  //
  // The proxy fixes that in three ways:
  //   1. the 4.3 KB SLD no longer rides in every tile URL — the proxy
  //      reads it from the published metadata and attaches it server-side,
  //   2. the tile is CACHED ON DISK, so the second reader of a view is
  //      a local file and not a round trip to a busy public server,
  //   3. a tile the publisher cannot produce answers 200 with a
  //      transparent PNG, so the console stays clean.
  const PROXY_PATH = "/api/tile/fao-rivers";

  const WMS_URL = "https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wms";
  const WMS_LAYER = "river_network";

  const PANE = "faoRiverPane";
  const PANE_Z = 371;

  const STORE_LEVEL = "xyzo.faoRivers.level";
  const STORE_LABELS = "xyzo.faoRivers.labels";
  const DEFAULT_LEVEL = "medium";

  // The attribution is a LICENCE OBLIGATION (CC BY 4.0), not a courtesy.
  // Leaflet prints it in the bottom-right corner. It names BOTH
  // publishers: the FAO layer and the upstream HydroSHEDS/HydroRIVERS
  // product it is derived from — the upstream licence (Appendix A of the
  // HydroSHEDS Technical Documentation) requires its Exhibit B
  // attribution, and the full statement travels with the published
  // metadata (`meta.json` → `upstream_attribution`).
  const ATTRIBUTION =
    "FAO AQUASTAT — Rivers (Global, 2026 ed.), from HydroRIVERS / HydroSHEDS (© WWF) · CC BY 4.0";

  // ── fallbacks ─────────────────────────────────────────────────────────
  // The builder publishes the real tables in meta.json. These copies are
  // what the layer uses if that fetch fails, and the module's test asserts
  // they agree with the published ones — a table that drifts would make
  // the legend describe a map that is not there.
  const FALLBACK_LEVELS = [
    { id: "major", label: "Major", filter: "dis_av_cms>=100", min_cms: 100 },
    { id: "medium", label: "Medium", filter: "dis_av_cms>=10", min_cms: 10 },
    { id: "fine", label: "Fine", filter: "dis_av_cms>=1", min_cms: 1 },
    { id: "full", label: "Full detail", filter: null, min_cms: 0 },
  ];
  const FALLBACK_CLASSES = [
    { id: "great", title: "Great rivers", min_ord: 1, max_ord: 2, color: "#ffffff", width: 1.25 },
    { id: "large", title: "Large rivers", min_ord: 3, max_ord: 4, color: "#67e8f9", width: 0.85 },
    { id: "medium", title: "Streams", min_ord: 5, max_ord: 6, color: "#38bdf8", width: 0.6 },
    { id: "fine", title: "Fine detail (order 7+)", min_ord: 7, max_ord: null, color: "#93c5fd", width: 0.35 },
  ];
  const FALLBACK_INTERMITTENT = {
    id: "intermittent", title: "Intermittent", color: "#fbbf24", width: 0.45, dashed: true,
  };

  // The degraded mode: if the published SLD cannot be fetched, the layer
  // still draws — every reach, in one colour. It is worse than the real
  // thing and it says so in the log, but a blank map is worse.
  const FALLBACK_SLD =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" ' +
    'xmlns:ogc="http://www.opengis.net/ogc"><NamedLayer><Name>river_network</Name>' +
    '<UserStyle><FeatureTypeStyle><Rule><ogc:Filter><ogc:PropertyIsGreaterThanOrEqualTo>' +
    '<ogc:PropertyName>ord_flow</ogc:PropertyName><ogc:Literal>1</ogc:Literal>' +
    '</ogc:PropertyIsGreaterThanOrEqualTo></ogc:Filter><LineSymbolizer><Stroke>' +
    '<CssParameter name="stroke">#7dd3fc</CssParameter>' +
    '<CssParameter name="stroke-width">0.7</CssParameter>' +
    '</Stroke></LineSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer>' +
    '</StyledLayerDescriptor>';

  // Two label callouts closer together than this overlap into one blur.
  const LABEL_MIN_GAP_PX = 70;
  const MAX_LABELS = 40;

  const state = {
    map: null,
    layer: null,          // L.tileLayer.wms
    enabled: false,
    meta: null,
    sld: null,
    labels: null,         // [{name, lat, lng, strahler}]
    labelLayer: null,     // L.layerGroup of tooltips
    level: DEFAULT_LEVEL,
    labelsOn: true,
    loadPromise: null,
    opacity: 0.9,
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
      // Above the wind animation (379) would be wrong — the wind is the
      // topmost weather layer — and this is a ground layer, so it sits
      // just under the city names (380) and over everything else.
      pane.style.zIndex = String(PANE_Z);
      // A wash must never eat a click: the river lines are decoration,
      // and the click-to-submit flow has to keep working underneath.
      pane.style.pointerEvents = "none";
    }
  }

  function levels() {
    const t = (state.meta && state.meta.levels) || FALLBACK_LEVELS;
    return Array.isArray(t) && t.length ? t : FALLBACK_LEVELS;
  }
  function classes() {
    const t = (state.meta && state.meta.classes) || FALLBACK_CLASSES;
    return Array.isArray(t) && t.length ? t : FALLBACK_CLASSES;
  }
  function intermittent() {
    return (state.meta && state.meta.intermittent) || FALLBACK_INTERMITTENT;
  }
  function levelById(id) {
    const found = levels().find((l) => l.id === id);
    return found || levels().find((l) => l.id === DEFAULT_LEVEL) || FALLBACK_LEVELS[1];
  }
  function currentLevel() {
    return levelById(state.level);
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureData() {
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = Promise.all([
      fetch(META_URL, { cache: "default" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([meta]) => {
        if (meta) state.meta = meta;
        // The SLD is published INSIDE meta.json, next to the class table
        // the legend is drawn from — one request, and the key and the map
        // come from the same rows. If it cannot be fetched the layer
        // falls back to one flat colour, and says so: a silent
        // degradation is how a layer ends up drawing something the legend
        // does not describe.
        const sld = meta && meta.sld && meta.sld.body;
        if (sld && sld.indexOf("StyledLayerDescriptor") !== -1) {
          state.sld = sld;
        } else {
          state.sld = FALLBACK_SLD;
          warn("[fao-rivers] the published SLD could not be fetched — " +
               "falling back to a single-colour style");
        }
        state.loadPromise = null;
        return state.meta;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[fao-rivers] data load failed", e);
        throw e;
      });
    return state.loadPromise;
  }

  function ensureLabels() {
    if (state.labels) return Promise.resolve(state.labels);
    return fetch(LABELS_URL, { cache: "default" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((fc) => {
        const out = [];
        for (const f of (fc && fc.features) || []) {
          const p = f.properties || {};
          const c = (f.geometry && f.geometry.coordinates) || [];
          if (!p.name || c.length < 2) continue;
          out.push({
            name: String(p.name),
            lat: Number(c[1]),
            lng: Number(c[0]),
            strahler: Number(p.strahler) || 0,
          });
        }
        state.labels = out;
        log("[fao-rivers] loaded", out.length, "river names");
        return out;
      })
      .catch((e) => {
        warn("[fao-rivers] label load failed", e);
        return [];
      });
  }

  // ── the tile layer ───────────────────────────────────────────────────
  //
  // Three sources, picked per tile:
  //
  //   z ≤ 4   OUR OWN STATIC TILES — rendered once, offline, from our
  //           own copy of the network (scripts/river_tiles_build.py).
  //           The publisher is not involved at all, and the world view
  //           — which the publisher takes 25-48 s a tile for — is
  //           instant. **z4 is a country-sized view**, so the whole of
  //           the zoomed-out half of the map is ours.
  //   z > 4   our caching PROXY, which asks the publisher once and keeps
  //           the tile on disk.
  //   fallback the publisher's WMS directly, if the proxy route is not
  //           deployed (an API running an older build).
  //
  // The DETAIL LEVEL is in the path of all three: it is a different
  // picture and a different cache entry.
  const STATIC_PATH = "/data/rivers/fao/tiles";
  const STATIC_ZOOM_MAX = 4;

  // ── THE TILE URL CARRIES A BUILD TOKEN ───────────────────────────────
  //
  // **A PNG UNDER `public_html` IS IMMUTABLE FOR A YEAR (Caddy), and the
  // proxy answers with `max-age=604800`.** So the tiles that were served
  // before the projection was fixed — the plate-carrée ones, and the
  // vertically flipped ones — stayed in every reader's browser cache for
  // a WEEK (proxied tiles) or a YEAR (our own static tiles), and a
  // rebuilt pyramid was invisible behind a stale URL. That is exactly
  // the "the rivers are not placed correctly" report: the reader was
  // looking at the OLD picture, not at a wrong one.
  //
  // The fix is the house pattern — a `?v=` token — and it must be
  // bumped whenever the tiles are rebuilt. **A URL is the cache key**,
  // so a new token is a new entry and the stale one is simply never
  // asked for again.
  const TILE_BUILD = "20261106b";

  function proxyUrl(levelId, z, y, x) {
    return `${PROXY_PATH}/${levelId}/${z}/${y}/${x}?v=${TILE_BUILD}`;
  }

  // The publisher's own WMS, used ONLY as a fallback if the proxy route
  // is not there (an API running an older build). It carries the SLD in
  // every request, which is exactly what the proxy exists to avoid, so
  // it is the degraded path and not the normal one.
  //
  // The bbox is in WEB MERCATOR — the slippy grid Leaflet lays tiles out
  // on. Asking for the same extent in EPSG:4326 returns a PLATE CARRÉE
  // image, which Leaflet then stretches over a Mercator square: at z2 the
  // continents visibly move (measured).
  const R = 20037508.34;
  function wmsUrl(levelId, z, y, x) {
    const n = 2 ** z;
    const bx = (x / n) * 2 * R - R;
    const bx1 = ((x + 1) / n) * 2 * R - R;
    const by = R - ((y + 1) / n) * 2 * R;
    const by1 = R - (y / n) * 2 * R;
    const lvl = levelById(levelId);
    const p = new URLSearchParams({
      SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap",
      LAYERS: WMS_LAYER, STYLES: "",
      BBOX: `${bx},${by},${bx1},${by1}`,
      WIDTH: String(IMAGE_PX), HEIGHT: String(IMAGE_PX),
      SRS: "EPSG:3857", FORMAT: "image/png", TRANSPARENT: "true",
      sld_body: state.sld || FALLBACK_SLD,
    });
    if (lvl && lvl.filter) p.set("CQL_FILTER", lvl.filter);
    return `${WMS_URL}?${p.toString()}`;
  }

  // The slippy grid is 256 px — Leaflet's default, and the grid the
  // publisher and our own pyramid are both cut on.
  const TILE_PX = 256;
  // The IMAGE is rendered at double resolution and the browser
  // downscales it into the 256-px slot. The publisher's cost does not
  // depend on the output size (the query and the set-up dominate), so
  // this is free sharpness.
  const IMAGE_PX = 512;

  /**
   * Which source a tile comes from — OUR static pyramid below the cut,
   * our caching proxy above it. Pure, so the tests can drive it without
   * a map.
   *
   * **THE COORDINATES IN THE URL ARE THE STANDARD SLIPPY GRID.** Leaflet's
   * tile coordinates depend on `tileSize`: `_pxBoundsToTileRange()` divides
   * the pixel bounds by the TILE SIZE, so a 512-px layer asks for a
   * 512-px grid — a tile at (11, 7) then covers the ground of the
   * STANDARD square (22, 14). Our pyramid and the publisher are on the
   * standard 256-px grid, so a 512-px layer fetches a tile from the
   * NORTH-WEST QUADRANT of where it belongs and draws it over the right
   * place. **The rivers appeared at completely the wrong place on Earth**
   * (measured: a tile at longitude 85° was fetched from longitude -56°).
   *
   * So: `tileSize` stays at the default 256 and the grid is the standard
   * one everywhere. The IMAGES are still 512 px — the publisher renders
   * the standard square at double resolution and the browser downscales
   * it into the 256-px slot, which is the house pattern (see the
   * Macrostrat geology layer).
   */
  function tileUrlFor(levelId, z, y, x) {
    if (state.usingFallback) return wmsUrl(levelId, z, y, x);
    if (z <= STATIC_ZOOM_MAX) {
      return `${STATIC_PATH}/${levelId}/${z}/${x}/${y}.png?v=${TILE_BUILD}`;
    }
    return proxyUrl(levelId, z, y, x);
  }

  function buildLayer() {
    if (!window.L || !window.L.tileLayer) return null;
    if (state.map) ensurePane(state.map);
    const layer = L.tileLayer("", {
      // **THE DEFAULT 256 — NEVER 512.** (This is the same rule the
      // Macrostrat geology layer records, and the reason it exists:
      // Leaflet's CRS scale is fixed at 256·2^z, so a 512-px layer asks
      // for a 512-px grid and every tile is fetched from the wrong
      // square.) The IMAGES are 512 px — the publisher renders the
      // standard square at double resolution and the browser downscales
      // it into the 256-px slot, which is sharper and costs the
      // publisher exactly the same.
      //
      // The publisher renders a 256 px tile of this network in ~2.4 s
      // and a 512 px tile of the SAME AREA in ~2.4 s as well: the cost
      // is the query and the set-up, not the rasterising.
      minZoom: 0,
      maxZoom: 15,
      // The network stops at 55.4°S and 83.4°N — asking for a tile
      // below that is a guaranteed empty request.
      bounds: L.latLngBounds([[-55.4, -180], [83.4, 180]]),
      keepBuffer: 1,
      updateWhenIdle: true,
      // A tile that fails to arrive answers with the transparent
      // placeholder, not a broken-image icon: a missing tile is a hole in
      // the network, and a hole reads better than a crossed-out box.
      errorTileUrl:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      attribution: ATTRIBUTION,
      pane: PANE,
      // A wash, not a wall: the network is dense enough that 100 % turns
      // the map into a mat of blue. This is also the default the opacity
      // slider resets to.
      opacity: 0.9,
    });
    // Which source a tile comes from is decided PER TILE, because it
    // depends on the zoom: our own static pyramid below the cut, the
    // proxy above it.
    layer.getTileUrl = function (coords) {
      return tileUrlFor(currentLevel().id, coords.z, coords.y, coords.x);
    };
    // The fallback: if the proxy route is not deployed, every tile above
    // the static pyramid errors. After a few of them, fall back to the
    // publisher's WMS so the layer still draws.
    layer.on("tileerror", () => {
      state.tileErrors = (state.tileErrors || 0) + 1;
      if (state.usingFallback || state.tileErrors < 5) return;
      state.usingFallback = true;
      warn("[fao-rivers] the tile proxy is not answering — " +
           "falling back to the publisher's WMS");
      layer.redraw();
    });
    return layer;
  }

  function getTileLayer() {
    if (!state.layer) {
      state.layer = buildLayer();
    }
    return state.layer;
  }

  // The level is IN the URL, so changing it means new tiles — and new
  // cache entries. The tile source is decided per tile, so a redraw is
  // all it takes.
  function applyLevel() {
    if (!state.layer) return;
    state.layer.redraw();
  }

  // ── labels ───────────────────────────────────────────────────────────
  /**
   * Pure label selection — the map is the only thing it cannot have, so
   * the tests drive it directly (`_chooseLabels`).
   *
   *   labels           [{name, lat, lng, strahler}]
   *   opts.zoom        current zoom
   *   opts.minStrahler the smallest river worth naming
   *   opts.contains(latlng)   the padded viewport test
   *   opts.toContainerPoint(latlng)  for the screen-space gap
   *
   * Returns [{name, anchor, strahler}] — ONE label per river name.
   */
  function chooseLabels(labels, opts) {
    const zoom = opts.zoom;
    const minStrahler = opts.minStrahler;
    const contains = opts.contains;
    const toPoint = opts.toContainerPoint;

    const candidates = [];
    for (const l of labels || []) {
      if (l.strahler < minStrahler) continue;
      if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue;
      const anchor = [l.lat, l.lng];
      if (contains && !contains(anchor)) continue;
      candidates.push({ name: l.name, anchor, strahler: l.strahler });
    }

    // The most important river first, so a name that loses a slot to a
    // collision is a LESS important river, never an arbitrary one.
    candidates.sort((a, b) => b.strahler - a.strahler || a.name.localeCompare(b.name));

    const out = [];
    for (const c of candidates) {
      if (out.length >= MAX_LABELS) break;
      const pt = toPoint(c.anchor);
      if (!pt) continue;
      let clash = false;
      for (const q of out) {
        const dx = pt.x - q.pt.x, dy = pt.y - q.pt.y;
        if (dx * dx + dy * dy < LABEL_MIN_GAP_PX * LABEL_MIN_GAP_PX) { clash = true; break; }
      }
      if (clash) continue;
      out.push({ name: c.name, anchor: c.anchor, strahler: c.strahler, pt });
    }
    return out.map(({ name, anchor, strahler }) => ({ name, anchor, strahler }));
  }

  // How big a river has to be to be worth a name at this zoom. The
  // names are the FAO's basin names, so there are five thousand of them;
  // the gate keeps the map readable instead of a wall of words.
  function labelMinStrahler(zoom) {
    if (zoom <= 3) return 6;
    if (zoom <= 5) return 5;
    if (zoom <= 7) return 4;
    return 3;
  }

  function updateLabels(zoom) {
    if (!state.map || !state.labels) return;
    if (!state.labelLayer) {
      state.labelLayer = L.layerGroup();
      if (state.enabled && state.map) state.labelLayer.addTo(state.map);
    }
    state.labelLayer.clearLayers();
    if (!state.enabled || !state.labelsOn || zoom < 3) return;
    const map = state.map;

    // Placement is VIEWPORT-DEPENDENT (only on-screen rivers are worth a
    // slot), so the bounds are part of the input. Padded a little so a
    // river just entering the view gets labelled before the user can
    // read the empty edge.
    const bounds = map.getBounds().pad(0.1);

    const chosen = chooseLabels(state.labels, {
      zoom,
      minStrahler: labelMinStrahler(zoom),
      contains: (ll) => bounds.contains(ll),
      toContainerPoint: (ll) => map.latLngToContainerPoint(ll),
    });

    for (const c of chosen) {
      L.tooltip({
        permanent: true,
        direction: "center",
        className: "river-label",
        opacity: 0.9,
        // A label must NEVER take a click: the click-to-submit flow and
        // the pin renderer both live under it.
        interactive: false,
      })
        .setContent(c.name)
        .setLatLng(c.anchor)
        .addTo(state.labelLayer);
    }
  }

  // ── the options ──────────────────────────────────────────────────────
  function setLevel(id, opts) {
    const lvl = levelById(id);
    const next = lvl ? lvl.id : DEFAULT_LEVEL;
    if (next === state.level && state.layer) return next;
    state.level = next;
    if (!opts || opts.persist !== false) storageSet(STORE_LEVEL, next);
    applyLevel();
    if (state.map && state.enabled) updateLabels(state.map.getZoom());
    // The chip that was clicked has to become the PRESSED one, and the
    // caption has to say what the new level means. Without this the row
    // keeps showing the level the reader was on before they clicked —
    // a legend that lies about the map is worse than no legend.
    refreshLegend();
    notifyChange();
    return next;
  }

  function getLevel() { return state.level; }

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

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    if (state.enabled) {
      ensureData()
        .then(() => {
          applyLevel();
          return ensureLabels();
        })
        .then(() => {
          if (state.labelLayer && state.map) state.labelLayer.addTo(state.map);
          if (state.map) updateLabels(state.map.getZoom());
        })
        .catch(() => {});
    } else {
      if (state.labelLayer && state.map && state.map.hasLayer(state.labelLayer)) {
        state.map.removeLayer(state.labelLayer);
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
    if (state.layer && typeof state.layer.setOpacity === "function") {
      state.layer.setOpacity(state.opacity);
    }
  }

  function getOpacity() {
    if (state.layer && typeof state.layer.getOpacity === "function") {
      return state.layer.getOpacity();
    }
    return state.opacity;
  }
  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:fao-rivers-change", {
        detail: { enabled: state.enabled, level: state.level, labels: state.labelsOn },
      }));
    } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  function legendSwatch(c) {
    return '<span class="fao-river-swatch" style="background:' +
      (c.dashed ? "repeating-linear-gradient(90deg," + c.color +
        " 0 4px,transparent 4px 8px)" : c.color) +
      '"></span>';
  }

  function mountLegend() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("fao-rivers-legend");
    if (old) old.remove();

    const levelChips = levels().map((l) =>
      '<button type="button" class="soil-prop-btn" data-level="' + l.id +
      '" aria-pressed="false">' + l.label + "</button>").join("");

    const host = document.createElement("div");
    host.id = "fao-rivers-legend";
    host.className = "temp-legend leaflet-control-layers-temp";
    host.innerHTML =
      '<div class="temp-legend-title"><span>Rivers — FAO 2026</span></div>' +
      '<div class="mag-switch-label">Detail</div>' +
      '<div class="soil-prop-switch" id="fao-rivers-level-switch" role="group" ' +
      'aria-label="River detail level">' + levelChips + "</div>" +
      '<div class="temp-legend-detail" id="fao-rivers-level-note"></div>' +
      '<label class="mag-wash-row"><input type="checkbox" id="ctrl-fao-rivers-labels"> River names</label>' +
      '<div class="fao-river-key" id="fao-rivers-key"></div>' +
      '<div class="temp-legend-foot" id="fao-rivers-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    host.querySelectorAll("#fao-rivers-level-switch .soil-prop-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        setLevel(btn.getAttribute("data-level"));
      });
    });

    const labelsBox = host.querySelector("#ctrl-fao-rivers-labels");
    if (labelsBox) {
      labelsBox.addEventListener("change", () => setLabelsOn(labelsBox.checked));
    }

    refreshLegend();
    return true;
  }

  function refreshLegend() {
    // The legend may not be mounted yet (the layers dropdown is created
    // after the layer modules initialise), and the module is also loaded
    // in a test sandbox with no document at all.
    if (typeof document === "undefined") return;
    const host = document.getElementById("fao-rivers-legend");
    if (!host) return;
    host.querySelectorAll("#fao-rivers-level-switch .soil-prop-btn").forEach((btn) => {
      const on = btn.getAttribute("data-level") === state.level;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-active", on);
    });

    const lvl = currentLevel();
    const note = document.getElementById("fao-rivers-level-note");
    if (note) {
      note.textContent = lvl.min_cms
        ? "Rivers carrying " + lvl.min_cms + " m³/s and more."
        : "Every reach in the network, down to 0.1 m³/s.";
    }

    const box = host.querySelector("#ctrl-fao-rivers-labels");
    if (box) box.checked = !!state.labelsOn;

    // The key is drawn from the SAME table the map is drawn from, so it
    // cannot describe a colour the map does not use.
    const key = document.getElementById("fao-rivers-key");
    if (key) {
      const rows = classes().map((c) =>
        '<div class="fao-river-key-row">' + legendSwatch(c) +
        '<span>' + c.title + "</span></div>").join("");
      const inter = intermittent();
      key.innerHTML = rows +
        '<div class="fao-river-key-row">' + legendSwatch(inter) +
        '<span>' + inter.title + "</span></div>";
    }

    const foot = document.getElementById("fao-rivers-foot");
    if (foot) {
      foot.textContent = ATTRIBUTION +
        (state.meta && state.meta.published ? " · published " + state.meta.published : "");
    }
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);

    // The stored preferences are read BEFORE the listeners are attached,
    // so a reader who chose "Full detail" gets it — and the layer is put
    // on the map if they had it on.
    state.level = levelById(storageGet(STORE_LEVEL, DEFAULT_LEVEL)).id;
    // THE NAMES ARE OFF BY DEFAULT (owner ask 2026-11-08: *"not to show
    // any labels if the user doesn't want to see them.. it might already
    // be that way.. so default it without labels"*).
    //
    // IT WAS NOT, AND THE STUDY BEHIND THE ASK SAYS WHY IT SHOULD BE.
    // The 2026 network carries no names on its reaches, so the names come
    // from the FAO's own CLASSIC layer — and **that layer has no river
    // name either**: it carries `maj_name` and `sub_name`, which are
    // BASIN names (measured on the 86,882-feature source: 18 attributes,
    // and not one of them names a river). So what the map prints is the
    // name of the BASIN a reach belongs to: "Cahokia / Joachim",
    // "Mississippi - Missouri", "Lower Arkansas". 601 of the 5,097
    // published names are compounds like that, and the rest are places
    // ("Gobi Interior"), abbreviations ("Ob", "Ko") or descriptions
    // ("Zona de rios en Chaco Boreal").
    //
    // A reader who has not asked for a word should not be given one: the
    // names are the LAYER'S OPTION, not the price of admission. The
    // switch stays, and an explicit "on" is remembered (the store key is
    // written by setLabelsOn), so this is a DEFAULT and not a removal.
    state.labelsOn = storageGet(STORE_LABELS, "0") !== "0";

    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });
    map.on("zoomend", () => {
      if (state.enabled) updateLabels(map.getZoom());
    });
    // Labels are placed for ON-SCREEN rivers only, so a PAN changes which
    // names deserve one — re-place after the view settles. Throttled
    // because an animated pan chains several moveends.
    let labelTimer = null;
    map.on("moveend", () => {
      if (!state.enabled) return;
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => {
        labelTimer = null;
        updateLabels(map.getZoom());
      }, 150);
    });

    // The legend lives inside the layers dropdown, which app.js creates
    // after the layer modules initialise — so the injection is retried
    // until the control exists (the climate / soil / mag pattern).
    if (mountLegend()) refreshLegend();
    let tries = 0;
    const timer = setInterval(() => {
      if (mountLegend() || ++tries > 40) clearInterval(timer);
    }, 250);

    // The SLD and the class table are fetched NOW, not when the layer is
    // switched on: the first tile request has to carry the real
    // cartography, or the map draws in the fallback style and then
    // redraws in the real one — two rounds of tiles for nothing. It is
    // 7 KB, and the legend's key comes from the same file.
    ensureData()
      .then(() => {
        applyLevel();
        refreshLegend();
      })
      .catch(() => {});
  }

  function blocksClick() {
    return false;   // rivers never swallow a map click
  }

  // No client-side field to sample: the network is a raster served by the
  // publisher, so there is nothing to read a number from. The HUD leaves
  // this layer alone rather than guessing.
  function sampleAt() { return null; }

  // ── public API ───────────────────────────────────────────────────────
  window.FaoRiversLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    sampleAt,
    setLevel: setLevel,
    getLevel: getLevel,
    setLabelsOn: setLabelsOn,
    getLabelsOn: getLabelsOn,
    mountLegend: mountLegend,
    refreshLegend: refreshLegend,
    LAYER_NAME: "🌊 Rivers (FAO 2026)",
    _state: state,
    _chooseLabels: chooseLabels,
    _labelMinStrahler: labelMinStrahler,
    _levels: levels,
    _classes: classes,
    _applyLevel: applyLevel,
    _proxyUrl: proxyUrl,
    _tileUrlFor: tileUrlFor,
    _TILE_BUILD: TILE_BUILD,
    _STATIC_ZOOM_MAX: STATIC_ZOOM_MAX,
  };
})();
