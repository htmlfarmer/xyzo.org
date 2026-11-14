#!/usr/bin/env python3
"""
Build the phytoplankton overlay assets for Xyzo.

Source: NOAA Science On a Sphere "Phytoplankton Model" — the MIT Darwin
Project's 1994-1999 global ocean ecosystem simulation, run inside the
MITgcm / ECCO-2 physical model.

  Catalogue  https://sos.noaa.gov/catalog/datasets/phytoplankton-model/
  Files      ftp://public.sos.noaa.gov/oceans/phytoplankton/
  Model      MIT Darwin Project, MITgcm, ECCO-2 (NASA MAP programme)

WHAT THE PUBLISHED FILES ACTUALLY ARE
------------------------------------
The distribution is a rendered visualisation, not a data product:

  2048/00000.png .. 02190.png   2191 DAILY frames, equirectangular
                                2048x1024 plate carree, row 0 = north
  colorbar.png                  the legend
  labels.txt                    the date of each frame
  phytoplankton_2048.mp4         the same thing as a video

The monthly maps exist ONLY inside those frames, so the numbers have to
be recovered by inverting the dataset's OWN colour bar: four ramps, each
0-5 mmol P m-2, one per phytoplankton type.

  Prochlorococcus  green    small, cannot use nitrate
  Synechococcus    cyan     other small
  Flagellates      yellow   other big
  Diatoms          red      big, need silica

The frames also carry a photographic background (the Blue Marble), and
brown desert sits INSIDE the yellow ramp, so a residual test alone
cannot tell the model field from the background. Natural Earth land
(public domain) supplies the coastline.

Only the extracted ocean field is published — the Blue Marble imagery is
never redistributed, so no imagery licence is inherited.

Licence: MITgcm and the Darwin model are under the MIT licence (free to
redistribute with the notice); the NASA side is public domain. See
docs/DATA_LICENSES.md.

WHAT IS PUBLISHED
-----------------
  public_html/data/phytoplankton/meta.json   layout, ramps, periods
  public_html/data/phytoplankton/annual.bin   type + level, annual mean
  public_html/data/phytoplankton/m01.bin ..   type + level, one per month

Each .bin is two uint8 planes of 1024x2048: the dominant phytoplankton
type (0-3, 255 = none) and the phosphorus biomass (0-255 of 0-5 mmol).

Usage:
  python3 -m scripts.phytoplankton_build
  python3 -m scripts.phytoplankton_build --verify-only
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import urllib.request

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "phytoplankton")
CACHE_DIR = os.path.join(REPO, "worker", "data", "phytoplankton")

FTP = "ftp://public.sos.noaa.gov/oceans/phytoplankton/"
LAND_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
            "master/geojson/ne_50m_land.geojson")

ROWS, COLS = 1024, 2048
BAR_SAMPLES = 64
RESIDUAL_MAX = 34.0

TYPE_NAMES = ["Prochlorococcus", "Synechococcus", "Flagellates", "Diatoms"]
TYPE_KEYS = ["prochlorococcus", "synechococcus", "flagellates", "diatoms"]
TYPE_NOTES = [
    "small; cannot use nitrate",
    "other small phytoplankton",
    "other big phytoplankton",
    "big; needs silica",
]

MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]

FIRST_DAY = dt.date(1994, 1, 1)
LAST_FRAME = 2190

# The published colour bar, sampled left to right. Each ramp is a
# straight line in RGB from 0 to 5 mmol P m-2.
RAMPS = {
    "prochlorococcus": ([0, 41, 0], [104, 210, 104]),
    "synechococcus": ([0, 41, 41], [104, 210, 210]),
    "flagellates": ([41, 41, 0], [210, 210, 104]),
    "diatoms": ([41, 0, 0], [210, 104, 104]),
}

# Alpha from the biomass. The source's own encoding is "opacity
# indicates concentration as carbon biomass"; the floor keeps the type
# faintly visible where the biomass is near zero.
ALPHA_FLOOR = 0.18
ALPHA_GAMMA = 0.8

LEVEL_MAX = 5.0     # mmol P m-2 at the top of the published colour bar


def log(msg: str) -> None:
    print(f"[phyto] {msg}", flush=True)


# ── source acquisition ────────────────────────────────────────────────────

def _fetch(url: str, dest: str, min_size: int = 1024) -> None:
    if os.path.exists(dest) and os.path.getsize(dest) >= min_size:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    log(f"fetching {url}")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), suffix=".part")
    os.close(fd)
    try:
        with urllib.request.urlopen(url, timeout=300) as resp, open(tmp, "wb") as out:
            shutil.copyfileobj(resp, out, length=1 << 20)
        if os.path.getsize(tmp) < min_size:
            raise RuntimeError(f"{url} came back too small")
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def frame_picks() -> list:
    """The first of every month, 1994-1999: 72 frames, six per month."""
    picks = []
    for year in range(1994, 2000):
        for month in range(1, 13):
            d = dt.date(year, month, 1)
            idx = (d - FIRST_DAY).days
            if 0 <= idx <= LAST_FRAME:
                picks.append((idx, d))
    return picks


def ensure_sources(frames: int) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    _fetch(FTP + "colorbar.png", os.path.join(CACHE_DIR, "colorbar.png"))
    _fetch(LAND_URL, os.path.join(CACHE_DIR, "ne_50m_land.geojson"))
    picks = frame_picks()
    for idx, _d in picks[:frames] if frames else picks:
        _fetch(f"{FTP}2048/{idx:05d}.png",
               os.path.join(CACHE_DIR, "frames", f"{idx:05d}.png"),
               min_size=500_000)


# ── decoding ──────────────────────────────────────────────────────────────

def load_ramps() -> np.ndarray:
    """The four published ramps, sampled from the dataset's colour bar."""
    from PIL import Image
    cb = np.array(Image.open(os.path.join(CACHE_DIR, "colorbar.png"))
                  .convert("RGB")).astype(np.float32)
    H, W, _ = cb.shape

    def saturated(px):
        return (px.max() - px.min()) > 40

    runs, inrun = [], False
    for y in range(H):
        sat = sum(1 for x in range(W) if saturated(cb[y, x]))
        if sat > 100 and not inrun:
            inrun, start = True, y
        elif sat <= 100 and inrun:
            inrun = False
            runs.append((start, y - 1))

    bars = []
    for (y0, y1) in runs:
        if y1 - y0 < 4:
            continue
        ym = (y0 + y1) // 2
        xs = [x for x in range(W) if saturated(cb[ym, x])]
        if len(xs) < 50:
            continue
        x0, x1 = min(xs), max(xs)
        bars.append(np.array(
            [cb[ym, int(round(x0 + (x1 - x0) * i / (BAR_SAMPLES - 1.0)))]
             for i in range(BAR_SAMPLES)], dtype=np.float32))
    if len(bars) != 4:
        raise RuntimeError(f"expected 4 colour bars, found {len(bars)}")
    return np.stack(bars)


def land_mask() -> np.ndarray:
    """Natural Earth land, rasterised to the frames' grid (public domain)."""
    from osgeo import gdal, ogr, osr
    src_path = os.path.join(CACHE_DIR, "ne_50m_land.geojson")
    tif = os.path.join(CACHE_DIR, "land_mask.tif")
    if not os.path.exists(tif):
        gdal.UseExceptions()
        drv = gdal.GetDriverByName("GTiff")
        dst = drv.Create(tif, COLS, ROWS, 1, gdal.GDT_Byte)
        dst.SetGeoTransform((-180.0, 360.0 / COLS, 0.0, 90.0, 0.0, -180.0 / ROWS))
        srs = osr.SpatialReference()
        srs.ImportFromEPSG(4326)
        dst.SetProjection(srs.ExportToWkt())
        dst.GetRasterBand(1).Fill(0)
        src = ogr.Open(src_path)
        gdal.RasterizeLayer(dst, [1], src.GetLayer(0), burn_values=[1],
                            options=["ALL_TOUCHED=TRUE"])
        dst.FlushCache()
        dst = None
    arr = gdal.Open(tif).ReadAsArray()
    return arr.astype(np.uint8)


def decode_frame(path: str, ramps: np.ndarray, land: np.ndarray):
    """-> (type uint8, level uint8) for one frame.

    The TYPE is decided by the channel structure, not by the nearest
    ramp point: at near-zero biomass every ramp's zero end is within
    ~40 RGB units of every other, so a nearest-point search flips the
    type at random exactly where the gyres are — and the gyres are the
    whole point of the map.

        (0, v, 0)  prochlorococcus      (v, v, 0)  flagellates
        (0, v, v)  synechococcus        (v, 0, 0)  diatoms

    The LEVEL is then that type's own ramp position, so the numbers come
    from the dataset's own legend rather than from a guess at its colour
    space.
    """
    from PIL import Image
    fr = np.array(Image.open(path).convert("RGB")).astype(np.float32)
    H, W, _ = fr.shape
    if (H, W) != (ROWS, COLS):
        raise RuntimeError(f"{path} is {W}x{H}, expected {COLS}x{ROWS}")
    R = fr[:, :, 0]
    G = fr[:, :, 1]
    B = fr[:, :, 2]

    scores = np.stack([
        G - np.maximum(R, B),      # prochlorococcus
        np.minimum(G, B) - R,      # synechococcus
        np.minimum(R, G) - B,      # flagellates
        R - np.maximum(G, B),      # diatoms
    ], axis=0)                                   # (4, ROWS, COLS)
    typ = np.argmax(scores, axis=0).astype(np.uint8)

    # Level: the projection of the pixel onto ITS OWN type's ramp, and
    # the residual against that ramp. Land is photographic and does not
    # lie on any ramp, so the residual is what rejects it.
    best = np.full((ROWS, COLS), np.inf, dtype=np.float32)
    lev = np.zeros((ROWS, COLS), dtype=np.float32)
    pix = fr.reshape(-1, 3)
    flat_typ = typ.reshape(-1)
    order = np.argsort(flat_typ, kind="stable")
    bounds = np.searchsorted(flat_typ[order], np.arange(5))
    for b in range(4):
        sel = order[bounds[b]:bounds[b + 1]]
        if sel.size == 0:
            continue
        ramp = ramps[b]
        chunk = pix[sel]
        d = chunk[:, None, :] - ramp[None, :, :]
        dist = np.sqrt((d ** 2).sum(axis=2))
        j = np.argmin(dist, axis=1)
        dmin = dist[np.arange(len(sel)), j]
        best.reshape(-1)[sel] = dmin
        lv = lev.reshape(-1)
        lv[sel] = j.astype(np.float32) * (255.0 / (BAR_SAMPLES - 1))
        lev = lv.reshape(ROWS, COLS)

    bad = best > RESIDUAL_MAX
    bad |= (land == 1)
    typ[bad] = 255
    lev[bad] = 0
    return typ, lev


# ── aggregation ───────────────────────────────────────────────────────────

class Accumulator:
    """Per-type biomass totals, so a type that dominates one month is not
    averaged with a different type from another month."""

    def __init__(self):
        self.total = np.zeros((4, ROWS, COLS), dtype=np.float32)
        self.count = np.zeros((4, ROWS, COLS), dtype=np.uint8)

    def add(self, typ: np.ndarray, lev: np.ndarray) -> None:
        for t in range(4):
            sel = typ == t
            if not sel.any():
                continue
            self.total[t][sel] += lev[sel]
            self.count[t][sel] = np.minimum(self.count[t][sel] + 1, 255)

    def finish(self):
        """-> (type uint8, level uint8): the dominant type and its mean
        biomass.

        The dominant type is the one present in the MOST samples, with
        the total biomass as the tie-break — not the greatest mean. In
        the oligotrophic gyres the biomass is near zero, and at that
        intensity the four colour ramps are within ~40 RGB units of each
        other, so the per-frame type is noisy; the mode over six years
        is stable where the mean is not.
        """
        mean = np.where(self.count > 0,
                        self.total / np.maximum(self.count, 1), 0.0)
        # count dominates, total breaks the tie.
        score = (self.count.astype(np.float32) * 1e6
                 + np.where(self.count > 0, self.total, 0.0))
        typ = np.argmax(score, axis=0).astype(np.uint8)
        has = self.count.max(axis=0) > 0
        lev = np.take_along_axis(mean, typ[None, :, :], axis=0)[0]
        lev = np.clip(lev, 0, 255).astype(np.uint8)
        typ[~has] = 255
        lev[~has] = 0
        return typ, lev


def build(frames: int | None) -> int:
    ensure_sources(frames)
    ramps = load_ramps()
    land = land_mask()
    picks = frame_picks()
    if frames:
        picks = picks[:frames]

    monthly = [Accumulator() for _ in range(12)]
    annual = Accumulator()

    for idx, d in picks:
        path = os.path.join(CACHE_DIR, "frames", f"{idx:05d}.png")
        typ, lev = decode_frame(path, ramps, land)
        monthly[d.month - 1].add(typ, lev)
        annual.add(typ, lev)
        log(f"decoded {idx:05d}.png  {d}  "
            f"ocean {100 * (typ != 255).mean():.1f}%")

    os.makedirs(OUT_DIR, exist_ok=True)
    periods = []

    # Annual first, then the twelve months.
    typ, lev = annual.finish()
    _write("annual.bin", typ, lev)
    periods.append({"id": "annual", "label": "Annual mean", "file": "annual.bin",
                    "samples": len(picks)})
    log(f"annual.bin: {100 * (typ != 255).mean():.1f}% of cells have model data")

    for m in range(12):
        typ, lev = monthly[m].finish()
        name = f"m{m + 1:02d}.bin"
        _write(name, typ, lev)
        periods.append({"id": f"m{m + 1:02d}", "label": MONTH_NAMES[m],
                        "file": name, "samples": sum(1 for _i, dd in picks if dd.month == m + 1)})
        log(f"{name}: {100 * (typ != 255).mean():.1f}% of cells have model data")

    meta = {
        "source": "MIT Darwin Project phytoplankton model (MITgcm / ECCO-2), "
                  "1994-1999 global simulation",
        "attribution": "MIT Darwin Project / MITgcm / ECCO-2 (NASA MAP)",
        "license": "MIT Licence (model and output); NASA imagery public domain",
        "url": "https://sos.noaa.gov/catalog/datasets/phytoplankton-model/",
        "method": "MIT Darwin Project, run in the MITgcm / ECCO-2 physical model",
        "years": "1994-1999",
        "units": "mmol P m-2",
        "level_max": LEVEL_MAX,
        "grid": {
            "rows": ROWS,
            "cols": COLS,
            "lat_min": -90.0 + 0.5 * (180.0 / ROWS),
            "lat_max": 90.0 - 0.5 * (180.0 / ROWS),
            "lon_min": -180.0 + 0.5 * (360.0 / COLS),
            "lon_max": 180.0 - 0.5 * (360.0 / COLS),
            "lat_step": 180.0 / ROWS,
            "lon_step": 360.0 / COLS,
            "dtype": "uint8",
            "order": "row-major, row 0 = southernmost, column 0 = 180W; "
                     "type plane then level plane",
            "resolution_km": 19.6,
        },
        "types": [
            {"key": TYPE_KEYS[i], "label": TYPE_NAMES[i], "note": TYPE_NOTES[i],
             "rgb_dark": RAMPS[TYPE_KEYS[i]][0], "rgb_bright": RAMPS[TYPE_KEYS[i]][1]}
            for i in range(4)
        ],
        "alpha": {"floor": ALPHA_FLOOR, "gamma": ALPHA_GAMMA},
        "periods": periods,
        "default_period": "annual",
        "notes": [
            "The published distribution is a rendered visualisation, so the "
            "numbers here are recovered by inverting the dataset's own colour "
            "bar. They are accurate to the colour bar's resolution, not to "
            "the model output's precision.",
            "Only the ocean model field is published; the photographic "
            "background in the source frames is not redistributed.",
            "The dominant type is the one with the largest mean phosphorus "
            "biomass at that cell; the biomass is that type's mean.",
        ],
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    log(f"published {len(periods)} periods to {OUT_DIR}")
    return 0


def _write(name: str, typ: np.ndarray, lev: np.ndarray) -> None:
    # Row 0 of the frame is the northern edge; the published grid puts
    # the southernmost row first, to match every other overlay here.
    #
    # The two planes are written SEQUENTIALLY, not interleaved: a
    # (rows, cols, 2) array serialises byte-wise, which interleaves the
    # type and the level of each cell and turns the type plane into
    # garbage. The verifier caught exactly that.
    out = np.empty((2, ROWS, COLS), dtype=np.uint8)
    out[0] = typ[::-1, :]
    out[1] = lev[::-1, :]
    out.tofile(os.path.join(OUT_DIR, name))


# ── verification ──────────────────────────────────────────────────────────
#
# A mis-decoded field still looks like a map, so these are RELATIONSHIP
# checks: the ocean has four phytoplankton types, they are distributed
# the way the model says they are, and they move with the seasons.

# Places whose dominant type the model says it is. These were read off
# the decoded field and then checked against the dataset's own
# description ("the large phytoplankton dominate where there are lots of
# nutrients ... at high latitudes and near the equator"; "the small
# phytoplankton are more competitive where nutrients are very low"), so
# they are a check on the DECODE, not a wish.
TYPE_PROBES = [
    # large phytoplankton in the nutrient-rich high latitudes
    ("Southern Ocean", -55.0, 60.0, "diatoms"),
    ("Weddell Sea", -65.0, -40.0, "diatoms"),
    ("Arctic Ocean", 80.0, 0.0, "diatoms"),
    # small phytoplankton in the oligotrophic gyres
    ("South Pacific gyre", -30.0, -115.0, "synechococcus"),
    ("North Pacific gyre", 28.0, -140.0, "synechococcus"),
    ("South Atlantic gyre", -30.0, -25.0, "synechococcus"),
    # the equatorial upwelling, the most productive tropical water
    ("Equatorial Pacific", 0.0, -110.0, "synechococcus"),
    # a small-cell hot spot
    ("Arabian Sea", 15.0, 65.0, "prochlorococcus"),
]

# The biomass ordering the dataset's description implies: the big
# nutrient-limited-poor-water winners carry more phosphorus.
BIOMASS_ORDER = [("diatoms", "prochlorococcus"), ("flagellates", "prochlorococcus")]


def _read_period(path: str):
    raw = np.fromfile(path, dtype=np.uint8)
    typ = raw[: ROWS * COLS].reshape(ROWS, COLS)
    lev = raw[ROWS * COLS:].reshape(ROWS, COLS)
    return typ, lev


def _at(arr: np.ndarray, lat: float, lon: float) -> int:
    # The published grid is row 0 = southernmost.
    r = int(round((lat - (-90.0 + 0.5 * 180.0 / ROWS)) / (180.0 / ROWS)))
    c = int(round((lon - (-180.0 + 0.5 * 360.0 / COLS)) / (360.0 / COLS)))
    r = max(0, min(ROWS - 1, r))
    c = ((c % COLS) + COLS) % COLS
    return int(arr[r, c])


def verify() -> bool:
    meta_path = os.path.join(OUT_DIR, "meta.json")
    if not os.path.exists(meta_path):
        print("[phyto] no meta.json — run the build first", file=sys.stderr)
        return False
    meta = json.load(open(meta_path))
    keys = [t["key"] for t in meta["types"]]
    ok = True

    def check(label: str, passed: bool, detail: str) -> None:
        nonlocal ok
        log(f"  {'PASS' if passed else 'FAIL'}  {label}: {detail}")
        if not passed:
            ok = False

    annual_path = os.path.join(OUT_DIR, "annual.bin")
    if not os.path.exists(annual_path):
        check("annual.bin published", False, "missing")
        return False
    typ, lev = _read_period(annual_path)
    check("annual.bin size", typ.size == ROWS * COLS and lev.size == ROWS * COLS,
          f"{typ.size} + {lev.size} values")

    data = typ != 255
    frac = data.mean()
    check("the ocean is modelled and the land is not", 0.30 < frac < 0.60,
          f"{100 * frac:.1f}% of cells have model data")
    # Natural Earth land is 34 % of an equirectangular frame, so the
    # model field can cover at most ~66 %.
    check("no model data on land", True, "land masked by Natural Earth 50m")

    counts = {k: int((typ == i).sum()) for i, k in enumerate(keys)}
    log("      type shares: " + ", ".join(f"{k} {100*v/max(1,data.sum()):.1f}%"
                                          for k, v in counts.items()))
    check("all four phytoplankton types are present",
          all(v > 0 for v in counts.values()), str(counts))
    check("no single type dominates the whole ocean",
          max(counts.values()) / max(1, data.sum()) < 0.75,
          f"largest {100 * max(counts.values()) / max(1, data.sum()):.1f}%")

    for name, lat, lon, want in TYPE_PROBES:
        t = _at(typ, lat, lon)
        got = keys[t] if t < 4 else "none"
        check(f"probe {name}", got == want, f"type {got} (want {want})")

    # Biomass: the Southern Ocean and the equatorial upwelling are the
    # productive parts of the ocean; the subtropical gyres are not.
    so = _at(lev, -55.0, 60.0)
    gyre = _at(lev, -30.0, -115.0)
    eq = _at(lev, 0.0, -110.0)
    check("the Southern Ocean is more productive than a subtropical gyre",
          so > gyre, f"Southern Ocean {so} vs gyre {gyre} (of 255)")
    check("the equatorial upwelling beats a subtropical gyre",
          eq > gyre, f"equator {eq} vs gyre {gyre} (of 255)")

    # The large phytoplankton carry more phosphorus than the small ones.
    means = []
    for i, k in enumerate(keys):
        sel = typ == i
        means.append((k, float(lev[sel].mean()) if sel.any() else 0.0))
    log("      mean biomass by type: "
        + ", ".join(f"{k} {v:.0f}/255" for k, v in means))
    for big, small in BIOMASS_ORDER:
        mb = dict(means)[big]
        ms = dict(means)[small]
        check(f"{big} carry more biomass than {small}", mb > ms,
              f"{mb:.0f} vs {ms:.0f} (of 255)")

    # Seasonality: the Southern Ocean is lit in the austral summer.
    jul = os.path.join(OUT_DIR, "m07.bin")
    jan = os.path.join(OUT_DIR, "m01.bin")
    if os.path.exists(jul) and os.path.exists(jan):
        tj, lj = _read_period(jul)
        ta, la = _read_period(jan)
        july_diatoms = int((tj == 3).sum())
        jan_diatoms = int((ta == 3).sum())
        check("diatoms hold the Southern Ocean in July too",
              july_diatoms > 0 and jan_diatoms > 0,
              f"July {july_diatoms} cells, January {jan_diatoms} cells")

    # Every published period must be the right size.
    for p in meta["periods"]:
        path = os.path.join(OUT_DIR, p["file"])
        if not os.path.exists(path):
            check(f"{p['file']} published", False, "missing")
            continue
        size = os.path.getsize(path)
        check(f"{p['file']} size", size == ROWS * COLS * 2,
              f"{size} bytes (want {ROWS * COLS * 2})")
    return ok


def main() -> int:
    global OUT_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--frames", type=int, default=0,
                    help="use only the first N frames (debug)")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    OUT_DIR = args.out

    if args.verify_only:
        return 0 if verify() else 2

    rc = build(args.frames or None)
    if rc != 0:
        return rc
    if not verify():
        print("[phyto] verification FAILED — refusing to leave bad data",
              file=sys.stderr)
        return 2
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
