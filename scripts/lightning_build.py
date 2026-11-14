#!/usr/bin/env python3
"""
Build the global lightning density overlay assets for Xyzo.

Source: the WWLLN Global Lightning Climatology (WGLC) v2 — the 5 arc-minute
monthly climatology of lightning *stroke* density, 2020-2022.

  Zenodo   https://doi.org/10.5281/zenodo.20277101   (CC BY 4.0)
  Paper    Kaplan, J. O., & Lau, K. H.-K. (2021), "The WGLC global gridded
           lightning climatology and timeseries", Earth Syst. Sci. Data, 13,
           3577-3607. https://doi.org/10.5194/essd-13-3577-2021
  Method   WWLLN "AE" georeferenced stroke counts, gridded at 5 arc-minutes
           and corrected for detection efficiency with WWLLN's own global
           gridded efficiency maps.

WHY THIS DATASET AND NOT NASA LIS/OTD
-------------------------------------
The map everybody shares (geology.com, NOAA's Science On a Sphere) is NASA
LIS/OTD: a 0.5 degree grid — about 55 km per cell. WGLC is 5 arc-minutes,
0.0833 degrees — about 9.3 km per cell. Same phenomenon, six times finer,
and 2020-2022 rather than 1995-2013. It is the finest global lightning
climatology that exists in the public domain.

WHAT IS PUBLISHED
-----------------
  public_html/data/lightning/grid_annual.bin   the annual mean, 2160x4320
  public_html/data/lightning/grid_m01.bin .. m12.bin   one per month
  public_html/data/lightning/meta.json          layout, ramp, ticks, sources

The grids are uint16, one LSB = 1e-4 strokes km-2 d-1. Linear, so the
file is a plain raster of the published variable — the non-linear part
(the colour ramp) lives in the client and is described by meta.json.

Every *.png under public_html is served `immutable` for a year, so a
rebuilt tile pyramid is invisible behind a stale version token (the bug
that hid the Koppen layer on 2026-10-22). A .bin revalidates, and it is
also the right shape for this data: Leaflet cannot read a NetCDF and the
field has to be resampled into a Mercator wash anyway.

Usage:
  python3 -m scripts.lightning_build
  python3 -m scripts.lightning_build --verify-only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.request

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "lightning")
CACHE_DIR = os.path.join(REPO, "worker", "data")

SOURCE_NAME = "wglc_climatology_05m_monthly.nc"
SOURCE_URL = ("https://zenodo.org/api/records/20277101/files/"
              "wglc_climatology_05m_monthly.nc/content")
SOURCE_SHA256 = "2dc0075e613fbb0536e3293e747495576fd027c14902926e7a987f2e1a7d529b"
SOURCE_BYTES = 143983531

# ── the published grid ────────────────────────────────────────────────────
# WGLC's finest product: 5 arc-minutes = 1/12 degree.
GRID_ROWS = 2160
GRID_COLS = 4320
LAT_STEP = 1.0 / 12.0
LON_STEP = 1.0 / 12.0
LAT_MIN = -90.0 + LAT_STEP / 2.0     # -89.958333 — cell centres
LON_MIN = -180.0 + LON_STEP / 2.0    # -179.958333

# Storage: linear, 1e-4 strokes km-2 d-1 per LSB. The dataset peaks at
# 0.4197, so the whole range fits in uint16 with room to spare.
SCALE = 1e-4
MAX_STORED = 65535 * SCALE            # 6.5535 strokes km-2 d-1

# ── the colour scale ──────────────────────────────────────────────────────
# The client maps a value to a ramp position with
#     t = (v / VMAX) ** POWER
# and then looks the colour up in the ramp below. A power law is not a
# nicety here: the median cell on Earth is 3e-5 strokes km-2 d-1 and the
# maximum is 0.144 — a factor of 4800. On a linear ramp every ocean and
# every desert would be the same colour and the map would be a black
# rectangle.
#
# VMAX is the same for EVERY period, so a cell that is orange in January
# is orange in July. The annual field peaks at 0.14425 and the single
# hottest monthly cell is 0.4197, but only 19 cells in 9.3 million exceed
# VMAX — one hotspot cell clipped is invisible, a per-period scale would
# make January and July incomparable.
VMAX = 0.15
POWER = 0.4

# matplotlib's "inferno": black -> violet -> crimson -> orange -> straw.
# The NASA map this replaces runs grey -> deep red -> BLACK, which is
# invisible on this map's dark basemap. Inferno is the modern scientific
# choice for a density field on a dark ground and reads at a glance.
RAMP = [
    {"t": 0.000, "rgb": "#050416"},
    {"t": 0.125, "rgb": "#1b0c41"},
    {"t": 0.250, "rgb": "#4a0c6b"},
    {"t": 0.375, "rgb": "#781c6d"},
    {"t": 0.500, "rgb": "#a52c60"},
    {"t": 0.625, "rgb": "#cf4446"},
    {"t": 0.750, "rgb": "#ed6925"},
    {"t": 0.875, "rgb": "#fb9b06"},
    {"t": 1.000, "rgb": "#fcffa4"},
]

# Alpha is separate from the ramp so the places with NO lightning stay
# transparent and the basemap shows through. 40 % of the globe is exactly
# zero and 53 % is below 5e-5 — painting those opaque black would bury
# the coastlines under a black rectangle. The haze that remains over the
# Sahara is real (it is the NASA map's "light purple") and it is the
# driest thing on Earth, which the ramp shows by colour rather than by
# absence.
ALPHA = [
    {"t": 0.00, "a": 0},
    {"t": 0.05, "a": 0},
    {"t": 0.09, "a": 45},
    {"t": 0.14, "a": 95},
    {"t": 0.22, "a": 160},
    {"t": 0.35, "a": 225},
    {"t": 0.50, "a": 255},
]

MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]
MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def log(msg: str) -> None:
    print(f"[lightning] {msg}", flush=True)


# ── source acquisition ────────────────────────────────────────────────────

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_source(refresh: bool = False) -> str:
    """Path to the NetCDF, downloading it if it is not already cached."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, SOURCE_NAME)
    if refresh and os.path.exists(path):
        os.remove(path)
    if os.path.exists(path) and os.path.getsize(path) == SOURCE_BYTES:
        log(f"source cached: {path}")
        return path
    log(f"downloading {SOURCE_NAME} ({SOURCE_BYTES / 1e6:.0f} MB) from Zenodo")
    tmp_fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
    os.close(tmp_fd)
    try:
        with urllib.request.urlopen(SOURCE_URL, timeout=600) as resp, \
                open(tmp, "wb") as out:
            shutil.copyfileobj(resp, out, length=1 << 20)
        size = os.path.getsize(tmp)
        if size != SOURCE_BYTES:
            raise RuntimeError(f"size {size} != expected {SOURCE_BYTES}")
        digest = _sha256(tmp)
        if digest != SOURCE_SHA256:
            raise RuntimeError(f"sha256 {digest} != expected {SOURCE_SHA256}")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    log(f"source verified: {path}")
    return path


def read_density(path: str) -> np.ndarray:
    """The density variable as float32 [12, 2160, 4320]."""
    try:
        import h5py
    except ImportError:
        h5py = None
    if h5py is not None:
        with h5py.File(path, "r") as fh:
            var = fh["density"]
            data = var[:]
            units = fh["density"].attrs.get("units", b"")
        units = units.decode() if isinstance(units, bytes) else str(units)
        if units and "km-2" not in units.replace("km**-2", "km-2"):
            raise RuntimeError(f"unexpected units {units!r}")
        return np.asarray(data, dtype=np.float32)
    try:
        from osgeo import gdal
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(f"need h5py or GDAL to read the NetCDF: {exc}")
    ds = gdal.Open(f'NETCDF:"{path}":density')
    if ds is None:
        raise RuntimeError("GDAL could not open the density variable")
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray()
    return np.asarray(arr, dtype=np.float32)


# ── build ─────────────────────────────────────────────────────────────────

def quantise(field: np.ndarray) -> np.ndarray:
    """float32 strokes km-2 d-1 -> uint16, linear, 1e-4 per LSB."""
    s = np.rint(np.clip(field, 0.0, MAX_STORED) / SCALE)
    return s.astype("<u2")


def t_of(value: float) -> float:
    """Ramp position of a value — the same transform the client applies."""
    if value <= 0:
        return 0.0
    return min(1.0, (value / VMAX) ** POWER)


def year_ticks() -> list:
    """Legend ticks, in strokes km-2 yr-1, with their ramp positions.

    The scale is a power law, so the tick VALUES are bunched at one end
    of the bar: 0.05 and 0.1 sit 2 % apart in ramp position, which
    overlaps the labels completely. So the candidates are thinned to a
    minimum spacing in RAMP POSITION — that is what decides whether two
    labels collide — and the top of the scale is always kept.
    """
    wanted = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 45, 54]
    out = []
    last_t = None
    for y in wanted:
        daily = y / 365.0
        if daily > VMAX:
            continue
        t = t_of(daily)
        if last_t is not None and (t - last_t) < 0.085:
            continue
        out.append({"year": y, "daily": daily, "t": t})
        last_t = t
    # The maximum is the one tick the reader most wants; if it crowds
    # the tick below it, that one goes instead.
    if out and out[-1]["year"] != 54:
        top = {"year": 54, "daily": 54 / 365.0, "t": t_of(54 / 365.0)}
        if out and (top["t"] - out[-1]["t"]) < 0.085:
            out.pop()
        out.append(top)
    return out


def build() -> int:
    src = ensure_source()
    data = read_density(src)
    if data.shape != (12, GRID_ROWS, GRID_COLS):
        raise RuntimeError(f"unexpected density shape {data.shape}")

    os.makedirs(OUT_DIR, exist_ok=True)

    # The annual mean is day-weighted: a 31-day month counts for more of
    # the year than a 30-day one, and the per-year figures the legend
    # quotes have to add up.
    annual = np.zeros((GRID_ROWS, GRID_COLS), dtype=np.float64)
    periods = []
    for m in range(12):
        monthly = np.asarray(data[m], dtype=np.float64)
        annual += monthly * MONTH_DAYS[m]
        arr = quantise(monthly)
        name = f"grid_m{m + 1:02d}.bin"
        arr.tofile(os.path.join(OUT_DIR, name))
        periods.append({
            "id": f"m{m + 1:02d}",
            "label": MONTH_NAMES[m],
            "file": name,
            "rows": GRID_ROWS,
            "cols": GRID_COLS,
            "days": MONTH_DAYS[m],
            "max_daily": float(monthly.max()),
            "mean_daily": float(monthly.mean()),
        })
        log(f"{name}: max {monthly.max():.4f} strokes/km2/day")

    annual /= 365.0
    arr = quantise(annual)
    arr.tofile(os.path.join(OUT_DIR, "grid_annual.bin"))
    annual_period = {
        "id": "annual",
        "label": "Annual mean",
        "file": "grid_annual.bin",
        "rows": GRID_ROWS,
        "cols": GRID_COLS,
        "days": 365,
        "max_daily": float(annual.max()),
        "mean_daily": float(annual.mean()),
    }
    log(f"grid_annual.bin: max {annual.max():.4f} strokes/km2/day "
        f"({annual.max() * 365:.1f} /km2/yr)")

    meta = {
        "source": "WWLLN Global Lightning Climatology (WGLC) v2 — "
                  "5 arc-minute monthly climatology",
        "attribution": "WWLLN / ARVE Research",
        "license": "CC BY 4.0",
        "doi": "10.5281/zenodo.20277101",
        "url": "https://zenodo.org/records/20277101",
        "paper": "Kaplan, J. O., & Lau, K. H.-K. (2021), The WGLC global "
                 "gridded lightning climatology and timeseries, Earth Syst. "
                 "Sci. Data, 13, 3577-3607",
        "variable": "density",
        "units": "strokes km-2 d-1",
        "years": "2020-2022",
        "grid": {
            "rows": GRID_ROWS,
            "cols": GRID_COLS,
            "lat_min": LAT_MIN,
            "lat_max": LAT_MIN + (GRID_ROWS - 1) * LAT_STEP,
            "lon_min": LON_MIN,
            "lon_max": LON_MIN + (GRID_COLS - 1) * LON_STEP,
            "lat_step": LAT_STEP,
            "lon_step": LON_STEP,
            "scale": SCALE,
            "dtype": "uint16",
            "order": "row-major, row 0 = southernmost, column 0 = 180W",
            "resolution_km": 9.3,
        },
        "ramp": RAMP,
        "alpha": ALPHA,
        "v_max": VMAX,
        "power": POWER,
        "periods": [annual_period] + periods,
        "default_period": "annual",
        "ticks": year_ticks(),
        "notes": [
            "Stroke density, not flash density: WWLLN detects cloud-to-ground "
            "strokes, so these numbers run below NASA's LIS/OTD flash counts.",
            "The scale is a power law (power=0.4) so that a factor of 4800 "
            "between the driest and wettest cell stays readable.",
            "Values below ~2e-5 strokes km-2 d-1 are transparent so the "
            "basemap shows through where there is no lightning.",
        ],
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)

    total = sum(os.path.getsize(os.path.join(OUT_DIR, p["file"]))
                for p in meta["periods"])
    log(f"published {len(meta['periods'])} periods, {total / 1e6:.1f} MB")
    return 0


# ── verification ──────────────────────────────────────────────────────────
#
# A density field that decodes with a flipped axis still looks like a
# plausible map, so these are RELATIONSHIP checks, not shape checks. The
# control matters: the data has to be able to FAIL.

def _sample(field: np.ndarray, lat: float, lon: float) -> float:
    """Nearest-cell value (the grid is 5 arc-minutes; bilinear would only
    smooth the answer and hide a bad decode)."""
    r = int(round((lat - LAT_MIN) / LAT_STEP))
    c = int(round((lon - LON_MIN) / LON_STEP))
    r = max(0, min(GRID_ROWS - 1, r))
    c = max(0, min(GRID_COLS - 1, c))
    return float(field[r, c])


def _box_max(field: np.ndarray, la0: float, la1: float,
             lo0: float, lo1: float) -> float:
    r0 = int(round((la0 - LAT_MIN) / LAT_STEP))
    r1 = int(round((la1 - LAT_MIN) / LAT_STEP))
    c0 = int(round((lo0 - LON_MIN) / LON_STEP))
    c1 = int(round((lo1 - LON_MIN) / LON_STEP))
    r0, r1 = max(0, r0), min(GRID_ROWS, r1)
    c0, c1 = max(0, c0), min(GRID_COLS, c1)
    return float(field[r0:r1, c0:c1].max())


def verify() -> bool:
    src = ensure_source()
    data = read_density(src)
    annual = np.zeros((GRID_ROWS, GRID_COLS), dtype=np.float64)
    for m in range(12):
        annual += np.asarray(data[m], dtype=np.float64) * MONTH_DAYS[m]
    annual /= 365.0

    ok = True

    def check(label: str, passed: bool, detail: str) -> None:
        nonlocal ok
        log(f"  {'PASS' if passed else 'FAIL'}  {label}: {detail}")
        if not passed:
            ok = False

    log("verifying the annual mean")

    # 1. The single hottest cell on Earth is in the tropics. A field
    #    decoded with the latitude axis flipped puts it in the southern
    #    mid-latitudes instead, because that is where the ITCZ sits in
    #    the southern summer — but the ANNUAL maximum is in the northern
    #    band (Central America / the Congo), not the southern one.
    r, c = np.unravel_index(int(np.argmax(annual)), annual.shape)
    lat = LAT_MIN + r * LAT_STEP
    lon = LON_MIN + c * LON_STEP
    check("annual maximum is in the tropics",
          abs(lat) < 30.0,
          f"max {annual.max():.4f} at lat {lat:+.2f} lon {lon:+.2f}")

    # 2. NOAA's own figure for this dataset family: about 70 % of global
    #    lightning is in the tropics. A wrong axis moves that share.
    lat_rows = LAT_MIN + np.arange(GRID_ROWS) * LAT_STEP
    band = annual.sum(axis=1)
    share = 100.0 * band[(lat_rows > -30) & (lat_rows < 30)].sum() / annual.sum()
    check("60-85 % of global density is in the tropics", 60.0 <= share <= 85.0,
          f"{share:.1f} %")

    # 3. The poles are dead. This is the single most sensitive check to a
    #    latitude flip, because the poles are where a flipped field would
    #    put the ITCZ's opposite shoulder.
    pshare = 100.0 * band[(lat_rows > 60) | (lat_rows < -60)].sum() / annual.sum()
    check("poles carry under 1 % of global density", pshare < 1.0,
          f"{pshare:.3f} %")

    # 4. The Sahara is the driest large region on Earth; it must be
    #    orders of magnitude below the Congo.
    sahara = _box_max(annual, 15, 30, 0, 25)
    congo = _box_max(annual, -5, 5, 18, 30)
    check("Sahara is far drier than the Congo", congo > 8.0 * sahara,
          f"Sahara {sahara:.5f} vs Congo {congo:.5f} strokes/km2/d")

    # 5. Known hotspots must all be present and above the global mean.
    #    These are box maxima, not single cells: a hotspot is a region,
    #    and pinning it to one 9 km cell would make the check a test of
    #    my guess about which cell is brightest.
    hotspots = [
        ("Lake Maracaibo", 8, 11, -73, -69, 0.050),
        ("Central Africa", -5, 5, 18, 30, 0.010),
        ("Florida", 26, 29, -83, -79, 0.010),
        ("Sumatra", -3, 3, 98, 104, 0.010),
        ("Himalayan foreland", 24, 29, 80, 88, 0.003),
        ("Amazon", -6, 2, -66, -55, 0.004),
        ("Pampas", -38, -30, -66, -56, 0.003),
        ("Lake Victoria", -3, 2, 31, 34, 0.002),
        ("Maritime Continent", -8, 2, 100, 118, 0.010),
        ("Mexico", 14, 22, -104, -92, 0.010),
    ]
    for name, la0, la1, lo0, lo1, floor in hotspots:
        v = _box_max(annual, la0, la1, lo0, lo1)
        check(f"hotspot {name}", v >= floor,
              f"{v:.5f} strokes/km2/d ({v * 365:.1f}/km2/yr), floor {floor}")

    # 6. Axis sense: a point and its mirror in longitude must not share a
    #    value. Maracaibo is the hottest place on Earth; its mirror in
    #    Tajikistan is a desert.
    a = _sample(annual, 9.6, -71.8)
    b = _sample(annual, 9.6, 71.8)
    check("longitude is not mirrored", a > 20.0 * max(b, 1e-9),
          f"Maracaibo {a:.5f} vs mirror {b:.5f}")
    c1 = _sample(annual, -0.7, 29.3)
    c2 = _sample(annual, -0.7, -29.3)
    check("longitude is not mirrored (Atlantic)", c1 > 20.0 * max(c2, 1e-9),
          f"Congo {c1:.5f} vs Atlantic {c2:.5f}")

    # 7. Seasonality: the ITCZ migrates, so the southern hemisphere must
    #    dominate in December and the northern in July. A field that is
    #    stuck, or whose months are mis-ordered, fails here.
    def hemi_share(month_idx: int) -> float:
        f = np.asarray(data[month_idx], dtype=np.float64)
        lat_rows = LAT_MIN + np.arange(GRID_ROWS) * LAT_STEP
        north = f[lat_rows > 0].sum()
        south = f[lat_rows < 0].sum()
        return float(north / (north + south))

    dec = hemi_share(11)
    jul = hemi_share(6)
    check("July is a northern-hemisphere season", jul > 0.58,
          f"northern share {jul:.3f}")
    check("December is a southern-hemisphere season", dec < 0.45,
          f"northern share {dec:.3f}")

    # 8. The December hotspot is over the Maritime Continent; the July
    #    hotspot is over Mexico. If the month axis were reversed these
    #    two would swap.
    dec_arr = np.asarray(data[11], dtype=np.float64)
    jul_arr = np.asarray(data[6], dtype=np.float64)
    r, cc = np.unravel_index(int(np.argmax(dec_arr)), dec_arr.shape)
    dec_lat = LAT_MIN + r * LAT_STEP
    dec_lon = LON_MIN + cc * LON_STEP
    r, cc = np.unravel_index(int(np.argmax(jul_arr)), jul_arr.shape)
    jul_lat = LAT_MIN + r * LAT_STEP
    jul_lon = LON_MIN + cc * LON_STEP
    check("December peaks over the Maritime Continent",
          -12.0 < dec_lat < 6.0 and 95.0 < dec_lon < 125.0,
          f"lat {dec_lat:+.2f} lon {dec_lon:+.2f}")
    check("July peaks over Mexico", 12.0 < jul_lat < 25.0 and -105.0 < jul_lon < -85.0,
          f"lat {jul_lat:+.2f} lon {jul_lon:+.2f}")

    # 9. Nothing negative, nothing NaN, and the stored grids round-trip.
    if not np.isfinite(annual).all() or (annual < 0).any():
        check("no negative or non-finite values", False, "found bad cells")
    else:
        check("no negative or non-finite values", True, "clean")

    for name in ("grid_annual.bin",):
        path = os.path.join(OUT_DIR, name)
        if not os.path.exists(path):
            check(f"{name} published", False, "missing")
            continue
        raw = np.fromfile(path, dtype="<u2")
        if raw.size != GRID_ROWS * GRID_COLS:
            check(f"{name} size", False, f"{raw.size} values")
            continue
        back = raw.astype(np.float64) * SCALE
        worst = float(np.abs(back - np.clip(annual, 0, MAX_STORED).ravel()).max())
        check(f"{name} round-trips", worst <= SCALE * 0.5 + 1e-12,
              f"max error {worst:.2e} strokes/km2/d")

    return ok


def main() -> int:
    global OUT_DIR

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download the source NetCDF")
    args = ap.parse_args()

    OUT_DIR = args.out

    if args.verify_only:
        return 0 if verify() else 2

    rc = build()
    if rc != 0:
        return rc
    if not verify():
        print("[lightning] verification FAILED — refusing to leave bad data",
              file=sys.stderr)
        return 2
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
