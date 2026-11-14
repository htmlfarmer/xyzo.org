/* ═══════════════════════════════════════════════════════════════════════
   Ocean Currents + Temperature overlay — NOAA "Perpetual Ocean".

   Source: NOAA Science On a Sphere, "Ocean Currents - Temperature"
     https://sos.noaa.gov/catalog/datasets/ocean-currents-temperature/
     FTP:   ftp://public.sos.noaa.gov/oceans/perpetual_ocean/temp/
     NOAA NESDIS / GSL, US Government work — public domain.

   The SOS release is a VIDEO (perpetual_ocean_2048.mp4, 313 MB,
   2048x1024, 120 s loop) — there is no clean still, unlike the
   Anthropocene dataset. We ship ONE extracted frame (t=60 s) as a
   2048x1024 palette PNG (~336 KB), processed to be a usable overlay:

     • Land is made TRANSPARENT using a Natural Earth 110m land mask,
       so it does not double up over the map's own basemap.
     • The polar caps (|lat| > 78) are blanked — the source paints sea
       ice / ice sheets as flat grey, which is not part of the ECCO
       sea-surface current field.
     • The burned-in SOS player chrome (timestamp, frame counter) is
       patched out by copying a clean row over the corners.
     • Warm current cores (Gulf Stream, Agulhas, Kuroshio, ACC) are
       selectively saturated so they read against the dark navy ocean.

   The field is coloured by water TEMPERATURE: ~32 °F (0 °C) blue up to
   ~77 °F (25 °C) red. Data is NASA's ECCO-2 model (2021-2023), built
   from satellites, buoys and in-situ measurements.

   Rendering: a custom L.GridLayer that samples the equirectangular
   image through the Web-Mercator tile grid — exactly like
   transport-layer.js. A plain L.imageOverlay spans ONE copy of the
   world and leaves a gap past the antimeridian; a GridLayer repeats,
   and each tile row's latitude is resolved through the inverse Mercator
   (tileLat) so the currents stay aligned with the coastlines.

   createTile calls done() ASYNCHRONOUSLY (a synchronous callback
   leaves every tile at visibility:hidden), and the GridLayer provides
   setOpacity/getOpacity for the layers dropdown.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/transport";
  const IMAGE_URL = BASE + "/ocean-currents.png";
  const PANE = "oceanPane";
  const PANE_Z = 361; // above isobars (360), below basins (362)
  const STORE_KEY = "xyzo.oceanLayer";

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

  // Inverse Mercator: fractional tile-y -> geodetic latitude. The source
  // image is equirectangular, so a tile row must be resolved through
  // THIS transform before picking its source row, or the current lines
  // slide north/south of the coasts they hug.
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureImage() {
    if (state.img) return Promise.resolve(state.img);
    if (state.imgPromise) return state.imgPromise;
    state.imgPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        state.img = img;
        state.imgPromise = null;
        log("[ocean] loaded", img.naturalWidth + "x" + img.naturalHeight);
        resolve(img);
      };
      img.onerror = () => {
        state.imgPromise = null;
        warn("[ocean] image failed to load:", IMAGE_URL);
        reject(new Error("ocean image load failed"));
      };
      img.src = IMAGE_URL;
    });
    return state.imgPromise;
  }

  // ── rendering ────────────────────────────────────────────────────────
  // One drawImage per output row: each row's latitude comes from the
  // inverse Mercator, which maps linearly onto the source image's rows.
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
        // Tile straddles the antimeridian — draw as two blits.
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
    const OceanGrid = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        paintTile(tile, coords);
        // ASYNC: Leaflet inserts the tile only after createTile returns.
        setTimeout(() => done(null, tile), 0);
        return tile;
      },
      // A bare GridLayer has no setOpacity; the dropdown and the
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
    return new OceanGrid({
      pane: PANE,
      opacity: 0.85,
      attribution:
        'NOAA NESDIS / Science On a Sphere — "Ocean Currents - Temperature" (NASA ECCO-2, 2021-2023)',
      // THE OVERLAY MUST EXIST AT EVERY ZOOM. A GridLayer is BLANK
      // outside [minZoom, maxZoom] — Leaflet computes no tile zoom at
      // all, so the layer draws nothing — and this one used to say
      // minZoom: 1, maxZoom: 8. That is two dead ends: the layer was
      // invisible on the whole-world view (z0) and it VANISHED again
      // above z8, so the currents disappeared exactly when the reader
      // zoomed in to look at them. The source is a 2048x1024
      // equirectangular picture: native around z3 and an upscale
      // beyond it, but present at every zoom, which is the point.
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
      if (state.overlay && e.layer === state.overlay) state.enabled = true;
    });
    map.on("overlayremove", (e) => {
      if (state.overlay && e.layer === state.overlay) state.enabled = false;
    });

    if (state.overlay && storageGet(STORE_KEY, "0") === "1") {
      try {
        state.overlay.addTo(state.map);
      } catch (_) {}
    }

    // Warm the image at idle so switching the layer on is instant —
    // **ONLY when the layer is already on.** It is 336 KB, the
    // layer is OFF by default, and warming it unconditionally put those
    // bytes on every first page load for a layer nobody had asked for.
    if (state.enabled) {
      const warm = () => ensureImage().catch(() => {});
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 8000 });
      else setTimeout(warm, 4000);
    }
  }

  // ── public API ───────────────────────────────────────────────────────
  window.OceanLayer = {
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
    // A picture, not a probe — never owns a click.
    blocksClick: () => false,
    LAYER_NAME: "🌊 Ocean Currents (ECCO)",
    DATA_URL: BASE,
    _state: state,
  };
})();
