/* ═══════════════════════════════════════════════════════════════════════
   Isobar (pressure contour) layer for the Xyzo map.

   Isobars are the lines of equal mean sea-level pressure that every
   synoptic chart is built from — they show where the highs and lows sit
   and how the pressure is flowing between them.

   There is no free isobar *tile* service, so the lines are computed
   server-side: worker/isobars.py contours the NOAA NCEP GFS analysis
   (PRMSL) with marching squares at 1 hPa intervals and stores the
   result in PostGIS. This module fetches the lines for the visible
   viewport and draws them as Leaflet polylines. The 1 hPa set is a
   SUPERSET of the classic 4 hPa chart — the contour of a given level
   does not depend on the interval used to enumerate levels — so the
   reader picks 1 / 2 / 4 / 8 / 16 hPa and the API thins accordingly.

   The switch is a checkbox in the Leaflet layers dropdown, listed under
   the base layers. It is a plain Leaflet-style checkbox rather than a
   registered overlay because the layers control rebuilds its own lists
   on every layer change — see app.js `mountIsobarRow`.

   Loaded before app.js; app.js hands it the map via IsobarLayer.init(map).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const API_PATH = "/api/weather/isobars";
  const STORE_KEY = "xyzo.isobarLayer";
  const OPACITY_STORE_KEY = "xyzo.isobarOpacity";
  // Contour detail, in hPa. The worker publishes the FINEST set (1 hPa)
  // and this selects a subset of it, so 4 — the classic synoptic chart —
  // is a thinning of the same data rather than a different download. The
  // API does the thinning (step=), so a coarser choice also costs less
  // bandwidth instead of throwing lines away client-side.
  const STEP_STORE_KEY = "xyzo.isobarStep";
  // Which CHANGE window is drawn ("" = the ordinary pressure chart).
  const DELTA_STORE_KEY = "xyzo.isobarDelta";
  // 0.1 hPa is the finest: the worker publishes the finest set and
  // the API thins it, so this is one dataset at eight densities. It is
  // not noisier — measured on the 2026-11-06 18Z GFS analysis, the
  // share of lines shorter than 20 degrees is 39.9 % at 0.25, 39.7 %
  // at 0.1 and 39.7 % at 0.05 (under 5 degrees: 12.9 / 12.8 / 12.7 %):
  // flat across a five-times-finer cut, because the noise lives in the
  // FIELD, not in the choice of level.
  //
  // Every entry must stay a whole multiple of ISO_INTERVAL_HPA in
  // worker/isobars.py (0.05) — a step the published lattice cannot
  // serve thins to whatever levels DO exist and the chip lies about
  // what it draws. isobar-step.bun.test.js checks the two together.
  // The CHANGE windows — the same list the API serves
  // (api/src/routes/weather-delta.ts). The label is what the chip says.
  const DELTA_WINDOWS = [
    { key: "24h", label: "24 h", title: "the last day" },
    { key: "3d", label: "3 d", title: "three days" },
    { key: "7d", label: "7 d", title: "a week" },
    { key: "moon", label: "moon", title: "one lunar cycle (29.53 days)" },
    { key: "season", label: "season", title: "a quarter of the year" },
    { key: "year", label: "year", title: "a full year" },
  ];
  const STEP_CHOICES = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
  const DEFAULT_STEP = 4;
  function readStoredStep() {
    const n = Number(storageGet(STEP_STORE_KEY, DEFAULT_STEP));
    return STEP_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_STEP;
  }

  // WHICH ANALYSIS to draw.
  //
  // Three analyses are stored side by side and they are NOT the same
  // picture: ECMWF IFS is 0.1° and lands ~8.5 h after its run, NOAA GFS
  // is 0.25° and lands ~3.5 h after its run, and NOAA HRRR is 3 km and
  // hourly but only covers North America. Until now the reader had no
  // say: the API picked, and it picked the newest analysis that covered
  // the viewport — which is usually GFS.
  //
  // That is why the lines here do not always match windy.com, which
  // draws ECMWF by default. Different model, different analysis time,
  // different contour interval: the same chart, not the same picture.
  // The picker makes that a CHOICE instead of a mystery.
  //
  // "auto" is the default and keeps the old behaviour exactly.
  const SOURCE_STORE_KEY = "xyzo.isobarSource";
  const SOURCE_CHOICES = [
    { id: "auto", label: "Auto",
      hint: "Newest analysis that covers the view (default)" },
    { id: "ecmwf", label: "ECMWF",
      hint: "ECMWF IFS 0.1° — the finer grid, about 8 h older" },
    { id: "gfs", label: "GFS",
      hint: "NOAA GFS 0.25° — the fresher global analysis" },
    { id: "hrrr", label: "HRRR",
      hint: "NOAA HRRR 3 km — hourly, North America only" },
  ];
  const DEFAULT_SOURCE = "auto";
  // The CHANGE window the reader last chose ("" = the ordinary chart).
  function readStoredDelta() {
    try {
      const v = String(localStorage.getItem(DELTA_STORE_KEY) || "");
      return DELTA_WINDOWS.some((w) => w.key === v) ? v : "";
    } catch (_) {
      return "";
    }
  }

  function readStoredSource() {
    const v = storageGet(SOURCE_STORE_KEY, DEFAULT_SOURCE);
    return SOURCE_CHOICES.some((s) => s.id === v) ? v : DEFAULT_SOURCE;
  }

  // How often the lines are LABELLED depends on how much of the world is
  // on screen: a world chart labels every 5th line (20 hPa) because 4 hPa
  // steps are unreadable at that size, while a city view labels every
  // line — otherwise a zoomed-in map often shows only one or two distinct levels, neither of them a
  // multiple of 20, and no line carries a value at all.
  const LABEL_EVERY_HPA = 20;
  const LABEL_EVERY_HPA_MID = 8;
  const LABEL_EVERY_HPA_NEAR = 4;

  function labelInterval() {
    if (!state.map) return LABEL_EVERY_HPA;
    const b = state.map.getBounds();
    const span = Math.max(
      b.getEast() - b.getWest(),
      b.getNorth() - b.getSouth(),
    );
    if (span > 150) return LABEL_EVERY_HPA;
    if (span > 40) return LABEL_EVERY_HPA_MID;
    return LABEL_EVERY_HPA_NEAR;
  }

  // A line shorter than this (in screen pixels) gets no label.
  const MIN_LABEL_PX = 90;

  // Labels are spaced ALONG the line rather than one per polyline. A
  // single isobar arrives as many short chains (the contour is cut up
  // wherever the field grazes the level), and one label per chain put
  // "1020" twelve times in a row on one line.
  const LABEL_SPACING_PX = 380;

  // Two labels of the same value closer together than this are merged
  // into one — that is what keeps a fragmented isobar from being
  // labelled over and over.
  const LABEL_MIN_GAP_PX = LABEL_SPACING_PX * 0.8;

  // Hard cap on the number of labels drawn at once.
  const MAX_LABELS = 60;

  // Keep labels this far in from the edge of the map so none of them is
  // half-clipped by the viewport.
  const LABEL_VIEWPORT_PAD_PX = 28;

  // How far outside the loaded box the user must pan before we refetch.
  const RELOAD_MARGIN = 0.25;

  // The first fetch waits briefly for the map view to settle. On a shared
  // link the map starts at the boot view (the whole world) and is moved to
  // the linked position a moment later — fetching straight away would
  // pull the world-wide isobars for a city-level view.
  //
  // The wait is short because the world fetch is now cheap (41 ms): a
  // long one just left the user staring at an empty map, which is what
  // "the pressure lines take forever to load" actually was.
  const FIRST_FETCH_DELAY_MS = 120;

  const DEFAULT_OPACITY = 0.85;

  const COLOUR_STORE_KEY = "xyzo.isobarColor";
  const DEFAULT_COLOUR = "pressure";

  // Declared ABOVE `state` because the state initialiser CALLS
  // readStoredColour(), and readStoredColour() reads this list — a
  // `const` below the object literal is in its temporal dead zone, and
  // the whole module then fails to evaluate ("Cannot access
  // 'COLOUR_CHOICES' before initialization") with no line of this code
  // ever running.
  const COLOUR_CHOICES = [
    { id: "pressure", label: "By pressure",
      hint: "The classic diverging key — cool lows, warm highs" },
    { id: "red", label: "Red", ink: "#ef4444",
      hint: "One bright ink — easy to see over anything" },
    { id: "white", label: "White", ink: "#f9fafb",
      hint: "One bright ink for a dark basemap" },
    { id: "black", label: "Black", ink: "#111827",
      hint: "One dark ink for a light basemap" },
    { id: "rainbow", label: "Rainbow",
      hint: "Full hue sweep, still keyed to the pressure" },
    { id: "turbo", label: "Turbo",
      hint: "Violet → cyan → green → red, high contrast on dark maps" },
  ];

  function readStoredColour() {
    let v = null;
    try { v = localStorage.getItem(COLOUR_STORE_KEY); } catch (_) { v = null; }
    return COLOUR_CHOICES.some((c) => c.id === v) ? v : DEFAULT_COLOUR;
  }

  const state = {
    map: null,
    group: null,
    labelGroup: null,
    enabled: false,
    opacity: DEFAULT_OPACITY,
    loaded: null, // { west, south, east, north } of the last fetch
    inflight: false,
    retryTimer: null,
    timer: null,
    firstTimer: null,
    runTime: null,
    levels: [],
    step: readStoredStep(),     // contour detail in hPa — see STEP_STORE_KEY
    // THE CHANGE MAP — the delta in pressure over a window, instead of the
    // pressure itself. null = the ordinary pressure chart. The window
    // keys are the ones the API serves (see api/src/routes/weather-delta.ts).
    deltaWindow: readStoredDelta() || null,
    deltaWindows: [],           // what the archive can answer, filled on demand
    // THE CACHED DELTA FIELD. The field is the WHOLE WORLD and does not
    // change with the viewport, so it is fetched ONCE per window and
    // re-used: a pan re-contours from the cache instead of going back to
    // the network for the 130 KB field. `deltaWin` is the window the
    // cache belongs to — a different window means a different field.
    deltaWin: null,
    deltaField: null,
    deltaGrid: null,
    deltaData: null,
    deltaScale: 40,             // the largest |change| on the whole map
    colour: readStoredColour(), // how the lines are painted — see COLOUR_CHOICES
    // WHICH analysis is drawn — see SOURCE_CHOICES. "auto" lets the API
    // pick the newest one that covers the viewport.
    requestedSource: readStoredSource(),
    // Which analyses are PUBLISHED right now — null until the layer
    // has asked `/api/weather/isobars/meta`. The picker uses it to
    // disable a chip for an analysis that is not there.
    availableSources: null,
    // null until resolveColourStops() has run (it needs RampStyles,
    // which loads before this module but is consulted lazily). `!==
    // undefined` distinguishes "not resolved yet" from a resolved null,
    // which is what a single INK resolves to.
    colourStops: undefined,
    items: [], // the fetched lines, kept so labels can be re-placed
    tolerance: null, // simplification the loaded data was built with
    source: null, // "ecmwf" | "gfs" | "hrrr" — which analysis is drawn
    sourceLabel: null, // the human-readable name of that analysis
    sourceDomain: null, // [[lng,lat] x4] the area it covers; null = global
    attribution: null, // the text currently in the map's attribution bar
  };

  // ── small helpers ─────────────────────────────────────────────────────
  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }

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
      localStorage.setItem(key, value);
    } catch (_) {
      /* private mode — the layer still works for this session */
    }
  }

  // ── colours ───────────────────────────────────────────────────────────
  // Classic synoptic-chart diverging scale: cold blues for the deep
  // lows, warm reds for the strong highs, near-neutral around the
  // 1012 hPa "average" line. This is the KEY — the colour carries the
  // pressure — and it is the default because it is what a chart means.
  const COLOR_STOPS = [
    { hpa: 960, color: "#4c1d95" },
    { hpa: 980, color: "#2563eb" },
    { hpa: 1000, color: "#06b6d4" },
    { hpa: 1012, color: "#22c55e" },
    { hpa: 1020, color: "#eab308" },
    { hpa: 1035, color: "#ea580c" },
    { hpa: 1055, color: "#b91c1c" },
  ];

  // ── the reader's colour choice ────────────────────────────────────────
  //
  // Owner ask: *"can we have a way to select the color of the pressure
  // lines near the detail switch — for example red is easy to see… or
  // various random styles?"*
  //
  // Two families, because they answer two different questions:
  //   • a single INK — "where are the isobars?" on a basemap that
  //     swallows them (red on a blue ocean, white on a dark satellite,
  //     black on a light street map). The pressure is then read from
  //     the labels and the probe, not from the colour.
  //   • a RAMP — the pressure still encoded in the hue, either the
  //     published key or a vivid one of the site's own schemes.
  //
  // Every option sits in ONE row next to the detail switch, with a dot
  // showing what it looks like — the reader picks by looking.

  // The stops the lines are actually painted from, or null for a single
  // ink. A scheme is applied with RampStyles.recolor(), which rewrites
  // the COLOURS and keeps the POSITIONS — the pressure is what the probe
  // reads and the labels print, so only the colour may move.
  function resolveColourStops() {
    const choice = COLOUR_CHOICES.find((c) => c.id === state.colour);
    if (choice && choice.ink) return null;
    if (!choice || choice.id === "pressure") return COLOR_STOPS;
    const R = window.RampStyles;
    if (!R || typeof R.recolor !== "function") return COLOR_STOPS;
    const out = R.recolor(
      COLOR_STOPS.map((s) => ({ c: s.hpa, rgb: s.color })), choice.id);
    return COLOR_STOPS.map((s, i) => ({
      hpa: s.hpa, color: (out[i] && out[i].rgb) || s.color,
    }));
  }

  // The dot shown on the chip: a solid colour for an ink, the scheme's
  // own gradient for a ramp.
  function swatchFor(choice) {
    if (choice.ink) return choice.ink;
    if (choice.id === "pressure") {
      return "linear-gradient(to right, " +
        COLOR_STOPS.map((s) => s.color).join(", ") + ")";
    }
    const R = window.RampStyles;
    if (R && typeof R.swatch === "function") return R.swatch(choice.id);
    return "#888";
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // THE CHANGE MAP GETS ITS OWN RAMP. The pressure ramp runs from blue
  // (low) to red (high) over 940–1060 hPa, and every one of those
  // numbers means the same thing — but for a CHANGE the number is the
  // DIFFERENCE, and "purple" means nothing. A change map is signed, so
  // it is coloured as one: BLUE where the pressure FELL, RED where it
  // ROSE, and pale in the middle where it barely moved. The scale is
  // the largest |change| on the map, so the ramp always uses its whole
  // range — the same rule the diverging ramps use elsewhere on the site.
  const DELTA_COLOR_STOPS = [
    { hpa: -40, color: "#2563eb" },
    { hpa: -20, color: "#60a5fa" },
    { hpa: -8, color: "#bfdbfe" },
    { hpa: 0, color: "#e5e7eb" },
    { hpa: 8, color: "#fecaca" },
    { hpa: 20, color: "#f87171" },
    { hpa: 40, color: "#dc2626" },
  ];

  function deltaColor(hpa) {
    const v = Number(hpa);
    if (!Number.isFinite(v)) return "#e5e7eb";
    const scale = state.deltaScale || 40;
    const norm = Math.max(-1, Math.min(1, v / scale));
    const stops = DELTA_COLOR_STOPS;
    if (norm <= stops[0].hpa / scale) return stops[0].color;
    const last = stops[stops.length - 1];
    if (norm >= last.hpa / scale) return last.color;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      const lo = a.hpa / scale, hi = b.hpa / scale;
      if (norm >= lo && norm <= hi) {
        const t = hi === lo ? 0 : (norm - lo) / (hi - lo);
        const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
        const mix = ca.map((val, idx) => Math.round(val + (cb[idx] - val) * t));
        return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
      }
    }
    return last.color;
  }

  function isobarColor(hpa) {
    // A single ink: every line the same colour, whatever the pressure.
    // The stops are null for an ink — see resolveColourStops().
    const stops = state.colourStops !== undefined
      ? state.colourStops
      : (state.colourStops = resolveColourStops());
    if (stops === null) {
      const choice = COLOUR_CHOICES.find((c) => c.id === state.colour);
      return (choice && choice.ink) || COLOR_STOPS[0].color;
    }
    if (hpa <= stops[0].hpa) return stops[0].color;
    const last = stops[stops.length - 1];
    if (hpa >= last.hpa) return last.color;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (hpa >= a.hpa && hpa <= b.hpa) {
        const t = (hpa - a.hpa) / (b.hpa - a.hpa);
        const ca = hexToRgb(a.color);
        const cb = hexToRgb(b.color);
        const mix = ca.map((v, idx) => Math.round(v + (cb[idx] - v) * t));
        return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
      }
    }
    return last.color;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  function init(map) {
    if (!map || state.map) return;
    state.map = map;

    // The pane sits above the climate wash (350) but below the pin
    // canvas (overlayPane, 400), so the isobars never hide a pin.
    if (!map.getPane("isobarPane")) {
      map.createPane("isobarPane");
      map.getPane("isobarPane").style.zIndex = "360";
      map.getPane("isobarPane").style.pointerEvents = "none";
    }

    // The attribution travels on the layer group, which is the layer the
    // map actually holds: Leaflet reads options.attribution off any
    // layer (L.Layer.getAttribution) and prints it bottom-right.
    //
    // It is rewritten when the analysis changes — the layer can switch
    // between ECMWF IFS (which carries a CC BY 4.0 attribution
    // obligation) and the NOAA analyses (public domain) at runtime.
    state.group = L.layerGroup({ attribution: "Pressure lines" });
    state.attribution = "Pressure lines";
    state.labelGroup = L.layerGroup();

    // ONE canvas for every isobar, instead of one SVG <path> per line.
    //
    // At 0.25 hPa a world view is 3,829 polylines, and the SVG
    // renderer creates 3,829 DOM paths for them — measured at ~250 ms of
    // the ~560 ms a step change costs at world zoom, more than the
    // 895 KB download. A canvas renderer draws them into one element,
    // and the isobars are `interactive: false` so nothing needs DOM
    // hit-testing.
    //
    // THE PANE MUST BE SET. A canvas renderer's container goes into the
    // default overlay pane if it is not told otherwise, and that pane
    // sits under the pin canvas with pointer-events on — a full-map
    // element there would swallow every click on the map. The isobar
    // pane already carries `pointer-events: none`.
    state.renderer = L.canvas({ pane: "isobarPane", padding: 0.5 });

    const storedOpacity = parseFloat(storageGet(OPACITY_STORE_KEY, ""));
    if (Number.isFinite(storedOpacity)) {
      state.opacity = Math.max(0, Math.min(1, storedOpacity));
    }

    // Refetch when the viewport leaves the area we already hold.
    map.on("moveend zoomend", scheduleRefresh);
    map.on("overlayadd", scheduleRefresh);
    // …and re-anchored to the new centre, or a view panned ONTO the
    // dateline keeps the offsets chosen for the old centre and the
    // lines that should be visible sit a full turn off the map. This
    // is cheap (a scan, plus setLatLngs only for lines that moved) and
    // runs alongside the refetch, which re-wraps again when it
    // rebuilds — see wrapLine()/rewrapLines().
    map.on("moveend zoomend", rewrapLines);

    // Restore the persisted preference (the checkbox reads this back when
    // it is mounted in the layers dropdown).
    const saved = storageGet(STORE_KEY, "");
    if (saved === "1" || saved === "true") setEnabled(true);
  }

  function isEnabled() {
    return state.enabled;
  }

  function setEnabled(enabled) {
    const next = !!enabled;
    if (next === state.enabled) return;
    state.enabled = next;
    storageSet(STORE_KEY, next ? "1" : "0");

    if (next) {
      if (state.group && state.map) state.group.addTo(state.map);
      if (state.labelGroup && state.map) state.labelGroup.addTo(state.map);
      // Which analyses are published right now — the picker needs it to
      // disable a chip for an analysis that is not there (HRRR has no
      // worker, so nothing has ever published one). Fetched when the
      // layer is switched ON, not at boot: the isobars are off by
      // default and this is one API call the reader did not ask for.
      loadAvailableSources();
      if (state.firstTimer) clearTimeout(state.firstTimer);
      state.firstTimer = setTimeout(() => {
        state.firstTimer = null;
        refresh(true);
      }, FIRST_FETCH_DELAY_MS);
    } else {
      if (state.group && state.map) state.map.removeLayer(state.group);
      if (state.labelGroup && state.map) state.map.removeLayer(state.labelGroup);
      if (state.group) state.group.clearLayers();
      if (state.labelGroup) state.labelGroup.clearLayers();
      state.items = [];
      state.loaded = null;
      state.tolerance = null;
      state.sourceDomain = null;
    }
  }

  function setOpacity(value) {
    const v = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(v)) return;
    state.opacity = v;
    storageSet(OPACITY_STORE_KEY, String(v));
    if (state.group) state.group.eachLayer((layer) => layer.setStyle({ opacity: v }));
    if (state.labelGroup) state.labelGroup.eachLayer((marker) => {
      const el = marker.getElement && marker.getElement();
      if (el) el.style.opacity = String(v);
    });
  }

  function getOpacity() {
    return state.opacity;
  }

  // ── fetching ──────────────────────────────────────────────────────────
  // The attribution each analysis must carry. ECMWF's Terms of Use
  // require the acknowledgement to be displayed PROMINENTLY and to use
  // their own wording, so it is spelled out in full rather than
  // abbreviated to an acronym.
  const SOURCE_ATTRIBUTIONS = {
    ecmwf:
      "Pressure lines based on data and products of the European Centre for " +
      "Medium-Range Weather Forecasts (ECMWF) — CC BY 4.0",
    gfs: "Pressure lines: NOAA NCEP GFS analysis — public domain",
    hrrr: "Pressure lines: NOAA HRRR 3 km analysis — public domain",
  };

  function setAttribution(text) {
    if (!text || text === state.attribution) return;
    // Keep the layer's own attribution in sync FIRST: Leaflet adds
    // options.attribution when the layer joins the map and removes the
    // SAME string when it leaves, so the two must never disagree.
    if (state.group) state.group.options.attribution = text;
    const ctrl = state.map && state.map.attributionControl;
    if (ctrl) {
      if (state.attribution) ctrl.removeAttribution(state.attribution);
      ctrl.addAttribution(text);
    }
    state.attribution = text;
  }

  // Is a point inside the quadrilateral the source covers? HRRR's CONUS
  // domain is a TRAPEZOID, not a box — its south edge is narrower than
  // its north edge — so a bounding-box test would hand HRRR a viewport
  // that pokes out over the Gulf of Mexico.
  function pointInQuad(lng, lat, quad) {
    let inside = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
      const xi = Number(quad[i][0]);
      const yi = Number(quad[i][1]);
      const xj = Number(quad[j][0]);
      const yj = Number(quad[j][1]);
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Does the viewport still sit inside the domain of the analysis we
  // are holding? A global source covers everything and always passes.
  function viewportInsideSource(box) {
    const quad = state.sourceDomain;
    if (!quad || !Array.isArray(quad) || quad.length < 3) return true;
    const west = Math.max(-180, box.west);
    const east = Math.min(180, box.east);
    const south = Math.max(-90, box.south);
    const north = Math.min(90, box.north);
    const pts = [
      [west, south], [east, south], [east, north], [west, north],
      [(west + east) / 2, south], [(west + east) / 2, north],
      [west, (south + north) / 2], [east, (south + north) / 2],
    ];
    for (const [lng, lat] of pts) {
      if (!pointInQuad(lng, lat, quad)) return false;
    }
    return true;
  }

  function currentBbox() {
    if (!state.map) return null;
    const b = state.map.getBounds();
    return {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    };
  }

  function bboxParam(box) {
    // Round outward so the server returns everything the viewport shows.
    const west = Math.floor(box.west * 100) / 100;
    const south = Math.floor(box.south * 100) / 100;
    const east = Math.ceil(box.east * 100) / 100;
    const north = Math.ceil(box.north * 100) / 100;
    return `${west},${south},${east},${north}`;
  }

  // The simplification the API will use for a given viewport — it must
  // mirror api/src/routes/weather.ts, or the "is the detail fine enough
  // yet?" test below never settles.
  function desiredTolerance(box) {
    const span = Math.max(box.east - box.west, box.north - box.south);
    return Math.max(0.015, Math.min(0.2, span / 2500));
  }

  function loadedCovers(box) {
    const loaded = state.loaded;
    if (!loaded) return false;
    // Clamp both boxes to the world before comparing. At low zoom the
    // viewport is wider than the globe (Leaflet reports west=-263,
    // east=263), so an unclamped comparison never matches and EVERY
    // pan fires another request for data we already hold.
    const west = Math.max(-180, box.west);
    const east = Math.min(180, box.east);
    const south = Math.max(-90, box.south);
    const north = Math.min(90, box.north);
    const lwest = Math.max(-180, loaded.west);
    const least = Math.min(180, loaded.east);
    const lsouth = Math.max(-90, loaded.south);
    const lnorth = Math.min(90, loaded.north);
    if (
      west < lwest - RELOAD_MARGIN ||
      east > least + RELOAD_MARGIN ||
      south < lsouth - RELOAD_MARGIN ||
      north > lnorth + RELOAD_MARGIN
    ) {
      return false;
    }
    // The box is covered — but is the DETAIL good enough for it? The
    // first fetch happens at whatever zoom the map opens on, so a layer
    // switched on at world zoom comes back 0.2° simplified and would
    // stay angular once you zoom into a city. Refetch when the viewport
    // now wants more than twice the detail we are holding.
    if (state.tolerance != null && desiredTolerance(box) < state.tolerance / 2) {
      return false;
    }
    // Has a pan carried the viewport out of the domain of the analysis
    // we are holding? HRRR only covers North America, so its lines stop
    // at the coast — keeping them would leave the ocean bare.
    if (!viewportInsideSource(box)) return false;
    return true;
  }

  function scheduleRefresh() {
    if (!state.enabled || !state.map) return;
    // The lines stay put, but the labels have to follow the zoom level.
    drawLabels();
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      refresh(false);
    }, 350);
  }

  async function refresh(force) {
    if (!state.enabled || !state.map) return;
    const box = currentBbox();
    if (!box) return;
    if (!force && loadedCovers(box)) return;
    if (state.inflight) {
      // A fetch is already running — but the thing that asked for THIS
      // one may be a CHANGE (a new analysis, a new step), and the
      // running fetch is for the OLD setting. Drop it on the floor and
      // try again in a moment, or the reader is left looking at the
      // previous analysis while the dropdown says "ECMWF".
      if (!state.retryTimer) {
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          refresh(false);
        }, 250);
      }
      return;
    }
    state.inflight = true;

    try {
      // `step` thins the 1 hPa dataset SERVER-side, so a coarser choice
      // is also a smaller response instead of lines thrown away here.
      // The step is part of the URL, so the browser cache keys on it too
      // — switching back to a step already seen costs no request body.
      // THE ARCHIVE (the time machine): the archived pressure chart is
      // the WHOLE WORLD's 4 hPa chart for that cycle — it is not cut to
      // the viewport, so it carries no bbox and no step. Asking it for a
      // bbox would be asking a question it cannot answer, and the chart
      // would be empty.
      const archiveUrl = window.WeatherArchive && window.WeatherArchive.active()
        ? window.WeatherArchive.isobarUrl()
        : null;
      // THE CHANGE MAP. The delta is the difference of two archived
      // pressure analyses and it is the WHOLE WORLD — it is not cut to
      // the viewport, so it carries no bbox. The server publishes the
      // delta FIELD and the ladder is applied HERE, so every step
      // (0.10 … 16 hPa) works from ONE fetch and the server never
      // contours a delta at all.
      if (state.deltaWindow && !archiveUrl) {
        await refreshDelta();
        return;
      }
      const url = archiveUrl || (`${API_PATH}?bbox=${encodeURIComponent(bboxParam(box))}&step=${state.step}` +
        `&source=${encodeURIComponent(state.requestedSource)}`);
      const resp = await fetch(url, {
        cache: "default",
      });
      if (!resp.ok) {
        warn("isobars: HTTP", resp.status);
        return;
      }
      const data = await resp.json();
      if (!data || !Array.isArray(data.items)) return;
      state.runTime = data.run_time || (archiveUrl ? (window.WeatherArchive && window.WeatherArchive.cycle()) : null) || null;
      state.levels = Array.isArray(data.levels) ? data.levels : [];
      state.tolerance = typeof data.tolerance === "number" ? data.tolerance : null;
      state.source = typeof data.source === "string" ? data.source : null;
      state.sourceLabel = typeof data.source_label === "string" ? data.source_label : null;
      state.sourceDomain = Array.isArray(data.source_domain) ? data.source_domain : null;
      setAttribution(SOURCE_ATTRIBUTIONS[state.source] || "Pressure lines");
      // If the API served a DIFFERENT analysis than the one asked for
      // — HRRR is not published, and an analysis that is not loaded
      // falls back to the newest global one — the chip has to say so.
      // The attribution bar already names what was DRAWN; the chip
      // names what was ASKED for, and the difference must not be a
      // silence.
      if (state.requestedSource !== "auto" && state.source &&
          state.source !== state.requestedSource) {
        const row = document.getElementById("isobar-source-switch");
        if (row) {
          const chip = row.querySelector(`button[data-source="${state.requestedSource}"]`);
          if (chip) {
            chip.title = "Not published right now — the map is drawing " +
              (state.sourceLabel || state.source) + " instead";
          }
        }
      }
      state.loaded = box;
      render(data.items);
    } catch (err) {
      warn("isobars: fetch failed", err);
    } finally {
      state.inflight = false;
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────
  // The stroke FOLLOWS THE DENSITY, not the step.
  //
  // 0.25 hPa at world zoom is ~3,800 polylines on one screen. At the
  // fixed 1.4 px they used to carry, the coverage is more than the
  // viewport's area: the chart paints the map solid and NOTHING under
  // it is visible — not the basemap, not the climate wash and not the
  // wind streaks that draw above them. Measured: with the isobars off
  // the wind reads 10,428 strong pixels and is plainly visible; with
  // 0.25 hPa on at zoom 3 it is buried.
  //
  // Thinning the stroke keeps EVERY line and loses only the coverage,
  // which is the part that was never readable anyway. The reader's
  // choice of step is untouched — the chart is still 0.25 hPa, it is
  // just drawn at a weight a screen can hold.
  // ── THE CHANGE MAP ──────────────────────────────────────────────────
  //
  // One fetch: the delta FIELD (the difference of two archived pressure
  // analyses). The chart's ladder is applied HERE, so every step works
  // without another request — and the lines come out in the API's own
  // shape, so the renderer, the labels, the antimeridian wrapping and
  // the colours are the same code either way.
  //
  // **THE FIELD IS FETCHED ONCE PER WINDOW AND THEN RE-USED.**
  //
  // The field is the WHOLE WORLD and it does not change with the
  // viewport — only the CONTOURING does. The first version fetched it
  // again on every pan, and it also left `state.loaded` null so that
  // `loadedCovers()` could never short-circuit: **measured on the live
  // site, four pans of the change map cost FOUR extra fetches of the
  // 130 KB field** (the "delta" path was the only one that always ran).
  //
  // So the field, the blurred field and the scale are CACHED against the
  // window they belong to, and a pan re-contours from the cache — the
  // cheap part — instead of going back to the network for the expensive
  // part. The lines are the same either way: the contouring is the same
  // code on the same field.
  async function refreshDelta() {
    const win = state.deltaWindow;
    if (!win) return;
    try {
      // ── THE FIELD: fetched once per window ──────────────────────────
      if (state.deltaWin !== win || !state.deltaField) {
        const resp = await fetch(`/api/weather/pressure/delta?window=${encodeURIComponent(win)}`, {
          cache: "default",
        });
        if (!resp.ok) {
          warn("isobar delta: HTTP", resp.status);
          return;
        }
        const data = await resp.json();
        if (!data || !data.grid || !data.data) return;
        const bin = atob(data.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const values = new Int16Array(bytes.buffer);
        const grid = {
          cols: data.grid.cols,
          rows: data.grid.rows,
          latMin: data.grid.lat_min,
          latStep: data.grid.lat_step,
          lonMin: data.grid.lon_min,
          lonStep: data.grid.lon_step,
          scale: data.grid.scale,
        };

        // ── THE BLUR, THE SAME ONE THE LIVE CHART GETS ────────────────
        //
        // The live chart is contoured from a Gaussian-blurred field
        // (worker/isobars.py::smooth_field — σ = 2 cells, wrapping in
        // longitude, nearest at the poles) because the analysis carries
        // structure below synoptic scale and contoured raw it breaks into
        // thousands of fragments. The delta skipped that, and a difference
        // of two fields is TWICE the noise — so the change map was
        // contouring the GRIB's own noise.
        //
        // Measured on the real 24-hour delta: the blur cuts the 0.10 hPa
        // chart from 28,171 lines to 11,181 and the 0.25 hPa chart from
        // 11,278 to 4,449 — and it gives the change map the same
        // character as the live one.
        const DC = window.DeltaContour;
        const field = DC && DC.smoothField ? DC.smoothField(values, grid) : values;

        // ── THE COLOUR SCALE IS THE WHOLE MAP ──────────────────────────
        //
        // Computed from the WHOLE field, before the viewport is applied —
        // otherwise the same line changes colour as the reader pans, and
        // "red" would mean something different in every view.
        let maxAbs = 0;
        for (let i = 0; i < field.length; i++) {
          const v = Math.abs(field[i]) / (grid.scale || 1);
          if (v > maxAbs) maxAbs = v;
        }
        state.deltaScale = maxAbs > 0 ? maxAbs : 40;
        // THE CACHE. Three things, all tied to THIS window: the decoded
        // field, its grid, and the metadata the attribution prints.
        state.deltaWin = win;
        state.deltaField = field;
        state.deltaGrid = grid;
        state.deltaData = data;
      }
      const field = state.deltaField;
      const grid = state.deltaGrid;
      const data = state.deltaData;
      const DC = window.DeltaContour;

      // ── CONTOUR THE VIEWPORT, NOT THE WORLD ──────────────────────────
      //
      // The client already holds the whole field (130 KB), so it can
      // contour only the cells the reader can see. The first version
      // contoured the WHOLE WORLD and trimmed the lines afterwards, so
      // every pan paid for the whole globe — the single biggest cost in
      // the freeze the owner reported ("they do load however they freeze
      // up the computer and almost crash it").
      const box = currentBbox();
      const opts = {};
      if (box && DC && DC.cellRangeFor) {
        const cellRange = DC.cellRangeFor(grid, box);
        if (cellRange) {
          opts.cellRange = cellRange;
          // A level outside the VIEWPORT's range cannot cross the
          // viewport, so it is not walked at all — and it still sits on
          // the same lattice, so a line keeps its colour as the reader
          // pans.
          const vr = DC.valueRangeFor ? DC.valueRangeFor(field, grid, cellRange) : null;
          if (vr) opts.valueRange = vr;
        }
      }

      let items = DC ? DC.contourLadder(field, grid, STEP_CHOICES, state.step, opts) : [];
      state.runTime = data.cycle || null;
      state.levels = [];
      state.source = "delta";
      state.sourceLabel = "Pressure change (" + (data.label || win) + ")";
      state.sourceDomain = null;
      state.tolerance = null;
      setAttribution("Pressure change · " + (data.label || win) +
        " (" + (data.ref_cycle ? data.ref_cycle.slice(0, 10) : "") + " → " +
        (data.cycle ? data.cycle.slice(0, 10) : "") + ")");
      // The box the LINES were cut for. `loadedCovers()` compares it with
      // the viewport: a pan that stays inside it costs nothing, and a pan
      // that leaves it re-contours (from the cached field — no network).
      state.loaded = box;
      render(items);
    } catch (e) {
      warn("isobar delta failed:", e);
    }
  }

  /**
   * Switch between the pressure chart and the CHANGE map.
   *
   * A window key (or null for the ordinary chart) is all it takes; the
   * window list is fetched once so the chips can grey out the windows
   * the archive cannot reach yet.
   *
   * `opts.persist === false` — a window that ARRIVED IN A LINK is not a
   * preference change: opening someone else's map must not overwrite
   * the reader's own stored choice (the same rule every layer
   * preference follows at boot — "a LINK IS A VIEW, NOT A SETTINGS
   * CHANGE").
   */
  async function setDeltaWindow(win, opts) {
    const want = win ? String(win) : null;
    // Only the windows the layer actually OFFERS. The chips can only
    // produce a valid one, but a LINK can carry anything, and the API
    // has no such window — the request would 404 and the map would
    // show an error for a setting the reader never asked for.
    if (want && !DELTA_WINDOWS.some((w) => w.key === want)) return false;
    if (state.deltaWindow === want) return false;
    state.deltaWindow = want;
    if (!(opts && opts.persist === false)) {
      try { localStorage.setItem(DELTA_STORE_KEY, want || ""); } catch (_) {}
    }
    // The loaded lines belong to the PREVIOUS window — they must not be
    // reused for the new one.
    state.loaded = null;
    state.tolerance = null;
    // Repaint the chips HERE, not only in the click handler. A window
    // that arrives in a LINK changes it with no click at all, and the
    // dropdown would then say "pressure" while the map drew the CHANGE
    // map — a control lying about what is on screen.
    paintDeltaRow();
    // Tell the URL, and tell it BEFORE the fetch: the reader pressed a
    // chip and the address bar should say so at once, not after the
    // archive answers.
    try {
      window.dispatchEvent(new window.CustomEvent("xyzo:isobar-delta", {
        detail: { window: want },
      }));
    } catch (_) {}
    await refresh(true);
    return true;
  }
  function getDeltaWindow() {
    return state.deltaWindow;
  }

  // Repaint the CHANGE chips: which window is on.
  //
  // Module-scope for the same reason `paintStep()` is — the window can
  // change from a LINK or from a saved style, with no click at all, and
  // the chip row has to agree with the map.
  function paintDeltaRow() {
    const row = document.getElementById("isobar-change-switch");
    if (!row) return;
    const current = state.deltaWindow || "";
    for (const b of row.querySelectorAll("button")) {
      const on = (b.dataset.delta || "") === current;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  async function loadDeltaWindows() {
    try {
      const resp = await fetch("/api/weather/pressure/delta/cycles", { cache: "default" });
      if (!resp.ok) return [];
      const data = await resp.json();
      state.deltaWindows = Array.isArray(data.windows) ? data.windows : [];
      return state.deltaWindows;
    } catch (_) {
      return [];
    }
  }

  function weightFor(count) {
    if (count <= 120) return 1.4;    // the classic chart: full weight
    if (count <= 400) return 1.0;
    if (count <= 1200) return 0.7;
    // A world view at 0.25 hPa is 4,486 lines. The 6,000 cut keeps that
    // view — and any stormier 0.25 one (a 140 hPa field tops out near
    // 5,300) — on exactly the weight it has always had, so nothing
    // already on screen changes.
    if (count <= 6000) return 0.5;   // a world view of the finest set
    // A world view at 0.10 hPa is 11,152 lines. Stroke weight is INK per
    // line, and 11,152 x 0.5 px is 5,576 line-px against a screen that
    // held 2,243 for the 0.25 view and ~5,361 in the case this thinning
    // was added for ("the chart paints the map solid and NOTHING under it
    // is visible"). 0.3 px lands at 3,346 — measurably denser than the
    // 0.25 view (more lines is the point of the chip) and about 0.6 of
    // the solid case, so the basemap and the wind still read through.
    // Measured on the live map (2026-11-06, GFS 18Z, `#20,0,2`, a
    // 1440x900 world view, layer switched OFF in the SAME session so
    // the diff is the lines and nothing else — the temperature and
    // wind overlays are OFF in that frame, so nothing else moves):
    // pixels whose colour changes by more than 96/255 —
    //
    //     0.25 hPa, 4,381 lines at 0.5 px   14.7 %
    //     0.10 hPa, 10,895 lines at 0.5 px  31.7 %   (2.2x the 0.25 view)
    //     0.10 hPa, 10,895 lines at 0.3 px  19.4 %   (1.3x, -39 % ink)
    //
    // The tier therefore costs 39 % of the heavy view's ink and leaves
    // the SAME lines on the map — the reader still gets a line every
    // 0.10 hPa, drawn at a weight a screen can hold. Integrated over
    // the whole frame (sum of |delta| / 255 per pixel) the saving is
    // 24 %: thinning the stroke removes the strongest coverage first,
    // which is what "the chart paints the map solid" means.
    return 0.3;
  }

  // ── THE DATELINE ─────────────────────────────────────────────────────
  //
  // Leaflet projects a polyline vertex through a CRS anchored at the
  // map's CENTRE. This view's centre is 175.6 and its bounds run to
  // 207.25, but the DATA is in [-180, 180] — so a vertex at -170, which
  // belongs 14 degrees EAST of centre, is placed 345 degrees to the
  // WEST: off the left edge. The fetch is correct (the API answers this
  // exact bbox with 1,157 lines covering both halves), the drawing is
  // correct, and the map still shows an empty right-hand ocean.
  //
  // MEASURED at #49.1961,175.6055,5: 127,530 of the250,609 drawn
  // vertices carry a negative longitude — the Pacific east of the
  // dateline, i.e. the RIGHT half of this view — and **all 127,530
  // project off the LEFT edge. Zero land on screen.** Only 2,203
  // vertices (the 175.6–180 sliver) appear on the right.
  //
  // The fix is to keep the line CONTIGUOUS and anchor only its START
  // to the centre: the first vertex goes within ±180° of the centre,
  // and every vertex after it goes within ±180° of its PREVIOUS one.
  //
  // ANCHORING EVERY VERTEX TO THE CENTRE — the first version — BREAKS
  // THE LINE IN TWO, and it is worse than doing nothing. A trace
  // stored as 144 … 207 (already contiguous, already correct) has its
  // second half pushed to −160 … −153 because |200 − 2.4| > 180, while
  // its first half stays at 144 — and Leaflet then draws one 310°
  // chord: a horizontal band straight across the map. MEASURED after
  // flying from the dateline to Europe: bands over the whole viewport,
  // 69,867 px of them attributable to the isobars alone.
  //
  // The scan is a few hundred thousand float comparisons (~1 ms) and
  // setLatLngs only runs for the lines that actually moved, so panning
  // far from the dateline costs one pass and no redraws.
  //
  // Handles both shapes: the [lat, lng] arrays this file builds, and
  // the LatLng objects Leaflet hands back from getLatLngs().
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

    // …and every later vertex to the one before it, which is what keeps
    // a line that crosses the dateline a single curve instead of two
    // halves on opposite sides of the world.
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

  // Re-wrap every drawn line against the CURRENT centre. Called on
  // moveend/zoomend: without it a view panned onto the dateline from
  // elsewhere would keep the offsets chosen for the old centre, and
  // lines that should be visible would sit a full turn off the map.
  function rewrapLines() {
    if (!state.group || !state.map) return;
    const centre = state.map.getCenter().lng;
    let moved = 0;
    state.group.eachLayer((line) => {
      const latlngs = line.getLatLngs();
      if (wrapLine(latlngs, centre)) {
        line.setLatLngs(latlngs);
        moved++;
      }
    });
    if (moved) drawLabels();
  }

  function render(items) {
    if (!state.group || !state.map) return;
    state.group.clearLayers();
    state.items = Array.isArray(items) ? items : [];

    for (const item of state.items) {
      const coords = item.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const level = Number(item.level_hpa);
      const latlngs = coords.map((c) => [Number(c[1]), Number(c[0])]); // [lat, lng]
      if (latlngs.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
      // …and into the map's continuous longitude, or the half of this
      // line east of the dateline lands off the left edge. See
      // wrapLine() above; this is the build half, rewrapLines() is the
      // keep-it-correct half.
      wrapLine(latlngs, state.map.getCenter().lng);

      const line = L.polyline(latlngs, {
        pane: "isobarPane",
        renderer: state.renderer,
        color: state.deltaWindow ? deltaColor(level) : isobarColor(level),
        // The level rides on the polyline so a COLOUR change can
        // re-paint without refetching: repaintLines() asks each line
        // for its own pressure and re-reads it from the new scheme.
        level: level,
        weight: weightFor(items.length),
        opacity: state.opacity,
        interactive: false,
        smoothFactor: 1.5,
      });
      state.group.addLayer(line);
    }

    drawLabels();
  }

  // Labels are placed in SCREEN space: where along a line the label goes,
  // and at what angle, depends on the zoom level. So they are re-placed
  // whenever the view changes — the lines themselves never move, only
  // the labels do.
  //
  // A label is placed every LABEL_SPACING_PX ALONG a line, not once per
  // polyline. A single isobar arrives as many short chains (the contour
  // is cut wherever the field grazes the level), and one label per chain
  // stamped "1020" twelve times in a row on a single line.
  // What a label SAYS. The ordinary chart prints the pressure
  // ("1012"), which is a plain number. A CHANGE is signed and has a
  // unit: "+8 hPa" says the pressure ROSE, "-3 hPa" says it fell —
  // without the sign and the unit, a change map is a chart of
  // unlabelled numbers.
  function labelTextFor(level) {
    const v = Number(level);
    if (!Number.isFinite(v)) return "";
    if (!state.deltaWindow) return String(v);
    const body = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
    return (v > 0 ? "+" : "") + body + " hPa";
  }

  function drawLabels() {
    if (!state.labelGroup || !state.map) return;
    state.labelGroup.clearLayers();
    if (!state.items.length) return;

    const map = state.map;
    const size = map.getSize();
    const pad = LABEL_VIEWPORT_PAD_PX;
    const inside = (x, y) =>
      x >= pad && y >= pad && x <= size.x - pad && y <= size.y - pad;

    // Project every line once, keeping only those a label could land on,
    // and rank them by how much of the line is actually on screen.
    const interval = labelInterval();
    const candidates = [];
    for (const item of state.items) {
      const level = Number(item.level_hpa);
      if (!Number.isFinite(level) || level % interval !== 0) continue;
      const coords = item.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;

      const pts = new Array(coords.length);
      let total = 0;
      let visible = 0;
      let bad = false;
      for (let i = 0; i < coords.length; i++) {
        const lat = Number(coords[i][1]);
        const lng = Number(coords[i][0]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          bad = true;
          break;
        }
        pts[i] = map.latLngToContainerPoint([lat, lng]);
        if (i > 0) {
          const seg = pts[i].distanceTo(pts[i - 1]);
          total += seg;
          const mx = (pts[i].x + pts[i - 1].x) / 2;
          const my = (pts[i].y + pts[i - 1].y) / 2;
          if (mx >= -pad && my >= -pad && mx <= size.x + pad && my <= size.y + pad) {
            visible += seg;
          }
        }
      }
      if (bad || total < MIN_LABEL_PX || visible < MIN_LABEL_PX) continue;
      candidates.push({ level, pts, total, visible });
    }

    // Most prominent first, so the labels that get drawn are the ones
    // the reader can see before the cap is reached.
    candidates.sort((a, b) => b.visible - a.visible);

    const placed = [];
    const tooClose = (x, y, level) =>
      placed.some(
        (p) => p.level === level && Math.hypot(p.x - x, p.y - y) < LABEL_MIN_GAP_PX,
      );

    outer:
    for (const c of candidates) {
      // Cumulative screen distance at every vertex.
      const cum = new Array(c.pts.length);
      cum[0] = 0;
      for (let i = 1; i < c.pts.length; i++) {
        cum[i] = cum[i - 1] + c.pts[i].distanceTo(c.pts[i - 1]);
      }
      // First label half a spacing in — but a chain shorter than that
      // still deserves one at its own midpoint, otherwise an isobar
      // broken into short pieces goes unlabelled altogether.
      const first = Math.min(LABEL_SPACING_PX / 2, c.total / 2);
      for (let d = first; d <= c.total; d += LABEL_SPACING_PX) {
        let i = 1;
        while (i < cum.length && cum[i] < d) i++;
        if (i >= c.pts.length) break;
        const a = c.pts[i - 1];
        const b = c.pts[i];
        const seg = cum[i] - cum[i - 1];
        const t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        if (!inside(x, y)) continue;
        if (tooClose(x, y, c.level)) continue;
        if (placed.length >= MAX_LABELS) break outer;

        // Keep the text upright — a label rotated 180° reads upside down.
        let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        placed.push({ level: c.level, x, y, angle });
      }
    }

    for (const l of placed) {
      state.labelGroup.addLayer(
        L.marker(map.containerPointToLatLng([l.x, l.y]), {
          pane: "isobarPane",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "xyzo-isobar-label",
            html: `<span style="transform:rotate(${l.angle}deg)">${labelTextFor(l.level)}</span>`,
            iconSize: [0, 0],
          }),
        }),
      );
    }
  }

  // ── HUD sampling ──────────────────────────────────────────────────────
  // Squared distance from point (px,py) to segment a→b, all in the same
  // planar units (lng·cos(lat), lat). Vertex distance is NOT enough: a
  // cursor sitting in the MIDDLE of a long isobar segment is far from
  // every vertex, so a vertex scan misreads "on the line" as "miles
  // away" — the exact case the HUD exists to answer.
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const ex = px - ax;
      const ey = py - ay;
      return ex * ex + ey * ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    return ex * ex + ey * ey;
  }

  // Nearest-isobar reading for the Hover HUD ("Everything" mode). Finds
  // the closest contour SEGMENT and, when a second level is nearby,
  // blends the two by inverse distance — the pressure at the cursor
  // sits between the bracketing isobars. O(all loaded segments) per
  // call, rAF-throttled by the HUD; at world zoom that is ~1000 lines
  // of simplified coordinates, a ~1 ms scan.
  function sampleAt(latlng) {
    if (!state.enabled || !state.items.length) return null;
    const lat = latlng && Number(latlng.lat);
    const lng0 = latlng && Number(latlng.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng0)) return null;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const px = lng0 * cosLat;
    const py = lat;
    let best = null;      // { d2, level } — nearest segment, any level
    let bestOther = null; // { d2, level } — nearest segment at another level
    for (const item of state.items) {
      const level = Number(item.level_hpa);
      if (!Number.isFinite(level)) continue;
      const coords = item.coordinates;
      if (!Array.isArray(coords) || coords.length < 1) continue;
      let d2 = Infinity;
      if (coords.length === 1) {
        const c = coords[0];
        const ex = Number(c[0]) * cosLat - px;
        const ey = Number(c[1]) - py;
        d2 = ex * ex + ey * ey;
      } else {
        for (let i = 1; i < coords.length; i++) {
          const a = coords[i - 1];
          const b = coords[i];
          const d = segDist2(px, py,
            Number(a[0]) * cosLat, Number(a[1]),
            Number(b[0]) * cosLat, Number(b[1]));
          if (d < d2) d2 = d;
        }
      }
      if (!Number.isFinite(d2)) continue;
      if (!best || d2 < best.d2) {
        // The demoted best is a candidate for the other level.
        if (best && best.level !== level && (!bestOther || best.d2 < bestOther.d2)) {
          bestOther = { d2: best.d2, level: best.level };
        }
        best = { d2, level };
      } else if (best.level !== level && (!bestOther || d2 < bestOther.d2)) {
        bestOther = { d2, level };
      }
    }
    if (!best) return null;
    const d1 = Math.sqrt(best.d2);
    // A CHANGE is signed: "+8 hPa" says the pressure ROSE, "-3 hPa"
    // says it fell. The ordinary pressure chart needs no sign — 1012
    // hPa is 1012 hPa either way.
    const fmt = (lvl) => {
      const v = Math.abs(lvl) < 0.05 ? 0 : lvl;
      const body = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
      return (state.deltaWindow && v > 0 ? "+" : "") + body + " hPa";
    };
    if (d1 === 0) return fmt(best.level);   // sitting on the line
    if (!bestOther) return fmt(best.level) + (state.deltaWindow ? " change" : " isobar");
    const d2 = Math.sqrt(bestOther.d2);
    const p = best.level + ((bestOther.level - best.level) * d1) / (d1 + d2);
    return "≈" + fmt(p);
  }

  // ── public API ────────────────────────────────────────────────────────
  // ── export surface ───────────────────────────────────────────────────
  // The isobars as vector LineStrings, in the order the API returned
  // them: { level_hpa, coordinates: [[lng, lat], …] }. The layer holds
  // them in memory already (it drew them), so the export costs nothing.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "isobars",
      z: 360,   // the map pane order — the export draws in it too
      label: "⛅ Pressure lines (isobars)",
      kind: "vector",
      attribution: "NOAA NCEP GFS — mean sea-level pressure (PRMSL)",
      licence: "US Government work (public domain)",
      source: "https://www.ncei.noaa.gov/products/weather-climatic-modeling-global-system",
      get period() { return state.runTime || ""; },
      style: { stroke: "#ffffff", width: 1, opacity: 0.7 },
      isActive: () => !!(state.items && state.items.length),
      async features() {
        const out = [];
        for (const item of state.items || []) {
          const coords = item.coordinates;
          if (!Array.isArray(coords) || coords.length < 2) continue;
          const level = Number(item.level_hpa);
          if (!Number.isFinite(level)) continue;
          out.push({
            type: "Feature",
            properties: {
              name: level + " hPa",
              level_hpa: level,
              description: "Isobar — " + level + " hPa",
            },
            geometry: { type: "LineString", coordinates: coords },
          });
        }
        return { type: "FeatureCollection", features: out };
      },
    });
  }


  // ── contour detail ──────────────────────────────────────────────────
  //
  // Changing it INVALIDATES the loaded viewport: state.loaded is what
  // loadedCovers() checks to decide a refetch is unnecessary, so leaving
  // it set would make the new step a no-op — the control would appear to
  // do nothing. Clearing it forces one fetch of the new detail.
  //
  // `opts.persist === false` — a step that ARRIVED IN A LINK is not a
  // preference change. Opening someone else's map must not overwrite
  // the reader's own stored choice (the same rule every other layer
  // preference follows at boot: "a LINK IS A VIEW, NOT A SETTINGS
  // CHANGE"). The chip is a real choice and persists as before.
  function setStep(step, opts) {
    const want = Number(step);
    if (STEP_CHOICES.indexOf(want) < 0 || want === state.step) return false;
    state.step = want;
    if (!(opts && opts.persist === false)) {
      storageSet(STEP_STORE_KEY, String(want));
    }
    state.loaded = null;
    state.tolerance = null;
    if (state.enabled) refresh(true);
    // Repaint the chips HERE, not only in the click handler. A step that
    // arrives in a LINK or in a PRESET changes the step without any
    // click — and the dropdown would then say "4 hPa" while the map was
    // drawing 1 hPa, which is a control lying about what is on screen.
    paintStep();
    // Tell the URL. The detail is part of the STYLE, so a shared link
    // has to carry it: `overlay=isobars@90` says how opaque the lines
    // are, `iso=1` says how detailed they are. Without this the link
    // reproduced the layer but not the setting the reader chose, and
    // the "share the exact map" promise was a half-promise.
    try {
      window.dispatchEvent(new window.CustomEvent("xyzo:isobar-step", {
        detail: { step: want },
      }));
    } catch (_) {}
    return true;
  }
  function getStep() {
    return state.step;
  }

  // ── the colour choice ─────────────────────────────────────────────────
  //
  // Same shape as the step: a real choice, persisted, and the choice
  // travels with a shared link (see `iso=` in app.js).
  function setColour(id, opts) {
    const want = String(id);
    if (!COLOUR_CHOICES.some((c) => c.id === want)) return false;
    if (want === state.colour) return true;
    state.colour = want;
    if (!(opts && opts.persist === false)) {
      storageSet(COLOUR_STORE_KEY, want);
    }
    // The resolved stops are derived from the choice — drop them and
    // the next paint resolves them again. A cached stops array would
    // make every chip after the first a no-op.
    state.colourStops = undefined;
    repaintLines();
    paintColourRows();
    // Tell the URL: `iso=<step>` carries the colour too, so a shared
    // link reproduces the lines as they were seen.
    try {
      window.dispatchEvent(new window.CustomEvent("xyzo:isobar-colour", {
        detail: { colour: want },
      }));
    } catch (_) {}
    return true;
  }
  function getColour() {
    return state.colour;
  }

  // ── which analysis is drawn ───────────────────────────────────────────
  //
  // Same shape as the step and the colour: a real choice, persisted, and
  // the choice travels with a shared link (see `isoSrc=` in app.js).
  //
  // It REFETCHES — the three analyses are different data, not different
  // paint, so there is nothing to repaint.
  function setSource(id, opts) {
    const want = String(id);
    if (!SOURCE_CHOICES.some((s) => s.id === want)) return false;
    if (want === state.requestedSource) return true;
    state.requestedSource = want;
    if (!(opts && opts.persist === false)) {
      storageSet(SOURCE_STORE_KEY, want);
    }
    // The loaded lines belong to the PREVIOUS analysis — they must not
    // be reused for the new one.
    state.loaded = null;
    state.tolerance = null;
    state.source = null;
    state.sourceLabel = null;
    state.sourceDomain = null;
    if (state.enabled) refresh(true);
    // Repaint HERE, not only in the click handler: a source that arrives
    // in a LINK changes it with no click at all, and the dropdown would
    // then say one thing while the map drew another.
    paintSourceRow();
    // Tell the URL, so a shared link reproduces the analysis the reader
    // was looking at — the difference between "the same chart" and "the
    // same picture".
    try {
      window.dispatchEvent(new window.CustomEvent("xyzo:isobar-source", {
        detail: { source: want },
      }));
    } catch (_) {}
    return true;
  }
  function getRequestedSource() {
    return state.requestedSource;
  }

  // Which analyses are actually PUBLISHED right now.
  //
  // The API knows — `/api/weather/isobars/meta` lists the sources it
  // holds — and the reader must not be offered one that is not there.
  // HRRR is the case that matters: the API has always accepted
  // `source=hrrr`, and there is NO WORKER for it, so nothing has ever
  // published an HRRR isobar row. A chip that offers it and then
  // silently draws something else is exactly the "control lying about
  // what is on screen" this repo is written against.
  async function loadAvailableSources() {
    try {
      const resp = await fetch(`${API_PATH}/meta`, { cache: "no-cache" });
      if (!resp.ok) return;
      const data = await resp.json();
      const sources = data && data.sources ? data.sources : null;
      if (!sources || typeof sources !== "object") return;
      state.availableSources = Object.keys(sources);
      paintSourceRow();
    } catch (err) {
      // The list is a nicety; the fetch itself is the source of truth
      // and it carries its own fallback.
      warn("isobars: could not read the available analyses", err);
    }
  }

  // The active chip in the source row.
  function paintSourceRow() {
    const row = document.getElementById("isobar-source-switch");
    if (!row) return;
    const available = state.availableSources;
    for (const b of row.querySelectorAll("button")) {
      const id = b.dataset.source;
      const on = id === state.requestedSource;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      // An analysis that is not published cannot be drawn. The chip is
      // disabled rather than removed — the reader can see that the
      // analysis EXISTS and that it is not here today, which is more
      // useful than a row with a hole in it.
      const missing = !!available && id !== "auto" && available.indexOf(id) === -1;
      b.disabled = missing;
      b.classList.toggle("is-unavailable", missing);
      if (missing) {
        b.title = "Not published right now — no worker builds this one yet";
      } else {
        const choice = SOURCE_CHOICES.find((c) => c.id === id);
        b.title = choice ? choice.hint : "";
      }
    }
  }

  // Re-colour the lines that are already on the map, without refetching
  // them. The geometry does not change — only the paint does.
  function repaintLines() {
    if (!state.group || !state.items) return;
    // The weight depends on how many lines are on screen, so a COLOUR
    // change has to re-apply it as well — the density is what decides
    // it, and the density does not change when the palette does.
    const weight = weightFor(state.items.length);
    state.group.eachLayer((layer) => {
      if (typeof layer.setStyle !== "function") return;
      const level = layer.options && layer.options.level;
      if (!Number.isFinite(level)) return;
      try { layer.setStyle({ color: isobarColor(level), weight: weight }); } catch (_) {}
    });
  }

  // The active chip in the colour row.
  function paintColourRows() {
    const row = document.getElementById("isobar-colour-switch");
    if (!row) return;
    for (const b of row.querySelectorAll("button")) {
      const on = b.dataset.colour === state.colour;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // The active chip in the detail row.
  //
  // MODULE scope, not inside mountStepControl(): a step that arrives in
  // a LINK or in a PRESET changes the step with no click at all, and
  // the dropdown would then say "4 hPa" while the map was drawing
  // 1 hPa — a control lying about what is on screen.
  function paintStep() {
    const row = document.getElementById("isobar-step-switch");
    if (!row) return;
    const cur = state.step;
    for (const b of row.querySelectorAll("button")) {
      const on = Number(b.dataset.step) === cur;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // ── contour detail selector ───────────────────────────────────────────
  // Mounted by app.js into the layers dropdown, directly under the isobar
  // row it creates there. The layer owns this control — magnetic and soil
  // keep theirs in their modules too.
  function mountStepControl(row) {
    if (!row || document.getElementById("isobar-step-switch")) return;
  // Contour detail: 1 / 2 / 4 / 8 / 16 hPa.
  //
  // The worker publishes the FINEST set (1 hPa) and the API thins it for
  // the chosen step, so this is one dataset viewed at five densities —
  // not five downloads. 4 is the classic synoptic chart and the default,
  // so nobody's existing view changes until they ask.
  //
  // Chips, not a <select>: five fixed options, and `.soil-prop-switch` is
  // the markup the soil and magnetic selectors already use in this same
  // white dropdown — so this needs no new CSS (and cannot collide with a
  // stylesheet being edited elsewhere).
  //
  // The chips carry `soil-prop-btn` so they look like the soil, wave and
  // magnetic chips beside them. The container class alone styles the ROW
  // (flex + gap); the buttons need the class of their own, and without
  // it they rendered as bare default <button>s in the middle of a white
  // dropdown that is otherwise all chips.
  const stepChoices = STEP_CHOICES;
  const stepRow = document.createElement("div");
  stepRow.className = "soil-prop-switch";
  stepRow.id = "isobar-step-switch";
  stepRow.setAttribute("role", "group");
  stepRow.setAttribute("aria-label", "Isobar detail");
  for (const s of stepChoices) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "soil-prop-btn";
    b.dataset.step = String(s);
    // "0.10", not "0.1": two decimals match the "0.25" chip beside it and
    // the 0.05 lattice's own precision, and it is how the owner asked for
    // the chip to read. Every other chip keeps the label it has always
    // had — this changes nothing that was already on screen.
    const label = s === 0.1 ? "0.10" : String(s);
    b.textContent = label + " hPa";
    // Title says what the choice DOES, not what it is called.
    b.title = s === 4
      ? "Standard synoptic pressure chart (default)"
      : s < 4
        ? `More detail — a line every ${label} hPa`
        : `Less detail — a line every ${label} hPa`;
    b.addEventListener("click", () => {
      if (setStep(s)) paintStep();
    });
    stepRow.appendChild(b);
  }
  row.insertAdjacentElement("afterend", stepRow);
  paintStep();
  mountChangeControl(stepRow);
  mountColourControl(stepRow);
  mountSourceControl(stepRow);
  }

  // ── the CHANGE selector ───────────────────────────────────────────────
  // The question the pressure chart cannot answer on its own: WHERE did
  // the pressure RISE and where did it FALL? The chart shows the
  // pressure of ONE analysis; the change map shows the DIFFERENCE
  // between two, over a window — 24 hours, a lunar cycle, a season, a
  // year.
  //
  // It sits directly under the DETAIL switch, because the two are the
  // two questions about this layer: how fine the lines are, and over
  // what period. Same chip markup as the detail switch
  // (`.soil-prop-switch` / `.soil-prop-btn`), so there is no new CSS
  // to collide with.
  function mountChangeControl(anchor) {
    if (!anchor || document.getElementById("isobar-change-switch")) return;
    const row = document.createElement("div");
    row.className = "soil-prop-switch";
    row.id = "isobar-change-switch";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Pressure change over");

    const paint = () => paintDeltaRow();

    const mk = (key, label, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "soil-prop-btn";
      b.dataset.delta = key;
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", async () => {
        await setDeltaWindow(key || null);
        paint();
      });
      row.appendChild(b);
      return b;
    };
    mk("", "pressure", "The pressure itself — the ordinary chart");
    for (const w of DELTA_WINDOWS) {
      mk(w.key, w.label, "The change in pressure over " + w.title);
    }
    anchor.insertAdjacentElement("afterend", row);
    paint();

    // Grey out the windows the archive cannot reach yet: a window that
    // needs a year of fields cannot be answered by an archive that has
    // three days of them.
    loadDeltaWindows().then((list) => {
      for (const w of list) {
        const chip = row.querySelector(`button[data-delta="${w.window}"]`);
        if (!chip) continue;
        if (!w.available) {
          chip.disabled = true;
          chip.classList.add("is-disabled");
          chip.title = "Not available yet — the archive has to reach back that far";
        } else {
          chip.title = "The change in pressure over " + (w.title || w.window) +
            " (" + (w.ref_cycle || "").slice(0, 10) + " → " + (w.cycle || "").slice(0, 10) + ")";
        }
      }
    });
  }

  // ── colour selector ───────────────────────────────────────────────────
  // Sits directly under the DETAIL switch, because the two are the two
  // questions about the isobars: how dense, and what colour. Same
  // markup as the detail chips (`.soil-prop-switch` / `.soil-prop-btn`)
  // so there is no new CSS to collide with.
  //
  // Each chip carries a DOT showing what it looks like — a solid
  // colour for a single ink, the scheme's own gradient for a ramp — so
  // the reader picks by looking rather than by name.
  function mountColourControl(anchor) {
    if (!anchor || document.getElementById("isobar-colour-switch")) return;
    const row = document.createElement("div");
    row.className = "soil-prop-switch";
    row.id = "isobar-colour-switch";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Isobar colour");

    for (const choice of COLOUR_CHOICES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "soil-prop-btn";
      b.dataset.colour = choice.id;
      b.title = choice.hint;
      b.setAttribute("aria-pressed", "false");
      const dot = document.createElement("span");
      dot.className = "soil-legend-swatch";
      dot.setAttribute("aria-hidden", "true");
      dot.style.background = swatchFor(choice);
      b.appendChild(dot);
      b.appendChild(document.createTextNode(choice.label));
      b.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        setColour(choice.id);
      });
      row.appendChild(b);
    }
    anchor.insertAdjacentElement("afterend", row);
    paintColourRows();
  }

  // ── which analysis ────────────────────────────────────────────────────
  //
  // The third question about the isobars, after "how dense" and "what
  // colour": WHOSE chart is this? Three analyses are published side by
  // side and they are different pictures of the same atmosphere — the
  // GFS 0.25° analysis is fresher, the ECMWF IFS 0.1° is finer, and the
  // HRRR 3 km is a CONUS-only analysis at hourly resolution.
  //
  // Without this the reader had no way to ask for a particular one, and
  // the lines on the map were the API's choice rather than the reader's.
  //
  // Same markup as the other two chip rows (`.soil-prop-switch` /
  // `.soil-prop-btn`), so there is no new CSS to collide with.
  function mountSourceControl(anchor) {
    if (!anchor || document.getElementById("isobar-source-switch")) return;
    const row = document.createElement("div");
    row.className = "soil-prop-switch";
    row.id = "isobar-source-switch";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Pressure analysis");

    for (const choice of SOURCE_CHOICES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "soil-prop-btn";
      b.dataset.source = choice.id;
      b.title = choice.hint;
      b.setAttribute("aria-pressed", "false");
      b.appendChild(document.createTextNode(choice.label));
      b.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        setSource(choice.id);
      });
      row.appendChild(b);
    }
    anchor.insertAdjacentElement("afterend", row);
    paintSourceRow();
  }

  window.IsobarLayer = {
    // THE ARCHIVE (the time machine): drop the lines drawn from the
    // last fetch, so the next fetch asks the ARCHIVE for the cycle the
    // reader picked rather than the live one.
    resetForArchive() {
      state.items = [];
      state.lines = [];
      state.runTime = null;
      state.levels = [];
      state.inflight = false;
    },
    init,
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    setEnabled,
    isEnabled,
    sampleAt,
    setOpacity,
    getOpacity,
    setStep,
    getStep,
    STEP_CHOICES,
    // The CHANGE map's window ("" / null = the ordinary pressure chart).
    // It is part of the picture, so it travels with a shared link (see
    // `delta=` in app.js).
    setDeltaWindow,
    getDeltaWindow,
    DELTA_WINDOWS,
    // The colour of the lines, and the choices offered.
    setColour,
    getColour,
    COLOUR_CHOICES,
    // WHICH analysis is drawn: "auto" | "ecmwf" | "gfs" | "hrrr".
    setSource,
    getRequestedSource,
    SOURCE_CHOICES,
    mountStepControl,
    refresh: (force) => refresh(force !== false),
    getRunTime: () => state.runTime,
    getLevels: () => state.levels,
    // The analysis the API ACTUALLY served — which is not always the
    // one that was asked for: HRRR only covers North America, and a
    // source that is not loaded falls back to the newest global one.
    getSource: () => state.source,
    getSourceLabel: () => state.sourceLabel,
    LAYER_NAME: "⛅ Pressure lines (isobars)",
    registerExport,
    // test hooks
    _state: state,
    _wrapLine: wrapLine,
    _rewrapLines: rewrapLines,
  };

  registerExport();
})();
