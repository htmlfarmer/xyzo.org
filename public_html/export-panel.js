/* ═══════════════════════════════════════════════════════════════════════
   The export panel — "take this map with you".

   WHAT THE USER GETS
   ──────────────────
   · a PNG of the map they are looking at (overlays + pins + a legend
     and the attribution footer)
   · a GeoTIFF of any data layer — the file QGIS opens natively
   · a GeoJSON of the vector layers
   · a KML for Google Earth
   · a CSV of the pins, or of a raster layer as lon/lat/value
   · a ZIP with all of it, plus the licence text

   WHERE THE WORK HAPPENS
   ──────────────────────
   In the user's browser. There is no export endpoint on the server and
   no render queue: the site already publishes every dataset as a static
   file under /data/, so the browser reads what it already has and
   writes the file itself. A whole-world GeoTIFF costs the site
   nothing.

   THE LICENCE
   ──────────
   Every export carries the attribution and licence of every dataset it
   contains — CC BY 4.0 requires attribution, and CC BY-SA 4.0 (the FAO
   basins, Glottolog) makes the derivative share-alike. The footer on a
   PNG and the LICENSE.txt in a ZIP are not decoration; they are the
   licence obligation.

   A NOTE ON THE BASEMAP
   ─────────────────────
   The PNG draws the OVERLAYS. It does not draw a third-party basemap:
   a world PNG made of OSM or Esri tiles would be a bulk download, and
   the tile policies do not allow that. The data layers are all ours,
   and a data figure reads better without a satellite photo under it.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const FORMATS = [
    { id: "png", label: "PNG", kind: "raster", hint: "A picture of the map" },
    { id: "geotiff", label: "GeoTIFF", kind: "raster", hint: "Opens in QGIS" },
    { id: "geojson", label: "GeoJSON", kind: "vector", hint: "Opens in QGIS" },
    { id: "kml", label: "KML", kind: "vector", hint: "Google Earth" },
    { id: "csv", label: "CSV", kind: "pins", hint: "A table" },
    { id: "zip", label: "Everything", kind: "all", hint: "One ZIP" },
  ];

  const state = {
    open: false,
    scope: "view",        // "view" | "world"
    format: "png",
    selected: new Set(),  // surface ids
    includePins: true,
    scale: 1,
    busy: false,
    el: null,
  };

  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }

  function reg() { return window.XYZO_EXPORT; }
  function engine() { return window.XYZO_EXPORT_ENGINE; }

  // The overlay opacity of a surface, from the map's own store — the
  // export must be as transparent as the screen.
  function opacityFor(surface) {
    try {
      if (surface.layerName && typeof window.overlayOpacityFor === "function") {
        return window.overlayOpacityFor(surface.layerName);
      }
    } catch (_) {}
    return 1;
  }

  function currentBbox() {
    const e = engine();
    if (!e) return [-180, -90, 180, 90];
    if (state.scope === "world") return e.WORLD_BBOX.slice();
    return e.bboxFromMap();
  }

  function pins() {
    try {
      if (typeof window.__xyzoExportPins === "function") return window.__xyzoExportPins() || [];
    } catch (_) {}
    return [];
  }

  // ── the markup ──────────────────────────────────────────────────────
  function build() {
    const el = document.createElement("div");
    el.id = "export-panel";
    el.className = "export-panel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    el.setAttribute("aria-label", "Export map data");
    el.innerHTML = [
      '<div class="export-panel-inner">',
      '<div class="export-panel-head">',
      '  <span class="export-panel-title">Export</span>',
      '  <button type="button" class="export-panel-close" aria-label="Close export">&times;</button>',
      '</div>',
      '<div class="export-panel-body">',
      '  <div class="export-label">Area</div>',
      '  <div class="export-picker" id="export-scope" role="group" aria-label="Export area">',
      '    <button type="button" data-scope="view" class="is-active">This view</button>',
      '    <button type="button" data-scope="world">Whole world</button>',
      '  </div>',
      '  <div class="export-label">Format</div>',
      '  <div class="export-picker export-picker-wrap" id="export-format" role="group" aria-label="Export format"></div>',
      '  <div class="export-label">Layers</div>',
      '  <div class="export-layers" id="export-layers"></div>',
      '  <div class="export-label">Options</div>',
      '  <label class="export-check"><input type="checkbox" id="export-pins" checked> Include story pins</label>',
      '  <label class="export-check" id="export-scale-row"><input type="checkbox" id="export-scale"> Double resolution</label>',
      '  <div class="export-estimate" id="export-estimate"></div>',
      '  <div class="export-progress" id="export-progress" hidden>',
      '    <div class="export-progress-bar"><span id="export-progress-fill"></span></div>',
      '    <span class="export-progress-text" id="export-progress-text">Working…</span>',
      '  </div>',
      '  <div class="export-error" id="export-error" hidden></div>',
      '</div>',
      '<div class="export-panel-foot">',
      '  <button type="button" class="export-btn export-btn-ghost" id="export-cancel">Cancel</button>',
      '  <button type="button" class="export-btn" id="export-go">Download</button>',
      '</div>',
      '</div>',
    ].join("");
    document.body.appendChild(el);
    state.el = el;
    return el;
  }

  // ── the layer list ──────────────────────────────────────────────────
  function renderLayers() {
    const host = document.getElementById("export-layers");
    if (!host || !reg()) return;
    host.innerHTML = "";
    const all = reg().list();
    if (!all.length) {
      host.innerHTML = '<div class="export-empty">No exportable layers yet.</div>';
      return;
    }
    for (const s of all) {
      const active = reg().isActive(s);
      const row = document.createElement("label");
      row.className = "export-layer" + (active ? "" : " is-inactive");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = s.id;
      cb.checked = state.selected.has(s.id);
      if (!active) {
        cb.disabled = true;
        cb.checked = false;
      }
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(s.id);
        else state.selected.delete(s.id);
        updateEstimate();
      });
      const name = document.createElement("span");
      name.className = "export-layer-name";
      name.textContent = s.label || s.id;
      const kind = document.createElement("span");
      kind.className = "export-layer-kind";
      kind.textContent = s.kind === "vector" ? "vector" : "data";
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(kind);
      host.appendChild(row);
    }
  }

  function renderFormats() {
    const host = document.getElementById("export-format");
    if (!host) return;
    host.innerHTML = "";
    for (const f of FORMATS) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.format = f.id;
      b.title = f.hint;
      b.textContent = f.label;
      if (state.format === f.id) b.classList.add("is-active");
      b.addEventListener("click", () => {
        state.format = f.id;
        renderFormats();
        updateEstimate();
      });
      host.appendChild(b);
    }
  }

  // ── the estimate ────────────────────────────────────────────────────
  function updateEstimate() {
    const host = document.getElementById("export-estimate");
    if (!host) return;
    const e = engine();
    if (!e) { host.textContent = ""; return; }
    const bbox = currentBbox();
    const raster = selectedSurfaces("raster");
    const vector = selectedSurfaces("vector");
    const bits = [];
    bits.push(bbox[0].toFixed(1) + "° … " + bbox[2].toFixed(1) + "°");
    bits.push(bbox[1].toFixed(1) + "° … " + bbox[3].toFixed(1) + "°");
    if (state.format === "png") {
      const dims = pngSize();
      bits.push(dims[0] + " × " + dims[1] + " px");
    } else if (state.format === "geotiff") {
      const s = raster[0];
      if (s) {
        const lat = e.latticeFor(s, bbox);
        bits.push(lat.width + " × " + lat.height + " cells");
        // Say so when the file is coarser than the source — the user
        // must not think they are getting the published resolution.
        if (lat.scaled && lat.deg) {
          bits.push("at " + lat.deg.toFixed(3) + "°");
        }
      }
    } else if (state.format === "csv") {
      // A CSV is ONE table. With a data layer selected it is that
      // layer's lon/lat/value table; otherwise it is the pins.
      if (raster.length === 1) {
        const lat = e.latticeFor(raster[0], bbox);
        bits.push(lat.width + " × " + lat.height + " cells → table");
      } else {
        bits.push(pins().length + " pins → table");
      }
    } else if (state.format === "geojson" || state.format === "kml") {
      bits.push(vector.length + " vector layer" + (vector.length === 1 ? "" : "s"));
    }
    host.textContent = bits.join(" · ");
  }

  function pngSize() {
    const e = engine();
    const bbox = currentBbox();
    let w, h;
    if (state.scope === "world") {
      w = 2048;
      h = 1024;
    } else {
      try {
        const m = engine().map();
        const size = m.getSize();
        w = size.x;
        h = size.y;
      } catch (_) {
        w = 1280;
        h = 800;
      }
    }
    if (state.scale === 2) { w *= 2; h *= 2; }
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  }

  function selectedSurfaces(kind) {
    const r = reg();
    if (!r) return [];
    return r.list(kind).filter((s) => state.selected.has(s.id));
  }

  // ── open / close ────────────────────────────────────────────────────
  function open() {
    if (!state.el) build();
    // Pre-select whatever the map is currently showing.
    const r = reg();
    state.selected.clear();
    if (r) {
      for (const s of r.list()) {
        if (r.isActive(s)) state.selected.add(s.id);
      }
    }
    state.open = true;
    state.el.style.display = "flex";
    renderFormats();
    renderLayers();
    updateEstimate();
    const err = document.getElementById("export-error");
    if (err) { err.hidden = true; err.textContent = ""; }
    try { wire(); } catch (_) {}
  }

  function close() {
    state.open = false;
    if (state.el) state.el.style.display = "none";
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    const el = state.el;

    el.querySelector(".export-panel-close").addEventListener("click", close);
    document.getElementById("export-cancel").addEventListener("click", close);

    el.querySelector("#export-scope").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-scope]");
      if (!b) return;
      state.scope = b.dataset.scope;
      el.querySelectorAll("#export-scope button").forEach((x) => {
        x.classList.toggle("is-active", x === b);
      });
      updateEstimate();
    });

    document.getElementById("export-pins").addEventListener("change", (ev) => {
      state.includePins = ev.target.checked;
      updateEstimate();
    });

    document.getElementById("export-scale").addEventListener("change", (ev) => {
      state.scale = ev.target.checked ? 2 : 1;
      updateEstimate();
    });

    document.getElementById("export-go").addEventListener("click", run);

    // Click outside the panel closes it.
    el.addEventListener("click", (ev) => {
      if (ev.target === el) close();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && state.open) close();
    });
  }

  // ── the export itself ───────────────────────────────────────────────
  function setProgress(frac, text) {
    const wrap = document.getElementById("export-progress");
    const fill = document.getElementById("export-progress-fill");
    const label = document.getElementById("export-progress-text");
    if (!wrap) return;
    wrap.hidden = false;
    if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + "%";
    if (label && text) label.textContent = text;
  }

  function hideProgress() {
    const wrap = document.getElementById("export-progress");
    if (wrap) wrap.hidden = true;
  }

  function showError(msg) {
    const err = document.getElementById("export-error");
    if (!err) return;
    err.hidden = false;
    err.textContent = msg;
  }

  async function run() {
    if (state.busy) return;
    const e = engine();
    if (!e) { showError("The export engine is not available."); return; }

    const go = document.getElementById("export-go");
    const bbox = currentBbox();
    const raster = selectedSurfaces("raster");
    const vector = selectedSurfaces("vector");
    const pinList = state.includePins ? pins() : [];

    state.busy = true;
    if (go) { go.disabled = true; go.textContent = "Working…"; }
    hideProgress();
    setProgress(0.02, "Preparing…");

    try {
      let result;
      const onProgress = (f) => setProgress(0.02 + f * 0.9, "Sampling the data…");

      if (state.format === "png") {
        if (!raster.length && !vector.length) throw new Error("Pick at least one layer to draw.");
        const dims = pngSize();
        result = await e.png({
          surfaces: raster.concat(vector),
          bbox: bbox,
          width: dims[0],
          height: dims[1],
          opacityFor: opacityFor,
          pins: pinList,
          includePins: state.includePins,
          legendTitle: legendTitle(),
          onProgress: onProgress,
        });
      } else if (state.format === "geotiff") {
        if (!raster.length) throw new Error("Pick at least one data layer to export.");
        result = await e.geoTIFF({
          surfaces: raster,
          bbox: bbox,
          onProgress: onProgress,
        });
      } else if (state.format === "geojson") {
        result = await e.geoJSON({
          surfaces: vector,
          bbox: bbox,
          pins: pinList,
          includePins: state.includePins,
        });
      } else if (state.format === "kml") {
        result = await e.kml({
          surfaces: vector,
          bbox: bbox,
          pins: pinList,
          includePins: state.includePins,
        });
      } else if (state.format === "csv") {
        if (raster.length === 1) {
          result = await e.csvRaster({
            surface: raster[0],
            bbox: bbox,
            onProgress: onProgress,
          });
        } else {
          result = e.csvPins({ pins: pinList });
        }
      } else {
        if (!raster.length && !vector.length && !pinList.length) {
          throw new Error("Pick at least one layer to export.");
        }
        result = await e.bundle({
          surfaces: raster.concat(vector),
          bbox: bbox,
          scope: state.scope === "world" ? "whole world" : "current view",
          pins: pinList,
          includePins: state.includePins,
          onProgress: onProgress,
        });
      }

      setProgress(1, "Writing the file…");
      e.download(result.blob, result.filename);
      log("export complete", result.filename, result.blob.size);
      close();
    } catch (err) {
      warn("export failed", err);
      showError((err && err.message) ? err.message : "The export failed.");
    } finally {
      state.busy = false;
      if (go) { go.disabled = false; go.textContent = "Download"; }
      hideProgress();
    }
  }

  function legendTitle() {
    const names = selectedSurfaces("raster").concat(selectedSurfaces("vector"))
      .map((s) => s.label || s.id);
    const scope = state.scope === "world" ? "Whole world" : "Current view";
    return "Xyzo · " + scope + (names.length ? " · " + names.join(" · ") : "");
  }

  // ── boot ────────────────────────────────────────────────────────────
  window.XYZO_EXPORT_PANEL = {
    open: open,
    close: close,
    isOpen: () => state.open,
    _state: state,
  };

  // The control menu's EXPORT button.
  function wireButton() {
    const btn = document.getElementById("ctrl-export-btn");
    if (!btn || btn._xyzoExportWired) return false;
    btn._xyzoExportWired = true;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      open();
    });
    return true;
  }

  function boot(attempt) {
    if (wireButton()) return;
    // The button is static markup, so it is there by DOMContentLoaded —
    // but app.js also builds the control menu, so give it a few tries
    // rather than assuming. Bounded: a retry loop that never ends is
    // a leak, not a safety net.
    const n = attempt || 0;
    if (n > 25) {
      warn("export panel: the EXPORT button never appeared");
      return;
    }
    setTimeout(() => boot(n + 1), 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    setTimeout(boot, 0);
  }
})();
