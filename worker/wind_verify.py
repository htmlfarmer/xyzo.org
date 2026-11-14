#!/usr/bin/env python3
"""Independent verification of the published wind grid.

The wind overlay has three separate layers, and the worker's own
`verify()` gate only covers one of them:

  1. THE DATA     — is grid.bin really the GFS 10 m wind analysis?
  2. THE SAMPLER  — does the browser read the right cell for a point?
  3. THE PHYSICS  — do the particles move the way the wind blows?

This tool covers (1) end to end. It decodes the SAME GFS cycle a second
time, using the GRIB message's OWN index arithmetic — Ni, Nj,
latitudeOfFirstGridPoint, longitudeOfFirstGridPoint, the direction
increments and jScansPositively — instead of `decode_field()`'s
normalisation, and compares the result with the published file cell by
cell. A row-order inversion (the field mirrored about the equator), a
swapped u/v, a wrong scale factor, a stale cycle or a truncated upload
all show up here as a mismatch, whatever they look like on the map.

It can also cross-check against an INDEPENDENT implementation —
Open-Meteo's GFS, which reads the same NOAA analysis and serves it
through a completely different code path. That is the only check that
catches a field which decodes perfectly but means something else: u and
v swapped, the wrong level, the wrong sign, the wrong hour. The
numbers it prints are directly comparable with windy.com and
zoom.earth, which is the point of running it at a point you are looking
at on one of those.

Nothing here is on the publish path. worker/windmap.py writes the
overlay; this reads it and argues with it.

Usage:
    python -m worker.wind_verify                        # published grid vs GFS
    python -m worker.wind_verify --points 40.873,-64.739 41.74,-82.39
    python -m worker.wind_verify --reference            # + Open-Meteo GFS
    python -m worker.wind_verify --offline              # no network at all
    python -m worker.wind_verify --json                 # machine-readable
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import tempfile
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger("xyzo.wind_verify")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "wind")

# Landmarks that are easy to check by eye against a reference map, plus
# the two points this layer was last audited against.
DEFAULT_POINTS = [
    (40.873, -64.739),   # North Atlantic, off Nova Scotia
    (41.740, -82.390),   # Lake Erie, Ohio
    (51.500, -0.130),    # London
    (40.417, -3.703),    # Madrid
    (35.680, 139.690),   # Tokyo
    (-33.870, 151.210),  # Sydney
    (1.352, 103.820),    # Singapore
    (-1.292, 36.822),    # Nairobi
    (-22.907, -43.173),  # Rio de Janeiro
    (64.147, -21.940),   # Reykjavik
    (0.000, 0.000),      # the middle of the Atlantic
]

# Open-Meteo is a VERIFICATION dependency only. It is never on the
# publish path: the free tier counts one call per location, which is
# exactly why the overlay does not use it (see AGENTS.md, Temperature
# Overlay Rules).
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

# A published value may differ from the raw GRIB by at most the
# quantisation of the int16 storage (0.01 m/s), plus a hair for the
# float round-trip.
TOL_MS = 0.011

# The two implementations disagree by more than this in the open ocean
# or over land: our grid is 1° and Open-Meteo's GFS is 0.25°, and a
# 1° bilinear cannot reproduce the sub-cell structure of a front. Speed
# is the forgiving one; direction is the strict one.
TOL_SPEED_MS = 3.0
TOL_DIRECTION_DEG = 45.0

# How much the direction tolerance may grow with the local gradient.
TOL_DIRECTION_PER_MS = 8.0
TOL_DIRECTION_MAX_EXTRA = 60.0

# Below this the wind has no meaningful direction — a 1 m/s breeze
# points whichever way the sub-cell noise points, and the 1° and the
# 0.25° grid will disagree by 90° without either being wrong.
CALM_MS = 2.5


# ── the published file ───────────────────────────────────────────────────
class PublishedGrid:
    """public_html/data/wind/{meta.json,grid.bin}, decoded."""

    def __init__(self, meta: dict, u: np.ndarray, v: np.ndarray):
        self.meta = meta
        self.grid = meta["grid"]
        self.u = u
        self.v = v

    @property
    def run_time(self) -> str:
        return self.meta.get("run_time", "")

    @property
    def cycle(self) -> tuple[str, str]:
        """(date_str, cycle) of the published analysis, e.g. ("20261027", "12")."""
        rt = self.run_time
        if len(rt) < 13 or not rt.endswith("Z"):
            raise ValueError(f"unreadable run_time {rt!r}")
        d = rt[:10].replace("-", "")
        return d, rt[11:13]

    def at(self, lat: float, lon: float) -> tuple[float, float]:
        """Nearest-neighbour (u, v) in m/s."""
        g = self.grid
        row = int(round((lat - g["lat_min"]) / g["lat_step"]))
        col = int(round(((lon - g["lon_min"]) % 360) / g["lon_step"])) % g["cols"]
        row = min(max(row, 0), g["rows"] - 1)
        return float(self.u[row, col]), float(self.v[row, col])

    def bilinear(self, lat: float, lon: float) -> tuple[float, float]:
        """Bilinear (u, v) in m/s — the same rule the browser uses.

        Longitude wraps, and the column past the last one wraps back to
        column 0: at 359.5°E the two neighbours are 359° and 0°, not
        359° and 359°.
        """
        g = self.grid
        lon_w = ((((lon - g["lon_min"]) % 360) + 360) % 360) + g["lon_min"]
        gx = (lon_w - g["lon_min"]) / g["lon_step"]
        gy = (lat - g["lat_min"]) / g["lat_step"]
        x0 = int(math.floor(gx))
        y0 = int(math.floor(gy))
        x1 = (x0 + 1) % g["cols"]
        y1 = min(y0 + 1, g["rows"] - 1)
        x0 = x0 % g["cols"]
        fx, fy = gx - math.floor(gx), gy - math.floor(gy)

        def interp(arr):
            return ((1 - fy) * ((1 - fx) * arr[y0, x0] + fx * arr[y0, x1]) +
                    fy * ((1 - fx) * arr[y1, x0] + fx * arr[y1, x1]))

        return float(interp(self.u)), float(interp(self.v))


def load_published(out_dir: str = OUT_DIR) -> PublishedGrid:
    """Read the published grid.bin + meta.json."""
    meta_path = os.path.join(out_dir, "meta.json")
    grid_path = os.path.join(out_dir, "grid.bin")
    with open(meta_path) as fh:
        meta = json.load(fh)
    g = meta["grid"]
    n = int(g["rows"]) * int(g["cols"])
    raw = np.fromfile(grid_path, dtype="<i2")
    if raw.size != n * 2:
        raise ValueError(
            f"{grid_path} holds {raw.size} int16 values, expected {n * 2} "
            f"({g['rows']}x{g['cols']} planar u/v)"
        )
    scale = float(g.get("scale", 100))
    u = raw[:n].reshape(int(g["rows"]), int(g["cols"])).astype(np.float64) / scale
    v = raw[n:].reshape(int(g["rows"]), int(g["cols"])).astype(np.float64) / scale
    return PublishedGrid(meta, u, v)


# ── the wind itself ─────────────────────────────────────────────────────
def compass(deg: float) -> str:
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int(round((deg % 360) / 22.5)) % 16]


def describe(u: float, v: float) -> dict:
    """Speed and the meteorological "from" direction of a (u, v) pair."""
    speed = math.hypot(u, v)
    # u is eastward, v is northward. The wind comes FROM the opposite
    # of the direction it blows towards.
    frm = math.degrees(math.atan2(-u, -v)) % 360
    return {
        "u_ms": round(u, 2),
        "v_ms": round(v, 2),
        "speed_ms": round(speed, 2),
        "speed_kmh": round(speed * 3.6, 1),
        "speed_kt": round(speed * 1.94384, 1),
        "from_deg": round(frm, 1),
        "from": compass(frm),
    }


# ── the raw GRIB ────────────────────────────────────────────────────────
class RawField:
    """A GRIB message decoded with the message's OWN index arithmetic.

    Deliberately does not go through worker.isobars.decode_field(): the
    point of this class is to be an independent second opinion on where
    a value sits in the grid.
    """

    def __init__(self, values: np.ndarray, ni: int, nj: int, lat1: float,
                 lon1: float, di: float, dj: float, jpos: int, short_name: str):
        self.values = values          # RAW row order, as it comes out of the message
        self.ni, self.nj = ni, nj
        self.lat1, self.lon1 = lat1, lon1
        self.di, self.dj = di, dj
        self.jpos = jpos              # 1 = rows ascend from lat1, 0 = rows descend
        self.short_name = short_name

    def index(self, lat: float, lon: float) -> tuple[int, int]:
        if self.jpos == 1:
            j = int(round((lat - self.lat1) / self.dj))
        else:
            j = int(round((self.lat1 - lat) / self.dj))
        i = int(round(((lon - self.lon1) % 360) / self.di)) % self.ni
        return j, i

    def at(self, lat: float, lon: float) -> float:
        j, i = self.index(lat, lon)
        return float(self.values[j, i])

    def published_cell(self, lat: float, lon: float) -> tuple[int, int]:
        """Where a (lat, lon) belongs in a grid whose row 0 is -90° and
        whose column 0 is longitude 0."""
        j, i = self.index(lat, lon)
        lat_j = self.lat1 - j * self.dj if self.jpos == 0 else self.lat1 + j * self.dj
        lon_i = (self.lon1 + i * self.di) % 360.0
        return int(round(lat_j + 90.0)), int(round(lon_i)) % self.ni


def decode_raw(grib_bytes: bytes) -> RawField:
    """Decode a single-field GRIB2 message without normalising it."""
    import os as _os

    try:
        import eccodes
    except ImportError as exc:  # pragma: no cover - depends on the host
        raise RuntimeError(
            "eccodes is not installed — pip install 'eccodes' 'eccodeslib'"
        ) from exc

    handle, path = tempfile.mkstemp(prefix="xyzo-windverify-", suffix=".grb2")
    gid = None
    try:
        with _os.fdopen(handle, "wb") as fh:
            fh.write(grib_bytes)
        with open(path, "rb") as fh:
            gid = eccodes.codes_new_from_file(fh, eccodes.CODES_PRODUCT_GRIB)
            if isinstance(gid, list):
                gid = gid[0]
            if gid is None:
                raise RuntimeError("no GRIB message in the downloaded file")
            values = np.asarray(eccodes.codes_get_array(gid, "values"), dtype=np.float64)
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
            lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
            di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
            dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
            jpos = eccodes.codes_get(gid, "jScansPositively")
            short_name = eccodes.codes_get(gid, "shortName")
    finally:
        # The handle MUST be released: left open, the bundled eccodes
        # library segfaults while the interpreter tears down.
        if gid is not None:
            try:
                eccodes.codes_release(gid)
            except Exception:
                pass
        try:
            _os.unlink(path)
        except OSError:
            pass

    return RawField(values.reshape(nj, ni), ni, nj, lat1, lon1, di, dj,
                    jpos, short_name)


def fetch_raw_cycle(date_str: str, cycle: str) -> tuple[RawField, RawField]:
    """Download the 10 m u/v of one GFS cycle, decoded raw.

    The PRODUCT is the published grid's own resolution — 0.25° since
    2026-11-04, when the wind moved off the 1° product. The audit has to
    read the field the grid was cut from, or it measures the difference
    between two resolutions and calls it a data bug (the same mistake
    the isobar check had).
    """
    from .isobars import fetch_grib_field

    suffixes = ("0p25", "1p00")
    out = {}
    for short, var in (("10u", "UGRD"), ("10v", "VGRD")):
        grib, _product = fetch_grib_field(
            date_str, cycle, var, "10_m_above_ground",
            f"the GFS 10 m {var} wind", suffixes=suffixes,
        )
        field = decode_raw(grib)
        if field.short_name != short:
            raise RuntimeError(
                f"expected {short!r} from the filter server, got {field.short_name!r}"
            )
        out[short] = field
    return out["10u"], out["10v"]


# ── checks ──────────────────────────────────────────────────────────────
def check_self_consistency(pub: PublishedGrid) -> list[str]:
    """meta.json against grid.bin, with no network at all."""
    problems = []
    g = pub.grid
    n = int(g["rows"]) * int(g["cols"])
    if g.get("layout") != "planar_uv":
        problems.append(f"layout is {g.get('layout')!r}, expected 'planar_uv'")
    # The resolution is not hardcoded: the grid is 0.25° since
    # 2026-11-04 (it was 1°), and what has to hold is that the META and
    # the FILE agree — the product, the step and the shape are all one
    # statement about the same thing.
    lat_step = float(g["lat_step"])
    lon_step = float(g["lon_step"])
    rows = int(g["rows"])
    cols = int(g["cols"])
    if lat_step <= 0 or lon_step <= 0:
        problems.append(f"the grid steps are {lat_step}° x {lon_step}°")
    elif abs(lat_step - lon_step) > 1e-9:
        problems.append(f"lat_step {lat_step}° and lon_step {lon_step}° differ")
    if abs((rows - 1) * lat_step - 180.0) > 0.01:
        problems.append(
            f"{rows} rows at {lat_step}° do not span 180° of latitude"
        )
    if abs(cols * lon_step - 360.0) > 0.01:
        problems.append(
            f"{cols} columns at {lon_step}° do not span 360° of longitude"
        )
    # The product names the resolution, and the file must be the one
    # that product produces.
    product = str((pub.meta or {}).get("product") or "")
    expected_suffix = None
    for suffix in ("0p25", "1p00"):
        if product.endswith(suffix):
            expected_suffix = suffix
    if expected_suffix is None:
        problems.append(f"product {product!r} does not name a GFS grid")
    else:
        expect_step = 0.25 if expected_suffix == "0p25" else 1.0
        if abs(lat_step - expect_step) > 1e-9:
            problems.append(
                f"product {product!r} is a {expect_step}° grid but the meta "
                f"says {lat_step}°"
            )
    if float(g["lat_min"]) != -90.0 or float(g["lat_max"]) != 90.0:
        problems.append("row 0 must be the southernmost latitude (-90°)")
    if float(g["lon_min"]) != 0.0:
        problems.append(f"column 0 must be longitude 0, not {g['lon_min']}")
    if float(g.get("scale", 100)) != 100.0:
        problems.append(f"scale is {g.get('scale')}, the frontend reads 0.01 m/s per unit")

    # The published mean must be the mean of the published file.
    speed = np.hypot(pub.u, pub.v)
    if abs(float(speed.mean()) - float(pub.meta["mean_ms"])) > 0.02:
        problems.append(
            f"meta mean_ms {pub.meta['mean_ms']} but grid.bin averages {speed.mean():.2f}"
        )
    obs = pub.meta.get("observed_ms") or [None, None]
    if obs[0] is not None and abs(float(speed.min()) - float(obs[0])) > 0.02:
        problems.append(
            f"meta observed_ms min {obs[0]} but grid.bin holds {speed.min():.2f}"
        )
    if obs[1] is not None and abs(float(speed.max()) - float(obs[1])) > 0.02:
        problems.append(
            f"meta observed_ms max {obs[1]} but grid.bin holds {speed.max():.2f}"
        )
    return problems


def compare_cell_by_cell(pub: PublishedGrid, raw_u: RawField, raw_v: RawField) -> dict:
    """Every cell of the published grid against the raw GRIB message.

    This is the check that catches a mirrored field, a swapped u/v, a
    wrong scale and a stale cycle — all of them at once.
    """
    g = pub.grid
    rows, cols = int(g["rows"]), int(g["cols"])
    if (raw_u.nj, raw_u.ni) != (rows, cols):
        raise RuntimeError(
            f"the GFS grid is {raw_u.ni}x{raw_u.nj} but the published one is "
            f"{cols}x{rows} — they are different products"
        )

    du = np.zeros((rows, cols))
    dv = np.zeros((rows, cols))
    # The row and the column come from the PUBLISHED GRID'S OWN steps,
    # not from an assumed 1° lattice. The wind moved from the 1° product
    # to the 0.25° one on 2026-11-04, and the old "row = lat + 90" and
    # "col = round(lon)" arithmetic put every value in the wrong cell
    # (max diff 34.7 m/s — a shape that looks like a scrambled field and
    # is nothing of the sort).
    lat_step = float(g["lat_step"])
    lon_step = float(g["lon_step"])
    lat_min = float(g["lat_min"])
    for j in range(raw_u.nj):
        lat = raw_u.lat1 - j * raw_u.dj if raw_u.jpos == 0 else raw_u.lat1 + j * raw_u.dj
        row = int(round((lat - lat_min) / lat_step))
        if not (0 <= row < rows):
            continue
        for i in range(raw_u.ni):
            lon = (raw_u.lon1 + i * raw_u.di) % 360.0
            col = int(round(lon / lon_step)) % cols
            du[row, col] = raw_u.values[j, i]
            dv[row, col] = raw_v.values[j, i]

    diff_u = np.abs(pub.u - du)
    diff_v = np.abs(pub.v - dv)
    worst = float(max(diff_u.max(), diff_v.max()))
    where = np.unravel_index(int(np.argmax(np.maximum(diff_u, diff_v))),
                             diff_u.shape)
    return {
        "cells": rows * cols,
        "max_diff_ms": round(worst, 4),
        "cells_over_tolerance": int((np.maximum(diff_u, diff_v) > TOL_MS).sum()),
        "worst_cell": {"row": int(where[0]), "col": int(where[1]),
                       "lat": float(g["lat_min"] + where[0] * g["lat_step"]),
                       "lon": float(where[1] * g["lon_step"])},
    }


def compare_bilinear(pub: PublishedGrid, raw_u: RawField, raw_v: RawField,
                     points: list[tuple[float, float]]) -> dict:
    """The published grid's bilinear against a bilinear of the raw GRIB."""
    worst = 0.0
    worst_at = None
    for lat, lon in points:
        bu, bv = pub.bilinear(lat, lon)
        # Bilinear straight off the raw message, with the same wrapping.
        ru, rv = _raw_bilinear(raw_u, raw_v, lat, lon)
        d = max(abs(bu - ru), abs(bv - rv))
        if d > worst:
            worst, worst_at = d, (lat, lon)
    return {"max_diff_ms": round(worst, 4), "worst_at": worst_at}


def _raw_bilinear(raw_u: RawField, raw_v: RawField, lat: float,
                  lon: float) -> tuple[float, float]:
    def bilinear(field: RawField, lat: float, lon: float) -> float:
        gx = ((lon - field.lon1) % 360.0) / field.di
        gy = ((field.lat1 - lat) / field.dj) if field.jpos == 0 else \
             ((lat - field.lat1) / field.dj)
        x0 = int(math.floor(gx))
        y0 = int(math.floor(gy))
        fx, fy = gx - math.floor(gx), gy - math.floor(gy)
        x1 = (x0 + 1) % field.ni
        y1 = min(y0 + 1, field.nj - 1)
        x0 %= field.ni
        y0 = max(0, min(y0, field.nj - 1))
        return ((1 - fy) * ((1 - fx) * field.values[y0, x0] + fx * field.values[y0, x1]) +
                fy * ((1 - fx) * field.values[y1, x0] + fx * field.values[y1, x1]))

    return bilinear(raw_u, lat, lon), bilinear(raw_v, lat, lon)


# ── the independent reference ───────────────────────────────────────────
def fetch_reference(lat: float, lon: float, run_time: str) -> dict | None:
    """Open-Meteo's GFS at the same hour — a different code path reading
    the same NOAA analysis."""
    import httpx

    hour = run_time[11:13]
    day = run_time[:10]
    params = {
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "hourly": "wind_speed_10m,wind_direction_10m",
        "models": "gfs_seamless",
        "start_date": day,
        "end_date": day,
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }
    try:
        r = httpx.get(OPEN_METEO, params=params, timeout=45.0,
                      follow_redirects=True)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # network trouble must not fail the run
        log.warning("reference lookup failed for %s,%s: %s", lat, lon, exc)
        return None
    if isinstance(data, list):
        data = data[0]
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    if f"{day}T{hour}:00" not in times:
        return None
    k = times.index(f"{day}T{hour}:00")
    speed = hourly["wind_speed_10m"][k]
    direction = hourly["wind_direction_10m"][k]
    if speed is None or direction is None:
        return None
    return {"speed_ms": float(speed), "from_deg": float(direction)}


def local_spread(pub: PublishedGrid, lat: float, lon: float) -> float:
    """How much the wind varies across the four cells around a point.

    No grid can resolve what a finer one sees: the two
    implementations disagree by up to the local sub-cell variability,
    and the size of that variability is visible in the field itself.
    Tokyo sits in a cell whose four neighbours run from 1.9 to
    7.1 m/s — the honest answer for a 1° grid is somewhere in that
    band, and the 0.25° GFS analysis of the same hour says 8.9 m/s.
    So the tolerance has to grow with this, or a coastal point with a
    sharp gradient reads as a failure when nothing is wrong.

    The cells are the PUBLISHED grid's own, so this follows the
    resolution: it was 1° and is 0.25° since 2026-11-04.
    """
    g = pub.grid
    lat0 = math.floor((lat - g["lat_min"]) / g["lat_step"])
    lon0 = math.floor((((lon - g["lon_min"]) % 360) + 360) % 360 / g["lon_step"])
    speeds = []
    for dlat in (0, 1):
        for dlon in (0, 1):
            row = min(max(lat0 + dlat, 0), int(g["rows"]) - 1)
            col = int(lon0 + dlon) % int(g["cols"])
            speeds.append(float(math.hypot(pub.u[row, col], pub.v[row, col])))
    return max(speeds) - min(speeds)


def compare_reference(pub: PublishedGrid, points: list[tuple[float, float]]) -> list[dict]:
    rows = []
    for lat, lon in points:
        u, v = pub.bilinear(lat, lon)
        ours = describe(u, v)
        ref = fetch_reference(lat, lon, pub.run_time)
        if ref is None:
            rows.append({"point": [lat, lon], "ours": ours, "reference": None})
            continue
        d_dir = abs((ours["from_deg"] - ref["from_deg"] + 180.0) % 360.0 - 180.0)
        calm = (ours["speed_ms"] < CALM_MS and ref["speed_ms"] < CALM_MS)
        spread = local_spread(pub, lat, lon)
        speed_tol = TOL_SPEED_MS + spread
        dir_tol = TOL_DIRECTION_DEG + min(TOL_DIRECTION_MAX_EXTRA,
                                          spread * TOL_DIRECTION_PER_MS)
        rows.append({
            "point": [lat, lon],
            "ours": ours,
            "reference": ref,
            "delta_speed_ms": round(ours["speed_ms"] - ref["speed_ms"], 2),
            "delta_dir_deg": round(d_dir, 1),
            "calm": calm,
            # The grid's own cells around this point disagree among
            # themselves by this much, so no grid can do better there.
            "local_spread_ms": round(spread, 2),
            "speed_tolerance": round(speed_tol, 2),
            "ok": (abs(ours["speed_ms"] - ref["speed_ms"]) <= speed_tol
                   and (calm or d_dir <= dir_tol)),
        })
    return rows


# ── entry point ─────────────────────────────────────────────────────────
def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--points", nargs="*", default=None,
                        help="lat,lon pairs to report on")
    parser.add_argument("--reference", action="store_true",
                        help="also compare against Open-Meteo's GFS")
    parser.add_argument("--offline", action="store_true",
                        help="self-consistency only; do not touch the network")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output")
    args = parser.parse_args()

    points = DEFAULT_POINTS
    if args.points:
        points = []
        for p in args.points:
            lat, _, lon = p.partition(",")
            points.append((float(lat), float(lon)))

    pub = load_published()
    report: dict = {
        "run_time": pub.run_time,
        "grid": pub.grid,
        "points": [],
        "problems": [],
    }

    problems = check_self_consistency(pub)
    report["problems"].extend(problems)

    if not args.offline:
        try:
            date_str, cycle = pub.cycle
            raw_u, raw_v = fetch_raw_cycle(date_str, cycle)
            cells = compare_cell_by_cell(pub, raw_u, raw_v)
            report["cell_comparison"] = cells
            report["bilinear_comparison"] = compare_bilinear(pub, raw_u, raw_v, points)
            if cells["cells_over_tolerance"]:
                problems.append(
                    f"{cells['cells_over_tolerance']} of {cells['cells']} cells differ "
                    f"from the raw GRIB by more than {TOL_MS} m/s"
                )
        except RuntimeError as exc:
            problems.append(f"could not reach NOMADS: {exc}")

    for lat, lon in points:
        u, v = pub.bilinear(lat, lon)
        report["points"].append({"point": [lat, lon], **describe(u, v)})

    if args.reference and not args.offline:
        report["reference"] = compare_reference(pub, points)
        for row in report["reference"]:
            if row.get("reference") and not row.get("ok"):
                problems.append(
                    f"{row['point']}: ours {row['ours']['speed_ms']} m/s from "
                    f"{row['ours']['from_deg']}°, reference {row['reference']['speed_ms']} "
                    f"m/s from {row['reference']['from_deg']}°"
                )

    report["ok"] = not problems

    if args.json:
        print(json.dumps(report, indent=1))
    else:
        _print_report(report, problems)

    return 0 if report["ok"] else 1


def _print_report(report: dict, problems: list[str]) -> None:
    g = report["grid"]
    print(f"published wind grid   : {g['rows']}x{g['cols']}  "
          f"lat {g['lat_min']}..{g['lat_max']}  lon {g['lon_min']}..  "
          f"layout {g.get('layout')}")
    print(f"analysis              : {report['run_time']}")
    if "cell_comparison" in report:
        c = report["cell_comparison"]
        print(f"vs raw GRIB           : {c['cells']} cells, max diff "
              f"{c['max_diff_ms']} m/s, {c['cells_over_tolerance']} over tolerance")
        b = report["bilinear_comparison"]
        print(f"bilinear vs raw GRIB  : max diff {b['max_diff_ms']} m/s")
    print()
    print(f"{'point':>24} {'speed':>8} {'km/h':>7} {'kt':>6} {'from':>5} "
          f"{'u':>8} {'v':>8}")
    for p in report["points"]:
        print(f"({p['point'][0]:8.3f},{p['point'][1]:9.3f}) {p['speed_ms']:8.2f} "
              f"{p['speed_kmh']:7.1f} {p['speed_kt']:6.1f} {p['from']:>5} "
              f"{p['u_ms']:8.2f} {p['v_ms']:8.2f}  {p['from_deg']:5.1f}°")
    if report.get("reference"):
        print()
        print(f"{'point':>24} {'ours':>16} {'Open-Meteo GFS':>18} {'delta':>14}")
        for row in report["reference"]:
            ref = row.get("reference")
            if not ref:
                print(f"({row['point'][0]:8.3f},{row['point'][1]:9.3f}) "
                      f"{row['ours']['speed_ms']:8.2f} m/s   (no reference)")
                continue
            note = "  (calm — direction is not meaningful)" if row.get("calm") else ""
            print(f"({row['point'][0]:8.3f},{row['point'][1]:9.3f}) "
                  f"{row['ours']['speed_ms']:8.2f} m/s {row['ours']['from_deg']:5.1f}° "
                  f"{ref['speed_ms']:9.2f} m/s {ref['from_deg']:5.1f}° "
                  f"{row['delta_speed_ms']:6.2f} m/s {row['delta_dir_deg']:5.1f}°{note}")
            if row.get("local_spread_ms", 0) > 1.0:
                print(f"{'':24s} (the grid's own cells around it differ by "
                      f"{row['local_spread_ms']} m/s — no grid can do better "
                      f"there)")
    print()
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print(f"  ✗ {p}")
    else:
        print("✓ the published grid matches the GFS analysis it claims to be")


if __name__ == "__main__":
    raise SystemExit(main())
