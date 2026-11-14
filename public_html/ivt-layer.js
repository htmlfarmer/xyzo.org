/* ═══════════════════════════════════════════════════════════════════════
   Moisture transport (IVT) overlay for the Xyzo map.

   How much water vapour the atmosphere is MOVING — integrated vapour
   transport. It is the quantity that decides where an atmospheric river
   will land.

   IVT is NOT a GFS product. The GFS publishes the humidity and the wind
   at every pressure level; IVT is the integral of the humidity times
   the wind:

       IVT = (1/g) · ∫ q · V dp        [kg/(m·s)]

   so worker/ivt.py COMPUTES it from the same GFS analysis the other
   overlays use — the same idea as the wind layer, a derived field that
   says something the raw fields cannot.

   Source: NOAA NCEP GFS, 100% free (US Government work).

   worker/ivt.py writes two static files:

     /data/ivt/meta.json   colour ramp, grid layout, analysis run time
     /data/ivt/grid.bin    Uint16Array, 0.1 kg/(m·s) per unit, row 0 = -90°

   The scale is FIXED at 0..1500 kg/(m·s), because IVT has absolute
   thresholds that the public knows: 250 is the atmospheric-river
   detection threshold, and 500 / 750 / 1000 / 1250 are the CW3E
   (Ralph et al. 2019) categories — Weak, Moderate, Strong, Extreme.
   The legend carries that key, so a colour means something.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (typeof window.createFieldLayer !== "function") {
    if (window.XLog && typeof window.XLog.warn === "function") {
      window.XLog.warn("ivt-layer: field-layer.js did not load");
    }
    return;
  }

  window.IvtLayer = window.createFieldLayer({
    id: "ivt",
    layerName: "🌊 Moisture transport (IVT)",
    base: "/data/ivt",
    pane: "ivtPane",
    paneZ: 347,
    storeKey: "xyzo.ivtLayer",
    probeStoreKey: "xyzo.ivtProbe",
    legendTitle: "Moisture transport (IVT)",
    attribution: "NOAA NCEP GFS",
    format: (v) => Math.round(v) + " kg/(m·s)",
    legendNote: (meta) => {
      const scale = meta.ar_scale;
      if (!scale) return "";
      const cats = (scale.categories || [])
        .map((c) => "<b>" + c.min + "+</b> " + c.name)
        .join(" · ");
      return (
        "Atmospheric river: detected at <b>" + scale.detection +
        "</b> kg/(m·s). " + cats + "."
      );
    },
  });
})();
