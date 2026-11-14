/* ═══════════════════════════════════════════════════════════════════════
   City-name labels for the Xyzo map — an optional overlay that writes
   the names of cities onto a dedicated canvas.

   Source: /data/cities.10k.json — the SAME file CityEngine already
   lazily loads for search (44,487 geocoded cities with population).
   This module reuses that indexed list via CityEngine.load() instead
   of fetching the 4 MB a second time.

   (NOAA's SOS "city names" dataset is a single 4096 px PNG overlay for
   a globe projection — not a tile pyramid, useless at street zoom.
   Local, geocoded, population-filtered labels beat it in every way.)

   Labels are drawn on ONE canvas in cityLabelPane (z-index 380 — above
   the wind pane, below the pin canvas), re-rendered on moveend /
   zoomend / resize, never per frame: city names do not move relative
   to the ground between those events.

   Density is controlled two ways:
   - a population floor that rises as you zoom out (z0 shows only the
     handful of 10 M+ megacities; z7 shows every city ≥ 100 k), and
   - greedy collision avoidance: candidates are drawn largest-first and
     skipped when their box overlaps a label already placed.

   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const PANE = "cityLabelPane";
  const PANE_Z = 380;
  const STORE_KEY = "xyzo.cityLabels";

  // Population floor per zoom. Counts (from the real dataset):
  //   z0: 40 cities ≥10M · z2: 156 ≥5M · z4: 789 ≥1M
  //   z5: 1,472 ≥500k · z6: 3,704 ≥200k · z7: all 44,487 (viewport-culled)
  const MIN_POP = [
    10_000_000, // z0
    10_000_000, // z1
    5_000_000,  // z2
    2_000_000,  // z3
    1_000_000,  // z4
    500_000,    // z5
    200_000,    // z6
    100_000,    // z7
    0,          // z8+
  ];
  function minPopForZoom(z) {
    return MIN_POP[Math.max(0, Math.min(z, MIN_POP.length - 1))];
  }

  const state = {
    map: null,
    canvas: null,
    ctx: null,
    enabled: false,
    cities: null,        // sorted pop-desc after first load
    loadPromise: null,
    redrawTimer: null,
    lastBoundsKey: "",
  };

  // ── helpers ───────────────────────────────────────────────────────────
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
      // Above wind (370) — labels are context, they should sit over the
      // streamlines — but below the pin canvas (400), which is the
      // interactive layer.
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  function ensureCanvas(map) {
    if (state.canvas) return state.canvas;
    const c = document.createElement("canvas");
    c.className = "xyzo-city-labels";
    c.style.position = "absolute";
    c.style.left = "0";
    c.style.top = "0";
    c.style.pointerEvents = "none";
    map.getPane(PANE).appendChild(c);
    state.canvas = c;
    state.ctx = c.getContext("2d");
    return c;
  }

  // ── data: reuse CityEngine, never refetch the 4 MB ────────────────────
  function ensureCities() {
    if (state.cities) return Promise.resolve(state.cities);
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = (async () => {
      const CE = window.CityEngine;
      if (CE && typeof CE.load === "function") {
        await CE.load();
        const all = CE._state() && CE._state().allCities;
        if (all && all.length) {
          // Sort once, population descending: the greedy collision pass
          // draws big cities first, so small ones yield the space.
          state.cities = all.slice().sort(
            (a, b) => (b.p || 0) - (a.p || 0)
          );
          log("[city-labels] using CityEngine's index,", state.cities.length, "cities");
          return state.cities;
        }
      }
      // CityEngine unavailable (should not happen — it is always on the
      // page) — fall back to a direct fetch rather than showing nothing.
      const resp = await fetch("/data/cities.10k.json");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      state.cities = data.sort((a, b) => (b.p || 0) - (a.p || 0));
      log("[city-labels] fetched directly,", state.cities.length, "cities");
      return state.cities;
    })().catch((e) => {
      state.loadPromise = null;
      warn("[city-labels] load failed", e);
      throw e;
    });
    return state.loadPromise;
  }

  // ── drawing ───────────────────────────────────────────────────────────
  function scheduleRedraw() {
    if (!state.enabled) return;
    // Coalesce bursts: moveend + zoomend + resize often land together.
    if (state.redrawTimer) clearTimeout(state.redrawTimer);
    state.redrawTimer = setTimeout(() => {
      state.redrawTimer = null;
      redraw();
    }, 80);
  }

  function fontFor(pop) {
    // Taller type for bigger cities, so hierarchy reads at a glance.
    if (pop >= 10_000_000) return "700 14px system-ui, -apple-system, sans-serif";
    if (pop >= 3_000_000) return "600 13px system-ui, -apple-system, sans-serif";
    if (pop >= 1_000_000) return "600 12px system-ui, -apple-system, sans-serif";
    return "500 11px system-ui, -apple-system, sans-serif";
  }

  function redraw() {
    if (!state.enabled || !state.map || !state.canvas || !state.cities) return;
    const map = state.map;
    const dpr = window.devicePixelRatio || 1;
    const size = map.getSize();
    const c = state.canvas;
    if (c.width !== Math.round(size.x * dpr) || c.height !== Math.round(size.y * dpr)) {
      c.width = Math.round(size.x * dpr);
      c.height = Math.round(size.y * dpr);
      c.style.width = size.x + "px";
      c.style.height = size.y + "px";
    }

    // ANCHOR THE CANVAS TO THE SCREEN ORIGIN. The canvas sits inside
    // the map pane, and Leaflet's pane translate PERSISTS after every
    // drag-pan (measured 2026-10-28: panBy([150,80]) leaves
    // translate3d(-150px,-80px,0) on the pane, and only a setView/
    // zoom resets it to zero). The element therefore moves with the
    // pane — its rect was (-150,-80) — while the code below drew at
    // latLngToContainerPoint, so every label sat paneOffset away from
    // its city ("all off center", fine on a fresh load, drifting with
    // every pan). Anchor = the pane-content coordinate of screen
    // (0,0): then a pixel drawn at containerPoint really appears at
    // containerPoint, whatever the translate happens to be.
    const anchor = map.containerPointToLayerPoint([0, 0]);
    c.style.left = anchor.x + "px";
    c.style.top = anchor.y + "px";

    const ctx = state.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const zoom = map.getZoom();
    const floor = minPopForZoom(zoom);
    const bounds = map.getBounds().pad(0.05);

    // Greedy placement: candidates are already pop-sorted, so the first
    // fit wins and smaller cities fill the gaps.
    const placed = [];  // {x0,y0,x1,y1}
    const MAX_LABELS = 400;
    let drawn = 0;

    for (let i = 0; i < state.cities.length && drawn < MAX_LABELS; i++) {
      const city = state.cities[i];
      const pop = city.p || 0;
      if (pop < floor) break;  // sorted desc — everything below is smaller
      const lat = city.la;
      const lng = city.ln;
      if (lat == null || lng == null) continue;
      if (lat < bounds.getSouth() || lat > bounds.getNorth()) continue;
      if (lng < bounds.getWest() || lng > bounds.getEast()) continue;

      const pt = map.latLngToContainerPoint([lat, lng]);
      const font = fontFor(pop);
      const name = city.n;
      if (!name) continue;

      ctx.font = font;
      const w = ctx.measureText(name).width;
      const h = 14;  // fixed line box; font ≤ 14px
      const x0 = pt.x - w / 2 - 2;
      const y0 = pt.y - h / 2 - 2;
      const x1 = pt.x + w / 2 + 2;
      const y1 = pt.y + h / 2 + 2;
      if (x1 < 0 || y1 < 0 || x0 > size.x || y0 > size.y) continue;

      // collision: 1 px margin so letters never kiss
      let hit = false;
      for (let j = 0; j < placed.length; j++) {
        const b = placed[j];
        if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) { hit = true; break; }
      }
      if (hit) continue;

      placed.push({ x0, y0, x1, y1 });
      drawn++;

      // White fill + dark outline: readable on satellite (bright) and on
      // the dark basemaps alike — the same trick river/isobar labels use.
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(name, pt.x, pt.y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(name, pt.x, pt.y);

      // A small dot marks the exact point, so the label's meaning is
      // unambiguous even when the name is wide.
      if (pop >= 500_000) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y + h / 2 + 3, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
    }

    // Reveal ONLY once this frame is painted. scheduleRedraw coalesces
    // moveend/zoomend/resize bursts over 80 ms, and the old code
    // un-hid the canvas the instant moveend fired — the previous
    // view's labels flashed at their stale positions first.
    c.style.visibility = "";
  }

  // ── enable / disable ──────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureCanvas(state.map);
      state.canvas.style.display = "";
      ensureCities().then(() => redraw()).catch(() => {});
    } else if (state.canvas) {
      state.canvas.style.display = "none";
    }
    notifyChange();
  }

  function setEnabled(on) {
    const want = !!on;
    if (!state.map) return Promise.resolve(false);
    const layer = getTileLayer();
    if (want) {
      if (!state.map.hasLayer(layer)) layer.addTo(state.map);
    } else if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
    }
    onLayerToggled(state.map.hasLayer(layer));
    return Promise.resolve(state.enabled);
  }

  function setOpacity(v) {
    const o = Math.max(0, Math.min(1, Number(v) || 0));
    if (state.canvas) state.canvas.style.opacity = String(o);
    state.opacity = o;
  }
  function getOpacity() {
    return state.opacity != null ? state.opacity : 1;
  }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:city-labels-change", { detail: { enabled: state.enabled } }));
    } catch (_) {}
  }

  // ── the layers-control citizen ────────────────────────────────────────
  // A transparent L.Layer that owns the pane; it paints nothing itself —
  // the canvas does. Its only job is to be a checkbox + opacity slider
  // in the dropdown and to fire overlayadd/remove.
  function getTileLayer() {
    if (state._layer) return state._layer;
    if (typeof L === "undefined") return null;
    const NullLayer = L.Layer.extend({
      onAdd(map) {
        ensurePane(map);
        ensureCanvas(map);
        state.canvas.style.display = "";
        if (state.cities) redraw();
        else ensureCities().then(() => redraw()).catch(() => {});
      },
      onRemove() {
        if (state.canvas) state.canvas.style.display = "none";
      },
      // OverlayOpacity calls this on every overlay; a no-op here is
      // fine because setOpacity below is the module's own, but the
      // layers-control code path may hit the instance directly.
      setOpacity(v) { setOpacity(v); },
      getOpacity() { return getOpacity(); },
    });
    state._layer = new NullLayer();
    // Instance-level methods, mirroring river-layer's GeoJSON fix: the
    // opacity registry calls layer.setOpacity on whatever object is in
    // WEATHER_OVERLAYS.
    state._layer.setOpacity = (v) => setOpacity(v);
    state._layer.getOpacity = () => getOpacity();
    return state._layer;
  }

  // ── init ──────────────────────────────────────────────────────────────
  function init(map) {
    if (!map || state.map) return;
    state.map = map;
    ensurePane(map);

    map.on("overlayadd", (e) => {
      if (state._layer && e.layer === state._layer) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state._layer && e.layer === state._layer) onLayerToggled(false);
    });

    // Labels are baked into the canvas — they must follow the map, but
    // only at the points where the projection is final.
    map.on("moveend zoomend resize", scheduleRedraw);
    // Hide while dragging: a stale canvas at the old projection reads
    // as glitching; a blank pane reads as loading. It is un-hidden by
    // redraw() itself, after the fresh frame is painted — not here, or
    // the previous view's labels would flash for the ~80 ms redraw
    // coalesce window.
    map.on("movestart zoomstart", () => {
      if (state.canvas) state.canvas.style.visibility = "hidden";
    });

    // Restore the persisted preference by putting the layer on the map.
    // Without this the checkbox worked for one session and a bare revisit
    // (no URL hash) came back with labels OFF even though localStorage
    // said "1" — mag/climate restore the same way. This runs BEFORE the
    // layers control is created (app.js inits modules, then builds the
    // control), so the control picks the checked state up from the map.
    //
    // The state must be flipped DIRECTLY, not via the overlayadd event:
    // `overlayadd` is fired by the layers control, which does not exist
    // yet at init time — waiting for it leaves state.enabled false and
    // redraw() bails. climate-layer sets enabled from hasLayer for the
    // same reason.
    if (storageGet(STORE_KEY, "0") === "1") {
      const layer = getTileLayer();
      if (layer && !map.hasLayer(layer)) {
        try { layer.addTo(map); } catch (_) {}
      }
      onLayerToggled(!!(state._layer && map.hasLayer(state._layer)));
    }

    // **NO WARM HERE.** This used to kick `ensureCities()` when the
    // layer was NOT restored on — i.e. it loaded the 1.2 MB city index
    // for exactly the readers who were never going to see a label.
    // When the layer IS restored on, the restore above has already put
    // it on the map and onAdd has started the load (ensureCities()
    // dedupes via its cached promise), so nothing is lost by not
    // warming: the reader pays for the layer they asked for.
  }

  // Labels never block clicks: the canvas is pointer-events:none.
  function blocksClick() {
    return false;
  }

  // ── public API ────────────────────────────────────────────────────────
  window.CityLabels = {
    init,
    getTileLayer,
    setEnabled,
    isEnabled: () => state.enabled,
    setOpacity,
    getOpacity,
    blocksClick,
    LAYER_NAME: "🏙️ City names",
    _state: state,
    _redraw: redraw,
    _minPopForZoom: minPopForZoom,
  };
})();
