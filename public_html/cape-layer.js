/* ═══════════════════════════════════════════════════════════════════════
   Convective instability (CAPE) overlay for the Xyzo map.

   How much energy the atmosphere holds for a parcel to rise — Convective
   Available Potential Energy. It is the number every severe-weather
   forecast quotes, and the map had nothing to say about it.

   Source: NOAA NCEP GFS surface CAPE, 100% free (US Government work),
   the same 6-hourly analysis as the pressure lines and the wind.

   worker/cape.py writes two static files:

     /data/cape/meta.json   colour ramp, grid layout, analysis run time
     /data/cape/grid.bin    Uint16Array, 10 J/kg per unit, row 0 = -90°

   The scale is FIXED at 0..4000 J/kg, not adaptive, because CAPE's
   thresholds are absolute and the public knows them: 1000 J/kg is the
   "Severe" line on the SPC chart and 2500 J/kg is "Extreme". An
   adaptive scale would move those thresholds every run, and the whole
   point of the layer is that a colour means the same thing every day.

   The grid is fetched once and used twice: painted into a canvas for
   the overlay, and sampled directly for the probe — so what you read IS
   the colour you are looking at.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (typeof window.createFieldLayer !== "function") {
    if (window.XLog && typeof window.XLog.warn === "function") {
      window.XLog.warn("cape-layer: field-layer.js did not load");
    }
    return;
  }

  window.CapeLayer = window.createFieldLayer({
    id: "cape",
    layerName: "⛈️ Convective instability (CAPE)",
    base: "/data/cape",
    pane: "capePane",
    // Below the temperature field (355) and well below the isobars
    // (360) and the pins (400), so it never hides a story.
    // 348, NOT 346: wavePane already has 346 and two washes on one pane
    // fight for the same slot. CAPE sits with IVT (347), the other
    // GFS convective diagnostic, so the pair keeps one corner.
    paneZ: 348,
    storeKey: "xyzo.capeLayer",
    probeStoreKey: "xyzo.capeProbe",
    legendTitle: "Convective instability (CAPE)",
    attribution: "NOAA NCEP GFS",
    format: (v) => Math.round(v) + " J/kg",
    legendNote: (meta) => {
      const v = meta.observed ? meta.observed[1] : null;
      const peak = v != null ? "This run peaks at " + Math.round(v) + " J/kg." : "";
      return (
        "SPC thresholds: <b>1000</b> severe · <b>2500</b> extreme. " + peak
      );
    },
  });
})();
