/* ═══════════════════════════════════════════════════════════════════════
   The generic overlay-module list — which window.*Layer modules app.js
   registers and initialises through its shared loop rather than by
   writing out an `if (window.X && …)` block per layer.

   WHY THIS FILE EXISTS AT ALL: app.js is under an explicit 850,000-byte
   runaway ceiling asserted by code-splitting.bun.test.js, and it was
   sitting at 849,990 — ten bytes. Naming a third module inline
   (`["CapeLayer", "IvtLayer", "PopulationLayer"]`, twice, = +36 bytes)
   would have blown it. Holding the names HERE costs app.js two bytes
   (the array literal becomes one identifier) and makes every future
   overlay of this shape free instead of a CI failure that looks
   unrelated to the change that caused it.

   A module qualifies by exposing:
       LAYER_NAME, getTileLayer(), init(map)
   Both loops that read this list skip anything that does not, so a
   module listed here but never loaded (script blocked, typo in the
   filename) is silently ignored rather than a boot-stopping throw.

   Must load BEFORE app.js — app.js reads it at parse time via
   `window.XYZO_GENERIC_LAYERS`. index.html carries it as a `defer`
   script above app.js, so document order guarantees the ordering.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  window.XYZO_GENERIC_LAYERS = [
    // public_html/field-layer.js factory: CAPE + IVT
    "CapeLayer",
    "IvtLayer",
    // public_html/wind-speed-layer.js — the wind SPEED field, the scalar
    // companion to the wind animation. Same factory: it reads the u/v
    // grid the animation already fetched and takes the magnitude.
    "WindSpeedLayer",
    // public_html/population-layer.js — WorldPop 1 km density, hotlinked
    // WMTS (see its header for why it is not baked)
    "PopulationLayer",
    // public_html/hwsd-layer.js — the FAO/IIASA Harmonized World Soils
    // Database v2.2: 34 WRB soil groups at ~1 km, also hotlinked WMTS.
    // The sibling of SoilGrids — "what kind of soil" against "how much
    // sand and clay".
    "HWSDLayer",
  ];
})();
