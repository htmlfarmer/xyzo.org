/* ═══════════════════════════════════════════════════════════════════════
   The hover RING — one element, every layer.

   WHAT IT WAS
   -----------
   The ring that appears around a hovered story pin was the canvas pin
   renderer's PRIVATE "ghost" element: it created a DOM node, moved it
   to the pin on every mousemove and hid it again. It worked, and it
   was the only ring on the site — so hovering an EARTHQUAKE, a fault
   or a language region showed **nothing at all**. The owner asked for
   "a circle around the story or earthquake or whatever", and there was
   a circle for exactly one kind of thing.

   WHY A SHARED ELEMENT
   --------------------
   Two elements would be two rings that could disagree: one drawn by
   the pin renderer and one drawn by, say, the earthquake layer could
   both be visible at once, at different sizes, and the reader would
   see two circles for one cursor. So there is ONE element, and every
   layer asks this module to put it somewhere.

   The pin renderer keeps its own element name (`.xyzo-pin-hover-
   ghost`) because the CSS already styles it, but it no longer OWNS
   it: `HoverRing.show()` / `HoverRing.hide()` are the only way it is
   moved or hidden, and the same calls serve the other layers.

   The ring is `pointer-events: none`, so it can never swallow a
   click, and it lives in the marker pane so it stacks with the pins
   rather than under them.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const CLASS = "xyzo-pin-hover-ghost";
  const state = {
    map: null,
    el: null,
    owner: null,       // who asked for the ring ("pin", "earthquake", …)
    latlng: null,
  };

  function log(msg, a) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn("hover-ring: " + msg, a);
  }

  /**
   * THE element. Every layer that draws a ring uses this one — the
   * pin renderer included, so there is exactly ONE ring element on the
   * map and a query for `.xyzo-pin-hover-ghost` finds it.
   */
  function el(map) {
    return ensure(map);
  }

  function ensure(map) {
    if (!map) return null;
    state.map = map;
    if (state.el && document.body.contains(state.el)) return state.el;
    const el = document.createElement("div");
    el.className = CLASS + " hidden";
    el.setAttribute("aria-hidden", "true");
    const pane = map.getPane ? (map.getPane("markerPane") || map.getPane("overlayPane")) : null;
    (pane || document.body).appendChild(el);
    state.el = el;
    return el;
  }

  /**
   * Put the ring on a point.
   *
   * @param {object} map    the Leaflet map
   * @param {object} latlng a Leaflet LatLng
   * @param {number} radiusPx  the ring's radius in CSS pixels
   * @param {string} owner  who is asking — so a layer can tell that the
   *   ring is already its own and does not re-create it
   */
  function show(map, latlng, radiusPx, owner) {
    const el = ensure(map);
    if (!el || !latlng) return;
    const lat = Number(latlng.lat);
    const lng = Number(latlng.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const pt = map.latLngToLayerPoint([lat, lng]);
    const r = Math.max(6, Math.round(radiusPx || 12));
    state.owner = owner || null;
    state.latlng = [lat, lng];
    el.style.left = pt.x + "px";
    el.style.top = pt.y + "px";
    el.style.width = (r * 2 + 6) + "px";
    el.style.height = (r * 2 + 6) + "px";
    el.classList.remove("hidden");
  }

  function hide(owner) {
    // A layer that owns the ring may hide it; a layer that does NOT
    // own it must not — otherwise moving the pointer off an earthquake
    // would wipe the ring that belongs to a story pin.
    if (owner && state.owner && state.owner !== owner) return;
    state.owner = null;
    state.latlng = null;
    if (state.el) state.el.classList.add("hidden");
  }

  function isVisible() {
    return !!(state.el && !state.el.classList.contains("hidden"));
  }

  window.HoverRing = {
    init: ensure,
    el: el,
    show: show,
    hide: hide,
    isVisible: isVisible,
    owner: () => state.owner,
    _state: state,
  };
})();
