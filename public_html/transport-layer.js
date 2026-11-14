/* ═══════════════════════════════════════════════════════════════════════
   Human Transportation overlay — NOAA's "Anthropocene" composite.

   Source: NOAA Science On a Sphere, "Human Transportation"
     https://sos.noaa.gov/catalog/datasets/human-transportation/
     File:  ftp_mirror/extras/human_transportation/anthropocene.png
     NOAA NESDIS / GSL, US Government work — public domain.

   A single equirectangular (plate carrée) world image, 2048×1024,
   combining three datasets on the Black Marble 2012 night-lights base:

     RED    87,000 daily airline flights
     BLUE   3,500 commercial vessels tracked over a year (~10 % of
            global shipping traffic)
     GREEN  the world road network, used by 1B+ motor vehicles

   The original is 4096×2048 16-bit (31 MB). We ship a 2048×1024 8-bit
   PNG (522 KB): this is a DECORATIVE context layer, not a probe-backed
   data grid, so half resolution is plenty — and PNG keeps the thin
   coloured route lines crisp where JPEG would ring around them. The
   asset is FROZEN (2012 data, never regenerated), so Caddy's
   *.png immutable rule caches it permanently, which is exactly right
   here — that rule only bites REBUILT assets (the Köppen incident).

   Why a custom L.GridLayer and not L.imageOverlay:
     An imageOverlay spans ONE copy of the world, so panning past the
     antimeridian leaves a blank gap — the same pitfall documented for
     the temperature layer. A GridLayer repeats, and its tiles are Web
     Mercator while the source is equirectangular, so each tile row's
     latitude comes from the inverse Mercator transform (tileLat),
     exactly as temp-layer does. Sampling in latitude-space instead
     would shift the route lines against the basemap.

   createTile must call done() ASYNCHRONOUSLY — Leaflet inserts a tile
   only after createTile returns, and a synchronous callback leaves
   every tile at visibility:hidden (the bug temp-layer shipped).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const BASE = "/data/transport";
  const IMAGE_URL = BASE + "/human-transportation.png";
  const PANE = "transportPane";
  const PANE_Z = 359; // above mag (358), below isobars (360)
  const STORE_KEY = "xyzo.transportLayer";

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
  // THIS transform before picking its source row, or the route lines
  // slide north/south of the cities they connect.
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ensureImage() {
    if (state.img) return Promise.resolve(state.img);
    if (state.imgPromise) return state.imgPromise;
    state.imgPromise = new Promise((resolve, reject) => {
      const img = new Image();
      // The PNG is same-origin, so the canvas stays untainted and we
      // could pixel-sample it later if a probe is ever added.
      img.crossOrigin = "anonymous";
      img.onload = () => {
        state.img = img;
        state.imgPromise = null;
        log("[transport] loaded", img.naturalWidth + "x" + img.naturalHeight);
        resolve(img);
      };
      img.onerror = () => {
        state.imgPromise = null;
        warn("[transport] image failed to load:", IMAGE_URL);
        reject(new Error("transport image load failed"));
      };
      img.src = IMAGE_URL;
    });
    return state.imgPromise;
  }

  // ── rendering ────────────────────────────────────────────────────────
  // Paint one tile by walking its rows: each output row's latitude comes
  // from the inverse Mercator, which maps linearly onto the source
  // image's rows (plate carrée). One drawImage per row — GPU-backed,
  // exact, and far cheaper than a per-pixel JS resample.
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

    // Longitude: the tile's x range maps linearly onto image columns,
    // and wraps — a tile straddling the antimeridian is drawn as two
    // blits, exactly as the temp layer does.
    const leftFrac = coords.x / n;
    const rightFrac = (coords.x + 1) / n;
    const sxLeft = leftFrac * imgW;
    const swFull = (rightFrac - leftFrac) * imgW; // == imgW / n

    for (let row = 0; row < H; row++) {
      // Fractional tile-y for the MIDDLE of this output row, then its
      // geodetic latitude, then that latitude's row in the equirect
      // source. Mercator y is non-linear in latitude; equirect y is.
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
    const TransportGrid = L.GridLayer.extend({
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
    return new TransportGrid({
      pane: PANE,
      opacity: 0.85,
      attribution:
        'NOAA NESDIS / Science On a Sphere — "Human Transportation" (2012 night lights + flights, shipping, roads)',
      // THE OVERLAY MUST EXIST AT EVERY ZOOM. A GridLayer is BLANK
      // outside [minZoom, maxZoom] — Leaflet computes no tile zoom at
      // all — and this one used to say minZoom: 1, maxZoom: 8, so the
      // composite was invisible on the whole-world view and VANISHED
      // again above z8. The source reaches the poles, and it is a
      // 2048x1024 picture: native around z3 and an upscale beyond it,
      // but present everywhere.
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
    // **ONLY when the layer is already on.** It is 839 KB, the
    // layer is OFF by default, and warming it unconditionally put those
    // bytes on every first page load for a layer nobody had asked for.
    if (state.enabled) {
      const warm = () => ensureImage().catch(() => {});
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 8000 });
      else setTimeout(warm, 4000);
    }
  }

  // ── public API ───────────────────────────────────────────────────────
  window.TransportLayer = {
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
    // This is a picture, not a probe-backed field: it never owns a
    // click, so the click-to-submit flow is never blocked.
    blocksClick: () => false,
    LAYER_NAME: "🛰️ Human Transportation",
    DATA_URL: BASE,
    _state: state,
  };
})();
