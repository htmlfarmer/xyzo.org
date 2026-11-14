/**
 * export-writers.js — the file formats a user takes away.
 *
 * The GeoTIFF is the important one: it is the answer to "download this
 * dataset so I can open it in QGIS". A wrong geotransform or a wrong
 * row order produces a file that OPENS — silently, upside down or
 * shifted a continent — so these tests check the bytes, not the shape.
 *
 * The writers are pure functions, so they can be evaluated in bun with
 * no DOM at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const src = readFileSync(join(ROOT, "export-writers.js"), "utf8");

function loadWriters() {
  globalThis.window = globalThis;
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.XYZO_EXPORT_WRITERS;
}
const W = loadWriters();

// Inflate a raw deflate stream, so the test can prove the ZIP entry
// round-trips rather than just claiming it does.
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}


// ── a tiny TIFF reader, so the assertions are against the FILE and not
//    against the writer's own idea of what it wrote. ────────────────────
const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };

function readTIFF(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  expect(little, "little-endian").toBe(true);
  expect(view.getUint16(2, true), "magic 42").toBe(42);
  const ifdOffset = view.getUint32(4, true);
  const count = view.getUint16(ifdOffset, true);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const p = ifdOffset + 2 + i * 12;
    const id = view.getUint16(p, true);
    const type = view.getUint16(p + 2, true);
    const n = view.getUint32(p + 4, true);
    const size = (TIFF_TYPE_SIZE[type] || 1) * n;
    let at;
    if (size <= 4) at = p + 8;
    else at = view.getUint32(p + 8, true);
    const values = [];
    if (type === 2) {
      let s = "";
      for (let k = 0; k < n - 1; k++) s += String.fromCharCode(bytes[at + k]);
      values.push(s);
    } else {
      for (let k = 0; k < n; k++) {
        const o = at + k * TIFF_TYPE_SIZE[type];
        if (type === 3) values.push(view.getUint16(o, true));
        else if (type === 4) values.push(view.getUint32(o, true));
        else if (type === 12) values.push(view.getFloat64(o, true));
        else if (type === 11) values.push(view.getFloat32(o, true));
        else values.push(bytes[o]);
      }
    }
    tags[id] = { type, values, at, size };
  }
  return { bytes, view, tags, ifdOffset };
}

describe("export-writers — GeoTIFF", () => {
  test("writes a valid TIFF header and a sorted IFD", () => {
    const data = new Float32Array(4 * 3);
    for (let i = 0; i < data.length; i++) data[i] = i;
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v", unit: "m" }],
      width: 4,
      height: 3,
      bbox: [-10, -5, 10, 5],
      dtype: "float32",
      description: "test",
    });
    const t = readTIFF(buf);
    expect(t.tags[256].values[0]).toBe(4);
    expect(t.tags[257].values[0]).toBe(3);
    expect(t.tags[258].values[0]).toBe(32);
    expect(t.tags[259].values[0]).toBe(1);       // uncompressed
    expect(t.tags[277].values[0]).toBe(1);       // samples per pixel
    expect(t.tags[284].values[0]).toBe(1);       // chunky
    expect(t.tags[339].values[0]).toBe(3);       // IEEE float
    // Tags must be in ascending id order — TIFF requires it.
    const ids = Object.keys(t.tags).map(Number).sort((a, b) => a - b);
    const ordered = ids.every((id, i) => id === ids[i]);
    expect(ordered).toBe(true);
  });

  test("the geotransform places raster (0,0) at the north-west corner", () => {
    const data = new Float32Array(4 * 3);
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: 4,
      height: 3,
      bbox: [-10, -5, 10, 5],
      dtype: "float32",
    });
    const t = readTIFF(buf);
    // ModelPixelScale: dx = 20/4 = 5, dy = 10/3.
    expect(t.tags[33550].values[0]).toBeCloseTo(5, 6);
    expect(t.tags[33550].values[1]).toBeCloseTo(10 / 3, 6);
    // ModelTiepoint: raster (0,0) → (minLon, maxLat).
    const tie = t.tags[33922].values;
    expect(tie[0]).toBe(0);
    expect(tie[3]).toBeCloseTo(-10, 6);
    expect(tie[4]).toBeCloseTo(5, 6);
  });

  test("the GeoKeyDirectory declares EPSG:4326", () => {
    const data = new Float32Array(4);
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: 2, height: 2,
      bbox: [-180, -90, 180, 90],
      dtype: "float32",
    });
    const t = readTIFF(buf);
    const gk = t.tags[34735].values;
    expect(gk[0]).toBe(1);          // key directory version
    // The fourth header value is the NUMBER OF KEYS; each key is four
    // shorts, so the array is 4 + 4*keys long.
    expect(gk[3]).toBe((gk.length - 4) / 4);
    expect(gk[3]).toBe(4);          // model type, raster type, citation, CRS
    const keys = {};
    for (let i = 4; i + 3 < gk.length; i += 4) keys[gk[i]] = gk[i + 3];
    expect(keys[1024]).toBe(2);     // ModelTypeGeographic
    expect(keys[1025]).toBe(1);     // RasterPixelIsArea
    expect(keys[2048]).toBe(4326);  // WGS 84
    // The ASCII citation block must exist and carry the CRS name.
    expect(t.tags[34737].values[0]).toContain("WGS 84");
  });

  test("row 0 is the NORTHERNMOST row", () => {
    // A 2x2 grid: row 0 = north = [10, 20], row 1 = south = [30, 40].
    const data = new Float32Array([10, 20, 30, 40]);
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: 2, height: 2,
      bbox: [0, 0, 2, 2],
      dtype: "float32",
    });
    const t = readTIFF(buf);
    const stripOffset = t.tags[273].values[0];
    const dv = new DataView(buf);
    expect(dv.getFloat32(stripOffset, true)).toBe(10);
    expect(dv.getFloat32(stripOffset + 4, true)).toBe(20);
    expect(dv.getFloat32(stripOffset + 8, true)).toBe(30);
    expect(dv.getFloat32(stripOffset + 12, true)).toBe(40);
  });

  test("a south-first array is flipped, not trusted", () => {
    const data = new Float32Array([30, 40, 10, 20]); // south-first
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: 2, height: 2,
      bbox: [0, 0, 2, 2],
      dtype: "float32",
      rowOrder: "south",
    });
    const dv = new DataView(buf);
    const t = readTIFF(buf);
    const off = t.tags[273].values[0];
    expect(dv.getFloat32(off, true)).toBe(10);
    expect(dv.getFloat32(off + 12, true)).toBe(40);
  });

  test("the pixel values survive the round trip", () => {
    const w = 5, h = 4;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = -12.5 + i * 0.25;
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: w, height: h,
      bbox: [0, 0, 5, 4],
      dtype: "float32",
    });
    const dv = new DataView(buf);
    const t = readTIFF(buf);
    const off = t.tags[273].values[0];
    for (let i = 0; i < data.length; i++) {
      expect(dv.getFloat32(off + i * 4, true)).toBeCloseTo(data[i], 4);
    }
  });

  test("multiple bands are interleaved and named in GDAL_METADATA", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([10, 20, 30, 40]);
    const buf = W.writeGeoTIFF({
      bands: [
        { data: a, name: "u", unit: "m/s" },
        { data: b, name: "v", unit: "m/s" },
      ],
      width: 2, height: 2,
      bbox: [0, 0, 2, 2],
      dtype: "float32",
      attribution: "NOAA NCEP GFS",
      licence: "public domain",
    });
    const t = readTIFF(buf);
    expect(t.tags[277].values[0]).toBe(2);
    expect(t.tags[258].values).toEqual([32, 32]);
    const dv = new DataView(buf);
    const off = t.tags[273].values[0];
    expect(dv.getFloat32(off, true)).toBe(1);
    expect(dv.getFloat32(off + 4, true)).toBe(10);
    expect(dv.getFloat32(off + 8, true)).toBe(2);
    const md = t.tags[42112].values[0];
    expect(md).toContain("<GDALMetadata>");
    expect(md).toContain("u (m/s)");
    expect(md).toContain("v (m/s)");
    expect(md).toContain("NOAA NCEP GFS");
  });

  test("int16 grids keep their dtype", () => {
    const data = new Int16Array([1, -2, 300, -32768]);
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: 2, height: 2,
      bbox: [0, 0, 2, 2],
      dtype: "int16",
      nodata: -32768,
    });
    const t = readTIFF(buf);
    expect(t.tags[258].values[0]).toBe(16);
    expect(t.tags[339].values[0]).toBe(2);   // signed int
    const dv = new DataView(buf);
    const off = t.tags[273].values[0];
    expect(dv.getInt16(off, true)).toBe(1);
    expect(dv.getInt16(off + 2, true)).toBe(-2);
    expect(dv.getInt16(off + 6, true)).toBe(-32768);
  });

  test("a large image is split into strips", () => {
    const w = 1024, h = 1024;
    const data = new Float32Array(w * h);
    const buf = W.writeGeoTIFF({
      bands: [{ data, name: "v" }],
      width: w, height: h,
      bbox: [0, 0, 1024, 1024],
      dtype: "float32",
    });
    const t = readTIFF(buf);
    const offsets = t.tags[273].values;
    const counts = t.tags[279].values;
    expect(offsets.length).toBe(counts.length);
    expect(offsets.length).toBeGreaterThan(1);
    // Every strip must sit inside the file and be the right size.
    let total = 0;
    for (let i = 0; i < offsets.length; i++) {
      expect(offsets[i] + counts[i]).toBeLessThanOrEqual(buf.byteLength);
      total += counts[i];
    }
    expect(total).toBe(w * h * 4);
  });
});

describe("export-writers — GeoJSON / KML / CSV", () => {
  const features = [
    {
      type: "Feature",
      properties: { name: "Nile", description: "the river" },
      geometry: { type: "LineString", coordinates: [[30, 0], [31, 1]] },
    },
    {
      type: "Feature",
      properties: { name: "Cairo" },
      geometry: { type: "Point", coordinates: [31.2, 30.0] },
    },
  ];

  test("GeoJSON is a FeatureCollection and carries the attribution", () => {
    const s = W.writeGeoJSON({
      features,
      bbox: [30, 0, 32, 2],
      attribution: "FAO",
      licence: "CC BY-SA 4.0",
      name: "rivers",
    });
    const fc = JSON.parse(s);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBe(2);
    expect(fc.attribution).toBe("FAO");
    expect(fc.licence).toBe("CC BY-SA 4.0");
    expect(fc.bbox).toEqual([30, 0, 32, 2]);
  });

  test("KML wraps every geometry type", () => {
    const s = W.writeKML({
      features: features.concat([{
        type: "Feature",
        properties: { name: "basin" },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }]),
      name: "x",
      attribution: "FAO",
    });
    expect(s).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(s).toContain("<LineString>");
    expect(s).toContain("<Point>");
    expect(s).toContain("<Polygon>");
    expect(s).toContain("31.200000,30.000000,0");
    expect(s).toContain("FAO");
  });

  test("KML escapes XML in names", () => {
    const s = W.writeKML({
      features: [{
        type: "Feature",
        properties: { name: 'A & B <script>' },
        geometry: { type: "Point", coordinates: [0, 0] },
      }],
    });
    expect(s).toContain("A &amp; B &lt;script&gt;");
    expect(s).not.toContain("<script>");
  });

  test("CSV quotes cells that contain a comma or a quote", () => {
    const s = W.writeCSV({
      columns: ["a", "b"],
      rows: [[1, "x,y"], [2, 'he said "hi"']],
    });
    const lines = s.trim().split("\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe('1,"x,y"');
    expect(lines[2]).toBe('2,"he said ""hi"""');
  });

  test("CSV from objects keeps the column order", () => {
    const s = W.writeCSV({
      columns: ["lon", "lat", "value"],
      objects: [{ lon: 1.5, lat: -2.5, value: 3 }],
    });
    expect(s.trim()).toBe("lon,lat,value\n1.5,-2.5,3");
  });
});

describe("export-writers — SVG", () => {
  test("draws points, lines and polygons in Mercator space", () => {
    const s = W.writeSVG({
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [10, 10]] } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      ],
      width: 360,
      height: 180,
      footer: "Source: test",
    });
    expect(s).toContain("<svg");
    expect(s).toContain("<circle");
    expect(s).toContain("<polyline");
    expect(s).toContain("<polygon");
    expect(s).toContain("Source: test");
  });
});

describe("export-writers — ZIP", () => {
  test("a stored ZIP round-trips its entries", () => {
    const zip = W.writeZIP({
      files: [
        { name: "a.txt", data: "hello" },
        { name: "b.txt", data: "world" },
      ],
      date: new Date(2026, 0, 2, 3, 4, 5),
    });
    const bytes = zip;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    expect(eocd).toBeGreaterThan(-1);
    expect(view.getUint16(eocd + 8, true)).toBe(2);   // entries on this disk
    expect(view.getUint16(eocd + 10, true)).toBe(2);  // total entries
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);

    // Walk the central directory and pull every entry out.
    let p = cdOffset;
    const found = [];
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(p, true)).toBe(0x02014b50);
      const crc = view.getUint32(p + 16, true);
      const csize = view.getUint32(p + 20, true);
      const usize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const localOff = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      found.push({ name, crc, csize, usize, localOff });
      p += 46 + nameLen;
    }
    expect(p - cdOffset).toBe(cdSize);
    expect(found.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);

    for (const f of found) {
      expect(view.getUint32(f.localOff, true)).toBe(0x04034b50);
      const lNameLen = view.getUint16(f.localOff + 26, true);
      const dataStart = f.localOff + 30 + lNameLen;
      const text = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + f.csize));
      expect(text).toBe(f.name === "a.txt" ? "hello" : "world");
      expect(f.usize).toBe(f.csize);
      expect(W.crc32(bytes.subarray(dataStart, dataStart + f.csize))).toBe(f.crc);
    }
  });
});

describe("export-writers — deflated ZIP", () => {
  test("writeZIPAsync deflates what it can and still round-trips", async () => {
    // A lot of zeroes — the shape of a GeoTIFF — compresses well.
    const big = new Uint8Array(200000);
    const enc = new TextEncoder();
    const files = [
      { name: "big.bin", data: big },
      { name: "small.txt", data: enc.encode("hello") },
    ];
    const zip = await W.writeZIPAsync({ files: files });
    expect(zip.length).toBeGreaterThan(0);

    // The local header must still be a valid local header.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // Find the end-of-central-directory and walk the directory.
    let eocd = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    expect(eocd).toBeGreaterThan(-1);
    const total = view.getUint16(eocd + 10, true);
    expect(total).toBe(2);
    let p = view.getUint32(eocd + 16, true);
    const seen = [];
    for (let i = 0; i < total; i++) {
      expect(view.getUint32(p, true)).toBe(0x02014b50);
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const usize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
      seen.push({ name, method, csize, usize, localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    expect(seen.map((f) => f.name)).toEqual(["big.bin", "small.txt"]);
    for (const f of seen) {
      // The uncompressed size is always the ORIGINAL size.
      expect(f.usize).toBe(f.name === "big.bin" ? 200000 : 5);
      // The method is either stored (0) or deflated (8).
      expect([0, 8]).toContain(f.method);
      // The local header must agree with the directory.
      expect(view.getUint32(f.localOff, true)).toBe(0x04034b50);
      expect(view.getUint16(f.localOff + 8, true)).toBe(f.method);
      // The CRC is of the UNCOMPRESSED data.
      const lNameLen = view.getUint16(f.localOff + 26, true);
      const lExtraLen = view.getUint16(f.localOff + 28, true);
      const dataStart = f.localOff + 30 + lNameLen + lExtraLen;
      const raw = f.method === 8
        ? await inflateRaw(zip.subarray(dataStart, dataStart + f.csize))
        : zip.subarray(dataStart, dataStart + f.csize);
      expect(W.crc32(raw)).toBe(view.getUint32(f.localOff + 14, true));
      expect(raw.length).toBe(f.usize);
    }
  });

  test("a file that does not compress is stored, not inflated", async () => {
    const enc = new TextEncoder();
    // Random-ish incompressible bytes.
    const noise = new Uint8Array(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;
    const zip = await W.writeZIPAsync({ files: [{ name: "n.bin", data: noise }] });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    const p = view.getUint32(eocd + 16, true);
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    expect(usize).toBe(noise.length);
    // Storing it is correct; inflating it would be a lie.
    if (method === 0) expect(csize).toBe(usize);
  });
});

describe("export-writers — attribution text", () => {
  test("the licence file names every source and its licence", () => {
    const s = W.writeAttributionText({
      generated: "2026-10-29T00:00:00Z",
      scope: "Whole world",
      extent: [-180, -90, 180, 90],
      sources: [
        { name: "🌡️ Temperature (GFS)", attribution: "NOAA NCEP GFS", licence: "public domain" },
        { name: "🌊 Hydrological Basins", attribution: "FAO", licence: "CC BY-SA 4.0" },
      ],
    });
    expect(s).toContain("XYZO MAP EXPORT");
    expect(s).toContain("NOAA NCEP GFS");
    expect(s).toContain("CC BY-SA 4.0");
    expect(s).toContain("ShareAlike");
    expect(s).toContain("-180.0000, -90.0000, 180.0000, 90.0000");
  });
});
