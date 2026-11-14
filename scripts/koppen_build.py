#!/usr/bin/env python3
"""
Build the Koeppen-Geiger climate overlay assets served to the Xyzo map.

Source: Beck et al. 2018, "Present and future Koppen-Geiger climate
classification maps at 1-km resolution", Scientific Data 5, 180214.
  DOI      10.6084/m9.figshare.6396959   (CC BY 4.0)
  File     Beck_KG_V1_present_0p0083.tif  43200x21600 unsigned byte
  Values   1..30 = the 30 Koppen-Geiger classes, 0 = ocean

WHY BECK AND NOT THE KML WE USED BEFORE
--------------------------------------
The previous source was maps/World_Koppen_Gerrit_Hendriksen.kml, a
digitisation of the figure in Peel et al. (2007). That article is
licensed CC BY-NC-SA 2.5 — NonCommercial AND ShareAlike — which is the
only licence exposure this project had (docs/DATA_LICENSES.md §4). Beck
et al. remapped the same classification under CC BY 4.0, at 1 km
resolution (the old KML was a 0.5 deg grid). Same symbols, cleaner
licence, thirty times finer.

The colours, descriptions and criteria in BECK_CLASSES are the ones the
map already uses, so the 29-class key in the layers dropdown does not
change; only the classification data is Beck's.

Outputs (all under public_html/data/koppen/):
  tiles/{z}/{x}/{y}.png   XYZ tile pyramid, EPSG:3857, transparent over ocean
  classes.json            the climate classes: code, group, description, criteria, color
  grid.png                paletted lookup grid (0.25 deg) for "climate at this point"

Usage:
  python3 -m scripts.koppen_build [--beck PATH] [--out DIR] [--max-zoom 6]
  python3 -m scripts.koppen_build --verify-only
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter

try:
    from osgeo import gdal, osr
except ImportError as exc:  # pragma: no cover
    print(f"GDAL python bindings required: {exc}", file=sys.stderr)
    raise

import numpy as np
from PIL import Image

gdal.UseExceptions()

KML_NS = "{http://www.opengis.net/kml/2.2}"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(REPO, "worker", "data", "koppen")

# Grid resolutions. Beck et al. is 1/120 deg (928 m) — the display
# raster reads the source at its OWN resolution, so nothing is thrown
# away before the warp. The lookup grid is what the probe reads.
RASTER_DEG = 1.0 / 120.0  # source resolution, for verify()
GRID_DEG = 0.05           # client-side lookup grid (5.6 km)


# ── KML parsing ──────────────────────────────────────────────────────────

def read_kml(path: str) -> str:
    """Read the KML, fixing the mis-declared encoding (ISO-8859-1 -> UTF-8)."""
    raw = open(path, "rb").read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        # latin-1 bytes reinterpreted as UTF-8: preserves the o-umlaut.
        return raw.decode("latin-1").encode("utf-8").decode("utf-8")


def parse_styles(root: ET.Element) -> dict:
    """style id -> {code, description, criteria, color(rgba), group}."""
    styles = {}
    for st in root.iter(f"{KML_NS}Style"):
        sid = st.get("id")
        if not sid or not sid.isdigit():
            continue  # label styles + "<all other values>" are not class styles
        poly = st.find(f"{KML_NS}PolyStyle")
        if poly is None:
            continue
        cnode = poly.find(f"{KML_NS}color")
        if cnode is None or not cnode.text:
            continue
        abgr = cnode.text.strip().upper()
        if len(abgr) != 8:
            continue
        a, b, g, r = (int(abgr[i : i + 2], 16) for i in (0, 2, 4, 6))
        ball = st.find(f"{KML_NS}BalloonStyle/{KML_NS}text")
        text = ball.text if ball is not None and ball.text else ""
        m = re.search(r"This is\s+([A-Za-z]+)", text)
        code = m.group(1) if m else sid
        desc = re.search(r"- description\s*:\s*([^\r\n<]+)", text)
        crit = re.search(r"- criteria\s*:\s*([^\r\n<]+)", text)
        styles[sid] = {
            "id": sid,
            "code": code,
            "description": (desc.group(1).strip() if desc else ""),
            "criteria": (crit.group(1).strip() if crit else ""),
            "rgba": (r, g, b, a),
            "color": "#%02X%02X%02X" % (r, g, b),
        }
    return styles


def parse_polygons(root: ET.Element):
    """Yield (style_id, outer_ring, [inner_rings]) for every Polygon placemark."""
    for pm in root.iter(f"{KML_NS}Placemark"):
        poly = pm.find(f"{KML_NS}Polygon")
        if poly is None:
            continue
        su = pm.find(f"{KML_NS}styleUrl")
        if su is None or not su.text:
            continue
        style_id = su.text.strip().lstrip("#")

        def ring_of(node):
            c = node.find(
                f"{KML_NS}LinearRing/{KML_NS}coordinates"
            )
            if c is None or not c.text:
                return None
            pts = []
            for tok in c.text.split():
                parts = tok.split(",")
                if len(parts) < 2:
                    continue
                try:
                    pts.append((float(parts[0]), float(parts[1])))
                except ValueError:
                    continue
            return pts or None

        outer = ring_of(poly.find(f"{KML_NS}outerBoundaryIs"))
        if not outer or len(outer) < 4:
            continue
        holes = []
        for ib in poly.findall(f"{KML_NS}innerBoundaryIs"):
            h = ring_of(ib)
            if h and len(h) >= 4:
                holes.append(h)
        yield style_id, outer, holes


# ── Rasterisation ────────────────────────────────────────────────────────

def rasterize(polys, styles, width, height, bbox=(-180.0, -90.0, 180.0, 90.0)):
    """Burn each polygon into a uint8 class-id raster (0 = nodata).

    Output is NORTH-UP: row 0 is the top edge (lat = y1), matching the
    GeoTIFF north-up geotransform and the PNG top-down row order.

    Uses a scanline fill on each polygon's bounding box, which is far cheaper
    than a full-canvas point-in-polygon test for ~4.5k small polygons.
    """
    grid = bytearray(width * height)
    x0, y0, x1, y1 = bbox
    sx = width / (x1 - x0)
    sy = height / (y1 - y0)

    for style_id, outer, holes in polys:
        cid = int(style_id)
        if cid <= 0 or cid > 255:
            continue
        ring = outer[:-1] if outer[0] == outer[-1] else outer
        if len(ring) < 3:
            continue

        px = [(p[0] - x0) * sx for p in ring]
        py = [(p[1] - y0) * sy for p in ring]

        min_ix = max(0, int(min(px)))
        max_ix = min(width - 1, int(max(px)) + 1)
        min_iy = max(0, int(min(py)))
        max_iy = min(height - 1, int(max(py)) + 1)
        if min_ix > max_ix or min_iy > max_iy:
            continue

        hole_rings = []
        for h in holes:
            hr = h[:-1] if h[0] == h[-1] else h
            if len(hr) >= 3:
                hole_rings.append(
                    (
                        [(p[0] - x0) * sx for p in hr],
                        [(p[1] - y0) * sy for p in hr],
                    )
                )

        for iy in range(min_iy, max_iy + 1):
            cy = iy + 0.5
            crossings = []
            for ring_px, ring_py in [(px, py)] + hole_rings:
                n = len(ring_px)
                for i in range(n):
                    ax, ay = ring_px[i], ring_py[i]
                    bx, by = ring_px[(i + 1) % n], ring_py[(i + 1) % n]
                    if (ay > cy) != (by > cy):
                        crossings.append(ax + (cy - ay) * (bx - ax) / (by - ay))
            if not crossings:
                continue
            crossings.sort()
            # flip to north-up: row 0 = top (lat y1)
            base = (height - 1 - iy) * width
            for i in range(0, len(crossings) - 1, 2):
                a = int(crossings[i] + 0.5)
                b = int(crossings[i + 1] + 0.5)
                if a < min_ix:
                    a = min_ix
                if b > max_ix:
                    b = max_ix
                if b <= a:
                    continue
                for ix in range(a, b + 1):
                    grid[base + ix] = cid
    return grid


# ── Beck et al. 2018 input (the CC BY 4.0 source) ─────────────────────────
#
# The KML this script used to read is Gerrit Hendriksen's digitisation
# of Peel et al. 2007, whose paper is CC BY-NC-SA 2.5 — a NonCommercial
# AND ShareAlike licence (see docs/DATA_LICENSES.md §4). Beck et al.
# (2018) is a peer-reviewed remapping of the same classification at 1 km
# resolution, published under CC BY 4.0: no NonCommercial clause, no
# ShareAlike, and thirty times finer than the 0.5° source we used to
# derive from.
#
# The GeoTIFF stores one unsigned byte per cell, 1..30, with 0 for
# ocean. The colours, descriptions and criteria below are the ones the
# map already uses (so the 29-class key in the layers dropdown does not
# change); only the CLASSIFICATION DATA is Beck's.
BECK_CLASSES = {
    #  code : (hex colour, description, criteria)
    "Af": ("#0000FF", "Tropical - Rainforest", "precipitation of the driest month = 60"),
    "Am": ("#0077FF", "Tropical - Monsoon", "Not (Af) & precipitation of the driest month = 100-mean annual precipitation/25"),
    "Aw": ("#46A9FA", "Tropical - Savannah", "Not (Af) & precipitation of the driest month"),
    "BSh": ("#F5A300", "Arid - Steppe - Hot Summer", "mean annual temperature >= 18"),
    "BSk": ("#FFDB63", "Arid - Steppe - Cold Summer", "mean annual temperature"),
    "BWh": ("#FF0000", "Arid - Desert - Hot", "mean annual precipitation"),
    "BWk": ("#FF9696", "Arid - Desert - Cold", "mean annual precipitation"),
    "Csa": ("#FFFF00", "Temperate - Dry Summer", "precipitation of the driest month in summer"),
    "Csb": ("#C7C700", "Temperate - Dry Summer", "precipitation of the driest month in summer"),
    "Csc": ("#969600", "Temperate - Dry Summer", "precipitation of the driest month in summer"),
    "Cwa": ("#96FF96", "Temperate - Dry Winter", "precipitation of the driest month in winter"),
    "Cwb": ("#63C763", "Temperate - Dry Winter", "precipitation of the driest month in winter"),
    "Cwc": ("#329632", "Temperate - Dry Winter", "precipitation of the driest month in winter"),
    "Cfa": ("#C7FF4F", "Temperate - Without dry season- Hot Summer", "temperature of the hottest month >= 22"),
    "Cfb": ("#66FF33", "Temperate - Without dry season- Warm Summer", "Not (a) & number of months where the temperature is above 10 = 4"),
    "Cfc": ("#32C700", "Temperate - Without dry season- Cold Summer", "Not (a or b) & 1 = number of months where the temperature is above 10"),
    "Dsa": ("#FF00FF", "Cold - Dry Summer", "precipitation of the driest month in summer"),
    "Dsb": ("#C700C7", "Cold - Dry Summer", "precipitation of the driest month in summer"),
    "Dsc": ("#963296", "Cold - Dry Summer", "precipitation of the driest month in summer"),
    "Dsd": ("#966596", "Cold - Dry Summer", "precipitation of the driest month in summer"),
    "Dwa": ("#ABB0FF", "Cold - Dry Winter", "precipitation of the driest month in winter"),
    "Dwb": ("#5A78DB", "Cold - Dry Winter", "precipitation of the driest month in winter"),
    "Dwc": ("#4C51B5", "Cold - Dry Winter", "precipitation of the driest month in winter"),
    "Dwd": ("#320087", "Cold - Dry Winter", "precipitation of the driest month in winter"),
    "Dfa": ("#00FFFF", "Cold - Without dry season - Hot Summer", "temperature of the hottest month = 22"),
    "Dfb": ("#38C7FF", "Cold - Without dry season - Warm Summer", "Not (a) & number of months where the temperature is above 10 = 4"),
    "Dfc": ("#007D7D", "Cold - Without dry season - Cold Summer", "Not (a, b or d)"),
    "Dfd": ("#00455E", "Cold - Without dry season - Very Cold Winter", "Not (a or b) & temperature of the coldest month"),
    "ET": ("#B2B2B2", "Polar - Tundra", "temperature of the hottest month > 0"),
    "EF": ("#686868", "Polar - Frost", "temperature of the hottest month = 0"),
}

# Beck et al.'s value 1..30 in legend.txt order.
BECK_CODES = [
    "Af", "Am", "Aw", "BWh", "BWk", "BSh", "BSk",
    "Csa", "Csb", "Csc", "Cwa", "Cwb", "Cwc", "Cfa", "Cfb", "Cfc",
    "Dsa", "Dsb", "Dsc", "Dsd", "Dwa", "Dwb", "Dwc", "Dwd",
    "Dfa", "Dfb", "Dfc", "Dfd",
    "ET", "EF",
]


def load_beck(path: str, width: int, height: int):
    """Read the Beck et al. 2018 1-km GeoTIFF down to the display grid.

    Nearest-neighbour on purpose: the values are CLASS IDs, and any
    averaging would invent classes that do not exist.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    ds = gdal.Open(path, gdal.GA_ReadOnly)
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray(buf_xsize=width, buf_ysize=height)
    ds = None

    # Beck's value n is BECK_CODES[n-1]; 0 is ocean. The rest of this
    # pipeline keys everything on a `styles` dict whose keys are the
    # integer ids in the grid, so style id == Beck value.
    styles: dict[str, dict] = {}
    for value, code in enumerate(BECK_CODES, start=1):
        hexcol, desc, crit = BECK_CLASSES[code]
        r, g, b = int(hexcol[1:3], 16), int(hexcol[3:5], 16), int(hexcol[5:7], 16)
        styles[str(value)] = {
            "code": code,
            "color": hexcol,
            "rgba": (r, g, b, 255),
            "description": desc,
            "criteria": crit,
        }

    return arr.reshape(-1), styles


# ── Tile pyramid (built by hand) ─────────────────────────────────────────
# gdal2tiles mis-aligns the rows of this dataset (it resamples the palette
# band into an overview and the overview geotransform drifts), so the
# pyramid is generated directly: warp the classified band to Web Mercator
# with NEAREST resampling (class ids must survive untouched), then slice.

MER_SIZE = 32768  # master mercator raster: 1223 m/px at the equator —
                  # 1.3x the source's 928 m, and 32768/128 = 256 so the
                  # z7 tiles slice it EXACTLY with no resampling


def warp_to_mercator(tif_path: str, out_path: str) -> "np.ndarray":
    """Warp the classified band to EPSG:3857 and return it as a numpy array."""
    import numpy as np

    half = 20037508.342789244  # Web Mercator half-extent in metres
    opts = gdal.WarpOptions(
        format="GTiff",
        outputBounds=(-half, -half, half, half),
        width=MER_SIZE,
        height=MER_SIZE,
        dstSRS="EPSG:3857",
        srcNodata=0,
        dstNodata=0,
        resampleAlg=gdal.GRA_NearestNeighbour,
        multithread=True,
        warpMemoryLimit=256 * 1024 * 1024,
    )
    gdal.Warp(out_path, tif_path, options=opts)
    ds = gdal.Open(out_path, gdal.GA_ReadOnly)
    arr = ds.GetRasterBand(1).ReadAsArray()
    ds = None
    return np.ascontiguousarray(arr)


def rgba_from_ids(block, palette_rgba):
    """class-id block -> RGBA numpy array (index 0 = transparent)."""
    import numpy as np

    pal = np.array(palette_rgba, dtype=np.uint8).reshape(-1, 4)
    return pal[block]


def build_tiles(merc, out_dir, palette_rgba, max_zoom, tile_size=256):
    """Slice the mercator raster into an XYZ pyramid (z0..max_zoom)."""
    import numpy as np
    from PIL import Image

    n = merc.shape[0]
    written = 0
    for z in range(max_zoom, -1, -1):
        count = 2**z
        step = n / count
        d = os.path.join(out_dir, str(z))
        for ty in range(count):
            for tx in range(count):
                x0 = max(0, int(round(tx * step)))
                x1 = min(n, int(round((tx + 1) * step)))
                y0 = max(0, int(round(ty * step)))
                y1 = min(n, int(round((ty + 1) * step)))
                if x1 <= x0 or y1 <= y0:
                    img = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
                else:
                    block = merc[y0:y1, x0:x1]
                    img = Image.fromarray(rgba_from_ids(block, palette_rgba), "RGBA")
                    if img.size != (tile_size, tile_size):
                        img = img.resize((tile_size, tile_size), Image.BOX)
                tdir = os.path.join(d, str(tx))
                os.makedirs(tdir, exist_ok=True)
                img.save(os.path.join(tdir, f"{ty}.png"), optimize=True)
                written += 1
    return written


def group_of(code: str) -> str:
    c = (code or "").strip()
    if c.startswith("A"):
        return "Tropical"
    if c.startswith("B"):
        return "Arid"
    if c.startswith("C"):
        return "Temperate"
    if c.startswith("D"):
        return "Cold"
    if c.startswith("E"):
        return "Polar"
    return "Other"


# sanity probes: (lat, lng, expected Koeppen code or None for "no data")
# These were set against the Beck et al. 2018 classification, which
# differs from Peel et al. 2007 in a few places: Beck puts the Amazon
# interior in Af (rainforest) where Peel had Am (monsoon), and Beck has
# a Csc class the older map did not carry.
PROBES = [
    (23.0, 12.0, "BWh"),    # Sahara
    (0.0, 25.0, "Af"),      # Congo basin
    (-3.0, -60.0, "Af"),    # Amazon interior (Beck: rainforest; Peel: monsoon)
    (25.0, 45.0, "BWh"),    # Arabian desert
    (55.0, 37.0, "Dfb"),    # Moscow
    (64.0, 100.0, "Dfc"),   # Siberia
    (-25.0, 135.0, "BWh"),  # Australian outback
    (40.0, -100.0, "Dfa"),  # US plains (humid continental)
    (-80.0, 0.0, "EF"),     # Antarctica
    (78.0, 15.0, "ET"),     # Svalbard
    (13.0, 75.0, "Am"),     # India's monsoon coast (Mangalore)
]


def verify(grid, width, height, styles):
    """Probe known locations to catch orientation / colour-table mistakes."""
    ok = True
    for lat, lng, expect in PROBES:
        ix = min(width - 1, max(0, int((lng + 180.0) / 360.0 * width)))
        iy = min(height - 1, max(0, int((90.0 - lat) / 180.0 * height)))
        cid = grid[iy * width + ix]
        code = styles.get(str(cid), {}).get("code", "-")
        flag = "ok " if code == expect else "FAIL"
        if code != expect:
            ok = False
        print(f"[koppen]   probe {lat:>6.1f},{lng:>7.1f} -> {code:<4} (expect {expect}) {flag}")
    return ok


def verify_mercator(merc, styles):
    """Probe the warped Web Mercator raster the same way.

    Guards the tile pipeline: a wrong warp or a flipped axis would show up
    here as a class mismatch before a single tile is written.
    """
    import math

    n = merc.shape[0]
    ok = True
    for lat, lng, expect in PROBES:
        x = (lng + 180.0) / 360.0
        s = math.sin(math.radians(lat))
        y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
        ix = min(n - 1, max(0, int(x * n)))
        iy = min(n - 1, max(0, int(y * n)))
        cid = int(merc[iy, ix])
        code = styles.get(str(cid), {}).get("code", "-")
        flag = "ok " if code == expect else "FAIL"
        if code != expect:
            ok = False
        print(f"[koppen]   merc  {lat:>6.1f},{lng:>7.1f} -> {code:<4} (expect {expect}) {flag}")
    return ok


def verify_published(out_dir: str, styles: dict) -> bool:
    """Probe the PUBLISHED lookup grid — the artefact the client reads.

    The in-memory probes above prove the source decodes correctly; this
    proves the file the browser actually fetches agrees with it. A stale
    grid.png left behind by an interrupted rebuild would fail here.
    """
    path = os.path.join(out_dir, "grid.png")
    if not os.path.exists(path):
        print(f"[koppen] FAIL  published grid.png missing: {path}")
        return False
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    rgb_to_code = {tuple(st["rgba"][:3]): st["code"] for st in styles.values()}
    ok = True
    for lat, lng, expect in PROBES:
        ix = min(w - 1, max(0, int((lng + 180.0) / 360.0 * w)))
        iy = min(h - 1, max(0, int((90.0 - lat) / 180.0 * h)))
        px = im.getpixel((ix, iy))[:3]
        code = rgb_to_code.get(px, "-" if px == (0, 0, 0) else "?")
        if code != expect:
            ok = False
        flag = "ok " if code == expect else "FAIL"
        print(f"[koppen]   published {lat:>6.1f},{lng:>7.1f} -> {code:<4} (expect {expect}) {flag}")
    return ok


def check_tiles(out_dir: str, max_zoom: int) -> bool:
    """Every level up to max_zoom exists and the deepest one is full."""
    ok = True
    expected = 0
    for z in range(max_zoom + 1):
        d = os.path.join(out_dir, "tiles", str(z))
        if not os.path.isdir(d):
            print(f"[koppen] FAIL  tiles/{z}/ missing")
            ok = False
            continue
        n = sum(len(files) for _r, _d, files in os.walk(d))
        expected += 4 ** z
        if n < 4 ** z:
            print(f"[koppen] FAIL  tiles/{z}/ has {n} of {4 ** z}")
            ok = False
    if ok:
        print(f"[koppen]   published pyramid z0-{max_zoom}: {expected} tiles, all present")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--beck",
                    default=os.path.join(CACHE_DIR, "Beck_KG_V1_present_0p0083.tif"),
                    help="Beck et al. 2018 1-km present-day GeoTIFF")
    ap.add_argument("--out", default=os.path.join(REPO, "public_html", "data", "koppen"))
    ap.add_argument("--max-zoom", type=int, default=7)
    ap.add_argument("--keep-intermediate", action="store_true")
    ap.add_argument("--verify-only", action="store_true",
                    help="re-run every probe against Beck and the published "
                         "artefacts without rebuilding")
    args = ap.parse_args()

    if args.verify_only:
        rw = int(360 / RASTER_DEG)
        rh = int(180 / RASTER_DEG)
        grid, styles = load_beck(args.beck, rw, rh)
        print(f"[koppen] verify-only: source {rw}x{rh}")
        src_ok = verify(grid, rw, rh, styles)
        del grid
        pub_ok = verify_published(args.out, styles)
        tiles_ok = check_tiles(args.out, args.max_zoom)
        ok = src_ok and pub_ok and tiles_ok
        print("[koppen] verification " + ("PASSED" if ok else "FAILED"))
        return 0 if ok else 2

    if not os.path.exists(args.beck):
        print(f"GeoTIFF not found: {args.beck}", file=sys.stderr)
        print("Download Beck et al. 2018 (CC BY 4.0) and place it there:", file=sys.stderr)
        print("  https://ndownloader.figshare.com/files/12407516  (71 MB zip)", file=sys.stderr)
        print("  unzip Beck_KG_V1_present_0p0083.tif -> " + args.beck, file=sys.stderr)
        return 1

    print(f"[koppen] reading {args.beck}")
    rw = int(360 / RASTER_DEG)
    rh = int(180 / RASTER_DEG)
    grid, styles = load_beck(args.beck, rw, rh)
    print(f"[koppen] {len(styles)} classes, {rw}x{rh} ({RASTER_DEG} deg)")

    # canonical class list (style id == Beck value, one per code)
    canon: dict[str, dict] = {}
    for sid, st in sorted(styles.items(), key=lambda kv: int(kv[0])):
        key = st["code"]
        if key not in canon:
            canon[key] = dict(st, styleIds=[int(sid)])
        else:
            canon[key]["styleIds"].append(int(sid))

    out = args.out
    os.makedirs(out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="koppen-")
    try:
        # ── 1. the display raster is already loaded (load_beck) ──────────
        # np.count_nonzero, not (grid != 0).sum(): the latter builds a
        # full-size bool array — 933 MB of extra RAM at source resolution.
        covered = int(np.count_nonzero(grid)) if hasattr(grid, "shape") else sum(1 for v in grid if v)
        print(f"[koppen] land coverage: {covered}/{rw*rh} cells ({covered*100/(rw*rh):.1f}%)")
        if not verify(grid, rw, rh, styles):
            print("[koppen] WARNING: probe mismatches — check orientation/class map", file=sys.stderr)

        # Free the plate-carrée array before the warp allocates the
        # Mercator one: 933 MB + 1.07 GB is fine on this box, but there
        # is no reason to hold both at once.
        del grid

        # ── 1b. warp the SOURCE FILE straight to Web Mercator ─────────
        # Not the intermediate GeoTIFF: warping Beck directly means the
        # source's 928 m cells survive into the master raster instead of
        # being upsampled from a 5.6 km grid. This is the whole reason
        # the resolution improved.
        print(f"[koppen] warping {os.path.basename(args.beck)} to Web Mercator "
              f"({MER_SIZE}x{MER_SIZE}) ...")
        merc = warp_to_mercator(args.beck, os.path.join(tmp, "merc.tif"))

        # ── 2. tile pyramid ─────────────────────────────────────────────
        # Palette for the RGBA conversion: index 0 = transparent (ocean),
        # then one entry per class id.
        palette_rgba = [(0, 0, 0, 0)]
        for sid in sorted(styles, key=lambda s: int(s)):
            palette_rgba.append(styles[sid]["rgba"])
        while len(palette_rgba) < 256:
            palette_rgba.append((0, 0, 0, 0))

        if not verify_mercator(merc, styles):
            print("[koppen] ERROR: Web Mercator warp is misaligned", file=sys.stderr)
            return 1

        tiles_dir = os.path.join(out, "tiles")
        if os.path.isdir(tiles_dir):
            shutil.rmtree(tiles_dir)
        os.makedirs(tiles_dir, exist_ok=True)
        print(f"[koppen] building tiles z0-{args.max_zoom} ...")
        ntiles = build_tiles(merc, tiles_dir, palette_rgba, args.max_zoom)
        print(f"[koppen] {ntiles} tiles written")
        del merc

        # ── 3. lookup grid (0.25 deg, paletted PNG) ────────────────────
        gw = int(360 / GRID_DEG)
        gh = int(180 / GRID_DEG)
        print(f"[koppen] building lookup grid {gw}x{gh} ({GRID_DEG} deg) ...")
        ggrid, _ = load_beck(args.beck, gw, gh)

        # palette: index 0 = nodata, then one entry per canonical class
        palette = [(0, 0, 0, 0)]
        code_to_index = {}
        for i, (code, st) in enumerate(sorted(canon.items(), key=lambda kv: kv[0]), start=1):
            r, g, b, a = st["rgba"]
            palette.append((r, g, b, a))
            code_to_index[code] = i
        style_to_index = {}
        for code, st in canon.items():
            for sid in st["styleIds"]:
                style_to_index[sid] = code_to_index[code]

        # remap the class-id grid into palette indexes. A numpy LUT
        # lookup, not a Python loop: this runs over 1M cells and the
        # generator version took longer than the warp.
        lut = np.zeros(256, dtype=np.uint8)
        for sid, idx in style_to_index.items():
            lut[int(sid)] = idx
        arr = lut[np.frombuffer(ggrid.tobytes(), dtype=np.uint8)].reshape(gh, gw)
        pal = np.array(palette, dtype=np.uint8).reshape(-1, 4)
        rgba = pal[arr]
        Image.fromarray(rgba, "RGBA").save(os.path.join(out, "grid.png"), optimize=True)

        # ── 4. metadata ─────────────────────────────────────────────────
        classes = []
        for code, st in sorted(canon.items(), key=lambda kv: kv[0]):
            classes.append(
                {
                    "code": code,
                    "group": group_of(code),
                    "description": st["description"],
                    "criteria": st["criteria"],
                    "color": st["color"],
                    "index": code_to_index[code],
                }
            )
        with open(os.path.join(out, "classes.json"), "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "grid": {"width": gw, "height": gh, "degrees": GRID_DEG,
                             "bbox": [-180, -90, 180, 90], "file": "grid.png"},
                    "classes": classes,
                    "source": "Beck, H.E., Zimmermann, N.E., McVicar, T.R., "
                              "Vergopolan, N., Berg, A., Wood, E.F. (2018), "
                              "Present and future Koppen-Geiger climate "
                              "classification maps at 1-km resolution, "
                              "Scientific Data 5, 180214",
                    "note": "Present-day classification (1980-2016), 1 km; "
                            "derived from Peel et al. (2007) by Beck et al.",
                    # CC BY 4.0: no NonCommercial clause, no ShareAlike.
                    # This replaces the Peel et al. 2007 source, which was
                    # CC BY-NC-SA 2.5. See docs/DATA_LICENSES.md §4.
                    "license": "CC BY 4.0",
                    "license_url": "https://doi.org/10.6084/m9.figshare.6396959",
                },
                fh,
                indent=1,
            )

        # ── 5. no source geojson: the Beck source is a RASTER, not ──────
        # polygons, so there is no geometry to export. The published
        # tiles and grid.png are the outputs; the source GeoTIFF is
        # cached at worker/data/koppen/ and is one fetch away.

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # ── report ─────────────────────────────────────────────────────────
    total = 0
    nfiles = 0
    for dirpath, _dirs, files in os.walk(os.path.join(out, "tiles")):
        for f in files:
            total += os.path.getsize(os.path.join(dirpath, f))
            nfiles += 1
    print(f"[koppen] {nfiles} tiles, {total/1024/1024:.2f} MB")
    for f in ("grid.png", "classes.json"):
        p = os.path.join(out, f)
        if os.path.exists(p):
            print(f"[koppen] {f}: {os.path.getsize(p)/1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
