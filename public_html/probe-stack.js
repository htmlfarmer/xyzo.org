/* ═══════════════════════════════════════════════════════════════════════
   The probe stack — ONE place that decides where a readout sits.

   THE PROBLEM
   ───────────
   Every layer that has a number under the cursor draws its OWN box:
   the wind animation, the wind-speed field, the climate wash, the
   temperature field, the soil, the magnetic field, the lightning, the
   phytoplankton, the relief, the waves, the ocean currents. Each one
   positions itself at `containerPoint + 14 px` — the house offset — so
   with two or three of them on, they land on the SAME 14 px and
   STACK ON TOP OF EACH OTHER. The reader sees the top box and the
   other two are hidden underneath it.

   Measured on the live map (2026-11-04, pointer at 800,500):

       .wind-probe          [814, 514, 196, 44]
       #wind-speed-probe    [814, 514, 139, 26]     <- exactly on top
       .climate-probe       [914, 574, 205, 30]     <- exactly on top

   Three boxes, two of them invisible, and the visible one only says
   part of the story.

   THE RULE
   ────────
   ONE positioner for every readout on the map. It stacks the boxes
   downward from the cursor, flips the stack upward when it would run
   off the bottom, flips a box to the left of the cursor when it would
   run off the right, and it treats the hover HUD card as the TOP of
   the stack so the card never covers a layer's reading.

   The layers keep their own look — a climate probe is a climate probe
   and a wind probe is a wind probe — because those boxes carry things
   the card cannot (a colour swatch, a °C/°F pair, a compass point).
   What they lose is the right to choose their own coordinates.

   WHY NOT ONE MERGED CARD?
   ───────────────────────
   A single card would be tidier, but eleven layers would have to give
   up their own probe markup, and the ARMED (tap-to-read) probes on a
   touch device are a deliberate single-layer action with a different
   life cycle. Stacking keeps every layer's box and its armed flow
   intact, and fixes the overlap with one positioner.

   Coordinates
   ───────────
   Two coordinate systems live on this page:

     * the layer probes are `position: absolute` inside the MAP
       CONTAINER, so their left/top are CONTAINER points;
     * the hover HUD is `position: fixed` on `<body>`, so its left/top
       are VIEWPORT points.

   The stacker measures both and writes each back in its own system.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // The probe boxes that live inside the map container.
  const MAP_PROBES = [
    ".climate-probe",          // climate, soil, cropland, geology, etopo, wave
    ".temp-probe",             // temperature, magnetic
    ".wind-probe",             // the wind animation
    ".lightning-probe",
    ".phytoplankton-probe",
    ".field-probe",            // CAPE, IVT, wind speed
    ".ocean-current-probe",
  ];

  // The card that lives on <body>.
  const FIXED_PROBES = [".hover-hud"];

  const OFFSET = 14;   // px from the cursor — the house offset every probe used
  const GAP = 3;       // px between two stacked boxes
  const EDGE = 10;     // px kept clear of the edge of the map

  const state = {
    map: null,
    host: null,        // the map container
    anchor: null,      // { cp: {x,y}, client: {x,y} } — the last cursor position
    raf: 0,
    lastCount: -1,
  };

  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    if (el.classList && el.classList.contains("hidden")) return false;
    // `offsetWidth`/`offsetHeight` are 0 for an element that is not
    // rendered at all — a probe that was never shown, or one inside a
    // collapsed panel.
    return !!(el.offsetWidth || el.offsetHeight);
  }

  function collect() {
    const host = state.host;
    const mapBoxes = [];
    const fixedBoxes = [];
    if (host) {
      for (const sel of MAP_PROBES) {
        const els = host.querySelectorAll(sel);
        for (let i = 0; i < els.length; i++) {
          if (visible(els[i])) mapBoxes.push(els[i]);
        }
      }
    }
    for (const sel of FIXED_PROBES) {
      const els = document.querySelectorAll(sel);
      for (let i = 0; i < els.length; i++) {
        if (visible(els[i])) fixedBoxes.push(els[i]);
      }
    }
    return { mapBoxes, fixedBoxes };
  }

  // Lay every readout out in one column, starting at the cursor.
  function layout() {
    state.raf = 0;
    const host = state.host;
    const anchor = state.anchor;
    if (!host || !anchor) return;

    const { mapBoxes, fixedBoxes } = collect();
    if (!mapBoxes.length && !fixedBoxes.length) return;

    // The layer readings first, the hover card last: the card is the
    // thing the reader pointed at, so it goes on top of the column
    // rather than under it.
    const boxes = mapBoxes.concat(fixedBoxes).map((el) => ({
      el,
      w: el.offsetWidth,
      h: el.offsetHeight,
      fixed: fixedBoxes.indexOf(el) !== -1,
    }));

    const hostW = host.clientWidth || window.innerWidth;
    const hostH = host.clientHeight || window.innerHeight;
    const total = boxes.reduce((s, b) => s + b.h + GAP, -GAP);

    // Where the column starts. It flips ABOVE the cursor when it would
    // run off the bottom — and only then, so the natural reading order
    // (top to bottom) is preserved whenever there is room.
    let y = anchor.cp.y + OFFSET;
    if (y + total > hostH - EDGE) {
      const up = anchor.cp.y - OFFSET - total;
      if (up >= EDGE) y = up;
    }

    const hostRect = host.getBoundingClientRect();

    for (const b of boxes) {
      let x = anchor.cp.x + OFFSET;
      // Flip to the LEFT of the cursor when the box would run off the
      // right edge — the box keeps its own width, so the reading is
      // never clipped.
      if (x + b.w > hostW - EDGE) x = anchor.cp.x - OFFSET - b.w;
      if (x < EDGE) x = Math.max(EDGE, x);
      const top = y;
      if (b.fixed) {
        // A fixed element on <body> is positioned in VIEWPORT points;
        // the stack works in container points.
        b.el.style.left = Math.round(hostRect.left + x) + "px";
        b.el.style.top = Math.round(hostRect.top + top) + "px";
      } else {
        b.el.style.left = Math.round(x) + "px";
        b.el.style.top = Math.round(top) + "px";
      }
      y += b.h + GAP;
    }
  }

  function schedule() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(layout);
  }

  // ── the public API ────────────────────────────────────────────────────

  // Place ONE element (the hover card) in the stack. Called by the
  // hover module after it has rendered, so the card and the layer
  // probes are laid out together rather than fighting for the cursor.
  function place(el) {
    // The card is rendered BEFORE it is un-hidden, so it may well be
    // invisible at this instant — the layout still has to be scheduled,
    // or the card would keep the coordinates of the PREVIOUS cursor
    // until the next mousemove.
    void el;
    schedule();
  }

  function init(map) {
    if (!map || state.map) return;
    state.map = map;
    state.host = map.getContainer ? map.getContainer() : null;
    if (!state.host) {
      warn("probe-stack: the map has no container — the probes will not be stacked");
      return;
    }
    map.on("mousemove", (e) => {
      const oe = e.originalEvent;
      const client = oe && typeof oe.clientX === "number"
        ? { x: oe.clientX, y: oe.clientY }
        : null;
      state.anchor = {
        cp: e.containerPoint ? { x: e.containerPoint.x, y: e.containerPoint.y } : null,
        client,
      };
      if (!state.anchor.cp && client) {
        // A synthetic event with no container point: fall back to the
        // container's own rect so the stack still has an anchor.
        const r = state.host.getBoundingClientRect();
        state.anchor.cp = { x: client.x - r.left, y: client.y - r.top };
      }
      schedule();
    });
    map.on("mouseout", () => {
      state.anchor = null;
    });
    map.on("movestart", () => {
      state.anchor = null;
    });
  }

  window.ProbeStack = {
    init,
    place,
    schedule,
    // test hooks
    _state: state,
    _layout: layout,
    _collect: collect,
  };
})();
