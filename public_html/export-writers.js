/* ═══════════════════════════════════════════════════════════════════════
   Export writers — the file formats a user can take away.

   These are PURE functions: bytes in, bytes out. No DOM, no fetch, no
   network. That is deliberate — it makes them testable in bun without a
   browser, and it keeps the format logic separate from the map.

   WHAT IS HERE
   ────────────
     writeGeoTIFF()  — a real GeoTIFF, EPSG:4326, georeferenced.
                       Opens natively in QGIS, ArcGIS, Whitebox, R.
     writeGeoJSON()  — RFC 7946 FeatureCollection.
     writeKML()      — KML 2.2 for Google Earth.
     writeCSV()      — lon/lat/value tables and pin tables.
     writeSVG()      — a true vector SVG of the vector overlays.
     writeZIP()      — a store-only ZIP (no compression, no dependency).

   WHY A HAND-ROLLED ZIP
   ──────────────────────
   The site's rule is "no build step, vanilla JS", and public_html/vendor
   holds no archive library. A ZIP with STORED (uncompressed) entries is
   a few dozen lines and needs no third-party code. The exports are
   mostly text — GeoJSON, CSV, KML, a licence file — so compression
   would buy little.

   THE GEOTIFF
   ───────────
   This is the one that matters for "add it to QGIS". It is a classic
   (not BigTIFF) little-endian TIFF with:
     · ModelPixelScale + ModelTiepoint  — the geotransform
     · GeoKeyDirectory with GTModelType=2 (geographic) and
       GeographicTypeGeoKey=4326         — the CRS
     · GDAL_METADATA                     — the band names, so QGIS shows
                                           "temperature (°C)" over the
                                           layer instead of "Band 1"

   ROW ORDER: row 0 is the NORTHERNMOST row, which is the raster
   convention every GDAL reader assumes. The tiepoint puts raster
   (0,0) at (minLon, maxLat). If the engine ever hands over a
   south-first array the file would open upside down, so the writer
   takes `rowOrder` and normalises here rather than trusting the
   caller.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const E = (window.XYZO_EXPORT_WRITERS = {});

  // ── small helpers ───────────────────────────────────────────────────
  function escapeXml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // ── CRC32 (for ZIP) ─────────────────────────────────────────────────
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes) {
    const t = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  E.crc32 = crc32;

  // ═══════════════════════════════════════════════════════════════════
  // GeoTIFF
  // ═══════════════════════════════════════════════════════════════════

  const TIFF = {
    BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5,
    FLOAT: 11, DOUBLE: 12,
  };
  const TYPE_SIZE = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8,
  };

  const DTYPES = {
    float32: { bits: 32, format: 3, bytes: 4 },   // SampleFormat 3 = IEEE float
    float64: { bits: 64, format: 3, bytes: 8 },
    int16:   { bits: 16, format: 2, bytes: 2 },   // 2 = signed int
    uint16:  { bits: 16, format: 1, bytes: 2 },   // 1 = unsigned int
    int32:   { bits: 32, format: 2, bytes: 4 },
  };

  // Build the tag list. Each entry: {id, type, values} where values is
  // an array of numbers or a string (ASCII).
  function geotiffTags(opts) {
    const width = opts.width | 0;
    const height = opts.height | 0;
    const spp = opts.bands.length;
    const dt = DTYPES[opts.dtype] || DTYPES.float32;
    const bbox = opts.bbox;
    const dx = (bbox[2] - bbox[0]) / width;
    const dy = (bbox[3] - bbox[1]) / height;

    const tags = [];
    tags.push({ id: 256, type: TIFF.LONG, values: [width] });
    tags.push({ id: 257, type: TIFF.LONG, values: [height] });
    tags.push({ id: 258, type: TIFF.SHORT, values: new Array(spp).fill(dt.bits) });
    tags.push({ id: 259, type: TIFF.SHORT, values: [1] });          // no compression
    tags.push({ id: 262, type: TIFF.SHORT, values: [1] });          // BlackIsZero
    tags.push({ id: 277, type: TIFF.SHORT, values: [spp] });
    tags.push({ id: 284, type: TIFF.SHORT, values: [1] });          // chunky
    tags.push({ id: 339, type: TIFF.SHORT, values: new Array(spp).fill(dt.format) });

    // Strips. Split the image so no single strip is enormous — some
    // readers are happier with 1 MB strips than with one 26 MB one.
    const rowBytes = width * spp * dt.bytes;
    const maxRows = Math.max(1, Math.floor(1024 * 1024 / Math.max(1, rowBytes)));
    const rowsPerStrip = Math.min(height, maxRows);
    const numStrips = Math.max(1, Math.ceil(height / rowsPerStrip));
    tags.push({ id: 278, type: TIFF.LONG, values: [rowsPerStrip] });

    // StripOffsets / StripByteCounts are filled in once the layout is
    // known — placeholders for now, patched below.
    tags.push({ id: 273, type: TIFF.LONG, values: new Array(numStrips).fill(0), _stripOffsets: true });
    tags.push({ id: 279, type: TIFF.LONG, values: new Array(numStrips).fill(0), _stripBytes: true });

    tags.push({ id: 33550, type: TIFF.DOUBLE, values: [dx, dy, 0] });
    tags.push({ id: 33922, type: TIFF.DOUBLE, values: [0, 0, 0, bbox[0], bbox[3], 0] });

    // GeoKeyDirectory.
    const keys = [
      1024, 0, 1, 2,     // GTModelTypeGeoKey = 2 (ModelTypeGeographic)
      1025, 0, 1, 1,     // GTRasterTypeGeoKey = 1 (RasterPixelIsArea)
      2048, 0, 1, 4326,  // GeographicTypeGeoKey = 4326 (WGS 84)
    ];
    const citation = opts.citation || "WGS 84";
    // 1026 GTCitationGeoKey lives in the ASCII params block, so it is
    // appended after that block's offset is known.
    tags.push({ id: 34735, type: TIFF.SHORT, values: null, _geokeys: keys });
    tags.push({ id: 34737, type: TIFF.ASCII, values: citation + "\0", _ascii: true });

    if (opts.gdalMetadata) {
      tags.push({ id: 42112, type: TIFF.ASCII, values: opts.gdalMetadata + "\0" });
    }
    // GDAL_NODATA — the sentinel the reader is told to treat as "no
    // value". Without it a blank cell is just a number.
    if (opts.nodata != null) {
      const s = String(opts.nodata);
      tags.push({ id: 42113, type: TIFF.ASCII, values: s + "\0" });
    }

    // TIFF requires ascending tag order in the IFD.
    tags.sort((a, b) => a.id - b.id);
    return { tags, numStrips, rowsPerStrip, rowBytes, dt, spp, width, height };
  }

  function buildGdalMetadata(opts) {
    const items = [];
    if (opts.description) {
      items.push('<Item name="DATASET" role="description">' + escapeXml(opts.description) + "</Item>");
    }
    if (opts.attribution) {
      items.push('<Item name="ATTRIBUTION" role="description">' + escapeXml(opts.attribution) + "</Item>");
    }
    if (opts.licence) {
      items.push('<Item name="LICENSE" role="description">' + escapeXml(opts.licence) + "</Item>");
    }
    if (opts.nodata != null) {
      items.push('<Item name="NODATA" role="description">' + escapeXml(String(opts.nodata)) + "</Item>");
    }
    (opts.bands || []).forEach((b, i) => {
      const label = b.name + (b.unit ? " (" + b.unit + ")" : "");
      items.push('<Item name="DESCRIPTION" sample="' + i + '" role="description">' + escapeXml(label) + "</Item>");
    });
    if (!items.length) return null;
    return "<GDALMetadata>" + items.join("") + "</GDALMetadata>";
  }

  /**
   * Write a georeferenced GeoTIFF.
   *
   * opts = {
   *   bands: [{ data: TypedArray, name, unit }],   // one entry per band
   *   width, height,
   *   bbox: [minLon, minLat, maxLon, maxLat],
   *   dtype: "float32" | "int16" | "uint16" | "int32",
   *   nodata: number | null,
   *   rowOrder: "north" (default) | "south",
   *   description, attribution, licence,
   * }
   * Returns an ArrayBuffer.
   */
  E.writeGeoTIFF = function writeGeoTIFF(opts) {
    const bands = (opts.bands || []).filter((b) => b && b.data);
    if (!bands.length) throw new Error("writeGeoTIFF: no bands");
    const width = opts.width | 0;
    const height = opts.height | 0;
    if (!(width > 0) || !(height > 0)) throw new Error("writeGeoTIFF: bad size");
    const bbox = opts.bbox;
    if (!bbox || bbox.length !== 4) throw new Error("writeGeoTIFF: bad bbox");

    const dt = DTYPES[opts.dtype] || DTYPES.float32;
    const spp = bands.length;
    const rowBytes = width * spp * dt.bytes;

    const meta = geotiffTags({
      bands: bands,
      width: width,
      height: height,
      bbox: bbox,
      dtype: opts.dtype,
      citation: opts.citation || "WGS 84",
      gdalMetadata: buildGdalMetadata({
        bands: bands,
        description: opts.description,
        attribution: opts.attribution,
        licence: opts.licence,
        nodata: opts.nodata,
      }),
    });

    // ── lay out the file ───────────────────────────────────────────
    // header(8) | IFD | extra values | image data
    const nTags = meta.tags.length;
    const ifdSize = 2 + nTags * 12 + 4;

    // The GeoKeyDirectory needs the ASCII citation's offset, and the
    // ASCII block's length is known — so compute it before sizing.
    const asciiBlock = meta.tags.find((t) => t._ascii);
    const asciiLen = asciiBlock ? asciiBlock.values.length : 0;

    // Extra (out-of-line) tag values.
    const extras = [];
    let extraCursor = 0;
    for (const t of meta.tags) {
      if (t._geokeys) continue; // patched later
      if (t.type === TIFF.ASCII) {
        t._bytes = new TextEncoder().encode(t.values);
        t._size = t._bytes.length;
      } else {
        t._size = t.values.length * TYPE_SIZE[t.type];
      }
      if (t._size <= 4) {
        t._inline = true;
        continue;
      }
      t._inline = false;
      // Word-align the out-of-line value, as the spec recommends.
      if (extraCursor % 2) extraCursor++;
      t._extraOffset = extraCursor;
      extraCursor += t._size;
    }

    // The GeoKeyDirectory is always out of line (it is long).
    //
    // Layout: a 4-SHORT header (version, revision, minor, NUMBER OF
    // KEYS) followed by one 4-SHORT entry per key. The header's fourth
    // value is the key COUNT, not the number of shorts — getting that
    // wrong makes GDAL refuse the file.
    const geokeyTag = meta.tags.find((t) => t._geokeys);
    const numKeys = geokeyTag._geokeys.length / 4 + 1; // + the citation key
    const geokeyValues = new Array(4 + numKeys * 4).fill(0);
    geokeyValues[0] = 1; geokeyValues[1] = 1; geokeyValues[2] = 0;
    geokeyValues[3] = numKeys;
    let k = 4;
    for (let i = 0; i < geokeyTag._geokeys.length; i += 4) {
      geokeyValues[k++] = geokeyTag._geokeys[i];
      geokeyValues[k++] = geokeyTag._geokeys[i + 1];
      geokeyValues[k++] = geokeyTag._geokeys[i + 2];
      geokeyValues[k++] = geokeyTag._geokeys[i + 3];
    }
    // 1026 GTCitationGeoKey → TIFFTagLocation 34737, count = asciiLen-1,
    // value = offset of the citation inside the ASCII block.
    geokeyValues[k++] = 1026;
    geokeyValues[k++] = 34737;
    geokeyValues[k++] = Math.max(1, asciiLen - 1);
    geokeyValues[k++] = 0;
    geokeyTag.values = geokeyValues;
    geokeyTag._size = geokeyValues.length * TYPE_SIZE[TIFF.SHORT];
    if (extraCursor % 2) extraCursor++;
    geokeyTag._extraOffset = extraCursor;
    extraCursor += geokeyTag._size;

    const extraStart = 8 + ifdSize;
    const dataStart = extraStart + extraCursor;

    // Strip offsets.
    const strips = [];
    let off = dataStart;
    for (let s = 0; s < meta.numStrips; s++) {
      const rows = Math.min(meta.rowsPerStrip, height - s * meta.rowsPerStrip);
      const bytes = rows * rowBytes;
      strips.push({ offset: off, bytes: bytes, row: s * meta.rowsPerStrip, rows: rows });
      off += bytes;
    }
    const stripOffsetsTag = meta.tags.find((t) => t._stripOffsets);
    const stripBytesTag = meta.tags.find((t) => t._stripBytes);
    stripOffsetsTag.values = strips.map((s) => s.offset);
    stripBytesTag.values = strips.map((s) => s.bytes);
    // Their sizes were computed with placeholder arrays of the same
    // length, so they are still correct.

    const total = off;

    // ── write ──────────────────────────────────────────────────────
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);

    // Header: little-endian, magic 42, first IFD at 8.
    buf[0] = 0x49; buf[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);

    // IFD.
    let p = 8;
    view.setUint16(p, nTags, true);
    p += 2;
    for (const t of meta.tags) {
      view.setUint16(p, t.id, true);
      view.setUint16(p + 2, t.type, true);
      view.setUint32(p + 4, t._count != null ? t._count : t.values.length, true);
      if (t._inline) {
        writeInline(view, buf, p + 8, t);
      } else {
        view.setUint32(p + 8, extraStart + t._extraOffset, true);
      }
      p += 12;
    }
    view.setUint32(p, 0, true); // next IFD = 0
    p += 4;

    // Extra values.
    for (const t of meta.tags) {
      if (t._inline || t._extraOffset == null) continue;
      const at = extraStart + t._extraOffset;
      if (t.type === TIFF.ASCII) {
        buf.set(t._bytes, at);
      } else {
        writeNumeric(view, at, t.type, t.values);
      }
    }

    // Image data.
    const southFirst = opts.rowOrder === "south";
    // A float band can hold NaN, which is the honest "no value" — an
    // integer band needs a real sentinel, because int16 has no NaN.
    const isFloat = dt.format === 3;
    const nodataNum = opts.nodata != null && Number.isFinite(Number(opts.nodata))
      ? Number(opts.nodata)
      : null;
    for (const strip of strips) {
      let at = strip.offset;
      for (let r = 0; r < strip.rows; r++) {
        const srcRow = southFirst
          ? height - 1 - (strip.row + r)
          : (strip.row + r);
        for (let x = 0; x < width; x++) {
          for (let b = 0; b < spp; b++) {
            const arr = bands[b].data;
            const v = arr[srcRow * width + x];
            const missing = v == null || !Number.isFinite(v);
            const val = missing
              ? (isFloat ? NaN : (nodataNum != null ? nodataNum : 0))
              : v;
            if (dt.bits === 32 && dt.format === 3) view.setFloat32(at, val, true);
            else if (dt.bits === 16) view.setInt16(at, Math.round(val), true);
            else if (dt.bits === 32) view.setInt32(at, Math.round(val), true);
            else if (dt.bits === 64) view.setFloat64(at, val, true);
            at += dt.bytes;
          }
        }
      }
    }

    return buf.buffer;
  };

  function writeInline(view, buf, at, t) {
    if (t.type === TIFF.ASCII) {
      const bytes = t._bytes;
      for (let i = 0; i < 4 && i < bytes.length; i++) buf[at + i] = bytes[i];
      return;
    }
    if (t.type === TIFF.SHORT) {
      // Up to two SHORTs fit in four bytes.
      view.setUint16(at, t.values[0] & 0xffff, true);
      if (t.values.length > 1) view.setUint16(at + 2, t.values[1] & 0xffff, true);
      return;
    }
    writeNumeric(view, at, t.type, t.values);
  }

  function writeNumeric(view, at, type, values) {
    for (let i = 0; i < values.length; i++) {
      const off = at + i * TYPE_SIZE[type];
      const v = values[i];
      switch (type) {
        case TIFF.BYTE: view.setUint8(off, v & 0xff); break;
        case TIFF.SHORT: view.setUint16(off, v & 0xffff, true); break;
        case TIFF.LONG: view.setUint32(off, v >>> 0, true); break;
        case TIFF.FLOAT: view.setFloat32(off, v, true); break;
        case TIFF.DOUBLE: view.setFloat64(off, v, true); break;
        default: break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GeoJSON
  // ═══════════════════════════════════════════════════════════════════

  /**
   * opts = { features: Feature[], bbox?, attribution?, licence?, name? }
   * RFC 7946 allows foreign members on a FeatureCollection, which is
   * where the attribution and licence travel.
   */
  E.writeGeoJSON = function writeGeoJSON(opts) {
    const fc = {
      type: "FeatureCollection",
      features: opts.features || [],
    };
    if (opts.name) fc.name = opts.name;
    if (opts.bbox) fc.bbox = opts.bbox.map((n) => Math.round(n * 1e6) / 1e6);
    if (opts.attribution) fc.attribution = opts.attribution;
    if (opts.licence) fc.licence = opts.licence;
    if (opts.generator) fc.generator = opts.generator;
    return JSON.stringify(fc);
  };

  // ═══════════════════════════════════════════════════════════════════
  // KML
  // ═══════════════════════════════════════════════════════════════════

  function kmlCoords(ring) {
    const parts = [];
    for (const p of ring) {
      parts.push(num(p[0], 0).toFixed(6) + "," + num(p[1], 0).toFixed(6) + ",0");
    }
    return parts.join(" ");
  }

  function kmlGeometry(g) {
    if (!g) return "";
    if (g.type === "Point") {
      return "<Point><coordinates>" +
        num(g.coordinates[0], 0).toFixed(6) + "," +
        num(g.coordinates[1], 0).toFixed(6) + ",0</coordinates></Point>";
    }
    if (g.type === "LineString") {
      return "<LineString><tessellate>1</tessellate><coordinates>" +
        kmlCoords(g.coordinates) + "</coordinates></LineString>";
    }
    if (g.type === "MultiLineString") {
      return "<MultiGeometry>" + g.coordinates.map((c) =>
        "<LineString><tessellate>1</tessellate><coordinates>" + kmlCoords(c) + "</coordinates></LineString>"
      ).join("") + "</MultiGeometry>";
    }
    if (g.type === "Polygon") {
      const rings = g.coordinates.map((r) =>
        "<outerBoundaryIs><LinearRing><coordinates>" + kmlCoords(r) + "</coordinates></LinearRing></outerBoundaryIs>"
      ).join("");
      return "<Polygon>" + rings + "<tessellate>1</tessellate></Polygon>";
    }
    if (g.type === "MultiPolygon") {
      return "<MultiGeometry>" + g.coordinates.map((poly) =>
        "<Polygon>" + poly.map((r) =>
          "<outerBoundaryIs><LinearRing><coordinates>" + kmlCoords(r) + "</coordinates></LinearRing></outerBoundaryIs>"
        ).join("") + "</Polygon>"
      ).join("") + "</MultiGeometry>";
    }
    if (g.type === "GeometryCollection") {
      return "<MultiGeometry>" + (g.geometries || []).map(kmlGeometry).join("") + "</MultiGeometry>";
    }
    return "";
  }

  /**
   * opts = { features: Feature[], name?, description?, attribution? }
   */
  E.writeKML = function writeKML(opts) {
    const features = opts.features || [];
    const body = features.map((f) => {
      const props = f.properties || {};
      const name = props.name || props.title || props.label || "";
      const desc = props.description || props.snippet || "";
      const styleUrl = props.styleUrl ? "<styleUrl>" + escapeXml(props.styleUrl) + "</styleUrl>" : "";
      return (
        "<Placemark>" +
        "<name>" + escapeXml(name) + "</name>" +
        (desc ? "<description>" + escapeXml(desc) + "</description>" : "") +
        styleUrl +
        kmlGeometry(f.geometry) +
        "</Placemark>"
      );
    }).join("");

    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
      "<Document>\n" +
      "<name>" + escapeXml(opts.name || "Xyzo export") + "</name>\n" +
      (opts.description ? "<description>" + escapeXml(opts.description) + "</description>\n" : "") +
      (opts.attribution ? "<description>" + escapeXml(opts.attribution) + "</description>\n" : "") +
      body +
      "</Document>\n</kml>\n"
    );
  };

  // ═══════════════════════════════════════════════════════════════════
  // CSV
  // ═══════════════════════════════════════════════════════════════════

  function csvCell(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * opts = { columns: ["lon","lat","value"], rows: [[..],[..]] }
   * Or   { columns, objects: [{..}] } — the object keys are used in
   * header order.
   */
  E.writeCSV = function writeCSV(opts) {
    const columns = opts.columns || [];
    const lines = [columns.map(csvCell).join(",")];
    if (opts.rows) {
      for (const r of opts.rows) lines.push(r.map(csvCell).join(","));
    } else if (opts.objects) {
      for (const o of opts.objects) {
        lines.push(columns.map((c) => csvCell(o[c])).join(","));
      }
    }
    return lines.join("\n") + "\n";
  };

  // ═══════════════════════════════════════════════════════════════════
  // SVG
  // ═══════════════════════════════════════════════════════════════════

  // Web Mercator, matching the map's own projection so an SVG export
  // and a screenshot of the same view line up.
  function mercX(lon, width) {
    return ((lon + 180) / 360) * width;
  }
  function mercY(lat, height) {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const s = Math.sin((clamped * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return y * height;
  }
  E.mercX = mercX;
  E.mercY = mercY;

  /**
   * opts = {
   *   features: Feature[],
   *   width, height,
   *   bbox: [minLon, minLat, maxLon, maxLat],
   *   background: "#0a0a0a",
   *   styleFor: (feature) => ({ stroke, fill, "stroke-width", opacity })
   * }
   */
  E.writeSVG = function writeSVG(opts) {
    const width = opts.width | 0;
    const height = opts.height | 0;
    const parts = [];
    parts.push(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + " " + height + '">'
    );
    parts.push('<rect x="0" y="0" width="' + width + '" height="' + height +
      '" fill="' + escapeXml(opts.background || "#0b1020") + '"/>');
    parts.push(
      '<g transform="translate(0,0)">'
    );

    const styleFor = opts.styleFor || (() => ({ stroke: "#38bdf8", fill: "none", "stroke-width": 1 }));

    for (const f of opts.features || []) {
      const g = f.geometry;
      if (!g) continue;
      const st = styleFor(f) || {};
      const attrs =
        ' fill="' + escapeXml(st.fill || "none") + '"' +
        ' stroke="' + escapeXml(st.stroke || "none") + '"' +
        ' stroke-width="' + escapeXml(String(st["stroke-width"] != null ? st["stroke-width"] : 1)) + '"' +
        (st.opacity != null ? ' opacity="' + escapeXml(String(st.opacity)) + '"' : "");
      if (g.type === "Point") {
        const x = mercX(g.coordinates[0], width);
        const y = mercY(g.coordinates[1], height);
        const r = st.radius != null ? st.radius : 3;
        parts.push('<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="' + r + '"' + attrs + "/>");
      } else if (g.type === "LineString") {
        const d = g.coordinates.map((c) =>
          mercX(c[0], width).toFixed(2) + "," + mercY(c[1], height).toFixed(2)
        ).join(" ");
        parts.push('<polyline points="' + d + '"' + attrs + "/>");
      } else if (g.type === "MultiLineString") {
        for (const line of g.coordinates) {
          const d = line.map((c) =>
            mercX(c[0], width).toFixed(2) + "," + mercY(c[1], height).toFixed(2)
          ).join(" ");
          parts.push('<polyline points="' + d + '"' + attrs + "/>");
        }
      } else if (g.type === "Polygon") {
        for (const ring of g.coordinates) {
          const d = ring.map((c) =>
            mercX(c[0], width).toFixed(2) + "," + mercY(c[1], height).toFixed(2)
          ).join(" ");
          parts.push('<polygon points="' + d + '"' + attrs + "/>");
        }
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) {
          for (const ring of poly) {
            const d = ring.map((c) =>
              mercX(c[0], width).toFixed(2) + "," + mercY(c[1], height).toFixed(2)
            ).join(" ");
            parts.push('<polygon points="' + d + '"' + attrs + "/>");
          }
        }
      }
    }

    parts.push("</g>");
    if (opts.footer) {
      const lines = String(opts.footer).split("\n");
      lines.forEach((ln, i) => {
        parts.push('<text x="12" y="' + (height - 14 + i * 16) +
          '" font-family="system-ui,sans-serif" font-size="12" fill="#e2e8f0">' +
          escapeXml(ln) + "</text>");
      });
    }
    parts.push("</svg>");
    return parts.join("\n");
  };

  // ═══════════════════════════════════════════════════════════════════
  // ZIP (store-only)
  // ═══════════════════════════════════════════════════════════════════

  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    const time =
      (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
    const date =
      ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: date & 0xffff };
  }

  /**
   * opts = { files: [{ name, data: Uint8Array | string }], date?: Date }
   * Returns a Uint8Array (the ZIP bytes).
   *
   * Entries are STORED (uncompressed) unless a `compressed` payload is
   * supplied — see writeZIPAsync(), which deflates with the platform's
   * own CompressionStream. A GeoTIFF of the whole world is mostly
   * zeroes, so the difference is worth several megabytes.
   */
  E.writeZIP = function writeZIP(opts) {
    const files = opts.files || [];
    const stamp = dosDateTime(opts.date || new Date());
    const enc = new TextEncoder();

    const entries = files.map((f) => {
      const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const nameBytes = enc.encode(f.name);
      // The CRC is always of the UNCOMPRESSED data — that is what the
      // format says, and it is what the reader checks.
      const crc = crc32(raw);
      if (f.compressed && f.compressed.length) {
        return {
          nameBytes: nameBytes,
          data: f.compressed,
          crc: crc,
          method: 8,
          usize: raw.length,
        };
      }
      return {
        nameBytes: nameBytes,
        data: raw,
        crc: crc,
        method: 0,
        usize: raw.length,
      };
    });

    // Local headers + data.
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const e of entries) {
      const local = new Uint8Array(30 + e.nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0x0800, true);      // UTF-8 filename
      lv.setUint16(8, e.method, true);    // stored | deflate
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, e.crc, true);
      lv.setUint32(18, e.data.length, true);
      lv.setUint32(22, e.usize, true);
      lv.setUint16(26, e.nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(e.nameBytes, 30);

      localChunks.push(local, e.data);

      const central = new Uint8Array(46 + e.nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, e.method, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, e.crc, true);
      cv.setUint32(20, e.data.length, true);
      cv.setUint32(24, e.usize, true);
      cv.setUint16(28, e.nameBytes.length, true);
      cv.setUint16(30, 0, true);          // extra
      cv.setUint16(32, 0, true);          // comment
      cv.setUint16(34, 0, true);          // disk
      cv.setUint16(36, 0, true);          // internal attrs
      cv.setUint32(38, 0, true);          // external attrs
      cv.setUint32(42, offset, true);     // local header offset
      central.set(e.nameBytes, 46);
      centralChunks.push(central);

      offset += local.length + e.data.length;
    }

    const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of localChunks) { out.set(c, p); p += c.length; }
    for (const c of centralChunks) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
  };

  // Deflate with the platform's own compressor. `deflate-raw` is the
  // exact stream a ZIP entry needs (no zlib wrapper). Returns null
  // where CompressionStream is not available, and the caller stores
  // the file uncompressed instead.
  E.deflateRaw = async function deflateRaw(bytes) {
    try {
      if (typeof CompressionStream === "undefined") return null;
      const cs = new CompressionStream("deflate-raw");
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const chunks = [];
      const reader = cs.readable.getReader();
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let p = 0;
      for (const c of chunks) { out.set(c, p); p += c.length; }
      // Compression that made it BIGGER is not worth it.
      return out.length < bytes.length ? out : null;
    } catch (_) {
      return null;
    }
  };

  /**
   * A ZIP with deflated entries, falling back to stored ones where the
   * platform has no CompressionStream (or where compression would not
   * help).
   */
  E.writeZIPAsync = async function writeZIPAsync(opts) {
    const enc = new TextEncoder();
    const files = [];
    for (const f of opts.files || []) {
      const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const compressed = await E.deflateRaw(raw);
      files.push({
        name: f.name,
        data: raw,
        compressed: compressed || undefined,
      });
    }
    return E.writeZIP({ files: files, date: opts.date });
  };

  // ═══════════════════════════════════════════════════════════════════
  // A small text file bundle — the licence/README that must travel with
  // every export.
  // ═══════════════════════════════════════════════════════════════════

  E.writeAttributionText = function writeAttributionText(opts) {
    const lines = [];
    lines.push("XYZO MAP EXPORT");
    lines.push("===============");
    lines.push("");
    if (opts.generated) lines.push("Generated: " + opts.generated);
    if (opts.scope) lines.push("Scope: " + opts.scope);
    if (opts.extent) {
      lines.push(
        "Extent: " + opts.extent.map((n) => n.toFixed(4)).join(", ") +
        "  (EPSG:4326 — west, south, east, north)"
      );
    }
    lines.push("");
    lines.push("SOURCES AND LICENCES");
    lines.push("--------------------");
    for (const s of opts.sources || []) {
      lines.push("• " + s.name);
      if (s.attribution) lines.push("    " + s.attribution);
      if (s.licence) lines.push("    Licence: " + s.licence);
      if (s.source) lines.push("    Source: " + s.source);
      if (s.period) lines.push("    Period: " + s.period);
      lines.push("");
    }
    lines.push("");
    lines.push("These datasets are made available under their own terms. This");
    lines.push("export is a derivative and carries the attribution and licence of");
    lines.push("every source it contains. Redistribution must respect the terms");
    lines.push("above — in particular the ShareAlike terms of any CC BY-SA source.");
    lines.push("");
    lines.push("Full audit: https://xyzo.org/ (docs/DATA_LICENCES.md)");
    lines.push("Map: https://xyzo.org/");
    return lines.join("\n");
  };

  E.escapeXml = escapeXml;
})();
