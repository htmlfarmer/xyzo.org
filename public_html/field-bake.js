/* ═══════════════════════════════════════════════════════════════════════
   Canonical Web-Mercator bake for a lat/lon grid field.

   WHY THIS FILE EXISTS
   --------------------
   Three overlays on this site are a lat/lon GRID field painted as a
   picture: the GFS 2 m temperature, the WWLLN lightning density and the
   WMM magnetic wash. The flat map paints them per Web-Mercator tile;
   the 3D globe has no tiles, so it drapes one picture over the sphere.

   The drape is an "image" source: a quad whose four corners are given
   in lng/lat. MapLibre turns those corners into MERCATOR coordinates
   and stretches the texture across that mercator rectangle — so the
   texture's V axis is MERCATOR, not latitude.

   The globe used to bake the texture in LATITUDE (row 0 = +90°, rows
   linear in latitude) and drape it as if it were mercator. The picture
   was therefore sampled with the wrong row for every latitude except
   the equator: at 45°N the globe showed the Sahara's 38 °C instead of
   the Bay of Biscay's 11 °C, and the poles came out hot. Measured on
   the 2026-11-03 cycle, the value painted at 45°N was 27 °C too warm.

   A MERCATOR bake fixes it, and it has a second, better consequence:
   the globe then shows the SAME picture as the flat map, because the
   flat map's tile grid is Web Mercator too. One bake, two views, no
   second implementation of the mapping to drift.

   The flat map's temp-layer.js and lightning-layer.js already bake in
   mercator; this module owns the arithmetic so there is one copy.

   Usage:
     window.XYZO_FIELD_BAKE.tileLat(v)             // mercator y -> latitude
     window.XYZO_FIELD_BAKE.rampColor(ramp, c)     // the canonical ramp
     window.XYZO_FIELD_BAKE.bakeMercator({...})    // grid -> canvas
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // The Web Mercator limit. A mercator image source's quad must stop
  // here: at ±90° the projection is y = Infinity and the source never
  // renders at all. Everything poleward of this is clamped to the last
  // row, which is the honest answer for a mercator picture anyway.
  const LAT_LIMIT = 85.051129;

  // mercator y (0 at the north edge, 1 at the south edge) -> latitude.
  // The same formula the flat map's tileLat() uses.
  function tileLat(v) {
    return ((2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) * 180) / Math.PI;
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // The canonical ramp lookup: INTERPOLATE BY EACH STOP'S OWN VALUE,
  // never by index. The published stops are NOT evenly spaced (the
  // temperature ramp's gaps run 4.2, 4.9, 3.5, 2.1 °C), so indexing
  // them with an even step lands on the wrong stop — up to +4.9 °C too
  // warm, which painted 0 °C lime-yellow where the map paints green.
  function rampColor(ramp, c) {
    if (!ramp || !ramp.length) return [128, 128, 128];
    const lo = ramp[0];
    const hi = ramp[ramp.length - 1];
    if (c <= lo.c) return hexToRgb(lo.rgb);
    if (c >= hi.c) return hexToRgb(hi.rgb);
    for (let i = 0; i < ramp.length - 1; i++) {
      const a = ramp[i];
      const b = ramp[i + 1];
      if (c >= a.c && c <= b.c) {
        const t = (b.c === a.c) ? 0 : (c - a.c) / (b.c - a.c);
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

  /**
   * Bake a lat/lon grid into a Web-Mercator picture.
   *
   * @param {object}   o
   * @param {object}   o.grid     { cols, rows, lat_min, lat_step, lon_min, lon_step }
   *                              `rows` counts SOUTH to NORTH from lat_min, which is
   *                              the layout every published grid on this site uses.
   * @param {ArrayLike} o.data    the raw grid values (Int16 / Uint16 / …)
   * @param {number}   o.width    pixels across (the whole 360° of longitude)
   * @param {number}   o.height   pixels down (the whole mercator range)
   * @param {Function} o.colorAt  (rawValue) -> [r,g,b,a] | null
   *                              null (or an omitted alpha) leaves the pixel clear.
   * @param {ArrayLike} [o.mask]  optional mask plane; a cell equal to
   *                              `maskValue` is left transparent.
   * @param {number}   [o.maskValue]
   * @returns {HTMLCanvasElement}
   */
  function bakeMercator(o) {
    const g = o.grid;
    const data = o.data;
    const W = Math.max(1, o.width | 0);
    const H = Math.max(1, o.height | 0);
    const colorAt = o.colorAt;
    const mask = o.mask || null;
    const maskValue = o.maskValue;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const out = img.data;

    for (let py = 0; py < H; py++) {
      // mercator row -> latitude (the inverse transform)
      const lat = tileLat((py + 0.5) / H);
      let row = (lat - g.lat_min) / g.lat_step;
      row = Math.max(0, Math.min(g.rows - 1, row));
      const r0 = Math.floor(row);
      const r1 = Math.min(g.rows - 1, r0 + 1);
      const fr = row - r0;
      const base0 = r0 * g.cols;
      const base1 = r1 * g.cols;
      const o = py * W * 4;

      for (let px = 0; px < W; px++) {
        const lon = -180 + (360 * (px + 0.5)) / W;
        let col = (lon - g.lon_min) / g.lon_step;
        col = ((col % g.cols) + g.cols) % g.cols;
        const c0 = Math.floor(col);
        const c1 = (c0 + 1) % g.cols;
        const fc = col - c0;

        const oi = o + px * 4;

        // A masked cell is transparent — the same blank NOAA prints in
        // the magnetic blackout zone.
        if (mask && mask[base0 + c0] === maskValue) {
          out[oi + 3] = 0;
          continue;
        }

        const top = data[base0 + c0] * (1 - fc) + data[base0 + c1] * fc;
        const bot = data[base1 + c0] * (1 - fc) + data[base1 + c1] * fc;
        const raw = top * (1 - fr) + bot * fr;

        const c = colorAt(raw);
        if (!c) {
          out[oi + 3] = 0;
          continue;
        }
        out[oi] = c[0];
        out[oi + 1] = c[1];
        out[oi + 2] = c[2];
        out[oi + 3] = c.length > 3 ? c[3] : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // The four corners of a mercator picture. Used as an image source's
  // `coordinates`, so the quad is exactly the mercator world.
  function mercatorQuad() {
    return [
      [-180, LAT_LIMIT],
      [180, LAT_LIMIT],
      [180, -LAT_LIMIT],
      [-180, -LAT_LIMIT],
    ];
  }

  window.XYZO_FIELD_BAKE = {
    LAT_LIMIT: LAT_LIMIT,
    tileLat: tileLat,
    hexToRgb: hexToRgb,
    rampColor: rampColor,
    bakeMercator: bakeMercator,
    mercatorQuad: mercatorQuad,
  };
})();
