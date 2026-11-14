#!/usr/bin/env python3
"""
Build a static PNG tile pyramid for the 2026 FAO river network, from our
own copy of the data.

WHY
---
The publisher's WMS renders this network in ~2 s a tile, and 25-48 s for a
whole-world tile. We now serve the tiles through our own caching proxy
(`api/src/routes/faoRiversProxy.ts`), so the publisher is asked once per
tile — but the FIRST reader of the world view still waits a minute, and
the layer depends on somebody else's server being up.

So we render the tiles OURSELVES, once, and serve them as static files.
After this build the publisher is out of the runtime path for these
zooms: our server reads a PNG off the disk and the browser composites it.

THE GEOMETRY, AND THE TRAP IN IT
--------------------------------
The slippy tile grid is a **WEB MERCATOR** grid. A tile is the Mercator
square between two latitudes, and the pixel rows are NOT linear in
latitude. So:

    px = (mx(lon) - x0) / (x1 - x0) * W
    py = (y0 - my(lat)) / (y0 - y1) * H

Rendering the tile in **plate carrée** (a latitude-linear axis) instead
puts every line in the wrong place — and at z4 over the equator the
error is under a percent, so it LOOKS fine until you go to z2 or to a
high latitude. (The proxy had exactly this bug on 2026-11-06; see
AGENTS.md.)

THE CARTOGRAPHY
----------------
The SAME classes the published SLD draws, from the SAME two attributes
(`ord_flow` and `smooth_200`):

    smooth_200 = 'I'            → intermittent  (amber, dashed)
    smooth_200 = 'P', order 1-2 → great rivers  (white)
                     order 3-4 → large rivers  (cyan)
                     order 5-6 → streams      (blue)
                     order 7+ → fine detail  (pale blue)

The table lives in `scripts/river_network_build.py` — ONE source of
truth, so the legend on the map and the pixels on the disk cannot
disagree.

Usage:
  python3 scripts/river_tiles_build.py                    # z0-z5, all levels
  python3 scripts/river_tiles_build.py --zoom-max 6
  python3 scripts/river_tiles_build.py --level medium
  python3 scripts/river_tiles_build.py --verify-only
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO, "data", "rivers_fao_2026")
OUT_DIR = os.path.join(REPO, "public_html", "data", "rivers", "fao", "tiles")
META_PATH = os.path.join(REPO, "public_html", "data", "rivers", "fao", "meta.json")

TILE_PX = 512
R = 20037508.34          # the Web Mercator half-circumference
SUPERSAMPLE = 2          # render big, downsample: thin lines need the bits

# The class table — the SAME rows the builder publishes in meta.json, so
# the legend and the pixels are one thing.
CLASSES = [
    # id,        title,                 min_ord, max_ord, colour,      width, dashed
    ("great",    "Great rivers",        1, 2, "#ffffff", 1.25, False),
    ("large",    "Large rivers",        3, 4, "#67e8f9", 0.85, False),
    ("medium",   "Streams",             5, 6, "#38bdf8", 0.60, False),
    ("fine",     "Fine detail (order 7+)", 7, None, "#93c5fd", 0.35, False),
    ("intermittent", "Intermittent",   None, None, "#fbbf24", 0.45, True),
]

# The level filters — the SAME ones the publisher is asked for.
LEVEL_FILTER = {
    "major": "dis_av_cms>=100",
    "medium": "dis_av_cms>=10",
    "fine": "dis_av_cms>=1",
    "full": None,
}

# How big a reach is allowed to be and still be in the picture, in m³/s.
LEVEL_MIN_CMS = {"major": 100.0, "medium": 10.0, "fine": 1.0, "full": 0.0}


def log(msg: str) -> None:
    print(f"[river-tiles] {msg}", flush=True)


def class_of(ord_flow: int, smooth_200: str) -> int:
    """The class index, or -1 for a reach no rule draws."""
    if smooth_200 == "I":
        return 4                                    # intermittent
    if smooth_200 != "P":
        return -1                                   # no rule matches it
    for i, (cid, _t, lo, hi, _c, _w, _d) in enumerate(CLASSES):
        if lo is None:
            continue
        if lo <= ord_flow and (hi is None or ord_flow <= hi):
            return i
    return -1


# ── loading the copy ───────────────────────────────────────────────────
class Network:
    """The fetched reaches, in flat arrays, with a coarse spatial index."""

    def __init__(self):
        self.coords = np.zeros((0, 2), dtype=np.float64)
        self.starts = np.zeros(0, dtype=np.int64)   # index into coords
        self.counts = np.zeros(0, dtype=np.int32)    # points per reach
        self.ord_flow = np.zeros(0, dtype=np.int16)
        self.smooth = np.zeros(0, dtype=np.int8)     # 0=P, 1=I
        self.dis = np.zeros(0, dtype=np.float32)
        self.cls = np.zeros(0, dtype=np.int8)
        self.cell = 5.0                              # the index cell, degrees
        self.cells = {}

    def load(self, src_dir: str) -> None:
        """Read the copy into flat numpy arrays.

        **IT IS BUILT AS ARRAYS, NOT AS PYTHON LISTS.** The network is
        8.5 million reaches and ~30 million points; a list of tuples
        costs ~130 bytes a point, so the lists would be **~4 GB** and
        the build would spend its life in the garbage collector. Each
        page is parsed into a small array and the pages are concatenated.
        """
        coord_parts: list = []
        start_parts: list = []
        count_parts: list = []
        flow_parts: list = []
        smooth_parts: list = []
        dis_parts: list = []
        offset = 0
        t0 = time.time()
        pages = sorted(f for f in os.listdir(src_dir) if f.startswith("page-"))
        if not pages:
            raise SystemExit(f"no pages in {src_dir} — run river_network_fetch.py")
        for i, name in enumerate(pages):
            with gzip.open(os.path.join(src_dir, name), "rt") as fh:
                feats = json.load(fh)["features"]
            pts: list = []
            starts: list = []
            counts: list = []
            flows: list = []
            smooth: list = []
            dis: list = []
            for f in feats:
                p = f["properties"]
                geom = f["geometry"]
                # A reach is a LineString or a MultiLineString; the parts
                # are flattened into one polyline (a sub-pixel join at
                # these scales).
                lines = geom["coordinates"]
                seg: list = []
                for line in lines:
                    seg.extend(line)
                if len(seg) < 2:
                    continue
                starts.append(offset + len(pts))
                counts.append(len(seg))
                pts.extend(seg)
                flows.append(int(p.get("ord_flow") or 9))
                smooth.append(1 if (p.get("smooth_200") or "P") == "I" else 0)
                dis.append(float(p.get("dis_av_cms") or 0.0))
            if pts:
                coord_parts.append(np.asarray(pts, dtype=np.float64).reshape(-1, 2))
            start_parts.append(np.asarray(starts, dtype=np.int64))
            count_parts.append(np.asarray(counts, dtype=np.int32))
            flow_parts.append(np.asarray(flows, dtype=np.int16))
            smooth_parts.append(np.asarray(smooth, dtype=np.int8))
            dis_parts.append(np.asarray(dis, dtype=np.float32))
            offset += len(pts)
            if (i + 1) % 10 == 0 or i == len(pages) - 1:
                log(f"  loaded {i + 1}/{len(pages)} pages "
                    f"({offset} points, {time.time() - t0:.0f}s)")
        self.coords = np.concatenate(coord_parts) if coord_parts else np.zeros((0, 2))
        self.starts = np.concatenate(start_parts) if start_parts else np.zeros(0, np.int64)
        self.counts = np.concatenate(count_parts) if count_parts else np.zeros(0, np.int32)
        self.ord_flow = np.concatenate(flow_parts) if flow_parts else np.zeros(0, np.int16)
        self.smooth = np.concatenate(smooth_parts) if smooth_parts else np.zeros(0, np.int8)
        self.dis = np.concatenate(dis_parts) if dis_parts else np.zeros(0, np.float32)
        # The class, per reach — the SLD's own rules.
        self.cls = np.asarray([class_of(int(o), "I" if s else "P")
                                for o, s in zip(self.ord_flow, self.smooth)],
                               dtype=np.int8)
        self._index()

    def _index(self) -> None:
        """Bucket the reaches by their bounding box, so a tile only looks
        at the reaches that can touch it.

        **THE COMMON CASE IS VECTORISED.** A reach is a few kilometres
        long, so it nearly always falls inside ONE 5° cell — and with
        8.5 million reaches, a Python loop over all of them is minutes
        of nothing. The reaches that straddle a cell boundary (the
        minority) are looped.
        """
        t0 = time.time()
        n = len(self.starts)
        ends = self.starts + self.counts
        mins = np.empty((n, 2))
        maxs = np.empty((n, 2))
        for i in range(n):
            seg = self.coords[self.starts[i]:ends[i]]
            mins[i] = seg.min(axis=0)
            maxs[i] = seg.max(axis=0)
        self.reach_min = mins
        self.reach_max = maxs
        c = self.cell
        gx0 = np.floor(mins[:, 0] / c).astype(np.int64)
        gx1 = np.floor(maxs[:, 0] / c).astype(np.int64)
        gy0 = np.floor(mins[:, 1] / c).astype(np.int64)
        gy1 = np.floor(maxs[:, 1] / c).astype(np.int64)
        cells: dict = {}
        one = (gx0 == gx1) & (gy0 == gy1)
        keys = (gx0[one] + 64) * 128 + (gy0[one] + 32)
        uniq, inv = np.unique(keys, return_inverse=True)
        order = np.argsort(inv, kind="stable")
        counts = np.bincount(inv)
        starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
        idx = np.nonzero(one)[0][order]
        for k, u in enumerate(uniq):
            cells[(int((u - (u % 128)) // 128) - 64, int(u % 128) - 32)] = \
                idx[starts[k]:starts[k] + counts[k]]
        # The reaches that straddle a boundary. They go into a separate
        # dict first: the vectorised pass above left numpy arrays in
        # `cells`, and a list has no .append.
        multi = np.nonzero(~one)[0]
        extra: dict = {}
        for i in multi:
            for gx in range(int(gx0[i]), int(gx1[i]) + 1):
                for gy in range(int(gy0[i]), int(gy1[i]) + 1):
                    extra.setdefault((gx, gy), []).append(int(i))
        self.cells = {k: (v if isinstance(v, np.ndarray)
                           else np.asarray(v, dtype=np.int64))
                      for k, v in cells.items()}
        for k, v in extra.items():
            have = self.cells.get(k)
            add = np.asarray(v, dtype=np.int64)
            self.cells[k] = add if have is None else np.concatenate([have, add])
        log(f"  indexed {n} reaches into {len(self.cells)} cells "
            f"({time.time() - t0:.0f}s)")

    def in_box(self, minx: float, miny: float, maxx: float, maxy: float):
        """The reaches whose bbox meets the box."""
        c = self.cell
        gx0 = int(math.floor(minx / c)); gx1 = int(math.floor(maxx / c))
        gy0 = int(math.floor(miny / c)); gy1 = int(math.floor(maxy / c))
        found: list = []
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                idx = self.cells.get((gx, gy))
                if idx is None:
                    continue
                hit = idx[(self.reach_min[idx, 0] <= maxx) &
                           (self.reach_max[idx, 0] >= minx) &
                           (self.reach_min[idx, 1] <= maxy) &
                           (self.reach_max[idx, 1] >= miny)]
                if len(hit):
                    found.append(hit)
        if not found:
            return np.zeros(0, dtype=np.int64)
        return np.unique(np.concatenate(found))


# ── the projection ─────────────────────────────────────────────────────
def mx(lon: float) -> float:
    return lon / 180.0 * R


def my(lat: float) -> float:
    lat = max(-85.051129, min(85.051129, lat))
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi * R


def tile_square(z: int, x: int, y: int):
    """The tile's Mercator square (x0, y0, x1, y1) in EPSG:3857.

    **THE NORTH EDGE IS THE LARGER NORTHING.** In EPSG:3857 y grows
    NORTHWARD, but the slippy ROW index grows SOUTHWARD — so row 0 is the
    top of the world and its northing is the largest. Getting the two
    the wrong way round **flips the tile vertically**, and a flipped tile
    is not a subtle error: measured against the publisher's own rendering
    of the same ground, the overlap collapsed from 100 % to 6 %.
    """
    n = 2 ** z
    x0 = (x / n) * 2 * R - R
    x1 = ((x + 1) / n) * 2 * R - R
    y0 = R - (y / n) * 2 * R            # NORTH edge (the larger northing)
    y1 = R - ((y + 1) / n) * 2 * R        # south edge
    return x0, y0, x1, y1


def square_to_lonlat(x0, y0, x1, y1):
    """The square's geographic bounds, for the spatial index."""
    def inv_my(y):
        return math.degrees(2 * math.atan(math.exp(y / R * math.pi)) - math.pi / 2)
    lon0 = x0 / R * 180.0
    lon1 = x1 / R * 180.0
    # y0 is the north edge, so its latitude is the larger one.
    lat0 = inv_my(y0)
    lat1 = inv_my(y1)
    return lon0, min(lat0, lat1), lon1, max(lat0, lat1)


# ── drawing ────────────────────────────────────────────────────────────
def draw_tile(net: Network, z: int, x: int, y: int, level: str) -> bytes:
    x0, y0, x1, y1 = tile_square(z, x, y)
    lon0, lat0, lon1, lat1 = square_to_lonlat(x0, y0, x1, y1)
    idx = net.in_box(lon0, lat0, lon1, lat1)
    min_cms = LEVEL_MIN_CMS[level]
    if len(idx):
        idx = idx[net.dis[idx] >= min_cms]
    W = TILE_PX * SUPERSAMPLE
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if len(idx):
        sx = (W / (x1 - x0))
        sy = (W / (y0 - y1))
        for i in idx:
            cls = int(net.cls[i])
            if cls < 0:
                continue
            cid, _title, _lo, _hi, colour, width, dashed = CLASSES[cls]
            seg = net.coords[net.starts[i]:net.starts[i] + net.counts[i]]
            px = (sx * (seg[:, 0] * R / 180.0 - x0)).astype(np.float64)
            py = (sy * (y0 - my_arr(seg[:, 1]))).astype(np.float64)
            w = max(1, int(round(width * SUPERSAMPLE)))
            col = colour
            if dashed:
                _draw_dashed(draw, px, py, w, col)
            else:
                draw.line(list(zip(px.tolist(), py.tolist())), fill=col, width=w)
    if SUPERSAMPLE > 1:
        img = img.resize((TILE_PX, TILE_PX), Image.LANCZOS)
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# my() for an array of latitudes.
_MY_CACHE: dict = {}


def my_arr(lat: np.ndarray) -> np.ndarray:
    lat = np.clip(lat, -85.051129, 85.051129)
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) / np.pi * R


def _draw_dashed(draw, px, py, w, col) -> None:
    """A dashed line: 4 px on, 4 px off, in tile pixels."""
    on = 4 * SUPERSAMPLE
    off = 4 * SUPERSAMPLE
    period = on + off
    for (x0, y0), (x1, y1) in zip(zip(px[:-1], py[:-1]), zip(px[1:], py[1:])):
        dx = x1 - x0
        dy = y1 - y0
        length = math.hypot(dx, dy)
        if length < 0.01:
            continue
        steps = max(2, int(length / (period / 2)) + 1)
        for k in range(steps):
            ta = k / steps
            tb = (k + 1) / steps
            mid = ((ta + tb) / 2) * length
            if (mid % period) < on:
                draw.line([(x0 + dx * ta, y0 + dy * ta),
                           (x0 + dx * tb, y0 + dy * tb)], fill=col, width=w)


# ── the build ──────────────────────────────────────────────────────────
def build(net: Network, zoom_max: int, levels, out_dir: str) -> int:
    made = 0
    for level in levels:
        for z in range(0, zoom_max + 1):
            n = 2 ** z
            t0 = time.time()
            for x in range(n):
                for y in range(n):
                    path = os.path.join(out_dir, level, str(z), str(x), f"{y}.png")
                    if os.path.exists(path):
                        continue
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    png = draw_tile(net, z, x, y, level)
                    with open(path, "wb") as fh:
                        fh.write(png)
                    made += 1
            log(f"  {level} z{z}: {n * n} tiles "
                f"({time.time() - t0:.0f}s)")
    return made


def verify(out_dir: str, zoom_max: int, levels) -> bool:
    ok = True
    for level in levels:
        for z in range(0, zoom_max + 1):
            n = 2 ** z
            for x in range(n):
                for y in range(n):
                    path = os.path.join(out_dir, level, str(z), str(x), f"{y}.png")
                    if not os.path.exists(path):
                        print(f"[river-tiles] MISSING {level} z{z} {x}/{y}",
                              file=sys.stderr)
                        ok = False
                        break
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC_DIR)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--zoom-max", type=int, default=5)
    ap.add_argument("--level", default="",
                    help="build only this level (default: all four)")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    levels = [args.level] if args.level else list(LEVEL_FILTER.keys())

    if args.verify_only:
        return 0 if verify(args.out, args.zoom_max, levels) else 2

    log("loading the local copy")
    net = Network()
    net.load(args.src)
    log(f"{len(net.starts)} reaches, "
        f"{len(net.coords)} points")

    t0 = time.time()
    made = build(net, args.zoom_max, levels, args.out)
    log(f"built {made} tiles in {time.time() - t0:.0f}s")

    if not verify(args.out, args.zoom_max, levels):
        print("[river-tiles] the pyramid is INCOMPLETE", file=sys.stderr)
        return 2
    log("the pyramid is complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
