/* ═══════════════════════════════════════════════════════════════════════
   3D globe view for Xyzo.

   The main map is Leaflet and stays Leaflet — the canvas pin renderer,
   the isobar layer, the basins probe and the layers dropdown are all
   deeply Leaflet-coupled, and a full engine swap would be a rewrite.

   This is a SEPARATE view (globe.html) built on MapLibre GL JS, which
   has a native globe projection. It renders the same data and the same
   overlays:

     basemap    Esri World Imagery (Web Mercator raster, reprojected)
     overlays  Köppen, Soil, Cropland, Land Cover, Geology  (tile pyramids)
                NASA Satellite / Rain / Night                (GIBS XYZ)
                Rivers, Basins, Magnetic lines, Isobars      (GeoJSON)
                Temperature                                  (baked image)
      pins       the story pins from /api/pins/map

   Two flat-map overlays deliberately do NOT port:
     · Wind streamlines — the animation is a screen-space canvas tied
       to Leaflet's 2D projection; particles behind the globe have no
       meaningful screen position.
     · Geologic contacts — the USGS layer is WMS (BBOX/GetMap), and
       MapLibre raster sources need an XYZ {z}/{x}/{y} template.

   A globe is a different projection, not a different world: a shared
   pin links back to the flat map at the same place, and the flat map
   links here.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const V = "202611142000";
  const q = (p) => p + (p.includes("?") ? "&" : "?") + "v=" + V;

  // field-bake.js owns the canonical Web-Mercator bake and the ramp.
  // It is loaded by globe.html BEFORE this file. Without it the three
  // gridded field overlays (temperature, lightning, the magnetic wash)
  // cannot be painted at all — and a half-painted field is worse than
  // an absent one, so say so loudly rather than silently.
  if (!window.XYZO_FIELD_BAKE) {
    const msg = "globe.js: field-bake.js did not load — the temperature, " +
      "lightning and magnetic-wash overlays are unavailable";
    if (window.XLog && window.XLog.error) window.XLog.error(msg);
    else if (window.console && window.console.warn) window.console.warn(msg);
  }

  // ── persisted settings ───────────────────────────────────────────────
  // Overlay on/off + opacity and the projection survive a reload, same
  // contract as the flat map's layerPrefs. Stored under xyzo.globe.* so
  // the two views never clobber each other.
  const SETTINGS_KEY = "xyzo.globe.settings";
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
    catch (_) { return {}; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
  }
  const settings = loadSettings();

  // NASA GIBS uses a date segment in the URL; bake it once at load,
  // same convention as the flat map's nasaDate().
  function nasaDate(daysAgo) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (daysAgo || 0));
    return d.getUTCFullYear() + "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(d.getUTCDate()).padStart(2, "0");
  }

  // ── the basins' COLOUR and OUTLINE STRENGTH ──────────────────────────
  //
  // Both were wrong, and the second is why the owner reported "I don't
  // see the black outlines":
  //
  //   1. THE OUTLINE WAS PAINTED AT THE FILL'S BASE. `line-opacity`
  //      inherited `baseOpacity(o, "fill-opacity")` = 0.16, where the
  //      flat map draws the same hairline at 0.85 — a 5.3x difference
  //      on a 0.8 px stroke. MEASURED on the live globe against a
  //      fill-only baseline (animations hidden, baseline noise 0 px):
  //      shipped = 5,119 px changed but only **2** above delta 40;
  //      at the flat map's 0.85 = 11,558 px and **4,179** strong.
  //      It was being drawn — invisibly.
  //
  //   2. ONE COLOUR, IGNORED BY THE READER'S SCHEME. The flat map
  //      offers blue/red/black in its legend (localStorage
  //      "xyzo.basinScheme") and colours each feature by its KIND
  //      (river / coast / interior). The globe hardcoded a single
  //      #38bdf8 for every feature, so a reader on "black" got sky-blue
  //      here — verified by storing black and reading the paint back.
  //
  // `SCHEMES.blue` is `null` in basin-layer.js, meaning "use the
  // published kind_colors"; those published values are what this falls
  // back to, so the two views agree without a network round trip before
  // the first paint. The parity test asserts these equal the flat map's
  // FALLBACK_KIND_COLORS and the published meta.json.
  //
  // DECLARED ABOVE the `const OVERLAYS` that calls it: a const below
  // its use is in the temporal dead zone and the WHOLE module fails to
  // evaluate (the isobar colour lesson — the layer is dead and nothing
  // says so).
  const BASIN_SCHEMES = {
    blue: null,                                    // -> published kind_colors
    red: { river: "#ef4444", coast: "#f87171", interior: "#7f1d1d" },
    black: { river: "#0a0a0a", coast: "#1c1c1c", interior: "#333333" },
  };
  const BASIN_KIND_COLORS = { river: "#38bdf8", coast: "#22d3ee", interior: "#a78bfa" };
  // The OUTLINE's own base. It shares the scheme's colour with the fill
  // but NOT its opacity: a wash at 0.16 and a hairline that has to read
  // over it are two different jobs.
  const BASIN_LINE_OPACITY = 0.85;

  function basinColors() {
    let name = "blue";
    try {
      const v = localStorage.getItem("xyzo.basinScheme");
      if (v && Object.prototype.hasOwnProperty.call(BASIN_SCHEMES, v)) name = v;
    } catch (_) { /* private mode: the default stands */ }
    return BASIN_SCHEMES[name] || BASIN_KIND_COLORS;
  }

  // A MapLibre `match` on the feature's own `kind`, so one toggle still
  // shows three basins the way the flat map does (river / coastal /
  // interior) rather than flattening them to a single hue.
  function basinKindColor(c) {
    return ["match", ["get", "kind"],
      "river", c.river, "coast", c.coast, "interior", c.interior,
      c.river];
  }

  function basinPaint() {
    const c = basinColors();
    const rgb = basinKindColor(c);
    return {
      "fill-color": rgb,
      "fill-opacity": 0.16,
      "fill-outline-color": rgb,
      "line-opacity": BASIN_LINE_OPACITY,
    };
  }

  // ── overlays ──────────────────────────────────────────────────────────
  // The same assets the flat map uses, so the two views agree.
  const OVERLAYS = [
    {
      key: "koppen",
      label: "🌍 Köppen Climate",
      type: "raster",
      tiles: [q("/data/koppen/tiles/{z}/{x}/{y}.png")],
      maxzoom: 6,
      opacity: 0.5,
    },
    {
      key: "soil",
      label: "🟫 Soil",
      type: "raster",
      tiles: [q("/data/soil/texture/tiles/{z}/{x}/{y}.png")],
      maxzoom: 6,
      opacity: 0.55,
      // TEN property pyramids; the switcher below swaps which one the
      // single "soil" checkbox controls. Same set as the flat map —
      // panel-parity pins the label, and a missing chip would be a
      // silent 2D/3D divergence.
      props: ["texture", "wrb", "usda", "clay", "sand", "silt", "phh2o", "soc", "bdod", "cec"],
    },
    {
      key: "cropland",
      label: "🌾 Cropland (ESA)",
      type: "raster",
      tiles: [q("/data/cropland/cropland/tiles/{z}/{x}/{y}.png")],
      maxzoom: 6,
      opacity: 0.55,
    },
    {
      key: "landcover",
      label: "🗺️ Land Cover (ESA)",
      type: "raster",
      tiles: [q("/data/cropland/landcover/tiles/{z}/{x}/{y}.png")],
      maxzoom: 6,
      opacity: 0.55,
    },
    {
      key: "geology",
      label: "🪨 Geology (Macrostrat)",
      type: "raster",
      tiles: ["/api/tile/mirror/macrostrat/{z}/{x}/{y}"],
      tileSize: 512,
      maxzoom: 14,
      opacity: 0.7,
    },
    {
      key: "nasa-sat",
      label: "🛰️ NASA Satellite (True Color)",
      type: "raster",
      tiles: [q("/api/tile/satellite/" + nasaDate(1) + "/{z}/{y}/{x}")],
      maxzoom: 9,
      opacity: 0.85,
    },
    {
      key: "nasa-rain",
      label: "🌧️ NASA Rain Rate (IMERG)",
      type: "raster",
      tiles: [q("/api/tile/rain/" + nasaDate(2) + "/{z}/{y}/{x}")],
      // Level6 supports zoom 0..6 — asking for 7+ returns HTTP 400 from GIBS.
      maxzoom: 6,
      opacity: 0.65,
    },
    {
      key: "nasa-night",
      label: "🌌 NASA Earth at Night",
      type: "raster",
      tiles: [q("/api/tile/night/2016-01-01/{z}/{y}/{x}")],
      maxzoom: 8,
      opacity: 0.8,
    },
    {
      key: "facebook",
      label: "🤝 Facebook Friendships",
      type: "raster",
      tiles: [q("/data/facebook/tiles/{z}/{x}/{y}.png")],
      maxzoom: 5,
      opacity: 0.6,
    },
    {
      key: "rivers",
      label: "💧 Rivers",
      type: "line",
      url: q("/data/rivers/rivers.geojson"),
      opacity: 0.85,
      // `line-opacity` here is the paint's INTRINSIC base, and the slider
      // multiplies it (see baseOpacity). It used to be 0.85 — which
      // equalled the slider default, so the old replace-don't-multiply
      // bug was invisible on rivers while it buried the basins. Now that
      // the two multiply, 1.0 keeps rivers at exactly the strength it has
      // always shipped at. (The flat map's river-layer uses 0.9 *
      // state.opacity, so drop this to 0.9 if you want the two views to
      // match rather than to stay put.)
      paint: { "line-color": "#3b82f6", "line-width": 1.1, "line-opacity": 1.0 },
    },
    {
      key: "basins",
      label: "🌊 Hydrological Basins",
      type: "fill",
      // NOT a URL. The single basins.geojson stopped being built when
      // the layer split into two detail levels (0.05° major / 0.01°
      // detailed) — pointing at the old filename404'd, so the globe's
      // basins overlay rendered nothing while every other layer worked.
      // The source starts empty and loadBasins() fills it from
      // meta.levels[].file, exactly as the flat map's levelUrl() does.
      url: { type: "FeatureCollection", features: [] },
      opacity: 0.7,
      // basinPaint() — the reader's stored scheme (blue/red/black),
      // coloured per kind, with the OUTLINE at its own 0.85 base rather
      // than the fill's 0.16. See the block above OVERLAYS.
      paint: basinPaint(),
    },
    {
      // Magnetic field as ONE toggle, matching the flat map's single
      // entry: whichever component × value the switcher below picks
      // (D / F / H / I, main field or change-per-year) is drawn as that
      // field's contour family PLUS a colour wash, both under this one
      // opacity slider. Only the index contours are drawn here — the
      // globe's fixed world view would turn the intermediate mesh into
      // a hairball, which is why the family names live in meta.json and
      // never in this file.
      key: "mag",
      label: "🧭 Magnetic Field (WMM)",
      type: "mag",
      // 0.9 = mag-layer.js's own default. The two views' defaults are
      // pinned equal by tests/panel-parity.bun.test.js.
      opacity: 0.9,
    },
    {
      // Isobars arrive from the API as {items:[{level_hpa,coordinates}]}
      // — a fetch-and-convert, not a static file, so they get their
      // own type and are loaded once at boot.
      key: "isobars",
      label: "⛅ Pressure lines (isobars)",
      type: "isobars",
      opacity: 0.85,
    },
    {
      // Temperature: the GFS 2 m grid painted once into an equirectangular
      // canvas and draped as a MapLibre image source. The flat map uses a
      // Mercator GridLayer; an image source with world coordinates is the
      // MapLibre-native equivalent and warps onto the globe correctly.
      key: "temp",
      label: "🌡️ Temperature (GFS)",
      type: "temp",
      // 0.9 = temp-layer.js's own default (was 0.55 here, so the same
      // overlay opened visibly fainter in 3D than on the flat map).
      opacity: 0.9,
    },
    {
      // Lightning density: the WWLLN 5 arc-minute global climatology,
      // painted once into a MERCATOR canvas and draped as a MapLibre
      // image source — the same trick as the temperature field. Only
      // the ANNUAL mean is carried to the globe: the globe is a fixed
      // world view, and the month switcher is a flat-map affordance.
      key: "lightning",
      label: "⚡ Lightning density (WWLLN)",
      type: "lightning",
      // 0.9 = lightning-layer.js's own default (was 0.85 here).
      opacity: 0.9,
    },
    {
      // The GFS 10 m wind SPEED field — the MAGNITUDE of the same u/v
      // pair the animation draws. On the globe it is a Mercator-baked
      // picture, exactly like the temperature field, so the two views
      // show the same numbers.
      key: "wind-speed",
      label: "🌬️ Wind speed (GFS)",
      type: "wind-speed",
      // 0.4 = wind-speed-layer.js's own default (a wash, not a wall).
      opacity: 0.4,
    },
    {
      // The GFS 10 m wind ANIMATION. The globe has no Leaflet pane and
      // no Leaflet CRS, so this is its own renderer: the particles live
      // in geographic space, are projected with map.project() each
      // frame, and are culled by a back-face test — a particle on the
      // far side of the sphere has no meaningful screen position.
      key: "wind",
      label: "💨 Wind (GFS)",
      type: "wind",
      // 0.95 = wind-layer.js's own default.
      opacity: 0.95,
    },
    {
      // The OSCAR ocean currents — the surface-current u/v pair,
      // animated with the same engine as the wind (globe-wind.js) over
      // the same physics. The particles live in geographic space and
      // are culled on the far side of the sphere, so the flow reads
      // correctly on a globe and not only on a flat map.
      key: "ocean-current",
      label: "🌊 Ocean currents (OSCAR)",
      type: "wind",
      // 0.85 = ocean-current-layer.js's own default.
      opacity: 0.85,
      source: "ocean",
    },
    {
      // The USGS earthquake catalogue, saved on our own disk by
      // scripts/earthquake_build.py. A GeoJSON source, so MapLibre
      // reprojects it onto the sphere for us — the same picture as the
      // flat map, with no second renderer.
      key: "earthquakes",
      label: "🌐 Earthquakes (USGS)",
      type: "quake",
      // 0.9 = earthquake-layer.js's own default.
      opacity: 0.9,
    },
    {
      // The USGS Quaternary Fault and Fold Database's traces plus the
      // global plate boundaries — lines, so they reproject natively.
      key: "faults",
      label: "🪨 Tectonic faults (USGS)",
      type: "faults",
      // 0.85 = fault-layer.js's own default.
      opacity: 0.85,
    },
    {
      // The Glottolog language REGIONS — one polygon per country, with
      // the languages spoken there. A fill, so it reprojects natively.
      key: "language-regions",
      label: "🌍 Language regions",
      type: "langregions",
      // 0.8 = languages-regions-layer.js's own default.
      opacity: 0.8,
    },
  ];

  // Tell the handoff WHAT THIS VIEW CAN DRAW. Anything in an incoming
  // link that is not one of these keys cannot be shown here and cannot
  // be switched off here either — so view-handoff.js puts it back in the
  // "Back to the map" link. Without this a single visit to 3D amputates
  // the overlays the globe has no way to render (the owner's link lost
  // population, HWSD soil and the FAO rivers that way).
  if (window.XYZO_HANDOFF && typeof window.XYZO_HANDOFF.registerGlobeKeys === "function") {
    window.XYZO_HANDOFF.registerGlobeKeys(OVERLAYS.map((o) => o.key));
  }

  // ── map ───────────────────────────────────────────────────────────────
  const map = new maplibregl.Map({
    container: "globe",
    style: {
      version: 8,
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
      sources: {
        basemap: {
          type: "raster",
          tiles: ["/api/tile/mirror/esri-imagery/{z}/{x}/{y}"],
          tileSize: 256,
          maxzoom: 13,
          attribution: "Source: Esri, Maxar, Earthstar Geographics",
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    },
    center: [10, 22],
    zoom: 2.1,
    attributionControl: true,
    // The globe IS the point — but the projection can be switched.
    // NOTE: MapLibre 5.6 IGNORES the constructor's `projection` option
    // (getProjection() stays null), so it is set in the load handler.
    maxPitch: 85,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), "bottom-right");

  // ── overlay sources + layers ──────────────────────────────────────────
  // MapLibre refuses addSource()/addLayer() before the style is loaded
  // ("Style is not done loading"), so everything is built in the load
  // handler below.
  const overlayState = {};
  // The wind ANIMATION is a canvas over the map, not a MapLibre layer,
  // so it needs its own handle: applyVisibility()/applyOpacity() reach
  // it through here.
  // The ANIMATIONS (the wind and the ocean currents) are canvases over
  // the map, not MapLibre layers, so each needs its own controller —
  // and it needs to be KEYED. There used to be ONE variable, and the
  // second animation created (the ocean currents) overwrote the first
  // (the wind): switching the wind on switched the OCEAN CURRENTS on
  // instead, and the wind never animated at all. A map, not a variable.
  const windControllers = {};
  // Which earthquake window the globe is showing (1 h / 24 h / 7 d /
  // 30 d). The chip row under the earthquake row switches it.
  let quakeWindow = "week";

  // Isobar colour ramp — same stops as the flat map's isobar-layer.js.
  const ISOBAR_STOPS = [
    { hpa: 960, color: "#4c1d95" },
    { hpa: 980, color: "#2563eb" },
    { hpa: 1000, color: "#06b6d4" },
    { hpa: 1012, color: "#22c55e" },
    { hpa: 1020, color: "#eab308" },
    { hpa: 1035, color: "#ea580c" },
    { hpa: 1055, color: "#b91c1c" },
  ];
  // The isobar COLOUR scheme a shared link asked for.
  //
  // The flat map offers these six choices and writes the choice into
  // `iso=<step>:<colour>`; the globe has to mean the same thing by it,
  // or a link is exact in one view and different in the other. The
  // schemes come from the SHARED ramp-styles.js (loaded by both pages)
  // so there is one `recolor`; the three inks are listed here as three
  // hex values because they are colours, not schemes — a change in
  // isobar-layer.js's COLOUR_CHOICES must be mirrored here.
  const ISO_INKS = { red: "#ef4444", white: "#f9fafb", black: "#111827" };
  let isoColourInUse = "pressure";
  let isoStops = ISOBAR_STOPS;

  function resolveIsoStops(colour) {
    isoColourInUse = colour || "pressure";
    if (ISO_INKS[isoColourInUse]) { isoStops = null; return null; }
    const R = window.RampStyles;
    if (isoColourInUse === "pressure" || !R || typeof R.recolor !== "function") {
      isoStops = ISOBAR_STOPS;
      return isoStops;
    }
    const out = R.recolor(
      ISOBAR_STOPS.map((s) => ({ c: s.hpa, rgb: s.color })), isoColourInUse);
    isoStops = ISOBAR_STOPS.map((s, i) => ({
      hpa: s.hpa, color: (out[i] && out[i].rgb) || s.color,
    }));
    return isoStops;
  }

  // A single ink: every line the same colour, whatever the pressure.
  function isobarInk() {
    return ISO_INKS[isoColourInUse] || null;
  }

  function isobarColor(hpa) {
    const stops = isoStops;
    if (hpa <= stops[0].hpa) return stops[0].color;
    const last = stops[stops.length - 1];
    if (hpa >= last.hpa) return last.color;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (hpa >= a.hpa && hpa <= b.hpa) {
        const t = (hpa - a.hpa) / (b.hpa - a.hpa);
        const pa = parseInt(a.color.slice(1), 16), pb = parseInt(b.color.slice(1), 16);
        const r = Math.round(((pa >> 16) & 255) + ((((pb >> 16) & 255) - ((pa >> 16) & 255)) * t));
        const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
        const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
        return "rgb(" + r + "," + g + "," + bl + ")";
      }
    }
    return last.color;
  }

  // The intrinsic translucency written into an overlay's own `paint`,
  // as distinct from the user's slider. The two are MULTIPLIED, not
  // substituted — the flat map has always done it this way
  // (basin-layer: `fillOpacity: 0.16 * state.opacity`,
  //  river-layer: `opacity: 0.9 * state.opacity`).
  //
  // The globe used to REPLACE the base with the slider, so an overlay
  // whose paint carries a deliberate low opacity lost it: basins is the
  // one that showed, because its base is 0.16 and the slider default is
  // 0.7. Measured at runtime, `basins@100` applied fill-opacity 1.0 —
  // fully opaque — and the whole globe became a flat cyan sheet with the
  // satellite, Köppen, soil and every other layer underneath buried.
  // At `basins@35` it applied 0.35, still 2.2x the intended wash.
  function baseOpacity(o, prop) {
    const v = o.paint && o.paint[prop];
    return typeof v === "number" && v >= 0 && v <= 1 ? v : 1;
  }

  function layerIdsFor(o) {
    if (o.type === "fill") return [o.key, o.key + "-line"];
    // Mag is ONE line layer for the SELECTED field plus ONE colour wash
    // (added the first time a field is baked, so it may not exist yet —
    // applyVisibility/applyOpacity both skip ids with no layer). Both
    // ids are STATIC, so a field switch swaps data through them and
    // visibility/opacity have nowhere to lag behind. Listing the three
    // per-family line ids instead is how a fourth family shipped
    // invisible: the list and the adder are two places to forget.
    if (o.type === "mag") return [o.key + "-lines", o.key + "-wash"];
    return [o.key];
  }

  function addOverlay(o) {
    const saved = (settings.overlays && settings.overlays[o.key]) || {};
    const startOpacity = typeof saved.opacity === "number" ? saved.opacity : o.opacity;
    const startEnabled = typeof saved.enabled === "boolean" ? saved.enabled : false;
    overlayState[o.key] = { enabled: startEnabled, opacity: startOpacity, def: o };

    if (o.type === "raster") {
      // A multi-property overlay (soil) restores the saved property's
      // tiles, not the hardcoded default.
      let tiles = o.tiles;
      if (o.props && saved.prop && o.props.indexOf(saved.prop) !== -1) {
        tiles = [q("/data/soil/" + saved.prop + "/tiles/{z}/{x}/{y}.png")];
      }
      map.addSource(o.key, {
        type: "raster",
        tiles: tiles,
        tileSize: o.tileSize || 256,
        maxzoom: o.maxzoom,
      });
      map.addLayer({
        id: o.key,
        type: "raster",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: { "raster-opacity": startOpacity },
      });
    } else if (o.type === "line") {
      map.addSource(o.key, { type: "geojson", data: o.url });
      map.addLayer({
        id: o.key,
        type: "line",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: { ...o.paint, "line-opacity": baseOpacity(o, "line-opacity") * startOpacity },
      });
    } else if (o.type === "fill") {
      map.addSource(o.key, { type: "geojson", data: o.url });
      map.addLayer({
        id: o.key,
        type: "fill",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          "fill-color": o.paint["fill-color"],
          "fill-opacity": baseOpacity(o, "fill-opacity") * startOpacity,
          "fill-outline-color": o.paint["fill-outline-color"],
        },
      });
      map.addLayer({
        id: o.key + "-line",
        type: "line",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          // The scheme's colour, per kind — the same expression the
          // fill above gets, so the hairline outlines the shape it
          // belongs to instead of one flat hue.
          "line-color": o.paint["fill-outline-color"] || "#38bdf8",
          "line-width": 0.8,
          // The OUTLINE's own base, not the fill's. It was reading
          // baseOpacity(o, "fill-opacity") = 0.16, so a 0.8 px hairline
          // was painted at a sixth of the flat map's 0.85 and the owner
          // saw no outlines at all. It still scales with the slider —
          // the two just no longer share one number.
          "line-opacity": baseOpacity(o, "line-opacity") * startOpacity,
        },
      });
    } else if (o.type === "mag") {
      // ONE source + line layer, carrying whichever field is selected —
      // the globe shows one component at a time, the same rule the flat
      // map's selector implies, and loadMag() swaps the source's data
      // when the chips change. Only the INDEX (major) contours are
      // drawn: `!= false` keeps the intermediate 2° mesh out of the
      // globe's fixed world view (the rank the flat map hides below
      // zoom 4), and is written `!= false` rather than `== true` so a
      // GeoJSON from before the major flag existed (every feature was an
      // index line then) still renders instead of blanking on a stale
      // browser cache.
      //
      // The WASH source/layer are added by loadMag() once the field has
      // been baked: an empty-url image source makes MapLibre throw.
      map.addSource(o.key + "-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: o.key + "-lines",
        type: "line",
        source: o.key + "-lines",
        filter: ["!=", ["get", "major"], false],
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          "line-color": "#111827",
          "line-width": ["case", ["has", "special"], 2.2, 1.1],
          "line-opacity": startOpacity,
        },
      });
    } else if (o.type === "isobars") {
      // The source starts empty; loadIsobars() fills it once the API
      // answers. The layer exists immediately so the checkbox works.
      map.addSource(o.key, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: o.key,
        type: "line",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 0.8,
          "line-opacity": startOpacity,
        },
      });
    } else if (o.type === "temp") {
      // No source/layer yet — loadTemp() adds both once the grid has
      // been baked. An empty-url image source makes MapLibre throw.
      // The checkbox still works: applyVisibility() is a no-op until
      // the layer exists, and loadTemp() reads st.enabled on arrival.
    } else if (o.type === "lightning") {
      // Same as the temperature field: loadLightning() adds the source
      // and the layer once the grid has been baked and draped.
    } else if (o.type === "wind-speed") {
      // The speed field is a Mercator-baked picture, like the
      // temperature: addWindSpeed() adds the source and the layer once
      // the grid has arrived. An empty-url image source makes MapLibre
      // throw, so nothing is added here.
    } else if (o.type === "wind") {
      // The ANIMATION is not a MapLibre layer at all — it is a canvas
      // over the map, driven by globe-wind.js. Its controller is
      // created here and toggled by applyVisibility().
      const ctrl = window.XYZO_GLOBE_WIND
        ? window.XYZO_GLOBE_WIND.createAnimation(map, o.key, startOpacity, o.source)
        : null;
      windControllers[o.key] = ctrl;
      if (ctrl && startEnabled) ctrl.setEnabled(true);
    } else if (o.type === "quake") {
      // The earthquake catalogue: circles whose radius grows with the
      // magnitude and whose colour cools with the age — the same
      // encoding the flat map uses, so the two views agree.
      map.addSource(o.key, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: o.key,
        type: "circle",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["coalesce", ["get", "mag"], 0],
            0, 2, 2, 3, 4, 6, 6, 11, 8, 18,
          ],
          "circle-color": [
            "match", ["get", "ageClass"],
            "hour", "#ff2d2d",
            "day", "#ff7a1a",
            "week", "#ffd21f",
            "month", "#4aa3ff",
            "#8b9bb4",
          ],
          "circle-opacity": 0.85,
          "circle-stroke-color": "#0b1220",
          "circle-stroke-width": 0.6,
        },
      });
    } else if (o.type === "faults") {
      // The fault traces and the plate boundaries — lines, so MapLibre
      // reprojects them onto the sphere for us.
      map.addSource(o.key, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: o.key,
        type: "line",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          "line-color": [
            "match", ["get", "kind"],
            "plate-boundary", "#f97316",
            "#e879f9",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 4, 1.4],
          "line-opacity": startOpacity,
        },
      });
    } else if (o.type === "langregions") {
      // The language regions — one polygon per country, coloured by how
      // many languages are spoken there.
      map.addSource(o.key, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: o.key,
        type: "fill",
        source: o.key,
        layout: { visibility: startEnabled ? "visible" : "none" },
        paint: {
          "fill-color": "#38bdf8",
          "fill-opacity": 0.16 * startOpacity,
          "fill-outline-color": "#38bdf8",
        },
      });
    }
  }

  // The three GeoJSON overlays: fetch the published file and hand it to
  // the source. The source starts empty, so the checkbox works from the
  // first paint.
  async function loadGeoOverlay(key, url, onDone) {
    try {
      const fc = await fetch(url, { cache: "default" })
        .then((r) => {
          if (!r.ok) throw new Error(key + " " + r.status);
          return r.json();
        });
      const src = map.getSource(key);
      if (src) src.setData(fc);
      if (onDone) onDone(fc);
    } catch (_) { /* offline — the layer stays empty, never broken */ }
  }

  // ── async overlay data (isobars + temperature) ───────────────────────
  // Both fetch at boot regardless of the checkbox state, so the first
  // toggle is instant. Failures leave the layer empty, never broken.

  // The GFS 10 m wind SPEED field. Same construction as the
  // temperature: the magnitude of the published u/v pair, baked in
  // MERCATOR and draped as an image source. The u/v bytes are the ones
  // the wind animation uses too — one download, two overlays.
  let windSpeedReady = false;
  async function loadWindSpeed() {
    if (windSpeedReady) return;
    if (!window.XYZO_GLOBE_WIND) return;
    try {
      // The state is read WHEN THE LAYER IS CREATED, not now: the bake
      // takes a fetch, and by the time it lands a shared link may have
      // switched the layer on and moved its slider. Reading it early
      // left the layer hidden at the wrong opacity.
      await window.XYZO_GLOBE_WIND.addSpeedLayer(map, "wind-speed", () => {
        const st = overlayState["wind-speed"];
        return { opacity: st ? st.opacity : 0.4, enabled: !!(st && st.enabled) };
      });
      windSpeedReady = true;
    } catch (_) { /* offline or bad grid — the layer stays absent */ }
  }

  // The globe's own default isobar density — see loadIsobars() for why
  // it is a default rather than a fixed value.
  const GLOBE_ISO_STEP = 2;
  // The detail actually in use, so the globe can write it back into the
  // hash it owns.
  let isoStepInUse = GLOBE_ISO_STEP;
  // The ANALYSIS actually in use, the same reason.
  let isoSourceInUse = "auto";

  // The detail a SHARED LINK asked for, if any. The flat map writes it
  // as `iso=<hPa>` or `iso=<hPa>:<colour>` and the handoff passes the
  // segment through untouched, so a link that says `iso=1:red` must
  // open at 1 hPa, in red, here too.
  //
  // It is read with a REGEX, not with `Number(part.slice(4))`: the
  // colour suffix makes a bare Number() return NaN, which the validity
  // check then rejects — the whole segment would be silently dropped.
  function globeIso() {
    try {
      const raw = (typeof INCOMING_HASH === "string" ? INCOMING_HASH : location.hash) || "";
      const part = raw.replace(/^#/, "").split("/").find((p) => p.indexOf("iso=") === 0);
      if (!part) return null;
      const m = part.slice(4).match(/^(\d+(?:\.\d+)?)(?::([a-z]+))?/);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) return null;
      return { step: n, colour: m[2] || null };
    } catch (_) {
      return null;
    }
  }
  function globeIsoStep() {
    const iso = globeIso();
    return iso ? iso.step : null;
  }
  function globeIsoColour() {
    const iso = globeIso();
    return iso ? iso.colour : null;
  }
  // WHICH analysis the pressure lines are drawn from: `isoSrc=ecmwf`.
  //
  // The flat map writes it into the link (the three analyses are
  // different pictures of the same atmosphere), and the handoff passes
  // the segment through untouched — so the globe has to read it, or a
  // link that asked for ECMWF opens here on whichever analysis the API
  // picks.
  function globeIsoSource() {
    try {
      var raw = (typeof INCOMING_HASH === "string" ? INCOMING_HASH : location.hash) || "";
      var part = raw.replace(/^#/, "").split("/").find(function (p) { return p.indexOf("isoSrc=") === 0; });
      if (!part) return null;
      var id = part.slice(7).trim();
      if (["auto", "ecmwf", "gfs", "hrrr"].indexOf(id) === -1) return null;
      return id;
    } catch (_) {
      return null;
    }
  }

  async function loadBasins() {
    // Two detail levels, chosen by the PUBLISHED default — never a
    // hardcoded filename (that is how the old basins.geojson 404'd).
    try {
      const meta = await fetch(q("/data/basins/meta.json"), { cache: "no-cache" })
        .then((r) => {
          if (!r.ok) throw new Error("basins meta " + r.status);
          return r.json();
        });
      const levels = Array.isArray(meta.levels) ? meta.levels : [];
      const def = levels.find((l) => l.id === meta.default_level) || levels[0];
      if (!def || !def.file) return;
      const fc = await fetch(q("/data/basins/" + def.file), { cache: "no-cache" })
        .then((r) => {
          if (!r.ok) throw new Error(def.file + " " + r.status);
          return r.json();
        });
      const src = map.getSource("basins");
      if (src) src.setData(fc);
    } catch (_) { /* offline or no data — the layer stays empty */ }
  }

  async function loadIsobars() {
    try {
      // The globe's own default density, and the reason for it.
      //
      // The globe has NO detail control — it is one fixed world view, so
      // it must pick a density rather than offer one. Without a `step`
      // the API returns EVERY published level, and the published set is
      // the finest one (1 hPa), so the globe would silently double in
      // density AND in payload the moment the worker published a finer
      // interval — a hairball at ~1,100 lines and ~626 KB for a view
      // that is not zoomable. 2 hPa is the globe's default.
      //
      // A SHARED LINK overrides it. The flat map writes the detail into
      // the URL as `iso=1`, and the handoff passes that segment through
      // untouched, so a link that asked for 1 hPa should open at 1 hPa
      // here too — otherwise "share the exact map" is exact in one view
      // and a different map in the other.
      const step = globeIsoStep() || GLOBE_ISO_STEP;
      // The COLOUR too — the whole of `iso=<step>:<colour>`. Resolved
      // BEFORE the features are built, because that is where the colour
      // of each line is decided.
      resolveIsoStops(globeIsoColour());
      // Record it BEFORE the fetch, not after. The globe's own hash
      // writer runs on the first moveend, which can beat this fetch
      // completing — and it must write the step the globe is actually
      // drawing. With the assignment after the await, a shared link's
      // `iso=1` was rewritten to `iso=2` and the detail was lost on the
      // way back to the flat map.
      isoStepInUse = step;
      // WHICH analysis, the same rule: recorded before the fetch, and
      // passed to the API so a link that asked for ECMWF's pressure
      // field opens here on ECMWF's pressure field.
      const isoSrc = globeIsoSource() || "auto";
      isoSourceInUse = isoSrc;
      const ink = isobarInk();
      // THE LIMIT IS FOR THE WHOLE WORLD, so it must clear the finest
      // step's whole-world line count with room to spare — the same
      // headroom trap the flat map's own 12,000 default had (11,152
      // lines at step 0.1: 7 % of headroom, so one extra line anywhere
      // and the response is TRUNCATED with no error, silently dropping
      // lines). At step 0.1 this fetch wants ~11,100 lines (the polar
      // rows are dropped), and 30,000 is the API's own ceiling.
      const res = await fetch(
        `/api/weather/isobars?bbox=-180,-85,180,85&limit=30000&step=${step}` +
          `&source=${encodeURIComponent(isoSrc)}`,
        { cache: "default" });
      if (!res.ok) return;
      const data = await res.json();
      const features = [];
      for (const item of data.items || []) {
        const coords = item.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        // The API returns a single LineString's coordinate array per
        // item; defend against a MultiLineString slipping through.
        const geomType = typeof coords[0][0] === "number" ? "LineString" : "MultiLineString";
        features.push({
          type: "Feature",
          geometry: { type: geomType, coordinates: coords },
          properties: {
            level: item.level_hpa,
            color: ink || isobarColor(item.level_hpa),
          },
        });
      }
      const src = map.getSource("isobars");
      if (src) src.setData({ type: "FeatureCollection", features });
    } catch (_) { /* offline or slow — the layer stays empty */ }
  }

  async function loadTemp() {
    try {
      // The COARSE pair: the globe bakes the temperature into an
      // equirectangular picture, so a 1° lattice is right there — and it
      // keeps the 0.7 MB off every globe visit.
      // `meta-1deg.json` describes `grid-1deg.bin` — the SAME analysis,
      // the SAME run, subsampled to 1° by the worker, so the two cannot
      // disagree.
      const [meta, buf] = await Promise.all([
        fetch(q("/data/temp/meta-1deg.json"), { cache: "no-cache" }).then((r) => r.json()),
        fetch(q("/data/temp/grid-1deg.bin"), { cache: "no-cache" }).then((r) => r.arrayBuffer()),
      ]);
      const grid = new Int16Array(buf);
      const g = meta.grid;
      if (grid.length !== g.rows * g.cols) return;

      // The ramp and the bake arithmetic live in field-bake.js, which
      // the flat map's temp-layer.js reads too — ONE ramp, ONE mapping,
      // two views.
      //
      // THE BAKE IS MERCATOR, NOT LATITUDE. MapLibre's image source
      // turns its four corners into mercator coordinates and stretches
      // the texture across that mercator rectangle, so the texture's V
      // axis is mercator. The globe used to bake rows linear in
      // latitude and drape that as if it were mercator: the picture was
      // sampled with the wrong row for every latitude except the
      // equator, so 45°N showed the Sahara's 38 °C instead of the Bay
      // of Biscay's 11 °C and the poles came out HOT. Measured on the
      // 2026-11-03 cycle, the value painted at 45°N was 27 °C too
      // warm. Baking in mercator also makes the globe show the same
      // picture as the flat map, whose tile grid is mercator too.
      const ramp = meta.ramp || [];
      const invScale = 1 / g.scale;
      const colorAt = (raw) => {
        const c = raw * invScale;
        const rgb = XYZO_FIELD_BAKE.rampColor(ramp, c);
        return [rgb[0], rgb[1], rgb[2], 255];
      };
      const canvas = XYZO_FIELD_BAKE.bakeMercator({
        grid: g, data: grid, width: 1024, height: 1024, colorAt: colorAt,
      });

      // Add the baked canvas as an image source draped over the world.
      // MapLibre accepts a data URL as an image source's url.
      // The corners stop at the MERCATOR LIMIT, not at ±90: the picture
      // IS mercator, so its quad has to be the mercator world too, and
      // projecting ±90° yields y=Infinity ("x=0, y=Infinity, z=0
      // outside of bounds") and the source silently never renders.
      map.addSource("temp", {
        type: "image",
        url: canvas.toDataURL("image/png"),
        coordinates: XYZO_FIELD_BAKE.mercatorQuad(),
      });
      const st = overlayState.temp;
      map.addLayer({
        id: "temp",
        type: "raster",
        source: "temp",
        layout: { visibility: st && st.enabled ? "visible" : "none" },
        paint: { "raster-opacity": st ? st.opacity : 0.55 },
      });
    } catch (_) { /* offline or bad grid — the layer stays empty */ }
  }

  // The lightning climatology is a POWER LAW ramp over the stored value,
  // and the alpha is separate from the colour so the places with no
  // lightning stay transparent. The flat map's lightning-layer.js builds
  // the same table; here it is built once and the whole field is baked
  // into an equirectangular canvas, because a globe has no tiles.
  async function loadLightning() {
    try {
      const [meta, buf] = await Promise.all([
        fetch(q("/data/lightning/meta.json"), { cache: "no-cache" }).then((r) => r.json()),
        fetch(q("/data/lightning/grid_annual.bin"), { cache: "no-cache" }).then((r) => r.arrayBuffer()),
      ]);
      const g = meta.grid;
      const grid = new Uint16Array(buf);
      if (grid.length !== g.rows * g.cols) return;

      const ramp = meta.ramp || [];
      const alphaStops = meta.alpha || [];
      const hexToRgb = (hex) => {
        const v = parseInt(hex.slice(1), 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      };
      const rampAt = (t) => {
        if (!ramp.length) return [128, 128, 128];
        if (t <= ramp[0].t) return hexToRgb(ramp[0].rgb);
        const last = ramp[ramp.length - 1];
        if (t >= last.t) return hexToRgb(last.rgb);
        for (let i = 0; i < ramp.length - 1; i++) {
          const a = ramp[i], b = ramp[i + 1];
          if (t >= a.t && t <= b.t) {
            const f = (t - a.t) / (b.t - a.t);
            const ca = hexToRgb(a.rgb), cb = hexToRgb(b.rgb);
            return [
              Math.round(ca[0] + (cb[0] - ca[0]) * f),
              Math.round(ca[1] + (cb[1] - ca[1]) * f),
              Math.round(ca[2] + (cb[2] - ca[2]) * f),
            ];
          }
        }
        return hexToRgb(last.rgb);
      };
      const alphaAt = (t) => {
        if (!alphaStops.length) return 255;
        if (t <= alphaStops[0].t) return alphaStops[0].a;
        const last = alphaStops[alphaStops.length - 1];
        if (t >= last.t) return last.a;
        for (let i = 0; i < alphaStops.length - 1; i++) {
          const a = alphaStops[i], b = alphaStops[i + 1];
          if (t >= a.t && t <= b.t) {
            const f = (t - a.t) / (b.t - a.t);
            return Math.round(a.a + (b.a - a.a) * f);
          }
        }
        return last.a;
      };

      // One table, indexed by the stored value, exactly like the flat
      // map: painting a pixel is an array read, not a pow().
      const LUT_SIZE = 8192;
      const lut = new Uint8Array(LUT_SIZE * 4);
      for (let i = 0; i < LUT_SIZE; i++) {
        const v = i * g.scale;
        let t = 0;
        if (v > 0) {
          t = Math.pow(v / meta.v_max, meta.power);
          if (t > 1) t = 1;
        }
        const rgb = rampAt(t);
        lut[i * 4] = rgb[0];
        lut[i * 4 + 1] = rgb[1];
        lut[i * 4 + 2] = rgb[2];
        lut[i * 4 + 3] = alphaAt(t);
      }

      // Row 0 = the TOP of the MERCATOR world, not lat +90. An image
      // source is a quad in MERCATOR space, so the picture has to be
      // mercator too — the same reason the flat map's tiles are. See
      // loadTemp() for the whole story; the short version is that a
      // latitude bake sampled with the wrong row for every latitude
      // except the equator, and the globe showed the Sahara's heat at
      // 45°N.
      const W = 2048, H = 1024;
      const canvas = XYZO_FIELD_BAKE.bakeMercator({
        grid: g,
        data: grid,
        width: W,
        height: H,
        colorAt: (raw) => {
          let li = ((raw + 0.5) | 0) * 4;
          if (li < 0) li = 0;
          else if (li >= lut.length) li = lut.length - 4;
          return [lut[li], lut[li + 1], lut[li + 2], lut[li + 3]];
        },
      });

      // The corners stop at the MERCATOR LIMIT: the picture IS
      // mercator, so its quad is the mercator world. At ±90° the
      // projection is y=Infinity and the source silently never renders.
      map.addSource("lightning", {
        type: "image",
        url: canvas.toDataURL("image/png"),
        coordinates: XYZO_FIELD_BAKE.mercatorQuad(),
      });
      const st = overlayState.lightning;
      map.addLayer({
        id: "lightning",
        type: "raster",
        source: "lightning",
        layout: { visibility: st && st.enabled ? "visible" : "none" },
        paint: { "raster-opacity": st ? st.opacity : 0.85 },
      });
    } catch (_) { /* offline or bad grid — the layer stays empty */ }
  }

  // ── magnetic field (WMM) ─────────────────────────────────────────────
  // meta.json is the ENTIRE contract here: which components exist, which
  // file holds each plane, its Int16 scale, its ramp and range, whether
  // the blackout zone blanks it, and which contour family belongs to it.
  // globe.html loads only maplibre + globe.js — it has no Leaflet, so
  // mag-layer.js cannot come along — and reading the published table
  // instead of keeping a second one is the only way the two views can
  // never disagree about what a field IS.
  const magState = {
    meta: null,
    view: { component: "d", mode: "main" },
    planes: {},        // field key -> Int16Array
    planePromises: {},
    mask: null,
    maskPromise: null,
    gen: 0,            // a field switch mid-flight must not paint the old one
  };
  const MAG_MODE_LABELS = { main: "Main field", sv: "Change per year" };

  function magEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // component + mode -> the one field key that holds it. Scanned from
  // meta rather than reconstructed, so a field added to the worker
  // appears on the globe without touching this file.
  function magFieldKey(view) {
    const m = magState.meta;
    if (!m || !m.fields) return null;
    const v = view || magState.view;
    for (const k of Object.keys(m.fields)) {
      const f = m.fields[k];
      if (f.component === v.component && f.mode === v.mode) return k;
    }
    return null;
  }

  // Validate the view against what is actually published, falling back
  // to the first component — a remembered view from an older build must
  // render SOMETHING, not nothing.
  function magFieldKeyOrDefault() {
    let key = magFieldKey();
    if (key) return key;
    const comps = (magState.meta && magState.meta.components) || ["d"];
    magState.view = { component: comps[0], mode: "main" };
    key = magFieldKey();
    if (!key) {
      // Last resort: the first field of any kind.
      const any = magState.meta && magState.meta.fields && Object.keys(magState.meta.fields)[0];
      if (any) magState.view = {
        component: magState.meta.fields[any].component,
        mode: magState.meta.fields[any].mode,
      };
      key = magFieldKey();
    }
    return key;
  }

  function magComponents() {
    const m = magState.meta;
    return (m && m.components) || [];
  }

  function magModes() {
    const m = magState.meta;
    return (m && m.modes && Object.keys(m.modes)) || ["main"];
  }

  // Component chips are labelled by their MAIN-FIELD entry's own label
  // out of meta ("Declination", "Total force", ...) — no second list of
  // names to keep in step with the worker. The `|| uppercase` fallback is
  // for a meta.json published before the label existed: without it
  // magEsc(undefined) renders four EMPTY chips, and a user cannot tell
  // which button picks what (found by Playwright, 2026-10-30).
  function magComponentLabel(c) {
    const m = magState.meta;
    if (m && m.fields) {
      for (const k of Object.keys(m.fields)) {
        const f = m.fields[k];
        if (f.component === c && f.mode === "main" && f.label) return f.label;
      }
    }
    return String(c).toUpperCase();
  }

  async function magMask() {
    if (magState.mask) return magState.mask;
    if (!magState.maskPromise) {
      magState.maskPromise = fetch(q("/data/mag/mask.bin"), { cache: "no-cache" })
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          magState.mask = new Uint8Array(buf);
          magState.maskPromise = null;
          return magState.mask;
        })
        .catch((e) => {
          magState.maskPromise = null;
          throw e;
        });
    }
    return magState.maskPromise;
  }

  async function magPlane(key) {
    if (magState.planes[key]) return magState.planes[key];
    if (!magState.planePromises[key]) {
      const m = magState.meta;
      const f = m.fields[key];
      magState.planePromises[key] = Promise.all([
        fetch(q("/data/mag/" + f.file), { cache: "no-cache" }).then((r) => {
          if (!r.ok) throw new Error(f.file + " " + r.status);
          return r.arrayBuffer();
        }),
        // Only D and ΔD blank, so the mask is a nice-to-have: losing it
        // must cost the blackout transparency, not the whole field.
        magMask().catch(() => null),
      ])
        .then(([buf]) => {
          const arr = new Int16Array(buf);
          const g = m.grid;
          if (g && arr.length !== g.rows * g.cols) {
            throw new Error(f.file + " is " + arr.length + " values, expected " + g.rows * g.cols);
          }
          magState.planes[key] = arr;
          magState.planePromises[key] = null;
          return arr;
        })
        .catch((e) => {
          magState.planePromises[key] = null;
          throw e;
        });
    }
    return magState.planePromises[key];
  }

  // The flat map's rampColor(), re-implemented. NO ramp in meta.json is
  // evenly spaced in value — the diverging ones carry a flat plateau
  // around zero, and even the temperature ramp runs gaps of 4.2, 4.9,
  // 3.5, 2.1 °C. So a stop is always found by scanning for the
  // BRACKETING PAIR, never by indexing stops by value.
  //
  // An earlier version of this comment asserted that loadTemp()'s rgbOf
  // was safe because the temperature ramp had even spacing. meta.json
  // says otherwise, and that false reassurance shipped the bug: rgbOf
  // indexed the stops evenly, landed up to +4.9 °C too warm, and painted
  // 0 °C lime-yellow where the flat map paints green (114 RGB units
  // apart). rgbOf now scans for the bracketing pair too. Keep every ramp
  // lookup in this codebase the same way — one ramp, two renderers, and
  // segment interpolation is the only method they can share without
  // disagreeing.
  function magRampColor(ramp, v) {
    if (!ramp || !ramp.length) return [128, 128, 128];
    const hex = (h) => {
      const n = parseInt(h.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    if (v <= ramp[0].c) return hex(ramp[0].rgb);
    const last = ramp[ramp.length - 1];
    if (v >= last.c) return hex(last.rgb);
    for (let i = 0; i < ramp.length - 1; i++) {
      const a = ramp[i];
      const b = ramp[i + 1];
      if (v >= a.c && v <= b.c) {
        const t = b.c === a.c ? 0 : (v - a.c) / (b.c - a.c);
        const ca = hex(a.rgb);
        const cb = hex(b.rgb);
        return [
          Math.round(ca[0] + (cb[0] - ca[0]) * t),
          Math.round(ca[1] + (cb[1] - ca[1]) * t),
          Math.round(ca[2] + (cb[2] - ca[2]) * t),
        ];
      }
    }
    return hex(last.rgb);
  }

  // One MERCATOR canvas for the field, draped as an image source (the
  // temperature / lightning pattern). An image source is a quad in
  // MERCATOR space — MapLibre turns its four corners into mercator
  // coordinates and stretches the texture across that rectangle — so
  // the picture has to be mercator as well. A latitude bake put the
  // field in the wrong place on the sphere.
  //
  // The corners stop at the MERCATOR LIMIT: the picture IS mercator,
  // so its quad is the mercator world. Projecting the exact pole yields
  // y=Infinity and the source silently never renders.
  function bakeMag(key, plane) {
    const m = magState.meta;
    const field = m.fields[key];
    const g = m.grid;
    const scale = field.scale || g.scale || 100;
    const lo = (field.range && field.range[0]) || 0;
    const hi = (field.range && field.range[1]) || 1;
    const ramp = field.ramp || [];
    // The ALPHA table ({t, a} stops, t = ramp position) is what stops
    // the wash painting over the globe: near zero it is ~40/255 so the
    // earth underneath shows through the "nothing happening" zone. A
    // meta.json from before the table existed gets a fully opaque wash
    // (255 everywhere) — the old look, not a broken one.
    const alphaStops = field.alpha || [];
    const alphaAt = (t) => {
      if (!alphaStops.length) return 255;
      if (t <= alphaStops[0].t) return alphaStops[0].a;
      const last = alphaStops[alphaStops.length - 1];
      if (t >= last.t) return last.a;
      for (let i = 0; i < alphaStops.length - 1; i++) {
        const a = alphaStops[i], b = alphaStops[i + 1];
        if (t >= a.t && t <= b.t) {
          const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
          return Math.round(a.a + (b.a - a.a) * f);
        }
      }
      return last.a;
    };
    // One LUT entry per 1/1024 of the RANGE, so the table is
    // unit-agnostic — a fixed 0.25° step (the old flat-map value) would
    // have needed 180,001 entries for F's 45,000 nT span.
    const lutStep = (hi - lo) / 1024 || 1;
    const lut = new Uint8Array(1025 * 4);
    for (let i = 0; i <= 1024; i++) {
      const rgb = magRampColor(ramp, lo + i * lutStep);
      lut[i * 4] = rgb[0];
      lut[i * 4 + 1] = rgb[1];
      lut[i * 4 + 2] = rgb[2];
      lut[i * 4 + 3] = alphaAt(i / 1024);
    }
    const mask = field.boz ? magState.mask : null;

    // MERCATOR, for the same reason as the temperature and the
    // lightning: an image source is a quad in mercator space, so the
    // picture has to be mercator too. A latitude bake put the whole
    // magnetic field in the wrong place on the sphere — the declination
    // pattern is unmistakably wrong when the field is sampled with the
    // wrong row.
    const canvas = XYZO_FIELD_BAKE.bakeMercator({
      grid: g,
      data: plane,
      width: 1024,
      height: 1024,
      mask: mask,
      maskValue: 1,
      colorAt: (raw) => {
        const v = raw / scale;
        const k = Math.max(0, Math.min(1024, Math.round((v - lo) / lutStep)));
        return [lut[k * 4], lut[k * 4 + 1], lut[k * 4 + 2], lut[k * 4 + 3]];
      },
    });
    return canvas;
  }

  // Swap BOTH halves of the overlay to the selected field: the contour
  // family into the one GeoJSON source, and the wash as a fresh image
  // source. `gen` makes a fast second click win — without it a slow
  // first fetch can land last and repaint the field the user just left.
  async function renderMagField() {
    const key = magFieldKeyOrDefault();
    if (!key) return;
    const gen = ++magState.gen;
    const field = magState.meta.fields[key];

    try {
      const fc = await fetch(q("/data/mag/" + field.lines), { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(field.lines + " " + r.status);
        return r.json();
      });
      if (gen !== magState.gen) return;
      const src = map.getSource("mag-lines");
      if (src) src.setData(fc);
    } catch (_) { /* offline — the layer keeps whatever it had */ }

    // The lines take the FIELD's ramp colour at their own level (the
    // flat map does the same): ink-black #111827 was invisible on the
    // dark globe, and a line at level L sat on a wash of the same
    // hue — so the special landmarks (agonic / aclinic / no-change,
    // all at level 0) stay the saturated cyan glow while everything
    // else is lifted 30 % toward white to read over its own band.
    // The gen guard: a FAILED fetch for a stale field must not repaint
    // the lines with the field the user just left.
    if (gen === magState.gen) {
      const rampExpr = ["interpolate", ["linear"], ["get", "level"]];
      for (const st of (field.ramp || [])) {
        const hex = parseInt(st.rgb.slice(1), 16);
        const r = Math.round(((hex >> 16) & 255) + (255 - ((hex >> 16) & 255)) * 0.3);
        const g = Math.round(((hex >> 8) & 255) + (255 - ((hex >> 8) & 255)) * 0.3);
        const b = Math.round((hex & 255) + (255 - (hex & 255)) * 0.3);
        rampExpr.push(st.c, "rgb(" + r + "," + g + "," + b + ")");
      }
      if (map.getLayer("mag-lines") && (field.ramp || []).length) {
        map.setPaintProperty("mag-lines", "line-color",
          ["case", ["==", ["get", "level"], 0], "rgb(102,242,255)", rampExpr]);
      }
    }

    try {
      const plane = await magPlane(key);
      if (gen !== magState.gen) return;
      const canvas = bakeMag(key, plane);
      // Image sources have no setData, so remove + re-add — the same
      // thing the soil property switcher does to its tiles.
      if (map.getLayer("mag-wash")) map.removeLayer("mag-wash");
      if (map.getSource("mag-wash")) map.removeSource("mag-wash");
      map.addSource("mag-wash", {
        type: "image",
        url: canvas.toDataURL("image/png"),
        coordinates: XYZO_FIELD_BAKE.mercatorQuad(),
      });
      const st = overlayState.mag;
      map.addLayer({
        id: "mag-wash",
        type: "raster",
        source: "mag-wash",
        layout: { visibility: st && st.enabled ? "visible" : "none" },
        paint: { "raster-opacity": st ? st.opacity : 0.8 },
      });
    } catch (_) { /* bad grid — the contours still draw */ }
  }

  async function loadMag() {
    try {
      const meta = await fetch(q("/data/mag/meta.json"), { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error("mag meta " + r.status);
        return r.json();
      });
      if (!meta || !meta.fields) return;
      magState.meta = meta;
      const saved = settings.magView;
      if (saved && typeof saved.component === "string" && typeof saved.mode === "string") {
        magState.view = { component: saved.component, mode: saved.mode };
      }
      magFieldKeyOrDefault();
      renderMagSelector();
      await renderMagField();
    } catch (_) { /* offline or no data — the toggle paints nothing */ }
  }

  // The two chip rows. Rebuilds its own innerHTML and reassigns its
  // own onclick, so calling it again can never stack a second handler.
  function renderMagSelector() {
    const host = document.getElementById("mag-field-switch");
    if (!host || !magState.meta) return;
    const comps = magComponents();
    const modes = magModes();
    const rowOf = (aria, buttons) =>
      '<div class="globe-ov-props" role="group" aria-label="' + magEsc(aria) + '">' +
      buttons.join("") + "</div>";

    host.innerHTML =
      rowOf("Magnetic component",
        comps.map((c) =>
          '<button type="button" data-mag-comp="' + magEsc(c) + '" class="' +
          (magState.view.component === c ? "active" : "") + '" title="' +
          magEsc(magComponentLabel(c)) + '">' + magEsc(magComponentLabel(c)) + "</button>")) +
      rowOf("Field value",
        modes.map((mv) =>
          '<button type="button" data-mag-mode="' + magEsc(mv) + '" class="' +
          (magState.view.mode === mv ? "active" : "") + '">' +
          magEsc(MAG_MODE_LABELS[mv] || mv) + "</button>"));

    host.onclick = (e) => {
      const b = e.target.closest("button[data-mag-comp],button[data-mag-mode]");
      if (!b) return;
      const comp = b.getAttribute("data-mag-comp");
      const mode = b.getAttribute("data-mag-mode");
      magState.view = {
        component: comp || magState.view.component,
        mode: mode || magState.view.mode,
      };
      if (!magFieldKey()) return;
      settings.magView = { component: magState.view.component, mode: magState.view.mode };
      saveSettings(settings);
      renderMagSelector();
      renderMagField();
    };
  }

  // ── pins ──────────────────────────────────────────────────────────────
  function addPins() {
  map.addSource("pins", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  // The HOVER RING. The flat map has one (hover-ring.js) and the globe
  // needs the same affordance: without it, pointing at a story on the
  // globe changed the cursor and nothing else, and a reader could not
  // tell which of two overlapping pins the click would open.
  map.addSource("pin-hover-ring", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "pins-halo",
    type: "circle",
    source: "pins",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 8, 10],
      "circle-color": "#5eead4",
      "circle-opacity": 0.25,
      "circle-stroke-width": 0,
    },
  });
  map.addLayer({
    id: "pin-hover-ring",
    type: "circle",
    source: "pin-hover-ring",
    filter: ["==", ["get", "hover"], true],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 8, 11],
      "circle-color": "#5eead4",
      "circle-opacity": 0.25,
      "circle-stroke-color": "#5eead4",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "pins",
    type: "circle",
    source: "pins",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 1.6, 8, 5.5],
      "circle-color": [
        "match",
        ["get", "category"],
        "conflict", "#ef4444",
        "disaster", "#f97316",
        "politics", "#a78bfa",
        "business", "#22d3ee",
        "health", "#4ade80",
        "sports", "#facc15",
        "science", "#c084fc",
        "#5eead4",
      ],
      "circle-stroke-color": "#0b1220",
      "circle-stroke-width": 0.6,
    },
  });

  }

  function pinCoords(p) {
    const lat = p.lat != null ? p.lat : (p.location && p.location.lat);
    const lng = p.lng != null ? p.lng : (p.location && p.location.lng);
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return [lng, lat];
  }

  let pinsLoaded = false;
  async function loadPins() {
    // The whole-world pin query is the heaviest one the API runs, and
    // under load it can fail. Retry once before giving up: a globe with
    // no pins is a broken globe, and the failure is transient.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          "/api/pins/map?bbox=-180,-85,180,85&limit=2000&light=1", { cache: "default" });
        if (!res.ok) {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          return;
        }
        const data = await res.json();
        const pins = data.pins || [];
        const features = [];
        for (const p of pins) {
          const c = pinCoords(p);
          if (!c) continue;
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: c },
            properties: {
              id: String(p.id),
              title: p.title || "(untitled)",
              place: p.place_name || "",
              category: p.category || "other",
              published_at: p.published_at || "",
            },
          });
        }
        map.getSource("pins").setData({ type: "FeatureCollection", features });
        pinsLoaded = true;
        document.getElementById("globe-status").textContent =
          features.length.toLocaleString() + " stories on the globe";
        return;
      } catch (e) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        document.getElementById("globe-status").textContent = "pins unavailable";
        return;
      }
    }
  }

  map.on("load", () => {
    try { map.setProjection({ type: "globe" }); } catch (_) {}
    for (const o of OVERLAYS) addOverlay(o);
    addPins();
    wirePinPopup();
    loadPins();
    loadIsobars();
    loadBasins();
    loadTemp();
    loadLightning();
    loadWindSpeed();
    loadGeoOverlay("earthquakes", q("/data/earthquakes/week.geojson"));
    loadGeoOverlay("faults", q("/data/faults/faults.geojson"));
    loadGeoOverlay("language-regions", q("/data/languages/regions.geojson"));
    // Mag is NOT awaited: the panel must not wait on meta.json. loadMag
    // suspends at its first await, so renderControls() below has already
    // created #mag-field-switch by the time it resumes and repaints the
    // chip rows with the real component list.
    loadMag();
    renderControls();
  });

  // ── pin popup ─────────────────────────────────────────────────────────
  function wirePinPopup() {
  map.on("click", "pins", (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties || {};
    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const link =
      "https://xyzo.org/#" +
      f.geometry.coordinates[1].toFixed(4) + "," +
      f.geometry.coordinates[0].toFixed(4) + ",8/pin=" +
      encodeURIComponent(p.id);
    new maplibregl.Popup({ offset: 10, closeButton: true })
      .setLngLat(f.geometry.coordinates)
      .setHTML(
        '<div class="globe-popup">' +
        '<div class="globe-popup-title">' + esc(p.title) + "</div>" +
        '<div class="globe-popup-meta">' + esc(p.place) + " · " + esc(p.category) + "</div>" +
        '<a class="globe-popup-link" href="' + link + '">Open on the flat map →</a>' +
        "</div>")
      .addTo(map);
  });
  map.on("mouseenter", "pins", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "pins", () => { map.getCanvas().style.cursor = ""; });

  // The ring follows the hovered pin. It is ONE circle, moved to the
  // feature under the cursor — never a second circle next to the
  // first.
  let hoverFeature = null;
  function setHoverRing(f) {
    if (hoverFeature === f) return;
    hoverFeature = f;
    const src = map.getSource("pin-hover-ring");
    if (!src) return;
    if (!f) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const c = f.geometry && f.geometry.coordinates;
    if (!c) return;
    src.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: c },
        properties: { hover: true },
      }],
    });
  }
  // The LAYER's own mouse event, not a map-wide query: on the globe a
  // map-wide `queryRenderedFeatures(point)` does not report the features
  // under the cursor (the projection is a sphere, not a plane), so the
  // ring never appeared. MapLibre's per-layer `mousemove` fires only
  // when the pointer is actually over the layer, which is exactly the
  // signal wanted.
  map.on("mousemove", "pins", (e) => {
    setHoverRing(e.features && e.features.length ? e.features[0] : null);
  });
  map.on("mouseout", "pins", () => setHoverRing(null));
  map.on("mouseleave", "pins", () => setHoverRing(null));
  }

  // ── controls ──────────────────────────────────────────────────────────
  function persistOverlay(key) {
    const st = overlayState[key];
    if (!settings.overlays) settings.overlays = {};
    settings.overlays[key] = { enabled: st.enabled, opacity: st.opacity };
    saveSettings(settings);
  }

  function applyVisibility(o, on) {
    if (o.type === "wind") {
      // The animation is a canvas, not a MapLibre layer — and EACH
      // animation has its own controller.
      const ctrl = windControllers[o.key];
      if (ctrl) ctrl.setEnabled(on);
      return;
    }
    for (const id of layerIdsFor(o)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
  }

  function applyOpacity(o, v) {
    if (o.type === "wind") {
      // The canvas carries the opacity in its own alpha.
      const ctrl = windControllers[o.key];
      if (ctrl) ctrl.setOpacity(v);
      return;
    }
    if (o.type === "raster" || o.type === "temp" || o.type === "lightning" || o.type === "wind-speed") {
      if (map.getLayer(o.key)) map.setPaintProperty(o.key, "raster-opacity", v);
    } else if (o.type === "quake") {
      if (map.getLayer(o.key)) map.setPaintProperty(o.key, "circle-opacity", 0.85 * v);
    } else if (o.type === "langregions") {
      // The fill's own base (0.16, a hairline wash) is MULTIPLIED by
      // the slider, never replaced by it — the same product the flat
      // map uses.
      if (map.getLayer(o.key)) map.setPaintProperty(o.key, "fill-opacity", 0.16 * v);
    } else if (o.type === "mag") {
      // One opacity knob for both halves of the overlay: the contours
      // are stroked lines, the field colours are a raster.
      for (const id of [o.key + "-lines", o.key + "-wash"]) {
        if (!map.getLayer(id)) continue;
        map.setPaintProperty(
          id,
          id === o.key + "-wash" ? "raster-opacity" : "line-opacity",
          v
        );
      }
    } else if (o.type === "fill") {
      // Same product as at build time — the slider scales the paint's own
      // base, it does not replace it. Keeping the two paths identical is
      // what stops a freshly-loaded layer and a slider-dragged one from
      // disagreeing.
      //
      // THE FILL AND THE OUTLINE HAVE SEPARATE BASES, and they must be
      // read separately for the same reason: the wash is 0.16 and the
      // hairline is 0.85. Reading the fill's base for both was what made
      // the outlines invisible, and a build path that fixed it while the
      // slider path did not would put the bug back on the first drag.
      const base = baseOpacity(o, "fill-opacity");
      if (map.getLayer(o.key)) map.setPaintProperty(o.key, "fill-opacity", base * v);
      if (map.getLayer(o.key + "-line")) {
        map.setPaintProperty(o.key + "-line", "line-opacity",
                             baseOpacity(o, "line-opacity") * v);
      }
    } else {
      const base = baseOpacity(o, "line-opacity");
      if (map.getLayer(o.key)) map.setPaintProperty(o.key, "line-opacity", base * v);
    }
  }

  function renderControls() {
    const host = document.getElementById("globe-overlays");
    host.innerHTML = "";
    for (const o of OVERLAYS) {
      const st = overlayState[o.key];
      const row = document.createElement("div");
      row.className = "globe-ov-row";
      row.innerHTML =
        '<label><input type="checkbox" data-key="' + o.key + '"' + (st.enabled ? " checked" : "") + '> <span>' + o.label + "</span></label>" +
        '<input type="range" class="globe-ov-opacity" data-key="' + o.key +
        '" min="0" max="100" step="5" value="' + Math.round(st.opacity * 100) +
        '" aria-label="Opacity of ' + o.label + '">' +
        '<span class="globe-ov-val" data-key="' + o.key + '">' +
        Math.round(st.opacity * 100) + "%</span>";
      host.appendChild(row);

      const cb = row.querySelector("input[type=checkbox]");
      const slider = row.querySelector("input[type=range]");
      const val = row.querySelector(".globe-ov-val");

      cb.addEventListener("change", () => {
        st.enabled = cb.checked;
        applyVisibility(o, cb.checked);
        persistOverlay(o.key);
      });

      slider.addEventListener("input", () => {
        const v = Number(slider.value) / 100;
        st.opacity = v;
        val.textContent = slider.value + "%";
        applyOpacity(o, v);
        persistOverlay(o.key);
      });

      // Soil gets a property switcher under its row — one checkbox
      // controls whichever property is selected, same as the flat map.
      if (o.props) {
        const chips = document.createElement("div");
        chips.className = "globe-ov-props";
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", "Soil property");
        const activeProp = (settings.overlays && settings.overlays[o.key] &&
          settings.overlays[o.key].prop) || o.props[0];
        for (const p of o.props) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = p;
          b.dataset.prop = p;
          b.className = p === activeProp ? "active" : "";
          b.addEventListener("click", () => {
            // Swap the raster source's tiles in place. MapLibre has no
            // setTiles, so remove + re-add the source and layer.
            const wasEnabled = st.enabled;
            const curOpacity = st.opacity;
            if (map.getLayer(o.key)) map.removeLayer(o.key);
            if (map.getSource(o.key)) map.removeSource(o.key);
            map.addSource(o.key, {
              type: "raster",
              tiles: [q("/data/soil/" + p + "/tiles/{z}/{x}/{y}.png")],
              tileSize: 256,
              maxzoom: o.maxzoom,
            });
            map.addLayer({
              id: o.key,
              type: "raster",
              source: o.key,
              layout: { visibility: wasEnabled ? "visible" : "none" },
              paint: { "raster-opacity": curOpacity },
            });
            for (const btn of chips.querySelectorAll("button")) {
              btn.classList.toggle("active", btn === b);
            }
            if (!settings.overlays) settings.overlays = {};
            if (!settings.overlays[o.key]) settings.overlays[o.key] = {};
            settings.overlays[o.key].prop = p;
            saveSettings(settings);
          });
          chips.appendChild(b);
        }
        row.insertAdjacentElement("afterend", chips);
      }

      // Mag gets a FIELD switcher under its row — one checkbox and one
      // opacity slider control whichever component and value are
      // selected, the same arrangement the flat map's legend uses. The
      // chips themselves are painted by renderMagSelector() once
      // meta.json has arrived (it may already have).
      if (o.key === "mag") {
        const wrap = document.createElement("div");
        wrap.id = "mag-field-switch";
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-label", "Magnetic field shown");
        row.insertAdjacentElement("afterend", wrap);
      }

      // Earthquakes get a WINDOW switcher: 1 h / 24 h / 7 d / 30 d.
      // The globe fetches the same published files the flat map reads,
      // so the two views show the same catalogue.
      if (o.key === "earthquakes") {
        const wrap = document.createElement("div");
        wrap.className = "globe-ov-props";
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-label", "Earthquake window");
        const windows = [
          ["hour", "1 h"], ["day", "24 h"], ["week", "7 d"], ["month", "30 d"],
        ];
        for (const [id, label] of windows) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.dataset.eqWindow = id;
          b.className = id === quakeWindow ? "active" : "";
          b.addEventListener("click", () => {
            quakeWindow = id;
            for (const other of wrap.querySelectorAll("button")) {
              other.classList.toggle("active", other === b);
            }
            loadGeoOverlay("earthquakes", q("/data/earthquakes/" + id + ".geojson"));
          });
          wrap.appendChild(b);
        }
        row.insertAdjacentElement("afterend", wrap);
      }
    }

    // Fill the mag chips if meta.json beat us here; loadMag() calls it
    // again when it lands, so the order does not matter.
    renderMagSelector();

    // Projection switcher — globe, vertical perspective, plain mercator.
    const proj = document.getElementById("globe-projection");
    const savedProj = settings.projection || "globe";
    proj.innerHTML = ["globe", "vertical-perspective", "mercator"]
      .map((t) => '<button type="button" data-proj="' + t + '"' + (t === savedProj ? ' class="active"' : "") + ">" + t + "</button>")
      .join("");
    // Wired ONCE. renderControls() can run a second time (loadMag calls
    // it after meta.json arrives) and `proj` survives that rebuild — a
    // listener added each round would fire N times per click.
    if (!proj._xyzoWired) {
      proj._xyzoWired = true;
      proj.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-proj]");
        if (!b) return;
        const type = b.getAttribute("data-proj");
        try {
          map.setProjection({ type });
        } catch (_) {
          map.setProjection(type === "mercator" ? { type: "mercator" } : { type });
        }
        for (const btn of proj.querySelectorAll("button")) {
          btn.classList.toggle("active", btn === b);
        }
        settings.projection = type;
        saveSettings(settings);
      });
    }
    // Apply the saved projection on load.
    if (savedProj !== "globe") {
      try { map.setProjection({ type: savedProj }); } catch (_) {}
    }
  }

  // ── panel hide / show ─────────────────────────────────────────────────
  //
  // The panel had no close affordance at all. On a phone (393×660) it is
  // 298×606 — 76 % of the width and 92 % of the height — so the globe was
  // a sliver down the right-hand edge with no way to get rid of the panel.
  // The ✕ collapses it; the ☰ button brings it back, so it can never
  // become a one-way door. The choice is remembered alongside the rest of
  // the view state, and a phone starts collapsed because the globe is the
  // point of the page and the panel is settings.
  (function wireGlobePanel() {
    const panel = document.getElementById("globe-panel");
    const closeBtn = document.getElementById("globe-panel-close");
    const openBtn = document.getElementById("globe-panel-open");
    if (!panel || !closeBtn || !openBtn) return;

    const setPanelOpen = (open, persist) => {
      document.body.classList.toggle("globe-panel-hidden", !open);
      openBtn.hidden = open;
      if (persist !== false) {
        settings.panelOpen = open;
        saveSettings(settings);
      }
      // The canvas is offset on wide screens to clear the panel.
      setTimeout(() => { try { map.resize(); } catch (_) {} }, 0);
    };

    closeBtn.addEventListener("click", () => setPanelOpen(false));
    openBtn.addEventListener("click", () => setPanelOpen(true));

    let startOpen;
    if (settings.panelOpen === true || settings.panelOpen === false) {
      startOpen = settings.panelOpen;      // a remembered choice wins
    } else {
      startOpen = window.innerWidth > 640;
    }
    setPanelOpen(startOpen, false);
  })();

  // ── keyboard: escape the globe back to mercator ──────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      try { map.setProjection({ type: "mercator" }); } catch (_) {}
    }
  });

  // ── URL hash: a shared globe link carries the whole view ────────────
  //
  // Same shape as the flat map, plus a projection token:
  //   #lat,lng,zoom/overlay=koppen@50,soil@55/proj=globe
  //
  // Without this a shared link opens the globe at its default view with
  // every overlay off — the map state is the whole point of a shareable
  // address.
  // Accepts an explicit hash so the reader can use the CAPTURED string
  // rather than location.hash, which the initial moveend may already
  // have rewritten (see INCOMING_HASH above).
  function parseGlobeHash(incoming) {
    const h = (incoming != null ? incoming : location.hash).replace(/^#/, "");
    if (!h) return null;
    const parts = h.split("/");
    const res = { overlays: [], proj: "globe" };
    const coord = parts[0];
    if (coord) {
      const n = coord.split(",").map(Number);
      if (n.length >= 3 && n.every(Number.isFinite)) {
        res.lat = n[0]; res.lng = n[1]; res.zoom = n[2];
      }
    }
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (p.startsWith("overlay=")) {
        res.overlays = decodeURIComponent(p.slice(8)).split(",").map((e) => {
          const at = e.lastIndexOf("@");
          if (at <= 0) return { key: e, opacity: null };
          const pct = Number(e.slice(at + 1));
          return {
            key: e.slice(0, at),
            opacity: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct / 100 : null,
          };
        });
      } else if (p.startsWith("proj=")) {
        res.proj = decodeURIComponent(p.slice(5));
      } else if (p.startsWith("iso=")) {
        // The isobar detail AND colour, in hPa and scheme — the same
        // segment the flat map writes. A shared link has to mean the
        // same thing in both views, so the colour suffix must not make
        // a bare Number() return NaN and drop the whole segment.
        //
        // The digits group takes an optional decimal ON PURPOSE: the
        // step is fractional (0.1 / 0.25 / 0.5), and bare `\d+` matched
        // only the "0" of "0.1", giving n = 0, which the `n > 0` check
        // then threw away — every fractional step was dropped here while
        // globeIso() below accepted it. Same grammar, both parsers.
        const m = p.slice(4).match(/^(\d+(?:\.\d+)?)(?::([a-z]+))?/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && n > 0) res.isoStep = n;
          if (m[2]) res.isoColour = m[2];
        }
      }
    }
    return res;
  }

  // CAPTURED before MapLibre can touch it, and the writer below refuses
  // to run until it has been consumed.
  //
  // The map's initial `moveend` fires early, and writeGlobeHash() ->
  // applyGlobeHash() REPLACES location.hash computed from the DEFAULT
  // overlay state. On a shared link that ran BEFORE the `load` handler
  // got to read the incoming hash, so the position and every overlay were
  // silently overwritten with the boot view — measured: a link asking for
  // 12.35,76.54 with two layers on came up at 22,10 zoom 2.1 with every
  // layer off. Capturing the string up front closes the read side;
  // `hashConsumed` closes the write side. Without the gate, capturing
  // alone would still lose: the writer fires first and the reader then
  // sees its own overwritten value.
  const INCOMING_HASH = location.hash || "";
  let hashConsumed = false;

  // ── the flat map's own settings ──────────────────────────────────────
  // pin density, wind style, river detail, time window, base layer,
  // search, open pin. The globe has NO control for any of them and
  // cannot honour them — but `syncFlatHref()` builds "Back to the map"
  // from location.hash, and applyGlobeHash() rebuilds that hash from
  // scratch out of the layers the globe drew. A rebuild that dropped
  // them therefore handed the reader their OWN link back with the style
  // stripped: measured on the owner's link, `density=max`,
  // `wind=particles:speed` and `rivers=medium` were all gone after one
  // visit to the globe.
  //
  // Everything the globe's own writer emits is excluded, so a carried
  // part can never fight a live one: overlay=/proj=/iso=/isoSrc= are the
  // globe's, and the head is its position.
  const GLOBE_OWNED_PREFIXES = ["overlay=", "proj=", "iso=", "isoSrc="];
  function flatOnlyParts(raw) {
    const parts = String(raw || "").replace(/^#/, "").split("/").slice(1);
    const out = [];
    for (const p of parts) {
      if (!p || GLOBE_OWNED_PREFIXES.some((g) => p.indexOf(g) === 0)) continue;
      if (out.indexOf(p) < 0) out.push(p);
    }
    return out.length ? "/" + out.join("/") : "";
  }

  let hashTimer = null;
  function applyGlobeHash() {
    if (!hashConsumed) return;   // never clobber a link we have not read
    try {
      const c = map.getCenter();
      let h = `#${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom().toFixed(1)}`;
      const proj = (() => { try { return map.getProjection().type; } catch (_) { return "globe"; } })();
      if (proj && proj !== "globe") h += `/proj=${proj}`;
      const on = [];
      for (const o of OVERLAYS) {
        const st = overlayState[o.key];
        if (st && st.enabled) {
          const pct = Math.round(st.opacity * 100);
          on.push(o.key + "@" + pct);
        }
      }
      if (on.length) h += `/overlay=${on.join(",")}`;
      // The isobar detail AND its colour, so the globe's own link says
      // what it is drawing and a round trip back to the flat map keeps
      // both halves. Writing only the step would strip the colour.
      const isoState = overlayState["isobars"];
      if (isoState && isoState.enabled) {
        // ALWAYS, not only when it differs from the default — the flat
        // map writes it always too, and a segment that changes shape
        // between the two views is a segment that loses something on
        // the way home.
        h += `/iso=${isoStepInUse}:${isoColourInUse || "pressure"}`;
        // And WHICH analysis — the same rule, the same reason.
        h += `/isoSrc=${encodeURIComponent(isoSourceInUse || "auto")}`;
      }
      // …and the settings this view has no control over, so going home
      // does not cost the reader their own choices.
      h += flatOnlyParts(INCOMING_HASH);
      if (location.hash !== h) history.replaceState(null, "", h);
    } catch (_) {}
  }
  function writeGlobeHash() {
    if (hashTimer) clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      hashTimer = null;
      applyGlobeHash();
      syncFlatHref();
    }, 250);
  }

  // "Back to the map" must carry the view BACK — position, every overlay
  // and its opacity — not a bare "/" (there was no bridge either way
  // before this, so returning threw the globe's state away).
  //
  // The hash is FLUSHED first: writeGlobeHash() is debounced by 250 ms,
  // and a user who toggles a layer and immediately clicks back would
  // otherwise be handed the previous view.
  function syncFlatHref() {
    const el = document.querySelector(".globe-back");
    if (!el) return;
    if (!window.XYZO_HANDOFF || typeof window.XYZO_HANDOFF.flatHref !== "function") return;
    try {
      applyGlobeHash();
      // The SECOND argument is the link the globe was opened with: it is
      // what carries home the overlays this view could not draw (see
      // view-handoff.js::unrenderableOverlays).
      el.href = window.XYZO_HANDOFF.flatHref(location.hash, INCOMING_HASH);
    } catch (_) {}
  }

  // Read the hash once the map is ready — from the CAPTURED string, not
  // location.hash: the initial moveend may already have rewritten that.
  map.on("load", () => {
    const parsed = parseGlobeHash(INCOMING_HASH);
    // Consume it unconditionally, even when there is nothing to apply.
    // Until this line the writer refuses to run; after it, normal hash
    // writing resumes.
    hashConsumed = true;
    if (!parsed) return;
    if (parsed.lat != null && parsed.lng != null && parsed.zoom != null) {
      map.jumpTo({ center: [parsed.lng, parsed.lat], zoom: parsed.zoom });
    }
    if (parsed.proj && parsed.proj !== "globe") {
      try { map.setProjection({ type: parsed.proj }); } catch (_) {}
    }
    for (const ov of parsed.overlays) {
      const st = overlayState[ov.key];
      if (!st) continue;
      st.enabled = true;
      if (ov.opacity != null) st.opacity = ov.opacity;
      // Apply to the UI + the layer.
      const cb = document.querySelector(`.globe-ov-row input[data-key="${ov.key}"]`);
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
      if (ov.opacity != null) {
        const slider = document.querySelector(`.globe-ov-opacity[data-key="${ov.key}"]`);
        if (slider) { slider.value = String(Math.round(ov.opacity * 100)); slider.dispatchEvent(new Event("input")); }
      }
    }
  });

  // Give the back link a state-carrying href from the very first paint,
  // so even before the user touches anything the URL they came in with
  // (and its overlays) travels home again.
  syncFlatHref();

  // Write the hash on every state change.
  map.on("moveend", writeGlobeHash);
  document.addEventListener("click", (e) => {
    const cb = e.target.closest && e.target.closest(".globe-ov-row input[type=checkbox]");
    if (cb) writeGlobeHash();
    const sl = e.target.closest && e.target.closest(".globe-ov-opacity");
    if (sl) writeGlobeHash();
    const pr = e.target.closest && e.target.closest("#globe-projection button");
    if (pr) writeGlobeHash();
    // ALSO sync immediately: the hash write is debounced, and a user who
    // toggles a layer and hits "Back to the map" inside 250 ms would
    // otherwise take the previous view home with them.
    if (cb || sl || pr) syncFlatHref();
  }, true);

  window.__globeMap = map;
  window.__globePinsLoaded = () => pinsLoaded;
  // Test hooks: the animation controllers are keyed by overlay, and a
  // test needs to see WHICH one a switch reaches.
  window.__globeAnimations = windControllers;
})();
