#!/usr/bin/env python3
"""
Build the topography/bathymetry relief overlay for the Xyzo map.

Source: NOAA NCEI ETOPO 2022 v1, 60 arc-second "surface" (ice surface)
  https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/
  ETOPO_2022_v1_60s_N90W180_surface.tif  (~466 MB, public domain)

Why ETOPO2022 and not ETOPO1: NOAA retired the ETOPO1 downloads (the
links 404). ETOPO2022 at 60 arc-seconds IS the same 1 arc-minute spec
ETOPO1 shipped at — the maintained successor of the same product line —
and "surface" is the Ice-Surface variant the SOS catalog described.
Free, no key, US Government work.

The 466 MB GeoTIFF is downloaded ONCE into ~/.xyzo/etopo/ (outside the
repo) and reused by every rebuild. The builder warps it to Web Mercator
per zoom, shades it with a numpy hillshade, colours it with a
hypsometric ramp quantised to 31 elevation bins × 8 shade steps = 248
palette slots — one FIXED palette shared by every tile, so adjacent
tiles seam-match exactly and each PNG is tiny (indexed colour).

Outputs (all under public_html/data/etopo/):
  tiles/{z}/{x}/{y}.png   XYZ pyramid, z0..max-zoom (default 7 ≈ 1.2 km/px)
  grid.bin                Int16 probe grid, 0.1 deg, metres, north row first
  meta.json               ramp + grid geometry + attribution

Usage:
  python3 scripts/etopo_build.py
  python3 scripts/etopo_build.py --max-zoom 6        # fewer tiles
  python3 scripts/etopo_build.py --verify-only       # just the gate
  python3 scripts/etopo_build.py --skip-download     # offline
"""

from __future__ import annotations

import argparse
import json
import math
import os
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

SOURCE_URL = (
    "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/"
    "60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif"
)
SOURCE_NAME = "ETOPO_2022_v1_60s_surface.tif"
SOURCE_DIR = os.path.join(os.path.expanduser("~"), ".xyzo", "etopo")
SOURCE_PATH = os.path.join(SOURCE_DIR, SOURCE_NAME)
SOURCE_BYTES = 465_969_062  # content-length; guards against a truncated download

TILE_SIZE = 256
HALF = 20037508.342789244
GRID_DEG = 0.1
NODATA = -32768

# Shade is quantised to 8 steps; bins*8 + 1 must fit a byte palette.
SHADE_STEPS = 8

# Classic hypsometric stops: elevation (m) -> colour. More bins near sea
# level so the shelf and the coastal plain stay readable; the deep ocean
# and the high peaks are smooth enough to coarsen.
BIN_EDGES = [
    -11000, -9000, -7000, -5500, -4500, -3500, -2500, -1800,
    -1200, -700, -300, -100, -20, 0, 50, 150, 300, 600,
    1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000,
    5500, 6000, 7000, 8000, 9000,
]  # 32 edges -> 31 bins -> 31*8 = 248 slots + 1 transparent = 249 <= 256

COLOUR_STOPS = [
    (-11000, "#000018"), (-9000, "#000030"), (-7000, "#000050"),
    (-5500, "#001870"), (-4500, "#003090"), (-3500, "#0050a8"),
    (-2500, "#1878c0"), (-1800, "#3098d0"), (-1200, "#58b0dc"),
    (-700, "#80c8e8"), (-300, "#a8d8f0"), (-100, "#c8e8f8"),
    (-20, "#e0f0fc"), (0, "#f0f8ff"),
    (0, "#2d8a2d"), (50, "#46a03c"), (150, "#6cb844"),
    (300, "#96cc4e"), (600, "#c2d85c"), (1000, "#e0cc66"),
    (1500, "#d8b45a"), (2000, "#c99a4e"), (2500, "#b98146"),
    (3000, "#a86b40"), (3500, "#96583c"), (4000, "#854838"),
    (4500, "#743c34"), (5000, "#a09088"), (5500, "#c0b8b0"),
    (6000, "#e0dcd8"), (7000, "#f0eeec"), (8000, "#ffffff"),
    (9000, "#ffffff"),
]

# verify(): known elevations, checked against the SOURCE before publishing.
# Bounds are calibrated to what a 60-arc-second (~1.8 km) model actually
# produces — the grid averages peaks and trenches across a whole cell, so
# Everest comes out ~6,700 m and Challenger Deep ~-10,000 m, not their
# survey extremes. The probes' job is catching a flipped axis or a
# scrambled row order, not second-gridding the source's own smoothing.
ELEV_PROBES = [
    # (lat, lng, lo_m, hi_m, label)
    (11.37, 142.59, -10500, -9500, "Challenger Deep"),
    (27.998, 86.925, 6000, 9000, "Everest"),
    (31.50, 35.50, -700, -100, "Dead Sea shore"),
    (0.0, -30.0, -4500, -3000, "Mid-Atlantic abyssal plain"),
    (0.0, -140.0, -6000, -4000, "Central Pacific abyssal plain"),
    (52.50, 4.80, -20, 80, "Netherlands coast"),
    (63.07, -151.00, 4000, 6300, "Denali"),
    (-82.0, 0.0, 1500, 3500, "Antarctic ice sheet"),
]


def log(msg: str) -> None:
    print(f"[etopo] {msg}", flush=True)


# ── source ──────────────────────────────────────────────────────────────

def ensure_source(skip_download: bool = False) -> str:
    """Download the GeoTIFF once (resumable) into ~/.xyzo/etopo/."""
    if os.path.exists(SOURCE_PATH):
        size = os.path.getsize(SOURCE_PATH)
        if size == SOURCE_BYTES:
            return SOURCE_PATH
        if size > SOURCE_BYTES:
            raise RuntimeError(f"{SOURCE_PATH} is {size} bytes, expected {SOURCE_BYTES}")
        if skip_download:
            raise RuntimeError(f"{SOURCE_PATH} is truncated ({size}/{SOURCE_BYTES}) and --skip-download was set")
        log(f"resuming partial download ({size:,}/{SOURCE_BYTES:,})")
    elif skip_download:
        raise RuntimeError(f"{SOURCE_PATH} missing and --skip-download was set")

    os.makedirs(SOURCE_DIR, exist_ok=True)
    part = SOURCE_PATH + ".part"
    offset = os.path.getsize(part) if os.path.exists(part) else 0
    if offset:
        log(f"resuming download at {offset:,} bytes")
    req = urllib.request.Request(
        SOURCE_URL,
        headers={"Range": f"bytes={offset}-"} if offset else {},
    )
    log(f"downloading {SOURCE_URL} ...")
    with urllib.request.urlopen(req, timeout=120) as resp, open(part, "ab" if offset else "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    size = os.path.getsize(part)
    if size != SOURCE_BYTES:
        raise RuntimeError(f"download incomplete: {size}/{SOURCE_BYTES} bytes (rerun to resume)")
    os.replace(part, SOURCE_PATH)
    log(f"source ready: {SOURCE_PATH} ({size:,} bytes)")
    return SOURCE_PATH


def open_source() -> "gdal.Dataset":
    ds = gdal.Open(SOURCE_PATH)
    if ds is None:
        raise RuntimeError(f"cannot open {SOURCE_PATH}")
    return ds


# ── colouring ───────────────────────────────────────────────────────────

def _hex_to_rgb(h: str) -> tuple:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def ramp_colour(elev: float) -> tuple:
    """Interpolate the hypsometric stop list at an elevation."""
    if elev <= COLOUR_STOPS[0][0]:
        return _hex_to_rgb(COLOUR_STOPS[0][1])
    for i in range(len(COLOUR_STOPS) - 1):
        e0, c0 = COLOUR_STOPS[i]
        e1, c1 = COLOUR_STOPS[i + 1]
        if e0 <= elev <= e1:
            if e1 == e0:
                return _hex_to_rgb(c1)
            # A duplicated edge (the 0 m coast pair) means a hard cut —
            # take the land colour, not a blend across the shoreline.
            if e0 == e1:
                return _hex_to_rgb(c1)
            t = (elev - e0) / (e1 - e0)
            a, b = _hex_to_rgb(c0), _hex_to_rgb(c1)
            return tuple(round(a[k] + (b[k] - a[k]) * t) for k in range(3))
    return _hex_to_rgb(COLOUR_STOPS[-1][1])


def build_palette() -> list:
    """256*3 RGB table: slot 0 transparent, then bins*SHADE_STEPS slots.

    Every tile uses THIS palette, so a colour that spans two tiles is
    pixel-identical across the seam.
    """
    nbins = len(BIN_EDGES) - 1
    pal = [0, 0, 0]  # slot 0 = no data
    for i in range(nbins):
        mid = (BIN_EDGES[i] + BIN_EDGES[i + 1]) / 2
        base = ramp_colour(mid)
        for s in range(SHADE_STEPS):
            # shade 0 = full shadow, 7 = full light. Floor 0.55 so
            # shadows stay legible, not black.
            f = 0.55 + 0.45 * (s / (SHADE_STEPS - 1))
            pal.extend(int(round(c * f)) for c in base)
    while len(pal) < 768:
        pal.extend([0, 0, 0])
    return pal


def build_ramp_meta() -> list:
    """[{c: metres, colour}] at bin edges — the client draws the legend
    as a CSS linear-gradient from this."""
    return [
        {"c": int(BIN_EDGES[i]),
         "rgb": ramp_colour((BIN_EDGES[i] + BIN_EDGES[i + 1]) / 2)}
        for i in range(len(BIN_EDGES) - 1)
    ]


def hillshade(elev: np.ndarray) -> np.ndarray:
    """Horn hillshade, 0..255. Light: azimuth 315°, altitude 45°.

    Elevation is metres; cell size is in pixels — for visual shading
    that is fine (the classic map-maker's shorthand) and it keeps the
    per-strip computation dependency-free.
    """
    z = elev.astype(np.float32)
    # pad one pixel so interior gradients have neighbours at the strip edges
    p = np.pad(z, 1, mode="edge")
    dzdx = (p[1:-1, 2:] - p[1:-1, :-2]) / 2.0
    dzdy = (p[2:, 1:-1] - p[:-2, 1:-1]) / 2.0
    # slope is the ANGLE (radians), not the gradient magnitude — using
    # hypot() raw feeds a huge number into sin/cos and the shade collapses
    # to 0 on any steep terrain.
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)  # aspect in math convention
    az = math.radians(315.0)
    alt = math.radians(45.0)
    shaded = (np.sin(alt) * np.cos(np.pi / 2 - slope)
              + np.cos(alt) * np.sin(np.pi / 2 - slope) * np.cos(az - aspect))
    shaded = np.clip(shaded, 0.0, 1.0)
    return (shaded * 255.0).astype(np.uint8)


# ── warping ─────────────────────────────────────────────────────────────

def warp_to_mercator(src_ds, size: int, out_path: str) -> None:
    opts = gdal.WarpOptions(
        format="GTiff",
        outputBounds=(-HALF, -HALF, HALF, HALF),
        width=size,
        height=size,
        dstSRS="EPSG:3857",
        srcNodata=NODATA,
        dstNodata=NODATA,
        # Elevation is a continuous field — average is the honest
        # interpolation, same rule as the soil property rasters.
        resampleAlg=gdal.GRA_Average,
        multithread=True,
        warpMemoryLimit=512 * 1024 * 1024,
        outputType=gdal.GDT_Int16,
        creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=2", "TILED=YES", "BIGTIFF=YES"],
    )
    gdal.Warp(out_path, src_ds, options=opts)


def warp_to_grid(src_ds, out_path: str) -> None:
    width = int(360 / GRID_DEG)
    height = int(180 / GRID_DEG)
    opts = gdal.WarpOptions(
        format="GTiff",
        outputBounds=(-180.0, -90.0, 180.0, 90.0),
        width=width,
        height=height,
        dstSRS="EPSG:4326",
        srcNodata=NODATA,
        dstNodata=NODATA,
        resampleAlg=gdal.GRA_Average,
        outputType=gdal.GDT_Int16,
        creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=2", "TILED=YES"],
    )
    gdal.Warp(out_path, src_ds, options=opts)


# ── verification ────────────────────────────────────────────────────────

def sample_elev(lat: float, lng: float) -> float:
    """Mean elevation of a tiny window read from the SOURCE."""
    ds = open_source()
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


def verify() -> bool:
    """Gate: known places must carry the elevations geography says."""
    ok = True
    for lat, lng, lo, hi, label in ELEV_PROBES:
        v = sample_elev(lat, lng)
        if math.isnan(v):
            log(f"probe {label:28s} ({lat:7.2f},{lng:8.2f})  no-data  FAIL")
            ok = False
            continue
        good = lo <= v <= hi
        log(f"probe {label:28s} ({lat:7.2f},{lng:8.2f})  {v:9.0f} m  "
            f"{'ok' if good else f'FAIL (want {lo}..{hi})'}")
        if not good:
            ok = False
    return ok


# ── tiling ──────────────────────────────────────────────────────────────

STRIP_ROWS = 512


def write_zoom(z: int, merc_path: str, out_dir: str, pal: list) -> int:
    """Colour + shade one warped master into a tile pyramid."""
    n = TILE_SIZE * (2 ** z)
    ds = gdal.Open(merc_path)
    band = ds.GetRasterBand(1)
    written = 0
    nbins = len(BIN_EDGES) - 1
    # Inner thresholds: digitize(v) = i  <=>  BIN_EDGES[i] <= v < BIN_EDGES[i+1]
    # for i in 0..nbins-1 (first bin swallows everything below edges[1]).
    inner = np.array(BIN_EDGES[1:-1], dtype=np.int32)
    shade_div = 256 // SHADE_STEPS

    for y0 in range(0, n, STRIP_ROWS):
        rows = min(STRIP_ROWS, n - y0)
        core = band.ReadAsArray(0, y0, n, rows)
        if core is None:
            continue
        # hillshade pads its own edges (mode="edge"), so no cross-strip
        # read is needed — each strip shades independently.
        shade = hillshade(core)
        bins = np.digitize(core, inner, right=False)
        bins = np.clip(bins, 0, nbins - 1)
        shade_lvl = np.clip(shade // shade_div, 0, SHADE_STEPS - 1)

        idx = (1 + bins * SHADE_STEPS + shade_lvl).astype(np.uint8)
        idx[core == NODATA] = 0

        for ty in range(y0 // TILE_SIZE, (y0 + rows - 1) // TILE_SIZE + 1):
            r0 = max(y0, ty * TILE_SIZE)
            r1 = min(y0 + rows, (ty + 1) * TILE_SIZE)
            if r1 <= r0:
                continue
            sub = idx[r0 - y0:r1 - y0]
            for tx in range(n // TILE_SIZE):
                block = sub[:, tx * TILE_SIZE:(tx + 1) * TILE_SIZE]
                if not block.any():
                    continue  # pure no-data — nothing to draw
                img = Image.fromarray(block, mode="P")
                img.putpalette(pal)
                img.info["transparency"] = bytes([0])
                path = os.path.join(out_dir, str(z), str(tx), f"{ty}.png")
                os.makedirs(os.path.dirname(path), exist_ok=True)
                img.save(path, optimize=True)
                written += 1
    ds = None
    return written


def write_grid(src_ds, out_path: str, tmpdir: str) -> None:
    tmp = os.path.join(tmpdir, "grid.tif")
    warp_to_grid(src_ds, tmp)
    gds = gdal.Open(tmp)
    arr = gds.GetRasterBand(1).ReadAsArray()
    gds = None
    os.remove(tmp)
    np.ascontiguousarray(arr.astype("<i2")).tofile(out_path)


# ── main ────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, "public_html", "data", "etopo"))
    ap.add_argument("--max-zoom", type=int, default=7,
                    help="highest pyramid zoom (7 ≈ 1.2 km/px, matches the 1-arc-min source)")
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--skip-download", action="store_true",
                    help="fail instead of downloading (offline rebuilds)")
    ap.add_argument("--keep-intermediate", action="store_true")
    args = ap.parse_args()

    gdal.SetConfigOption("GDAL_HTTP_TIMEOUT", "120")
    gdal.SetConfigOption("GDAL_HTTP_MAX_RETRY", "3")

    try:
        ensure_source(skip_download=args.skip_download)
    except Exception as exc:
        print(f"[etopo] {exc}", file=sys.stderr)
        return 1

    if args.verify_only:
        return 0 if verify() else 2

    log(f"max zoom {args.max_zoom}")
    if not verify():
        print("[etopo] verification FAILED — refusing to publish", file=sys.stderr)
        return 2

    tmpdir = tempfile.mkdtemp(prefix="etopo-build-")
    try:
        src = open_source()
        os.makedirs(args.out, exist_ok=True)

        # ── probe grid ──
        grid_path = os.path.join(args.out, "grid.bin")
        write_grid(src, grid_path, tmpdir)
        log("probe grid written (0.1 deg, metres)")

        # ── tiles ──
        pal = build_palette()
        tiles_dir = os.path.join(args.out, "tiles")
        if os.path.exists(tiles_dir):
            shutil.rmtree(tiles_dir)
        os.makedirs(tiles_dir, exist_ok=True)
        for z in range(args.max_zoom, -1, -1):
            size = TILE_SIZE * (2 ** z)
            merc = os.path.join(tmpdir, f"merc_{z}.tif")
            warp_to_mercator(src, size, merc)
            written = write_zoom(z, merc, tiles_dir, pal)
            os.remove(merc)
            log(f"zoom {z} -> {written} tiles")
        src = None

        # ── meta ──
        meta = {
            "key": "etopo",
            "title": "Topography & Bathymetry (ETOPO)",
            "unit": "m",
            "scale": 1,
            "decimals": 0,
            "blurb": (
                "ETOPO 2022 v1 at 60 arc-seconds — land topography and "
                "ocean bathymetry in one relief model (the maintained "
                "successor to ETOPO1, same 1 arc-minute spec)."
            ),
            "ramp": build_ramp_meta(),
            "shade_steps": SHADE_STEPS,
            "grid": {
                "width": int(360 / GRID_DEG),
                "height": int(180 / GRID_DEG),
                "degrees": GRID_DEG,
                "nodata": NODATA,
                "dtype": "int16",
            },
            "source": SOURCE_URL,
            "attribution": "NOAA NCEI ETOPO 2022 v1 — public domain",
            # ETOPO is a US Government work, so the data itself carries
            # no reuse restriction — but data-licences.bun.test.js
            # requires the field, and an overlay whose meta.json omits
            # its licence is indistinguishable from one that is
            # restricted. Emitted here so a rebuild cannot drop it.
            "license": "US Government work (public domain)",
        }
        with open(os.path.join(args.out, "meta.json"), "w") as fh:
            json.dump(meta, fh, indent=1)
        log("meta.json written")
    finally:
        if not args.keep_intermediate:
            shutil.rmtree(tmpdir, ignore_errors=True)

    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
