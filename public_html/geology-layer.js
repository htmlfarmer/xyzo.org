/* ═══════════════════════════════════════════════════════════════════════
   Geology overlay for the Xyzo map — bedrock + geologic contacts.

   Two layers-control entries share one module and one pane:

     🪨 Geology (Macrostrat)         colourful bedrock units
     🗺️ Geologic contacts (USGS/GSC) the fault/contact line network

   Sources (both free, both CORS `*`):

   • Macrostrat — https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png
     CC BY 4.0 (UW Macrostrat Lab / NSF). 512 px tiles, real polygons
     through z14 (~4 m/px — far past 1 km detail). Thousands of units
     composited from national geological surveys including the GSC
     1:35M world compilation. Baking this pyramid globally is impossible
     (4^14 tiles); the tile server is the product, so we hotlink —
     the same trade the NASA GIBS overlays already made.

   • USGS — https://mrdata.usgs.gov/services/worldgeol (WMS 1.1.1)
     "World geology compiled by the Geological Survey of Canada at
     approximately 1:35,000,000 scale, published as Open File 2915".
     The `contacts` layer draws the unit boundaries (faults and
     stratigraphic contacts) as thin black lines on transparent PNG,
     in EPSG:3857 — Leaflet's native SRS. A CSS filter inverts them
     to bright white so they read on a dark basemap.

   Probe: hovering/tapping the map (with Probe armed) queries
   Macrostrat's point API for the unit under the cursor — name,
   age range, lithology. Debounced and cached; the probe IS the
   legend (a static key for thousands of units is impossible).

   Tiles are hotlinked, not written under public_html/data/, so there
   is no BUILD token and no Caddy immutable-cache trap here.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Served through our own mirror: asked once, stored on our disk, and
  // revalidated against Macrostrat every 30 days (geology does not move)
  // — see api/src/routes/tileMirror.ts. No file extension on purpose:
  // Caddy stamps `*.png` with a year of `immutable`.
  const CARTO_URL = "/api/tile/mirror/macrostrat/{z}/{x}/{y}";
  const UNITS_API = "https://macrostrat.org/api/v2/geologic_units/map";
  const WMS_URL = "https://mrdata.usgs.gov/services/worldgeol";
  const PANE = "geologyPane";
  const PANE_Z = 354;
  const GEO_STORE = "xyzo.geologyLayer";
  const CONTACT_STORE = "xyzo.geologyContacts";
  const PROBE_STORE = "xyzo.geologyProbe";

  // Macrostrat serves 512 px PNG tiles, but they use the STANDARD XYZ
  // z/x/y grid — same geographic bounds as normal 256 px tiles, just
  // higher resolution (a "retina" tile). Leaflet's CRS scale is fixed at
  // 256 * 2^z; setting tileSize: 512 tells Leaflet each tile step is 512
  // CRS-pixels, which places every tile at 2x spacing covering 2x area
  // — the whole overlay comes out stretched and shifted. Keep the
  // default 256; the browser downscales the 512 px image into the
  // correct slot (slight softness on non-retina, correct geography
  // everywhere). Macrostrat's own map sidesteps this by rendering their
  // vector tiles instead.
  //
  // Do NOT set tileSize: 512 here. Pinned by overlay-contracts test.
  // Real unit polygons through z14 in detailed areas (Alps, etc.);
  // beyond that Leaflet upscales. Ocean tiles are 1 KB transparent
  // PNGs (200, not 404), so the console stays clean.
  const MAX_NATIVE = 14;

  const state = {
    map: null,
    geoLayer: null,        // L.tileLayer — Macrostrat carto
    contactLayer: null,    // L.tileLayer.wms — USGS contacts
    enabled: { geology: false, contacts: false },
    probeMode: false,
    legendMounted: false,
    lastProbe: null,
    probeTimer: null,
    probeCache: new Map(), // "lat,lng" -> unit info
    opacity: { geology: 0.7, contacts: 0.85 },
  };

  // ── helpers ───────────────────────────────────────────────────────────
  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
      // Above cropland (353), below temperature (355) and the pins.
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  // ── the two overlay layers ────────────────────────────────────────────
  function buildGeoLayer() {
    if (!window.L) return null;
    return L.tileLayer(CARTO_URL, {
      minZoom: 0,
      maxNativeZoom: MAX_NATIVE,
      opacity: state.opacity.geology,
      pane: PANE,
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution:
        '<a href="https://macrostrat.org" target="_blank" rel="noopener">Macrostrat</a> ' +
        "(CC BY 4.0, UW Macrostrat Lab)",
      className: "xyzo-geology-tiles",
    });
  }

  function buildContactLayer() {
    if (!window.L || typeof L.tileLayer.wms !== "function") return null;
    // WMS 1.1.1 + EPSG:3857 = Leaflet's default SRS. The `contacts`
    // layer is the GSC unit-boundary network (faults + contacts).
    return L.tileLayer.wms(WMS_URL, {
      layers: "contacts",
      format: "image/png",
      transparent: true,
      version: "1.1.1",
      opacity: state.opacity.contacts,
      pane: PANE,
      updateWhenIdle: true,
      attribution:
        "World geology: <a href=\"https://mrdata.usgs.gov/geology/world/\" " +
        'target="_blank" rel="noopener">USGS / GSC</a> (Open File 2915)',
      className: "xyzo-geology-contacts",
    });
  }

  function getTileLayer() {
    if (!state.geoLayer) state.geoLayer = buildGeoLayer();
    return state.geoLayer;
  }

  function getContactLayer() {
    if (!state.contactLayer) state.contactLayer = buildContactLayer();
    return state.contactLayer;
  }

  // ── enable / disable ──────────────────────────────────────────────────
  function onToggled(mode, on) {
    state.enabled[mode] = !!on;
    storageSet(mode === "geology" ? GEO_STORE : CONTACT_STORE, state.enabled[mode] ? "1" : "0");
    if (state.enabled.geology || state.enabled.contacts) {
      // legend is just the probe button + attribution; nothing to load
    } else {
      hideProbe();
    }
    refreshProbeBtn();
    notifyChange();
  }

  function setEnabledMode(mode, on) {
    const want = !!on;
    const layer = mode === "geology" ? getTileLayer() : getContactLayer();
    if (!layer || !state.map) return Promise.resolve(false);
    if (want) {
      if (!state.map.hasLayer(layer)) layer.addTo(state.map);
    } else if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
    }
    onToggled(mode, state.map.hasLayer(layer));
    return Promise.resolve(state.enabled[mode]);
  }

  function notifyChange() {
    try { if (typeof window.updateUrlHash === "function") window.updateUrlHash(); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:geology-change", {
        detail: { geology: state.enabled.geology, contacts: state.enabled.contacts },
      }));
    } catch (_) {}
  }

  // ── legend (probe button + attribution only) ──────────────────────────
  function mountLegendIntoLayersControl() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("geology-legend");
    if (old) old.remove();

    const coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (navigator.maxTouchPoints || 0) > 0;

    const host = document.createElement("div");
    host.id = "geology-legend";
    host.className = "climate-legend leaflet-control-layers-geology";
    if (coarsePointer) host.classList.add("is-touch");
    host.innerHTML =
      '<div class="climate-legend-title"><span>Geology</span>' +
      '<button type="button" class="climate-probe-toggle" id="ctrl-geology-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the rock unit (touch devices)">Probe</button>' +
      "</div>" +
      '<div class="climate-legend-body" id="geology-legend-body">' +
      '<div class="geology-legend-note">' +
      "Hover or tap to read the bedrock unit (name, age, rock type). " +
      "Contacts draws the fault / boundary network over it." +
      "</div></div>" +
      '<div class="climate-legend-foot" id="geology-legend-foot">' +
      "Macrostrat (CC BY 4.0) · USGS/GSC Open File 2915" +
      "</div>";
    section.appendChild(host);
    state.legendMounted = true;

    const probeBtn = host.querySelector("#ctrl-geology-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeBtn();
      });
    }
    refreshProbeBtn();
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

  function refreshProbeBtn() {
    const btn = document.getElementById("ctrl-geology-probe-toggle");
    if (!btn) return;
    const any = state.enabled.geology || state.enabled.contacts;
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
    btn.disabled = !any;
    btn.style.opacity = any ? "" : "0.45";
  }

  // ── probe: Macrostrat point API ───────────────────────────────────────
  function probeEl() {
    let el = document.getElementById("geology-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "geology-probe";
      el.className = "climate-probe geology-probe";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      const host = (state.map && state.map.getContainer()) || document.body;
      host.appendChild(el);
    }
    return el;
  }

  function hideProbe() {
    const el = document.getElementById("geology-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
    if (state.probeTimer) { clearTimeout(state.probeTimer); state.probeTimer = null; }
  }

  function formatUnit(u) {
    if (!u) return null;
    const bits = [];
    if (u.name) bits.push(esc(u.name));
    else if (u.strat_name) bits.push(esc(u.strat_name));
    else bits.push("<em>unnamed unit</em>");
    const age = u.best_int_name || u.t_int_name;
    if (age) {
      let ageTxt = esc(age);
      if (u.b_age != null && u.t_age != null && u.b_age !== u.t_age) {
        ageTxt += " · " + Math.round(u.b_age) + "–" + Math.round(u.t_age) + " Ma";
      }
      bits.push('<span class="geology-probe-age">' + ageTxt + "</span>");
    }
    if (u.lith) bits.push('<span class="geology-probe-lith">' + esc(String(u.lith).slice(0, 80)) + "</span>");
    return '<div class="geology-probe-main">' + bits.join("</div><div>") + "</div>";
  }

  function queryUnit(lat, lng) {
    // cache to 0.1° so a slow pan doesn't re-query every cell
    const key = lat.toFixed(1) + "," + lng.toFixed(1);
    if (state.probeCache.has(key)) return Promise.resolve(state.probeCache.get(key));
    const url = UNITS_API + "?lat=" + lat.toFixed(3) + "&lng=" + lng.toFixed(3);
    return fetch(url, { cache: "default" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((json) => {
        // Macrostrat wraps everything: {success: {v, license, data: [...]}}
        const payload = json && json.success ? json.success : json;
        const u = payload && payload.data && payload.data[0] ? payload.data[0] : null;
        // keep the cache small
        if (state.probeCache.size > 40) {
          const first = state.probeCache.keys().next().value;
          state.probeCache.delete(first);
        }
        state.probeCache.set(key, u);
        return u;
      });
  }

  function showProbe(html, containerPoint) {
    const el = probeEl();
    if (!html) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    if (state.lastProbe !== html) {
      el.innerHTML = html;
      state.lastProbe = html;
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  // Stand down when the Hover HUD owns the cursor — the rule every
  // OTHER probe follows (15 of them; geology was the one missing it).
  //
  // The card and a probe box are two halves of one thing: the HUD says
  // "the reading under the cursor" precisely so no layer's own box has
  // to. Without this check geology's box was the ONLY thing rendered at
  // cursor+14 in "Everything" mode, and it read "no data" where the
  // reader was looking for the wind speed the HUD carries — reported
  // exactly that way: "the mouse pointer … doesn't show the wind speed
  // in miles per hour, it just says No data".
  //
  // It also honours the second reason the HUD excludes geology from
  // SAMPLERS entirely: this path fires a NETWORK request at Macrostrat's
  // point API, debounced only by250 ms — "a mousemove must not fire an
  // HTTP request per cell" is the documented rule.
  function hudOwnsCursor() {
    return !!(window.HoverInfo &&
              typeof HoverInfo.suppressesProbes === "function" &&
      HoverInfo.suppressesProbes());
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled.geology || !state.probeMode || !latlng) return;
    if (hudOwnsCursor()) {
      // A probe that merely stops updating KEEPS its last text on
      // screen — the box has to go away, and the timer has to go with
      // it or a response already in flight re-shows it.
      if (state.probeTimer) {
        clearTimeout(state.probeTimer);
        state.probeTimer = null;
      }
      hideProbe();
      return;
    }
    const lat = latlng.lat;
    const lng = latlng.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    // show a loading tick immediately so the probe feels alive
    if (state.lastProbe !== "…") {
      showProbe('<div class="geology-probe-main"><em>…</em></div>', containerPoint);
    }
    // debounce 250 ms — hover fires every frame
    if (state.probeTimer) clearTimeout(state.probeTimer);
    state.probeTimer = setTimeout(() => {
      state.probeTimer = null;
      queryUnit(lat, lng)
        .then((u) => {
          // ignore stale responses after the pointer moved on — and
          // never re-show one that arrived after the HUD took the cursor
          if (!state.probeMode || !state.enabled.geology || hudOwnsCursor()) return;
          // LABELLED, and never a bare "no data". This box is stacked by
          // probe-stack.js AMONG the wind and climate readings, and
          // formatUnit() renders bare text with nothing saying which
          // layer it belongs to — so an unlabelled "no data" appearing
          // above "💨 5 mph · 9 km/h" reads as THE WIND having no data.
          // (Reported exactly that way; the wind reads correctly in
          // every mode.) Macrostrat has no unit over most of the ocean
          // and over anything it has not mapped, so this string is common.
          showProbe(formatUnit(u) ||
                      '<div class="geology-probe-main">🪨 <em>no rock unit here</em></div>',
                    containerPoint);
        })
        .catch((e) => {
          warn("[geology] probe failed", e);
          showProbe('<div class="geology-probe-main"><em>probe failed</em></div>', containerPoint);
        });
    }, 250);
  }

  // ── init ──────────────────────────────────────────────────────────────
  function init(map) {
    if (!map) return;
    state.map = map;
    ensurePane(map);

    map.on("overlayadd", (e) => {
      if (state.geoLayer && e.layer === state.geoLayer) onToggled("geology", true);
      if (state.contactLayer && e.layer === state.contactLayer) onToggled("contacts", true);
    });
    map.on("overlayremove", (e) => {
      if (state.geoLayer && e.layer === state.geoLayer) onToggled("geology", false);
      if (state.contactLayer && e.layer === state.contactLayer) onToggled("contacts", false);
    });

    map.on("mousemove", (e) => updateProbe(e.latlng, e.containerPoint));
    map.on("click", () => { if (state.probeMode) hideProbe(); });

    waitForLayersControl();
  }

  function blocksClick() {
    return !!((state.enabled.geology || state.enabled.contacts) && state.probeMode);
  }

  // ── public API ────────────────────────────────────────────────────────
  window.GeologyLayer = {
    init: init,
    getTileLayer: getTileLayer,
    getContactLayer: getContactLayer,
    setEnabled: (on) => setEnabledMode("geology", on),
    setContactsEnabled: (on) => setEnabledMode("contacts", on),
    isEnabled: () => state.enabled.geology,
    isContactsEnabled: () => state.enabled.contacts,
    setOpacity: (v) => {
      state.opacity.geology = Math.max(0, Math.min(1, Number(v) || 0));
      if (state.geoLayer && typeof state.geoLayer.setOpacity === "function") {
        state.geoLayer.setOpacity(state.opacity.geology);
      }
    },
    getOpacity: () => state.opacity.geology,
    blocksClick: blocksClick,
    updateProbe: updateProbe,
    LAYER_NAME: "🪨 Geology (Macrostrat)",
    CONTACTS_LAYER_NAME: "🗺️ Geologic contacts (USGS)",
    _state: state,
    _formatUnit: formatUnit,
    _queryUnit: queryUnit,
  };
})();
