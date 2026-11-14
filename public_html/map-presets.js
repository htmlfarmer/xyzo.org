/**
 * Map presets, the first-visit "cool map", and the saved / last-used
 * default map.  (Owner spec 2026-10-30.)
 *
 * Three things live here, all of them about WHAT MAP OPENS NEXT TIME:
 *
 *  1. PRESETS — a handful of curated "cool maps" (the layers control
 *     gets a ✨ Cool maps chip strip; one click applies one). Each
 *     preset is stored as a real app hash (`#lat,lng,zoom/density=
 *     /overlay=slug@pct,…`) and goes through the SAME parse/apply path
 *     a shared URL uses — a preset, a pasted link and a saved style can
 *     therefore never diverge.
 *
 *  2. FIRST VISIT — if the machine looks capable (`deviceTier()`:
 *     enough cores / RAM, no save-data, no 2G/3G) the very first load
 *     opens the coolest preset instead of the bare world view. Phones
 *     and thin machines get a light preset (Köppen wash only — PNG
 *     tiles, no grids to download).
 *
 *  3. DEFAULTS — the user can ⭐ save the current map as their default
 *     ("Next visit → My default"), or leave it on "Last used", in which
 *     case whatever they had on screen when they left is what opens
 *     next time (app.js auto-saves it via autoSave()). "✨ Cool" re-opens
 *     the curated preset on every visit.
 *
 * app.js owns everything that touches the live map (applyMapState,
 * captureMapState); this module is pure state + storage so it can be
 * tested head-less. It reads `localStorage` lazily off the global scope
 * so tests can inject their own store.
 */
(function () {
  const G = (typeof window !== "undefined" && window) ||
            (typeof globalThis !== "undefined" ? globalThis : {});

  const DEFAULT_KEY = "xyzo.defaultMapState"; // ⭐ the saved default
  const LAST_KEY = "xyzo.lastMapState";       // auto-saved last used
  const MODE_KEY = "xyzo.nextVisitMap";       // "auto" | "saved" | "cool"
  const MODES = ["auto", "saved", "cool"];

  // ── storage ────────────────────────────────────────────────────────
  function store() {
    try { return G.localStorage || null; } catch (_) { return null; }
  }
  function loadJson(key) {
    const s = store();
    if (!s) return null;
    try {
      const raw = s.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === "object" ? v : null;
    } catch (_) { return null; }
  }
  function saveJson(key, value) {
    const s = store();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }

  // ── state hygiene ──────────────────────────────────────────────────
  // A stored state only ever carries the fields applyMapState() knows.
  // Anything else (a corrupted key, a future experiment) is dropped
  // here rather than handed to the map.
  const MAX_OVERLAYS = 30;

  function sanitizeState(state) {
    if (!state || typeof state !== "object") return null;
    const out = {};
    if (Number.isFinite(state.lat)) out.lat = state.lat;
    if (Number.isFinite(state.lng)) out.lng = state.lng;
    if (Number.isFinite(state.zoom)) out.zoom = state.zoom;
    if (typeof state.base === "string" && state.base) out.base = state.base;
    if (typeof state.density === "string" && state.density) out.density = state.density;
    // The isobar DETAIL step, in hPa. It is part of the style, so a
    // preset that names it must carry it — otherwise the preset opens
    // the isobars at the reader's own step and the curated view is
    // not the view that was curated.
    //
    // Round to TWO decimals, not to a whole number: Math.round(0.5) is 1
    // and Math.round(0.25) is 0, so the old `Math.round(isoStep)` saved
    // a 0.5 hPa style as 1 (which then applied as 1 — a wrong step, not
    // a missing one) and a 0.25 or 0.1 style as 0, which setStep rejects
    // so the value was quietly ignored. Every step on the ladder is at
    // most two decimals, so this normalises float noise without moving
    // any real choice.
    if (Number.isFinite(state.isoStep) && state.isoStep > 0) {
      out.isoStep = Math.round(state.isoStep * 100) / 100;
    }
    if (typeof state.isoColour === "string" && state.isoColour) {
      out.isoColour = state.isoColour;
    }
    // WHICH analysis the lines are drawn from — the same argument: a
    // curated view of ECMWF's pressure field is not the same view in
    // GFS's.
    if (typeof state.isoSource === "string" && state.isoSource) {
      out.isoSource = state.isoSource;
    }
    // The pressure CHANGE map's WINDOW, the same argument: "the change
    // over the last day" and "the change over the last year" are
    // different pictures.
    if (typeof state.deltaWindow === "string" && state.deltaWindow) {
      out.deltaWindow = state.deltaWindow;
    }
    // The wind's STYLE, COLOUR and DENSITY, the same argument: a
    // curated wind map is not the same map in a different rendering,
    // nor at a different density.
    if (state.wind && typeof state.wind === "object") {
      const w = {};
      if (typeof state.wind.style === "string" && state.wind.style) {
        w.style = state.wind.style;
      }
      if (typeof state.wind.colour === "string" && state.wind.colour) {
        w.colour = state.wind.colour;
      }
      if (Number.isFinite(state.wind.density)) {
        w.density = state.wind.density;
      }
      if (w.style || w.colour || w.density != null) out.wind = w;
    }
    // The 2026 FAO rivers' DETAIL LEVEL, the same argument: "Major" and
    // "Full detail" are different pictures of the same network.
    if (typeof state.riversLevel === "string" && state.riversLevel) {
      out.riversLevel = state.riversLevel;
    }
    if (Array.isArray(state.overlays)) {
      out.overlays = [];
      for (const ov of state.overlays.slice(0, MAX_OVERLAYS)) {
        if (!ov || typeof ov !== "object") continue;
        const slug = typeof ov.slug === "string" ? ov.slug : null;
        if (!slug) continue;
        const pct = Number.isFinite(ov.pct)
          ? Math.max(0, Math.min(100, Math.round(ov.pct)))
          : null;
        out.overlays.push(pct == null ? { slug } : { slug, pct });
      }
    }
    if (Number.isFinite(state.ts)) out.ts = state.ts;
    // A state with NOTHING in it is not a state — and handing `{}` to
    // applyMapState would run its removal half and strip every overlay
    // off the map. An explicit "overlays: []" (a deliberately cleared
    // map) still counts: that IS a meaningful state.
    const hasOverlays = Array.isArray(out.overlays);
    if (out.lat == null && out.lng == null && out.zoom == null &&
        out.base == null && out.density == null && !hasOverlays) return null;
    return out;
  }

  /**
   * Parse an app hash (`#lat,lng,zoom/base=…/density=…/overlay=a@50,b`)
   * into the state shape applyMapState() consumes. Mirrors app.js's
   * parseMapHash() grammar on purpose — this module never imports
   * app.js (it is a browser global, not a module), and a preset that
   * fails to parse is simply not applied.
   */
  function parseHash(hash) {
    if (typeof hash !== "string" || hash.length < 2) return null;
    const parts = hash.replace(/^#/, "").split("/");
    const state = {};
    const coords = parts[0].split(",").map(Number);
    if (coords.length >= 3 && coords.every((n) => Number.isFinite(n))) {
      const [lat, lng, zoom] = coords;
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && zoom >= 1 && zoom <= 19) {
        state.lat = lat; state.lng = lng; state.zoom = zoom;
      }
    }
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const base = p.match(/^base=(.+)$/);
      if (base) { try { state.base = decodeURIComponent(base[1]); } catch (_) {} }
      const density = p.match(/^density=(.+)$/);
      if (density) { try { state.density = decodeURIComponent(density[1]); } catch (_) {} }
      const iso = p.match(/^iso=(\d+(?:\.\d+)?)(?::([a-z]+))?/);
      if (iso) {
        try {
          const n = Number(iso[1]);
          if (Number.isFinite(n) && n > 0) state.isoStep = n;
          if (iso[2]) state.isoColour = iso[2];
        } catch (_) {}
      }
      // `isoSrc=<analysis>` — WHICH analysis the pressure lines are
      // drawn from. The grammar a preset speaks is deliberately the same
      // one a shared URL speaks, so a preset, a pasted link and a saved
      // style can never diverge.
      const isoSrc = p.match(/^isoSrc=([a-z]+)/);
      if (isoSrc) {
        try { state.isoSource = decodeURIComponent(isoSrc[1]); } catch (_) {}
      }
      // `delta=<window>` — the pressure CHANGE map's window. The same
      // grammar, the same reason: the ordinary chart and the change map
      // are different pictures of the same atmosphere.
      const delta = p.match(/^delta=([a-z0-9]+)/);
      if (delta) {
        try { state.deltaWindow = decodeURIComponent(delta[1]); } catch (_) {}
      }
      // `wind=<style>:<colour>:<density>` — how the wind animation is
      // drawn, coloured, and how much of it there is. Part of the
      // style, so it travels with a link and with a preset.
      //
      // THREE fields, anchored exactly as app.js's is. The old
      // two-field form matched NOTHING against
      // `wind=particles:speed:200`, so a preset carrying a density
      // dropped the whole segment and opened in the reader's own
      // rendering. Same grammar, both readers — that is the rule.
      const wind = p.match(/^wind=([^:/]+)(?::([^:/]+))?(?::([^:/]+))?$/);
      if (wind) {
        state.wind = {};
        if (wind[1]) state.wind.style = decodeURIComponent(wind[1]);
        // The same numeric-second-field rule app.js applies, for the
        // same reason: `wind=particles:200` is a density, and two
        // readers calling it different things is the bug this grammar
        // exists to prevent.
        const c2 = wind[2] ? decodeURIComponent(wind[2]) : null;
        const numericSecond = c2 != null && /^\d+$/.test(c2);
        if (c2 != null && !numericSecond) state.wind.colour = c2;
        const raw = wind[3] != null ? wind[3] : (numericSecond ? c2 : null);
        if (raw != null) {
          const d = Number(raw);
          if (Number.isFinite(d)) state.wind.density = d;
        }
      }
      // `rivers=<level>` — the 2026 FAO river network's detail level.
      // The grammar a preset speaks is deliberately the same one a
      // shared URL speaks, so a preset, a pasted link and a saved style
      // can never diverge.
      const rivers = p.match(/^rivers=([a-z]+)/);
      if (rivers) {
        try { state.riversLevel = decodeURIComponent(rivers[1]); } catch (_) {}
      }
      const overlay = p.match(/^overlay=(.+)$/);
      if (overlay) {
        let list = "";
        try { list = decodeURIComponent(overlay[1]); } catch (_) { list = overlay[1]; }
        state.overlays = list.split(",").map((entry) => {
          const at = entry.lastIndexOf("@");
          if (at <= 0) return { slug: entry };
          const pct = Number(entry.slice(at + 1));
          return {
            slug: entry.slice(0, at),
            pct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null,
          };
        }).filter((o) => o.slug);
      }
    }
    return sanitizeState(state);
  }

  // ── the curated presets ────────────────────────────────────────────
  //
  // `tier: "high"` presets are for a machine that can carry several
  // tile pyramids + grid downloads at once; "low" ones are cheap (PNG
  // tiles, no binary grids). COOL picks the one a first visit opens.
  //
  // "🌍 Earth portrait" is the FIRST-VISIT SHOWCASE (COOL_ID.high) —
  // the map xyzo.org opens with when the machine has nothing stored.
  // Changing what a first-time reader sees is a one-line change here:
  // point `hash` at whatever view you want, and `COOL_ID` below picks
  // the preset (by tier). It is NOT the map a returning reader gets —
  // bootPlan() prefers their ⭐ saved default, then their last-used
  // state, and only falls through to this when there is neither.
  //
  // Owner spec 2026-11-03: *"i really like having the wind and also all
  // the other base maps when we first load xyzo.org unless they already
  // have selected something else — use whatever they had for their last
  // view."* That is exactly bootPlan()'s precedence, so all that changed
  // was this hash.
  //
  // Superseded 2026-11-08 by the map they pasted — the hash below is
  // now THEIRS, verbatim, FIFTEEN overlays deep: the wind animation over
  // the wind SPEED field, the pressure lines at 0.25 hPa off GFS, the
  // land's own systems (climate, soil, soil TYPE, population, cropland,
  // land cover, relief), the rivers and the basins, the tectonic faults
  // and the NASA rain.
  //
  // WHAT CHANGED AGAINST 2026-11-04, and why each half matters:
  //   · the GEOLOGY and the LIVE OCEAN CURRENTS are GONE — the currents
  //     are a 2014 altimetry field the README calls "NOT live", so a
  //     showcase map has no business opening on it;
  //   · the SOIL TYPE (HWSD), the RELIEF (ETOPO) and the TECTONIC
  //     FAULTS came in, with the wind SPEED field under the animation;
  //   · the ISOBARS went from 1 hPa to 0.25 hPa off GFS — the finest
  //     the chip ladder offers — and the wind from "colourful" to the
  //     published "by speed" ramp;
  //   · the heavy washes came UP (Köppen 20 → 100, soil 20 → 65, land
  //     cover 15 → 60, population 20 → 25) because this map is read as
  //     a PORTRAIT OF THE LAND, not as a wind chart.
  //
  // ZOOM 3, not a closer one: the guard test requires every cool map to
  // be a GLOBAL view (zoom ≤ 3), and this hash is already zoom 3, so
  // the rule and the owner's link agree. A first load should show the
  // world's wind, not a third of it.
  const PRESETS = [
    {
      // Owner's showcase (2026-11-08) — THEIR map, verbatim. Fifteen
      // overlays: the wind pair (animation + the speed field it sits
      // on), the isobars at 0.25 hPa off GFS, the land's own systems
      // (climate, soil, soil TYPE, population, cropland, land cover,
      // relief), the rivers and the basins, the faults and the rain.
      // Hash kept verbatim so it is a real, shareable app hash like
      // every other preset.
      //
      // `population-density-worldpop-1-km`, `soil-type-hwsd-v2-2` and
      // `tectonic-faults-usgs` are NOT explicit LAYER_SLUGS keys (see
      // the population preset's note): they resolve through
      // getLayerSlug()'s EXACT comparison against the module's
      // LAYER_NAME — deterministic, not a substring scan.
      id: "portrait", tier: "high", name: "🌍 Earth portrait", icon: "🌍",
      desc: "The wind over the world — climate, soil, population, land cover, relief, faults and the pressure lines beneath it",
      // Owner spec 2026-11-08 — the map they pasted, VERBATIM:
      //   https://xyzo.org/#2.1967,16.8750,3/density=max/overlay=wind-gfs@100,
      //   basins@100,koppen@100,soil-soilgrids@65,rivers@100,cropland-esa@50,
      //   population-density-worldpop-1-km@25,land-cover-esa@60,isobars@100,
      //   soil-type-hwsd-v2-2@30,wind-speed-gfs@30,tectonic-faults-usgs@100,
      //   nasa-rain@30,etopo@55/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed
      //
      // The centre is 2.20 N, 16.88 E — the Gulf of Guinea, where the
      // Congo basin's rivers, the equatorial rain and the continental
      // shelf's faults all show at once.
      hash: "#2.1967,16.8750,3/density=max/overlay=wind-gfs@100,basins@100,koppen@100,soil-soilgrids@65,rivers@100,cropland-esa@50,population-density-worldpop-1-km@25,land-cover-esa@60,isobars@100,soil-type-hwsd-v2-2@30,wind-speed-gfs@30,tectonic-faults-usgs@100,nasa-rain@30,etopo@55/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed",
    },
    {
      // Owner's own favourite (2026-11-01) — the map they pasted as
      // "a population overlay default". Nine overlays on a LIGHT base:
      // population density over soil, cropland, land cover, climate and
      // relief, tied together by basins and rivers. Hash kept verbatim
      // so it is a real, shareable app hash like every other preset.
      //
      // Its slug (`population-density-worldpop-1-km`) is NOT an explicit
      // LAYER_SLUGS key: that table lives in app.js, which sits at
      // 849,992 bytes against the 850,000 runaway ceiling (10 bytes of
      // headroom at the time of writing) — adding it would fail CI for a
      // reason unrelated to the change. It instead resolves through
      // getLayerSlug()'s EXACT comparison against the module's
      // LAYER_NAME, which is deterministic (see the test that pins it),
      // not the substring scan the explicit-key rule exists to avoid.
      // The layer registers through generic-layers.js for the same
      // byte-ceiling reason.
      id: "population", tier: "high", name: "👥 Where people live", icon: "👥",
      desc: "Population density over soil, cropland, climate, relief and rivers",
      hash: "#14.0087,14.9414,3/density=max/base=light/overlay=soil-soilgrids@45,population-density-worldpop-1-km@100,isobars@100,cropland-esa@45,koppen@30,basins@100,rivers@100,land-cover-esa@10,etopo@30",
    },
    {
      // Owner's wind map (2026-11-03). The wind animation over the wind
      // SPEED field — the speed wash is the ground the streaks lie on
      // and the two together are the whole picture — with the isobars
      // at their finest (iso=1) for the pressure pattern under it, and
      // relief, climate and the basins for the land itself.
      //
      // The wind's STYLE and COLOUR travel in the hash too
      // (`wind=flow:colourful`): a curated wind map that rendered
      // differently on every reader would not be a curated wind map.
      //
      // Zoom 3, like every other chip — "cool maps are GLOBAL views,
      // never zoomed in" (owner rule, 2026-11-01). The centre is the
      // owner's own South Atlantic view, pulled back to the global zoom
      // the rule asks for.
      id: "wind", tier: "high", name: "🌬️ Wind map", icon: "🌬️",
      desc: "Wind over the speed field, with isobars, relief and climate",
      hash: "#23.1202,-34.1895,3/density=max/overlay=basins@100,wind-speed-gfs@35,wind-gfs@100,koppen@25,etopo@20,isobars@100/iso=1/wind=flow:colourful",
    },
    {
      id: "street", tier: "high", name: "🛣️ Street mode", icon: "🛣️",
      desc: "Street map under relief, soil, cropland, land cover and a light climate wash",
      hash: "#30.2211,-22.3242,3/density=max/base=street/overlay=etopo@45,soil-soilgrids@30,cropland-esa@45,land-cover-esa@20,koppen@5",
    },
    {
      // Owner's fuller weather view (2026-11-01) — replaces the original
      // four-layer storm chip. Eleven overlays: the GFS trio plus
      // lightning, NASA rain and satellite, a Köppen wash, moisture
      // transport, and the terrain pair (rivers, basins) for context.
      // Two of its slugs (moisture-transport-ivt,
      // convective-instability-cape) reach LAYER_NAME through the
      // field-layer factory's `layerName:` argument rather than a
      // direct declaration — see the test's slug scan.
      id: "storm", tier: "high", name: "⛈️ Storm watch", icon: "⛈️",
      desc: "Temperature, wind, lightning, rain, moisture transport and instability",
      hash: "#3.4257,15.9961,3/density=high/overlay=temperature@30,wind-gfs@100,lightning@60,isobars@90,nasa-rain@100,nasa-sat@100,koppen@35,moisture-transport-ivt@45,rivers@100,basins@100,convective-instability-cape@45",
    },
    {
      id: "ocean", tier: "high", name: "🦠 Living ocean", icon: "🦠",
      desc: "Salinity, currents, waves and the plankton that drift in them",
      hash: "#0,-150,3/density=medium/overlay=salinity@70,ocean@85,waves@60,phytoplankton@85",
    },
    {
      id: "forces", tier: "high", name: "🧭 Hidden forces", icon: "🧭",
      desc: "Magnetic field, relief, geology and the basins they carve",
      hash: "#25,10,3/density=medium/overlay=magnetic@100,etopo@55,geology@60,basins@80,rivers@100",
    },
    {
      // Owner's geological view (2026-11-01), revised twice for weight
      // and once for ZOOM. First draft was geology@75 at zoom 3 over the
      // Sahara; "we might need to go slightly lighter" → geology@40 at
      // zoom 7 over the Congo basin. Then: "we don't want the geological
      // maps or any of the cool maps to zoom in — we just want global
      // views" → pulled back to a global zoom 3 like every other chip.
      //
      // Four of its six overlays overlap 🧭 Hidden forces; the
      // differences that earn it its own chip are soil-soilgrids@100 and
      // the much lighter geology.
      //
      // All six slugs are explicit LAYER_SLUGS keys, so it passes the
      // deterministic-slug rule without needing the derived route.
      id: "geology", tier: "high", name: "🪨 Geological", icon: "🪨",
      desc: "Magnetic field, relief, a light geology wash, soil, basins and rivers",
      hash: "#0.1923,15.5896,3/overlay=magnetic@100,etopo@55,geology-macrostrat@40,basins@80,rivers@100,soil-soilgrids@100",
    },
    {
      id: "lights", tier: "high", name: "🌌 Night lights", icon: "🌌",
      desc: "Night lights, flights, shipping and the friendships between cities",
      hash: "#25,10,3/density=high/overlay=nasa-night@100,transport@45,facebook@70,city-names@100",
    },
    {
      // The SATELLITE view — the base layer and nothing else. (2026-11-14.)
      //
      // This is the LOW TIER's map: the one a machine that cannot carry
      // the showcase opens on its first visit. It was the "🌱 Climate
      // skin" (Köppen + city names), and the owner described what the
      // low tier should be — *"a low rez version without any overlays
      // except the satellite view"* — which is both lighter AND more
      // honest about what "low rez" means.
      //
      // IT WAS NOT LIGHT AFTER ALL: the city-name layer alone pulls the
      // 1.16 MB city index, and the Köppen wash is a tile pyramid of its
      // own. A bare satellite view is the basemap the reader was going
      // to look at anyway.
      //
      // The pin density is MEDIUM, not the default map's max: the pins
      // are the heaviest thing a slow machine fetches (3,000 at max,
      // 1,500 at medium), and the density is a separate axis from the
      // overlays — the two views are the same MAP with a different number
      // of pins on it.
      id: "plain", tier: "low", name: "🛰️ Satellite", icon: "🛰️",
      desc: "The satellite basemap alone — light enough for any device",
      hash: "#19.9733,0.0000,2/density=medium",
    },
    {
      id: "climate", tier: "low", name: "🌱 Climate skin", icon: "🌱",
      desc: "The Köppen climate wash — light enough for any device",
      hash: "#10,20,3/density=medium/overlay=koppen@35,city-names@100",
    },
  ];

  // The FIRST-VISIT map, by device tier: the showcase on a machine that
  // can carry it, the bare satellite view on one that cannot.
  //
  // The low tier used to be the "🌱 Climate skin" (Köppen + city names)
  // — which was NOT light: the city names alone pull a 1.16 MB index.
  // It is the satellite view now, which is what the owner asked for
  // (*"a low rez version without any overlays except the satellite
  // view"*) and what a slow machine can actually carry.
  const COOL_ID = { high: "portrait", low: "plain" };

  // ── THE DEFAULT MAP ─────────────────────────────────────────────────
  //
  // What the "🛰️ Default map" button in the BOTTOM BAR restores.
  //
  // Owner spec 2026-11-13: *"can you have a easy way to 'clear the map
  // to a default satellite only view'"* — and then, with a map of their
  // own: *"maybe this default map is wiser?"*, so the button restored
  // THEIR map (satellite, the wind animation over it, the pressure lines
  // under it).
  //
  // **THAT MAP WAS TOO SLOW ON SOME COMPUTERS** (owner, 2026-11-14:
  // *"its just too slow on some computers"*), and the wind animation is
  // the reason: it is a canvas that repaints every frame, over a field
  // that has to be fetched and contoured first. So the button went back
  // to what the first ask said it was — **"a default satellite only
  // view"** — and the hash below is the owner's own link to it,
  // VERBATIM: the world view, the satellite basemap, the pin density at
  // max, and **no overlays at all**.
  //
  // WHY IT IS A HASH AND NOT A LIST OF LAYERS: the map's vocabulary is
  // the hash (a shared link, a preset and a saved style all speak it),
  // so the button speaks it too and goes through the SAME parse → apply
  // path (`parseHash()` → `applyMapState()` → `applySavedStyle()` →
  // `applyLayersFromParsedHash()`). A button that assembled the view
  // itself would be a SECOND implementation of "what a map is", and the
  // second implementation is the one that drifts.
  //
  // `base` is stated HERE and not in the hash: the hash names no base
  // layer, so a reader who is on the street map and presses the button
  // would keep the street map. "The default map" means the default
  // BASEMAP too — the satellite one.
  //
  // THE HASH NAMES NO `overlay=` SEGMENT, and that is the POINT: the
  // hash-apply path only ADDS, but `applySavedStyle()` REMOVES every
  // overlay the state does not contain first — so a hash with no
  // overlays list is a hash that says "none", and the button clears the
  // map rather than adding to it.
  const DEFAULT_MAP = {
    id: "default",
    name: "🛰️ Default map",
    desc: "Satellite only — no overlays",
    hash: "#19.9733,0.0000,2/density=max",
    base: "satellite",
  };

  /** The default map, as a copy (a caller must not edit the constant). */
  function defaultMap() { return Object.assign({}, DEFAULT_MAP); }

  /**
   * The default map as a STATE (the shape applyMapState() consumes), or
   * null if the hash will not parse. The base layer is filled in here,
   * so the button always lands on the satellite basemap.
   */
  function defaultMapState() {
    const state = parseHash(DEFAULT_MAP.hash);
    if (!state) return null;
    if (!state.base) state.base = DEFAULT_MAP.base;
    return state;
  }

  function presets() { return PRESETS.slice(); }
  function presetById(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  /**
   * Is this machine worth showing the heavy showcase map to?
   *
   * "high" needs: no save-data, no 2G/3G, ≥ 4 cores, and either no RAM
   * info (desktop Safari/Firefox hide it) or ≥ 4 GB. A narrow screen
   * (< 480 px — a phone) is demoted unless it admits ≥ 8 GB: a dozen
   * tile pyramids and four grid downloads thermally throttle a phone
   * into a stuttering first impression.
   */
  function deviceTier(nav) {
    // `nav === null` means "there is no navigator" and must NOT fall
    // back to the ambient one (bun and workers define their own).
    const n = (nav === undefined && typeof navigator !== "undefined")
      ? navigator : nav;
    if (!n) return "low";
    try {
      const c = n.connection || n.webkitConnection || null;
      if (c) {
        if (c.saveData) return "low";
        if (c.effectiveType && /^(slow-2g|2g|3g)$/.test(c.effectiveType)) return "low";
      }
      const mem = typeof n.deviceMemory === "number" ? n.deviceMemory : null;
      if (mem != null && mem < 4) return "low";
      const cores = typeof n.hardwareConcurrency === "number" ? n.hardwareConcurrency : 0;
      if (cores && cores < 4) return "low";
      const w = typeof G.innerWidth === "number" ? G.innerWidth : 0;
      if (w > 0 && w < 480 && (mem == null || mem < 8)) return "low";
      return "high";
    } catch (_) { return "low"; }
  }

  /** The state a preset denotes, or null if it will not parse. */
  function presetState(preset) {
    if (!preset || typeof preset.hash !== "string") return null;
    return parseHash(preset.hash);
  }

  /** The preset a first visit (or "✨ Cool" mode) opens, for this device. */
  function coolPreset(nav) {
    return presetById(COOL_ID[deviceTier(nav)] || COOL_ID.low);
  }

  // ── defaults & last-used ───────────────────────────────────────────
  function saveDefault(state) {
    const clean = sanitizeState(state);
    if (!clean) return false;
    clean.ts = Date.now();
    return saveJson(DEFAULT_KEY, clean);
  }
  function getDefault() { return sanitizeState(loadJson(DEFAULT_KEY)); }
  function clearDefault() {
    const s = store();
    if (!s) return false;
    try { s.removeItem(DEFAULT_KEY); return true; } catch (_) { return false; }
  }

  function autoSave(state) {
    const clean = sanitizeState(state);
    if (!clean) return false;
    clean.ts = Date.now();
    return saveJson(LAST_KEY, clean);
  }
  function lastState() { return sanitizeState(loadJson(LAST_KEY)); }

  function getMode() {
    const s = store();
    let m = null;
    try { m = s ? s.getItem(MODE_KEY) : null; } catch (_) {}
    return MODES.indexOf(m) >= 0 ? m : "auto";
  }
  function setMode(mode) {
    const s = store();
    if (!s) return "auto";
    const m = MODES.indexOf(mode) >= 0 ? mode : "auto";
    try { s.setItem(MODE_KEY, m); } catch (_) {}
    return m;
  }

  /**
   * What the next visit should open with. Called by app.js ONLY when
   * the URL carried no hash and no ?base=/&overlay= — a shared link is
   * an explicit instruction and always wins.
   *
   * @returns {{source: "saved"|"auto"|"cool", state: object}|null}
   */
  function bootPlan(nav) {
    const mode = getMode();
    const def = getDefault();
    const last = lastState();

    // An explicit ⭐ default wins in every mode except "✨ Cool" —
    // there the user asked for the curated map, so that is what opens.
    if (mode !== "cool" && def) return { source: "saved", state: def };
    // No default saved (or it vanished with the storage): whatever they
    // used last time.
    if (mode !== "cool" && last) return { source: "auto", state: last };
    // First visit ever, or "✨ Cool" chosen: the curated map this
    // machine can carry.
    const p = coolPreset(nav);
    const state = p && presetState(p);
    if (state) return { source: "cool", state: state, presetId: p.id };
    return null;
  }

  const api = {
    DEFAULT_KEY, LAST_KEY, MODE_KEY, MODES,
    presets, presetById, presetState, coolPreset, deviceTier, parseHash,
    sanitizeState,
    DEFAULT_MAP, defaultMap, defaultMapState,
    saveDefault, getDefault, clearDefault,
    autoSave, lastState,
    getMode, setMode,
    bootPlan,
  };

  if (typeof window !== "undefined") window.MapPresets = api;
  if (typeof globalThis !== "undefined") globalThis.MapPresets = api;
})();
