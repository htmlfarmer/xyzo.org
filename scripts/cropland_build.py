#!/usr/bin/env python3
"""
Build the ESA WorldCover cropland / land-cover overlay assets for Xyzo.

Source: ESA WorldCover 10 m v200 (2021) — CC BY 4.0
  https://esa-worldcover.esa.int/
  https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/

The map is published as 3° x 3° GeoTIFF tiles on S3 (2,651 of them). They
are read in place over HTTP range requests (/vsicurl/): nothing is
downloaded whole, and GDAL picks the overview level a zoom needs.

Every source tile is warped into the global Web Mercator grid of a zoom
level and the XYZ tiles are cut out of that, so both modes (cropland
only, full land cover) come from the same classified pixels and cannot
disagree.

Outputs (all under public_html/data/cropland/):

  cropland/tiles/{z}/{x}/{y}.png   the cropland extent (class 40) only
  landcover/tiles/{z}/{x}/{y}.png  the full ESA classification
  grid.bin                         cropland share per 0.1 deg cell (0-100 %)
  class.bin                        dominant land-cover class per 0.1 deg cell
  meta.json                        class table, grid geometry, attribution

Usage:
  python3 scripts/cropland_build.py                    # everything, z0..9
  python3 scripts/cropland_build.py --max-zoom 9
  python3 scripts/cropland_build.py --modes cropland
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

try:
    from osgeo import gdal
except ImportError as exc:  # pragma: no cover
    print(f"GDAL python bindings required: {exc}", file=sys.stderr)
    raise

gdal.UseExceptions()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BUCKET = "https://esa-worldcover.s3.eu-central-1.amazonaws.com"
MAP_PREFIX = "v200/2021/map/"
KEY_RE = re.compile(r"ESA_WorldCover_10m_2021_v200_([NS])(\d{2})([EW])(\d{3})_Map\.tif$")

TILE_SIZE = 256
HALF = 20037508.342789244
GRID_DEG = 0.1
# The source uses 0 for "outside the tile" (ocean / not covered).
NODATA = 0
# The source grid: 3 deg in 36,000 px.
SOURCE_STEP = 3.0 / 36000.0

# ESA WorldCover 10 m v200 class list (the palette in the GeoTIFF).
CLASSES = [
    (10, "Tree cover", "#006400"),
    (20, "Shrubland", "#FEBB22"),
    (30, "Grassland", "#FFFF4C"),
    (40, "Cropland", "#F096FF"),
    (50, "Built-up", "#FA0000"),
    (60, "Bare / sparse vegetation", "#B4B4B4"),
    (70, "Snow and ice", "#F0F0F0"),
    (80, "Permanent water bodies", "#0064C8"),
    (90, "Herbaceous wetland", "#0096A0"),
    (95, "Mangroves", "#00CF75"),
    (100, "Moss and lichen", "#FAE6A0"),
]
CLASS_CODES = [c[0] for c in CLASSES]

# The cropland-only wash. The ESA colour for cropland is pink, which is
# unmistakable on the official map but reads as an error on a basemap, so
# the overlay uses a crop green and says so in the legend.
CROPLAND_COLOR = (86, 190, 74)
CROPLAND_ALPHA = 210

# Probe points: (lat, lng, (op, bound)) on the cropland share.
# The coordinates sit ON a farmland pixel — the old set had points on a
# forest patch (Iowa), the São Paulo city centre, deep Congo rainforest
# and central-IR desert, all of which read 0 for perfectly good data.
CROPLAND_PROBES = [
    (39.0, 116.4, ("gt", 50)),    # North China Plain
    (48.0, 32.0, ("gt", 50)),     # Ukrainian steppe
    (41.2, -93.0, ("gt", 50)),    # US corn belt (Iowa farmland)
    (21.0, 78.0, ("gt", 40)),     # Deccan / Gujarat
    (-22.9, -46.6, ("gt", 30)),   # São Paulo basin countryside
    (-2.2, 28.9, ("gt", 20)),     # Albertine Rift farmland
    (36.9, 54.6, ("gt", 20)),     # Gorgan / Caspian ag belt
    (-25.0, 135.0, ("lt", 20)),   # Australian outback
    (70.0, 100.0, ("lt", 5)),     # Siberian tundra
    (0.0, -30.0, ("lt", 10)),     # mid Atlantic
]


def log(msg: str) -> None:
    print(f"[cropland] {msg}", flush=True)


# ── source tiles ─────────────────────────────────────────────────────────

def list_source_tiles(cache_path: str) -> list:
    """The 3° tiles that exist in the bucket."""
    if os.path.exists(cache_path):
        with open(cache_path) as fh:
            return json.load(fh)
    log("listing the ESA WorldCover bucket ...")
    keys = []
    token = None
    while True:
        url = f"{BUCKET}/?list-type=2&max-keys=1000&prefix={MAP_PREFIX}"
        if token:
            url += f"&continuation-token={urllib.parse.quote(token)}"
        with urllib.request.urlopen(url, timeout=60) as resp:
            body = resp.read()
        root = ET.fromstring(body)
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        for k in root.findall(".//s3:Key", ns):
            keys.append(k.text)
        trunc = root.find("s3:IsTruncated", ns)
        nxt = root.find("s3:NextContinuationToken", ns)
        if trunc is not None and trunc.text == "true" and nxt is not None:
            token = nxt.text
        else:
            break
    tiles = []
    for key in keys:
        m = KEY_RE.search(os.path.basename(key))
        if not m:
            continue
        ns_, lat, ew, lon = m.groups()
        latv = int(lat) * (-1 if ns_ == "S" else 1)
        lonv = int(lon) * (-1 if ew == "W" else 1)
        tiles.append({
            "key": key,
            "lon0": lonv, "lon1": lonv + 3,
            "lat0": latv, "lat1": latv + 3,
        })
    tiles.sort(key=lambda t: (t["lat0"], t["lon0"]))
    with open(cache_path, "w") as fh:
        json.dump(tiles, fh)
    log(f"{len(tiles)} source tiles")
    return tiles


def open_source(key: str):
    gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    gdal.SetConfigOption("GDAL_HTTP_MULTIRANGE", "YES")
    gdal.SetConfigOption("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
    gdal.SetConfigOption("GDAL_HTTP_TIMEOUT", "120")
    return gdal.Open("/vsicurl/" + BUCKET + "/" + key)


def open_all(tiles, workers: int = 16) -> dict:
    """Open every source tile. The headers are the slow part (one HTTP
    round trip each), so they are fetched in parallel."""
    t = time.time()
    out = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for key, ds in zip([x["key"] for x in tiles], ex.map(open_source, [x["key"] for x in tiles])):
            if ds is not None:
                out[key] = ds
    log(f"{len(out)} source tiles opened in {round(time.time() - t)}s")
    return out


# ── geometry ─────────────────────────────────────────────────────────────

def merc_y(lat: float, n: int) -> float:
    s = math.sin(math.radians(max(-85.05112878, min(85.05112878, lat))))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n


def pixel_range(lon0, lon1, lat0, lat1, n):
    """Global pixel range of a geographic box on a zoom-level grid.

    The window is expanded OUTWARD to whole pixels. Flooring both edges
    (the old behaviour) made each tile's warp start west/north of its
    own data, so the first row/column came out nodata — a 1px hole at
    every 3° source-tile boundary, which the map showed as a yellow
    grid over the black-washed overlay. Neighbouring tiles now overlap
    by a pixel; write_zoom only copies valid pixels, so the overlap
    fills those edges instead of clobbering them.
    """
    px0 = math.floor((lon0 + 180.0) / 360.0 * n)
    px1 = math.ceil((lon1 + 180.0) / 360.0 * n)
    # merc_y grows southward: the north edge (lat1) floors, the south
    # edge (lat0) ceils — same outward expansion on both sides.
    py0 = math.floor(merc_y(lat1, n))
    py1 = math.ceil(merc_y(lat0, n))
    return int(px0), int(py0), max(1, int(px1 - px0)), max(1, int(py1 - py0))


def bounds_of_pixels(px0, py0, w, h, n):
    """Mercator bounds of a pixel window on a zoom-level grid."""
    res = 2 * HALF / n
    return (
        -HALF + px0 * res,
        HALF - (py0 + h) * res,
        -HALF + (px0 + w) * res,
        HALF - py0 * res,
    )


def warp_tile(ds, lon0, lon1, lat0, lat1, n):
    """Warp one source tile into the global grid of a zoom level.

    The output window is the exact pixel window the tile covers, so the
    result lines up with every other tile and with every other zoom
    level — the pixels of the globe are the same on all of them.
    """
    px0, py0, w, h = pixel_range(lon0, lon1, lat0, lat1, n)
    xmin, ymin, xmax, ymax = bounds_of_pixels(px0, py0, w, h, n)
    opts = gdal.WarpOptions(
        format="MEM",
        outputBounds=(xmin, ymin, xmax, ymax),
        width=w,
        height=h,
        dstSRS="EPSG:3857",
        srcNodata=NODATA,
        dstNodata=NODATA,
        resampleAlg=gdal.GRA_NearestNeighbour,
    )
    out = gdal.Warp("", ds, options=opts)
    arr = out.GetRasterBand(1).ReadAsArray()
    out = None
    return px0, py0, arr


class SourceIndex:
    """Which source tiles can touch a given tile of a zoom level."""

    def __init__(self, tiles):
        self.cells = {}
        for t in tiles:
            row = int((t["lat0"] + 90) // 3)
            col = int((t["lon0"] + 180) // 3)
            self.cells[(row, col)] = t

    def overlapping(self, tx, ty, n):
        lon0 = tx * TILE_SIZE / n * 360.0 - 180.0
        lon1 = (tx + 1) * TILE_SIZE / n * 360.0 - 180.0
        lat1 = math.degrees(2 * math.atan(math.exp((1 - 2 * ty * TILE_SIZE / n) * math.pi)) - math.pi / 2)
        lat0 = math.degrees(2 * math.atan(math.exp((1 - 2 * (ty + 1) * TILE_SIZE / n) * math.pi)) - math.pi / 2)
        col0 = int((lon0 + 180) // 3) - 1
        col1 = int((lon1 + 180) // 3) + 1
        row0 = int((lat0 + 90) // 3) - 1
        row1 = int((lat1 + 90) // 3) + 1
        out = []
        for row in range(max(0, row0), min(60, row1 + 1)):
            for col in range(max(0, col0), min(120, col1 + 1)):
                t = self.cells.get((row, col))
                if t is not None:
                    out.append(t)
        return out


# ── palettes ─────────────────────────────────────────────────────────────

def mode_palette(mode: str):
    """class code -> RGBA, plus the palette the PNGs are written with.

    Returns (lut, pal, alphas): `pal` is the flat RGB table for
    putpalette(), `alphas` is one alpha byte per palette slot for the
    PNG tRNS chunk. Writing `transparency=bytes([k])` (the old form)
    only marks slot k and leaves every other slot opaque — so all the
    "invisible" classes rendered as solid black, which showed up as a
    ~55% dark wash over the whole basemap.
    """
    if mode == "cropland":
        table = {code: (0, 0, 0, 0) for code in CLASS_CODES}
        table[NODATA] = (0, 0, 0, 0)
        table[40] = CROPLAND_COLOR + (CROPLAND_ALPHA,)
    else:
        table = {NODATA: (0, 0, 0, 0)}
        for code, _title, colour in zip(CLASS_CODES, [c[1] for c in CLASSES], [c[2] for c in CLASSES]):
            c = colour.lstrip("#")
            rgb = (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
            # water stays transparent: the basemap already draws it
            table[code] = rgb + (0,) if code == 80 else rgb + (215,)
    codes = sorted(table.keys())
    slot = {code: i for i, code in enumerate(codes)}
    pal = []
    alphas = []
    for code in codes:
        r, g, b, a = table[code]
        pal.extend([r, g, b])
        alphas.append(a)
    while len(pal) < 768:
        pal.extend([0, 0, 0])
        alphas.append(255)
    lut = np.zeros(256, dtype=np.uint8)
    for code, s in slot.items():
        lut[code] = s
    return lut, pal, bytes(alphas)


# ── tiling ───────────────────────────────────────────────────────────────

def write_zoom(tiles, arrays, index, z, mode, out_dir) -> int:
    """Cut one zoom level out of the warped source tiles."""
    n = TILE_SIZE * (2 ** z)
    lut, pal, alphas = mode_palette(mode)
    # slot of "no class" — used only to skip fully-empty output tiles
    transparent = 0
    written = 0
    seen = set()
    for src in tiles:
        entry = arrays.get(src["key"])
        if entry is None:
            continue
        px0, py0, arr = entry
        h, w = arr.shape
        tx0 = px0 // TILE_SIZE
        ty0 = py0 // TILE_SIZE
        tx1 = (px0 + w - 1) // TILE_SIZE
        ty1 = (py0 + h - 1) // TILE_SIZE
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                if (tx, ty) in seen:
                    continue
                seen.add((tx, ty))
                canvas = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.uint8)
                empty = True
                # a tile can be fed by up to four source tiles
                for other in index.overlapping(tx, ty, n):
                    oentry = arrays.get(other["key"])
                    if oentry is None:
                        continue
                    opx0, opy0, oarr = oentry
                    oh, ow = oarr.shape
                    ix0 = max(tx * TILE_SIZE, opx0)
                    iy0 = max(ty * TILE_SIZE, opy0)
                    ix1 = min((tx + 1) * TILE_SIZE, opx0 + ow)
                    iy1 = min((ty + 1) * TILE_SIZE, opy0 + oh)
                    if ix1 <= ix0 or iy1 <= iy0:
                        continue
                    # The warp windows now overlap by a pixel (outward
                    # rounding). Copy only VALID pixels: a source's nodata
                    # edge sliver must never clobber the neighbour's data.
                    block = oarr[iy0 - opy0:iy1 - opy0, ix0 - opx0:ix1 - opx0]
                    dst = canvas[iy0 - ty * TILE_SIZE:iy1 - ty * TILE_SIZE,
                                 ix0 - tx * TILE_SIZE:ix1 - tx * TILE_SIZE]
                    valid = block != NODATA
                    dst[valid] = block[valid]
                    if valid.any():
                        empty = False
                if empty:
                    continue
                idx = lut[canvas]
                if not (idx != transparent).any():
                    continue
                img = Image.fromarray(idx, mode="P")
                img.putpalette(pal)
                # One alpha byte PER palette slot (PNG tRNS). This is what
                # makes non-cropland classes actually invisible.
                img.info["transparency"] = alphas
                path = os.path.join(out_dir, str(z), str(tx), f"{ty}.png")
                os.makedirs(os.path.dirname(path), exist_ok=True)
                img.save(path, optimize=True)
                written += 1
    return written


# ── probe grids ──────────────────────────────────────────────────────────

def build_grids(tiles, datasets, out_dir):
    """cropland share per 0.1 deg cell + the dominant class per cell.

    The 10 m classification is resampled to 0.01 deg (about 1 km, far
    finer than the cell it is summarised into) and then counted cell by
    cell.

    A 3° source tile is 30×30 cells of 0.1°, each made of 10×10 cells
    of 0.01° — so the reshape is (30, 10, 30, 10). Getting that
    backwards (10, 30, …) wrote only a 10×10 block per tile: 1/9 of the
    globe, and every probe that landed in the unwritten 2/3 read 0.
    """
    width = int(360 / GRID_DEG)
    height = int(180 / GRID_DEG)
    coarse = int(round(3.0 / GRID_DEG))    # 0.1° cells per 3° tile edge = 30
    fine = int(3.0 / (GRID_DEG / 10))      # 0.01° cells per tile edge = 300
    fine_per = fine // coarse              # fine cells per coarse cell = 10

    valid = np.zeros((height, width), dtype=np.int32)
    crop = np.zeros((height, width), dtype=np.int32)
    per_class = np.zeros((len(CLASS_CODES), height, width), dtype=np.int32)

    t = time.time()
    for i, src in enumerate(tiles):
        ds = datasets.get(src["key"])
        if ds is None:
            continue
        opts = gdal.WarpOptions(
            format="MEM",
            outputBounds=(src["lon0"], src["lat0"], src["lon1"], src["lat1"]),
            width=fine,
            height=fine,
            dstSRS="EPSG:4326",
            srcNodata=NODATA,
            dstNodata=NODATA,
            resampleAlg=gdal.GRA_NearestNeighbour,
        )
        out = gdal.Warp("", ds, options=opts)
        arr = out.GetRasterBand(1).ReadAsArray()
        out = None
        blocks = arr.reshape(coarse, fine_per, coarse, fine_per)
        x0 = int(round((src["lon0"] + 180) / GRID_DEG))
        y0 = int(round((90 - src["lat1"]) / GRID_DEG))
        v = (blocks != NODATA).sum(axis=(1, 3))
        valid[y0:y0 + coarse, x0:x0 + coarse] += v
        crop[y0:y0 + coarse, x0:x0 + coarse] += (blocks == 40).sum(axis=(1, 3))
        for ci, code in enumerate(CLASS_CODES):
            per_class[ci, y0:y0 + coarse, x0:x0 + coarse] += (blocks == code).sum(axis=(1, 3))
        if (i + 1) % 500 == 0:
            log(f"  grids {i + 1}/{len(tiles)}")
    log(f"grids resampled in {round(time.time() - t)}s")

    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(valid > 0, crop / np.maximum(valid, 1) * 100.0, 0.0)
    share_u8 = np.clip(np.rint(share), 0, 255).astype(np.uint8)
    share_u8.tofile(os.path.join(out_dir, "grid.bin"))

    dominant = np.zeros((height, width), dtype=np.uint8)
    best = np.zeros((height, width), dtype=np.int32)
    for ci, code in enumerate(CLASS_CODES):
        cnt = per_class[ci]
        better = cnt > best
        dominant = np.where(better, code, dominant)
        best = np.where(better, cnt, best)
    dominant.tofile(os.path.join(out_dir, "class.bin"))
    return width, height


# ── verification ─────────────────────────────────────────────────────────

def sample_grid(grid_path, width, height, lat, lng):
    lon = ((lng + 180) % 360 + 360) % 360 - 180
    ix = min(width - 1, max(0, int((lon + 180) / 360 * width)))
    iy = min(height - 1, max(0, int((90 - lat) / 180 * height)))
    data = np.fromfile(grid_path, dtype=np.uint8)
    return int(data[iy * width + ix])


def verify(out_dir, width, height) -> bool:
    ok = True
    grid = os.path.join(out_dir, "grid.bin")
    for lat, lng, (op, bound) in CROPLAND_PROBES:
        value = sample_grid(grid, width, height, lat, lng)
        good = value > bound if op == "gt" else value < bound
        log(f"probe ({lat:6.1f},{lng:7.1f})  cropland {value:3d}%  "
            f"{'ok' if good else 'FAIL (want %s %d)' % (op, bound)}")
        if not good:
            ok = False
    return ok


# ── main ─────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, "public_html", "data", "cropland"))
    ap.add_argument("--max-zoom", type=int, default=9)
    ap.add_argument("--cover-zoom", type=int, default=8,
                    help="max zoom of the full land-cover mode")
    ap.add_argument("--modes", nargs="*", default=["cropland", "landcover"])
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--grids-only", action="store_true",
                    help="rebuild grid.bin/class.bin/meta.json only; keep tiles")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    tiles = list_source_tiles(os.path.join(args.out, "source_tiles.json"))
    if not tiles:
        print("[cropland] no source tiles found", file=sys.stderr)
        return 1

    mode_max = {"cropland": args.max_zoom, "landcover": args.cover_zoom}
    if not args.grids_only:
        for mode in args.modes:
            tiles_dir = os.path.join(args.out, mode, "tiles")
            if os.path.exists(tiles_dir):
                shutil.rmtree(tiles_dir)
            os.makedirs(tiles_dir, exist_ok=True)

    index = SourceIndex(tiles)
    datasets = open_all(tiles, workers=args.workers)

    if not args.grids_only:
        for z in range(args.max_zoom, -1, -1):
            n = TILE_SIZE * (2 ** z)
            t = time.time()
            arrays = {}
            for src in tiles:
                ds = datasets.get(src["key"])
                if ds is None:
                    continue
                arrays[src["key"]] = warp_tile(ds, src["lon0"], src["lon1"],
                                               src["lat0"], src["lat1"], n)
            log(f"zoom {z}: {len(arrays)} source tiles warped in {round(time.time() - t)}s")
            for mode in args.modes:
                if z > mode_max.get(mode, -1):
                    continue
                written = write_zoom(tiles, arrays, index, z, mode,
                                     os.path.join(args.out, mode, "tiles"))
                log(f"{mode}: zoom {z} -> {written} tiles")
            del arrays
    else:
        log("grids-only: keeping existing tiles")

    width, height = build_grids(tiles, datasets, args.out)
    if not verify(args.out, width, height):
        print("[cropland] verification FAILED", file=sys.stderr)
        return 2

    meta = {
        "classes": [
            {"code": code, "title": title, "color": colour}
            for code, title, colour in CLASSES
        ],
        "cropland_color": "#%02X%02X%02X" % CROPLAND_COLOR,
        "grid": {
            "width": width,
            "height": height,
            "degrees": GRID_DEG,
            "dtype": "uint8",
            "grids": {
                "share": "grid.bin",
                "class": "class.bin",
            },
        },
        "attribution": "ESA WorldCover 10 m v200 (2021) — CC BY 4.0",
        "license": "CC BY 4.0",
        "source": "https://esa-worldcover.esa.int/",
    }
    with open(os.path.join(args.out, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
