/**
 * Per-layer opacity sliders for the Leaflet layers dropdown.
 *
 * The dropdown lists the base layers and the overlays (NASA imagery, the
 * Köppen climate wash). Each overlay gets a small slider so the user can
 * dial its transparency — e.g. keep the climate classification readable
 * under a satellite layer, or fade the cloud cover to see the pins.
 *
 * The values are stored per layer name in localStorage
 * (`xyzo.overlayOpacity`) and restored on the next visit.
 *
 * Loaded before app.js; app.js calls `OverlayOpacity.mount(WEATHER_OVERLAYS)`
 * right after it creates the layers control.
 */
(function () {
  const STORAGE_KEY = "xyzo.overlayOpacity";

  // `window` does not exist outside a browser (bun, workers, tests), and
  // `document` may not either. Resolve the global scope once.
  const G = (typeof window !== "undefined" && window) ||
            (typeof globalThis !== "undefined" ? globalThis : {});
  function hasDocument() {
    return typeof document !== "undefined" && document !== null;
  }
  // Used for rows mounted by mountRow() that have no stored value yet.
  const DEFAULT_OPACITY = 1;

  // The layer's OWN default opacity, captured before anything calls
  // setOpacity(). Leaflet's setOpacity() writes straight into
  // options.opacity, so by the time the user has moved a slider the
  // original default is unrecoverable from the layer — and reset()
  // must be able to put it back. Populated by restore()/mount(), which
  // app.js calls with the full overlay table.
  const LAYER_DEFAULTS = Object.create(null);
  function captureDefaults(overlays) {
    if (!overlays) return;
    for (const key of Object.keys(overlays)) {
      if (LAYER_DEFAULTS[key] == null) {
        LAYER_DEFAULTS[key] = layerOpacity(overlays[key]);
      }
    }
  }
  function defaultFor(key, layer) {
    if (LAYER_DEFAULTS[key] != null) return LAYER_DEFAULTS[key];
    return layerOpacity(layer);
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveStored(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (_) {
      /* private mode / quota — the slider still works for this session */
    }
  }

  // ── opacities that arrived in a SHARED LINK ───────────────────────────
  //
  // A link's opacity is part of the VIEW, not a preference: the reader
  // must SEE what the sender saw, and their own stored opacity must
  // survive opening someone else's map (the same rule every layer
  // preference follows at boot — "a LINK IS A VIEW, NOT A SETTINGS
  // CHANGE").
  //
  // So a link's value goes on the LAYER and on the SLIDER, and it is
  // remembered HERE so that a later slider remount — which re-applies
  // the stored value — does not quietly put the reader's opacity back
  // and discard the link's. That remount is not a corner case: the boot
  // snapshot restores the store and the remount follows on the next
  // tick, so without this the link's opacities were silently thrown
  // away a few milliseconds after they were applied.
  //
  // The reader moving a slider clears the override: that is a choice,
  // and it wins from then on.
  const VIEW_OVERRIDES = Object.create(null);
  // The overlay table mount()/restore() were last given — applyView()
  // needs it to find the layer.
  let overlaysRef = null;

  function applyView(name, value) {
    if (!name) return DEFAULT_OPACITY;
    const v = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(v)) return DEFAULT_OPACITY;
    VIEW_OVERRIDES[name] = v;
    const layer = overlaysRef && overlaysRef[name];
    if (layer && typeof layer.setOpacity === "function") layer.setOpacity(v);
    // The slider and its readout.
    const list = hasDocument()
      ? document.querySelector(".leaflet-control-layers-list")
      : null;
    if (list) {
      const want = "Opacity of " + name;
      for (const input of list.querySelectorAll("input[type=range]")) {
        if (input.getAttribute("aria-label") !== want) continue;
        input.value = String(Math.round(v * 100));
        const readout = input.parentElement &&
          input.parentElement.querySelector(".leaflet-overlay-opacity-val");
        if (readout) readout.textContent = input.value + "%";
      }
    }
    return v;
  }

  function layerOpacity(layer) {
    const o = layer && layer.options ? layer.options.opacity : null;
    return typeof o === "number" ? o : 1;
  }

  /**
   * The dotted leader between a layer's name and its opacity slider.
   * With sixteen overlay rows the slider no longer reads as belonging
   * to the name above it — the leader spans the gap so the eye follows
   * name → dots → slider → value. Decorative only (aria-hidden, and
   * pointer-events:none so it can never eat a label click).
   */
  function makeLeader() {
    if (!hasDocument()) return null;
    const el = document.createElement("span");
    el.className = "leaflet-overlay-leader";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  /**
   * Inject one slider per overlay into the layers dropdown.
   * @param {Object<string, L.Layer>} overlays  overlay name → layer
   */
  function mount(overlays) {
    if (!overlays) return;
    if (!hasDocument()) return;
    overlaysRef = overlays;
    const list = document.querySelector(".leaflet-control-layers-overlays");
    if (!list) return;

    captureDefaults(overlays);
    const stored = loadStored();
    const keys = Object.keys(overlays);
    // Leaflet renders the overlays in the order of the object's keys.
    const labels = Array.from(list.querySelectorAll("label"));

    keys.forEach((key, i) => {
      const layer = overlays[key];
      const label = labels[i];
      if (!layer || !label || label.parentNode.classList.contains("leaflet-overlay-row")) return;

      const current = VIEW_OVERRIDES[key] != null
        ? VIEW_OVERRIDES[key]
        : (stored[key] != null ? stored[key] : defaultFor(key, layer));
      const pct = Math.max(0, Math.min(100, Math.round(current * 100)));

      // The row holds the Leaflet label and the slider side by side.
      // The slider lives OUTSIDE the <label> on purpose: inside it, a
      // click on the slider would toggle the layer checkbox.
      const row = document.createElement("div");
      row.className = "leaflet-overlay-row";
      label.parentNode.insertBefore(row, label);
      row.appendChild(label);

      const leader = makeLeader();
      if (leader) row.appendChild(leader);

      const wrap = document.createElement("div");
      wrap.className = "leaflet-overlay-opacity";

      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "100";
      input.step = "5";
      input.value = String(pct);
      input.setAttribute("aria-label", "Opacity of " + key);
      input.title = "Opacity of " + key;

      const readout = document.createElement("span");
      readout.className = "leaflet-overlay-opacity-val";
      readout.textContent = pct + "%";

      input.addEventListener("input", () => {
        const v = Number(input.value) / 100;
        if (typeof layer.setOpacity === "function") layer.setOpacity(v);
        readout.textContent = input.value + "%";
        // The reader's own choice ends any override a shared link put
        // here: from now on the stored value is the truth.
        delete VIEW_OVERRIDES[key];
        stored[key] = v;
        saveStored(stored);
        // Let the app refresh the URL hash — a shared link has to carry
        // the exact style, and the opacity is part of the style.
        try {
          G.dispatchEvent(new G.CustomEvent("xyzo:overlay-opacity", {
            detail: { key, opacity: v },
          }));
        } catch (_) {}
      });
      // Never let a slider interaction bubble into Leaflet's own label
      // handling (it would toggle the overlay).
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("mousedown", (e) => e.stopPropagation());

      wrap.appendChild(input);
      wrap.appendChild(readout);
      row.appendChild(wrap);

      // Not every overlay is a TileLayer: a GeoJSON/vector group may
      // lack setOpacity until its module attaches one. Never let a
      // missing method abort mount() — that killed the rest of app.js.
      if (typeof layer.setOpacity === "function") {
        layer.setOpacity(pct / 100);
      }

      // The COLOUR control rides in the same row, for the same reason
      // this file owns opacity: one pass over the rows, one rebuild,
      // and app.js never has to mention it (it is 8 bytes under its
      // size ceiling). OverlayPalette decides per layer whether it can
      // offer anything — a layer with no setPalette/setFilter hook is
      // skipped, which is how categorical overlays stay out without a
      // filename list.
      //
      // Through G, never a bare `window`: this file's own header defines
      // G because `window` does not exist outside a browser, and these
      // four lines were the last bare use — they made mount() throw
      // ReferenceError in bun, so the module's resilience test only
      // passed when another test file happened to have leaked a `window`
      // into the global scope first.
      if (G.OverlayPalette && typeof G.OverlayPalette.mountRow === "function") {
        try {
          G.OverlayPalette.mountRow(row, key, layer);
        } catch (e) {
          if (G.XLog && G.XLog.warn) G.XLog.warn("[palette] mount failed", key, e);
        }
      }
    });
  }

  /**
   * Apply the stored opacity to a layer before (or without) mounting the
   * sliders — used so a saved value is in effect as soon as the map loads.
   */
  function restore(overlays) {
    if (!overlays) return;
    overlaysRef = overlays;
    captureDefaults(overlays);
    const stored = loadStored();
    Object.keys(overlays).forEach((key) => {
      const layer = overlays[key];
      if (stored[key] != null && layer && typeof layer.setOpacity === "function") {
        layer.setOpacity(stored[key]);
      }
    });
  }

  /**
   * Mount a slider for a row that lives OUTSIDE the overlays list.
   *
   * The layers dropdown rebuilds `_baseLayersList` and `_overlaysList`
   * on every layer change, so a row added to the dropdown by hand (the
   * isobar layer) is not one of the labels that mount() walks. This
   * attaches the same slider UI to such a row directly.
   *
   * @param {Element|null} row    the row element to decorate
   * @param {string} name          the layer name (the localStorage key)
   * @param {Function|null} apply  called with the new 0..1 value
   * @param {number} [fallback]    opacity to use when nothing is stored
   */
  function mountRow(row, name, apply, fallback) {
    if (!row || !apply) return;
    const input = row.querySelector(".leaflet-overlay-opacity");
    if (input) return; // already mounted

    const stored = loadStored();
    const base = typeof fallback === "number" ? fallback : DEFAULT_OPACITY;
    const current = stored[name] != null ? stored[name] : base;
    const pct = Math.max(0, Math.min(100, Math.round(current * 100)));

    const wrap = document.createElement("div");
    wrap.className = "leaflet-overlay-opacity";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(pct);
    slider.setAttribute("aria-label", "Opacity of " + name);
    slider.title = "Opacity of " + name;

    const readout = document.createElement("span");
    readout.className = "leaflet-overlay-opacity-val";
    readout.textContent = pct + "%";

    slider.addEventListener("input", () => {
      const v = Number(slider.value) / 100;
      apply(v);
      readout.textContent = slider.value + "%";
      // The reader's own choice ends any override a shared link put here.
      delete VIEW_OVERRIDES[name];
      stored[name] = v;
      saveStored(stored);
      try {
        G.dispatchEvent(new G.CustomEvent("xyzo:overlay-opacity", {
          detail: { key: name, opacity: v },
        }));
      } catch (_) {}
    });
    // A click on the slider must not reach the label's checkbox.
    slider.addEventListener("click", (e) => e.stopPropagation());
    slider.addEventListener("mousedown", (e) => e.stopPropagation());

    wrap.appendChild(slider);
    wrap.appendChild(readout);
    // Same dotted leader as mount() — the isobar row is built by
    // app.js (label first), so appending here puts it between the
    // name and the slider.
    const leader = makeLeader();
    if (leader) row.appendChild(leader);
    row.appendChild(wrap);

    apply(pct / 100);
  }

  /**
   * The effective opacity of one overlay (0..1).
   *
   * THE VALUE CURRENTLY ON SCREEN WINS, in this order: a shared link's
   * view override, then the reader's stored preference, then the
   * layer's own default.
   *
   * The override has to come first because applyView() puts a link's
   * opacity on the layer and the slider and records it HERE — never in
   * the store, because opening someone else's map must not overwrite
   * the reader's own choice. Reading the store first meant getMapHash()
   * (the ONLY caller of this function) wrote the preference instead of
   * the picture for every overlay whose registered layer has no numeric
   * `options.opacity` — basins, rivers, magnetic, ocean currents,
   * language regions, earthquakes and faults all measured as **map at
   * 37 %, URL at 100 %**. Re-sharing that link silently reset the
   * opacity, in BOTH views, because the globe reads the same `slug@pct.
   *
   * The slider mount already resolves in exactly this order
   * (`VIEW_OVERRIDES[key] != null ? … : stored…`); get() has to agree
   * with it, or the number in the URL and the number on the slider are
   * decided by two different rules.
   *
   * The reader moving a slider deletes the override (see the input
   * handlers above), so from then on the stored value is the truth.
   */
  function get(overlays, key) {
    if (!key) return DEFAULT_OPACITY;
    if (VIEW_OVERRIDES[key] != null) return Number(VIEW_OVERRIDES[key]);
    const stored = loadStored();
    if (stored[key] != null) return Number(stored[key]);
    const layer = overlays && overlays[key];
    return defaultFor(key, layer);
  }

  /**
   * Apply an opacity to one overlay and sync the slider UI with it.
   *
   * Used when a shared link carries an opacity (`/overlay=basins@40`):
   * the layer, the slider and the stored value must all agree, or the
   * slider shows a number the map is not using.
   */
  function set(overlays, key, value) {
    if (!key) return DEFAULT_OPACITY;
    const v = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(v)) return DEFAULT_OPACITY;

    // The reader's own choice ends any override a shared link put here.
    delete VIEW_OVERRIDES[key];
    const stored = loadStored();
    stored[key] = v;
    saveStored(stored);

    if (overlays) overlaysRef = overlays;
    const layer = overlaysRef && overlaysRef[key];
    if (layer && typeof layer.setOpacity === "function") layer.setOpacity(v);

    // Update the slider and its readout.
    const list = hasDocument()
      ? document.querySelector(".leaflet-control-layers-list")
      : null;
    if (list) {
      const want = "Opacity of " + key;
      for (const input of list.querySelectorAll("input[type=range]")) {
        if (input.getAttribute("aria-label") !== want) continue;
        input.value = String(Math.round(v * 100));
        const readout = input.parentElement &&
          input.parentElement.querySelector(".leaflet-overlay-opacity-val");
        if (readout) readout.textContent = input.value + "%";
      }
    }

    try {
      G.dispatchEvent(new G.CustomEvent("xyzo:overlay-opacity", {
        detail: { key, opacity: v },
      }));
    } catch (_) {}
    return v;
  }

  /**
   * Forget every stored opacity and put each overlay back on the
   * layer's OWN default (captured by captureDefaults() before any
   * slider could clobber it). Backs the layers panel's "Reset" button.
   *
   * The slider rows are re-synced in place: the rows survive (they are
   * DOM we built), only their values change. The isobar row lives
   * outside the overlays list and is reset by app.js, which owns it.
   */
  function reset(overlays) {
    saveStored({});
    if (!overlays || !hasDocument()) return;
    const list = document.querySelector(".leaflet-control-layers-overlays");
    const labels = list ? Array.from(list.querySelectorAll("label")) : [];
    const keys = Object.keys(overlays);
    keys.forEach((key, i) => {
      const layer = overlays[key];
      const v = Math.max(0, Math.min(1, defaultFor(key, layer)));
      if (layer && typeof layer.setOpacity === "function") layer.setOpacity(v);
      const label = labels[i];
      if (!label) return;
      const row = label.parentElement;
      const input = row && row.querySelector("input[type=range]");
      if (input) {
        input.value = String(Math.round(v * 100));
        const readout = row.querySelector(".leaflet-overlay-opacity-val");
        if (readout) readout.textContent = input.value + "%";
      }
    });
    try {
      G.dispatchEvent(new G.CustomEvent("xyzo:overlay-opacity", {
        detail: { key: "*", opacity: null },
      }));
    } catch (_) {}
  }

  // Both scopes: `window` in a browser, `globalThis` everywhere else
  // (bun, workers, tests — `window` is not defined there).
  if (typeof window !== "undefined") {
    window.OverlayOpacity = { mount, restore, mountRow, get, set, applyView, reset };
  }
  if (typeof globalThis !== "undefined") {
    globalThis.OverlayOpacity = { mount, restore, mountRow, get, set, applyView, reset };
  }
})();
