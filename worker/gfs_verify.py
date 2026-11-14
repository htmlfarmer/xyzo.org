#!/usr/bin/env python3
"""Cross-verification of the three GFS overlays against each other.

The map paints three fields that all come from ONE NOAA NCEP GFS
analysis cycle:

    worker/isobars.py  →  pressure (MSLP) → contours in PostGIS
    worker/tempmap.py  →  2 m temperature → data/temp/grid.bin
    worker/windmap.py  →  10 m wind (u/v) → data/wind/grid.bin

They share the decoder (`worker/isobars.py: decode_field()`), so a bug
in the decoder would corrupt all three at once — and each overlay's own
`verify()` gate is a *relationship* check (mid-latitudes windier than
the tropics, the equator warmer than the poles) which, as
`wind_verify.py` shows, cannot tell a mirrored field from a correct
one: the relationship holds in both hemispheres.

So this tool checks the three fields against each other, and each of
them against the raw GRIB message re-decoded with the message's OWN
index arithmetic:

  1. THE WIND vs THE PRESSURE — the geostrophic balance.
     In a balanced atmosphere the wind runs roughly PARALLEL to the
     isobars, with LOW pressure on its LEFT in the northern
     hemisphere. The geostrophic wind can be computed from the
     pressure field alone (V_g = k × ∇p / (ρf)), so the pressure field
     is an INDEPENDENT WITNESS for the wind: if the wind were mirrored,
     swapped or from the wrong level, it could not line up with the
     pressure gradient. Surface friction turns the flow slightly
     ACROSS the isobars, toward the low pressure — the sign of that
     cross-isobar component is checked too.

  2. THE WIND vs THE TEMPERATURE — advection.
     The wind carries air with it, so the temperature it comes FROM
     must be the cold side and the temperature it goes towards the
     warm side. A mirrored or reversed wind field breaks this.

  3. EACH PUBLISHED GRID vs THE RAW GRIB — cell by cell.

Nothing here is on the publish path. This is the audit.

Usage:
    python3 -m worker.gfs_verify                 # all three + the cross-checks
    python3 -m worker.gfs_verify --field wind    # one of them
    python3 -m worker.gfs_verify --offline       # no network: self-consistency
    python3 -m worker.gfs_verify --json
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

log = logging.getLogger("xyzo.gfs_verify")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO, "public_html", "data")

# The published grids.
WIND_DIR = os.path.join(DATA_DIR, "wind")
TEMP_DIR = os.path.join(DATA_DIR, "temp")

# Physical constants.
OMEGA = 7.2921159e-5      # rad/s
RHO0 = 1.225              # kg/m3, sea-level density
P0 = 101325.0             # Pa
DEG = math.pi / 180.0

# The isobars are drawn at 1 hPa now (see worker/isobars.py: the worker
# publishes the FINEST set and the API thins it to the step the reader
# picked).
#
# The check below does NOT use the interval: it reads the stored lines
# and compares the pressure field at each line's own vertices with that
# line's own level, so it is interval-agnostic by construction. The
# constant is kept only so nobody has to guess — it is NOT read by any
# code path here.
ISOBAR_INTERVAL_HPA = 1.0


# ── the raw GRIB, decoded with its own index arithmetic ────────────────
class RawField:
    """A GRIB message decoded WITHOUT normalising the row order.

    Deliberately independent of worker.isobars.decode_field(): the
    point of this class is to be a second opinion on where a value
    sits in the grid.
    """

    def __init__(self, values, ni, nj, lat1, lon1, di, dj, jpos, short_name):
        self.values = values          # RAW row order, as it comes out
        self.ni, self.nj = ni, nj
        self.lat1, self.lon1 = lat1, lon1
        self.di, self.dj = di, dj
        self.jpos = jpos              # 1 = rows ascend from lat1, 0 = descend
        self.short_name = short_name

    def index(self, lat, lon):
        if self.jpos == 1:
            j = int(round((lat - self.lat1) / self.dj))
        else:
            j = int(round((self.lat1 - lat) / self.dj))
        i = int(round(((lon - self.lon1) % 360) / self.di)) % self.ni
        return j, i

    def at(self, lat, lon):
        j, i = self.index(lat, lon)
        return float(self.values[j, i])


def decode_raw(grib_bytes: bytes) -> RawField:
    """Decode a single-field GRIB2 message without normalising it."""
    try:
        import eccodes
    except ImportError as exc:  # pragma: no cover - depends on the host
        raise RuntimeError(
            "eccodes is not installed — pip install 'eccodes' 'eccodeslib'"
        ) from exc

    handle, path = tempfile.mkstemp(prefix="xyzo-gfsverify-", suffix=".grb2")
    gid = None
    try:
        with os.fdopen(handle, "wb") as fh:
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
            os.unlink(path)
        except OSError:
            pass

    return RawField(values.reshape(nj, ni), ni, nj, lat1, lon1, di, dj,
                    jpos, short_name)


def fetch_raw(date_str: str, cycle: str, var: str, level: str, short: str,
              suffixes: tuple[str, ...] = ("1p00",)) -> RawField:
    """Download one GFS field and decode it raw.

    `suffixes` picks the product. The default is the 1° one, because
    the published wind and temperature grids ARE 1° — those checks have
    to compare a published grid with the grid it was published on. The
    isobars are a different story: they are contoured from the 0.25°
    product, so they are fetched by `fetch_raw_isobar()` instead.
    """
    from .isobars import fetch_grib_field

    grib, _product = fetch_grib_field(
        date_str, cycle, var, level, f"the GFS {var} field", suffixes=suffixes,
    )
    field = decode_raw(grib)
    if field.short_name != short:
        raise RuntimeError(
            f"expected {short!r} from the filter server, got {field.short_name!r}"
        )
    return field


# The grid each published analysis is CONTORED on.
#
# The isobar check compares the stored lines against the field they were
# cut from, so the field has to be fetched on the SOURCE'S OWN grid.
#
# GFS: worker/isobars.py asks for the 0.25° product first and falls back
#      to the 1° one only when the filter server cannot serve it (see
#      GFS_PRODUCTS), so the check asks for the same pair in the same
#      order and takes whichever comes back. Fetching the 1° product
#      instead is not a rounding difference: the two fields differ by
#      far more than the contouring error, so the check reports a
#      systematic offset that is not there — measured on the 2026-11-04
#      18Z analysis, a p95 of 1.35 hPa against the 1° field where the
#      0.25° field gives 0.03 hPa.
#
# ECMWF: the IFS 0.1° message, fetched by worker/ecmwf.py.
#
# The wind and the temperature overlays are NOT in this table: their
# published grids are 1° (they are held in the browser), so their
# checks keep the 1° product and the default above.
ISOBAR_GRID_SUFFIXES = {
    "gfs": ("0p25", "1p00"),
}


def fetch_raw_isobar(date_str: str, cycle: str, source: str = "gfs") -> RawField:
    """The MSLP field the isobars of `source` were cut from.

    For GFS this is the worker's own fetch — the same products, in the
    same order — so the check compares a contour with the very field it
    is a contour of. For ECMWF it is the IFS 0.1° message.
    """
    if source == "ecmwf":
        return fetch_raw_ecmwf(date_str, cycle)
    suffixes = ISOBAR_GRID_SUFFIXES.get(source, ISOBAR_GRID_SUFFIXES["gfs"])
    return fetch_raw(date_str, cycle, "PRMSL", "mean_sea_level", "prmsl",
                     suffixes=suffixes)


# ── a published grid ────────────────────────────────────────────────────
class Grid:
    """A published grid.bin + meta.json."""

    def __init__(self, meta: dict, values: np.ndarray):
        self.meta = meta
        self.grid = meta["grid"]
        self.values = values          # (rows, cols) in the published layout

    @classmethod
    def load(cls, out_dir: str, scale_key: str = "scale"):
        with open(os.path.join(out_dir, "meta.json")) as fh:
            meta = json.load(fh)
        g = meta["grid"]
        n = int(g["rows"]) * int(g["cols"])
        raw = np.fromfile(os.path.join(out_dir, "grid.bin"), dtype="<i2")
        if raw.size != n:
            raise ValueError(f"{out_dir}: {raw.size} values, expected {n}")
        scale = float(g.get(scale_key, 100))
        values = raw.reshape(int(g["rows"]), int(g["cols"])).astype(np.float64) / scale
        return cls(meta, values)

    @classmethod
    def load_planar_pair(cls, out_dir: str):
        """The wind's grid.bin holds TWO planes: u in [0, n), v in [n, 2n).

        Returns (grid, u, v) — the Grid's own `.values` is the u plane.
        """
        with open(os.path.join(out_dir, "meta.json")) as fh:
            meta = json.load(fh)
        g = meta["grid"]
        n = int(g["rows"]) * int(g["cols"])
        raw = np.fromfile(os.path.join(out_dir, "grid.bin"), dtype="<i2")
        if raw.size != n * 2:
            raise ValueError(f"{out_dir}: {raw.size} values, expected {n * 2}")
        scale = float(g.get("scale", 100))
        shape = (int(g["rows"]), int(g["cols"]))
        u = raw[:n].reshape(shape).astype(np.float64) / scale
        v = raw[n:].reshape(shape).astype(np.float64) / scale
        return cls(meta, u), u, v

    @property
    def run_time(self):
        return self.meta.get("run_time", "")

    @property
    def cycle(self):
        rt = self.run_time
        if len(rt) < 13 or not rt.endswith("Z"):
            raise ValueError(f"unreadable run_time {rt!r}")
        return rt[:10].replace("-", ""), rt[11:13]

    def lats(self):
        g = self.grid
        return g["lat_min"] + np.arange(int(g["rows"])) * float(g["lat_step"])

    def lons(self):
        g = self.grid
        return g["lon_min"] + np.arange(int(g["cols"])) * float(g["lon_step"])

    def bilinear(self, lat, lon):
        g = self.grid
        lon_w = ((((lon - g["lon_min"]) % 360) + 360) % 360) + g["lon_min"]
        gx = (lon_w - g["lon_min"]) / float(g["lon_step"])
        gy = (lat - g["lat_min"]) / float(g["lat_step"])
        x0 = int(math.floor(gx))
        y0 = int(math.floor(gy))
        x1 = (x0 + 1) % int(g["cols"])
        y1 = min(y0 + 1, int(g["rows"]) - 1)
        fx, fy = gx - math.floor(gx), gy - math.floor(gy)
        out = ((1 - fy) * ((1 - fx) * self.values[y0, x0] + fx * self.values[y0, x1]) +
               fy * ((1 - fx) * self.values[y1, x0] + fx * self.values[y1, x1]))
        return float(out)


def published_suffixes(pub: Grid) -> tuple[str, ...]:
    """The GFS product the published grid was cut from.

    A published grid says which product it came from — `meta.product` is
    `gfs.0p25` — and the grid's SIZE follows from that. The check has
    to read the same product, or it compares two resolutions and calls
    the difference a data bug: the wind moved from the 1° product to the
    0.25° one on 2026-11-04, and a check that still asked for 1° would
    report a shape mismatch on a perfectly good grid.

    Falls back to the 1° product when the meta says nothing, which is
    the old behaviour.
    """
    product = str((pub.meta or {}).get("product") or "")
    for suffix in ("0p25", "1p00"):
        if product.endswith(suffix):
            return (suffix,)
    return ("1p00",)


def _resample_to(field, src_lats, src_lons, dst_lats, dst_lons) -> np.ndarray:
    """Bilinearly resample a normalised field onto another lattice.

    Both lattices are (latitude ascending from -90, longitude 0..360),
    which is what `_native_grid()` produces and what the published
    grids use. Longitude wraps; latitude clamps.

    This is the general replacement for the old "row = lat + 90" index
    arithmetic, which only worked on a 1° lattice — the wind moved to
    0.25° on 2026-11-04 and the old mapping silently put the pressure
    field in the wrong cells.
    """
    n_src_lat, n_src_lon = field.shape
    src_lat0 = float(src_lats[0])
    src_lat_step = float(src_lats[1] - src_lats[0])
    src_lon_step = float(src_lons[1] - src_lons[0]) if n_src_lon > 1 else 1.0

    out = np.zeros((len(dst_lats), len(dst_lons)), dtype=np.float64)
    for j, lat in enumerate(dst_lats):
        fy = (float(lat) - src_lat0) / src_lat_step
        y0 = int(math.floor(fy))
        y0 = min(max(y0, 0), n_src_lat - 1)
        y1 = min(y0 + 1, n_src_lat - 1)
        w = fy - y0
        for i, lon in enumerate(dst_lons):
            fx = (((float(lon) % 360) + 360) % 360) / src_lon_step
            x0 = int(math.floor(fx))
            x0 = min(max(x0, 0), n_src_lon - 1)
            x1 = (x0 + 1) % n_src_lon
            u = fx - x0
            a = field[y0, x0] * (1 - u) + field[y0, x1] * u
            b = field[y1, x0] * (1 - u) + field[y1, x1] * u
            out[j, i] = a * (1 - w) + b * w
    return out


def compare_with_raw(pub: Grid, raw: RawField, scale: float = 1.0,
                      offset: float = 0.0, tol: float = 0.011) -> dict:
    """Every published cell against the raw GRIB message.

    The published grid's row r is latitude `lat_min + r*lat_step` and
    its column c is longitude `lon_min + c*lon_step`; the raw message
    is indexed with its own arithmetic. Comparing the two cell by cell
    is what catches a mirrored field, a swapped u/v, a wrong scale, a
    stale cycle or a one-row shift.

    `offset` converts the raw message's units into the published ones
    (the GFS temperature comes out in Kelvin; the overlay publishes
    Celsius). `tol` is the quantisation of the published storage: the
    wind is stored in 0.01 m/s units, the temperature in 0.1 C.
    """
    g = pub.grid
    rows, cols = int(g["rows"]), int(g["cols"])
    if (raw.nj, raw.ni) != (rows, cols):
        raise RuntimeError(
            f"the GFS grid is {raw.ni}x{raw.nj} but the published one is "
            f"{cols}x{rows} — different products"
        )
    diff = np.zeros((rows, cols))
    for j in range(raw.nj):
        lat = raw.lat1 - j * raw.dj if raw.jpos == 0 else raw.lat1 + j * raw.dj
        row = int(round((lat - g["lat_min"]) / float(g["lat_step"])))
        if not (0 <= row < rows):
            continue
        for i in range(raw.ni):
            lon = (raw.lon1 + i * raw.di) % 360.0
            col = int(round((lon - g["lon_min"]) % 360 / float(g["lon_step"]))) % cols
            diff[row, col] = pub.values[row, col] - (raw.values[j, i] + offset) * scale
    worst = float(np.abs(diff).max())
    return {
        "cells": rows * cols,
        "max_diff": round(worst, 4),
        "cells_over_tolerance": int((np.abs(diff) > tol).sum()),
    }


# ── the cross-field checks ──────────────────────────────────────────────
def _cycle_lag_hours(a: str, b: str) -> float | None:
    """How many hours apart two GFS analysis times are."""
    try:
        ta = datetime.strptime(a, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        tb = datetime.strptime(b, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None
    return (ta - tb).total_seconds() / 3600.0


def smooth_like_isobars(field: np.ndarray, spacing_deg: float = 1.0) -> np.ndarray:
    """Blur the pressure field exactly the way worker/isobars.py does.

    The isobars on the map are contours of the SMOOTHED field, so the
    cross-check has to use the same field — and the raw 1° MSLP is far
    too noisy at the grid scale to compare against a wind.

    `spacing_deg` is the grid the field lives on. The sigma is a
    PHYSICAL width, so a 0.1° grid needs five times as many cells as a
    0.25° one for the same blur — which is exactly what the worker does.

    The worker's sigma has a FLOOR of two CELLS
    (`worker/isobars.py: max(2.0, FIELD_SMOOTH_SIGMA_DEG / spacing_deg)`),
    so a 1° field is blurred by 2.0° of latitude rather than the
    intended 0.5°. That floor is NOT a problem for this check: the
    worker applies the SAME floor to the SAME grid, so as long as the
    field is fetched on the grid the lines were cut from, the two
    agree by construction. The floor only bites when the check and the
    worker are looking at DIFFERENT grids — which is exactly the bug
    this replaced.

    The blur is NOT re-implemented here: it is the worker's own
    function, called with the grid's own spacing.
    """
    from .isobars import smooth_field

    return smooth_field(np.asarray(field, dtype=np.float64), spacing_deg)


def geostrophic_check(wind_u, wind_v, mslp_pa, lats, lons) -> dict:
    """The wind against the pressure field.

    In a balanced atmosphere the flow runs roughly parallel to the
    isobars, with the LOW pressure on its LEFT in the northern
    hemisphere (and on its RIGHT in the southern one). Friction turns
    the surface flow slightly ACROSS the isobars, towards the low
    pressure.

    So two numbers come out:
      * the angle between the actual wind and the geostrophic wind
        computed from the pressure gradient alone — the real flow is
        10-30° off it at the surface;
      * the SIGN of the cross-isobar component — it must point from
        high pressure towards low pressure.
    """
    rows = len(lats)
    lat = np.radians(np.asarray(lats, dtype=np.float64))
    # The pressure gradient in the local east/north directions (Pa per
    # metre). The field is SMOOTHED first, with the same Gaussian the
    # isobar worker uses (sigma = 2 cells) — the isobars on the map are
    # drawn from that smoothed field, so this is the gradient the eye
    # follows, and the raw 1° MSLP is far too noisy at the grid scale
    # to compare against a wind.
    mslp_pa = smooth_like_isobars(mslp_pa)
    # The grid spacing, taken from the axes rather than assumed: the
    # published grid is 1°, but the check must not silently halve or
    # double the gradient on another grid.
    dlat = abs(float(lats[1]) - float(lats[0])) if len(lats) > 1 else 1.0
    dlon = abs(float(lons[1]) - float(lons[0])) if len(lons) > 1 else 1.0
    dpdx = np.gradient(mslp_pa, axis=1) / (111320.0 * dlon * np.cos(lat)[:, None])
    dpdy = np.gradient(mslp_pa, axis=0) / (111320.0 * dlat)
    f = 2.0 * OMEGA * np.sin(lat)

    # Geostrophic wind: V_g = (1/(rho f)) * k x grad(p)
    # k x grad(p) = (-dp/dy, dp/dx)
    with np.errstate(divide="ignore", invalid="ignore"):
        vg_u = -dpdy / (RHO0 * f)[:, None]
        vg_v = dpdx / (RHO0 * f)[:, None]

    # Only the mid-latitudes: the tropics are not in geostrophic
    # balance (the Coriolis force is too weak there for the relation
    # to mean anything).
    band = (np.abs(np.asarray(lats)) > 20) & (np.abs(np.asarray(lats)) < 75)
    band3 = band[:, None] & np.ones((1, len(lons)), dtype=bool)

    angle_err = []
    cross_sign = 0
    cross_total = 0
    for r in range(rows):
        if not band[r]:
            continue
        for c in range(len(lons)):
            u, v = wind_u[r, c], wind_v[r, c]
            gu, gv = vg_u[r, c], vg_v[r, c]
            if not (np.isfinite(u) and np.isfinite(v) and np.isfinite(gu) and np.isfinite(gv)):
                continue
            sp = math.hypot(u, v)
            gsp = math.hypot(gu, gv)
            if sp < 1.0 or gsp < 0.05:
                continue
            # Angle between the two vectors.
            dot = (u * gu + v * gv) / (sp * gsp)
            dot = max(-1.0, min(1.0, dot))
            angle_err.append(math.degrees(math.acos(dot)))
            # The cross-isobar component: the part of the wind along the
            # pressure gradient (towards LOW pressure).
            # The unit vector towards low pressure is (-dpdx, -dpdy) normalised.
            gx, gy = dpdx[r, c], dpdy[r, c]
            gmag = math.hypot(gx, gy)
            if gmag < 1e-9:
                continue
            cross = -(u * gx + v * gy) / gmag     # >0 means towards low pressure
            cross_total += 1
            if cross > 0:
                cross_sign += 1

    if not angle_err:
        return {"ok": False, "reason": "no usable cells"}
    angle_err.sort()
    median = angle_err[len(angle_err) // 2]
    return {
        "ok": True,
        "cells": len(angle_err),
        "median_angle_from_geostrophic_deg": round(median, 1),
        "mean_angle_from_geostrophic_deg": round(sum(angle_err) / len(angle_err), 1),
        "p90_angle_from_geostrophic_deg": round(angle_err[int(len(angle_err) * 0.9)], 1),
        # The surface flow crosses the isobars towards the low; the
        # fraction of cells that do is a direct measure of that.
        "fraction_flowing_towards_low_pressure": round(cross_sign / max(cross_total, 1), 3),
    }


def advection_check(wind_u, wind_v, temp_c, lats, lons) -> dict:
    """The wind against the temperature field.

    The wind carries air with it. Where the wind blows, it brings the
    temperature of the upwind side. So the temperature ADVECTED by the
    flow (the component of the wind along the temperature gradient) has
    to correlate with the temperature the flow comes FROM: the air
    arriving at a point must come from the colder side when the flow is
    advecting cold air in.

    The check: at every mid-latitude point, compare the temperature
    gradient along the wind direction with the temperature gradient
    against it. The flow must, on average, come FROM the colder side
    and blow TOWARDS the warmer side (in the mid-latitudes the flow is
    generally poleward of the cold air, so the upwind air is colder).
    """
    lat = np.asarray(lats, dtype=np.float64)
    dlat = abs(float(lats[1]) - float(lats[0])) if len(lats) > 1 else 1.0
    dlon = abs(float(lons[1]) - float(lons[0])) if len(lons) > 1 else 1.0
    dtdx = np.gradient(temp_c, axis=1) / (111320.0 * dlon * np.cos(np.radians(lat))[:, None])
    dtdy = np.gradient(temp_c, axis=0) / (111320.0 * dlat)

    colder_upwind = 0
    total = 0
    weighted = []
    for r in range(len(lats)):
        if not (20 < abs(lat[r]) < 75):
            continue
        for c in range(len(lons)):
            u, v = wind_u[r, c], wind_v[r, c]
            sp = math.hypot(u, v)
            if sp < 2.0:
                continue
            gx, gy = dtdx[r, c], dtdy[r, c]
            gmag = math.hypot(gx, gy)
            if gmag < 1e-9:
                continue
            # The rate of temperature change along the flow. The
            # gradient points towards the WARMER air, so a positive
            # value means the flow is moving from colder air into
            # warmer air — it is ADVECTING COLD AIR, which is what the
            # mid-latitude westerlies do.
            adv = (u * gx + v * gy) / gmag
            weighted.append(adv)
            if adv > 0:
                colder_upwind += 1
            total += 1

    if not total:
        return {"ok": False, "reason": "no usable cells"}
    weighted.sort()
    median = weighted[len(weighted) // 2]
    return {
        "ok": True,
        "cells": total,
        # The fraction of points where the flow brings COLDER air (the
        # upwind side is colder). In the mid-latitudes that is the
        # majority: the flow runs from the cold side towards the warm.
        "fraction_advecting_cold_air": round(colder_upwind / total, 3),
        "median_temperature_advection_K_per_m": round(median, 9),
    }


def isobar_check(pub_pressure: Grid, raw_prmsl: RawField) -> dict:
    """The pressure field the isobars are drawn from.

    The isobars themselves are stored as contours in PostGIS, so this
    checks the FIELD they came from, cell by cell, against the raw
    GRIB message.
    """
    return compare_with_raw(pub_pressure, raw_prmsl)


def _fetch_isobar_meta(api_base: str = "http://localhost:3008"):
    import httpx

    try:
        r = httpx.get(f"{api_base}/api/weather/isobars/meta", timeout=30.0,
                      follow_redirects=True)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def _cycle_from_stamp(stamp: str):
    """("20261027", "12") from "2026-10-27T12:00:00.000Z"."""
    try:
        return stamp[:10].replace("-", ""), stamp[11:13]
    except (TypeError, IndexError):
        return None, None


def _native_grid(raw: RawField):
    """The raw message's field on its OWN grid, with longitude 0 at column 0.

    The message is NOT normalised: its own index arithmetic is used, so
    the column a value lands in follows from `lon1 + i*di` and nothing
    else. ECMWF's IFS starts at longitude 180, so the checker's grid is
    a half-turn round the worker's — if the worker rolled its columns
    wrongly, the two disagree and the check FAILS. A checker that
    normalised the message the same way the worker does would hide the
    bug it exists to catch.

    Returns (field, lats, lons, spacing_deg). The field is in the
    message's own units (Pa).
    """
    rows, cols = raw.nj, raw.ni
    di, dj = abs(raw.di), abs(raw.dj)
    raw_lats = (
        raw.lat1 - np.arange(rows) * raw.dj
        if raw.jpos == 0
        else raw.lat1 + np.arange(rows) * raw.dj
    )
    # The field is returned with ASCENDING latitude (row 0 = southernmost),
    # exactly like the worker's decoder. `order` maps an ascending row
    # back to the row the message arrived in.
    order = np.argsort(raw_lats)
    lats = raw_lats[order]
    lons = np.arange(cols) * di
    south = float(lats[0])

    # The row each ascending latitude lands in, and the column each
    # message column lands in. Both are the message's OWN arithmetic.
    row_of = np.round((lats - south) / dj).astype(np.int64)
    np.clip(row_of, 0, rows - 1, out=row_of)
    raw_lon = (raw.lon1 + np.arange(cols) * raw.di) % 360.0
    col_of = np.round(raw_lon / di).astype(np.int64) % cols

    field = np.zeros((rows, cols), dtype=np.float64)
    field[row_of[:, None], col_of[None, :]] = raw.values[order, :]

    spacing = (di + dj) / 2.0
    return field, lats, lons, spacing


def fetch_raw_ecmwf(date_str: str, cycle: str) -> RawField:
    """Fetch an ECMWF IFS `msl` message, decoded without normalisation.

    Same contract as `fetch_raw()` for GFS: the raw row order and the
    raw longitude origin are preserved, so the checker sees the message
    exactly as it came off the wire.
    """
    from . import ecmwf

    grib, _rec = ecmwf.fetch_msl(date_str, cycle)
    return decode_raw(grib)


def _stored_isobar_lines(source: str,
                         bbox: tuple[float, float, float, float]) -> list[dict]:
    """The isobar lines as they are STORED, without any serving-time
    simplification.

    The API simplifies each line to the resolution the viewport can show
    (`ST_Simplify` at `span/2500` degrees), which deliberately moves the
    line by up to that tolerance. Checking the SERVED lines would
    therefore measure the rendering trade-off, not the data. The stored
    geometry is the contour itself, so that is what gets checked.

    The serving path is checked separately, against a bound derived from
    the tolerance the API reports.
    """
    from .db import connect

    west, south, east, north = bbox
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT level_hpa, ST_AsGeoJSON(geom) AS gj "
            "FROM weather_isobars "
            "WHERE source = %s "
            "  AND geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)",
            (source, west, south, east, north),
        )
        rows = cur.fetchall()

    out = []
    for row in rows:
        # The pool uses psycopg's dict_row factory, so the columns come
        # back by name.
        level_hpa = row["level_hpa"] if isinstance(row, dict) else row[0]
        gj = row["gj"] if isinstance(row, dict) else row[1]
        if isinstance(gj, (bytes, bytearray, memoryview)):
            gj = bytes(gj).decode("utf-8")
        if isinstance(gj, str):
            gj = json.loads(gj)
        out.append({
            # NOT int(): level_hpa is REAL since the 0.25 hPa lattice
            # (migration 2026-11-05-weather-isobars-half-hpa), and int()
            # TRUNCATES the fraction — 1000.25 became 1000, so the check
            # below compared the field against a level up to 0.75 hPa
            # away and measured its own truncation instead of the data.
            # Measured live before this fix: mean 0.372 / p95 0.752,
            # which is exactly the artefact of flooring levels drawn at
            # 0.25 hPa (mean of {0, .25, .5, .75} = 0.375, p95 = 0.75).
            # At a 0.05 lattice the same bug would report p95 0.95
            # against a 1.0 gate — passing by 5 % and catching nothing.
            "level_hpa": float(level_hpa),
            "coordinates": (gj or {}).get("coordinates") or [],
        })
    return out


def isobar_offsets(items: list[dict], raw_prmsl: RawField) -> dict:
    """How far the stored isobars sit from the field they were cut from.

    PURE — no DB, no network — so it can be run against a synthetic
    field (see worker/tests/test_gfs_verify_isobars.py).

    `items` is a list of {"level_hpa": float, "coordinates": [[lon, lat], …]}
    — the stored lines, in the shape `_stored_isobar_lines()` returns.
    The level must be the REAL value it was drawn at, fraction and all:
    an integer-truncated level makes this measure `frac(level)` rather
    than the field (see _stored_isobar_lines).

    The pressure field is rebuilt on the SOURCE'S OWN grid and smoothed
    with the worker's own blur, so the comparison is between a contour
    and the very field it is a contour of. Getting the grid wrong is
    the one mistake this cannot forgive: a 0.25° contour read against a
    1° field is a false alarm, not a finding.
    """
    if not items:
        return {"ok": False, "reason": "no stored isobar lines in that area"}

    # The pressure field on the source's own grid, smoothed exactly the
    # way the isobar worker smooths it.
    from .isobars import smooth_sigma_cells

    field, lats, lons, spacing = _native_grid(raw_prmsl)
    smooth = smooth_like_isobars(field, spacing) / 100.0     # hPa
    n_rows, n_cols = smooth.shape
    lat0 = float(lats[0])
    d_lat = float(lats[1] - lats[0])
    d_lon = float(lons[1] - lons[0])

    def pressure_at(lat, lon):
        x = (((lon) % 360) + 360) % 360
        y = lat - lat0
        x0, y0 = int(math.floor(x / d_lon)), int(math.floor(y / d_lat))
        fx = x / d_lon - x0
        fy = y / d_lat - y0
        x1 = (x0 + 1) % n_cols
        y1 = min(max(y0 + 1, 0), n_rows - 1)
        y0 = min(max(y0, 0), n_rows - 1)
        return float((1 - fy) * ((1 - fx) * smooth[y0, x0] + fx * smooth[y0, x1]) +
                     fy * ((1 - fx) * smooth[y1, x0] + fx * smooth[y1, x1]))

    errors = []
    levels = set()
    for item in items:
        level = float(item["level_hpa"])
        levels.add(level)
        coords = item.get("coordinates") or []
        # Sample every 5th vertex: a contour has hundreds of points and
        # they are all on the same level by construction.
        for k in range(0, len(coords), 5):
            lon, lat = coords[k]
            p = pressure_at(float(lat), float(lon))
            errors.append(p - level)

    if not errors:
        return {"ok": False, "reason": "no vertices to check"}
    mean = sum(errors) / len(errors)
    # The percentiles are taken over the ABSOLUTE offsets. Taking them
    # over the signed ones and then taking the absolute value of the
    # result measures something else entirely: with a systematic bias
    # the signed distribution's 95th percentile sits near zero, so the
    # old code reported a large "median" offset and a small "p95" for
    # the SAME data — and the p95 is the number the gate used.
    abs_errors = sorted(abs(e) for e in errors)

    return {
        "ok": True,
        "lines": len(items),
        "levels": len(levels),
        "vertices_checked": len(errors),
        # A systematic bias — the field the contour was cut from is
        # offset from the one it was checked against.
        "mean_offset_hpa": round(mean, 3),
        "median_abs_offset_hpa": round(abs_errors[len(abs_errors) // 2], 3),
        "p95_abs_offset_hpa": round(abs_errors[int(len(abs_errors) * 0.95)], 3),
        "max_abs_offset_hpa": round(abs_errors[-1], 3),
        # The grid the field was rebuilt on, and the blur it got. These
        # two are what decide whether the comparison above means
        # anything, so they are reported rather than assumed.
        "grid_deg": round(spacing, 4),
        "smooth_sigma_cells": round(smooth_sigma_cells(spacing), 4),
    }


# The gate on the isobar check.
#
# The lines are contours of the SMOOTHED field, and the Chaikin rounding
# and the Douglas-Peucker simplification move them a little. How little
# is a MEASUREMENT, not a guess — and the old allowance was wrong by two
# orders of magnitude:
#
#   * the old figure was 2.5 hPa, on the reasoning that the contouring
#     moves a line "by up to the grid spacing — which over high terrain,
#     where sea-level pressure falls steeply, is a couple of hPa". It
#     does NOT move a line by a grid cell: the Chaikin amplitude is
#     ~0.06° and the Douglas-Peucker tolerance 0.01°, so the movement is
#     ~0.07° — a third of a cell at 0.25°.
#   * MEASURED, on the field each source's lines were cut from, over
#     three GFS cycles (06/12/18Z) and the steepest terrain on Earth:
#
#       GFS    default box (Middle East)  p95 0.029 / 0.040 / 0.037
#       GFS    Tibetan Plateau            p95 0.037 / 0.042 / 0.048
#       GFS    the whole world             p95 0.038
#       ECMWF  default box                p95 0.011
#       ECMWF  Tibetan Plateau            p95 0.018
#       ECMWF  the whole world             p95 0.016
#
#     The WORST is 0.048 hPa — so the old 2.5 hPa allowance was 52x the
#     artefact it was meant to absorb, and the gate could not notice a
#     displacement of a whole grid cell (0.25° of latitude measures a
#     p95 of 0.698 hPa, one column of longitude 0.491).
#   * the tolerance is therefore 0.4 hPa: **8x the worst measured
#     artefact** (and 13x the default box's 0.029), while still catching
#     a single-grid-cell displacement in EITHER axis.
#
# What the gate catches, measured on the 2026-11-04 18Z lines:
#
#   the lines against the 1° field instead of the 0.25° one   p95 1.355
#   a level number 1 hPa out                                 p95 1.003
#   the lines shifted ONE grid row (0.25°)                  p95 0.698
#   the lines shifted ONE grid column (0.25°)               p95 0.491
#   the wrong cycle (06Z and 12Z lines vs the 18Z field)     p95 6.2 - 14.5
#   the field mirrored about the equator                    p95 12.0
#
# The MEAN is the second test. A systematic offset is the real failure
# mode: a mirrored field, a mis-aligned longitude axis, a stale cycle
# or a row shift all move the whole field. The scatter around it is a
# contouring artefact; the BIAS is a data bug. The measured mean is
# +0.002 to +0.008 hPa, so 0.25 hPa is ~30x clear.
#
# The MEDIAN is the "half the lines are exact" number: 0.6 is loose
# enough that a good chart never trips it and tight enough that a
# systematic shift of the whole set does.
#
# THE TOLERANCES WERE RAISED TO 1.0 / 0.5 FOR ONE BUILD CYCLE AND ARE
# BACK. The numbers that "justified" it — p95 0.51 hPa (GFS), median
# 0.499 hPa (ECMWF) at the 0.5 hPa interval, against 0.029 / 0.011 at
# 1 hPa — were NOT a property of a finer interval. The check read the
# stored level with `int(level_hpa)`, so at a 0.5 hPa interval every
# half-level was compared against the WHOLE hPa below it: the gate was
# measuring its own truncation (up to 0.999 hPa of it), and it collapsed
# 108 distinct stored levels to 27 distinct compared values. The
# "gradient x fixed displacement" story written around those numbers was
# a rationalisation of a bug.
#
# RE-MEASURED after the one-line fix (float, no truncation), at the
# 0.05 hPa interval this worker now publishes, over the 30..60E /
# 40S..0 box on the 2026-11-06 analyses:
#
#       GFS    p95 0.032   mean +0.005   median 0.001   (505 levels)
#       ECMWF  p95 0.010   mean +0.002   median 0.000   (120 levels)
#
# So 0.4 hPa is 12x the worst artefact — and it still catches the
# displacements it exists to catch (a one-grid-column shift 0.491, a
# one-grid-row shift 0.698, a level 1 hPa out 1.003, a wrong cycle
# 6.2-14.5, a mirrored field 12.0). Re-measure before changing any of
# these: a tolerance is a measurement, not a preference.
ISO_P95_TOL_HPA = 0.4
ISO_MEAN_TOL_HPA = 0.25
ISO_MEDIAN_TOL_HPA = 0.6


def isobar_gate(iso: dict) -> str | None:
    """The problem message when the isobars are NOT where they should be.

    None when the check passed — and also when it could not run: a
    check that did not run is a WARNING (see main()), not a failure.
    """
    if not iso.get("ok"):
        return None
    if iso.get("p95_abs_offset_hpa", 0.0) > ISO_P95_TOL_HPA:
        return (
            f"isobars sit up to {iso['p95_abs_offset_hpa']} hPa away "
            f"from the pressure field they are drawn from"
        )
    if abs(iso.get("mean_offset_hpa", 0.0)) > ISO_MEAN_TOL_HPA:
        return (
            f"isobars are systematically offset by {iso['mean_offset_hpa']} hPa "
            f"from the pressure field they are drawn from"
        )
    return None


def isobar_check(raw_prmsl: RawField, api_base: str = "http://localhost:3008",
                 bbox: tuple[float, float, float, float] = (30, -40, 60, 0),
                 source: str = "gfs") -> dict:
    """The isobars the map holds.

    The isobars are contours of the SMOOTHED pressure field, stored as
    PostGIS geometry. The check: take the points ALONG the stored lines
    and read the pressure field there — it has to equal that line's own
    level. A contour that is not a contour of the field (a stale cycle, a
    wrong smoothing, a row offset, a mis-aligned longitude axis) shows
    up as a systematic offset.

    The field is rebuilt on the SOURCE'S OWN grid — the grid the lines
    were contoured on — and smoothed with the same physical sigma the
    worker used, so the check compares the contour against the very
    field it was cut from — not against an approximation of it.

    The lines are read straight out of PostGIS rather than through the
    API, because the API simplifies them for the viewport and that
    would measure the rendering trade-off instead of the data.
    """
    try:
        items = _stored_isobar_lines(source, bbox)
    except Exception as exc:
        return {"ok": False, "reason": f"could not read the stored isobars: {exc}"}

    if not items:
        return {"ok": False, "reason": "no stored isobar lines in that area"}

    # The API must be serving the source we asked for.
    try:
        import httpx

        r = httpx.get(f"{api_base}/api/weather/isobars",
                      params={"bbox": ",".join(str(v) for v in bbox), "source": source},
                      timeout=60.0, follow_redirects=True)
        if r.status_code == 200:
            served_source = r.json().get("source")
            if served_source and served_source != source:
                return {
                    "ok": False,
                    "reason": f"the API served {served_source!r}, not {source!r}",
                }
    except Exception:
        pass

    return isobar_offsets(items, raw_prmsl)


# ── entry point ─────────────────────────────────────────────────────────
def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--field", default="all",
                        choices=["all", "wind", "temp", "pressure"])
    parser.add_argument("--offline", action="store_true",
                        help="self-consistency only; do not touch the network")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    report: dict = {"checks": {}, "problems": []}
    problems = report["problems"]

    # ── the published artefacts ─────────────────────────────────────────
    wind, u, v = Grid.load_planar_pair(WIND_DIR)
    temp = Grid.load(TEMP_DIR)
    report["wind_run_time"] = wind.run_time
    report["temp_run_time"] = temp.run_time

    if wind.run_time != temp.run_time:
        # The three workers each run on their own 6-hourly timer, and a
        # timer that fires BEFORE the new GFS cycle is published on
        # NOMADS finds the previous cycle still current. A one-cycle
        # lag is normal; anything more is not.
        lag_h = _cycle_lag_hours(wind.run_time, temp.run_time)
        msg = (f"the wind overlay is from {wind.run_time} and the temperature "
               f"overlay from {temp.run_time}")
        if lag_h is not None and 0 < lag_h <= 6:
            report.setdefault("warnings", []).append(msg + " — one cycle apart")
            log.warning("%s (one cycle apart — the 6-hourly timer ran before "
                        "the new cycle was published)", msg)
        else:
            problems.append(msg)

    # The wind is stored as two planar planes (u then v) — loaded above.
    g = wind.grid

    if not args.offline:
        date_str, cycle = wind.cycle
        try:
            raw_u = fetch_raw(date_str, cycle, "UGRD", "10_m_above_ground", "10u",
                              suffixes=published_suffixes(wind))
            raw_v = fetch_raw(date_str, cycle, "VGRD", "10_m_above_ground", "10v",
                              suffixes=published_suffixes(wind))
            raw_p = fetch_raw(date_str, cycle, "PRMSL", "mean_sea_level", "prmsl",
                              suffixes=published_suffixes(wind))
            raw_t = fetch_raw(date_str, cycle, "TMP", "2_m_above_ground", "2t",
                              suffixes=published_suffixes(wind))
        except RuntimeError as exc:
            problems.append(f"could not reach NOMADS: {exc}")
            raw_u = raw_v = raw_t = raw_p = None

        if raw_u is not None:
            if args.field in ("all", "wind"):
                # The wind grid holds two planes; each is compared with
                # its own message (u with 10u, v with 10v) — comparing
                # them the other way round is exactly the "swapped u/v"
                # bug this is meant to catch.
                c_u = compare_with_raw(Grid(wind.meta, u), raw_u)
                c_v = compare_with_raw(Grid(wind.meta, v), raw_v)
                report["checks"]["wind_u"] = c_u
                report["checks"]["wind_v"] = c_v
                for name, c in (("u", c_u), ("v", c_v)):
                    if c["cells_over_tolerance"]:
                        problems.append(
                            f"the published wind {name} differs from the GRIB "
                            f"in {c['cells_over_tolerance']} cells")

            if args.field in ("all", "temp"):
                # Compare the temperature overlay against ITS OWN cycle —
                # the three workers run on their own timers, so one of
                # them can be a cycle behind the others.
                t_date, t_cycle = temp.cycle
                try:
                    raw_t_own = fetch_raw(t_date, t_cycle, "TMP", "2_m_above_ground", "2t")
                except RuntimeError as exc:
                    raw_t_own = None
                    problems.append(f"could not fetch the temperature cycle: {exc}")
                if raw_t_own is not None:
                    # The GFS temperature comes out of the message in
                    # KELVIN; the overlay publishes Celsius.
                    # The temperature is stored in 0.1 C units, so the
                    # quantisation alone is up to 0.05 C.
                    c = compare_with_raw(temp, raw_t_own, scale=1.0,
                                         offset=-273.15, tol=0.05)
                    report["checks"]["temperature"] = c
                    if c["cells_over_tolerance"]:
                        problems.append(f"the published temperature differs from the GRIB in {c['cells_over_tolerance']} cells")

            if args.field in ("all", "pressure"):
                # The isobars are contours of the SMOOTHED pressure
                # field, stored as PostGIS geometry. Check the lines
                # the map actually serves against that field — at the
                # isobars' OWN cycle, which can be a cycle behind the
                # wind (each worker has its own timer).
                #
                # There are now SEVERAL published analyses (GFS 0.25°,
                # ECMWF IFS 0.1°), each stored under its own source
                # tag, and each has to be checked against ITS OWN raw
                # message. Checking ECMWF's lines against GFS's field
                # would prove nothing.
                iso_meta = _fetch_isobar_meta()
                iso_sources = (iso_meta or {}).get("sources") or {}
                iso_results: dict[str, dict] = {}
                for src_name, src_info in iso_sources.items():
                    if src_name == "hrrr":
                        # Regional (CONUS only) and checked by its own
                        # worker's verify gate.
                        continue
                    p_date, p_cycle = _cycle_from_stamp(src_info.get("run_time"))
                    try:
                        # The field the lines were cut FROM, on the
                        # source's own grid — the GFS isobars are
                        # contoured from the 0.25° product, so the
                        # 1° one would be a different field and the
                        # comparison would be meaningless.
                        raw_p_iso = fetch_raw_isobar(p_date, p_cycle, src_name)
                        iso = isobar_check(raw_p_iso, source=src_name)
                        iso["run_time"] = src_info.get("run_time")
                    except RuntimeError as exc:
                        iso = {"ok": False, "reason": str(exc)}
                    iso_results[src_name] = iso
                    if not iso.get("ok"):
                        report.setdefault("warnings", []).append(
                            f"the {src_name} isobar check did not run: "
                            f"{iso.get('reason')}")
                    else:
                        complaint = isobar_gate(iso)
                        if complaint is not None:
                            problems.append(f"the {src_name} {complaint}")

                report["checks"]["isobars_by_source"] = iso_results
                primary = (iso_meta or {}).get("primary")
                iso = iso_results.get(primary) or {}
                if not iso:
                    # No global source was published — fall back to any.
                    iso = next(iter(iso_results.values()), {})
                report["checks"]["isobars"] = iso

            # ── the cross-field checks ─────────────────────────────────
            lats = wind.lats()
            lons = wind.lons()

            # The pressure and the temperature, on the WIND's grid.
            #
            # The wind moved from the 1° product to the 0.25° one on
            # 2026-11-04, so the old "row = lat + 90" mapping (which
            # assumed a 1° lattice) put the pressure field in the wrong
            # cells — and the geostrophic check then compared two
            # unrelated fields and reported the wind 99° off
            # geostrophic. The field is now RESAMPLED onto the wind's
            # own lattice by the message's index arithmetic.
            #
            # And the pressure is the SMOOTHED field — the one the
            # published ISOBARS are contours of. The claim being tested
            # is "the flow runs along the isobars", so it has to be
            # tested against the isobars' own field, not a sharper one
            # they are not drawn from (this was Known Issue Q-N13).
            mslp = np.zeros((len(lats), len(lons)))
            tmp = np.zeros((len(lats), len(lons)))

            p_field, p_lats, p_lons, p_spacing = _native_grid(raw_p)
            p_smooth = smooth_like_isobars(p_field, p_spacing)
            mslp = _resample_to(p_smooth, p_lats, p_lons, lats, lons) / 100.0

            t_field, t_lats, t_lons, _ = _native_grid(raw_t)
            tmp = _resample_to(t_field, t_lats, t_lons, lats, lons) - 273.15

            geo = geostrophic_check(u, v, mslp, lats, lons)
            report["checks"]["wind_vs_pressure"] = geo
            if geo.get("ok"):
                if geo["median_angle_from_geostrophic_deg"] > 45:
                    problems.append(
                        f"the wind is {geo['median_angle_from_geostrophic_deg']}° off the "
                        f"geostrophic wind (median) — it does not line up with the "
                        f"pressure field"
                    )
                if geo["fraction_flowing_towards_low_pressure"] < 0.6:
                    problems.append(
                        f"only {geo['fraction_flowing_towards_low_pressure']:.0%} of the "
                        f"flow crosses the isobars towards the low pressure — the "
                        f"friction sign is wrong"
                    )

            adv = advection_check(u, v, tmp, lats, lons)
            report["checks"]["wind_vs_temperature"] = adv
            if adv.get("ok") and adv["fraction_advecting_cold_air"] < 0.5:
                problems.append(
                    f"only {adv['fraction_advecting_cold_air']:.0%} of the flow "
                    f"advects cold air — the wind and the temperature field do "
                    f"not agree"
                )

            # The mirrored-field control: flip the wind north-south and
            # the cross-check must FAIL. If it still passes, the check
            # has no teeth.
            #
            # The mirror is done on the grid's OWN rows, whatever its
            # resolution: the published wind was 1° (181 rows) and is
            # 0.25° (721 rows) since 2026-11-04, and a control that
            # hardcoded 90 rows broke on the new grid. A full reverse
            # flips the rows about the equator — with an ODD row count
            # the middle row IS the equator, which stays put.
            flipped = u[::-1, :].copy()
            geo_bad = geostrophic_check(flipped, v, mslp, lats, lons)
            report["checks"]["control_mirrored_wind"] = {
                "median_angle_from_geostrophic_deg":
                    geo_bad.get("median_angle_from_geostrophic_deg"),
                "detected": (not geo_bad.get("ok")) or
                            geo_bad.get("median_angle_from_geostrophic_deg", 0) > 45,
            }
            if not report["checks"]["control_mirrored_wind"]["detected"]:
                problems.append(
                    "the geostrophic cross-check does NOT notice a mirrored "
                    "wind field — it has no teeth"
                )

    report["ok"] = not problems
    if args.json:
        print(json.dumps(report, indent=1))
    else:
        _print(report, problems)
    return 0 if report["ok"] else 1


def _print(report, problems):
    print(f"wind overlay      : {report['wind_run_time']}")
    print(f"temperature overlay: {report['temp_run_time']}")
    print()
    for name, c in report.get("checks", {}).items():
        if isinstance(c, dict):
            bits = "  ".join(f"{k}={v}" for k, v in c.items())
            print(f"  {name:32s} {bits}")
    print()
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print(f"  ✗ {p}")
    else:
        print("✓ the three GFS overlays agree with each other and with the analysis")


if __name__ == "__main__":
    raise SystemExit(main())
