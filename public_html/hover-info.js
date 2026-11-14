/* ═══════════════════════════════════════════════════════════════════════
   Hover HUD — one card that follows the cursor, with three modes.

   Study: docs/TOOLTIP_STUDY_2026-10-28.md

   The map's hover story used to be scattered: pins showed a glowing
   ghost with no text, each overlay probe floated its own box near the
   cursor, and coordinates were invisible. This module consolidates
   that into ONE cursor-following card with a user-selectable mode:

      off    nothing follows the cursor (the HUD; layer probes stay
             under their own layer toggles)
      pins   (default) hovering a pin shows headline · place · time ·
             sources — the #1 missing hover, now filled
      all    everything: coordinates + pin card + one consolidated
             readings block sampled from every ENABLED in-memory layer
             (pressure, climate, temperature, wind, waves, soil,
             cropland/land cover, magnetic, lightning, phytoplankton,
             relief, rivers, languages). The layers' own hover boxes
             stand down while this mode is on (suppressesProbes()) so
             nothing stacks. Expensive layers stay out: geology is a
             network fetch and basins are a 650k-vertex ray-cast —
             both keep their click-Probe flow. Image-only overlays
             (salinity, ocean currents, Facebook, transportation) hold
             no numbers to read.

   Each layer can be switched off INDIVIDUALLY in the control menu
   (⚙ → MAP → Hover → the checkbox list, shown while mode is "all");
   the choice persists in localStorage["xyzo.hoverHudOff"]. The mode
   itself persists in localStorage["xyzo.hoverMode"].

   The HUD never steals clicks (pointer-events: none) and hides while
   the map is being dragged or the pointer leaves the container.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const STORE_KEY = "xyzo.hoverMode";
  const OFF_KEY = "xyzo.hoverHudOff";
  const MODES = ["off", "pins", "all"];
  const EDGE_PAD = 10;
  const CURSOR_OFFSET = 14;

  const state = {
    mode: "pins",
    map: null,
    el: null,
    pin: null,          // hovered pin (canvas renderer event) or null
    target: null,       // a generic hover target pushed by another layer
    latlng: null,       // last known cursor position on the globe
    lastSig: "",        // last rendered content signature (skip DOM churn)
    raf: 0,
    cursor: { x: 0, y: 0 },
    visible: false,
  };

  function storageGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtAgo(iso) {
    if (typeof formatRelativeTime === "function") return formatRelativeTime(iso);
    if (!iso) return "";
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    return h < 24 ? h + "h ago" : Math.floor(h / 24) + "d ago";
  }

  function fmtCoords(latlng) {
    const ns = latlng.lat >= 0 ? "N" : "S";
    const ew = latlng.lng >= 0 ? "E" : "W";
    return Math.abs(latlng.lat).toFixed(4) + "°" + ns + ", " +
      Math.abs(latlng.lng).toFixed(4) + "°" + ew;
  }

  // ── mode ─────────────────────────────────────────────────────────────
  function getMode() { return state.mode; }

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) mode = "pins";
    state.mode = mode;
    storageSet(STORE_KEY, mode);
    state.lastSig = "";               // force a re-render / hide
    refreshModeButtons();
    refreshSamplerListVisibility();
    // Tell the layers whose own hover box the card has just taken over.
    // A probe that merely STOPS updating is not enough: it keeps the last
    // reading it was given, so it stays on screen saying the same thing
    // the card now says. The box has to go, not freeze.
    try {
      window.dispatchEvent(new CustomEvent("xyzo:hover-mode", {
        detail: { mode: mode },
      }));
    } catch (_) {}
    schedule();
  }

  // "all" mode aggregates every enabled layer's reading into this card,
  // so the layers' own hover boxes must stand down or three probe boxes
  // fight the HUD for the same patch of screen.
  function suppressesProbes() { return state.mode === "all"; }

  function refreshModeButtons() {
    const picker = document.getElementById("hover-mode-picker");
    if (!picker) return;
    for (const b of picker.querySelectorAll("button[data-hover]")) {
      b.classList.toggle("active", b.getAttribute("data-hover") === state.mode);
    }
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  function ensureEl() {
    if (state.el && document.body.contains(state.el)) return state.el;
    const el = document.createElement("div");
    el.id = "hover-hud";
    el.className = "hover-hud";
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    state.el = el;
    return el;
  }

  function hide() {
    if (state.el) state.el.hidden = true;
    state.visible = false;
    state.lastSig = "";
  }

  // ── content ──────────────────────────────────────────────────────────
  // A GENERIC hover target. The story pins push one through the
  // "xyzo:pin-hover" event; any other overlay (the earthquakes, the
  // faults, a future marker layer) can push its own with
  // setTarget(). Without it the card only ever knew about pins, so
  // hovering an earthquake showed NOTHING at all — the reader had no
  // way to learn what was under the cursor.
  function targetBlock(t) {
    if (!t) return "";
    const title = t.title || "";
    const meta = t.meta || "";
    if (!title && !meta) return "";
    return '<div class="hover-hud-target">' +
      (title ? '<div class="hover-hud-title">' + esc(title) + "</div>" : "") +
      (meta ? '<div class="hover-hud-meta">' + esc(meta) + "</div>" : "") +
      "</div>";
  }

  function pinBlock(pin) {
    if (!pin) return "";
    const title = pin.title || pin.t || "";
    const place = pin.place_name || pin.pn || "";
    const time = pin.published_at ? fmtAgo(pin.published_at) : "";
    const sc = Number(pin.source_count ?? pin.sc ?? 1);
    const bits = [];
    if (place) bits.push(esc(place));
    if (time) bits.push(esc(time));
    if (sc > 1) bits.push(sc + " sources");
    return '<div class="hover-hud-pin">' +
      '<div class="hover-hud-title">' + esc(title.slice(0, 140)) +
      (title.length > 140 ? "…" : "") + "</div>" +
      (bits.length ? '<div class="hover-hud-meta">' + bits.join(" · ") + "</div>" : "") +
      "</div>";
  }

  // Every layer that can be sampled cheaply from its in-memory grid
  // exposes sampleAt(latlng) → string | null. Geology (network) and
  // basins (full ray-cast) deliberately do not — see the header.
  // Order roughly follows the map's own stack: pressure first (the
  // isobars are the field everything else rides on), then the washes.
  const SAMPLERS = [
    ["⛅", "IsobarLayer"],
    ["🌍", "ClimateLayer"],
    ["🌡️", "TempLayer"],
    ["⛈️", "CapeLayer"],
    // The moisture transport is a RIVER of water vapour; the rivers
    // layer below is literal rivers. The icons differ so the two do
    // not read as the same thing in the sampler list.
    ["🌊", "IvtLayer"],
    ["💨", "WindLayer"],
    // The wind SPEED field is the magnitude of the wind animation's own
    // u/v pair. It was missing here, so with the animation off and the
    // speed field on, "Everything" mode said nothing about the wind at
    // all. The field layer's readingGuard keeps the two from showing
    // the same air twice: with the animation ON, its row stands down.
    ["🌬️", "WindSpeedLayer"],
    ["🌊", "WaveLayer"],
    // The OSCAR ocean currents — the LIVE one, not the frozen ECCO
    // picture (which holds no numbers at all). It was missing here, so
    // the cursor over open water read coordinates but not the current.
    ["🌀", "OceanCurrentLayer"],
    ["🟫", "SoilLayer"],
    // The HWSD soil-TYPE layer (FAO/IIASA v2.2) — a SECOND soil
    // dataset, and it was missing here, which is worse than a missing
    // row: its own hover box STANDS DOWN in "Everything" mode (every
    // probe does, so the card never has two things saying the same
    // thing), and with no HUD row to replace it the soil type simply
    // VANISHED. Measured on the live map: hovering with the layer on
    // read "Technosols" in its own little box, and switching the HUD to
    // "Everything" showed the coordinates, the pin and nothing else —
    // no soil type at all.
    //
    // It is cheap enough to sample: the class is a COLOUR LOOKUP in the
    // pre-coloured tile under the cursor, and the decoded tile is
    // cached, so it reads one pixel of a bitmap it already has.
    ["🟫", "HWSDLayer"],
    ["🌾", "CroplandLayer"],
    ["🧭", "MagLayer"],
    ["⚡", "LightningLayer"],
    ["🦠", "PhytoplanktonLayer"],
    ["⛰️", "EtopoLayer"],
    ["💧", "RiverLayer"],
    ["🗣️", "LanguagesLayer"],
    // The three new overlays read from files on our own disk, so they
    // are as cheap as the others: the earthquakes are a hit test
    // against the published window, the faults and the language regions
    // are point-in-polygon tests.
    ["🌐", "EarthquakeLayer"],
    ["🪨", "FaultLayer"],
    ["🌍", "LanguagesRegionsLayer"],
  ];

  // ── per-layer on/off ────────────────────────────────────────────────
  // The user asked to be able to silence individual readings without
  // giving up the whole card. Disabled layers live in
  // localStorage["xyzo.hoverHudOff"] as a JSON array of window names.
  function getOffSet() {
    try {
      const v = JSON.parse(storageGet(OFF_KEY, "[]"));
      return new Set(Array.isArray(v) ? v : []);
    } catch (_) { return new Set(); }
  }

  function isSamplerEnabled(name) { return !getOffSet().has(name); }

  function setSamplerEnabled(name, on) {
    const s = getOffSet();
    if (on) s.delete(name); else s.add(name);
    storageSet(OFF_KEY, JSON.stringify(Array.from(s)));
    state.lastSig = "";
    renderSamplerList();
    schedule();
  }

  function samplerLabel(name, icon) {
    const layer = window[name];
    if (layer && layer.LAYER_NAME) return layer.LAYER_NAME;
    return icon + " " + name.replace(/Layer$/, "");
  }

  function renderSamplerList() {
    const host = document.getElementById("hover-sampler-list");
    if (!host) return;
    // No innerHTML churn if nothing changed (the list is static).
    const rows = [];
    for (const pair of SAMPLERS) {
      const icon = pair[0];
      const name = pair[1];
      const on = isSamplerEnabled(name);
      rows.push(
        '<label class="hover-sampler-row" title="Show ' + esc(samplerLabel(name, icon)) + ' in the HUD">' +
        '<input type="checkbox" data-sampler="' + esc(name) + '"' + (on ? " checked" : "") +
        "> <span>" + esc(samplerLabel(name, icon)) + "</span></label>",
      );
    }
    const html = rows.join("");
    if (host.innerHTML !== html) host.innerHTML = html;
    if (!host._xyzoWired) {
      host._xyzoWired = true;
      host.addEventListener("change", (e) => {
        const cb = e.target;
        if (!cb || !cb.dataset || !cb.dataset.sampler) return;
        setSamplerEnabled(cb.dataset.sampler, cb.checked);
      });
    }
  }

  function refreshSamplerListVisibility() {
    const host = document.getElementById("hover-sampler-list");
    if (!host) return;
    host.hidden = state.mode !== "all";
  }

  function readingsBlock(latlng) {
    if (!latlng) return "";
    const lines = [];
    for (const [icon, name] of SAMPLERS) {
      if (!isSamplerEnabled(name)) continue;
      const layer = window[name];
      if (!layer || typeof layer.sampleAt !== "function") continue;
      try {
        if (typeof layer.isEnabled === "function" && !layer.isEnabled()) continue;
        const text = layer.sampleAt(latlng);
        if (text) lines.push('<div class="hover-hud-reading">' + esc(icon + " " + text) + "</div>");
      } catch (_) { /* one bad sampler must not kill the card */ }
    }
    if (!lines.length) return "";
    return '<div class="hover-hud-readings">' + lines.join("") + "</div>";
  }

  function render() {
    state.raf = 0;
    if (state.mode === "off") { hide(); return; }

    const parts = [];
    if (state.mode === "all" && state.latlng) {
      parts.push('<div class="hover-hud-coords">' + esc(fmtCoords(state.latlng)) +
        " · z" + (state.map ? state.map.getZoom() : "?") + "</div>");
    }
    if (state.pin) parts.push(pinBlock(state.pin));
    if (state.target) parts.push(targetBlock(state.target));
    if (state.mode === "all") parts.push(readingsBlock(state.latlng));

    const html = parts.join("");
    // In "pins" mode the card exists only over something the reader
    // can point at — a story pin, or an overlay's own target (an
    // earthquake). In "all" mode the coordinates line keeps it alive
    // over open water too.
    if (!html || (state.mode === "pins" && !state.pin && !state.target)) { hide(); return; }

    const el = ensureEl();
    const contentChanged = html !== state.lastSig;
    if (contentChanged) {
      el.innerHTML = html;
      state.lastSig = html;
    }
    position(el);
    el.hidden = false;
    state.visible = true;
  }

  function position(el) {
    // The card is part of the PROBE STACK (probe-stack.js): the layer
    // probes and the card are laid out in ONE column, so the card never
    // covers a layer's reading and the layer probes never cover the
    // card. The stacker owns the coordinates.
    //
    // Without it the card sat at "cursor + 14px" — the same 14px every
    // layer probe uses — so hovering a story pin showed the card ON
    // TOP of the wind and climate readings.
    if (window.ProbeStack && typeof window.ProbeStack.place === "function") {
      window.ProbeStack.place(el);
      return;
    }
    // Flip to the left of the cursor on the right half of the screen so
    // the card never runs off the edge; same vertically near the bottom.
    const w = el.offsetWidth || 280;
    const h = el.offsetHeight || 40;
    let x = state.cursor.x + CURSOR_OFFSET;
    let y = state.cursor.y + CURSOR_OFFSET;
    if (x + w > window.innerWidth - EDGE_PAD) x = state.cursor.x - w - CURSOR_OFFSET;
    if (y + h > window.innerHeight - EDGE_PAD) y = state.cursor.y - h - CURSOR_OFFSET;
    el.style.left = Math.max(EDGE_PAD, x) + "px";
    el.style.top = Math.max(EDGE_PAD, y) + "px";
  }

  function schedule() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(render);
  }

  // ── events ───────────────────────────────────────────────────────────
  function onPinHover(e) {
    state.pin = (e && e.detail && e.detail.pin) || null;
    schedule();
  }

  function onMapMove(e) {
    if (state.mode === "off") return;
    const oe = e.originalEvent;
    if (oe && typeof oe.clientX === "number") {
      state.cursor.x = oe.clientX;
      state.cursor.y = oe.clientY;
    }
    state.latlng = e.latlng || null;
    schedule();
  }

  function onMapOut() {
    state.pin = null;
    state.target = null;
    state.latlng = null;
    hide();
  }

  // ── the generic hover target ──────────────────────────────────────────
  //
  // Any overlay can put "what is under the cursor" into the card:
  //
  //     HoverInfo.setTarget({ title: "M 4.1 · 25 km N of Hilo",
  //                           meta: "12 km deep · 3 minutes ago" });
  //     HoverInfo.clearTarget();
  //
  // The key is the OWNER: only the owner may clear its own target, so
  // the earthquakes cannot wipe the ring that belongs to a story pin
  // (and vice versa). The owner is also what stops the card flickering
  // when the pointer passes from a pin onto an earthquake and back.
  function setTarget(target, owner) {
    if (state.mode === "off") return;
    const key = owner || "target";
    const next = target ? Object.assign({}, target, { owner: key }) : null;
    if (state.target && state.target.owner === key && !next) {
      state.target = null;
    } else if (next) {
      state.target = next;
    }
    schedule();
  }

  function clearTarget(owner) {
    setTarget(null, owner);
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init(map) {
    if (!map || state.map) return;
    state.map = map;
    const saved = storageGet(STORE_KEY, "pins");
    state.mode = MODES.indexOf(saved) !== -1 ? saved : "pins";

    // Pin content comes from the canvas renderer's hit-test (it already
    // computes the hovered pin for the ghost — this reuses that work).
    window.addEventListener("xyzo:pin-hover", onPinHover);

    map.on("mousemove", onMapMove);
    map.on("movestart", hide);          // dragging: nothing follows
    map.on("mouseout", onMapOut);
    const container = map.getContainer();
    if (container) container.addEventListener("mouseleave", onMapOut);

    refreshModeButtons();
    renderSamplerList();
    refreshSamplerListVisibility();
  }

  // ── public API ───────────────────────────────────────────────────────
  window.HoverInfo = {
    init: init,
    getMode: getMode,
    setMode: setMode,
    setTarget: setTarget,
    clearTarget: clearTarget,
    suppressesProbes: suppressesProbes,
    isSamplerEnabled: isSamplerEnabled,
    setSamplerEnabled: setSamplerEnabled,
    // test hooks
    _state: state,
    _pinBlock: pinBlock,
    _readingsBlock: readingsBlock,
    _fmtCoords: fmtCoords,
    _samplers: SAMPLERS,
  };
})();
