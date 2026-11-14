/* ═══════════════════════════════════════════════════════════════════════
   The export contract — how a map layer describes itself to the
   exporter.

   WHY THIS FILE EXISTS
   ────────────────────
   The map has 26 overlays and eight base layers. Every one of them is
   already a PUBLISHED data product under /data/ — a .bin grid with a
   meta.json, or a .geojson, or a PNG. The server never renders a map
   and it never will: the exporter is a READER, and everything it needs
   is either already in the browser's memory or one fetch() away.

   So there is no server-side export endpoint and no render queue. A user
   who wants the whole world as a GeoTIFF gets it computed in their own
   browser, off their own connection, at zero cost to the site.

   THE RULE
   ────────
   A layer exports ITSELF. It does not get re-implemented in the
   exporter, because a second implementation of a layer's ramp, its
   scale factor or its row order is a second source of truth — and the
   second source of truth is the one that drifts. The soil layer says
   so itself: "never a second data source, or the number under the
   cursor will eventually disagree with the colour."

   So each layer module registers a SURFACE: a small object that exposes
   its OWN sampler and its OWN colour ramp. The exporter calls them.
   The numbers in the exported file and the colours on the screen come
   from the same function.

   THE SURFACE
   ───────────
     {
       id:          "temperature",        // stable slug
       label:       "🌡️ Temperature (GFS)",// what the user sees
       kind:        "raster" | "vector",

       // ── licence obligations ────────────────────────────────────
       // Every export carries these. CC BY 4.0 requires attribution;
       // CC BY-SA 4.0 (the FAO basins, Glottolog) additionally makes
       // the derivative share-alike, so the licence text travels with
       // the file. See docs/DATA_LICENCES.md.
       attribution: "NOAA NCEP GFS",
       licence:     "US Government work (public domain)",
       source:      "https://…",           // optional, the paper/dataset

       // ── raster surfaces ────────────────────────────────────────
       bands: [{ name, unit }],            // 1 band = scalar, n = multiband
       // The layer's OWN sampler. Returns a number, an array of numbers
       // (one per band), or null for nodata.
       sample(lat, lon) -> number | number[] | null,
       // The layer's OWN colour for a sample. Returns [r,g,b] 0-255, or
       // null for "no colour" (nodata / transparent).
       color(sample) -> [r,g,b] | null,
       // Optional per-sample alpha 0-255 (the lightning wash uses one).
       alpha?(sample) -> 0..255,
       // The native lattice, so the exporter can offer "export at the
       // source resolution" and clip a world export to the extent.
       native?: { cols, rows, latMin, latMax, lonMin, lonMax },

       // ── vector surfaces ────────────────────────────────────────
       // Features in EPSG:4326, optionally clipped to the bbox.
       features?(bbox) -> Promise<FeatureCollection>,
     }

   A surface may be registered but INACTIVE (its layer is off, its data
   is not loaded). The exporter asks `isActive()` if the surface
   provides it, and the UI shows only the active ones by default.

   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // id -> surface
  const surfaces = new Map();

  function register(surface) {
    if (!surface || typeof surface !== "object") return null;
    const id = String(surface.id || "").trim();
    if (!id) return null;
    // Copy the properties, PRESERVING ACCESSORS.
    //
    // Object.assign() would EVALUATE every getter and copy the value
    // it happened to hold at registration time — and a surface
    // registers when its layer module LOADS, long before the grid has
    // arrived. So the unit, the attribution, the period and the grid
    // geometry would all be frozen at their empty defaults, and the
    // export would carry a blank unit and the wrong resolution.
    // defineProperty() with the original descriptor keeps the getter
    // live, so it is read at export time, when the data is in memory.
    const s = {};
    for (const key of Object.keys(surface)) {
      Object.defineProperty(s, key, Object.getOwnPropertyDescriptor(surface, key));
    }
    Object.defineProperty(s, "id", { value: id, enumerable: true, writable: false });
    surfaces.set(id, s);
    return s;
  }

  function unregister(id) {
    return surfaces.delete(id);
  }

  function get(id) {
    return surfaces.get(id) || null;
  }

  function has(id) {
    return surfaces.has(id);
  }

  // kind: "raster" | "vector" | undefined for all
  function list(kind) {
    const all = Array.from(surfaces.values());
    if (!kind) return all;
    return all.filter((s) => s.kind === kind);
  }

  // A surface is exportable when it exposes the shape its kind needs.
  function isExportable(surface) {
    if (!surface) return false;
    if (surface.kind === "vector") return typeof surface.features === "function";
    if (surface.kind === "raster") return typeof surface.sample === "function";
    return false;
  }

  // A surface is ACTIVE when its layer is switched on and its data is
  // in memory. The UI lists the active ones first.
  function isActive(surface) {
    if (!surface) return false;
    if (typeof surface.isActive === "function") {
      try {
        return !!surface.isActive();
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  // The attribution block that must accompany every export that uses
  // this surface. Returns [] when the surface carries no attribution —
  // which should never happen, because the licence test asserts it.
  function attributionFor(surface) {
    if (!surface) return [];
    const name = surface.label || surface.id;
    const parts = [];
    if (surface.attribution) parts.push(surface.attribution);
    else parts.push(name);
    const lic = surface.licence || "see docs/DATA_LICENCES.md";
    return [{ name: name, attribution: surface.attribution || "", licence: lic }];
  }

  // The native geometry of a grid, read from whatever shape the layer
  // publishes in its meta.json.
  //
  // WHY THIS EXISTS: a hard-coded extent is a silent bug waiting to
  // happen. The Köppen grid was rebuilt on 2026-10-29 at 0.05° — twice
  // the resolution it had been at 0.25° — and a surface that carried
  // `native: {cols: 1440, rows: 720}` would have gone on exporting a
  // quarter-resolution file from a quarter-million-sample grid, with
  // nothing to say so. The layer publishes its own geometry; the
  // exporter reads it.
  //
  // Three shapes are published across the site:
  //   1. an explicit bbox      {width, height, degrees, bbox:[w,s,e,n]}
  //   2. cols/rows + lat range {cols, rows, lat_min, lat_max, lon_min, …}
  //   3. width/height + degrees (the global 0.1° products)
  function nativeFromMeta(meta, fallback) {
    const fb = fallback || {};
    const g = (meta && (meta.grid || meta)) || {};

    // 1. An explicit bbox.
    if (Array.isArray(g.bbox) && g.bbox.length === 4) {
      return {
        cols: g.width || fb.cols,
        rows: g.height || fb.rows,
        latMin: g.bbox[1],
        latMax: g.bbox[3],
        lonMin: g.bbox[0],
        lonMax: g.bbox[2],
      };
    }

    // 2. cols/rows with a latitude range.
    if (g.cols && g.rows && g.lat_min != null && g.lat_max != null) {
      let lonMax = g.lon_max;
      if (lonMax == null && g.lon_min != null) {
        lonMax = g.lon_min + g.cols * (g.lon_step || 1);
      }
      return {
        cols: g.cols,
        rows: g.rows,
        latMin: g.lat_min,
        latMax: g.lat_max,
        lonMin: g.lon_min != null ? g.lon_min : (fb.lonMin || 0),
        lonMax: lonMax != null ? lonMax : (fb.lonMax || 360),
      };
    }

    // 3. width/height with a degree step — the global 0.1° products.
    if (g.width && g.height) {
      return {
        cols: g.width,
        rows: g.height,
        latMin: -90,
        latMax: 90,
        lonMin: -180,
        lonMax: 180,
      };
    }

    return fb;
  }

  window.XYZO_EXPORT = {
    register: register,
    unregister: unregister,
    get: get,
    has: has,
    list: list,
    isExportable: isExportable,
    isActive: isActive,
    attributionFor: attributionFor,
    nativeFromMeta: nativeFromMeta,
    // The contract version, so a stale export-contract.js in a cached
    // browser can be detected rather than silently mis-parsed.
    VERSION: 1,
  };

  // A tiny console logger that respects the site's no-console rule
  // (public_html/console-guard.js suppresses console.* outright).
  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  window.XYZO_EXPORT.log = log;
})();
