/* ═══════════════════════════════════════════════════════════════════════
   ramp-styles.js — named colour palettes for the DATA overlays.

   The ask: "various rainbow color styles we can use for any of the data
   overlays". Two different mechanisms live here, because the overlays
   fall into two kinds:

   1. VALUE overlays (temperature, lightning, magnetic, relief, waves,
      CAPE, IVT, population-if-we-held-its-values) render from a ramp in
      meta.json: `[{ c: <value>, rgb: "#rrggbb" }, …]`. `recolor()`
      keeps every STOP POSITION and only rewrites the colour, so the
      legend, the probe and the map all stay in step — the palette is a
      view of the data, never a second copy of it.

   2. IMAGE overlays (population, served by FAO as pre-coloured PNGs)
      hold no values at all, so there is no ramp to rewrite. What CAN
      change is how the picture is drawn: CSS filters on the tile pane
      (hue-rotate / saturate / grayscale / sepia) shift or neutralise
      FAO's fixed palette. That is a genuine colour change but it is NOT
   a value-mapped rainbow — say so in the UI rather than implying
      otherwise.

   WHAT IS DELIBERATELY NOT HERE: categorical layers (Köppen, soil
   classes, cropland, phytoplankton). Their colours ARE their meaning —
   recolouring "tropical rainforest" to violet tells a lie the map then
   repeats. `isCategorical()` names them so a picker can refuse politely.

   Every palette is a list of hex stops sampled evenly across 0..1. They
   are named after the matplotlib/ColorBrewer originals they follow, so a
   reader who knows viridis gets what they expect.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Evenly spaced hex stops, 0 (low) → 1 (high).
  var RAMPS = {
    // The original: a full hue sweep, high contrast at both ends.
    rainbow: ["#00007f", "#0040ff", "#00bfff", "#00ff80", "#7fff00",
              "#ffd700", "#ff8000", "#ff2020", "#a00000"],

    // Perceptually uniform — no band where two neighbouring values look
    // the same colour. Good for a field with a long tail (population,
    // temperature).
    viridis: ["#440154", "#414487", "#2a788e", "#22a884", "#7ad151",
              "#fde725"],

    // Hotter, faster: violet → cyan → green → yellow → red. Reads well
    // against the dark satellite basemap the site opens on.
    turbo: ["#30123b", "#4145ab", "#4675ed", "#39a2fe", "#1bdda6",
            "#77e057", "#d8e219", "#fab426", "#f47b19", "#e43f2d",
            "#7a0403"],

    // Black → purple → orange → yellow: the classic "hot" ramp, best
    // where the low end should recede into the basemap.
    inferno: ["#000004", "#420a68", "#932667", "#dd513a", "#fca50a",
              "#fcffa4"],

    // Warm side only: amber → crimson. Good for magnitude fields.
    warm: ["#fff7ec", "#fee8c8", "#fdd49e", "#fdbb84", "#fc8d59",
           "#ef6548", "#d7301f", "#990000"],

    // Cool side only: pale blue → deep navy. Sea/ice-like fields.
    cool: ["#f7fbff", "#c6dbef", "#6baed6", "#3182bd", "#08519c",
           "#08306b"],

    // Value magnitude only — when hue would imply a direction the data
    // does not have.
    greyscale: ["#ffffff", "#d9d9d9", "#bdbdbd", "#969696", "#737373",
                "#525252", "#252525", "#000000"],
  };

  // The picker's order: what a reader is most likely to reach for.
  //
  // "published" is FIRST, and it means "the colours the source shipped
  // with". It is first because it is what every value overlay actually
  // paints until the reader chooses otherwise — and the picker used to
  // claim "Rainbow" while the map was showing the published ramp, which
  // is a small lie in a control the reader is about to trust.
  //
  // recolour() returns the ramp untouched for a name it does not know, so
  // "published" needs no special case anywhere else.
  var RAMP_ORDER = ["published", "rainbow", "viridis", "turbo", "inferno",
                    "warm", "cool", "greyscale"];

  var RAMP_LABELS = {
    published: "Published",
    rainbow: "Rainbow",
    viridis: "Viridis",
    turbo: "Turbo",
    inferno: "Inferno",
    warm: "Warm",
    cool: "Cool",
    greyscale: "Grey",
  };

  var RAMP_HINTS = {
    published: "The colours the source shipped with",
    rainbow: "Full hue sweep — the most contrast between neighbours",
    viridis: "Perceptually even — best for a long-tailed field",
    turbo: "Violet → cyan → green → red, high contrast on dark maps",
    inferno: "Black → purple → orange — the low end recedes",
    warm: "Amber → crimson, for magnitudes",
    cool: "Pale blue → navy, for sea and ice",
    greyscale: "Magnitude only, when hue would imply a direction",
  };

  // ── the transform ─────────────────────────────────────────────────────
  // Keep every stop's POSITION (its `c`), rewrite only the colour.
  // Positions are what make a ramp mean something: the probe reads the
  // value, the legend prints it, and the map colours by it. Swapping
  // positions would silently change what the data says.
  //
  // t is measured across the ramp's OWN range, so it works for a
  // sequential ramp (0…90 °C) and a diverging one (−180…+180 °) without
  // the caller saying which it is.
  function recolor(ramp, paletteName) {
    var stops = RAMPS[paletteName];
    if (!stops || !ramp || ramp.length < 2) return ramp;

    var c0 = ramp[0].c;
    var cN = ramp[ramp.length - 1].c;
    var span = cN - c0;
    var out = [];
    for (var i = 0; i < ramp.length; i++) {
      var t = span === 0 ? 0 : (ramp[i].c - c0) / span;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      out.push({ c: ramp[i].c, rgb: sample(stops, t) });
      // keep any sibling fields the layer put on the stop (the temp
      // ramp carries `f`, the mag ramps carry their own labels)
      for (var k in ramp[i]) {
        if (k !== "c" && k !== "rgb") out[i][k] = ramp[i][k];
      }
    }
    return out;
  }

  // Sample a hex-stop list at 0..1 with linear interpolation, so the
  // result has as many stops as the input (a step function between the
  // palette's own stops would band).
  function sample(stops, t) {
    var last = stops.length - 1;
    if (t <= 0) return stops[0];
    if (t >= 1) return stops[last];
    var x = t * last;
    var i = Math.floor(x);
    var f = x - i;
    if (i >= last) return stops[last];
    var a = hex(stops[i]);
    var b = hex(stops[i + 1]);
    var r = Math.round(a[0] + (b[0] - a[0]) * f);
    var g = Math.round(a[1] + (b[1] - a[1]) * f);
    var bl = Math.round(a[2] + (b[2] - a[2]) * f);
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | bl)
      .toString(16).slice(1);
  }

  function hex(h) {
    var v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // A swatch string for a legend button: a gradient of the palette, so
  // the reader picks by looking rather than by name.
  function swatch(paletteName) {
    var stops = RAMPS[paletteName];
    // "published" has no stops of its own — it means the SOURCE's
    // colours, which this module has never seen. A neutral grey ramp
    // stands in, so the swatch does not promise a colour it cannot
    // show.
    if (!stops) {
      if (paletteName === "published") {
        return "linear-gradient(to right, #6b7280, #9ca3af, #d1d5db, #f3f4f6)";
      }
      return "#888";
    }
    return "linear-gradient(to right, " + stops.join(", ") + ")";
  }

  // ── layers that hold a PICTURE rather than values ─────────────────────
  // Population is served by FAO as pre-coloured PNGs: there is no ramp to
  // rewrite, only the rendering to shift. These are CSS filter chains —
  // honest colour changes, explicitly NOT value-mapped.
  var FILTER_STYLES = {
    none:   { label: "As published", css: "none",
              hint: "FAO's own palette, unmodified" },
    rainbow:{ label: "Rainbow (hue shift)", css: "hue-rotate(120deg) saturate(1.5)",
              hint: "Rotates FAO's palette through the spectrum — the " +
                    "colour order is FAO's, not a value ramp (we hold no " +
                    "values; see the note below)" },
    vivid:  { label: "Vivid", css: "saturate(1.9) contrast(1.15)",
              hint: "Same colours, pushed harder" },
    mono:   { label: "Greyscale", css: "grayscale(1) contrast(1.1)",
              hint: "Density only, no colour meaning" },
    thermal:{ label: "Thermal", css: "hue-rotate(-70deg) saturate(1.6)",
              hint: "Cold end toward red, as a heat map reads" },
    sepia:  { label: "Sepia", css: "sepia(0.85) contrast(1.1)",
              hint: "Paper-chart look"},
  };
  var FILTER_ORDER = ["none", "rainbow", "vivid", "thermal", "mono", "sepia"];

  // ── what must NOT be recoloured ───────────────────────────────────────
  // Their colours are their meaning; a picker that recolours them turns
  // a classification into decoration.
  var CATEGORICAL = {
    "climate-layer.js": 1,      // Köppen zones
    "soil-layer.js": 1,         // WRB / USDA classes
    "cropland-layer.js": 1,     // ESA class ids
    "phytoplankton-layer.js": 1,// dominant plankton type
    "basin-layer.js": 1,        // drainage kind
    "languages-layer.js": 1,    // macroarea colours
  };

  function isCategorical(file) {
    return !!CATEGORICAL[file];
  }

  function hasPalette(file) {
    return !isCategorical(file);
  }

  window.RampStyles = {
    RAMPS: RAMPS,
    RAMP_ORDER: RAMP_ORDER,
    RAMP_LABELS: RAMP_LABELS,
    RAMP_HINTS: RAMP_HINTS,
    FILTER_STYLES: FILTER_STYLES,
    FILTER_ORDER: FILTER_ORDER,
    recolor: recolor,
    sample: sample,
    swatch: swatch,
    isCategorical: isCategorical,
    hasPalette: hasPalette,
    // test hooks
    _hex: hex,
  };
})();
