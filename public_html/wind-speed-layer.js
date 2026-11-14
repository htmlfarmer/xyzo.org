/* ═══════════════════════════════════════════════════════════════════════
   Wind SPEED field (GFS 10 m) — the scalar companion to the animation.

   The wind animation shows WHERE the air is going. This shows HOW FAST
   it is going, as a colour wash under the animation — the two together
   are the whole picture, and a reader can dim the animation (or turn it
   off) and still see the field.

   The speed is the MAGNITUDE of the published u/v pair, so it is
   computed from the bytes the animation is already using: one
   grid.bin, fetched once, read by both. Nothing is published twice and
   nothing is downloaded twice.

   Source: NOAA NCEP GFS 10 m wind (US Government work, public domain),
   the same 6-hourly analysis as the pressure lines and the temperature.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (typeof window.createFieldLayer !== "function") {
    if (window.XLog && typeof window.XLog.warn === "function") {
      window.XLog.warn("wind-speed-layer: field-layer.js did not load");
    }
    return;
  }

  // The field layer speaks the generic shape: a range, a ramp keyed by
  // `v`, and a grid. The wind's own meta speaks in `ms` and carries
  // TWO planes, so it is translated here — once — and the factory does
  // the rest (bake, drape, legend, probe, export).
  function speedMeta(meta) {
    return {
      source: meta.source,
      variable: "10 m wind speed",
      units: "m/s",
      run_time: meta.run_time,
      license: meta.license,
      attribution: meta.attribution,
      grid: { ...meta.grid, dtype: "int16", layout: "planar" },
      range: meta.range_ms,
      ramp: (meta.ramp || []).map((s) => ({ v: Number(s.ms), rgb: s.rgb })),
    };
  }

  // u and v -> the magnitude, in the grid's own units (0.01 m/s).
  function deriveSpeed(raw, meta) {
    const n = meta.grid.rows * meta.grid.cols;
    const scale = meta.grid.scale || 100;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const u = raw[i] / scale;
      const v = raw[n + i] / scale;
      out[i] = Math.round(Math.sqrt(u * u + v * v) * scale);
    }
    return out;
  }

  window.WindSpeedLayer = window.createFieldLayer({
    id: "wind-speed",
    layerName: "🌬️ Wind speed (GFS)",
    pane: "windSpeedPane",
    // Below the wind ANIMATION (370) and well below the pins (400), so
    // the speed wash is the ground the streaks lie on and never hides a
    // story. 366 is free (the overlay stack's free slots are 349, 363
    // and 366-369).
    paneZ: 366,
    // A wash, not a wall: at 100 % the field hides the basemap AND the
    // animation that is supposed to sit on top of it. 40 % lets the
    // satellite through and still reads as a field.
    defaultOpacity: 0.4,
    storeKey: "xyzo.windSpeedLayer",
    probeStoreKey: "xyzo.windSpeedProbe",
    legendTitle: "Wind speed — 10 m, GFS",
    attribution: "NOAA NCEP GFS",

    // Owner ask (2026-11-04): m/s is gone from every reader-facing wind
    // reading; the wind is shown in miles/hour, kilometres/hour and
    // knots. m/s stays the DATA unit (the published grid, the ramp and
    // the export band names are all in m/s) and only the DISPLAY
    // converts.
    format: (v) => Math.round(v * 2.23694) + " mph · " +
      Math.round(v * 3.6) + " km/h · " + Math.round(v * 1.94384) + " kt",
    legendNote: (meta) => {
      const r = meta.range || [];
      return "Slow " + Math.round((r[0] || 0) * 2.23694) + " mph · fast " +
        Math.round((r[1] || 0) * 2.23694) +
        " mph. The magnitude of the same u/v pair the wind animation draws.";
    },

    // The number comes from the wind ANIMATION's own sampler.
    //
    // The speed field used to compute its magnitude on a pre-derived
    // grid — and that is not the same number: bilinear(u,v) then
    // hypot is not bilinear(hypot(u,v)). The two layers printed 2.3 m/s
    // and 2.4 m/s for the same air on the same screen, which reads as
    // a bug to anyone who moves the pointer. Reading the vector
    // through the animation's sampler makes it ONE number.
    //
    // `undefined` falls back to this layer's own grid, so the field
    // still works if the animation module is missing.
    sampleValue: (lat, lon) => {
      const W = window.WindLayer;
      if (!W || typeof W.sampleVector !== "function") return undefined;
      const s = W.sampleVector(lat, lon);
      if (!s) return null;
      return Math.hypot(s[0], s[1]);
    },

    // With the wind ANIMATION on, its probe already carries the speed
    // AND the direction, so this layer's readout stands down — two boxes
    // with the same number in them is how the probes ended up fighting.
    // With the animation off, this layer is the only wind reading and it
    // speaks.
    readingGuard: () => !!(window.WindLayer && typeof window.WindLayer.isEnabled === "function" &&
      window.WindLayer.isEnabled()),

    // The data comes from the wind module, which has already fetched
    // it. If the reader turns the speed field on before the animation
    // has ever run, the wind module is asked to load it — one fetch,
    // shared by both layers.
    // The legend's meta is the WIND's meta reshaped — 1 KB on its own.
    // Without this hook the legend mount fell back to loadData(), which
    // fetched the whole 4 MB grid at boot for a layer that is OFF.
    loadMeta: async () => {
      const W = window.WindLayer;
      if (!W || typeof W.ensureMeta !== "function") throw new Error("wind-layer.js did not load");
      return speedMeta(await W.ensureMeta());
    },
    loadData: async () => {
      const W = window.WindLayer;
      if (!W || typeof W.getRawData !== "function") {
        throw new Error("wind-layer.js did not load");
      }
      const raw = await W.ensureRawData();
      return { meta: speedMeta(raw.meta), raw: raw.raw };
    },
    derive: deriveSpeed,
  });
})();
