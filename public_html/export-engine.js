/* ═══════════════════════════════════════════════════════════════════════
   The export engine — turns the map into files.

   THE WHOLE POINT
   ───────────────
   Nothing here runs on the server. A "download the whole world as a
   GeoTIFF" request is answered by the user's own browser, off the
   user's own connection, at zero cost to the site. The site already
   publishes every dataset as a static file under /data/, so the engine
   only ever READS.

   WHAT IT DOES
   ────────────
     · rasterize()  — sample a surface onto a lat/lon lattice
     · geoTIFF()    — that lattice as a georeferenced raster
     · csvRaster()  — that lattice as lon/lat/value rows
     · geoJSON()    — the vector overlays as a FeatureCollection
     · kml()        — the vector overlays + the pins, for Google Earth
     · csvPins()    — the pins as a table
     · bundle()     — everything the user picked, as one ZIP
     · png()        — a composited picture of the map

   THE LICENCE RULE
   ────────────────
   Every export carries the attribution and licence of every dataset it
   contains. CC BY 4.0 requires attribution; CC BY-SA 4.0 (the FAO
   basins, Glottolog) makes the derivative share-alike. That is why
   every writer takes an `attribution` and a `licence`, and why the
   bundle always contains a licence file — see docs/DATA_LICENCES.md.

   THE PNG PATH
   ────────────
   The basemap is only drawn for the CURRENT VIEW. A world PNG made of
   third-party tiles would be a bulk download, which the OSM and Esri
   tile policies do not allow. A world PNG is therefore overlays-only —
   which also reads better as a data figure than a satellite photo with
   a wash on top of it.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const E = (window.XYZO_EXPORT_ENGINE = {});

  const W = () => window.XYZO_EXPORT_WRITERS;

  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }
  E.log = log;
  E.warn = warn;

  // ── geometry ────────────────────────────────────────────────────────
  E.WORLD_BBOX = [-180, -90, 180, 90];

  // Normalise a bbox into [west, south, east, north] with a sane
  // longitude span. Leaflet's bounds can run past ±180 when the world
  // is repeated, and a viewport can straddle the antimeridian (west >
  // east) — both are folded into a continuous box here.
  E.normalizeBBox = function normalizeBBox(bbox) {
    if (!bbox || bbox.length !== 4) return E.WORLD_BBOX.slice();
    let w = Number(bbox[0]);
    let s = Number(bbox[1]);
    let e = Number(bbox[2]);
    let n = Number(bbox[3]);
    if (![w, s, e, n].every((v) => Number.isFinite(v))) return E.WORLD_BBOX.slice();
    if (s > n) { const t = s; s = n; n = t; }
    s = Math.max(-90, Math.min(90, s));
    n = Math.max(-90, Math.min(90, n));
    // A span wider than the globe is the globe.
    if (e - w > 360) { w = -180; e = 180; }
    // A viewport that straddles the antimeridian arrives west > east.
    // The samplers wrap longitude, so a continuous box that runs past
    // 180 is correct and keeps the image from splitting.
    if (e < w) e += 360;
    return [w, s, e, n];
  };

  // The Leaflet map. app.js declares it as a top-level `const`, which
  // does NOT become a window property — but it publishes the same
  // instance as window._xyzoMap, which is what the exporter uses.
  E.map = function () {
    try {
      if (window._xyzoMap && typeof window._xyzoMap.getBounds === "function") {
        return window._xyzoMap;
      }
    } catch (_) {}
    return null;
  };

  // The bbox of the current map view, in EPSG:4326.
  E.bboxFromMap = function bboxFromMap(map) {
    const m = map || E.map();
    if (!m || typeof m.getBounds !== "function") return E.WORLD_BBOX.slice();
    try {
      const b = m.getBounds();
      return E.normalizeBBox([
        b.getWest(), b.getSouth(), b.getEast(), b.getNorth(),
      ]);
    } catch (_) {
      return E.WORLD_BBOX.slice();
    }
  };

  // ── the surfaces ────────────────────────────────────────────────────
  // Only the surfaces that are switched on AND have their data in
  // memory can be exported — exporting a layer that was never loaded
  // would mean fetching 18 MB for nothing.
  E.activeSurfaces = function activeSurfaces(kind) {
    const reg = window.XYZO_EXPORT;
    if (!reg) return [];
    return reg.list(kind).filter((s) => {
      if (!reg.isExportable(s)) return false;
      return reg.isActive(s);
    });
  };

  E.allSurfaces = function allSurfaces(kind) {
    const reg = window.XYZO_EXPORT;
    if (!reg) return [];
    return reg.list(kind);
  };

  // ── rasterising ─────────────────────────────────────────────────────

  // The cell budget for one raster band.
  //
  // A float32 band is four bytes a cell, and a browser tab is not a
  // workstation. The Köppen grid was rebuilt at 0.05° on 2026-10-29,
  // so a whole-world export of it is 7200 × 3600 = 26 M cells — 104 MB
  // for ONE band, before the temperature, the magnetic field and the
  // waves are added. That is not a download, that is a crash.
  //
  // Above the budget the lattice is scaled down and the effective
  // resolution is reported, so the user is told what they are getting
  // rather than silently handed a coarse file.
  E.MAX_CELLS = 12 * 1000 * 1000;

  // The budget actually in force on THIS device. A phone holds a
  // fraction of what a desktop does, so it gets a smaller file — the
  // layers are the same, the resolution is coarser, and the UI says
  // so.
  E.cellBudget = function cellBudget() {
    try {
      const w = (typeof window !== "undefined" && window.innerWidth) || 1440;
      if (w && w < 800) return Math.floor(E.MAX_CELLS / 4);
    } catch (_) {}
    return E.MAX_CELLS;
  };

  // The lattice size for a surface over a bbox: the surface's own
  // resolution, clipped to the bbox. A world export of the 1° GFS
  // temperature is 360×181; a world export of the 5' lightning grid is
  // 4320×2160.
  E.latticeFor = function latticeFor(surface, bbox, override) {
    const native = surface.native;
    const maxCells = (override && override.maxCells) || E.cellBudget();
    if (override && override.width && override.height) {
      return { width: override.width | 0, height: override.height | 0, scaled: false };
    }
    if (!native || !native.cols || !native.rows) {
      // No declared resolution: fall back to something sane for the
      // bbox at roughly one cell per degree.
      const w = Math.max(1, Math.round(bbox[2] - bbox[0]));
      const h = Math.max(1, Math.round(bbox[3] - bbox[1]));
      return { width: w, height: h, scaled: false };
    }
    const lonSpan = native.lonMax - native.lonMin;
    const latSpan = native.latMax - native.latMin;
    const fracW = (bbox[2] - bbox[0]) / lonSpan;
    const fracH = (bbox[3] - bbox[1]) / latSpan;
    let width = Math.max(1, Math.min(native.cols, Math.round(native.cols * fracW)));
    let height = Math.max(1, Math.min(native.rows, Math.round(native.rows * fracH)));

    // Over the budget? Scale both axes by the same factor, so the
    // cells stay square-ish and the georeferencing stays honest.
    let scaled = false;
    const cells = width * height;
    if (cells > maxCells) {
      const k = Math.sqrt(maxCells / cells);
      width = Math.max(1, Math.floor(width * k));
      height = Math.max(1, Math.floor(height * k));
      scaled = true;
    }
    return {
      width: width,
      height: height,
      scaled: scaled,
      // The effective degrees per cell, so the UI can say so.
      deg: scaled
        ? Math.max(
            ((bbox[2] - bbox[0]) / width),
            ((bbox[3] - bbox[1]) / height)
          )
        : null,
    };
  };

  /**
   * Sample a surface onto a lat/lon lattice.
   *
   * Returns { bands: [{ data: Float64Array, name, unit }], nodata }.
   * NaN in the data means "no value here" — the writer turns that into
   * the file's nodata sentinel.
   */
  E.rasterize = async function rasterize(surface, bbox, width, height, onProgress) {
    if (!surface || typeof surface.sample !== "function") {
      throw new Error("rasterize: surface has no sampler");
    }
    const nb = surface.bands && surface.bands.length ? surface.bands.length : 1;
    const bands = [];
    for (let b = 0; b < nb; b++) {
      bands.push({
        // NaN-initialised: a cell with no value must stay NaN. A
        // zero-filled array would export "no data" as a real 0 — and a
        // 0 °C or a 0 % cropland share is a lie, not a blank.
        data: new Float64Array(width * height).fill(NaN),
        name: (surface.bands && surface.bands[b] && surface.bands[b].name) || ("band" + (b + 1)),
        unit: (surface.bands && surface.bands[b] && surface.bands[b].unit) || surface.unit || "",
      });
    }
    const lonSpan = bbox[2] - bbox[0];
    const latSpan = bbox[3] - bbox[1];

    for (let r = 0; r < height; r++) {
      // Row 0 is the NORTHERNMOST row — the raster convention.
      const lat = bbox[3] - ((r + 0.5) / height) * latSpan;
      for (let c = 0; c < width; c++) {
        const lon = bbox[0] + ((c + 0.5) / width) * lonSpan;
        const v = surface.sample(lat, lon);
        const i = r * width + c;
        if (v == null) continue;
        if (Array.isArray(v)) {
          for (let b = 0; b < nb; b++) {
            const x = v[b];
            bands[b].data[i] = x == null || !Number.isFinite(x) ? NaN : x;
          }
        } else {
          bands[0].data[i] = Number.isFinite(v) ? v : NaN;
        }
      }
      if (onProgress && (r & 63) === 0) {
        try { onProgress(r / height); } catch (_) {}
        // Yield so the progress bar can paint.
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    if (onProgress) { try { onProgress(1); } catch (_) {} }
    return { bands: bands, nodata: NaN };
  };

  // ── the file makers ─────────────────────────────────────────────────

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      "-" + p(d.getHours()) + p(d.getMinutes());
  }
  E.stamp = stamp;

  function slug(s) {
    return String(s || "")
      // Emoji go; the letters stay. "Köppen Climate" must not become
      // "k-ppen-climate".
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "export";
  }
  E.slug = slug;

  // The attribution lines for a set of surfaces — one per dataset.
  E.attributionsFor = function attributionsFor(surfaces) {
    const out = [];
    const seen = new Set();
    for (const s of surfaces || []) {
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({
        name: s.label || s.id,
        attribution: s.attribution || "",
        licence: s.licence || "",
        source: s.source || "",
        period: s.period || "",
      });
    }
    return out;
  };

  // One line per dataset — the footer on a PNG, the credits in a KML.
  // Takes either surfaces or already-built source rows.
  E.creditsFor = function creditsFor(rows) {
    if (!rows || !rows.length) return "";
    return rows.map((r) => {
      const bits = [r.name];
      if (r.attribution) bits.push(r.attribution);
      if (r.licence) bits.push(r.licence);
      return bits.join(" · ");
    }).join("\n");
  };

  E.attributionText = function attributionText(surfaces) {
    return E.creditsFor(E.attributionsFor(surfaces));
  };

  /**
   * A GeoTIFF of one or more raster surfaces.
   * opts = { surfaces, bbox, width, height, onProgress }
   * → { blob, filename, sources }
   */
  E.geoTIFF = async function geoTIFF(opts) {
    const surfaces = (opts.surfaces || []).filter((s) => s.kind === "raster");
    if (!surfaces.length) throw new Error("Nothing to export — no data layer selected.");
    const bbox = E.normalizeBBox(opts.bbox || E.WORLD_BBOX);
    const writers = W();

    // One lattice size for every surface in the file, so the bands
    // line up. The finest native resolution wins — but the BUDGET is
    // over the whole file, not per surface: a GeoTIFF with four bands
    // of 12 M cells is 192 MB, and no browser should be asked for that.
    let width = 0, height = 0;
    let totalBands = 0;
    for (const s of surfaces) {
      totalBands += (s.bands && s.bands.length) ? s.bands.length : 1;
    }
    const budget = E.cellBudget();
    const perSurface = Math.max(1, Math.floor(budget / Math.max(1, totalBands)));
    for (const s of surfaces) {
      const lat = E.latticeFor(s, bbox, { maxCells: perSurface });
      width = Math.max(width, lat.width);
      height = Math.max(height, lat.height);
    }
    // The combined lattice may still be over budget (the finest surface
    // sets the size for all of them), so trim it here.
    const cells = width * height;
    if (cells * totalBands > budget) {
      const k = Math.sqrt(budget / (cells * totalBands));
      width = Math.max(1, Math.floor(width * k));
      height = Math.max(1, Math.floor(height * k));
    }

    const bands = [];
    for (const s of surfaces) {
      const r = await E.rasterize(s, bbox, width, height, opts.onProgress);
      for (const b of r.bands) {
        // The lattice is float64 while it is sampled and float32 in the
        // file, so narrow it as soon as it is sampled — holding every
        // band at 8 bytes a cell doubles the peak memory, and a
        // whole-world export of a dozen bands is where that bites.
        const f32 = new Float32Array(b.data.length);
        f32.set(b.data);
        bands.push({ data: f32, name: b.name, unit: b.unit });
      }
    }

    const dtype = "float32";
    const buf = writers.writeGeoTIFF({
      bands: bands.map((b) => ({ data: b.data, name: b.name, unit: b.unit })),
      width: width,
      height: height,
      bbox: bbox,
      dtype: dtype,
      // A float band carries NaN for "no value", and GDAL_NODATA says
      // so. A blank cell must never read as a real 0.
      nodata: "nan",
      description: "Xyzo map export — " + surfaces.map((s) => s.label).join(", ") +
        ". Cells are the layer's own field sampled at the cell centres; " +
        "the geotransform spans " + bbox.map((n) => n.toFixed(4)).join(", ") +
        " (EPSG:4326). NoData = NaN.",
      attribution: E.attributionText(surfaces),
      licence: surfaces.map((s) => s.licence).filter(Boolean).join("; "),
    });

    const name = "xyzo-" + slug(surfaces.map((s) => s.label).join("-")) + "-" + stamp() + ".tif";
    return {
      blob: new Blob([buf], { type: "image/tiff" }),
      filename: name,
      sources: E.attributionsFor(surfaces),
      bbox: bbox,
    };
  };

  /**
   * A CSV of one raster surface over a bbox.
   * opts = { surface, bbox, width, height, maxRows, onProgress }
   *
   * maxRows caps the TABLE, not the data: a whole-world CSV of the
   * 0.25° wave grid is a million rows and forty megabytes, which is
   * nobody's idea of a spreadsheet. The rows are thinned on a regular
   * stride — the lon/lat columns make the grid explicit, and the
   * GeoTIFF (which carries every cell) is the lossless product.
   */
  E.csvRaster = async function csvRaster(opts) {
    const surface = opts.surface;
    if (!surface || surface.kind !== "raster") throw new Error("No data layer selected.");
    const bbox = E.normalizeBBox(opts.bbox || E.WORLD_BBOX);
    const lat = E.latticeFor(surface, bbox, opts);
    const r = await E.rasterize(surface, bbox, lat.width, lat.height, opts.onProgress);
    const writers = W();

    const maxRows = opts.maxRows || 200000;
    const cells = lat.width * lat.height;
    const stride = Math.max(1, Math.ceil(Math.sqrt(cells / maxRows)));

    const multi = r.bands.length > 1;
    const columns = multi
      ? ["lon", "lat"].concat(r.bands.map((b) => b.name + (b.unit ? "_" + b.unit : "")))
      : ["lon", "lat", (r.bands[0].name || "value") + (r.bands[0].unit ? "_" + r.bands[0].unit : "")];

    const rows = [];
    for (let row = 0; row < lat.height; row += stride) {
      const y = bbox[3] - ((row + 0.5) / lat.height) * (bbox[3] - bbox[1]);
      for (let col = 0; col < lat.width; col += stride) {
        const x = bbox[0] + ((col + 0.5) / lat.width) * (bbox[2] - bbox[0]);
        const i = row * lat.width + col;
        const vals = r.bands.map((b) => {
          const v = b.data[i];
          return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : "";
        });
        rows.push(multi ? [x, y].concat(vals) : [x, y, vals[0]]);
      }
    }
    const csv = writers.writeCSV({ columns: columns, rows: rows });
    const name = "xyzo-" + slug(surface.label) + "-" + stamp() + ".csv";
    return {
      blob: new Blob([csv], { type: "text/csv" }),
      filename: name,
      sources: E.attributionsFor([surface]),
      bbox: bbox,
      rows: rows.length,
      stride: stride,
    };
  };

  // ── vector ──────────────────────────────────────────────────────────

  // Does a geometry touch the bbox? A cheap test: any coordinate inside
  // the box, or the box's corners inside a polygon.
  function geomTouchesBBox(geom, bbox) {
    if (!geom) return false;
    const [w, s, e, n] = bbox;
    const inside = (x, y) => x >= w && x <= e && y >= s && y <= n;
    let saw = false;
    const walk = (coords) => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number") {
        saw = true;
        if (inside(coords[0], coords[1])) return true;
        return false;
      }
      for (const c of coords) {
        if (walk(c)) return true;
      }
      return false;
    };
    if (geom.type === "Point") return inside(geom.coordinates[0], geom.coordinates[1]);
    if (geom.type === "LineString" || geom.type === "Polygon") {
      return walk(geom.coordinates);
    }
    if (geom.type === "MultiLineString" || geom.type === "MultiPolygon") {
      return walk(geom.coordinates);
    }
    if (geom.type === "GeometryCollection") {
      return (geom.geometries || []).some((g) => geomTouchesBBox(g, bbox));
    }
    return saw;
  }
  E.geomTouchesBBox = geomTouchesBBox;

  /**
   * The vector overlays (and optionally the pins) as a GeoJSON.
   * opts = { surfaces, bbox, pins, pinTitle }
   */
  E.geoJSON = async function geoJSON(opts) {
    const surfaces = (opts.surfaces || []).filter((s) => s.kind === "vector");
    const bbox = E.normalizeBBox(opts.bbox || E.WORLD_BBOX);
    const features = [];
    for (const s of surfaces) {
      if (typeof s.features !== "function") continue;
      let fc;
      try {
        fc = await s.features(bbox);
      } catch (err) {
        warn("export: " + s.id + " features failed", err);
        continue;
      }
      for (const f of (fc && fc.features) || []) {
        if (opts.clip !== false && !geomTouchesBBox(f.geometry, bbox)) continue;
        features.push(f);
      }
    }
    if (opts.includePins !== false) {
      for (const f of pinFeatures(opts.pins || [])) features.push(f);
    }
    if (!features.length) throw new Error("Nothing to export — no feature found in this area.");
    const writers = W();
    const sources = E.attributionsFor(surfaces);
    if (opts.includePins !== false && (opts.pins || []).length) {
      sources.push({ name: "Xyzo story pins", attribution: E.PIN_ATTRIBUTION, licence: "" });
    }
    const text = writers.writeGeoJSON({
      features: features,
      bbox: bbox,
      attribution: E.creditsFor(sources),
      licence: sources.map((s) => s.licence).filter(Boolean).join("; "),
      generator: "Xyzo map export",
      name: "xyzo-export",
    });
    return {
      blob: new Blob([text], { type: "application/geo+json" }),
      filename: "xyzo-" + slug(surfaces.map((s) => s.label).join("-") || "features") + "-" + stamp() + ".geojson",
      sources: sources,
      bbox: bbox,
      count: features.length,
    };
  };

  // ── pins ────────────────────────────────────────────────────────────

  // The pins on the map as GeoJSON features.
  function pinFeatures(pins) {
    const out = [];
    for (const p of pins || []) {
      const lat = Number(p.lat != null ? p.lat : p.location && p.location.lat);
      const lon = Number(p.lng != null ? p.lng : p.location && p.location.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat === 0 && lon === 0) continue;
      const props = {
        name: p.title || "",
        description: p.title || "",
        place_name: p.place_name || p.pn || "",
        source_type: p.source_type || "",
        category: p.category || p.c || "",
        published_at: p.published_at || "",
        canonical_url: p.canonical_url || p.u || "",
        source_count: Number(p.source_count || p.sc || 1),
        event_id: p.event_id || p.eid || "",
      };
      out.push({
        type: "Feature",
        properties: props,
        geometry: { type: "Point", coordinates: [lon, lat] },
      });
    }
    return out;
  }
  E.pinFeatures = pinFeatures;

  /**
   * The pins as a CSV table.
   */
  E.csvPins = function csvPins(opts) {
    const pins = opts.pins || [];
    const features = pinFeatures(pins);
    const writers = W();
    const columns = [
      "id", "title", "place_name", "category", "source_type",
      "lat", "lng", "published_at", "source_count", "event_id", "canonical_url",
    ];
    const objects = features.map((f) => {
      const p = f.properties;
      const src = pins.find((q) => q && (q.title || "") === p.name) || {};
      return {
        id: src.id != null ? src.id : "",
        title: p.name,
        place_name: p.place_name,
        category: p.category,
        source_type: p.source_type,
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        published_at: p.published_at,
        source_count: p.source_count,
        event_id: p.event_id,
        canonical_url: p.canonical_url,
      };
    });
    const csv = writers.writeCSV({ columns: columns, objects: objects });
    return {
      blob: new Blob([csv], { type: "text/csv" }),
      filename: "xyzo-pins-" + stamp() + ".csv",
      count: objects.length,
    };
  };

  /**
   * The vector overlays + the pins as KML for Google Earth.
   */
  E.kml = async function kml(opts) {
    const surfaces = (opts.surfaces || []).filter((s) => s.kind === "vector");
    const bbox = E.normalizeBBox(opts.bbox || E.WORLD_BBOX);
    const features = [];
    for (const s of surfaces) {
      if (typeof s.features !== "function") continue;
      let fc;
      try {
        fc = await s.features(bbox);
      } catch (err) {
        warn("export: " + s.id + " features failed", err);
        continue;
      }
      for (const f of (fc && fc.features) || []) {
        if (opts.clip !== false && !geomTouchesBBox(f.geometry, bbox)) continue;
        features.push(f);
      }
    }
    if (opts.includePins !== false) {
      features.push(...pinFeatures(opts.pins || []));
    }
    if (!features.length) throw new Error("Nothing to export — no feature found in this area.");
    const writers = W();
    const sources = E.attributionsFor(surfaces);
    if (opts.includePins !== false && (opts.pins || []).length) {
      sources.push({ name: "Xyzo story pins", attribution: E.PIN_ATTRIBUTION, licence: "" });
    }
    const credits = E.creditsFor(sources);
    const text = writers.writeKML({
      features: features,
      name: "Xyzo export " + stamp(),
      description: credits,
      attribution: credits,
    });
    return {
      blob: new Blob([text], { type: "application/vnd.google-earth.kml+xml" }),
      filename: "xyzo-" + slug(surfaces.map((s) => s.label).join("-") || "features") + "-" + stamp() + ".kml",
      sources: E.attributionsFor(surfaces),
      bbox: bbox,
      count: features.length,
    };
  };

  // ── the bundle ──────────────────────────────────────────────────────
  /**
   * Everything the user picked, as one ZIP: the data files, a README
   * and the licence text. The licence file is not optional — a
   * CC BY-SA derivative has to carry its ShareAlike terms.
   */
  E.bundle = async function bundle(opts) {
    const files = [];
    const csvNotes = [];
    const writers = W();
    const sources = [];
    const bbox = E.normalizeBBox(opts.bbox || E.WORLD_BBOX);
    const scopeName = opts.scope || "view";

    const rasterSurfaces = (opts.surfaces || []).filter((s) => s.kind === "raster");
    const vectorSurfaces = (opts.surfaces || []).filter((s) => s.kind === "vector");

    if (rasterSurfaces.length) {
      const tif = await E.geoTIFF({
        surfaces: rasterSurfaces,
        bbox: bbox,
        onProgress: opts.onProgress,
      });
      files.push({ name: "data/" + tif.filename, data: new Uint8Array(await tif.blob.arrayBuffer()) });
      sources.push(...tif.sources);
      // The same numbers as a table, for anyone without a GIS. The
      // table is thinned on a stride — the GeoTIFF above carries every
      // cell, so nothing is lost by giving the CSV a coarser grid.
      for (const s of rasterSurfaces) {
        const csv = await E.csvRaster({ surface: s, bbox: bbox });
        files.push({ name: "data/" + csv.filename, data: new Uint8Array(await csv.blob.arrayBuffer()) });
        csvNotes.push(
          "  " + csv.filename + " — " + csv.rows.toLocaleString() + " rows" +
          (csv.stride > 1 ? ", every " + csv.stride + " cells" : "")
        );
      }
    }

    if (vectorSurfaces.length) {
      const gj = await E.geoJSON({
        surfaces: vectorSurfaces,
        bbox: bbox,
        pins: opts.pins,
        includePins: opts.includePins !== false,
      });
      files.push({ name: "data/" + gj.filename, data: new Uint8Array(await gj.blob.arrayBuffer()) });
      sources.push(...gj.sources);
    }

    if (opts.includePins !== false && (opts.pins || []).length) {
      const pc = E.csvPins({ pins: opts.pins });
      files.push({ name: "data/" + pc.filename, data: new Uint8Array(await pc.blob.arrayBuffer()) });
    }

    if (!files.length) throw new Error("Nothing to export — nothing selected.");

    // The story pins are the site's own data, but the STORIES behind
    // them belong to their publishers — so the licence file says who
    // they are and where they came from. An export of pins that points
    // at other people's reporting must not look like the site's own.
    if (opts.includePins !== false && (opts.pins || []).length) {
      sources.push({
        name: "Xyzo story pins",
        attribution: "Story locations published by xyzo.org — the underlying reporting belongs to its publishers",
        licence: "Linked by reference; each pin carries its publisher's URL",
        source: "https://xyzo.org/",
        period: "",
      });
    }

    const licenceText = writers.writeAttributionText({
      generated: new Date().toISOString(),
      scope: scopeName,
      extent: bbox,
      sources: sources,
    });
    files.push({ name: "LICENSE.txt", data: licenceText });

    const readme = [
      "XYZO MAP EXPORT",
      "===============",
      "",
      "This archive was generated in your browser by xyzo.org.",
      "No server-side rendering was involved: every file here was",
      "computed on your machine from the published open datasets.",
      "",
      "GEOGRAPHY",
      "---------",
      "  CRS:     EPSG:4326 (WGS 84)",
      "  Extent:  " + bbox.map((n) => n.toFixed(4)).join(", ") +
        "  (west, south, east, north)",
      "  A raster cell is the layer's own field sampled at the cell",
      "  centre. NoData is NaN, and the GDAL_NODATA tag says so — a",
      "  blank cell is never a zero.",
      "",
      "CONTENTS",
      "--------",
    ];
    for (const f of files) readme.push("  " + f.name);
    readme.push("  README.md");
    if (csvNotes.length) {
      readme.push("");
      readme.push("THE TABLES");
      readme.push("-----------");
      readme.push("  The GeoTIFF carries EVERY cell. The CSV tables are the");
      readme.push("  same numbers thinned onto a regular grid, so they stay");
      readme.push("  openable in a spreadsheet.");
      for (const n of csvNotes) readme.push(n);
    }
    readme.push("");
    readme.push("See LICENSE.txt for the attribution and licence of every dataset.");
    readme.push("Map: https://xyzo.org/");
    files.push({ name: "README.md", data: readme.join("\n") + "\n" });

    // Deflated where the platform can: a whole-world GeoTIFF is mostly
    // zeroes, and stored it would be tens of megabytes.
    const zip = await writers.writeZIPAsync({ files: files });
    return {
      blob: new Blob([zip], { type: "application/zip" }),
      filename: "xyzo-" + slug(scopeName) + "-" + stamp() + ".zip",
      sources: sources,
      bbox: bbox,
      count: files.length,
    };
  };

  // ── the PNG ─────────────────────────────────────────────────────────

  // Web Mercator helpers, matching the map's own projection.
  function projectX(lon, width, bbox) {
    const span = bbox[2] - bbox[0];
    return ((lon - bbox[0]) / span) * width;
  }
  function projectY(lat, height, bbox) {
    const span = bbox[3] - bbox[1];
    return ((bbox[3] - lat) / span) * height;
  }

  /**
   * A composited picture of the map.
   *
   * opts = {
   *   surfaces, bbox, width, height,
   *   opacityFor(surface) -> 0..1,
   *   pins, includePins,
   *   background,
   *   legendTitle,
   *   onProgress,
   * }
   */
  E.png = async function png(opts) {
    const bbox = E.normalizeBBox(opts.bbox || E.WORLD_BBOX);
    const width = Math.max(1, Math.round(opts.width || 1600));
    const height = Math.max(1, Math.round(opts.height || 800));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.background || "#070b16";
    ctx.fillRect(0, 0, width, height);

    // ── the layers, in the map's pane order ────────────────────────
    //
    // The exported picture has to look like the screen. The map stacks
    // its panes by z-index — the Köppen wash at 350, the temperature
    // field at 355, the isobars at 360, the rivers at 365 — so the
    // export draws in the SAME order, whatever order the user ticked
    // the layers in. (Drawing the climate over the temperature, as the
    // tick order happened to be, produced a picture that disagreed
    // with the map it came from.)
    const all = (opts.surfaces || []).slice().sort((a, b) => {
      const az = (a && typeof a.z === "number") ? a.z : 0;
      const bz = (b && typeof b.z === "number") ? b.z : 0;
      return az - bz;
    });

    for (const s of all) {
      if (s.kind === "vector") {
        if (typeof s.features !== "function") continue;
        let fc;
        try {
          fc = await s.features(bbox);
        } catch (_) {
          continue;
        }
        const st = s.style || {};
        for (const f of (fc && fc.features) || []) {
          drawFeature(ctx, f, bbox, width, height, st, s);
        }
        continue;
      }

      if (typeof s.sample !== "function" || typeof s.color !== "function") continue;
      const opacity = opts.opacityFor ? opts.opacityFor(s) : 1;
      if (opacity <= 0) continue;
      const img = ctx.createImageData(width, height);
      const out = img.data;
      const latSpan = bbox[3] - bbox[1];
      const lonSpan = bbox[2] - bbox[0];
      for (let r = 0; r < height; r++) {
        const lat = bbox[3] - ((r + 0.5) / height) * latSpan;
        for (let c = 0; c < width; c++) {
          const lon = bbox[0] + ((c + 0.5) / width) * lonSpan;
          const v = s.sample(lat, lon);
          if (v == null) continue;
          const rgb = s.color(v);
          if (!rgb) continue;
          const a = typeof s.alpha === "function" ? s.alpha(v) : 255;
          const i = (r * width + c) * 4;
          out[i] = rgb[0];
          out[i + 1] = rgb[1];
          out[i + 2] = rgb[2];
          out[i + 3] = Math.round(a * opacity);
        }
      }
      // Composite the field over whatever is already there.
      const tmp = document.createElement("canvas");
      tmp.width = width;
      tmp.height = height;
      tmp.getContext("2d").putImageData(img, 0, 0);
      ctx.drawImage(tmp, 0, 0);
      if (opts.onProgress) { try { opts.onProgress(0.5); } catch (_) {} }
    }

    // ── the pins ───────────────────────────────────────────────────
    if (opts.includePins !== false && (opts.pins || []).length) {
      const r = Math.max(2, Math.round(Math.min(width, height) / 220));
      for (const p of pinFeatures(opts.pins || [])) {
        const x = projectX(p.geometry.coordinates[0], width, bbox);
        const y = projectY(p.geometry.coordinates[1], height, bbox);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fbbf24";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.65)";
        ctx.stroke();
      }
    }

    // ── the legend and the attribution footer ──────────────────────
    const footer = E.attributionText(opts.surfaces);
    if (footer) {
      const lines = footer.split("\n");
      const fs = Math.max(10, Math.round(Math.min(width, height) / 46));
      ctx.font = fs + "px system-ui, sans-serif";
      const lh = fs + 4;
      const pad = fs;
      const boxH = lines.length * lh + pad * 2;
      ctx.fillStyle = "rgba(4,7,15,0.78)";
      ctx.fillRect(0, height - boxH, width, boxH);
      ctx.fillStyle = "#e2e8f0";
      ctx.textBaseline = "top";
      lines.forEach((ln, i) => {
        ctx.fillText(ln, pad, height - boxH + pad + i * lh);
      });
    }
    if (opts.legendTitle) {
      const fs = Math.max(12, Math.round(Math.min(width, height) / 34));
      ctx.font = "600 " + fs + "px system-ui, sans-serif";
      const tw = ctx.measureText(opts.legendTitle).width;
      ctx.fillStyle = "rgba(4,7,15,0.78)";
      ctx.fillRect(0, 0, tw + fs * 2, fs * 2);
      ctx.fillStyle = "#f8fafc";
      ctx.textBaseline = "middle";
      ctx.fillText(opts.legendTitle, fs, fs);
    }

    const blob = await new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
      } else {
        reject(new Error("This browser cannot encode a PNG."));
      }
    });
    return {
      blob: blob,
      filename: "xyzo-" + slug(opts.legendTitle || "map") + "-" + stamp() + ".png",
      sources: E.attributionsFor(opts.surfaces),
      bbox: bbox,
    };
  };

  function drawFeature(ctx, f, bbox, width, height, st, surface) {
    const g = f.geometry;
    if (!g) return;
    const style = typeof st === "function" ? st(f) : st;
    ctx.save();
    ctx.strokeStyle = style.stroke || "none";
    ctx.fillStyle = style.fill || "none";
    ctx.lineWidth = style.width || 1;
    if (style.opacity != null) ctx.globalAlpha = style.opacity;
    if (g.type === "LineString" || g.type === "MultiLineString") {
      const lines = g.type === "LineString" ? [g.coordinates] : g.coordinates;
      for (const line of lines) {
        ctx.beginPath();
        line.forEach((c, i) => {
          const x = projectX(c[0], width, bbox);
          const y = projectY(c[1], height, bbox);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const poly of polys) {
        ctx.beginPath();
        poly.forEach((ring) => {
          ring.forEach((c, i) => {
            const x = projectX(c[0], width, bbox);
            const y = projectY(c[1], height, bbox);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        });
        ctx.fill();
        ctx.stroke();
      }
    } else if (g.type === "Point") {
      const r = style.radius || 3;
      const x = projectX(g.coordinates[0], width, bbox);
      const y = projectY(g.coordinates[1], height, bbox);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (style.stroke) ctx.stroke();
    }
    ctx.restore();
  }

  // ── the download ────────────────────────────────────────────────────

  /**
   * Hand a Blob to the user as a file.
   *
   * A Blob URL is revoked on the next tick — revoking it synchronously
   * races the browser's own fetch of the URL in some engines and the
   * download silently fails.
   */
  E.download = function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "xyzo-export";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    }, 4000);
  };

  // Everything the map currently shows, ready to export.
  E.snapshot = function snapshot() {
    const surfaces = E.allSurfaces();
    return {
      raster: surfaces.filter((s) => s.kind === "raster"),
      vector: surfaces.filter((s) => s.kind === "vector"),
      all: surfaces,
    };
  };
})();
