/* ═══════════════════════════════════════════════════════════════════════
   overlay-palette.js — a colour-style picker on every overlay row.

   The ask: "a way for us to select different colors for all overlays".
   The machinery already existed for OPACITY — OverlayOpacity.mount()
   walks the layers-control rows and hangs a slider off each one — so
   this file does the same job for COLOUR, and for the same reason the
   opacity slider lives outside the <label>: a click inside a label
   toggles the checkbox.

   CAPABILITY-DRIVEN, NOT A LIST. The picker mounts only on rows whose
   layer exposes one of two hooks:

     setPalette(name)  a VALUE overlay — rewrites meta.ramp's COLOURS
                       (positions untouched) and repaints. temperature,
                       lightning, magnetic, relief, waves, CAPE/IVT.
     setFilter(name)   an IMAGE overlay — no values to remap, so the
                       drawing itself is shifted (CSS filter on the
                       pane). population, served pre-coloured by FAO.

   A layer exposing neither is skipped, which is how categorical layers
   (Köppen, soil, cropland, phytoplankton, basins, languages) stay out
   without a filename list to keep in step: their colours ARE their
   meaning, and recolouring "tropical rainforest" to violet turns a
   classification into decoration. RampStyles.isCategorical() is kept as
   a second, belt-and-braces guard.

   app.js does NOT know this file exists — OverlayOpacity calls into it,
   which is what keeps app.js off the hook for its 850,000-byte ceiling
   (it was at 849,992 with 8 bytes to spare when this landed).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var STORE_KEY = "xyzo.overlayPalette";

  function hasDocument() {
    return typeof document !== "undefined" && document.querySelector;
  }
  function storageGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch (_) {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }
  function loadStored() {
    try {
      return JSON.parse(storageGet(STORE_KEY, "{}")) || {};
    } catch (_) {
      return {};
    }
  }

  function styles() {
    return window.RampStyles;
  }

  // Which hook does this layer offer? Returns null for a layer that
  // offers neither — categorical overlays land here and are skipped.
  function modeFor(layer) {
    if (!layer) return null;
    if (typeof layer.setPalette === "function") return "palette";
    if (typeof layer.setFilter === "function") return "filter";
    return null;
  }

  function optionsFor(mode) {
    var R = styles();
    if (!R) return [];
    var order = mode === "filter" ? R.FILTER_ORDER : R.RAMP_ORDER;
    var labels = mode === "filter" ? null : R.RAMP_LABELS;
    return order.map(function (key) {
      return {
        key: key,
        label: labels ? labels[key] : R.FILTER_STYLES[key].label,
        hint: mode === "filter" ? R.FILTER_STYLES[key].hint : R.RAMP_HINTS[key],
        swatch: mode === "filter" ? null : R.swatch(key),
      };
    });
  }

  function applyTo(layer, mode, key, name) {
    var ok = false;
    try {
      if (mode === "palette" && typeof layer.setPalette === "function") {
        ok = !!layer.setPalette(key);
      } else if (mode === "filter" && typeof layer.setFilter === "function") {
        ok = !!layer.setFilter(key);
      }
    } catch (e) {
      if (window.XLog && XLog.warn) XLog.warn("[palette] apply failed", e);
      return false;
    }
    if (!ok) return false;

    var stored = loadStored();
    stored[name] = key;
    storageSet(STORE_KEY, stored);
    return true;
  }

  // ── the control ───────────────────────────────────────────────────────
  // A <select>, not chips: seven options with a swatch each is too wide
  // for the dropdown beside a 100 % slider, and a select keeps the row
  // one line tall however many palettes exist.
  function build(layer, name, mode, current) {
    var opts = optionsFor(mode);
    if (!opts.length) return null;

    var wrap = document.createElement("div");
    wrap.className = "leaflet-overlay-palette";
    wrap.title = mode === "filter"
      ? "Colour style (the source is a pre-coloured picture)"
      : "Colour palette";

    var sel = document.createElement("select");
    sel.className = "leaflet-overlay-palette-select";
    sel.setAttribute("aria-label", "Colour palette of " + name);

    opts.forEach(function (o) {
      var el = document.createElement("option");
      el.value = o.key;
      el.textContent = o.label;
      if (o.hint) el.title = o.hint;
      sel.appendChild(el);
    });
    sel.value = current;

    sel.addEventListener("change", function () {
      if (applyTo(layer, mode, sel.value, name)) {
        sel.title = wrap.title + " — " + sel.options[sel.selectedIndex].text;
      } else {
        sel.value = current; // the layer refused; put it back honestly
      }
    });

    wrap.appendChild(sel);
    return wrap;
  }

  // Called by OverlayOpacity for every row it mounts, so the two
  // controls always appear together or not at all.
  function mountRow(row, name, layer) {
    if (!row || !name) return;
    if (row.querySelector(".leaflet-overlay-palette")) return; // once only
    if (!styles()) return;

    var mode = modeFor(layer);
    if (!mode) return; // no hook: categorical, or not yet ported
    if (styles().isCategorical && styles().isCategorical(name)) return;

    var stored = loadStored();
    var current = stored[name];
    var opts = optionsFor(mode);
    var known = opts.some(function (o) { return o.key === current; });
    if (!known) current = opts[0].key;

    var control = build(layer, name, mode, current);
    if (!control) return;
    row.appendChild(control);

    // A palette picked on a previous visit must actually be APPLIED, not
    // merely shown in the select — otherwise reopening the map shows the
    // old colours under a dropdown that says otherwise.
    if (stored[name] && stored[name] !== opts[0].key) {
      applyTo(layer, mode, stored[name], name);
    }
  }

  window.OverlayPalette = {
    mountRow: mountRow,
    modeFor: modeFor,
    applyTo: applyTo,
    STORE_KEY: STORE_KEY,
    // test hooks
    _loadStored: loadStored,
    _optionsFor: optionsFor,
  };
})();
