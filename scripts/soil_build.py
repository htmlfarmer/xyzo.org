#!/usr/bin/env python3
"""
Build the SoilGrids soil overlay assets served to the Xyzo map.

Source: ISRIC World Soil Information — SoilGrids 2.0 (CC BY 4.0)
  https://soilgrids.org/  ·  https://files.isric.org/soilgrids/latest/

The rasters are read straight off ISRIC's public WebDAV over HTTP range
requests (/vsicurl/), so nothing huge is downloaded: only the windows the
pyramid actually needs are fetched.

Outputs (all under public_html/data/soil/):

  {layer}/tiles/{z}/{x}/{y}.png   XYZ tile pyramid (EPSG:3857), PNG palette
  {layer}/grid.bin                Int16 probe grid, 0.1 deg, lat-major
  {layer}/meta.json               class table + grid geometry + attribution

Layers
  clay, sand, silt, phh2o, soc, bdod, cec
      Straight from SoilGrids. The class breaks and colours come from
      ISRIC's own SLD for that property, so the legend is the official
      one and cannot drift from the data.
  texture
      USDA soil-texture class derived from sand/silt/clay with the
      standard texture triangle.
  usda
      The 12 orders of the USDA Soil Taxonomy (OpenLandMap-soildb,
      30 m) — a DIFFERENT classification from SoilGrids' WRB groups,
      from a different publisher. Read from a Cloud-Optimised GeoTIFF
      over HTTP; classified through the publisher's own SLD, which
      maps ~818 subclass codes to the 12 parent orders.

Every layer is classified to a small palette, so a tile is a handful of
bytes and the whole pyramid fits in Caddy's cache.

Usage:
  python3 -m scripts.soil_build                  # every layer, zoom 0..7
  python3 -m scripts.soil_build --layers texture phh2o
  python3 -m scripts.soil_build --max-zoom 8
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import tempfile
import urllib.request

import numpy as np
from PIL import Image

try:
    from osgeo import gdal
except ImportError as exc:  # pragma: no cover
    print(f"GDAL python bindings required: {exc}", file=sys.stderr)
    raise

gdal.UseExceptions()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

WEBDAV = "https://files.isric.org/soilgrids/latest"
LEGEND_BASE = WEBDAV + "/legends"
AGG_BASE = WEBDAV + "/data_aggregated/1000m"
# WRB "most probable soil reference group" — a Byte class map (0..29,
# 255 = no soil), not one of the aggregated property rasters.
WRB_VRT = WEBDAV + "/data/wrb/MostProbable.vrt"
WRB_NODATA = 255
SLD_CACHE = os.path.join(SCRIPT_DIR, "soil_slds")

# USDA soil orders (OpenLandMap-soildb ensemble, 30 m) — a DIFFERENT
# taxonomy from WRB: the 12 orders of the USDA Soil Taxonomy, not the
# 34 WRB reference groups. One Cloud-Optimised GeoTIFF (32.6 GB, but
# read by window over HTTP through its own overviews), UInt16 subclass
# codes 0..817, 32767 = no prediction (hyper-arid sand seas, ocean,
# ice — the publisher's mask, not ours).
USDA_COG = ("https://ceph.opengeohub.org/arco/soildb/"
            "soildbst_ensemble_c_30m_sg_20000101_20221231_go01_"
            "epsg4326_v1.1.0_srl04.tif")
USDA_NODATA = 32767
# The publisher's style, which maps every subclass code to its parent
# order ("79" -> "1. Alfisols"). A DIFFERENT HOST from ISRIC's
# legends, so fetch_sld() takes a URL from this table when present.
SLD_URLS = {
    "usda": "https://s3.ecodatacube.eu/ifad/soil_order.sld",
}

TILE_SIZE = 256
# Web Mercator half-extent in metres.
HALF = 20037508.342789244
# Probe grid resolution in degrees.
GRID_DEG = 0.1
# SoilGrids "no data" marker.
NODATA = -32768

# ── the layers ───────────────────────────────────────────────────────────
# scale converts the raw SoilGrids value into the display unit.
# The raw units are the ones ISRIC's SLD names for each property.
PROPERTIES = {
    "clay": {
        "title": "Clay",
        "unit": "%",
        "scale": 0.1,          # raw g/kg -> %
        "decimals": 1,
        "blurb": "Clay content of the topsoil (0-5 cm).",
    },
    "sand": {
        "title": "Sand",
        "unit": "%",
        "scale": 0.1,          # raw g/kg -> %
        "decimals": 1,
        "blurb": "Sand content of the topsoil (0-5 cm).",
    },
    "silt": {
        "title": "Silt",
        "unit": "%",
        "scale": 0.1,          # raw g/kg -> %
        "decimals": 1,
        "blurb": "Silt content of the topsoil (0-5 cm).",
    },
    "phh2o": {
        "title": "pH",
        "unit": "pH",
        "scale": 0.1,          # raw pH*10 -> pH
        "decimals": 1,
        "blurb": "Soil pH in water — the acidity/alkalinity of the topsoil.",
    },
    "soc": {
        "title": "Organic carbon",
        "unit": "% OC",
        "scale": 0.01,         # raw dg/kg -> %
        "decimals": 2,
        "blurb": "Soil organic carbon in the topsoil (0-5 cm).",
    },
    "bdod": {
        "title": "Bulk density",
        "unit": "g/cm³",
        "scale": 0.01,         # raw cg/cm3 -> g/cm3
        "decimals": 2,
        "blurb": "Bulk density — how tightly the soil particles are packed.",
    },
    "cec": {
        "title": "CEC",
        "unit": "cmol/kg",
        "scale": 0.1,          # raw mmol(c)/kg -> cmol/kg
        "decimals": 1,
        "blurb": "Cation exchange capacity — how much nutrient a soil can hold.",
    },
}

# USDA soil texture classes (the standard texture triangle).
TEXTURE_CLASSES = [
    ("sand", "Sand", "#f4e4c1"),
    ("loamy sand", "Loamy sand", "#efd9a8"),
    ("sandy loam", "Sandy loam", "#e3c98d"),
    ("loam", "Loam", "#d8bd78"),
    ("silt loam", "Silt loam", "#c9b573"),
    ("silt", "Silt", "#bfb271"),
    ("sandy clay loam", "Sandy clay loam", "#d9a05b"),
    ("clay loam", "Clay loam", "#c1823f"),
    ("silty clay loam", "Silty clay loam", "#b06f33"),
    ("sandy clay", "Sandy clay", "#e08c3c"),
    ("silty clay", "Silty clay", "#a76030"),
    ("clay", "Clay", "#8f4f2c"),
]

# Probe points: (lat, lng, [(check, ...)]).
#
#   ("abs", prop, lo, hi)   the value at that point must be within [lo, hi]
#   ("gt", prop, other)     prop at that point must be GREATER than other
#   ("lt", prop, other)     prop at that point must be LESS than other
#
# The bounds are in display units (%, pH, ...). They are deliberately
# loose: the point of the gate is to catch a wrong warp (flipped axis,
# shifted origin, wrong tile order) — not to second-guess SoilGrids.
# A flipped or shifted map still produces plausible-looking numbers, so
# the relative checks are what actually bite.
SOIL_PROBES = [
    # Sahara — sand dominated, alkaline
    (23.0, 12.0, [("abs", "clay", 0, 25), ("abs", "sand", 40, 100),
                  ("abs", "phh2o", 6.0, 9.0), ("gt", "sand", "clay")]),
    # Amazon basin — deep weathered clay-rich soil, acidic
    (-3.0, -60.0, [("abs", "clay", 15, 60), ("abs", "phh2o", 3.5, 6.5)]),
    # Netherlands — heavy marine clay
    (52.0, 5.0, [("abs", "clay", 15, 60), ("abs", "phh2o", 5.0, 8.5)]),
    # Munich — loamy, slightly acidic
    (48.1, 11.6, [("abs", "clay", 10, 45), ("abs", "phh2o", 5.0, 8.5)]),
    # Siberia — cold, low clay
    (64.0, 100.0, [("abs", "clay", 0, 35)]),
    # Central Australia — sandy
    (-25.0, 135.0, [("abs", "sand", 40, 100)]),
    # Peru — arid, sandy
    (-12.0, -77.0, [("abs", "sand", 30, 100)]),
    # Ganges delta — clay
    (22.5, 88.0, [("abs", "clay", 15, 60)]),
    # Po delta — clay
    (45.0, 10.5, [("abs", "clay", 15, 60)]),
    # South Greenland — thin, sandy soils (the ice sheet itself has none)
    (61.0, -43.0, [("abs", "clay", 0, 20)]),
]


def log(msg: str) -> None:
    print(f"[soil] {msg}", flush=True)


# ── SLD (official class breaks + colours) ───────────────────────────────

def fetch_sld(prop: str) -> str:
    """The publisher's own legend for a property, with an offline fallback.

    Most properties are ISRIC's; `usda` comes from OpenGeoHub's SLD_URLS
    entry because it is a different dataset on a different host.
    """
    os.makedirs(SLD_CACHE, exist_ok=True)
    cached = os.path.join(SLD_CACHE, f"{prop}.sld")
    url = SLD_URLS.get(prop) or f"{LEGEND_BASE}/{prop}.sld"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            text = resp.read().decode("utf-8", "replace")
        with open(cached, "w") as fh:
            fh.write(text)
        return text
    except Exception as exc:  # pragma: no cover - network hiccup
        if os.path.exists(cached):
            log(f"{prop}: legend fetch failed ({exc}); using the cached copy")
            with open(cached) as fh:
                return fh.read()
        raise


def parse_sld(sld: str, drop=frozenset({NODATA})):
    """SLD ColorMap -> [(quantity, hex_color, label)].

    Interval maps (the property SLDs) are of type "intervals": an entry
    covers [previous quantity, quantity). Value maps (wrb.sld) are of
    type "values": the quantity IS the class id. Entries in `drop` (the
    NODATA markers — -32768 for the property rasters, 255 for WRB) are
    removed either way.
    """
    entries = []
    # The namespace prefix is optional: ISRIC writes <ColorMapEntry>,
    # OpenGeoHub writes <sld:ColorMapEntry>. Matching only the bare tag
    # silently parses ZERO entries from the latter — and an empty colour
    # map then fails much later as "no colour map for usda".
    for m in re.finditer(r"<(?:\w+:)?ColorMapEntry([^>]*)/>", sld):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if "quantity" not in attrs:
            continue
        qty = int(attrs["quantity"])
        if qty in drop:
            continue
        colour = attrs.get("color", "#ffffff")
        entries.append((qty, colour.lower(), attrs.get("label", str(qty))))
    entries.sort(key=lambda e: e[0])
    return entries


def hex_to_rgb(colour: str):
    c = colour.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


# ── sources ──────────────────────────────────────────────────────────────

def source_url(prop: str) -> str:
    if prop == "wrb":
        return WRB_VRT
    if prop == "usda":
        return USDA_COG
    return f"{AGG_BASE}/{prop}/{prop}_0-5cm_mean_1000.tif"


def open_source(prop: str):
    """Open a SoilGrids raster over HTTP (range requests)."""
    url = source_url(prop)
    path = "/vsicurl/" + url
    gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    # The WRB map is a VRT that fans out to its GeoTIFF tiles — both
    # extensions have to be allowed or Open() 404s on the wrapper.
    exts = ".vrt,.tif" if prop == "wrb" else ".tif"
    gdal.SetConfigOption("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", exts)
    gdal.SetConfigOption("GDAL_HTTP_MULTIRANGE", "YES")
    gdal.SetConfigOption("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
    ds = gdal.Open(path)
    if ds is None:
        raise RuntimeError(f"cannot open {url}")
    return ds


# ── warping ──────────────────────────────────────────────────────────────

def warp_to_mercator(src_ds, size: int, out_path: str, *,
                     resample=gdal.GRA_Average,
                     nodata: int = NODATA,
                     dtype=gdal.GDT_Int16) -> str:
    """Warp a SoilGrids band to a Web Mercator master raster of `size` px.

    AVERAGE resampling is the honest interpolation for a continuous soil
    property. Categorical inputs (WRB class ids) must pass
    resample=GRA_NearestNeighbour — averaging class numbers produces
    ids that do not exist.
    """
    opts = gdal.WarpOptions(
        format="GTiff",
        outputBounds=(-HALF, -HALF, HALF, HALF),
        width=size,
        height=size,
        dstSRS="EPSG:3857",
        srcNodata=nodata,
        dstNodata=nodata,
        resampleAlg=resample,
        multithread=True,
        warpMemoryLimit=512 * 1024 * 1024,
        outputType=dtype,
        creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=2", "TILED=YES", "BIGTIFF=YES"],
    )
    gdal.Warp(out_path, src_ds, options=opts)
    return out_path


def warp_to_grid(src_ds, out_path: str, *,
                 resample=gdal.GRA_Average,
                 nodata: int = NODATA,
                 dtype=gdal.GDT_Int16) -> str:
    """Warp to the 0.1 deg probe grid (EPSG:4326, lat-major on disk)."""
    width = int(360 / GRID_DEG)
    height = int(180 / GRID_DEG)
    opts = gdal.WarpOptions(
        format="GTiff",
        outputBounds=(-180.0, -90.0, 180.0, 90.0),
        width=width,
        height=height,
        dstSRS="EPSG:4326",
        srcNodata=nodata,
        dstNodata=nodata,
        resampleAlg=resample,
        multithread=True,
        warpMemoryLimit=512 * 1024 * 1024,
        outputType=dtype,
        creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=2", "TILED=YES"],
    )
    gdal.Warp(out_path, src_ds, options=opts)
    return out_path


# ── classification ───────────────────────────────────────────────────────

def classify_by_breaks(values: np.ndarray, quantities: np.ndarray) -> np.ndarray:
    """Raw value -> class index (0 = no data).

    The SLD colour map is an interval map: entry k covers
    [quantities[k-1], quantities[k]). So the covering entry is the first
    one whose quantity is GREATER than the value, and the class number
    is that entry's 1-based position.
    """
    out = np.zeros(values.shape, dtype=np.uint8)
    valid = values != NODATA
    if not valid.any():
        return out
    # The covering entry is the first one whose quantity is GREATER than
    # the value — its 1-based position is the class number.
    idx = np.searchsorted(quantities, values[valid], side="right")
    idx = np.clip(idx, 1, len(quantities) - 1)
    out[valid] = idx.astype(np.uint8)
    return out


def texture_class(sand: np.ndarray, silt: np.ndarray, clay: np.ndarray) -> np.ndarray:
    """USDA soil texture class from sand/silt/clay percentages.

    The triangle thresholds follow the standard USDA decision rules
    (as used by the FAO and the R `soiltexture` package): the coarse
    fraction decides between the sand, loam and clay families, the fine
    fraction then splits each family.
    """
    s = sand.astype(np.float32)
    si = silt.astype(np.float32)
    c = clay.astype(np.float32)
    total = s + si + c
    valid = (total > 0) & (s != NODATA) & (si != NODATA) & (c != NODATA)

    # normalise to percentages of the sum (guards against small gaps)
    with np.errstate(invalid="ignore", divide="ignore"):
        s = np.where(valid, s / total * 100.0, 0.0)
        si = np.where(valid, si / total * 100.0, 0.0)
        c = np.where(valid, c / total * 100.0, 0.0)

    out = np.zeros(s.shape, dtype=np.uint8)  # 0 = no data

    # ── sand family: sand >= 85 -> sand; >= 70 -> loamy sand ───────────
    sand_fam = valid & (s >= 85)
    out[sand_fam] = 1
    sand_fam = valid & (s >= 70) & (s < 85)
    out[sand_fam] = 2

    # ── loam family: sand < 70 and clay < 35 ──────────────────────────
    loam_fam = valid & (s < 70) & (c < 35)
    # loam: silt < 40 and silt >= 19 (USDA "L" band)
    out[loam_fam & (si < 40) & (si >= 19)] = 4  # loam
    out[loam_fam & (si >= 40) & (c >= 20)] = 6  # silty clay loam
    out[loam_fam & (si >= 40) & (c < 20)] = 5  # silt loam
    out[loam_fam & (si < 40) & (si >= 19) & (c >= 27)] = 8  # clay loam
    out[loam_fam & (si < 19)] = 3  # sandy loam

    # ── clay family: clay >= 35 ───────────────────────────────────────
    clay_fam = valid & (c >= 35) & (s >= 45)
    out[clay_fam] = 10  # sandy clay
    clay_fam = valid & (c >= 35) & (s < 45)
    out[clay_fam & (si >= 40)] = 11  # silty clay
    out[clay_fam & (si < 40)] = 12  # clay

    # ── sandy clay loam: loam family with more sand ───────────────────
    sandy_clay_loam = valid & (s >= 45) & (c >= 20) & (c < 35)
    out[sandy_clay_loam] = 7

    return out


# ── tiling ───────────────────────────────────────────────────────────────

def palette_from_classes(entries):
    """[(quantity, colour, label)] -> (rgba table, class metadata).

    Entry k covers [entries[k-1].quantity, entries[k].quantity). Entry 0
    covers everything below entries[0].quantity, which is nothing for a
    non-negative property, so it is not published as a class.
    """
    table = [(0, 0, 0, 0)]  # index 0 = transparent
    classes = []
    for k in range(1, len(entries)):
        qty, colour, label = entries[k]
        prev = entries[k - 1][0]
        r, g, b = hex_to_rgb(colour)
        table.append((r, g, b, 255))
        classes.append({
            "index": k,
            "color": colour,
            "min": prev,
            "max": qty,
            "label": label,
        })
    return table, classes


def palette_from_values(entries):
    """Value-colormap SLD (wrb.sld) -> (rgba table, class metadata).

    The quantity IS the class id (0..29 after NODATA is dropped), not an
    interval break. Palette index 0 stays transparent (no soil), so class
    id q is stored as pixel value q + 1.
    """
    table = [(0, 0, 0, 0)]
    classes = []
    for qty, colour, label in entries:
        r, g, b = hex_to_rgb(colour)
        table.append((r, g, b, 255))
        classes.append({
            "index": qty + 1,
            "class_id": qty,
            "color": colour,
            "label": label,
        })
    return table, classes


def write_tiles(idx: np.ndarray, out_dir: str, z: int, table) -> int:
    """Slice a master class raster into 256 px PNG tiles.

    Empty tiles (class 0 everywhere) are skipped — the ocean and the
    parts of the world SoilGrids does not cover stay transparent, and a
    missing tile renders as nothing anyway.
    """
    size = idx.shape[0]
    count = size // TILE_SIZE
    written = 0
    # PIL's palette is RGB triplets only — the alpha of the "no data"
    # index is carried by the PNG transparency entry, not by the palette.
    pal = []
    for rgba in table:
        pal.extend(rgba[:3])
    # pad the palette to 256 entries
    while len(pal) < 768:
        pal.extend([0, 0, 0])

    for ty in range(count):
        row = idx[ty * TILE_SIZE:(ty + 1) * TILE_SIZE]
        # a whole row of tiles that is empty costs nothing
        if not row.any():
            continue
        for tx in range(count):
            block = row[:, tx * TILE_SIZE:(tx + 1) * TILE_SIZE]
            if not block.any():
                continue
            img = Image.fromarray(block, mode="P")
            img.putpalette(pal)
            img.info["transparency"] = bytes([0])
            path = os.path.join(out_dir, str(z), str(tx), f"{ty}.png")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            img.save(path, optimize=True)
            written += 1
    return written


def build_pyramid(layers, out_root: str, max_zoom: int, tmpdir: str) -> dict:
    """Build one layer: tiles + probe grid + meta."""
    key = layers["key"]
    out_dir = os.path.join(out_root, key)
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    props = layers["props"]          # list of raw property keys
    table = layers["table"]          # rgba table (index 0 = transparent)
    classes = layers["classes"]      # class metadata

    # Warp every input once per zoom level, then classify and slice.
    # Categorical layers warp with NEAREST — averaging 3 and 4 to make
    # 3.5 invents a class that does not exist — each with its own
    # nodata marker and dtype (WRB is Byte/255; USDA orders are
    # UInt16/32767). Continuous properties average, as before.
    for z in range(max_zoom, -1, -1):
        size = TILE_SIZE * (2 ** z)
        warps = []
        for p in props:
            ds = open_source(p)
            path = os.path.join(tmpdir, f"{key}_{p}_{z}.tif")
            if key == "wrb":
                warp_to_mercator(ds, size, path,
                                 resample=gdal.GRA_NearestNeighbour,
                                 nodata=WRB_NODATA, dtype=gdal.GDT_Byte)
            elif key == "usda":
                warp_to_mercator(ds, size, path,
                                 resample=gdal.GRA_NearestNeighbour,
                                 nodata=USDA_NODATA, dtype=gdal.GDT_UInt16)
            else:
                warp_to_mercator(ds, size, path)
            ds = None
            warps.append(path)

        idx = classify_layers(layers, warps)

        written = write_tiles(idx, os.path.join(out_dir, "tiles"), z, table)
        for path in warps:
            os.remove(path)
        log(f"{key}: zoom {z} -> {written} tiles")
        del idx, warps

    # ── probe grid ────────────────────────────────────────────────────
    grid_path = os.path.join(out_dir, "grid.bin")
    write_probe_grid(layers, grid_path, tmpdir)

    meta = {
        "key": key,
        "title": layers["title"],
        "unit": layers["unit"],
        "scale": layers["scale"],
        "decimals": layers["decimals"],
        "blurb": layers.get("blurb", ""),
        "classes": classes,
        "grid": {
            "width": int(360 / GRID_DEG),
            "height": int(180 / GRID_DEG),
            "degrees": GRID_DEG,
            "nodata": layers.get("grid_nodata", NODATA),
            "dtype": "int16",
        },
        "source": layers["source"],
        "attribution": layers["attribution"],
        "license": "CC BY 4.0",
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    return meta


# Rows per classification strip. The master raster at zoom 7 is
# 32768² px: a whole band is 2 GiB as Int16, and the texture path would
# additionally hold three float32 copies of it (~20 GiB peak) — more
# than the box has. Strips keep the peak at the output raster alone.
STRIP_ROWS = 512


def classify_layers(layers, warp_paths) -> np.ndarray:
    """Class index raster for a layer from its warped inputs.

    Inputs are read in horizontal strips, never whole: at zoom 7 one
    band is 2 GiB and the texture classifier wants float32 copies of
    three of them. Identical output to classifying in one call — the
    breaks and the texture triangle are per-pixel.
    """
    dss = [gdal.Open(p) for p in warp_paths]
    try:
        width, height = dss[0].RasterXSize, dss[0].RasterYSize
        for ds in dss:
            if (ds.RasterXSize, ds.RasterYSize) != (width, height):
                raise ValueError("warped inputs differ in size")
        out = np.zeros((height, width), dtype=np.uint8)
        quantities = np.array(layers["quantities"], dtype=np.int32)

        for y0 in range(0, height, STRIP_ROWS):
            rows = min(STRIP_ROWS, height - y0)
            bands = [ds.GetRasterBand(1).ReadAsArray(0, y0, width, rows)
                     for ds in dss]
            if layers["key"] == "wrb":
                # Byte class ids: 0..29 real, 255 no soil. Publish as
                # 1..30 so palette index 0 can stay transparent.
                v = bands[0]
                out[y0:y0 + rows] = np.where(
                    v == WRB_NODATA, 0, v.astype(np.int16) + 1).astype(np.uint8)
            elif layers["key"] == "usda":
                # UInt16 SUBCLASS codes -> the 12 published order
                # indices through the publisher's own SLD mapping. The
                # LUT is sized for the whole UInt16 range, so nodata
                # (32767) and any surprise value land on 0 = transparent
                # instead of throwing mid-build. MUST come before the
                # single-band branch below, which would treat the codes
                # as interval breaks and produce garbage classes.
                out[y0:y0 + rows] = layers["lut"][bands[0]]
            elif len(bands) == 1:
                out[y0:y0 + rows] = classify_by_breaks(bands[0], quantities)
            elif layers["key"] == "texture":
                # the three fractions are raw g/kg -> %
                sand = bands[0].astype(np.float32) * 0.1
                silt = bands[1].astype(np.float32) * 0.1
                clay = bands[2].astype(np.float32) * 0.1
                out[y0:y0 + rows] = texture_class(sand, silt, clay)
            else:
                raise ValueError(f"no classifier for {layers['key']}")
        return out
    finally:
        dss = [None] * len(dss)


def write_probe_grid(layers, out_path: str, tmpdir: str) -> None:
    """Int16 probe grid: raw values, 0.1 deg, north row first."""
    props = layers["props"]
    width = int(360 / GRID_DEG)
    height = int(180 / GRID_DEG)

    if layers["key"] == "wrb":
        # Byte class ids -> the published 1..30 convention; 0 = no soil.
        ds = open_source("wrb")
        tmp = os.path.join(tmpdir, "grid_wrb.tif")
        warp_to_grid(ds, tmp, resample=gdal.GRA_NearestNeighbour,
                     nodata=WRB_NODATA, dtype=gdal.GDT_Byte)
        ds = None
        gds = gdal.Open(tmp)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        os.remove(tmp)
        out = np.where(arr == WRB_NODATA, 0, arr.astype(np.int16) + 1)
        np.ascontiguousarray(out.astype("<i2")).tofile(out_path)
        return

    if layers["key"] == "usda":
        # Same LUT as the tiles: the client looks the value up in
        # meta.classes by index, so the grid must carry the PUBLISHED
        # order index (1..12, 0 = no data), never the raw subclass code.
        ds = open_source("usda")
        tmp = os.path.join(tmpdir, "grid_usda.tif")
        warp_to_grid(ds, tmp, resample=gdal.GRA_NearestNeighbour,
                     nodata=USDA_NODATA, dtype=gdal.GDT_UInt16)
        ds = None
        gds = gdal.Open(tmp)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        os.remove(tmp)
        out = layers["lut"][arr]
        np.ascontiguousarray(out.astype("<i2")).tofile(out_path)
        return

    if len(props) == 1:
        ds = open_source(props[0])
        tmp = os.path.join(tmpdir, "grid.tif")
        warp_to_grid(ds, tmp)
        ds = None
        gds = gdal.Open(tmp)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        os.remove(tmp)
        arr = np.ascontiguousarray(arr.astype("<i2"))
        arr.tofile(out_path)
        return

    # texture: store the class index (1..12) in the grid
    merged = np.zeros((height, width), dtype=np.int16)
    for i, p in enumerate(props):
        ds = open_source(p)
        tmp = os.path.join(tmpdir, f"grid_{i}.tif")
        warp_to_grid(ds, tmp)
        ds = None
        gds = gdal.Open(tmp)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        os.remove(tmp)
        if i == 0:
            sand = arr.astype(np.float32) * 0.1
        elif i == 1:
            silt = arr.astype(np.float32) * 0.1
        else:
            clay = arr.astype(np.float32) * 0.1
    merged = texture_class(sand, silt, clay).astype(np.int16)
    merged.tofile(out_path)


# ── verification ─────────────────────────────────────────────────────────

# WRB probes: (lat, lng, allowed class labels). A flipped axis puts the
# Amazon in the Sahara's soil and every probe fails at once. The sets
# are the groups soil maps actually put at those coordinates — loose
# enough for model disagreement, tight enough to catch a bad warp.
WRB_PROBES = [
    # Amazon basin — deeply weathered tropical soils
    (-3.0, -60.0, {"Ferralsols", "Acrisols", "Luvisols", "Nitisols", "Plinthosols", "Alisols"}),
    # Sahara (Tibesti) — bare rock / sand, no profile development
    (21.0, 17.0, {"Leptosols", "Arenosols", "Regosols", "Calcisols", "Gypsisols"}),
    # Netherlands — marine clay near the coast, sandy podzol country
    # inland; Cambisols show up on the higher grounds, so the set is
    # broad. The probe's job is catching a bad warp, not ranking models.
    (52.0, 5.0, {"Fluvisols", "Gleysols", "Histosols", "Stagnosols",
                 "Planosols", "Podzols", "Cambisols", "Luvisols"}),
    # Ukrainian steppe — chernozem belt
    (48.0, 32.0, {"Chernozems", "Kastanozems", "Phaeozems", "Cambisols"}),
    # Ganges delta — young alluvium
    (23.0, 90.0, {"Fluvisols", "Gleysols", "Planosols"}),
    # Siberian permafrost
    (65.0, 100.0, {"Cryosols", "Podzols", "Histosols", "Leptosols", "Gleysols"}),
]


def sample_source_class(prop: str, lat: float, lng: float):
    """Most common class id at a point (WRB probe path)."""
    ds = open_source(prop)
    tmp = tempfile.NamedTemporaryFile(suffix=".tif", delete=False)
    tmp.close()
    try:
        opts = gdal.WarpOptions(
            format="GTiff",
            outputBounds=(lng - 0.05, lat - 0.05, lng + 0.05, lat + 0.05),
            width=8,
            height=8,
            dstSRS="EPSG:4326",
            srcNodata=WRB_NODATA,
            dstNodata=WRB_NODATA,
            resampleAlg=gdal.GRA_NearestNeighbour,
            outputType=gdal.GDT_Byte,
        )
        gdal.Warp(tmp.name, ds, options=opts)
        ds = None
        gds = gdal.Open(tmp.name)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        vals = arr[arr != WRB_NODATA]
        if vals.size == 0:
            return None
        # modal class id
        counts = np.bincount(vals.astype(np.int64), minlength=WRB_NODATA)
        return int(counts.argmax())
    finally:
        ds = None
        os.remove(tmp.name)


def verify_wrb(wrb_def: dict) -> bool:
    """Gate: known places must carry the WRB group soil science expects."""
    ok = True
    by_id = {c["class_id"]: c["label"] for c in wrb_def["classes"]}
    for lat, lng, allowed in WRB_PROBES:
        cid = sample_source_class("wrb", lat, lng)
        label = by_id.get(cid, f"?({cid})") if cid is not None else "no-data"
        good = label in allowed
        log(f"wrB probe ({lat:6.1f},{lng:7.1f})  {label}"
            f"  {'ok' if good else 'FAIL (want ' + '/'.join(sorted(allowed)) + ')'}")
        if not good:
            ok = False
    return ok


# USDA-order probes: (lat, lng, allowed order names). The sets are the
# orders soil maps actually put at those coordinates — tight where the
# ensemble is unambiguous, loose where it disagrees with the textbook
# (the gate's job is catching a FLIPPED OR SHIFTED WARP, not ranking
# models: a bad warp moves every probe to a different climate zone and
# all six fail at once).
USDA_PROBES = [
    # Kansas — the mollisol belt (measured: Mollisols, 400/400)
    (38.0, -98.0, {"Mollisols"}),
    # Ukrainian steppe — chernozem country (measured: Mollisols, 400/400)
    (48.0, 32.0, {"Mollisols"}),
    # Indian Deccan — black cotton soil (measured: Vertisols, 400/400)
    (19.0, 78.0, {"Vertisols"}),
    # Siberian permafrost (measured: Gelisols modal, Entisols present)
    (65.0, 100.0, {"Gelisols", "Entisols"}),
    # Ganges delta — young alluvium (measured: Ultisols/Inceptisols;
    # soil science says Entisols/Inceptisols, so the set is all three)
    (23.0, 90.0, {"Ultisols", "Inceptisols", "Entisols"}),
    # Amazon basin — deeply weathered tropical soils (measured:
    # Inceptisols/Ultisols; the textbook answer is Oxisols/Ultisols)
    (-5.0, -60.0, {"Oxisols", "Ultisols", "Inceptisols"}),
]


def sample_source_usda(lat: float, lng: float, lut: np.ndarray):
    """Modal published USDA order index at a point, or None if no data.

    Mirrors sample_source_class() — same 0.1 deg window, same modal
    reading — but the source is UInt16 subclass codes with nodata 32767,
    and the codes are meaningless until the publisher's SLD maps them
    to the 12 orders, which is exactly what `lut` does.
    """
    ds = open_source("usda")
    tmp = tempfile.NamedTemporaryFile(suffix=".tif", delete=False)
    tmp.close()
    try:
        opts = gdal.WarpOptions(
            format="GTiff",
            outputBounds=(lng - 0.05, lat - 0.05, lng + 0.05, lat + 0.05),
            width=8,
            height=8,
            dstSRS="EPSG:4326",
            srcNodata=USDA_NODATA,
            dstNodata=USDA_NODATA,
            resampleAlg=gdal.GRA_NearestNeighbour,
            outputType=gdal.GDT_UInt16,
        )
        gdal.Warp(tmp.name, ds, options=opts)
        ds = None
        gds = gdal.Open(tmp.name)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        vals = arr[arr != USDA_NODATA]
        if vals.size == 0:
            return None
        # modal SUBCLASS code, then map it through the LUT — the same
        # order of operations the pyramid build uses
        counts = np.bincount(vals.astype(np.int64), minlength=USDA_NODATA + 1)
        code = int(counts.argmax())
        return int(lut[code]) if code < len(lut) else 0
    finally:
        ds = None
        os.remove(tmp.name)


def verify_usda(usda_def: dict) -> bool:
    """Gate: known places must carry the USDA order soil science expects."""
    ok = True
    lut = usda_def["lut"]
    by_index = {c["index"]: c["label"] for c in usda_def["classes"]}
    for lat, lng, allowed in USDA_PROBES:
        idx = sample_source_usda(lat, lng, lut)
        label = by_index.get(idx, "?") if idx else "no-data"
        good = label in allowed
        log(f"usda probe ({lat:6.1f},{lng:7.1f})  {label}"
            f"  {'ok' if good else 'FAIL (want ' + '/'.join(sorted(allowed)) + ')'}")
        if not good:
            ok = False
    return ok


def sample_source(prop: str, lat: float, lng: float) -> float:
    """Raw SoilGrids value at a point, read from the source raster."""
    ds = open_source(prop)
    gt = ds.GetGeoTransform()
    # the source is in Interrupted Goode Homolosine — warp a tiny window
    # around the point instead of inverting the projection by hand.
    tmp = tempfile.NamedTemporaryFile(suffix=".tif", delete=False)
    tmp.close()
    try:
        opts = gdal.WarpOptions(
            format="GTiff",
            outputBounds=(lng - 0.05, lat - 0.05, lng + 0.05, lat + 0.05),
            width=4,
            height=4,
            dstSRS="EPSG:4326",
            srcNodata=NODATA,
            dstNodata=NODATA,
            resampleAlg=gdal.GRA_NearestNeighbour,
            outputType=gdal.GDT_Int16,
        )
        gdal.Warp(tmp.name, ds, options=opts)
        ds = None
        gds = gdal.Open(tmp.name)
        arr = gds.GetRasterBand(1).ReadAsArray()
        gds = None
        vals = arr[arr != NODATA]
        if vals.size == 0:
            return float("nan")
        return float(vals.mean())
    finally:
        ds = None
        os.remove(tmp.name)


def verify(layers_by_key: dict) -> bool:
    """Gate: the values at known places must be what soil science says.

    A wrong warp (flipped axis, shifted origin) passes every structural
    check and still produces a plausible-looking map, so the probes are
    the only thing that catches it.
    """
    ok = True
    for lat, lng, checks in SOIL_PROBES:
        values = {}
        line = [f"({lat:6.1f},{lng:7.1f})"]
        for check in checks:
            kind = check[0]
            if kind == "abs":
                _, prop, lo, hi = check
                if prop not in layers_by_key:
                    continue
                raw = sample_source(prop, lat, lng)
                if math.isnan(raw):
                    line.append(f"{prop}=no-data")
                    ok = False
                    continue
                meta = layers_by_key[prop]
                value = raw * meta["scale"]
                values[prop] = value
                good = lo <= value <= hi
                line.append(f"{prop}={value:.1f}{meta['unit']}{'' if good else ' FAIL'}")
                if not good:
                    ok = False
            else:
                _, prop, other = check
                if prop not in layers_by_key or other not in layers_by_key:
                    continue
                for p in (prop, other):
                    if p in values:
                        continue
                    raw = sample_source(p, lat, lng)
                    meta = layers_by_key[p]
                    values[p] = float("nan") if math.isnan(raw) else raw * meta["scale"]
                a, b = values.get(prop), values.get(other)
                if a is None or b is None or math.isnan(a) or math.isnan(b):
                    continue
                good = a > b if kind == "gt" else a < b
                line.append(f"{prop}{' > ' if kind == 'gt' else ' < '}{other}{'' if good else ' FAIL'}")
                if not good:
                    ok = False
        log("probe " + "  ".join(line))
    return ok


# ── main ─────────────────────────────────────────────────────────────────

def build_layer_defs() -> dict:
    defs = {}
    for key, meta in PROPERTIES.items():
        entries = parse_sld(fetch_sld(key))
        if len(entries) < 2:
            raise RuntimeError(f"no colour map for {key}")
        table, classes = palette_from_classes(entries)
        # The class metadata carries the *display* value range; the
        # classification itself uses the raw quantities.
        for c in classes:
            c["min"] = round(c["min"] * meta["scale"], 3)
            c["max"] = round(c["max"] * meta["scale"], 3)
        defs[key] = {
            "key": key,
            "title": meta["title"],
            "unit": meta["unit"],
            "scale": meta["scale"],
            "decimals": meta["decimals"],
            "blurb": meta["blurb"],
            "props": [key],
            "quantities": [e[0] for e in entries],
            "table": table,
            "classes": classes,
            "source": source_url(key),
            "attribution": "SoilGrids 2.0 (ISRIC World Soil Information) — CC BY 4.0",
        }

    # texture class (derived)
    table = [(0, 0, 0, 0)]
    classes = []
    for i, (code, title, colour) in enumerate(TEXTURE_CLASSES, start=1):
        r, g, b = hex_to_rgb(colour)
        table.append((r, g, b, 255))
        classes.append({"index": i, "code": code, "color": colour, "label": title})
    defs["texture"] = {
        "key": "texture",
        "title": "Soil texture",
        "unit": "class",
        "scale": 1.0,
        "decimals": 0,
        "blurb": "USDA soil-texture class derived from sand, silt and clay.",
        "props": ["sand", "silt", "clay"],
        "quantities": [],
        "table": table,
        "classes": classes,
        "source": "derived from SoilGrids 2.0 sand/silt/clay (ISRIC)",
        "attribution": "SoilGrids 2.0 (ISRIC World Soil Information) — CC BY 4.0",
    }

    # WRB soil reference groups (the modern successor to the FAO/UNESCO
    # FGGD major soil groups): one Byte class map, official SLD colours.
    wrb_entries = parse_sld(fetch_sld("wrb"), drop={WRB_NODATA})
    if len(wrb_entries) < 10:
        raise RuntimeError("wrb.sld colour map missing")
    wrb_table, wrb_classes = palette_from_values(wrb_entries)
    defs["wrb"] = {
        "key": "wrb",
        "title": "Soil groups (WRB)",
        "unit": "class",
        "scale": 1.0,
        "decimals": 0,
        "blurb": "World Reference Base soil reference groups (most probable class).",
        "props": ["wrb"],
        "quantities": [],
        "table": wrb_table,
        "classes": wrb_classes,
        "grid_nodata": 0,
        "source": WRB_VRT,
        "attribution": "SoilGrids 2.0 WRB (ISRIC World Soil Information) — CC BY 4.0",
    }

    # USDA soil orders (OpenLandMap-soildb): the 12 orders of the USDA
    # Soil Taxonomy — a DIFFERENT classification from WRB's 34 groups,
    # from a different publisher, at 30 m instead of 1 km. The raster
    # stores ~818 SUBCLASS codes; the publisher's SLD maps every code
    # to its parent order ("79" -> "1. Alfisols"), so classification is
    # a LOOKUP (code -> order), not an interval break and not a
    # one-code-one-class value map like wrb.
    usda_entries = parse_sld(fetch_sld("usda"), drop={USDA_NODATA})
    if len(usda_entries) < 800:
        raise RuntimeError(
            f"usda.sld colour map missing or truncated ({len(usda_entries)} entries)")
    # Group the codes by their order label. The label carries the USDA
    # order number ("1. Alfisols" .. "12. Vertisols") — that number IS
    # the published class index, so the grid and the legend agree with
    # the publisher's own numbering.
    orders = {}          # order_num -> {"label", "colour", "codes"}
    for qty, colour, label in usda_entries:
        m = re.match(r"(\d+)\.\s*(.+)", label)
        if not m:
            raise RuntimeError(f"usda.sld: unparsable label {label!r}")
        num, name = int(m.group(1)), m.group(2)
        rec = orders.setdefault(num, {"label": name, "colour": colour, "codes": []})
        if rec["label"] != name:
            raise RuntimeError(f"usda.sld: order {num} has two names")
        rec["codes"].append(qty)
    if sorted(orders) != list(range(1, 13)):
        raise RuntimeError(
            f"usda.sld: expected orders 1..12, got {sorted(orders)}")

    # LUT: subclass code -> published order index (1..12), 0 = no data.
    # Sized for the FULL UInt16 range so any nodata (32767) or surprise
    # value indexes safely to 0 instead of throwing mid-build.
    lut = np.zeros(65536, dtype=np.uint8)
    table = [(0, 0, 0, 0)]          # palette 0 stays transparent
    classes = []
    for num in sorted(orders):
        rec = orders[num]
        r, g, b = hex_to_rgb(rec["colour"])
        table.append((r, g, b, 255))
        classes.append({"index": num, "class_id": num,
                        "color": rec["colour"], "label": rec["label"]})
        for code in rec["codes"]:
            lut[code] = num
    defs["usda"] = {
        "key": "usda",
        "title": "Soil orders (USDA)",
        "unit": "class",
        "scale": 1.0,
        "decimals": 0,
        "blurb": "The 12 orders of the USDA Soil Taxonomy — a different "
                 "classification system from the WRB groups above.",
        "props": ["usda"],
        "quantities": [],           # not an interval map: a LUT instead
        "lut": lut,
        "table": table,
        "classes": classes,
        "grid_nodata": 0,
        "source": USDA_COG,
        "attribution": "OpenLandMap-soildb (OpenGeoHub Foundation) — CC BY 4.0",
    }
    return defs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, "public_html", "data", "soil"))
    ap.add_argument("--layers", nargs="*", default=None,
                    help="layer keys to build (default: all)")
    ap.add_argument("--max-zoom", type=int, default=7)
    ap.add_argument("--keep-intermediate", action="store_true")
    args = ap.parse_args()

    gdal.SetConfigOption("GDAL_HTTP_TIMEOUT", "120")
    gdal.SetConfigOption("GDAL_HTTP_MAX_RETRY", "5")
    gdal.SetConfigOption("GDAL_HTTP_RETRY_DELAY", "3")

    defs = build_layer_defs()
    keys = args.layers or list(defs.keys())

    log(f"layers: {', '.join(keys)}  max zoom {args.max_zoom}")

    tmpdir = tempfile.mkdtemp(prefix="soil-build-")
    try:
        ok = verify(defs)
        if "wrb" in defs and "wrb" in keys:
            ok = verify_wrb(defs["wrb"]) and ok
        if "usda" in defs and "usda" in keys:
            ok = verify_usda(defs["usda"]) and ok
        if not ok:
            print("[soil] verification FAILED — refusing to publish", file=sys.stderr)
            return 2

        os.makedirs(args.out, exist_ok=True)
        for key in keys:
            build_pyramid(defs[key], args.out, args.max_zoom, tmpdir)
    finally:
        if not args.keep_intermediate:
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            log(f"intermediates kept in {tmpdir}")

    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
