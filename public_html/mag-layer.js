/* ═══════════════════════════════════════════════════════════════════════
   Magnetic-field overlay for the Xyzo map — the World Magnetic Model.

   Source: NOAA NCEI / British Geological Survey, WMM2025 (valid
   2025.0–2030.0). US Government work, public domain. The field is
   computed offline by worker/magmap.py from the 3 KB coefficient file
   (vendored at worker/data/WMM2025.COF) and written as static files —
   there is no fetch cycle and no timer, because the field changes over
   years, not hours. NOAA publishes the same field as ready-made contour
   shapefiles (meta.shapefiles), but those are LINES with no grids; the
   wash and the probe need the grids, and running colour from one source
   and lines from another is how the two eventually disagree.

   worker/magmap.py writes under /data/mag/ — FOUR components × TWO
   modes = eight selectable fields:

     component  main field            secular variation (its /yr rate)
     ─────────  ────────────────────  ────────────────────────────────
     D          grid_d.bin            grid_ddot.bin   (′/yr)
     F          grid_f.bin            grid_fdot.bin   (nT/yr)
     H          grid_h.bin            grid_hdot.bin   (nT/yr)
     I          grid_i.bin            grid_idot.bin   (′/yr)

   plus one GeoJSON contour family per field (isogonics / isodynamics /
   isohorizontals / isoclinics for the mains, isoporics and
   isoporics-{i,f,h} for the rates), mask.bin and meta.json.

   meta.json is the contract: meta.fields[k] carries the file, the unit,
   the Int16 SCALE, the colour ramp and range, its component/mode,
   whether the blackout zone blanks it, its line set and the below-zoom-5
   label spacing. The selector, the wash, the probe, the legend and the
   globe all read that one table, so a field added there appears
   everywhere. meta.grid.scale (100) is only the DEFAULT for the four
   fields that shipped first — per-field scales are required because one
   scale cannot serve a ±180° angle and a 67,000 nT magnitude.

   The LINES are the hero — this is a magnetic chart, not a measurement
   readout. Each line set carries two ranks: INDEX (major) contours are
   the labelled, always-visible lines; INTERMEDIATE (minor) contours fill
   in between and are hidden below zoom 4 — the way a topographic map
   draws thin contours between its bold index contours. The optional
   colour WASH and the PROBE sit underneath for context, both reading the
   same plane so the number under the cursor IS the colour under the
   cursor. The wash is off by default.

   The wash ramps for every SIGNED field sweep violet → cyan → an ICE
   centre → gold → crimson: cool is negative, warm is positive, and zero
   — the meaningful state there (agonic, aclinic, "no change") — still
   GLOWS rather than vanishing into the basemap, just not in green any
   more. The old ramp flanked its neon-green plateau with a pale green
   and a yellow-green, so "green on both sides of zero" ran the chart
   (and the ΔD wash, whose plateau covers 52 % of the globe, made the
   whole thing a green ball). F and H are magnitudes with no meaningful
   zero in range, so those two take a sequential indigo → violet → rose
   → amber ramp: a diverging one would paint half of a one-sided field
   in a colour that means "negative".

   BLACKOUT: H < 2000 nT is where a compass needle stands vertical. Only
   D and ΔD lose their meaning there (ΔD divides by H²), so the mask is
   applied PER FIELD — F is at its strongest at the poles, H is merely
   small, I runs smoothly to ±90°, and blanketing those would delete the
   poles from exactly the charts that show them best.

   One layers-control entry ("🧭 Magnetic Field (WMM)") serves all eight
   fields through TWO selector rows — a component chip row (D / F / H / I)
   and a mode row (Main field / Change per year) — because eight
   checkboxes would drown the dropdown. The lines are a GeoJSON group
   (river-layer pattern) with the setOpacity/getOpacity shim the layers
   machinery calls; the wash is a custom L.GridLayer painted client-side
   into a baked Mercator canvas (temp-layer pattern).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/mag";
  const META_URL = BASE + "/meta.json";
  const PANE = "magPane";
  const PANE_Z = 358; // above climate (350), below isobars (360)
  const STORE_KEY = "xyzo.magLayer";
  const PROBE_STORE_KEY = "xyzo.magProbe";
  const WASH_STORE_KEY = "xyzo.magWash";
  const COMP_STORE_KEY = "xyzo.magComponent";
  const MODE_STORE_KEY = "xyzo.magMode";
  const LAYER_NAME = "🧭 Magnetic Field (WMM)";

  // ── the selector's two dimensions ────────────────────────────────────
  // Component first (D, F, H, I — the order the request named them in
  // and the order NCEI tabulates them), then mode. `main` / `sv` are the
  // two grid keys of that component.
  const COMPONENTS = {
    d: { key: "d", label: "Declination", short: "D", main: "d", sv: "ddot" },
    f: { key: "f", label: "Total force", short: "F", main: "f", sv: "fdot" },
    h: { key: "h", label: "Horizontal force", short: "H", main: "h", sv: "hdot" },
    i: { key: "i", label: "Inclination", short: "I", main: "i", sv: "idot" },
  };
  const COMPONENT_ORDER = ["d", "f", "h", "i"];
  const MODE_ORDER = ["main", "sv"];
  const MODES = {
    // The probe reads all FOUR values of whichever mode is active, in
    // this order — so the reading always opens with declination.
    main: { key: "main", label: "Main field", fields: ["d", "f", "h", "i"] },
    sv: { key: "sv", label: "Change per year", fields: ["ddot", "fdot", "hdot", "idot"] },
  };

  // Per-field display data. File names live here (not in meta) so an
  // old cached meta.json cannot 404 the browser on a renamed plane;
  // everything that can vary with the model — scale, ramp, range, line
  // spacing — comes from meta.fields[k] at runtime.
  const FIELDS = {
    d: { component: "d", mode: "main", label: "Declination", short: "D",
         unit: "°", gridFile: "grid_d.bin", lines: "isogonics.geojson", boz: true },
    f: { component: "f", mode: "main", label: "Total force", short: "F",
         unit: "nT", gridFile: "grid_f.bin", lines: "isodynamics.geojson", boz: false },
    h: { component: "h", mode: "main", label: "Horizontal force", short: "H",
         unit: "nT", gridFile: "grid_h.bin", lines: "isohorizontals.geojson", boz: false },
    i: { component: "i", mode: "main", label: "Inclination", short: "I",
         unit: "°", gridFile: "grid_i.bin", lines: "isoclinics.geojson", boz: false },
    ddot: { component: "d", mode: "sv", label: "Δ declination", short: "ΔD",
            unit: "′/yr", gridFile: "grid_ddot.bin", lines: "isoporics.geojson", boz: true },
    fdot: { component: "f", mode: "sv", label: "Δ total force", short: "ΔF",
            unit: "nT/yr", gridFile: "grid_fdot.bin", lines: "isoporics-f.geojson", boz: false },
    hdot: { component: "h", mode: "sv", label: "Δ horizontal", short: "ΔH",
            unit: "nT/yr", gridFile: "grid_hdot.bin", lines: "isoporics-h.geojson", boz: false },
    idot: { component: "i", mode: "sv", label: "Δ inclination", short: "ΔI",
            unit: "′/yr", gridFile: "grid_idot.bin", lines: "isoporics-i.geojson", boz: false },
  };

  const state = {
    map: null,
    lines: null,          // L.geoJSON FeatureGroup (the registered layer)
    washLayer: null,      // L.GridLayer, only while the wash is on
    enabled: false,
    probeMode: false,
    washOn: false,
    component: "d",
    mode: "main",
    meta: null,
    metaPromise: null,
    features: {},         // FIELD key -> FeatureCollection
    featurePromises: {},
    planes: {},           // FIELD key -> Int16Array
    planePromises: {},
    mask: null,
    maskPromise: null,
    labelsLayer: null,
    legendMounted: false,
    lastProbe: null,
    opacity: 0.9,
    bake: null,           // { canvas, W, H } for the active field
    bakeKey: null,
    lut: null,
    lutKey: null,
  };

  // ── helpers ──────────────────────────────────────────────────────────
  function log(...args) {
    if (window.XLog && typeof window.XLog.debug === "function") window.XLog.debug(...args);
  }
  function warn(...args) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn(...args);
  }
  function storageGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (_) {}
  }

  // ── the active field ─────────────────────────────────────────────────
  // One key drives the lines, the wash, the legend ramp and the export
  // colour: COMPONENTS[component][mode].
  function fieldKey() {
    const c = COMPONENTS[state.component] || COMPONENTS.d;
    return state.mode === "sv" ? c.sv : c.main;
  }

  function fieldDef(key) {
    return FIELDS[key || fieldKey()] || FIELDS.d;
  }

  function fieldsOfMode(mode) {
    return (MODES[mode] || MODES.main).fields;
  }

  // Per-field values come from meta.fields[k], falling back to the grid
  // default (100 — the scale the four original fields shipped with, and
  // the only scale an OLD cached meta.json knows about).
  function metaField(key) {
    return (state.meta && state.meta.fields && state.meta.fields[key]) || null;
  }

  function fieldScale(key) {
    const f = metaField(key);
    if (f && typeof f.scale === "number" && f.scale > 0) return f.scale;
    const g = state.meta && state.meta.grid;
    return (g && g.scale) || 100;
  }

  function fieldRange(key) {
    const f = metaField(key);
    return (f && Array.isArray(f.range) && f.range) || [-1, 1];
  }

  // The below-zoom-5 label spacing. 30° reproduces what the angle
  // fields shipped with; F and H need their own step because 50,000 is
  // not a multiple of 30 and would label nothing at all.
  function labelStep(key) {
    const f = metaField(key);
    return (f && typeof f.label_step === "number" && f.label_step) || 30;
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    if (state.metaPromise) return state.metaPromise;
    state.metaPromise = fetch(META_URL, { cache: "default" })
      .then((r) => {
        if (!r.ok) throw new Error("meta " + r.status);
        return r.json();
      })
      .then((meta) => {
        state.meta = meta;
        state.metaPromise = null;
        log("[mag] meta loaded", meta.model, "epoch", meta.epoch);
        return meta;
      })
      .catch((e) => {
        state.metaPromise = null;
        warn("[mag] meta failed", e);
        throw e;
      });
    return state.metaPromise;
  }

  function ensureFeatures(key) {
    if (state.features[key]) return Promise.resolve(state.features[key]);
    if (state.featurePromises[key]) return state.featurePromises[key];
    const def = FIELDS[key];
    if (!def) return Promise.reject(new Error("unknown field " + key));
    state.featurePromises[key] = fetch(BASE + "/" + def.lines, { cache: "default" })
      .then((r) => {
        if (!r.ok) throw new Error(def.lines + " " + r.status);
        return r.json();
      })
      .then((fc) => {
        state.features[key] = fc;
        state.featurePromises[key] = null;
        log("[mag]", def.lines, "loaded", (fc.features || []).length, "lines");
        return fc;
      })
      .catch((e) => {
        state.featurePromises[key] = null;
        warn("[mag] lines failed", e);
        throw e;
      });
    return state.featurePromises[key];
  }

  function ensureMask() {
    if (state.mask) return Promise.resolve(state.mask);
    if (!state.maskPromise) {
      state.maskPromise = fetch(BASE + "/mask.bin", { cache: "default" })
        .then((r) => {
          if (!r.ok) throw new Error("mask.bin " + r.status);
          return r.arrayBuffer();
        })
        .then((buf) => {
          state.mask = new Uint8Array(buf);
          state.maskPromise = null;
          return state.mask;
        })
        .catch((e) => {
          state.maskPromise = null;
          warn("[mag] mask failed", e);
          throw e;
        });
    }
    return state.maskPromise;
  }

  // ONE plane per field. The old loader read component PAIRS (a main
  // grid and its rate together), which only held while each component
  // had exactly two grids; with eight fields the plane is the unit.
  function ensureFieldGrid(key) {
    if (state.planes[key]) return Promise.resolve(state.planes[key]);
    if (state.planePromises[key]) return state.planePromises[key];
    const def = FIELDS[key];
    if (!def) return Promise.reject(new Error("unknown field " + key));
    state.planePromises[key] = ensureMeta()
      .then(() =>
        Promise.all([
          fetch(BASE + "/" + def.gridFile, { cache: "default" }).then((r) => {
            if (!r.ok) throw new Error(def.gridFile + " " + r.status);
            return r.arrayBuffer();
          }),
          // The mask is a NICE-TO-HAVE for this plane (only D and ΔD
          // blank), so a failed fetch degrades to "nothing masked" with
          // a logged warning instead of taking the whole field down.
          ensureMask().catch(() => null),
        ])
      )
      .then(([buf]) => {
        const arr = new Int16Array(buf);
        const g = state.meta && state.meta.grid;
        const expect = g ? g.rows * g.cols : 0;
        if (expect && arr.length !== expect) {
          throw new Error(
            "grid is " + arr.length + " values, expected " + expect
          );
        }
        state.planes[key] = arr;
        state.planePromises[key] = null;
        log("[mag]", def.gridFile, "loaded", arr.length, "values");
        return arr;
      })
      .catch((e) => {
        state.planePromises[key] = null;
        warn("[mag] grid failed", e);
        throw e;
      });
    return state.planePromises[key];
  }

  // The probe reads all FOUR values of whichever mode is active, so
  // load that mode's planes as a set — four ~127 KB files, the same
  // footprint the component-pair loader had. The other mode's planes
  // arrive on the first switch to it and then stay cached.
  function ensureMode(mode) {
    return ensureMeta().then(() =>
      Promise.all(fieldsOfMode(mode).map(ensureFieldGrid))
    );
  }

  function ensureData() {
    return ensureMeta().then(() =>
      Promise.all([ensureFeatures(fieldKey()), ensureMode(state.mode)]).then(
        () => state.meta
      )
    );
  }

  // Bilinear sample of a plane; longitude wraps, latitude clamps. Values
  // come back in REAL units (deg for D/I, nT for F/H, arcmin/yr for the
  // angle rates, nT/yr for the force rates) — the plane is divided by
  // ITS OWN field's scale, not the grid default, because one Int16 scale
  // cannot serve both a ±180° angle and a 67,000 nT magnitude.
  function samplePlane(plane, lat, lon, key) {
    const meta = state.meta;
    if (!plane || !meta) return null;
    const g = meta.grid;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let row = (lat - g.lat_min) / g.lat_step;
    row = Math.max(0, Math.min(g.rows - 1, row));
    const r0 = Math.floor(row);
    const r1 = Math.min(g.rows - 1, r0 + 1);
    const fr = row - r0;

    let col = (lon - g.lon_min) / g.lon_step;
    col = ((col % g.cols) + g.cols) % g.cols;
    const c0 = Math.floor(col);
    const c1 = (c0 + 1) % g.cols;
    const fc = col - c0;

    const at = (r, c) => plane[r * g.cols + c];
    const top = at(r0, c0) * (1 - fc) + at(r0, c1) * fc;
    const bot = at(r1, c0) * (1 - fc) + at(r1, c1) * fc;
    return (top * (1 - fr) + bot * fr) / fieldScale(key || fieldKey());
  }

  // Nearest-cell blackout test: 1 = compass unusable.
  function isMasked(lat, lon) {
    const meta = state.meta;
    if (!state.mask || !meta) return false;
    const g = meta.grid;
    let r = Math.round((lat - g.lat_min) / g.lat_step);
    let c = Math.round((lon - g.lon_min) / g.lon_step);
    if (r < 0 || r >= g.rows) return false;
    c = ((c % g.cols) + g.cols) % g.cols;
    return state.mask[r * g.cols + c] === 1;
  }

  // ── colour ────────────────────────────────────────────────────────────
  function rampColor(ramp, v) {
    const lo = ramp[0];
    const hi = ramp[ramp.length - 1];
    if (v <= lo.c) return hexToRgb(lo.rgb);
    if (v >= hi.c) return hexToRgb(hi.rgb);
    for (let i = 0; i < ramp.length - 1; i++) {
      const a = ramp[i];
      const b = ramp[i + 1];
      if (v >= a.c && v <= b.c) {
        const t = (v - a.c) / (b.c - a.c);
        const ca = hexToRgb(a.rgb);
        const cb = hexToRgb(b.rgb);
        return [
          Math.round(ca[0] + (cb[0] - ca[0]) * t),
          Math.round(ca[1] + (cb[1] - ca[1]) * t),
          Math.round(ca[2] + (cb[2] - ca[2]) * t),
        ];
      }
    }
    return hexToRgb(hi.rgb);
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // Colour + ALPHA lookup table, built once the meta arrives: one entry
  // per 1/1440 of the field's RANGE, so colouring a pixel is an index
  // into an array, not an interpolation — and the table stays ~1440
  // entries whatever the units. The old fixed 0.25° step was right for D
  // (360° ÷ 1440 = 0.25°) but would have allocated 180,001 entries for
  // F's 45,000 nT span.
  //
  // The ALPHA comes from field.alpha ({t, a} stops, t = ramp position),
  // the same contract the lightning meta publishes: zero means nothing
  // is happening, so the basemap shows through it. Without the table
  // (a stale meta.json) every entry takes 255 and the wash is the old
  // opaque sheet — a graceful fallback, not a break.
  function alphaAt(stops, t) {
    if (!stops || !stops.length) return 255;
    if (t <= stops[0].t) return stops[0].a;
    const last = stops[stops.length - 1];
    if (t >= last.t) return last.a;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t >= a.t && t <= b.t) {
        const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        return Math.round(a.a + (b.a - a.a) * f);
      }
    }
    return last.a;
  }

  function buildLut(meta, fieldKey) {
    const field = meta.fields[fieldKey];
    if (!field || !field.ramp) return null;
    const lo = field.range[0];
    const hi = field.range[1];
    const step = (hi - lo) / 1440 || 1;
    const n = Math.round((hi - lo) / step) + 1;
    const alphaStops = field.alpha || null;
    const lut = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const rgb = rampColor(field.ramp, lo + i * step);
      lut[i * 4] = rgb[0];
      lut[i * 4 + 1] = rgb[1];
      lut[i * 4 + 2] = rgb[2];
      lut[i * 4 + 3] = alphaAt(alphaStops, n > 1 ? i / (n - 1) : 0.5);
    }
    return { data: lut, lo: lo, step: step, n: n };
  }

  // ── the baked wash ────────────────────────────────────────────────────
  // Same trick as the temperature layer: paint the field ONCE into a
  // full-world canvas (rows linear in Mercator y, because these are Web
  // Mercator tiles), then every tile is a GPU blit of the right
  // sub-rectangle. Blackout cells are left transparent.
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  const BAKED_W = 1024;

  function ensureBaked() {
    const key = fieldKey();
    if (state.bake && state.bakeKey === key) return state.bake;
    const meta = state.meta;
    const plane = state.planes[key];
    if (!meta || !plane) return null;
    const def = FIELDS[key];
    if (state.lutKey !== key) {
      state.lut = buildLut(meta, key);
      state.lutKey = key;
    }
    const lut = state.lut;
    if (!lut) return null;

    const g = meta.grid;
    const W = BAKED_W;
    const H = BAKED_W;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const out = img.data;
    const invScale = 1 / fieldScale(key);
    const mask = state.mask;
    // Blackout applies ONLY to the fields that lose their meaning there
    // (D and ΔD) — see the module header. Blanketing F or H with it
    // would erase the two poles from exactly the charts that show them.
    const maskThis = !!(def && def.boz) && !!mask;

    for (let py = 0; py < H; py++) {
      const lat = tileLat((py + 0.5) / H);
      let row = (lat - g.lat_min) / g.lat_step;
      row = Math.max(0, Math.min(g.rows - 1, row));
      const r0 = Math.floor(row);
      const r1 = Math.min(g.rows - 1, r0 + 1);
      const fr = row - r0;
      const base0 = r0 * g.cols;
      const base1 = r1 * g.cols;
      const maskRow = mask ? r0 * g.cols : -1;

      const o = py * W * 4;
      for (let px = 0; px < W; px++) {
        const lon = -180 + (360 * (px + 0.5)) / W;
        let col = (lon - g.lon_min) / g.lon_step;
        col = ((col % g.cols) + g.cols) % g.cols;
        const c0 = Math.floor(col);
        const c1 = (c0 + 1) % g.cols;
        const fc = col - c0;
        const oi = o + px * 4;

        // Blackout: transparent, same blank the NOAA charts use.
        if (maskThis && mask[maskRow + c0] === 1) {
          out[oi + 3] = 0;
          continue;
        }

        const top = plane[base0 + c0] * (1 - fc) + plane[base0 + c1] * fc;
        const bot = plane[base1 + c0] * (1 - fc) + plane[base1 + c1] * fc;
        const val = (top * (1 - fr) + bot * fr) * invScale;

        const k = Math.max(0, Math.min(lut.n - 1, Math.round((val - lut.lo) / lut.step)));
        const li = k * 4;
        out[oi] = lut.data[li];
        out[oi + 1] = lut.data[li + 1];
        out[oi + 2] = lut.data[li + 2];
        // The ALPHA is what stops the wash painting over the basemap:
        // near zero it is ~40/255, so the satellite imagery (or whatever
        // is underneath) shows through the "nothing happening" zone.
        out[oi + 3] = lut.data[li + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    state.bake = { canvas: canvas, W: W, H: H };
    state.bakeKey = key;
    return state.bake;
  }

  function blitTile(ctx, coords, size) {
    const bake = state.bake;
    const n = 1 << coords.z;
    const sw = bake.W / n;
    const sh = bake.H / n;
    let sx = (coords.x / n) * bake.W;
    const sy = (coords.y / n) * bake.H;

    ctx.imageSmoothingEnabled = true;
    if (sx >= 0 && sx + sw <= bake.W) {
      ctx.drawImage(bake.canvas, sx, sy, sw, sh, 0, 0, size, size);
      return;
    }
    // Straddles (or is beyond) the world edge — wrap it.
    sx = ((sx % bake.W) + bake.W) % bake.W;
    if (sx + sw <= bake.W) {
      ctx.drawImage(bake.canvas, sx, sy, sw, sh, 0, 0, size, size);
    } else {
      const first = bake.W - sx;
      const dw = size * (first / sw);
      ctx.drawImage(bake.canvas, sx, sy, first, sh, 0, 0, dw, size);
      ctx.drawImage(bake.canvas, 0, sy, sw - first, sh, dw, 0, size - dw, size);
    }
  }

  function makeWashLayer() {
    if (!window.L) return null;
    const MagWash = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        const bake = ensureBaked();
        if (bake) blitTile(tile.getContext("2d"), coords, size.x);
        // ASYNC callback: Leaflet inserts the tile only after createTile
        // returns, and _tileReady marks a tile loaded only if it already
        // knows about it — a synchronous done() leaves tiles invisible.
        setTimeout(() => done(null, tile), 0);
        return tile;
      },
      // A bare GridLayer has no setOpacity; the layers machinery and the
      // legend slider both call it.
      setOpacity(value) {
        const v = Math.max(0, Math.min(1, Number(value)));
        if (!Number.isFinite(v)) return;
        this.options.opacity = v;
        if (this._container) this._container.style.opacity = String(v);
      },
      getOpacity() {
        return this.options.opacity;
      },
    });
    return new MagWash({
      pane: PANE,
      // Same default the temperature wash uses, and the same NUMBER the
      // opacity slider reads — one knob, one truth. addWashToMap()
      // pushes it onto the container after the layer is added.
      opacity: state.opacity,
      attribution: state.meta ? state.meta.attribution : "NOAA NCEI / BGS",
    });
  }

  // ── lines ─────────────────────────────────────────────────────────────
  // THE LINES ARE THE HERO (AGENTS.md) and they shipped INK-BLACK
  // (#111827) — invisible on the dark satellite basemap the site opens
  // on, and dull on the light ones. They now take their colour from
  // the field's OWN ramp at the line's own level: a −60° isogonic line
  // earns the violet-blue its value deserves, +60° earns the amber, and
  // the agonic / aclinic / no-change landmarks sit on the cyan zero
  // glow. The chart reads as a spectrum instead of pencil scratches,
  // and the colour agrees with the wash and the legend because all
  // three come from one ramp.
  //
  // The lift toward WHITE is load-bearing: with the wash ON, a line at
  // level L sits on a wash of ≈ ramp(L) — the SAME colour — so an
  // unlifted line vanishes into its own wash. A 35 % lift keeps the hue
  // and makes the line a lighter tint of the band it crosses, the way a
  // contour reads on a filled topo map. It also makes the lines glow on
  // the dark satellite default. Specials lift less (20 %): they are the
  // landmarks and should stay the most saturated thing on screen.
  function liftTowardWhite(rgb, f) {
    return [
      Math.round(rgb[0] + (255 - rgb[0]) * f),
      Math.round(rgb[1] + (255 - rgb[1]) * f),
      Math.round(rgb[2] + (255 - rgb[2]) * f),
    ];
  }

  function lineColorFor(level, lift) {
    const field = state.meta && state.meta.fields && state.meta.fields[fieldKey()];
    if (!field || !field.ramp || !Number.isFinite(level)) return "#111827";
    const rgb = liftTowardWhite(rampColor(field.ramp, level), lift);
    return "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
  }

  function styleFor(feature) {
    const p = (feature && feature.properties) || {};
    const special = p.special;
    const minor = p.major === false;
    const zoom = state.map ? state.map.getZoom() : 3;
    // Three ranks: the agonic / aclinic / no-change landmarks (thickest
    // and brightest), the index contours every 10°, and the intermediate
    // 2° fill-in lines. Minors are hidden below zoom 4 — at world view
    // they turn the chart into a hairball, the way a topo map only draws
    // its thin contours once you are zoomed into a quadrangle.
    if (minor && zoom < 4) {
      return { color: "#111827", weight: 0, opacity: 0, interactive: false };
    }
    const base = {
      color: lineColorFor(Number(p.level), special ? 0.2 : 0.35),
      weight: special ? 2.6 : minor ? 0.6 : 1.2,
      opacity: (special ? 1 : minor ? 0.5 : 0.8) * state.opacity,
      interactive: false,
    };
    if (!special && !minor && zoom < 3) base.opacity *= 0.6;
    return base;
  }

  function restyle() {
    if (!state.lines) return;
    state.lines.eachLayer((ly) => {
      const ft = ly.feature;
      if (!ft) return;
      if (typeof ly.setStyle === "function") ly.setStyle(styleFor(ft));
    });
  }

  function fillLines() {
    if (!state.lines) return;
    // Only the ACTIVE field's family is on the map — the same one-at-a-
    // time rule the selector implies, and one GeoJSON fetch instead of
    // eight. (The globe follows the same rule for the same reason.)
    const fc = state.features[fieldKey()];
    state.lines.clearLayers();
    if (fc) state.lines.addData(fc);
    restyle();
  }

  // ── labels ────────────────────────────────────────────────────────────
  // One label per line, at a vertex a third along the longest segment so
  // the callout is not stuck on an end. Only lines whose |level| is a
  // multiple of 30 are labelled below zoom 5 (the chart would drown
  // otherwise); the agonic / aclinic lines always are.
  function anchorOf(feature) {
    const geom = feature.geometry;
    if (!geom) return null;
    let line = null;
    if (geom.type === "LineString") line = geom.coordinates;
    else if (geom.type === "MultiLineString" && geom.coordinates && geom.coordinates.length) {
      line = geom.coordinates.reduce((a, b) => (b.length > a.length ? b : a), geom.coordinates[0]);
    }
    if (!line || line.length < 2) return null;
    const i = Math.floor(line.length / 3);
    const pt = line[i] || line[0];
    return [pt[1], pt[0]]; // Leaflet wants [lat, lng]
  }

  function labelFor(feature) {
    const p = (feature && feature.properties) || {};
    if (p.label) return p.label;
    const lvl = p.level;
    if (lvl == null) return null;
    if (p.kind === "isogonic") {
      if (Math.abs(lvl) < 1e-9) return "Agonic";
      return Math.abs(lvl) + "°" + (lvl > 0 ? "E" : "W");
    }
    if (p.kind === "isoporic") {
      if (Math.abs(lvl) < 1e-9) return "No change";
      return (lvl > 0 ? "+" : "−") + Math.abs(lvl) + "°/yr";
    }
    // The force families: levels are nanoteslas, not degrees. The
    // worker always writes `label`, so this is only the fallback path
    // for a file from before it did — but a "50000°" on an isodynamic
    // line is worse than no label at all.
    if (p.kind === "isodynamic" || p.kind === "isohorizontal") {
      return Number(lvl).toLocaleString("en-US") + " nT";
    }
    if (Math.abs(lvl) < 1e-9) return "Aclinic";
    return lvl + "°";
  }

  function updateLabels(zoom) {
    if (!state.map || !state.lines) return;
    if (!state.labelsLayer) {
      state.labelsLayer = L.layerGroup();
      if (state.enabled) state.labelsLayer.addTo(state.map);
    }
    state.labelsLayer.clearLayers();
    if (!state.enabled || zoom < 3) return;
    const maxLabels = 30;
    let placed = 0;
    state.lines.eachLayer((ly) => {
      if (placed >= maxLabels) return;
      const ft = ly.feature;
      if (!ft) return;
      const p = ft.properties || {};
      const lvl = p.level || 0;
      const special = !!p.special;
      // Intermediate (minor) contours are never labelled — they are the
      // thin fill-in lines, and their values sit halfway between two
      // index lines the reader can already interpolate from.
      if (p.major === false) return;
      // Below zoom 5 only every `labelStep` level is named, plus the
      // agonic / aclinic / no-change landmarks. The step comes from the
      // FIELD: 30° for D/I (what they shipped with), 5,000 nT for F and
      // H, 50 nT/yr for the force rates. A single hardcoded 30 would
      // label nothing at all on a 23,000…67,000 nT field, because no
      // level there is a multiple of 30.
      if (zoom < 5 && !special && Math.abs(lvl % labelStep()) > 1e-6) return;
      const label = labelFor(ft);
      if (!label) return;
      const anchor = anchorOf(ft);
      if (!anchor) return;
      L.tooltip({
        permanent: true,
        direction: "center",
        className: "mag-label" + (special ? " mag-label-special" : ""),
        opacity: 0.95,
      })
        .setContent(label)
        .setLatLng(anchor)
        .addTo(state.labelsLayer);
      placed++;
    });
  }

  // ── the registered overlay layer ──────────────────────────────────────
  function buildLines() {
    if (!window.L) return null;
    if (state.map) ensurePane(state.map);
    const group = L.geoJSON(null, {
      pane: PANE,
      style: (ft) => styleFor(ft),
      interactive: false,
    });
    return group;
  }

  function ensurePane(map) {
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }
  }

  function getTileLayer() {
    // The layers control accepts any Layer — but OverlayOpacity.mount
    // calls setOpacity() on every entry in WEATHER_OVERLAYS, and a raw
    // L.geoJSON has no such method. Attach the pair so the group
    // satisfies the same contract as a TileLayer.
    if (!state.lines) {
      state.lines = buildLines();
      state.lines.setOpacity = (v) => setOpacity(v);
      state.lines.getOpacity = () => getOpacity();
    }
    return state.lines;
  }

  // ── wash on / off ─────────────────────────────────────────────────────
  // Put the wash on the map (creating it first if needed) and make sure
  // it renders at the SLIDER's value. A GridLayer does not apply its
  // `opacity` option to the container the way TileLayer does, so the
  // option alone can leave it at 1.0 while the slider reads something
  // else — always push it through setOpacity() after adding.
  function addWashToMap() {
    if (!state.map) return;
    if (!state.washLayer) state.washLayer = makeWashLayer();
    if (state.map.hasLayer(state.washLayer)) return;
    // Under the lines: both live in the same pane, so add order decides
    // stacking — wash first, lines on top.
    state.washLayer.addTo(state.map);
    state.washLayer.setOpacity(state.opacity);
  }

  function setWash(on) {
    state.washOn = !!on;
    storageSet(WASH_STORE_KEY, state.washOn ? "1" : "0");
    if (!state.map) return;
    if (state.washOn && state.enabled) {
      ensureData()
        .then(() => {
          addWashToMap();
          refreshWashToggle();
        })
        .catch(() => {});
    } else if (state.washLayer && state.map.hasLayer(state.washLayer)) {
      state.map.removeLayer(state.washLayer);
      refreshWashToggle();
    }
  }

  // ── enable / disable ──────────────────────────────────────────────────
  function onLayerToggled(on) {
    state.enabled = !!on;
    storageSet(STORE_KEY, state.enabled ? "1" : "0");
    if (state.enabled) {
      ensureData()
        .then(() => {
          fillLines();
          if (state.labelsLayer && state.map) state.labelsLayer.addTo(state.map);
          if (state.map) updateLabels(state.map.getZoom());
          if (state.washOn) setWash(true);
        })
        .catch(() => {});
    } else {
      if (state.labelsLayer && state.map && state.map.hasLayer(state.labelsLayer)) {
        state.map.removeLayer(state.labelsLayer);
      }
      if (state.washLayer && state.map && state.map.hasLayer(state.washLayer)) {
        state.map.removeLayer(state.washLayer);
      }
      hideProbe();
    }
    applyVisibility();
    notifyChange();
  }

  function setEnabled(on) {
    const want = !!on;
    if (!state.lines) state.lines = getTileLayer();
    if (!state.lines || !state.map) return Promise.resolve(false);
    if (want) {
      if (!state.map.hasLayer(state.lines)) state.lines.addTo(state.map);
    } else if (state.map.hasLayer(state.lines)) {
      state.map.removeLayer(state.lines);
    }
    onLayerToggled(state.map.hasLayer(state.lines));
    return Promise.resolve(state.enabled);
  }

  function setOpacity(v) {
    state.opacity = Math.max(0, Math.min(1, Number(v) || 0));
    if (!state.map) return;
    // ONE knob, BOTH halves. This is what the layers-control opacity
    // slider calls, and it used to restyle the contour lines only —
    // while the colour wash, the visually dominant half, stayed pinned
    // at its creation value. With the wash on, dragging the whole slider
    // moved the picture from mean luminance 190.5 to 190.8: nothing.
    // The globe already drove both halves; the flat map now does too.
    if (state.enabled) restyle();
    if (state.washLayer && state.map.hasLayer(state.washLayer)) {
      state.washLayer.setOpacity(state.opacity);
    }
  }

  function getOpacity() {
    return state.opacity;
  }

  function notifyChange() {
    try {
      if (typeof window.updateUrlHash === "function") window.updateUrlHash();
    } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("xyzo:mag-change", { detail: { enabled: state.enabled } }));
    } catch (_) {}
  }

  // ── field switch ──────────────────────────────────────────────────────
  // Switching the COMPONENT, the MODE, or both runs one reload: a new
  // line family, a new plane for the wash, a new ramp for the legend —
  // and the wash's bake has to be dropped or it keeps painting the old
  // field.
  function setView(component, mode) {
    const wantComp = COMPONENTS[component] ? component : state.component;
    const wantMode = MODES[mode] ? mode : state.mode;
    if (wantComp === state.component && wantMode === state.mode) return;
    state.component = wantComp;
    state.mode = wantMode;
    storageSet(COMP_STORE_KEY, wantComp);
    storageSet(MODE_STORE_KEY, wantMode);
    state.bake = null;
    state.bakeKey = null;
    state.lut = null;
    state.lutKey = null;
    if (state.enabled) {
      ensureData()
        .then(() => {
          fillLines();
          if (state.map) updateLabels(state.map.getZoom());
          // Re-create the wash layer for the new field's bake, at the
          // slider's opacity (the bake is per-field, so the layer goes).
          if (state.washOn && state.washLayer && state.map && state.map.hasLayer(state.washLayer)) {
            state.map.removeLayer(state.washLayer);
            state.washLayer = null;
            addWashToMap();
          }
        })
        .catch(() => {});
    }
    refreshSelector();
    refreshRamp();
    refreshProbeToggle();
    hideProbe();
  }

  function setComponent(key) {
    setView(key, state.mode);
  }

  function setMode(mode) {
    setView(state.component, mode);
  }

  // ── legend ────────────────────────────────────────────────────────────
  function gradient(meta, fieldKey) {
    const field = meta.fields[fieldKey];
    if (!field || !field.ramp) return "";
    const span = field.range[1] - field.range[0];
    const stops = field.ramp
      .map((r) => {
        const t = (r.c - field.range[0]) / span;
        // The bar shows what the WASH paints, alpha included — the
        // zero core is nearly clear and the wings solid. Same honesty
        // the lightning legend offers; an opaque bar would promise a
        // sheet the map does not draw.
        const a = (alphaAt(field.alpha, t) / 255).toFixed(3);
        const hex = parseInt(r.rgb.slice(1), 16);
        return (
          "rgba(" + ((hex >> 16) & 255) + "," + ((hex >> 8) & 255) + "," +
          (hex & 255) + "," + a + ") " +
          (((r.c - field.range[0]) / span) * 100).toFixed(2) + "%"
        );
      })
      .join(", ");
    return "linear-gradient(to right, " + stops + ")";
  }

  function mountLegend() {
    if (state.legendMounted) return true;
    const section = document.querySelector(".leaflet-control-layers-list");
    if (!section) return false;

    const old = document.getElementById("mag-legend");
    if (old) old.remove();

    // Built from the tables, not from a hand-written list: a component
    // or mode added there appears here without a second edit (and
    // cannot be forgotten, which is how the isoporics went missing from
    // the globe for a day).
    const compChips = COMPONENT_ORDER.map((c) =>
      '<button type="button" class="soil-prop-btn" data-comp="' + c +
      '" aria-pressed="false" title="' + COMPONENTS[c].label + '">' +
      COMPONENTS[c].label + "</button>"
    ).join("");
    const modeChips = MODE_ORDER.map((m) =>
      '<button type="button" class="soil-prop-btn" data-mode="' + m +
      '" aria-pressed="false" title="' + MODES[m].label + '">' +
      MODES[m].label + "</button>"
    ).join("");

    const host = document.createElement("div");
    host.id = "mag-legend";
    host.className = "temp-legend leaflet-control-layers-temp";
    host.innerHTML =
      '<div class="temp-legend-title"><span>Magnetic Field</span>' +
      '<button type="button" class="temp-probe-toggle" id="ctrl-mag-probe-toggle" ' +
      'aria-pressed="false" title="Tap the map to read the field">Probe</button></div>' +
      '<div class="mag-switch-label">Component</div>' +
      '<div class="soil-prop-switch" id="mag-comp-switch" role="group" aria-label="Magnetic component">' +
      compChips + "</div>" +
      '<div class="mag-switch-label">Value</div>' +
      '<div class="soil-prop-switch" id="mag-mode-switch" role="group" aria-label="Field value">' +
      modeChips + "</div>" +
      '<label class="mag-wash-row"><input type="checkbox" id="ctrl-mag-wash-toggle"> Colour wash</label>' +
      '<div class="temp-legend-scale">' +
      '<div class="temp-legend-bar" id="mag-legend-bar"></div>' +
      '<div class="temp-legend-row" id="mag-ticks"></div>' +
      "</div>" +
      '<div class="mag-unit-caption" id="mag-legend-unit"></div>' +
      '<div class="temp-legend-detail" id="mag-legend-detail"></div>' +
      '<div class="temp-legend-foot" id="mag-legend-foot"></div>';
    section.appendChild(host);
    state.legendMounted = true;

    host.querySelectorAll("#mag-comp-switch .soil-prop-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        setComponent(btn.getAttribute("data-comp"));
      });
    });
    host.querySelectorAll("#mag-mode-switch .soil-prop-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        setMode(btn.getAttribute("data-mode"));
      });
    });

    const probeBtn = host.querySelector("#ctrl-mag-probe-toggle");
    if (probeBtn) {
      probeBtn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        state.probeMode = !state.probeMode;
        storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
        if (!state.probeMode) hideProbe();
        refreshProbeToggle();
      });
    }

    const washBtn = host.querySelector("#ctrl-mag-wash-toggle");
    if (washBtn) {
      washBtn.addEventListener("change", () => setWash(washBtn.checked));
    }

    refreshSelector();
    refreshWashToggle();
    refreshProbeToggle();
    ensureMeta()
      .then((meta) => {
        refreshRamp(meta);
        const foot = document.getElementById("mag-legend-foot");
        if (foot && meta.model) {
          foot.textContent =
            meta.attribution + " · " + meta.model + " · valid " +
            meta.epoch + "–" + (meta.epoch + 5);
        }
      })
      .catch(() => {});
    return true;
  }

  // Both selector rows, in one refresh: the two dimensions are one
  // choice really, and two functions that can disagree about which chip
  // is lit is two chances to ship a legend that lies.
  function refreshSelector() {
    document.querySelectorAll("#mag-comp-switch .soil-prop-btn").forEach((btn) => {
      const on = btn.getAttribute("data-comp") === state.component;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll("#mag-mode-switch .soil-prop-btn").forEach((btn) => {
      const on = btn.getAttribute("data-mode") === state.mode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function refreshWashToggle() {
    const btn = document.getElementById("ctrl-mag-wash-toggle");
    if (btn) btn.checked = state.washOn;
  }

  function refreshRamp(metaIn) {
    const meta = metaIn || state.meta;
    const bar = document.getElementById("mag-legend-bar");
    if (!meta || !bar) return;
    const key = fieldKey();
    const field = meta.fields[key];
    if (!field || !field.range) return;
    bar.style.backgroundImage = gradient(meta, key);

    // The caption under the bar: which value the colours are for and in
    // what unit. It changes with the selector, so it cannot be part of
    // the markup — "22,000 … 67,000" means nothing until you know it is
    // nanoteslas, and "−180 … 180" nothing until you know it is degrees.
    const unitRow = document.getElementById("mag-legend-unit");
    if (unitRow) {
      const def = fieldDef(key);
      unitRow.textContent =
        (state.mode === "sv" ? "Rate of change — " : "") +
        def.label + " (" + (field.unit || def.unit || "") + ")";
    }

    const row = document.getElementById("mag-ticks");
    if (!row) return;
    row.innerHTML = "";
    const [lo, hi] = fieldRange(key);
    // Three ticks, always inside the bar. A signed range keeps the
    // landmark in the middle (0 = agonic / aclinic / "no change"); a
    // magnitude range never contains zero, and emitting `0` for it puts
    // a label at −14 % hanging off the left edge — so its middle tick is
    // the midpoint rounded to a 1-2-5 step.
    const ticks = lo < 0 && hi > 0 ? [lo, 0, hi] : [lo, roundNice((lo + hi) / 2, hi - lo), hi];
    for (const t of ticks) {
      if (t < lo || t > hi) continue;
      const pct = (((t - lo) / (hi - lo)) * 100).toFixed(3) + "%";
      const s = document.createElement("span");
      s.className = "temp-legend-tick";
      s.style.left = pct;
      s.textContent = Number(t).toLocaleString("en-US", { maximumFractionDigits: 2 });
      row.appendChild(s);
    }
  }

  // Round v to the nearest 1-2-5 step of ~span/10, so a midpoint lands
  // on 45,000 rather than 44,500.
  function roundNice(v, span) {
    const raw = Math.abs(span) / 10;
    if (!isFinite(raw) || raw <= 0) return v;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
    return Math.round(v / step) * step;
  }

  function waitForLayersControl() {
    if (mountLegend()) return;
    let tries = 0;
    const tick = () => {
      if (mountLegend() || ++tries > 40) return;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  function applyVisibility() {
    const probeBtn = document.getElementById("ctrl-mag-probe-toggle");
    if (probeBtn) {
      probeBtn.disabled = !state.enabled;
      probeBtn.style.opacity = state.enabled ? "" : "0.45";
    }
    const washBtn = document.getElementById("ctrl-mag-wash-toggle");
    if (washBtn) washBtn.disabled = !state.enabled;
    if (!state.enabled) hideProbe();
  }

  function refreshProbeToggle() {
    const btn = document.getElementById("ctrl-mag-probe-toggle");
    if (!btn) return;
    btn.classList.toggle("active", state.probeMode);
    btn.textContent = state.probeMode ? "Probe: On" : "Probe";
    btn.setAttribute("aria-pressed", state.probeMode ? "true" : "false");
  }

  // ── probe ─────────────────────────────────────────────────────────────
  function fmtDegMin(deg, hemiPos, hemiNeg) {
    const sign = deg < 0 ? -1 : 1;
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = Math.round((abs - d) * 60);
    const dd = m === 60 ? d + 1 : d;
    const mm = m === 60 ? 0 : m;
    return dd + "°" + String(mm).padStart(2, "0") + "′" + (sign < 0 ? hemiNeg : hemiPos);
  }

  function fmtArcmin(rate) {
    const sign = rate < 0 ? "−" : "+";
    return sign + Math.abs(rate).toFixed(1) + "′/yr";
  }

  function probeEl() {
    let el = document.getElementById("mag-probe");
    if (!el) {
      el = document.createElement("div");
      el.id = "mag-probe";
      el.className = "temp-probe";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      const host = (state.map && state.map.getContainer()) || document.body;
      host.appendChild(el);
    }
    return el;
  }

  function hideProbe() {
    const el = document.getElementById("mag-probe");
    if (el) el.hidden = true;
    state.lastProbe = null;
    const detail = document.getElementById("mag-legend-detail");
    if (detail) detail.innerHTML = "";
  }

  function showProbe(text, containerPoint) {
    const el = probeEl();
    if (text == null) {
      el.hidden = true;
      state.lastProbe = null;
      return;
    }
    if (state.lastProbe !== text) {
      el.textContent = text;
      state.lastProbe = text;
      const detail = document.getElementById("mag-legend-detail");
      if (detail) detail.textContent = text;
    }
    el.hidden = false;
    if (containerPoint) {
      el.style.left = containerPoint.x + 14 + "px";
      el.style.top = containerPoint.y + 14 + "px";
    }
  }

  // nT magnitudes run to five digits: thousands separators are the
  // difference between "50000" reading as an index and "50,000" reading
  // as a field strength.
  function fmtNt(v) {
    return Math.round(v).toLocaleString("en-US") + " nT";
  }

  function fmtRate(v, unit) {
    const sign = v < 0 ? "−" : "+";
    return sign + Math.abs(v).toFixed(1) + " " + unit;
  }

  function fmtValue(key, v) {
    switch (key) {
      case "d": return fmtDegMin(v, "E", "W");
      case "i": return fmtDegMin(v, "↓", "↑");
      case "f":
      case "h": return fmtNt(v);
      case "ddot":
      case "idot": return fmtArcmin(v);
      default: return fmtRate(v, (FIELDS[key] || {}).unit || "nT/yr");
    }
  }

  // The one-line probe/HUD text: the FOUR values of whichever mode is
  // active, in component order (D, F, H, I — or their rates). Null until
  // that mode's planes are ALL in memory, so the card never shows half a
  // reading while the rest is still downloading.
  function probeText(lat, lon) {
    if (!state.meta) return null;
    const keys = fieldsOfMode(state.mode);
    for (const k of keys) {
      if (!state.planes[k]) return null;
    }
    const masked = isMasked(lat, lon);
    const parts = [];
    let missing = null;
    for (const k of keys) {
      const def = FIELDS[k];
      if (def.boz && masked) {
        // D (or ΔD) has no value here — but F, H and I do, so say which
        // one is missing instead of blanking a card with three good
        // numbers on it.
        if (!missing) missing = def;
        continue;
      }
      const v = samplePlane(state.planes[k], lat, lon, k);
      if (v == null) continue;
      parts.push(def.short + " " + fmtValue(k, v));
    }
    if (!parts.length) {
      return masked ? "Blackout zone — compass unreliable" : null;
    }
    if (missing) parts.unshift("Blackout zone — " + missing.short + " undefined here");
    return parts.join(" · ");
  }

  function updateProbe(latlng, containerPoint) {
    if (!state.enabled || !state.meta) return;
    showProbe(probeText(latlng.lat, latlng.lng), containerPoint);
  }

  // ── init ──────────────────────────────────────────────────────────────
  function init(map) {
    if (!map || state.map) return;
    state.map = map;
    ensurePane(map);

    state.probeMode = storageGet(PROBE_STORE_KEY, "0") === "1";
    state.washOn = storageGet(WASH_STORE_KEY, "0") === "1";
    // Restore the two-part choice — and MIGRATE the old single-key one.
    // `xyzo.magComponent` used to hold "d" | "i" | "sv", where "sv" was a
    // whole component in its own right; under the 4×2 model "sv" is a
    // MODE, so it becomes declination + change-per-year — the same field
    // the chip showed before, spelled the new way.
    const savedMode = storageGet(MODE_STORE_KEY, "");
    const savedComp = storageGet(COMP_STORE_KEY, "d");
    if (savedMode === "main" || savedMode === "sv") {
      state.mode = savedMode;
    } else {
      state.mode = savedComp === "sv" ? "sv" : "main";
    }
    state.component = COMPONENTS[savedComp] ? savedComp : "d";

    // Register the overlay listeners BEFORE the localStorage restore
    // below. addTo() fires `overlayadd` synchronously; if the listener
    // is not yet attached the restore is invisible to onLayerToggled —
    // state.enabled stays false, fillLines() never runs, and the layer
    // draws nothing while the layers-control checkbox still looks
    // checked (Leaflet only checks map.hasLayer). That is exactly the
    // "checkbox on, field missing" bug of 2026-10-28.
    map.on("overlayadd", (e) => {
      if (state.lines && e.layer === state.lines) onLayerToggled(true);
    });
    map.on("overlayremove", (e) => {
      if (state.lines && e.layer === state.lines) onLayerToggled(false);
    });

    // Restore the previous choice. Like the other overlays this runs
    // before the layers control is created, so the control picks the
    // checked state up from the map — and now the overlayadd fired by
    // this addTo reaches the listener above.
    if (state.lines && storageGet(STORE_KEY, "0") === "1") {
      try {
        state.lines.addTo(state.map);
      } catch (_) {}
    }

    map.on("zoomend", () => {
      if (state.enabled) updateLabels(map.getZoom());
      if (state.enabled) restyle();
    });

    map.on("mousemove", (e) => {
      if (state.enabled && !state.probeMode) {
        // HoverInfo "all" mode aggregates every layer's reading into
        // one card — stand down so two boxes don't fight the cursor.
        if (window.HoverInfo && typeof HoverInfo.suppressesProbes === "function" && HoverInfo.suppressesProbes()) return;
        updateProbe(e.latlng, e.containerPoint);
      }
    });
    map.on("mouseout", () => {
      if (!state.probeMode) hideProbe();
    });
    map.on("click", (e) => {
      if (state.enabled && state.probeMode) updateProbe(e.latlng, e.containerPoint);
    });

    waitForLayersControl();

    // Warm the META at idle — the component chips and the legend are
    // in the dropdown whether or not the overlay is on. **THE PLANES
    // ARE NOT WARMED**: they are ~1 MB and the layer is OFF by default.
    const warm = () => ensureMeta().catch(() => {});
    if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
    else setTimeout(warm, 3000);
  }

  function blocksClick() {
    return state.enabled && state.probeMode;
  }

  // ── public API ────────────────────────────────────────────────────────
  // ── export surfaces ──────────────────────────────────────────────────
  // TWO surfaces from this module:
  //
  //  · "magnetic"        — the four planes of whichever MODE is active
  //                        as a multi-band raster. The rates and the
  //                        main field are four files apiece, and the
  //                        selector decides which four you are looking
  //                        at, so the export carries exactly those —
  //                        switch to "Change per year" to take ΔD/ΔF/
  //                        ΔH/ΔI home as a GeoTIFF.
  //  · "magnetic-lines"  — every contour line set the module has
  //                        actually loaded, as vector features.
  //
  // The blackout mask is honoured PER FIELD: cells where the compass
  // stands vertical are nodata in the D and ΔD bands only — F, H and I
  // are perfectly good readings there, and blanketing them would drop
  // the poles out of the file.
  const BAND_NAMES = {
    d: "declination", f: "total_force", h: "horizontal_force", i: "inclination",
    ddot: "declination_rate", fdot: "total_force_rate",
    hdot: "horizontal_force_rate", idot: "inclination_rate",
  };

  function registerExport() {
    if (!window.XYZO_EXPORT) return;

    // A GETTER, not a literal: the engine reads surface.bands when the
    // user actually exports, so this always names the four planes
    // sample() is about to return. A literal 8-band list with a
    // 4-value sampler would ship four silently empty bands.
    function activeBands() {
      return fieldsOfMode(state.mode).map((k) => ({
        name: BAND_NAMES[k] || k,
        unit: (FIELDS[k] || {}).unit || "",
      }));
    }

    function activePlanesReady() {
      return (
        !!state.meta &&
        fieldsOfMode(state.mode).every((k) => !!state.planes[k])
      );
    }

    window.XYZO_EXPORT.register({
      id: "magnetic",
      z: 358,   // the map pane order — the export draws in it too
      label: "🧭 Magnetic Field (WMM)",
      kind: "raster",
      unit: "deg",
      attribution: "NOAA NCEI / BGS — World Magnetic Model 2025",
      licence: "US Government work — public domain",
      source: "https://www.ncei.noaa.gov/products/world-magnetic-model",
      get period() { return state.meta ? state.meta.model : ""; },
      get bands() { return activeBands(); },
      get native() {
        return window.XYZO_EXPORT.nativeFromMeta(state.meta, {
          cols: 360, rows: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360,
        });
      },
      isActive: activePlanesReady,
      sample(lat, lon) {
        if (!state.meta) return null;
        const masked = isMasked(lat, lon);
        const out = [];
        let any = false;
        for (const k of fieldsOfMode(state.mode)) {
          // NODATA is NaN, never 0 — and only for the bands whose value
          // is actually undefined here.
          if (FIELDS[k].boz && masked) { out.push(NaN); continue; }
          const v = samplePlane(state.planes[k], lat, lon, k);
          if (v == null || !Number.isFinite(v)) { out.push(NaN); continue; }
          any = true;
          out.push(v);
        }
        return any ? out : null;
      },
      // The wash colour comes from the LAYER'S OWN ramp for the ACTIVE
      // field — the one the user is looking at.
      color(v) {
        if (!state.meta || !v) return null;
        const key = fieldKey();
        const field = state.meta.fields && state.meta.fields[key];
        if (!field || !field.ramp) return null;
        const idx = fieldsOfMode(state.mode).indexOf(key);
        const c = idx >= 0 ? v[idx] : v[0];
        if (!Number.isFinite(c)) return null;
        return rampColor(field.ramp, c);
      },
    });

    window.XYZO_EXPORT.register({
      id: "magnetic-lines",
      z: 358,   // the map pane order — the export draws in it too
      label: "🧭 Magnetic contours (WMM)",
      kind: "vector",
      attribution: "NOAA NCEI / BGS — World Magnetic Model 2025",
      licence: "US Government work — public domain",
      source: "https://www.ncei.noaa.gov/products/world-magnetic-model",
      style: { stroke: "#111827", width: 1, opacity: 0.85 },
      // Every family loaded so far — whichever the user has selected,
      // plus anything cached from an earlier selection. Loaded lazily
      // rather than all eight up front, so an export never claims a
      // line set it does not have.
      isActive: () => Object.keys(state.features).some((k) => state.features[k]),
      async features() {
        const out = [];
        for (const key of Object.keys(state.features)) {
          const fc = state.features[key];
          const def = FIELDS[key];
          if (!fc || !def) continue;
          for (const f of fc.features || []) {
            out.push({
              type: "Feature",
              properties: Object.assign(
                { component: def.component, mode: def.mode, title: def.label },
                f.properties || {}
              ),
              geometry: f.geometry,
            });
          }
        }
        return { type: "FeatureCollection", features: out };
      },
    });
  }


  window.MagLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: setEnabled,
    isEnabled: () => state.enabled,
    setOpacity: setOpacity,
    getOpacity: getOpacity,
    setComponent: setComponent,
    setMode: setMode,
    setView: setView,
    setWash: setWash,
    setProbeMode: (on) => {
      state.probeMode = !!on;
      storageSet(PROBE_STORE_KEY, state.probeMode ? "1" : "0");
      if (!state.probeMode) hideProbe();
      refreshProbeToggle();
    },
    // The map click handler skips the click-to-submit flow while a probe
    // is armed, so a tap reads the field instead of placing a pin.
    blocksClick: blocksClick,
    // HoverInfo "all" mode: a one-line reading for the cursor position.
    sampleAt(latlng) {
      if (!state.enabled || !state.meta) return null;
      return probeText(latlng.lat, latlng.lng);
    },
    LAYER_NAME: LAYER_NAME,
    DATA_URL: BASE,
    registerExport,
    _state: state,
    _styleFor: styleFor,
    _anchorOf: anchorOf,
    _labelFor: labelFor,
  };

  registerExport();
})();
