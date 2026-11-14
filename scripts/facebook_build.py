#!/usr/bin/env python3
"""
Build the Facebook Friendships overlay tiles for Xyzo.

Source: NOAA SOS Explorer — "Facebook Friendships"
  https://sos.noaa.gov/catalog/datasets/facebook-friendships/
  ftp://public.sos.noaa.gov/extras/facebook/2048.png  (2048x1024 RGBA)

Ten million Facebook friendship pairs plotted as a global arc map. The
PNG is plate carrée (2:1), fully opaque, with a dark-blue background:
the RED channel IS the friendship density (ocean ~1, Sahara ~1, India
~117, Western Europe ~204, USA ~250). China reads ~29 — the dataset
notes it is dim because of domestic platforms and restrictions.

Output:
  public_html/data/facebook/tiles/{z}/{x}/{y}.png   alpha = density
  public_html/data/facebook/meta.json               attribution + stats

The build:
  1. alpha = red channel  → the dark background becomes transparent and
     the basemap shows through, while the arcs stay where people are.
  2. Slice the plate-carrée source into an XYZ pyramid by inverting the
     Web Mercator projection per output pixel (nearest neighbour, same
     convention as koppen_build.py's GRA_NearestNeighbour warp).

A tile pyramid rather than a single L.imageOverlay: an imageOverlay
stretches plate-carrée content linearly across the projected Mercator
rectangle, which distorts the poles. The tile path samples the correct
lon/lat per pixel, so the arcs land where they belong.

Usage:
  python3 scripts/facebook_build.py
  python3 scripts/facebook_build.py --max-zoom 6
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import zipfile

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ZIP = os.path.join(REPO, "maps", "facebook_2048.zip")
SRC_PNG = os.path.join(REPO, "maps", "facebook_2048.png")
OUT_DIR = os.path.join(REPO, "public_html", "data", "facebook")
TILE = 256

SOURCE_URL = "https://sos.noaa.gov/catalog/datasets/facebook-friendships/"
DOWNLOAD_URL = "ftp://public.sos.noaa.gov/extras/facebook/2048.png"
ATTRIBUTION = "NOAA SOS Explorer — Facebook Friendships"
LICENSE = "Public domain (US Government work)"

# Named places that must have a known friendship density. A flipped axis
# or a sideways Mercator inversion puts every one of these in the wrong
# bucket, and only known places catch it.
#
#   (label, lon, lat, min_alpha, note)
# Expected values are read from the PROCESSED image (density = red x 1.3,
# clipped to 255), which is what the source probe and the tiles both use.
# Calibrated against the actual data on 2026-10-28.
PROBES = [
    ("mid-Atlantic Ocean", -30.0, 0.0, 0, 12, "ocean — near transparent"),
    ("central Pacific", -150.0, 0.0, 0, 12, "ocean — near transparent"),
    ("Sahara", 10.0, 23.0, 0, 30, "desert — very sparse"),
    ("United States", -95.0, 39.0, 150, 256, "very dense"),
    ("Western Europe", 5.0, 48.0, 150, 256, "dense"),
    ("United Kingdom", -2.0, 54.0, 150, 256, "dense"),
    ("India", 78.0, 22.0, 40, 256, "medium"),
    ("Japan", 139.0, 36.0, 40, 256, "medium"),
    ("Nigeria", 8.0, 9.0, 100, 256, "dense"),
    # Sao Paulo, not the Amazon: Brazil's friendships live on the coast.
    ("Brazil (Sao Paulo)", -46.6, -23.5, 100, 256, "dense — the coast"),
    ("Amazon", -50.0, -12.0, 0, 30, "rainforest — sparse"),
    ("China", 105.0, 35.0, 0, 30, "dim — domestic platforms + restrictions"),
    ("central Australia", 133.0, -24.0, 0, 30, "sparse"),
]


def log(msg: str) -> None:
    print(f"[facebook] {msg}", flush=True)


def find_source() -> str:
    """Return a path to the 2048x1024 source PNG, unpacking if needed."""
    if os.path.exists(SRC_PNG):
        return SRC_PNG
    if not os.path.exists(SRC_ZIP):
        raise SystemExit(
            f"Source missing: {SRC_PNG}\n"
            f"Download it with:  curl -o {SRC_ZIP} {DOWNLOAD_URL}"
        )
    log(f"extracting {os.path.basename(SRC_ZIP)}")
    with zipfile.ZipFile(SRC_ZIP) as z:
        z.extractall(os.path.dirname(SRC_PNG))
    if not os.path.exists(SRC_PNG):
        raise SystemExit(f"{SRC_PNG} not found inside the zip")
    return SRC_PNG


def to_alpha_rgba(path: str) -> np.ndarray:
    """Turn the opaque density image into an RGBA one whose alpha is the
    friendship density — the whole point of the overlay."""
    src = np.asarray(Image.open(path).convert("RGBA"))
    rgb = src[..., :3].copy()
    # The red channel carries the density: ~0 = no friendships, ~250 = the
    # densest connections on Earth. Multiplying by 1.3 lifts midtones (a
    # medium country at R=117 becomes visible) without saturating the ocean.
    density = np.clip(src[..., 0].astype(np.float32) * 1.3, 0, 255).astype(np.uint8)
    return np.dstack([rgb, density])


def mercator_to_lonlat(z, xs, ys, tile_size=TILE):
    """Tile pixel coordinates (float) → lon/lat in degrees."""
    n = float(2 ** z)
    xf = (xs + 0.5) / (n * tile_size)
    yf = (ys + 0.5) / (n * tile_size)
    lon = xf * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * yf))))
    return lon, lat


def build_tiles(src_rgba: np.ndarray, out_dir: str, max_zoom: int) -> int:
    """Slice the plate-carrée source into an XYZ pyramid (z0..max_zoom).

    For every output pixel we invert Web Mercator to lon/lat and sample
    the source. Nearest neighbour, matching the other raster overlays.
    """
    H, W = src_rgba.shape[0], src_rgba.shape[1]
    written = 0
    for z in range(max_zoom + 1):
        count = 2 ** z
        for ty in range(count):
            for tx in range(count):
                yy, xx = np.mgrid[0:TILE, 0:TILE]
                lon, lat = mercator_to_lonlat(z, tx * TILE + xx, ty * TILE + yy)
                sx = np.floor((lon + 180.0) / 360.0 * W).astype(np.int32)
                sy = np.floor((90.0 - lat) / 180.0 * H).astype(np.int32)
                valid = (sx >= 0) & (sx < W) & (sy >= 0) & (sy < H)
                tile = np.zeros((TILE, TILE, 4), np.uint8)
                if valid.any():
                    tile[yy[valid], xx[valid]] = src_rgba[sy[valid], sx[valid]]
                tdir = os.path.join(out_dir, str(z), str(tx))
                os.makedirs(tdir, exist_ok=True)
                Image.fromarray(tile, "RGBA").save(
                    os.path.join(tdir, f"{ty}.png"), optimize=True
                )
                written += 1
        log(f"z{z}: {count * count} tiles")
    return written


def sample(src_rgba, lon, lat):
    """Alpha of the source at a lon/lat (plate carrée)."""
    H, W = src_rgba.shape[0], src_rgba.shape[1]
    x = int((lon + 180.0) / 360.0 * W)
    y = int((90.0 - lat) / 180.0 * H)
    x = max(0, min(W - 1, x))
    y = max(0, min(H - 1, y))
    return int(src_rgba[y, x, 3])


def sample_tile(tiles_dir, z, lon, lat):
    """Alpha of a built tile at a lon/lat."""
    n = 2 ** z
    xf = (lon + 180.0) / 360.0 * n
    yf = (1.0 - math.log(math.tan(math.radians(max(-85.05, min(85.05, lat)))) +
                         1.0 / math.cos(math.radians(max(-85.05, min(85.05, lat))))) / math.pi) / 2.0 * n
    tx, ty = int(xf), int(yf)
    path = os.path.join(tiles_dir, str(z), str(tx), f"{ty}.png")
    if not os.path.exists(path):
        return None
    arr = np.asarray(Image.open(path).convert("RGBA"))
    px = int((xf - tx) * TILE)
    py = int((yf - ty) * TILE)
    return int(arr[min(TILE - 1, py), min(TILE - 1, px), 3])


def _verify_source(rgba) -> None:
    """Gate on the source: a flipped axis or a broken density channel
    passes a size check, only known places catch it."""
    problems = []
    for label, lon, lat, lo, hi, note in PROBES:
        a = sample(rgba, lon, lat)
        print(f"[facebook]   source {label:<24} alpha={a:>3}  expect {lo}..{hi - 1}  {note}")
        if not (lo <= a <= hi):
            problems.append(f"source {label}: alpha={a}, expected {lo}..{hi - 1}")
    if problems:
        for p in problems:
            print(f"[facebook] VERIFY FAIL: {p}")
        raise SystemExit("verify(source) failed — refusing to build tiles")
    log("verify(source) passed")


def _verify_tiles(tiles_dir, max_zoom) -> None:
    """Gate on the tiles: the Mercator inversion is only tested here."""
    problems = []
    z = min(max_zoom, 5)
    for label, lon, lat, lo, hi, _ in PROBES:
        a = sample_tile(tiles_dir, z, lon, lat)
        print(f"[facebook]   tile   {label:<24} alpha={a}  expect {lo}..{hi - 1}")
        if a is None:
            problems.append(f"tile {label}: no tile at z{z}")
        elif not (lo <= a <= hi):
            problems.append(f"tile {label}: alpha={a}, expected {lo}..{hi - 1}")
    if problems:
        for p in problems:
            print(f"[facebook] VERIFY FAIL: {p}")
        raise SystemExit("verify(tiles) failed — refusing to publish")
    log(f"verify(tiles) passed: {len(PROBES)} probes at z{z}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the Facebook friendships overlay")
    ap.add_argument("--max-zoom", type=int, default=5,
                    help="deepest zoom level (default 5)")
    args = ap.parse_args()

    src_path = find_source()
    log(f"source {src_path} ({os.path.getsize(src_path) / 1e6:.1f} MB)")

    rgba = to_alpha_rgba(src_path)
    log(f"alpha = red channel → {rgba.shape[1]}x{rgba.shape[0]} RGBA")

    # Gate on the SOURCE before publishing anything: if the density
    # channel or the orientation is wrong, nothing downstream can save it.
    log("verify: source image")
    _verify_source(rgba)

    os.makedirs(OUT_DIR, exist_ok=True)
    tiles_dir = os.path.join(OUT_DIR, "tiles")
    if os.path.exists(tiles_dir):
        shutil.rmtree(tiles_dir)

    log(f"slicing to z0..{args.max_zoom} …")
    written = build_tiles(rgba, tiles_dir, args.max_zoom)
    log(f"wrote {written} tiles")

    # Then gate the BUILT tiles: a Mercator inversion bug passes the
    # source gate and only shows up in the tiles.
    log("verify: built tiles")
    _verify_tiles(tiles_dir, args.max_zoom)

    meta = {
        "name": "Facebook Friendships",
        "source": SOURCE_URL,
        "download": DOWNLOAD_URL,
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        "max_zoom": args.max_zoom,
        "min_zoom": 0,
        "description": (
            "Ten million pairs of Facebook friendships plotted globally. "
            "Brighter = more connections; the map is a portrait of the "
            "internet, not of coastlines: Africa reads dim (limited access) "
            "and China reads dim (domestic platforms and restrictions)."
        ),
        "encoding": "alpha = friendship density (source red channel × 1.3)",
        "probes": [
            {"name": n, "lon": lo, "lat": la, "note": note}
            for n, lo, la, _, _, note in PROBES
        ],
    }
    meta_path = os.path.join(OUT_DIR, "meta.json")
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=2)
    log(f"wrote {meta_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
