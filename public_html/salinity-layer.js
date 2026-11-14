/* ═══════════════════════════════════════════════════════════════════════
   Sea Surface Salinity overlay — NOAA GFDL CM2.6, via NOAA SOS.

   Source: NOAA Science On a Sphere, "Sea Surface Salinity"
     https://sos.noaa.gov/catalog/datasets/sea-surface-salinity/
     File:  ftp://public.sos.noaa.gov/oceans/sss/4096/
            sss_4096.cm26_sos_sss_v7_0000.jpg   (frame 0 of 1,094)
     NOAA / Geophysical Fluid Dynamics Laboratory — US Government work,
     public domain (same status as the Human Transportation layer).

   The dataset is a day-by-day animation (1,094 daily frames) of surface
   salinity simulated by the high-resolution CM2.6 climate model. We ship
   ONE representative frame — the large-scale structure (salty subtropical
   gyres, fresh Arctic and river plumes) is the story, and 1,094 frames
   would be 2.2 GB. The colour scale is PSU (practical salinity unit,
   grams of salt per kg of water): warm = salty, cool = fresh.

   Build (one-time, like the transportation asset — the model output is
   frozen, never regenerated):
     - land (the SOS black mask) → palette index with PNG transparency,
       so the basemap's continents show through instead of a black wash;
     - 4096×2048 JPEG → 2048×1024, 256-colour palette, NO dithering
       (a smooth scientific ramp bands gently and looks clean; Floyd-
       Steinberg grain does not), 652 KB.

   Rendering: same custom L.GridLayer pattern as transport-layer and
   temp-layer — NOT L.imageOverlay (one world copy = a blank gap past
   the antimeridian), tile rows resolved through the inverse Mercator
   (tileLat) because the source is equirectangular and the tiles are
   Web Mercator, world-edge tiles drawn as two blits, done() called
   ASYNCHRONOUSLY (a synchronous done() leaves every tile hidden).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/salinity";
  const IMAGE_URL = BASE + "/salinity.png";
  const PANE = "salinityPane";
  // Above climate (350), below soil (352) — the bottom of the wash
  // stack; all washes are opt-in, so their relative order rarely shows.
  const PANE_Z = 351;
  const STORE_KEY = "xyzo.salinityLayer";

  const state = {
    map: null,
    overlay: null,
    enabled: false,
    img: null,
    imgPromise: null,
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

  // Inverse Mercator: fractional tile-y → geodetic latitude. The source
  // is equirectangular, so a tile row must go through THIS transform
  // before its source row is picked, or the salinity bands slide north
  // of where they belong (the transport/temp-layer rule).
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureImage() {
    if (state.img) return Promise.resolve(state.img);
    if (state.imgPromise) return state.imgPromise;
    state.imgPromise = new Promise((resolve, reject) => {
      const img = new Image();
      // Same-origin, so the canvas stays untainted if a probe is ever
      // added to read PSU values under the cursor.
      img.crossOrigin = "anonymous";
      img.onload = () => {
        state.img = img;
        state.imgPromise = null;
        log("[salinity] loaded", img.naturalWidth + "x" + img.naturalHeight);
        resolve(img);
      };
      img.onerror = () => {
        state.imgPromise = null;
        warn("[salinity] image failed to load:", IMAGE_URL);
        reject(new Error("salinity image load failed"));
      };
      img.src = IMAGE_URL;
    });
    return state.imgPromise;
  }

  // ── rendering ────────────────────────────────────────────────────────
  // One drawImage per output row: the row's latitude comes from the
  // inverse Mercator and maps linearly onto the equirect source.
  function paintTile(canvas, coords) {
    const img = state.img;
    if (!img) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const n = 1 << coords.z;
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const leftFrac = coords.x / n;
    const rightFrac = (coords.x + 1) / n;
    const sxLeft = leftFrac * imgW;
    const swFull = (rightFrac - leftFrac) * imgW;

    for (let row = 0; row < H; row++) {
      const v = (coords.y + (row + 0.5) / H) / n;
      const lat = tileLat(v);
      const srcRow = Math.min(
        imgH - 1,
        Math.max(0, Math.floor(((90 - lat) / 180) * imgH))
      );

      if (sxLeft >= 0 && sxLeft + swFull <= imgW) {
        ctx.drawImage(img, sxLeft, srcRow, swFull, 1, 0, row, W, 1);
      } else {
        // Straddles (or is beyond) the world edge — wrap it.
        let sx = ((sxLeft % imgW) + imgW) % imgW;
        if (sx + swFull <= imgW) {
          ctx.drawImage(img, sx, srcRow, swFull, 1, 0, row, W, 1);
        } else {
          const first = imgW - sx;
          const dw = (first / swFull) * W;
          ctx.drawImage(img, sx, srcRow, first, 1, 0, row, dw, 1);
          ctx.drawImage(img, 0, srcRow, swFull - first, 1, dw, row, W - dw, 1);
        }
      }
    }
  }

  function makeTileLayer() {
    const SalinityGrid = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        paintTile(tile, coords);
        // ASYNC: Leaflet inserts the tile only after createTile returns;
        // a synchronous done() leaves every tile at visibility:hidden.
        setTimeout(() => done(null, tile), 0);
        return tile;
      },
      // A bare GridLayer has no setOpacity; the layers dropdown and the
      // OverlayOpacity slider both call it.
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
    return new SalinityGrid({
      pane: PANE,
      opacity: 0.85,
      attribution:
        'NOAA GFDL (CM2.6) sea surface salinity — via NOAA Science On a Sphere (public domain)',
      // THE OVERLAY MUST EXIST AT EVERY ZOOM. A GridLayer is BLANK
      // outside [minZoom, maxZoom] — Leaflet computes no tile zoom at
      // all — and this one used to say minZoom: 1, maxZoom: 8, so the
      // salinity was invisible on the whole-world view and VANISHED
      // again above z8. The source is a 2048x1024 picture: native
      // around z3 and an upscale beyond it, but present everywhere.
      minZoom: 0,
      maxZoom: 18,
    });
  }

  function getTileLayer() {
    if (state.overlay) return state.overlay;
    if (typeof L === "undefined") return null;
    state.overlay = makeTileLayer();
    state.overlay.on("add", () => {
      state.enabled = true;
      storageSet(STORE_KEY, "1");
      ensureImage()
        .then(() => {
          // Tiles created before the image landed were painted blank.
          if (state.enabled && state.overlay) state.overlay.redraw();
        })
        .catch(() => {});
    });
    state.overlay.on("remove", () => {
      state.enabled = false;
      storageSet(STORE_KEY, "0");
    });
    return state.overlay;
  }

  function init(map) {
    if (!map || state.map) return;
    state.map = map;
    if (!map.getPane(PANE)) {
      map.createPane(PANE);
      const pane = map.getPane(PANE);
      pane.style.zIndex = String(PANE_Z);
      pane.style.pointerEvents = "none";
    }

    // Register the overlay listener BEFORE the localStorage restore
    // below — addTo() fires `overlayadd` synchronously, and a listener
    // attached afterwards never sees the restore, leaving the checkbox
    // on with nothing drawn (the 2026-10-28 magnetic-layer bug).
    map.on("overlayadd", (e) => {
      if (state.overlay && e.layer === state.overlay) {
        state.enabled = true;
      }
    });
    map.on("overlayremove", (e) => {
      if (state.overlay && e.layer === state.overlay) {
        state.enabled = false;
      }
    });

    if (state.overlay && storageGet(STORE_KEY, "0") === "1") {
      try {
        state.overlay.addTo(state.map);
      } catch (_) {}
    }

    // Warm the image at idle so switching the layer on is instant —
    // **ONLY when the layer is already on.** It is 637 KB, the
    // layer is OFF by default, and warming it unconditionally put those
    // bytes on every first page load for a layer nobody had asked for.
    if (state.enabled) {
      const warm = () => ensureImage().catch(() => {});
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 8000 });
      else setTimeout(warm, 4000);
    }
  }

  // ── public API ───────────────────────────────────────────────────────
  window.SalinityLayer = {
    init: init,
    getTileLayer: getTileLayer,
    setEnabled: (on) => {
      const want = !!on;
      if (!state.overlay) state.overlay = getTileLayer();
      if (!state.overlay || !state.map) return Promise.resolve(false);
      if (want) {
        if (!state.map.hasLayer(state.overlay)) state.overlay.addTo(state.map);
      } else if (state.map.hasLayer(state.overlay)) {
        state.map.removeLayer(state.overlay);
      }
      state.enabled = state.map.hasLayer(state.overlay);
      return Promise.resolve(state.enabled);
    },
    isEnabled: () => state.enabled,
    setOpacity: (v) => {
      if (state.overlay && typeof state.overlay.setOpacity === "function") {
        state.overlay.setOpacity(v);
      }
    },
    getOpacity: () =>
      state.overlay && typeof state.overlay.getOpacity === "function"
        ? state.overlay.getOpacity()
        : 0.85,
    // A picture, not a probe-backed field: it never owns a click, so
    // the click-to-submit flow is never blocked.
    blocksClick: () => false,
    LAYER_NAME: "🧂 Sea surface salinity",
    DATA_URL: BASE,
    _state: state,
  };
})();
