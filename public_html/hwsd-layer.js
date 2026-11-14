/* ═══════════════════════════════════════════════════════════════════════
   HWSD v2.2 — WRB soil group names (FAO & IIASA)

   The Harmonized World Soil Database version 2.2 is a global soil
   inventory at ~1 km (30 arc-second), classifying every cell into one
   of 34 FAO 1990 Revised Legend units correlated to WRB 2022 —
   Acrisols, Arenosols, Ferralsols, Vertisols, and so on. It is the
   "what kind of soil is HERE" map, as opposed to SoilGrids' "how much
   sand / clay / carbon is HERE".

   Source: FAO & IIASA, Harmonized World Soil Database v2.2
   (data.apps.fao.org · GAEZ V5), published 2023-01-27, revised
   2026-09-30. **CC BY 4.0** — attribution only, no NonCommercial, no
   ShareAlike. See docs/DATA_LICENSES.md.

   WHY IT IS HOTLINKED, NOT BAKED
   ------------------------------
   A faithful 1 km pyramid is millions of tiles; a WMTS GetTile IS an
   XYZ template Leaflet reads directly, so it costs zero stored bytes.
   The same trade NASA GIBS, Macrostrat and the FAO WorldPop overlay
   already made. The URL below was NOT taken from the catalogue — the
   catalogue's copy is wrong in two ways, both found by asking the
   service (this is the third time in this repo):

     • `tilematrixset=EPSG:900913` → HTTP 400. The service's real
       name is `WebMercatorQuad`.
     • the `style` parameter is omitted → HTTP 400
       `Missing 'GetTile' parameters: {'style'}`. WMTS always requires
       one. `style=default` is correct.
     • the catalogue writes `TileCol={y}&TileRow={x}` — SWAPPED. The
       tiles are ordinary XYZ: `TileCol={x}&TileRow={y}`.

   THE PROBE READS THE TILE'S OWN PIXEL
   ------------------------------------
   The tiles are pre-coloured by FAO, so the class under the cursor is
   decoded from the pixel rather than from a grid — the same
   "we hold a picture, not values" position the population overlay
   takes, except here the picture DOES carry a value (a class id) and
   the legend publishes the colour for each one. It needs
   `crossOrigin: true` so `getImageData` is not tainted; FAO answers
   `Access-Control-Allow-Origin: https://xyzo.org`, verified 2026-11-05.

   Pane: `hwsdPane` (z-index **370** — the slot the wind animation
   vacated when it moved to 379; see AGENTS.md "Overlay Pane Stack").
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (typeof L === "undefined") {
    if (window.XLog && window.XLog.warn) window.XLog.warn("hwsd-layer: Leaflet missing");
    return;
  }

  const PANE = "hwsdPane";
  // Unquoted on purpose: overlay-contracts.bun.test.js's Z_RE reads
  // `PANE_Z = <digits>` out of the source, and a quoted `"370"` does
  // not match it — the test then reports "declares a pane but no
  // z-index" and fails. Same shape as population-layer.js.
  const PANE_Z = 370;
  const LAYER_NAME = "🟫 Soil type (HWSD v2.2)";
  const ATTRIBUTION =
    "Soil type: FAO & IIASA, Harmonized World Soil Database v2.2 (HWSD) — CC BY 4.0";
  const STORE_KEY = "xyzo.hwsdLayer";

  // Served through OUR OWN mirror. The whole WMTS query — layer, matrix
  // set, style — is fixed server-side in api/src/routes/tileMirror.ts,
  // so the client sends nothing but z/x/y, and the copy on our disk is
  // revalidated against FAO every 7 days (a WorldPop-scale release does
  // not move faster than that). No file extension, because Caddy's
  // `@staticAssets` block stamps `*.png` with a year of `immutable`,
  // which would defeat that revalidation.
  const WMTS_URL = "/api/tile/mirror/hwsd/{z}/{x}/{y}";

  // The 34 classes, in the legend's own order, with the swatch colour
  // each tile is painted with. Extracted from the service's own
  // `GetLegendGraphic` (221×1154 PNG) on 2026-11-05: one swatch per
  // text row, paired with the class list in order. If FAO ever
  // re-colours the legend this table goes stale — the probe would then
  // name the wrong class, which is why the probe reports "unknown
  // colour" rather than guessing when the distance is large.
  const CLASSES = [
    ["Acrisols", "#f79804"], ["Alisols", "#ffffbe"], ["Andosols", "#fe0000"],
    ["Arenosols", "#f5d4a1"], ["Anthrosols", "#cf9804"], ["Chernozems", "#914d35"],
    ["Calcisols", "#fef400"], ["Cambisols", "#febe00"], ["Cryosols", "#4b3dac"],
    ["Durisol", "#efe4be"], ["Fluvisols", "#00fefd"], ["Ferralsols", "#ff8721"],
    ["Gleysols", "#8083d9"], ["Gypsisols", "#fef6a4"], ["Histosols", "#706b66"],
    ["Kastanozems", "#ca937f"], ["Leptosols", "#d1d1d1"], ["Luvisols", "#fa8484"],
    ["Lixisols", "#ffbebe"], ["Nitisols", "#ffa77f"], ["Phaeozems", "#bd6446"],
    ["Planosols", "#f77d3a"], ["Plinthosols", "#730000"], ["Podzols", "#0cd900"],
    ["Regosols", "#fee3a4"], ["Retisols", "#fec2c2"], ["Solonchaks", "#fe00fa"],
    ["Solonetz", "#f9c2fe"], ["Stagnosols", "#40c0e9"], ["Technosols", "#91009d"],
    ["Umbrisols", "#738e7f"], ["Vertisols", "#c500ff"],
    ["Open inland water", "#0000ff"], ["Glaciers", "#d4d4d4"],
  ];

  const RGB = CLASSES.map(function (c) {
    const n = parseInt(c[1].slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });

  const state = {
    map: null,
    layer: null,
    pane: null,
    enabled: false,
    opacity: 1,
    probe: null,
    lastProbe: "",
  };

  function log(...a) { if (window.XLog) window.XLog.debug(...a); }

  function storageGet(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : v; }
    catch (_) { return d; }
  }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  // ── the tile layer ─────────────────────────────────────────────────────
  function makeLayer() {
    if (state.layer) return state.layer;
    // `crossOrigin: true` is what makes the probe possible: without it
    // the canvas is tainted and getImageData throws. FAO answers
    // Access-Control-Allow-Origin for our origin.
    state.layer = L.tileLayer(WMTS_URL, {
      pane: PANE,
      maxZoom: 12,
      minZoom: 0,
      // 30 arc-second is ~1 km, so anything past z12 is upscaling.
      maxNativeZoom: 9,
      opacity: state.opacity,
      attribution: ATTRIBUTION,
      crossOrigin: true,
      // The tiles are a classification, not a photograph: no
      // interpolation between them, or a boundary between two soil
      // units becomes a blend of neither.
      className: "xyzo-hwsd-tiles",
    });
    return state.layer;
  }

  // ── the legend ────────────────────────────────────────────────────────
  //
  // 34 classes make a static key impossible to keep in the reader's
  // head, and the probe only helps if you are already pointing at
  // something. The key lives in the layers dropdown — the same place
  // the Köppen key and the isobar controls live — and it is appended
  // to `.leaflet-control-layers-list`, the <section> that WRAPS the two
  // lists Leaflet empties and rebuilds on every layer change.
  //
  // THREE ELEMENTS, AND ONLY ONE OF THEM IS SAFE TO ADD TO:
  //   `.leaflet-control-layers-overlays`  ← Leaflet EMPTIES this
  //   `.leaflet-control-layers-list`      ← the section; persists
  //   `.leaflet-control-layers`           ← the control; persists, but
  //     it is OUTSIDE the section, so anything there escapes both the
  //     panel's scroll box and Leaflet's collapsed/expanded toggle.
  // The bug was landing in the third (see mountLegend below).
  // Returns true once the key is on the page, so the caller can retry.
  // It has to: app.js's layer-init loop runs BEFORE `L.control.layers()`
  // creates the list (1754 against 3985), so on the first attempt there
  // is nothing to inject into — which is why the climate, soil and
  // temperature legends all retry the same way.
  function mountLegend() {
    const list = document.querySelector(".leaflet-control-layers-list");
    // NO LIST YET IS A FAILURE, NOT A SUCCESS. The first version
    // returned true here (`if (!list || …) return true`), which told
    // waitForLayersControl the key was mounted and stopped the retry —
    // so the legend never appeared. The list is created by
    // `L.control.layers()`, which runs AFTER this module's init loop.
    if (!list) return false;
    if (document.getElementById("hwsd-legend")) return true;
    if (!list.parentElement) return false;

    const box = document.createElement("div");
    box.id = "hwsd-legend";
    box.className = "hwsd-legend";
    box.hidden = !state.enabled;

    const title = document.createElement("div");
    title.className = "hwsd-legend-title";
    title.textContent = "Soil type — WRB group (HWSD v2.2)";
    box.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "hwsd-legend-grid";
    for (let i = 0; i < CLASSES.length; i++) {
      const row = document.createElement("div");
      row.className = "hwsd-legend-row";
      const dot = document.createElement("span");
      dot.className = "hwsd-legend-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.style.background = CLASSES[i][1];
      const name = document.createElement("span");
      name.textContent = CLASSES[i][0];
      row.appendChild(dot);
      row.appendChild(name);
      grid.appendChild(row);
    }
    box.appendChild(grid);

    // CHILD of the section, SIBLING of the two lists Leaflet rebuilds —
    // and NOT a sibling of the section itself. That is the whole
    // distinction, and getting it wrong is what the owner reported:
    // "its kinda showing up on the side when it shouldnt".
    //
    // `insertAdjacentElement("afterend", box)` put the key AFTER the
    // <section class="leaflet-control-layers-list">, i.e. directly in
    // `.leaflet-control-layers` — outside the panel's scroll box
    // (measured: list bottom 843 px, legend 843 → 1172, while
    // `scrollHeight` 5118 ran on inside the section) and, worse,
    // OUTSIDE the element Leaflet hides when the dropdown closes. So a
    // collapsed panel — the state every first visit starts in — showed a
    // 221 × 329 legend box hanging under the stack button while every
    // other key (soil: 0 × 0) was correctly hidden.
    //
    // Leaflet only ever empties `.leaflet-control-layers-base` and
    // `.leaflet-control-layers-overlays`, so appending to the section
    // survives every layer change — which is what the header comment
    // always said the code did.
    list.appendChild(box);
    return true;
  }

  function waitForLayersControl() {
    if (mountLegend()) { setLegendVisible(state.enabled); return; }
    let tries = 0;
    const tick = function () {
      if (mountLegend() || ++tries > 40) { setLegendVisible(state.enabled); return; }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  function setLegendVisible(on) {
    const box = document.getElementById("hwsd-legend");
    if (!box) return;
    box.hidden = !on;
    if (on) revealLegend();
  }

  // The key is 3,200 px down a 5,000 px dropdown, so a reader who ticks
  // "Soil type" sees the map change and NO key at all — the key is
  // somewhere below twenty other legends. Bring it into view when the
  // layer is switched on, and only when it is not already visible.
  //
  // It is the DROPDOWN's own scroll box that moves: the key is a child
  // of .leaflet-control-layers-list, so scrollIntoView on it scrolls
  // that box and nothing else.
  function revealLegend() {
    const box = document.getElementById("hwsd-legend");
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!box || !list) return;
    try {
      const b = box.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      // Already on screen — do not move the reader's scroll for nothing.
      if (b.top >= l.top - 2 && b.bottom <= l.bottom + 2) return;
      const reduce = typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      box.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    } catch (_) {}
  }

  // ── the probe ─────────────────────────────────────────────────────────
  //
  // Read the CLASS out of the tile under the cursor. The tiles are
  // pre-coloured, so this is a colour lookup — and the honest answer
  // when nothing matches is "unknown colour", never a guess: a wrong
  // soil unit is worse than no reading.
  // A decoded tile, keyed by its URL. The probe draws each tile to a
  // canvas to read one pixel — doing that per mousemove would be a
  // drawImage + getImageData on every frame, so each tile is decoded
  // ONCE and the pixel is read from the cached bitmap. The browser
  // already caches the tile itself, so the cache key hits immediately.
  const _decoded = new Map();

  function decodedTile(img) {
    const key = img.currentSrc || img.src;
    const hit = _decoded.get(key);
    if (hit) return hit;
    if (!img.naturalWidth || !img.complete) return null;
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
      // A hard ceiling: the map is 12 tiles across at most, so a few
      // hundred entries is a full world. Anything past that is a leak.
      if (_decoded.size > 400) _decoded.clear();
      _decoded.set(key, c);
      return c;
    } catch (_) {
      return null;   // tainted or not decoded — see classAt()
    }
  }

  function classAt(latlng) {
    const map = state.map;
    if (!map) return null;
    const cp = map.latLngToContainerPoint(latlng);
    const x = cp.x, y = cp.y;
    // The tile that covers this point. Leaflet positions its tiles with
    // left/top in container coordinates, so a hit test on the rects is
    // enough — no need to reproject.
    const tiles = state.pane ? state.pane.querySelectorAll("img") : [];
    for (let i = 0; i < tiles.length; i++) {
      const img = tiles[i];
      const r = img.getBoundingClientRect();
      const host = map.getContainer().getBoundingClientRect();
      const lx = x + host.left - r.left;
      const ly = y + host.top - r.top;
      if (lx < 0 || ly < 0 || lx >= r.width || ly >= r.height) continue;
      if (!img.naturalWidth) continue;
      const bmp = decodedTile(img);
      if (!bmp) {
        // Tainted canvas (the CORS header did not arrive) or the image
        // is not decoded yet. Say so rather than naming a soil type we
        // cannot see.
        return { name: "reading…", rgb: null };
      }
      let data;
      try {
        data = bmp.getContext("2d", { willReadFrequently: true }).getImageData(
          Math.floor((lx / r.width) * bmp.width),
          Math.floor((ly / r.height) * bmp.height), 1, 1).data;
      } catch (_) {
        return { name: "reading…", rgb: null };
      }
      if (data[3] < 16) return { name: "no data", rgb: null };
      return nearest(data[0], data[1], data[2]);
    }
    return null;
  }

  function nearest(r, g, b) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < RGB.length; i++) {
      const c = RGB[i];
      const d = (c[0] - r) * (c[0] - r) + (c[1] - g) * (c[1] - g) + (c[2] - b) * (c[2] - b);
      if (d < bestD) { bestD = d; best = i; }
    }
    // A tile boundary blends two classes; a far match means we are on a
    // blend or on a colour FAO changed. Report it, do not pretend.
    if (bestD > 900) return { name: "unknown colour", rgb: [r, g, b] };
    return { name: CLASSES[best][0], rgb: RGB[best] };
  }

  function ensureProbe() {
    if (state.probe && state.probe.isConnected) return state.probe;
    const el = document.createElement("div");
    el.className = "hwsd-probe";
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    const host = (state.map && state.map.getContainer()) || document.body;
    host.appendChild(el);
    state.probe = el;
    return el;
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled) return;
    const hit = classAt(latlng);
    const el = ensureProbe();
    if (!hit) { el.hidden = true; return; }
    let html = "";
    if (hit.rgb) {
      html += '<span class="hwsd-probe-dot" style="background:rgb(' +
        hit.rgb[0] + "," + hit.rgb[1] + "," + hit.rgb[2] + ')"></span>';
    }
    html += "<strong>" + hit.name + "</strong>";
    if (state.lastProbe !== html) {
      el.innerHTML = html;
      state.lastProbe = html;
    }
    if (containerPoint) {
      // Container points, never a pane: a pane child rides Leaflet's
      // translate and the tooltip ends up paneOffset from the cursor.
      el.style.left = (containerPoint.x + 14) + "px";
      el.style.top = (containerPoint.y + 14) + "px";
    }
    el.hidden = false;
  }

  function hideProbe() {
    if (state.probe) { state.probe.hidden = true; state.lastProbe = ""; }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  function init(map) {
    if (!map || state.map) return;
    state.map = map;

    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      pane.style.zIndex = String(PANE_Z);
      // A wash must never swallow a click: the pane sits over the map,
      // and a pointer-events pane would break the click-to-submit flow
      // and every probe that owns a click.
      pane.style.pointerEvents = "none";
    }
    state.pane = map.getPane(PANE);

    // LISTENERS BEFORE THE RESTORE, and before any hash can add the
    // layer. app.js's `applyLayersFromParsedHash` calls
    // `WEATHER_OVERLAYS[name].addTo(map)`, which fires `overlayadd` —
    // if nothing is listening yet, `state.enabled` stays false while
    // the checkbox looks checked, and the legend and the probe both
    // stay off over a map that IS showing the tiles. This is the same
    // trap the population and magnetic layers shipped with; the fix is
    // the same.
    map.on("overlayadd", function (e) {
      if (state.layer && e.layer === state.layer) {
        state.enabled = true;
        setLegendVisible(true);
      }
    });
    map.on("overlayremove", function (e) {
      if (state.layer && e.layer === state.layer) {
        state.enabled = false;
        setLegendVisible(false);
        hideProbe();
      }
    });

    // The stored preference. Flip DIRECTLY: at init time the layers
    // control does not exist yet, so there is no overlayadd to catch —
    // the same reason the population layer does it this way.
    if (storageGet(STORE_KEY, "0") === "1") {
      const layer = makeLayer();
      try { if (!map.hasLayer(layer)) layer.addTo(map); } catch (_) {}
      state.enabled = !!(state.layer && map.hasLayer(state.layer));
    }

    // The reader's hover, not a click: this is a reading, not an
    // action, so it must not steal the map's clicks.
    map.on("mousemove", function (e) {
      if (!state.enabled) return;
      if (window.HoverInfo && typeof window.HoverInfo.suppressesProbes === "function" &&
          window.HoverInfo.suppressesProbes()) {
        // The card is carrying this reading now — and a box that merely
        // STOPS updating keeps the last text it was given, so it would
        // go on saying the soil type beside the card that says it too.
        // It has to go, not freeze.
        hideProbe();
        return;
      }
      updateProbe(e.latlng, e.containerPoint);
    });
    map.on("mouseout", hideProbe);

    // And the same when the reader switches the HUD to "Everything"
    // without moving the pointer: the box would otherwise sit there
    // until the next mousemove.
    if (!window.__xyzoHwsdModeListener) {
      window.__xyzoHwsdModeListener = true;
      window.addEventListener("xyzo:hover-mode", function (e) {
        if (e && e.detail && e.detail.mode === "all") hideProbe();
      });
    }

    // The legend mounts after the layers control exists — and the
    // control is created AFTER this init loop runs, so it always needs
    // the retry on a cold boot.
    waitForLayersControl();
  }

  function setEnabled(on) {
    const next = !!on;
    if (next === state.enabled) return;
    state.enabled = next;
    storageSet(STORE_KEY, next ? "1" : "0");
    if (!state.map) return;
    if (next) {
      makeLayer().addTo(state.map);
      waitForLayersControl();
    } else {
      if (state.layer) state.map.removeLayer(state.layer);
      setLegendVisible(false);
      hideProbe();
    }
  }

  function setOpacity(v) {
    const o = Math.max(0, Math.min(1, Number(v)));
    if (!Number.isFinite(o)) return;
    state.opacity = o;
    // No storage key of our own: overlay-opacity.js's `xyzo.overlayOpacity`
    // (keyed by LAYER_NAME) is the one store that restores on the next
    // visit — a second key here would be written and never read, and the
    // two would drift. Same shape as population-layer.js.
    if (state.layer) state.layer.setOpacity(o);
  }
  function getOpacity() { return state.opacity; }

  window.HWSDLayer = {
    init,
    LAYER_NAME,
    getTileLayer: function () { return makeLayer(); },
    isEnabled: function () { return state.enabled; },
    setEnabled,
    setOpacity,
    getOpacity,
    // The reading is a hover, so it never owns the map's clicks.
    blocksClick: function () { return false; },
    sampleAt: function (latlng) {
      if (!state.enabled) return null;
      const hit = classAt(latlng);
      if (!hit || !hit.name || hit.name === "no data" || hit.name === "reading…") return null;
      return "Soil: " + hit.name;
    },
    registerExport: function () { /* a picture of classes — see the header */ },
    _state: state,
    _classes: CLASSES,
  };
})();
