/* ═══════════════════════════════════════════════════════════════════════
   Earthquakes overlay for the Xyzo map — USGS summary feeds.

   Source: U.S. Geological Survey, Earthquake Hazards Program (public domain)
     https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/
   Licence: Public domain — USGS asks to be credited, and the credit is
   printed on the map (options.attribution) as well as in meta.json.

   scripts/earthquake_build.py writes:

     /data/earthquakes/hour.geojson    the last hour
     /data/earthquakes/day.geojson     the last 24 hours
     /data/earthquakes/week.geojson    the last 7 days
     /data/earthquakes/month.geojson   the last 30 days
     /data/earthquakes/meta.json       licence, counts, colour + radius scales

   The four windows are four files on purpose: the client fetches ONLY the
   window the reader asked for, so the "last hour" view costs a few hundred
   bytes and the 30-day view (about 10,000 events) is never dragged over
   the wire by a page that only wanted the last hour.

   WHY THE CLICK IS NOT A LEAFLET MARKER CLICK
   ───────────────────────────────────────────
   The map's own pin canvas lives in Leaflet's overlayPane (z-index 400) and
   covers the whole map with `pointer-events: auto`, so a vector layer in a
   LOWER pane never receives the click — measured with Playwright: the
   click lands on the pin canvas, the news pin opens and the earthquake
   below it is unreachable. The markerPane would work, but it paints the
   earthquakes OVER the news pins, which are the site's actual content.

   So the markers are drawn non-interactively and the CLICK IS HIT-TESTED
   HERE, on Leaflet's `preclick` — the event Leaflet fires immediately
   BEFORE the map's own `click`, and only when the click was not a drag.
   Opening the popup there also sets the site's `_lastPopupOpenAt`
   timestamp, which is what stops the click-to-submit overlay from opening
   a story form on top of the earthquake the reader just clicked.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/earthquakes";
  const PANE = "earthquakePane";
  // 368 — above every wash and every physical line layer (the wind-speed
  // wash is 366, the fault lines 367), below the wind animation (370),
  // the city labels (380) and the pin canvas (400). Earthquakes are
  // geography the reader clicks on, not news, so they stay under the
  // pins. Checked against the source, not against a remembered table:
  // 366 and 367 were already taken when this file was written.
  const PANE_Z = 368;
  const STORE_KEY = "xyzo.earthquakeLayer";
  const WINDOW_STORE_KEY = "xyzo.earthquakeWindow";
  const DEFAULT_WINDOW = "day";
  const REFRESH_MS = 10 * 60 * 1000;   // the builder publishes every 10 min
  const DEFAULT_EVENT_PAGE = "https://earthquake.usgs.gov/earthquakes/eventpage/{id}/executive";
  const ATTRIBUTION = "U.S. Geological Survey, Earthquake Hazards Program (public domain)";

  // The four windows. `chip` is what the switcher button says.
  const WINDOWS = [
    { id: "hour", label: "Last hour", chip: "1 h" },
    { id: "day", label: "Last 24 hours", chip: "24 h" },
    { id: "week", label: "Last 7 days", chip: "7 d" },
    { id: "month", label: "Last 30 days", chip: "30 d" },
  ];
  const WINDOW_IDS = WINDOWS.map((w) => w.id);

  // THE AGE → COLOUR SCALE. Red is "it is happening now", and the scale
  // cools as the event ages. The same table is published in meta.json, and
  // the client reads ITS copy from there when it arrives — a second hand-
  // written copy of these thresholds is a second source of truth.
  const AGE_COLORS = [
    { id: "hour", label: "Last hour", tint: "< 1 h", maxAgeMs: 3600e3, color: "#ff2d2d" },
    { id: "day", label: "Last 24 hours", tint: "< 24 h", maxAgeMs: 24 * 3600e3, color: "#ff7a1a" },
    { id: "week", label: "Last 7 days", tint: "< 7 d", maxAgeMs: 7 * 24 * 3600e3, color: "#ffd21f" },
    { id: "month", label: "Last 30 days", tint: "< 30 d", maxAgeMs: 30 * 24 * 3600e3, color: "#4aa3ff" },
    { id: "older", label: "Older", tint: "> 30 d", maxAgeMs: null, color: "#8b9bb4" },
  ];

  // THE MAGNITUDE → RADIUS SCALE, in pixels.
  const RADIUS_BASE = 3;
  const RADIUS_PER_MAG = 2.2;
  const RADIUS_MIN = 4;
  const RADIUS_MAX = 26;

  const state = {
    map: null,
    layer: null,          // L.geoJSON FeatureGroup
    enabled: false,
    window: DEFAULT_WINDOW,
    meta: null,
    features: null,       // the FeatureCollection of the ACTIVE window
    index: null,          // flat array for the hit-test and the HUD sampler
    cache: {},            // window id -> FeatureCollection
    loadPromise: null,
    opacity: 0.9,
    legendMounted: false,
    renderer: null,
    refreshTimer: null,
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
  // The house rule: every piece of user or upstream text goes through
  // escapeHtml() before it reaches innerHTML.
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── the scales ───────────────────────────────────────────────────────
  function radiusForMag(mag) {
    const m = typeof mag === "number" && isFinite(mag) ? mag : 0;
    const r = RADIUS_BASE + RADIUS_PER_MAG * (m - 1);
    return Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, r));
  }

  function ageClassFor(ageMs) {
    for (const c of AGE_COLORS) {
      if (c.maxAgeMs === null) return c;
      if (ageMs < c.maxAgeMs) return c;
    }
    return AGE_COLORS[AGE_COLORS.length - 1];
  }

  function colorForAge(ageMs) {
    return ageClassFor(ageMs).color;
  }

  function ageOf(props) {
    const t = props && typeof props.time === "number" ? props.time : 0;
    return Math.max(0, Date.now() - t);
  }

  // ── styling ──────────────────────────────────────────────────────────
  function styleFor(feature) {
    const p = (feature && feature.properties) || {};
    return {
      renderer: state.renderer,
      radius: radiusForMag(p.mag),
      // A white hairline so the dot reads on the dark satellite basemap
      // AND on a pale street map.
      color: "#ffffff",
      weight: 1,
      fillColor: colorForAge(ageOf(p)),
      fillOpacity: 0.85 * state.opacity,
      opacity: 0.45 * state.opacity,
      // NOT interactive: the pin canvas covers this pane, so a Leaflet
      // marker click could never arrive here. The click is hit-tested on
      // `preclick` instead (see the header).
      interactive: false,
    };
  }

  function restyle() {
    if (!state.layer || !state.features) return;
    state.layer.eachLayer((ly) => {
      if (ly.feature && typeof ly.setStyle === "function") ly.setStyle(styleFor(ly.feature));
    });
  }

  // ── data ─────────────────────────────────────────────────────────────
  function windowUrl(id) {
    return BASE + "/" + id + ".geojson";
  }
  function metaUrl() {
    return BASE + "/meta.json";
  }

  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    // `cache: "no-cache"` revalidates with the origin instead of trusting
    // the browser's heuristic cache — the file changes every ten minutes,
    // and Caddy sends no Cache-Control for .geojson.
    return fetch(metaUrl(), { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m) {
          state.meta = m;
          mountLegend();
        }
        return m;
      })
      .catch((e) => { warn("[earthquakes] meta load failed", e); return null; });
  }

  function ensureWindow(id, force) {
    const wid = WINDOW_IDS.indexOf(id) >= 0 ? id : DEFAULT_WINDOW;
    if (!force && state.cache[wid]) return Promise.resolve(state.cache[wid]);
    if (!force && state.loadPromise && state.loadPromise.id === wid) {
      return state.loadPromise.promise;
    }
    const promise = fetch(windowUrl(wid), { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((fc) => {
        state.cache[wid] = fc;
        state.loadPromise = null;
        log("[earthquakes] loaded", (fc.features || []).length, "events for", wid);
        return fc;
      })
      .catch((e) => {
        state.loadPromise = null;
        warn("[earthquakes] load failed for", wid, e);
        throw e;
      });
    state.loadPromise = { id: wid, promise: promise };
    return promise;
  }

  // The flat index the hit-test and the HUD sampler walk. One array, one
  // projection per candidate — the same shape the pin renderer uses.
  function buildIndex(fc) {
    const out = [];
    const feats = (fc && fc.features) || [];
    for (const f of feats) {
      const c = f.geometry && f.geometry.coordinates;
      const p = f.properties || {};
      if (!c || c.length < 2) continue;
      out.push({
        lat: Number(c[1]),
        lng: Number(c[0]),
        radius: radiusForMag(p.mag),
        props: p,
      });
    }
    return out;
  }

  // ── the overlay layer ────────────────────────────────────────────────
  function ensurePane(map) {
    if (map.getPane(PANE)) return;
    map.createPane(PANE);
    const pane = map.getPane(PANE);
    pane.style.zIndex = String(PANE_Z);
    // The pane itself never takes the click — the hit-test runs on the
    // map's preclick, so the click still reaches the map (and the site's
    // click-to-submit flow) everywhere it should.
    pane.style.pointerEvents = "none";
  }

  function buildLayer() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    // Canvas, not SVG: the 30-day window is about 10,000 circles, and
    // 10,000 SVG paths is a lot of DOM to pan.
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
    const group = window.L.geoJSON(null, {
      pane: PANE,
      pointToLayer: (feature, latlng) =>
        window.L.circleMarker(latlng, styleFor(feature)),
      style: (ft) => styleFor(ft),
      interactive: false,
      attribution: ATTRIBUTION,
    });
    // OverlayOpacity.mount() calls setOpacity() on every entry in
    // WEATHER_OVERLAYS, and a raw L.geoJSON has no such method.
    group.setOpacity = (v) => setOpacity(v);
    group.getOpacity = () => getOpacity();
    return group;
  }

  function getTileLayer() {
    if (!state.layer) state.layer = buildLayer();
    return state.layer;
  }

  function fillLayer(fc) {
    if (!state.layer) state.layer = getTileLayer();
    if (!state.layer || !fc) return;
    state.features = fc;
    state.index = buildIndex(fc);
    state.layer.clearLayers();
    state.layer.addData(fc);
    updateLegendCounts();
  }

  // ── the popup ────────────────────────────────────────────────────────
  function eventUrl(id) {
    const template = (state.meta && state.meta.event_page) || DEFAULT_EVENT_PAGE;
    return template.replace("{id}", encodeURIComponent(id || ""));
  }

  function relativeAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + " s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }

  function popupHtml(p) {
    const props = p || {};
    const mag = (typeof props.mag === "number") ? props.mag.toFixed(1) : "?";
    const place = props.place || "Unknown location";
    const when = new Date(props.time || 0);
    const utc = isNaN(when.getTime()) ? "unknown" : when.toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const local = isNaN(when.getTime()) ? "unknown" : when.toLocaleString();
    const depth = (typeof props.depth === "number") ? props.depth.toFixed(1) + " km" : "unknown";
    const felt = (typeof props.felt === "number") ? String(props.felt) : "none reported";
    const tsunami = props.tsunami ? "Yes" : "No";
    const evType = props.type || "earthquake";
    const status = props.status || "";
    const alert = props.alert || "";
    const id = props.id || "";
    const url = eventUrl(id);
    const isMobile = window.innerWidth <= 768;
    // Leaflet's own × is hidden by the house stylesheet, so a popup
    // without one of these has NO way to be closed at all.
    const closeBtn = isMobile
      ? '<button class="popup-close-btn-mobile" aria-label="Close popup">✕ Close</button>'
      : '<button class="popup-close-btn" aria-label="Close popup">✕</button>';
    const rows = [
      ["Depth", escapeHtml(depth)],
      ["Felt reports", escapeHtml(felt)],
      ["Tsunami", escapeHtml(tsunami)],
      ["Type", escapeHtml(evType)],
    ];
    if (status) rows.push(["Status", escapeHtml(status)]);
    if (alert) rows.push(["Alert", escapeHtml(alert)]);
    return (
      '<div class="eq-popup">' +
      closeBtn +
      '<div class="eq-popup-head">' +
      '<span class="eq-popup-mag">M ' + escapeHtml(mag) + '</span>' +
      '<span class="eq-popup-age">' + escapeHtml(relativeAge(ageOf(props))) + '</span>' +
      '</div>' +
      '<div class="eq-popup-place">' + escapeHtml(place) + '</div>' +
      '<div class="eq-popup-time">UTC ' + escapeHtml(utc) + '</div>' +
      '<div class="eq-popup-time">Local ' + escapeHtml(local) + '</div>' +
      '<div class="eq-popup-rows">' +
      rows.map((r) => '<div class="eq-popup-row"><span class="eq-popup-key">' + r[0] +
        '</span><span class="eq-popup-val">' + r[1] + '</span></div>').join("") +
      '</div>' +
      '<div class="eq-popup-id">Event ID: ' + escapeHtml(id) + '</div>' +
      '<a class="eq-popup-link" href="' + escapeHtml(url) + '" target="_blank" ' +
      'rel="noopener noreferrer">USGS event page ↗</a>' +
      '</div>'
    );
  }

  // ── the click ────────────────────────────────────────────────────────
  //
  // Hit-test in DEGREES first (cheap) and then in PIXELS (exact). The
  // longitude difference is wrapped, so an event at 179.9°E is found from
  // a click at 179.9°W.
  function hitTest(latlng) {
    if (!state.index || !state.index.length || !state.map) return null;
    const lat = Number(latlng && latlng.lat);
    const lng = Number(latlng && latlng.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const zoom = state.map.getZoom();
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const metresPerPx = 156543.03392804097 * cosLat / Math.pow(2, zoom);
    const clickPt = state.map.latLngToContainerPoint(latlng);
    let best = null;
    let bestD2 = Infinity;
    for (const e of state.index) {
      const reachDeg = ((e.radius + 8) * metresPerPx) / 111320;
      let dLng = e.lng - lng;
      dLng = ((dLng + 540) % 360) - 180;
      if (Math.abs(dLng * cosLat) > reachDeg) continue;
      if (Math.abs(e.lat - lat) > reachDeg) continue;
      const pt = state.map.latLngToContainerPoint([e.lat, e.lng]);
      const dx = pt.x - clickPt.x;
      const dy = pt.y - clickPt.y;
      const d2 = dx * dx + dy * dy;
      const r = e.radius + 6;
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  function popupOptions() {
    // The site's POPUP_OPTIONS (app.js) is the reference: autoPan is OFF
    // because the site's keepPopupOnScreen() does the framing itself, and
    // maxWidth is measured against the zoomed popup.
    try {
      if (typeof POPUP_OPTIONS !== "undefined" && POPUP_OPTIONS) return POPUP_OPTIONS;
    } catch (_) {}
    return {
      maxWidth: 320,
      minWidth: 240,
      maxHeight: 380,
      autoPan: false,
      autoClose: true,
      closeOnClick: false,
      closeOnMove: false,
    };
  }

  // ── the HOVER ────────────────────────────────────────────────────────
  //
  // The earthquakes are drawn on a canvas renderer, so they have no DOM
  // node to hover — and until now they had no hover affordance at
  // all: pointing at one showed nothing, so the reader could not tell
  // that the dot under the cursor was an earthquake, let alone how big
  // it was.
  //
  // Two things now happen on hover:
  //   · the SHARED ring (hover-ring.js) goes round the dot, so the
  //     cursor has a circle under it exactly as it does over a story
  //     pin — one ring, shared, never two;
  //   · the hover card says what it is (magnitude, place, age).
  //
  // The ring is the reader's proof that the click will open THIS
  // event and not the one behind it.
  function onMouseMove(e) {
    if (!state.enabled || !state.index || !state.index.length) return;
    const hit = hitTest(e.latlng);
    const map = state.map;
    if (hit) {
      if (map && map.getContainer) {
        const container = map.getContainer();
        if (container) container.style.cursor = "pointer";
      }
      const props = hit.props || {};
      const radius = radiusForMag(props.mag);
      if (window.HoverRing && typeof window.HoverRing.show === "function") {
        window.HoverRing.show(map, hit, radius, "earthquake");
      }
      if (window.HoverInfo && typeof window.HoverInfo.setTarget === "function") {
        // ageOf() is the event's AGE, not its timestamp: relativeAge()
        // takes an age in ms, so handing it props.time (the epoch) would
        // print "20761 d ago" — the time since 1970, not since the
        // earthquake.
        const when = props.time ? relativeAge(ageOf(props)) : "";
        const depth = props.depth != null ? Math.round(props.depth) + " km deep" : "";
        window.HoverInfo.setTarget({
          title: "M " + (typeof props.mag === "number" ? props.mag.toFixed(1) : "?") +
                 (props.place ? " · " + props.place : ""),
          meta: [when, depth].filter(Boolean).join(" · "),
        }, "earthquake");
      }
    } else {
      if (map && map.getContainer) {
        const container = map.getContainer();
        // Only reset the cursor if nobody else has claimed it.
        if (container && container.style.cursor === "pointer") container.style.cursor = "";
      }
      if (window.HoverRing && typeof window.HoverRing.hide === "function") {
        window.HoverRing.hide("earthquake");
      }
      if (window.HoverInfo && typeof window.HoverInfo.clearTarget === "function") {
        window.HoverInfo.clearTarget("earthquake");
      }
    }
  }

  function onPreClick(e) {
    if (!state.enabled || !state.features) return;
    const hit = hitTest(e && e.latlng);
    if (!hit) return;
    try {
      // Leaflet 1.9's signature is openPopup(content, latlng, options) —
      // the CONTENT comes first. (openPopup(latlng, content) sets the
      // content to a LatLng and throws on appendChild.)
      state.map.openPopup(popupHtml(hit.props), [hit.lat, hit.lng], popupOptions());
    } catch (err) {
      warn("[earthquakes] popup failed", err);
    }
  }

  // ── enable / disable ─────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureMeta();
      ensureWindow(state.window).then((fc) => {
        if (!state.enabled) return;
        fillLayer(fc);
        mountLegend();
      }).catch(() => {});
      startRefresh();
    } else {
      stopRefresh();
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

  // ── the window switcher ──────────────────────────────────────────────
  function setWindow(id) {
    const wid = WINDOW_IDS.indexOf(id) >= 0 ? id : DEFAULT_WINDOW;
    if (wid === state.window && state.features) return Promise.resolve(wid);
    state.window = wid;
    storageSet(WINDOW_STORE_KEY, wid);
    paintChips();
    return ensureWindow(wid).then((fc) => {
      if (state.window === wid) fillLayer(fc);
      updateLegendCounts();
      notifyChange();
      return wid;
    }).catch(() => wid);
  }

  function getWindow() { return state.window; }

  function refreshCurrent(force) {
    if (!state.enabled) return Promise.resolve(null);
    return ensureWindow(state.window, force).then((fc) => {
      if (!state.enabled) return null;
      fillLayer(fc);
      return fc;
    }).catch(() => null);
  }

  function startRefresh() {
    stopRefresh();
    // The builder publishes every ten minutes; the "last hour" window is
    // only true if it is re-read. A stale hour window is a lie.
    state.refreshTimer = setInterval(() => { refreshCurrent(true); }, REFRESH_MS);
  }

  function stopRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:earthquake-change", {
        detail: { enabled: state.enabled, window: state.window },
      }));
    } catch (_) {}
  }

  // ── legend ───────────────────────────────────────────────────────────
  //
  // Inside the Leaflet layers dropdown, which keeps Leaflet's default
  // WHITE background — so the colours are chosen to read on white.
  function mountLegend() {
    if (state.legendMounted) return true;
    const list = document.querySelector(".leaflet-control-layers-list");
    if (!list) return false;
    const old = document.getElementById("eq-legend");
    if (old) old.remove();

    const host = document.createElement("div");
    host.id = "eq-legend";
    host.className = "eq-legend leaflet-control-layers-eq";

    const chips = WINDOWS.map((w) =>
      '<button type="button" class="soil-prop-btn" data-window="' + escapeHtml(w.id) + '" ' +
      'aria-pressed="false">' + escapeHtml(w.chip) + '</button>').join("");

    const swatches = AGE_COLORS.map((c) =>
      '<div class="eq-legend-row">' +
      '<span class="eq-legend-swatch" style="background:' + escapeHtml(c.color) + '"></span>' +
      '<span>' + escapeHtml(c.tint) + '</span></div>').join("");

    host.innerHTML =
      '<div class="eq-legend-title">Earthquakes (USGS)</div>' +
      '<div class="soil-prop-switch eq-window-switch" id="eq-window-switch" role="group" ' +
      'aria-label="Earthquake time window">' + chips + '</div>' +
      '<div class="eq-legend-sub" id="eq-legend-count"></div>' +
      '<div class="eq-legend-rows">' + swatches + '</div>' +
      '<div class="eq-legend-foot">Circle size = magnitude · colour = how recent · ' +
      'click an event for details</div>';

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

    host.querySelectorAll("#eq-window-switch .soil-prop-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setWindow(btn.dataset.window);
      });
    });
    paintChips();
    updateLegendCounts();
    return true;
  }

  function paintChips() {
    const row = document.getElementById("eq-window-switch");
    if (!row) return;
    for (const b of row.querySelectorAll("button")) {
      const on = b.dataset.window === state.window;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function updateLegendCounts() {
    const el = document.getElementById("eq-legend-count");
    if (!el) return;
    const w = WINDOWS.find((x) => x.id === state.window);
    const counts = (state.meta && state.meta.counts) || {};
    const n = counts[state.window];
    el.textContent = (w ? w.label : state.window) + (n != null ? " · " + n + " events" : "");
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);
    const saved = storageGet(WINDOW_STORE_KEY, DEFAULT_WINDOW);
    if (WINDOW_IDS.indexOf(saved) >= 0) state.window = saved;

    map.on("overlayadd", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.layer && e.layer === state.layer) onLayerToggled(false);
    });

    // The click. `preclick` fires immediately before the map's own click
    // and never fires for a drag, so a pan that starts on an earthquake
    // does not open it.
    map.on("preclick", onPreClick);

    // The hover. `mousemove` on the map (not on the canvas) — the
    // earthquakes are drawn on a canvas renderer and have no DOM node
    // of their own, so the map is the only thing that sees the cursor.
    map.on("mousemove", onMouseMove);
    map.on("mouseout", () => {
      if (window.HoverRing && typeof window.HoverRing.hide === "function") {
        window.HoverRing.hide("earthquake");
      }
      if (window.HoverInfo && typeof window.HoverInfo.clearTarget === "function") {
        window.HoverInfo.clearTarget("earthquake");
      }
    });

    ensureMeta();
    if (storageGet(STORE_KEY, "0") === "1") {
      // The checkbox is the source of truth for the on/off state; the
      // stored preference only decides what happens when the reader comes
      // back to a map they left with the layer on.
      log("[earthquakes] stored preference is on");
    }
  }

  function blocksClick() {
    // The popup IS the interaction. The layer never swallows a map click,
    // so the click-to-submit flow still works everywhere else.
    return false;
  }

  // ── HUD sampling ("Everything" mode) ────────────────────────────────
  // The nearest earthquake within ~0.3° (≈ 33 km). Beyond that the
  // reading would be a guess, so it returns null rather than naming an
  // earthquake on the far side of an ocean.
  function sampleAt(latlng) {
    if (!state.enabled || !state.index) return null;
    const lat = Number(latlng && latlng.lat);
    const lng = Number(latlng && latlng.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const MAX_D2 = 0.3 * 0.3;
    let best = null;
    let bestD2 = Infinity;
    for (const e of state.index) {
      let dLng = e.lng - lng;
      dLng = ((dLng + 540) % 360) - 180;
      const dx = dLng * cosLat;
      const dy = e.lat - lat;
      const d2 = dx * dx + dy * dy;
      if (d2 > MAX_D2) continue;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    if (!best) return null;
    const p = best.props || {};
    const mag = (typeof p.mag === "number") ? p.mag.toFixed(1) : "?";
    const km = Math.round(Math.sqrt(bestD2) * 111);
    const where = p.place ? " · " + p.place : "";
    return "M " + mag + " · " + relativeAge(ageOf(p)) + where + (km >= 1 ? " · " + km + " km" : "");
  }

  // ── export surface ───────────────────────────────────────────────────
  // The rule: a layer exports ITSELF. The exporter reads the same
  // features the map draws, so the file and the picture cannot disagree.
  function registerExport() {
    if (!window.XYZO_EXPORT) return;
    window.XYZO_EXPORT.register({
      id: "earthquakes",
      z: PANE_Z,
      label: "🌐 Earthquakes (USGS)",
      kind: "vector",
      attribution: "U.S. Geological Survey, Earthquake Hazards Program (public domain)",
      licence: "Public domain",
      source: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/",
      style: { stroke: "#ff2d2d", fill: "#ff2d2d", radius: 6, opacity: 0.9 },
      isActive: () => !!state.features,
      async features() {
        const fc = state.features;
        if (!fc) return { type: "FeatureCollection", features: [] };
        return { type: "FeatureCollection", features: (fc.features || []).slice() };
      },
    });
  }

  window.EarthquakeLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    onLayerToggled: onLayerToggled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    blocksClick: blocksClick,
    setWindow: setWindow,
    getWindow: getWindow,
    refresh: refreshCurrent,
    mountLegend: mountLegend,
    sampleAt: sampleAt,
    LAYER_NAME: "🌐 Earthquakes (USGS)",
    WINDOWS: WINDOWS,
    AGE_COLORS: AGE_COLORS,
    registerExport: registerExport,
    // test hooks
    _state: state,
    _styleFor: styleFor,
    _radiusForMag: radiusForMag,
    _colorForAge: colorForAge,
    _popupHtml: popupHtml,
    _hitTest: hitTest,
  };

  registerExport();
})();
