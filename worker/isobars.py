#!/usr/bin/env python3
"""Build isobar (pressure contour) lines from global pressure analyses.

The map's "⛅ Pressure lines" layer draws the isobars — the lines of equal
mean sea-level pressure that every synoptic chart is built from. There is
no free isobar *tile* service, so the lines are computed here and served
from PostGIS.

Two sources are built and stored side by side, each tagged in the
`source` column of `weather_isobars`:

    "ecmwf"  ECMWF IFS open data, mean sea-level pressure, 0.1° global.
             CC BY 4.0 (commercial use permitted), NO key, no login.
             The finer grid — 2.5x the resolution of GFS.
             https://data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p1/oper/

    "gfs"    NOAA NCEP GFS analysis, PRMSL (mean sea-level pressure),
             0.25° global. US Government work — public domain.
             The FRESHER analysis (it lands ~3.5 h after the run; ECMWF
             takes ~8.5 h).
             https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/

The API picks whichever analysis is actually newer for the viewport, so
the layer is never stuck on a stale cycle just because the finer source
publishes late.

Decoding uses ECMWF's `eccodes` bindings (pip package `eccodes` +
`eccodeslib`); both ship manylinux wheels, so there is nothing to compile.
If eccodes is missing the worker logs and exits 0 — a missing optional
dependency must never take down the timer.

Usage:
    python -m worker.isobars              # build every source, store
    python -m worker.isobars --dry-run    # fetch + contour, print stats only
    python -m worker.isobars --source ecmwf   # only the ECMWF source
    python -m worker.isobars --run 2026102518   # force a specific cycle
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Iterable, Sequence

# IMPORTANT: import the database driver BEFORE eccodes.
#
# eccodes (via gribapi) loads its native library through CFFI, and
# psycopg loads libpq. When eccodes is imported first, the interpreter
# tears the two down in an order that segfaults: the work completes and
# the data is written, but the process dies with SIGSEGV, so systemd
# records the run as a failure. Importing psycopg first keeps the
# teardown clean. worker.db imports psycopg at module level, so this
# single import below is enough to fix the order for the whole process.
from .db import connect  # noqa: F401  (import order — see above)

log = logging.getLogger("xyzo.isobars")

# ── Source configuration ────────────────────────────────────────────────
NOMADS_PROD = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
FILTER_SERVER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_{suffix}.pl"

# GFS analysis cycles run every 6 h (00/06/12/18Z). The 00Z analysis
# only lands around 04:30Z, so a cycle that has not been published yet
# simply fails the HEAD probe and the previous one is used.

# The GFS products, finest first. 0.25° is 16x the area of 1° and its
# contour vertices sit 4x closer together in each direction, which is
# what stops the isobars from looking like 1° staircases. The 1° product
# is the fallback when the filter server cannot serve the finer one.
GFS_PRODUCTS = (
    # (file suffix, filter script suffix, full-product size)
    ("0p25", "0p25", "505 MB"),
    ("1p00", "1p00", "42 MB"),
)
GFS_FILE = "gfs.t{cycle}z.pgrb2.{suffix}.f000"

# Isobar interval in hPa — the PUBLISHED LATTICE, not the classic
# chart's step. 4 hPa is the synoptic-chart standard; we cut the field
# far finer than that and let the UI thin ONE set down to whichever step
# the reader picks, so "more detail" and "less detail" are two ends of
# one control instead of two datasets to keep in step.
#
# THE INVARIANT: every step the detail switch offers must be a whole
# multiple of this constant. The ladder is 0.1 / 0.25 / 0.5 / 1 / 2 / 4
# / 8 / 16 hPa, and 0.05 is exactly their GCD (0.1 = 2x0.05, 0.25 =
# 5x0.05, 0.5 = 10x0.05, 1 = 20x0.05, ...), so this one lattice is a
# SUPERSET of every chip's — one dataset at many densities, and thinning
# it down is exact rather than approximate. A finer interval is always
# safe; a coarser one
# silently empties a chip — asking for step=0.1 against a 0.25 lattice
# returns only every 0.5 hPa line while the chip claims 0.10. The
# isobar-step test reads STEP_CHOICES out of the JS and this constant
# out of here and checks they still agree.
#
# WHY ONE UNIFORM INTERVAL and not the cheaper cut: the published set
# could also be the union of the 0.1 and 0.25 lattices — 12 levels per
# hPa instead of this lattice's 20, i.e. 40 % less contouring, because
# 8 of every 20 levels here are unreachable by any current chip. It is
# not worth it. `weather_isobars_build.interval_hpa` is ONE number and
# the no-op guard compares it (see store_isobars), so the cut has to be
# fully described by that number or a rebuild gets skipped. Recording
# 0.05 for a partial lattice would make a later, genuine 0.05 cut look
# already-published — the exact "the finer set never shipped" trap. The
# 40 % is the price of a build record that tells the truth.
#
# WHY THINNING IS EXACT: the contour of one specific level (say 1000
# hPa) does not depend on the interval used to enumerate the levels —
# only on the field. So level 1000 contoured at 0.05 hPa is
# byte-identical to level 1000 contoured at 4 hPa, and filtering this
# set down to multiples of 4 reproduces the classic chart EXACTLY.
#
# COST, measured on the live 2026-11-06T18Z GFS 0.25° field, whole
# world: 0.25 hPa = 4,531 lines / 477 levels / 165 s; 0.1 hPa = 11,266
# / 1,192 / 417 s; 0.05 hPa = 22,544 / 2,385 / 835 s — linear in the
# levels at 0.346 / 0.350 / 0.350 s each. The three were timed in ONE
# process, so the last figure carries the first two lattices still in
# memory; a CLEAN build of the same field contours 0.05 in **679 s**
# and stores in 6 s — **11 m 26 s end to end**, about 4x the 0.25
# build's ~2.7 min. Contouring is linear in the levels, so the cost is
# a constant per level and nothing about the pipeline changed; ECMWF's
# 0.1° grid carries 6.25x the cells of GFS and 1.33x the levels, which
# is why it stays the slow one — MEASURED on the same day: **79 m 53 s**
# end to end for 20,368 lines / 2,264 levels (GFS: 11 m 26 s for
# 22,544 / 2,385), i.e. ~7x. Both builds are background work behind a
# no-op guard, so the cost is paid four times a day, not per reader.
#
# A FINER set is NOT a noisier chart — the noise lives in the FIELD,
# not in the choice of level. The Gaussian smoothing
# (FIELD_SMOOTH_SIGMA_DEG) takes the analysis-scale wobble out of the
# field BEFORE the contour is cut, so the finer set is the same chart
# with more lines in it. Measured on the 2026-11-02 12Z GFS analysis,
# the share of lines shorter than 20 degrees was 76.6 % at 2 hPa and
# 76.9 % at 1 hPa (under 5 degrees: 58.8 % against 59.1 %); measured on
# 2026-11-05 00Z it was 54.8 % at 1 hPa, 55.0 % at 0.5 and 54.8 % at
# 0.25 (under 5 degrees: 20.0 / 19.5 / 19.5 %), with the line count
# doubling each halving — 1,117 → 2,240 → 4,459. **And it holds all the
# way to 0.05: measured on 2026-11-06 18Z, 39.9 % at 0.25, 39.7 % at
# 0.1 and 39.7 % at 0.05 (under 5 degrees: 12.9 / 12.8 / 12.7 %) — flat
# across a five-times-finer cut.** If that share ever starts climbing,
# the smoothing is what broke, not the interval.
ISO_INTERVAL_HPA = 0.05

# Douglas-Peucker tolerance in degrees. It has to stay BELOW the
# amplitude the Chaikin rounding leaves behind, or the simplification
# undoes the smoothing and the staircase comes back. Chaikin(2) leaves
# ~0.06° of rounding, so 0.01° keeps it.
SIMPLIFY_TOL_DEG = 0.01

# Chaikin corner-cutting passes. Each pass replaces every segment with
# two shorter ones at 1/4 and 3/4, which rounds the grid-aligned
# corners without overshooting (a spline would).
SMOOTH_ITERATIONS = 2

# Minimum vertices for a contour to be worth storing. Two is the floor:
# a perfectly straight isobar is legitimately just two points.
MIN_LINE_POINTS = 2

# Below this length a contour is only kept when it is holding an isobar
# together (see filter_short_chains). Small fragments with no neighbours
# are noise, but a fragment that bridges a break in an otherwise
# continuous line must stay — dropping it makes the line visibly stop
# and start again.
MIN_LINE_LENGTH_DEG = 2.0

# How near an endpoint has to be for two chains to count as neighbours
# when deciding whether a short piece belongs to an isobar. Slightly
# more than a grid cell, because pieces often overlap rather than meet.
BRIDGE_TOL_DEG = 0.35

# Two pieces whose ends come within this distance belong to the same
# isobar and are merged into one line. One grid cell: the whole world
# collapses from ~5,000 pieces to ~250 continuous isobars, and the
# result is stable from 0.25° all the way to 1.0°.
MERGE_TOL_DEG = 0.25


# Gaussian smoothing of the pressure field BEFORE contouring, expressed in
# DEGREES so it means the same thing on every grid.
#
# The analysis carries structure well below synoptic scale; contouring it
# raw produces thousands of tiny fragments AND leaves the contour riding
# the analysis grid, which shows up as a visible staircase.
#
# The sigma used to be "2 grid cells", which was 0.5° on the 0.25° GFS
# grid but only 0.20° on ECMWF's 0.1° grid — the same number silently
# smoothing 2.5x less in physical terms, which turns a clean synoptic
# chart into a tangle of wiggles. It is now a physical width and the
# cell count is derived from the grid spacing.
FIELD_SMOOTH_SIGMA_DEG = 0.5

# The reference grid spacing the sigma was originally expressed against
# (the 0.25° GFS analysis). Kept so the smoothing of the 0.25° GFS
# source is bit-for-bit what it was before ECMWF arrived.
GFS_GRID_DEG = 0.25

# The polar rows are dropped before contouring. Every longitude on a
# pole row shares one latitude, so a contour that lands there becomes a
# perfectly straight line running along the pole.
LAT_LIMIT_DEG = 85.0


# ── Locating the newest GFS run ─────────────────────────────────────────
def _nomads_dirs(max_days_back: int = 3) -> Iterable[tuple[str, str]]:
    """Yield (YYYYMMDD, HH) directories newest first.

    The cycles are walked in true chronological order (every 6 h back from
    the most recent one). Ordering by day first would prefer today's 00Z
    over yesterday's 18Z — a 19-hour-old analysis over a 1-hour-old one.
    """
    now = datetime.now(timezone.utc)
    cycle_hour = (now.hour // 6) * 6
    current = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    for _ in range(max_days_back * 4 + 1):
        yield current.strftime("%Y%m%d"), current.strftime("%H")
        current -= timedelta(hours=6)


def find_latest_run(force_run: str | None = None) -> tuple[str, str] | None:
    """Return (YYYYMMDD, HH) of the newest GFS run that is actually on disk.

    The nominal cycle can be missing (NCEP republishes, cycles slip), so
    every candidate is probed with a HEAD request before it is accepted.
    """
    if force_run:
        # YYYYMMDDHH is 10 characters — GFS cycles are two digits
        # ("00", "06", "12", "18"). The old check asked for 9, so it
        # rejected the exact format every docstring advertises and made
        # `--run` unusable across isobars, tempmap and windmap. A 9-char
        # value is still accepted so an existing caller keeps working
        # (the trailing hour is then zero-padded by the caller).
        if len(force_run) not in (9, 10):
            raise ValueError("--run must be YYYYMMDDHH")
        return force_run[:8], force_run[8:]

    import httpx

    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        for date_str, cycle in _nomads_dirs():
            for suffix, _filter, _size in GFS_PRODUCTS:
                url = (f"{NOMADS_PROD}/gfs.{date_str}/{cycle}/atmos/"
                       f"{GFS_FILE.format(cycle=cycle, suffix=suffix)}")
                try:
                    resp = client.head(url)
                except Exception as exc:  # network hiccup — try the next cycle
                    log.debug("HEAD %s failed: %s", url, exc)
                    continue
                if resp.status_code == 200:
                    return date_str, cycle
    return None


def fetch_grib_field(
    date_str: str,
    cycle: str,
    var_name: str,
    level_name: str,
    purpose: str = "the field",
    suffixes: tuple[str, ...] | None = None,
) -> tuple[bytes, str]:
    """Download ONE field of a GFS analysis as GRIB2 bytes.

    Returns (grib_bytes, product_suffix).

    The filter server subsets the product to a single field, so a refresh
    costs one small request instead of the whole (up to 505 MB) file. If
    the fine 0.25° product cannot be served, the 1° product is used
    instead — the field is coarser but the caller still gets it.

    `suffixes` restricts which products are tried (default: all of
    `GFS_PRODUCTS`). The temperature overlay passes ("1p00",) because its
    grid is held in the browser and 0.25° would cost 720 KB gzipped
    instead of 67 KB.

    Shared by the pressure lines (`PRMSL` / `mean_sea_level`) and the
    temperature map (`TMP` / `2_m_above_ground`), so a second product
    costs no extra machinery.
    """
    import httpx

    rel = f"gfs.{date_str}/{cycle}/atmos"
    last_error = "no product tried"
    products = [
        (suf, filt, size) for (suf, filt, size) in GFS_PRODUCTS
        if suffixes is None or suf in suffixes
    ]
    if not products:
        raise ValueError(f"unknown GFS product suffixes: {suffixes}")

    with httpx.Client(timeout=300.0, follow_redirects=True) as client:
        for suffix, filter_suffix, size in products:
            params = {
                "file": GFS_FILE.format(cycle=cycle, suffix=suffix),
                f"lev_{level_name}": "1",
                f"var_{var_name}": "1",
                "dir": "/" + rel,
            }
            url = FILTER_SERVER.format(suffix=filter_suffix)
            try:
                resp = client.get(url, params=params)
                if resp.status_code == 200 and resp.content[:4] == b"GRIB":
                    log.info("filter server %s: %d bytes", suffix, len(resp.content))
                    return resp.content, suffix
                last_error = f"{suffix}: HTTP {resp.status_code}"
            except Exception as exc:
                last_error = f"{suffix}: {exc}"
            log.warning("filter server could not serve %s (%s)", suffix, last_error)

            # Last resort: the whole product. Only worth it for the 1°
            # file — the 0.25° one is 505 MB.
            if suffix == "1p00":
                full_url = f"{NOMADS_PROD}/{rel}/{GFS_FILE.format(cycle=cycle, suffix=suffix)}"
                log.info("downloading %s", full_url)
                resp = client.get(full_url)
                resp.raise_for_status()
                return resp.content, suffix

    raise RuntimeError(f"could not fetch {purpose} ({last_error})")


def fetch_grib_fields(
    date_str: str,
    cycle: str,
    var_name: str,
    level_names: Sequence[str],
    purpose: str = "the fields",
    suffixes: tuple[str, ...] | None = None,
) -> tuple[bytes, str]:
    """Download SEVERAL levels of ONE variable as a single GRIB2 file.

    The filter server subsets the product to every requested field at
    once, so a dozen pressure levels of one variable cost ONE request
    instead of a dozen. The file that comes back holds one message per
    field — `decode_fields()` splits it.

    Returns (grib_bytes, product_suffix).
    """
    import httpx

    rel = f"gfs.{date_str}/{cycle}/atmos"
    last_error = "no product tried"
    products = [
        (suf, filt, size) for (suf, filt, size) in GFS_PRODUCTS
        if suffixes is None or suf in suffixes
    ]
    if not products:
        raise ValueError(f"unknown GFS product suffixes: {suffixes}")

    with httpx.Client(timeout=300.0, follow_redirects=True) as client:
        for suffix, filter_suffix, size in products:
            params: dict[str, str] = {
                "file": GFS_FILE.format(cycle=cycle, suffix=suffix),
                f"var_{var_name}": "1",
                "dir": "/" + rel,
            }
            for level_name in level_names:
                params[f"lev_{level_name}"] = "1"
            url = FILTER_SERVER.format(suffix=filter_suffix)
            try:
                resp = client.get(url, params=params)
                if resp.status_code == 200 and resp.content[:4] == b"GRIB":
                    log.info(
                        "filter server %s: %d bytes for %d level(s)",
                        suffix, len(resp.content), len(level_names),
                    )
                    return resp.content, suffix
                last_error = f"{suffix}: HTTP {resp.status_code}"
            except Exception as exc:
                last_error = f"{suffix}: {exc}"
            log.warning("filter server could not serve %s (%s)", suffix, last_error)

    raise RuntimeError(f"could not fetch {purpose} ({last_error})")


def fetch_mslp_grib(date_str: str, cycle: str) -> tuple[bytes, str]:
    """Download the PRMSL message of a GFS analysis as GRIB2 bytes."""
    return fetch_grib_field(
        date_str, cycle, "PRMSL", "mean_sea_level", "the MSLP field"
    )


# ── GRIB decode ─────────────────────────────────────────────────────────
def check_scan_order(scans_positively, lat1, lat_last) -> None:
    """Cross-check the GRIB header's own description of the scan.

    `jScansPositively` says which way the rows run and the header also
    declares the latitude of the first and the last point of the scan.
    The two have to agree. If they ever disagree the field would be
    published mirrored about the equator — and every downstream check
    would still pass, because the mid-latitudes are windier than the
    tropics in BOTH hemispheres.

    Raises SystemExit (never a warning): a mirrored field must not be
    published.
    """
    if lat_last is None:
        return
    descends = lat_last < lat1
    if descends != (not scans_positively):
        raise SystemExit(
            f"[isobars] GRIB row order is inconsistent: jScansPositively="
            f"{scans_positively} but the scan runs from {lat1} to {lat_last}"
        )


def decode_field(
    grib_bytes: bytes,
    expect_short_name,
    prefix: str = "xyzo-grib-",
):
    """Decode a single-field GRIB2 message.

    `expect_short_name` is an eccodes shortName, or a tuple of accepted
    names — the pressure field is `prmsl` in GFS and `msl` in ECMWF IFS.

    Returns (values, lats, lons, run_time): a (nlat, nlon) array in the
    message's OWN units (Pa for pressure, K for temperature — no scaling
    is applied here), lats ascending from -90 to +90, lons 0..360.
    """
    import os
    import tempfile

    import numpy as np

    try:
        import eccodes
    except ImportError as exc:  # pragma: no cover - depends on the host
        raise RuntimeError(
            "eccodes is not installed — pip install 'eccodes' 'eccodeslib'"
        ) from exc

    # The eccodes binding wants a real file object (it takes the FILE*
    # straight out of the Python object), so the bytes go to a temp file.
    handle, path = tempfile.mkstemp(prefix=prefix, suffix=".grb2")
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

            short_name = eccodes.codes_get(gid, "shortName")
            expected = (
                (expect_short_name,)
                if isinstance(expect_short_name, str)
                else tuple(expect_short_name)
            )
            if short_name not in expected:
                raise RuntimeError(
                    f"expected {'/'.join(expected)}, got {short_name!r}"
                )

            values = np.asarray(eccodes.codes_get_array(gid, "values"), dtype=np.float64)
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
            lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
            di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
            dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
            scans_positively = eccodes.codes_get(gid, "jScansPositively")
            date = eccodes.codes_get(gid, "dataDate")
            hour = eccodes.codes_get(gid, "dataTime")
            # Optional structural facts about the scan. They are the
            # cross-check on jScansPositively — see below.
            try:
                lat_last = eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")
            except Exception:
                lat_last = None
            try:
                i_scans_negatively = eccodes.codes_get(gid, "iScansNegatively")
            except Exception:
                i_scans_negatively = 0
    finally:
        # The GRIB handle MUST be released. Left open, the bundled eccodes
        # library segfaults while the interpreter tears down at exit — the
        # work completes, but systemd records the run as SIGSEGV and the
        # timer looks like it failed.
        if gid is not None:
            try:
                eccodes.codes_release(gid)
            except Exception:
                pass
        try:
            os.unlink(path)
        except OSError:
            pass

    grid = values.reshape(nj, ni)

    # The row order is decided by jScansPositively, and the header ALSO
    # declares the latitude of the first and the last point of the
    # scan. The two have to agree. This is the only place where the
    # truth about the row order actually lives, so it is checked here
    # rather than inferred from the weather.
    check_scan_order(scans_positively, lat1, lat_last)

    # jScansPositively=1 -> rows ascend from lat1; =0 -> rows descend from
    # lat1 (the first row is the NORTHERNMOST). Normalise to ascending
    # latitude so row 0 is always the southernmost. Getting this backwards
    # mirrors the field about the equator — the isobars still look
    # plausible but sit in the wrong hemisphere.
    if scans_positively:
        lats = lat1 + np.arange(nj) * dj
    else:
        lats = (lat1 - np.arange(nj) * dj)[::-1]
        grid = grid[::-1, :]

    # The longitude axis assumes the columns run west to east. A product
    # that scans the other way would be laid out in reverse, and the
    # field would be mirrored about the prime meridian — refuse it
    # rather than publish it.
    if i_scans_negatively:
        raise SystemExit(
            "[isobars] this GRIB scans its columns east to west; the "
            "decoder only handles a west-to-east scan"
        )

    lons = (lon1 + np.arange(ni) * di) % 360.0
    grid, lons = align_longitudes(grid, lons)

    run_time = datetime.strptime(f"{date:08d}{hour:04d}", "%Y%m%d%H%M").replace(
        tzinfo=timezone.utc
    )
    return grid, lats, lons, run_time


def align_longitudes(grid, lons):
    """Roll the columns so the longitude axis starts at 0 and increases.

    ECMWF's IFS grid starts at longitude **180**, not 0, so after the
    `% 360` wrap the decoded axis reads 180.0 … 359.9, 0.0 … 179.9 —
    NON-monotonic. `contour_isobars()` interpolates the edge crossings
    linearly in longitude and assumes a monotonic axis, so an unaligned
    field puts a visibly distorted isobar near the antimeridian.

    The defect is subtle — the map still looks plausible, which is the
    worst kind of bug. Rolling the columns so the axis starts at 0 also
    makes the torus window arithmetic in `contour_isobars()` independent
    of the source.
    """
    import numpy as np

    if len(lons) < 2:
        return grid, lons

    # The minimum of a monotonic 0..360 axis is 0 — find its column and
    # roll the grid by the same amount.
    k = int(np.argmin(lons))
    if k:
        grid = np.roll(grid, -k, axis=1)
        lons = np.roll(lons, -k)

    # A grid that still is not monotonic does not cover the full globe.
    # That is legitimate for a regional product, but it must not reach
    # the contour code, which assumes a closed torus.
    if not np.all(np.diff(lons) > 0):
        raise SystemExit(
            "[isobars] longitude axis is not monotonic after alignment — "
            "this product does not cover the full globe"
        )

    # Snap the origin to exactly 0. A 0.1° grid computed as
    # (180 + 1800*0.1) % 360 lands on 5.7e-14 rather than 0, and the
    # torus window is computed from this value.
    if abs(float(lons[0])) < 1e-6:
        lons = lons - float(lons[0])

    return grid, lons


def decode_fields(grib_bytes: bytes, prefix: str = "xyzo-grib-"):
    """Decode EVERY message in a multi-field GRIB2 file.

    The NOMADS filter server can subset a product to several fields at
    once (`&var_SPFH=1&lev_1000_mb=1&lev_850_mb=1`), and the file it
    returns holds one message per field. Fetching a dozen pressure
    levels that way is ONE request instead of a dozen — which is what
    makes the moisture-transport integral affordable.

    Returns a list of dicts, in the order the messages appear:
        {values, lats, lons, run_time, short_name, level, type_of_level}

    The normalisation matches `decode_field()` exactly: latitude
    ascending (row 0 = southernmost), longitude starting at 0 and
    increasing.
    """
    import os
    import tempfile

    import numpy as np

    try:
        import eccodes
    except ImportError as exc:  # pragma: no cover - depends on the host
        raise RuntimeError(
            "eccodes is not installed — pip install 'eccodes' 'eccodeslib'"
        ) from exc

    handle, path = tempfile.mkstemp(prefix=prefix, suffix=".grb2")
    out: list[dict] = []
    try:
        with os.fdopen(handle, "wb") as fh:
            fh.write(grib_bytes)
        with open(path, "rb") as fh:
            while True:
                gid = eccodes.codes_new_from_file(fh, eccodes.CODES_PRODUCT_GRIB)
                if gid is None:
                    break
                if isinstance(gid, list):
                    gid = gid[0]
                if gid is None:
                    break
                try:
                    values = np.asarray(
                        eccodes.codes_get_array(gid, "values"), dtype=np.float64
                    )
                    ni = eccodes.codes_get(gid, "Ni")
                    nj = eccodes.codes_get(gid, "Nj")
                    lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
                    lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
                    di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
                    dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
                    scans_positively = eccodes.codes_get(gid, "jScansPositively")
                    date = eccodes.codes_get(gid, "dataDate")
                    hour = eccodes.codes_get(gid, "dataTime")
                    short_name = eccodes.codes_get(gid, "shortName")
                    try:
                        level = eccodes.codes_get(gid, "level")
                    except Exception:
                        level = None
                    try:
                        type_of_level = eccodes.codes_get(gid, "typeOfLevel")
                    except Exception:
                        type_of_level = None

                    grid = values.reshape(nj, ni)
                    if scans_positively:
                        lats = lat1 + np.arange(nj) * dj
                    else:
                        lats = (lat1 - np.arange(nj) * dj)[::-1]
                        grid = grid[::-1, :]
                    lons = (lon1 + np.arange(ni) * di) % 360.0
                    grid, lons = align_longitudes(grid, lons)
                    run_time = datetime.strptime(
                        f"{date:08d}{hour:04d}", "%Y%m%d%H%M"
                    ).replace(tzinfo=timezone.utc)
                    out.append({
                        "values": grid,
                        "lats": lats,
                        "lons": lons,
                        "run_time": run_time,
                        "short_name": short_name,
                        "level": level,
                        "type_of_level": type_of_level,
                    })
                finally:
                    eccodes.codes_release(gid)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    return out


def decode_mslp(grib_bytes: bytes):
    """Decode the PRMSL message into mean sea-level pressure in hPa."""
    grid, lats, lons, run_time = decode_field(grib_bytes, "prmsl", "xyzo-mslp-")
    return grid / 100.0, lats, lons, run_time  # Pa -> hPa


def decode_mslp_ecmwf(grib_bytes: bytes):
    """Decode an ECMWF IFS `msl` message into mean sea-level pressure in hPa."""
    grid, lats, lons, run_time = decode_field(grib_bytes, "msl", "xyzo-ecmwf-msl-")
    return grid / 100.0, lats, lons, run_time  # Pa -> hPa


# ── Marching squares ────────────────────────────────────────────────────
# Corner order per cell: 0 = (row, col), 1 = (row, col+1),
# 2 = (row+1, col+1), 3 = (row+1, col).
#
# The case index is a 4-bit mask of "corner is above the level":
# bit0=corner0, bit1=corner1, bit2=corner2, bit3=corner3.
_CASES: dict[int, list[tuple[str, str]]] = {
    1: [("b", "l")], 2: [("b", "r")], 3: [("r", "l")], 4: [("r", "t")],
    6: [("b", "t")], 7: [("r", "l")], 8: [("l", "t")], 9: [("b", "t")],
    11: [("r", "t")], 12: [("l", "r")], 13: [("b", "r")], 14: [("b", "l")],
}

# The two SADDLE cases are ambiguous: the four corners straddle the
# level in a checkerboard pattern and there are two ways to pair the
# edges. Picking one blindly produces a line that crosses itself — a
# visible "lightning bolt" on the chart.
#
# The asymptotic decider resolves it with the value at the cell centre
# (for a bilinear field that is exactly the mean of the four corners):
# if the centre is above the level, the "above" region is connected,
# and the pairing flips when it is below.
#
#   case 5  (corners 0 and 2 above):  centre above -> (b,r)+(l,t)
#                                     centre below -> (b,l)+(r,t)
#   case 10 (corners 1 and 3 above):  centre above -> (b,l)+(r,t)
#                                     centre below -> (b,r)+(l,t)
_SADDLE = {
    5: ([("b", "r"), ("l", "t")], [("b", "l"), ("r", "t")]),
    10: ([("b", "l"), ("r", "t")], [("b", "r"), ("l", "t")]),
}



def _edge_point(va, vb, ax, ay, bx, by, level):
    """Interpolated crossing point on the edge between two corners."""
    import numpy as np

    with np.errstate(divide="ignore", invalid="ignore"):
        t = (level - va) / (vb - va)
    t = np.where(np.isfinite(t), t, 0.5)
    t = np.clip(t, 0.0, 1.0)
    return ax + (bx - ax) * t, ay + (by - ay) * t


def marching_squares(grid, lats, lons, level):
    """Contour one level out of a regular lat/lon grid.

    Returns an (n, 4) array of segments [x1, y1, x2, y2] in degrees.
    """
    import numpy as np

    v00 = grid[:-1, :-1]
    v10 = grid[:-1, 1:]
    v11 = grid[1:, 1:]
    v01 = grid[1:, :-1]

    case = (
        ((v00 > level).astype(np.uint8))
        | ((v10 > level).astype(np.uint8) << 1)
        | ((v11 > level).astype(np.uint8) << 2)
        | ((v01 > level).astype(np.uint8) << 3)
    )

    x0 = lons[:-1][None, :]
    x1 = lons[1:][None, :]
    y0 = lats[:-1][:, None]
    y1 = lats[1:][:, None]

    X = np.broadcast_to(x0, v00.shape)
    Y = np.broadcast_to(y0, v00.shape)
    dx = x1 - x0
    dy = y1 - y0

    edges = {
        # bottom edge, corner0 -> corner1
        "b": _edge_point(v00, v10, X, Y, X + dx, Y, level),
        # right edge, corner1 -> corner2
        "r": _edge_point(v10, v11, X + dx, Y, X + dx, Y + dy, level),
        # top edge, corner3 -> corner2
        "t": _edge_point(v01, v11, X, Y + dy, X + dx, Y + dy, level),
        # left edge, corner0 -> corner3
        "l": _edge_point(v00, v01, X, Y, X, Y + dy, level),
    }

    chunks = []
    for case_id, pairs in _CASES.items():
        mask = case == case_id
        if not mask.any():
            continue
        for edge_a, edge_b in pairs:
            (xa, ya), (xb, yb) = edges[edge_a], edges[edge_b]
            chunks.append(
                np.stack([xa[mask], ya[mask], xb[mask], yb[mask]], axis=1)
            )

    # Saddle cells: the pairing depends on the value at the centre.
    centre = (v00 + v10 + v11 + v01) / 4.0
    for case_id, (above_pairs, below_pairs) in _SADDLE.items():
        mask = case == case_id
        if not mask.any():
            continue
        for pairs, sub in ((above_pairs, centre > level), (below_pairs, centre <= level)):
            sel = mask & sub
            if not sel.any():
                continue
            for edge_a, edge_b in pairs:
                (xa, ya), (xb, yb) = edges[edge_a], edges[edge_b]
                chunks.append(
                    np.stack([xa[sel], ya[sel], xb[sel], yb[sel]], axis=1)
                )

    if not chunks:
        return np.empty((0, 4))
    return np.concatenate(chunks, axis=0)


def stitch_segments(segments, tol: float = 1e-6):
    """Join loose contour segments into continuous polylines.

    O(n): segments are indexed by their (rounded) endpoints, then chains
    are walked from the open ends first and the remaining closed rings are
    walked afterwards.

    At a branch point (four cells meeting at one corner, a saddle, the
    pole rows) several segments share a node. The walk has to pick the
    one that continues the line GEOMETRICALLY — taking any free segment
    teleports the line across the map, which is what produced the
    map-wide leaps in the first version.
    """
    if len(segments) == 0:
        return []

    node_id: dict[tuple[int, int], int] = {}
    coords: list[tuple[float, float]] = []

    def node(x: float, y: float) -> int:
        key = (int(round(x / tol)), int(round(y / tol)))
        idx = node_id.get(key)
        if idx is None:
            idx = len(coords)
            node_id[key] = idx
            coords.append((x, y))
        return idx

    adjacency: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for index, (ax, ay, bx, by) in enumerate(segments):
        a = node(ax, ay)
        b = node(bx, by)
        adjacency[a].append((b, index))
        adjacency[b].append((a, index))

    used = [False] * len(segments)
    lines: list[list[tuple[float, float]]] = []

    def walk(first_node: int, first_seg: int, first_next: int) -> list[int]:
        # The chain starts at the node the caller is standing on, then
        # crosses the first segment to the other end.
        chain = [first_node, first_next]
        current = first_next
        prev_seg = first_seg
        prev_point = coords[first_node]
        while True:
            cur_x, cur_y = coords[current]
            in_x = cur_x - prev_point[0]
            in_y = cur_y - prev_point[1]
            in_len = math.hypot(in_x, in_y)

            best = None
            best_score = None
            for candidate, seg_index in adjacency[current]:
                if seg_index == prev_seg or used[seg_index]:
                    continue
                far_x, far_y = coords[candidate]
                out_x = far_x - cur_x
                out_y = far_y - cur_y
                out_len = math.hypot(out_x, out_y)
                if in_len == 0.0 or out_len == 0.0:
                    score = 0.0
                else:
                    # Cosine similarity: 1 means the line carries straight
                    # on, -1 means it doubles back.
                    score = (in_x * out_x + in_y * out_y) / (in_len * out_len)
                if best_score is None or score > best_score:
                    best_score = score
                    best = (candidate, seg_index)
            if best is None:
                break
            used[best[1]] = True
            chain.append(best[0])
            prev_point = coords[current]
            current, prev_seg = best
        return chain

    # Open chains first: start from the free ends so a ring that touches
    # another ring is not cut in half.
    for node_index, neighbours in adjacency.items():
        if len(neighbours) != 1:
            continue
        other, seg_index = neighbours[0]
        if used[seg_index]:
            continue
        used[seg_index] = True
        lines.append([coords[n] for n in walk(node_index, seg_index, other)])

    # Whatever is left is a closed ring.
    for index, (ax, ay, bx, by) in enumerate(segments):
        if used[index]:
            continue
        used[index] = True
        chain = walk(node(bx, by), index, node(ax, ay))
        if chain[-1] != chain[0]:
            chain.append(chain[0])
        lines.append([coords[n] for n in chain])

    return lines


def simplify(points: Sequence[tuple[float, float]], tolerance: float):
    """Douglas-Peucker simplification."""
    import numpy as np

    if len(points) < 3:
        return list(points)
    pts = np.asarray(points, dtype=float)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        p0 = pts[start]
        p1 = pts[end]
        d = p1 - p0
        length = math.hypot(d[0], d[1])
        segment = pts[start + 1 : end]
        if length < 1e-12:
            dist = np.hypot(segment[:, 0] - p0[0], segment[:, 1] - p0[1])
        else:
            dist = np.abs(
                d[0] * (p0[1] - segment[:, 1]) - (p0[0] - segment[:, 0]) * d[1]
            ) / length
        offset = int(np.argmax(dist))
        if dist[offset] > tolerance:
            middle = start + 1 + offset
            keep[middle] = True
            stack.append((start, middle))
            stack.append((middle, end))
    return pts[keep]


def chaikin_smooth(points, iterations: int | None = None):
    """Round the corners of a polyline with Chaikin corner-cutting.

    Marching squares returns a polyline whose vertices sit on the
    analysis grid, so the contour comes out visibly angular — the
    staircase you see on a 1° grid. Chaikin replaces every segment with
    two shorter ones at 1/4 and 3/4 of the way along it, which rounds
    the corners off.

    Unlike a spline it never overshoots, so the line stays on the side
    of the true contour it started on.
    """
    if iterations is None:
        iterations = SMOOTH_ITERATIONS
    pts = list(points)
    for _ in range(iterations):
        if len(pts) < 3:
            return pts
        rounded = [pts[0]]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            rounded.append((x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.25))
            rounded.append((x0 + (x1 - x0) * 0.75, y0 + (y1 - y0) * 0.75))
        rounded.append(pts[-1])
        pts = rounded
    return pts


def polyline_length(points) -> float:
    """Length of a polyline in degrees."""
    total = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        total += math.hypot(x1 - x0, y1 - y0)
    return total



def grid_spacing_deg(lats, lons) -> float:
    """The mean grid spacing in degrees (a regular lat/lon grid)."""
    import numpy as np

    d_lon = float(np.mean(np.diff(lons))) if len(lons) > 1 else GFS_GRID_DEG
    d_lat = float(np.mean(np.diff(lats))) if len(lats) > 1 else GFS_GRID_DEG
    if d_lon <= 0 or d_lat <= 0:
        return GFS_GRID_DEG
    return (abs(d_lon) + abs(d_lat)) / 2.0


def smooth_sigma_cells(spacing_deg: float) -> float:
    """The Gaussian sigma, in CELLS, for a field on a given grid.

    Split out of `smooth_field()` so that an audit can report the blur
    it applied WITHOUT re-deriving the rule: a second implementation of
    the sigma is a second source of truth, and the source of truth that
    drifts is the one nobody checks.
    """
    if FIELD_SMOOTH_SIGMA_DEG <= 0 or spacing_deg <= 0:
        return 0.0
    # The sigma is a physical width converted to cells, but it has a
    # FLOOR of two cells. The blur exists to stop the contour riding the
    # analysis grid — the visible staircase — and a Gaussian narrower
    # than about a cell and a half cannot remove a grid-aligned
    # staircase. The floor is what keeps the coarse 1° GFS fallback
    # smoothing the way it always did (2 cells = 2° there, 0.5° on the
    # 0.25° grid). Without it, the 1° fallback would draw staircases.
    return max(2.0, FIELD_SMOOTH_SIGMA_DEG / spacing_deg)


def smooth_field(grid, spacing_deg: float = GFS_GRID_DEG):
    """Blur the pressure field before it is contoured.

    The analysis carries structure well below synoptic scale.
    Contouring it raw breaks the isobars into thousands of tiny
    fragments — technically correct, useless on a chart.

    The longitude axis wraps (it is periodic) but the latitude axis does
    not (the poles are edges, not a seam), so the two axes get
    different boundary modes.

    The sigma is a PHYSICAL width (`FIELD_SMOOTH_SIGMA_DEG`), converted
    to cells against the grid spacing. A sigma expressed in cells would
    smooth 2.5x less in physical terms on ECMWF's 0.1° grid than on
    GFS's 0.25° grid — the same number, a completely different chart.
    """
    sigma = smooth_sigma_cells(spacing_deg)
    if sigma <= 0:
        return grid
    try:
        from scipy.ndimage import gaussian_filter
    except ImportError:  # pragma: no cover - scipy is optional
        log.warning("scipy is not installed — contouring the raw field")
        return grid
    return gaussian_filter(grid, sigma=sigma, mode=("nearest", "wrap"))


def filter_short_chains(
    chains,
    min_length: float = MIN_LINE_LENGTH_DEG,
    tol: float = BRIDGE_TOL_DEG,
):
    """Drop short fragments — unless they are holding an isobar together.

    Filtering on length alone opened visible gaps: a contour arrives as
    several pieces wherever the field grazes a level, and the small
    pieces in between were thrown away along with them.

    So a short piece is only dropped when it has **fewer than two
    neighbouring chains of the same level**. Two neighbours means it
    bridges a break in an isobar and has to stay; one neighbour is a
    hair sticking off the line; zero is an isolated speck.
    """
    if not chains:
        return []
    parts = [list(c) for c in chains if len(c) >= 2]
    if not parts:
        return []

    def bucket_of(x, y):
        return (math.floor(x / tol), math.floor(y / tol))

    buckets: dict[tuple, list[int]] = {}
    ends: list[tuple[float, float, int]] = []
    for i, p in enumerate(parts):
        for pt in (p[0], p[-1]):
            ends.append((pt[0], pt[1], i))
            buckets.setdefault(bucket_of(pt[0], pt[1]), []).append(len(ends) - 1)

    neighbours: list[set[int]] = [set() for _ in parts]
    for x1, y1, i in ends:
        kx, ky = bucket_of(x1, y1)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ej in buckets.get((kx + dx, ky + dy), []):
                    x2, y2, j = ends[ej]
                    if j == i:
                        continue
                    if math.hypot(x2 - x1, y2 - y1) <= tol:
                        neighbours[i].add(j)

    kept = []
    for i, p in enumerate(parts):
        if polyline_length(p) >= min_length:
            kept.append(p)
        elif len(neighbours[i]) >= 2:
            kept.append(p)
    return kept


def _join_pieces(a, b, tol: float):
    """Append piece `b` to the end of piece `a`, cutting the overshoot.

    The two overlap: `b` starts back along `a`'s last segment, because
    the contour cut the same corner twice. Appending them as they are
    leaves a visible back-step, so `a`'s last segment is cut at the
    point where `b` begins.

    Returns None when the two are NOT overlapping — merely adjacent
    strands of the same isobar. Joining those produces a line that
    doubles back on itself, which is a visible staircase on the map.
    """
    if len(a) < 2:
        return None
    ea, sb = a[-1], b[0]
    if math.hypot(ea[0] - sb[0], ea[1] - sb[1]) > tol:
        return None
    dx = ea[0] - a[-2][0]
    dy = ea[1] - a[-2][1]
    length_sq = dx * dx + dy * dy
    if length_sq < 1e-12:
        return None
    t = ((sb[0] - a[-2][0]) * dx + (sb[1] - a[-2][1]) * dy) / length_sq
    if not (0.0 <= t <= 1.0):
        # `b` does not start on `a`'s last segment: they are two
        # neighbouring strands, not the same line. Leave them apart.
        return None
    cut = (a[-2][0] + dx * t, a[-2][1] + dy * t)
    merged = list(a[:-1]) + [cut] + list(b[1:])
    # Drop consecutive duplicates (the cut can land on an existing point).
    out = [merged[0]]
    for point in merged[1:]:
        if abs(point[0] - out[-1][0]) > 1e-12 or abs(point[1] - out[-1][1]) > 1e-12:
            out.append(point)
    return out


def merge_isobars(lines, tol: float = MERGE_TOL_DEG):
    """Join the pieces of each isobar into continuous lines.

    A contour arrives as thousands of pieces: marching squares cuts the
    line wherever the field grazes the level, and the stitch cannot
    rejoin them because their ends do not coincide. Left alone, the map
    draws ~5,000 separate SVG paths — slow to create, slow to redraw and
    slow to ship.

    Pieces whose ends come within `tol` of each other belong to the same
    isobar, and at 0.25° (one grid cell) the whole world collapses from
    ~5,000 pieces to ~250 continuous lines — which is the number of
    isobars a synoptic chart actually has.

    Returns [(level, points), ...] with the pieces merged.
    """
    by_level: dict[int, list[list[tuple[float, float]]]] = defaultdict(list)
    for level, points in lines:
        by_level[level].append(list(points))

    cell = max(tol, 1e-9)
    merged: list[tuple[int, list[tuple[float, float]]]] = []

    for level, pieces in by_level.items():
        n = len(pieces)
        if n < 2:
            merged.extend((level, p) for p in pieces)
            continue

        # Endpoints are indexed 2i = start of piece i, 2i+1 = end.
        ends: list[tuple[float, float]] = []
        for p in pieces:
            ends.append(p[0])
            ends.append(p[-1])

        buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i, e in enumerate(ends):
            buckets[(math.floor(e[0] / cell), math.floor(e[1] / cell))].append(i)

        def partners(idx: int) -> list[int]:
            """Endpoint indices near ends[idx] (excluding its own piece)."""
            e = ends[idx]
            kx = math.floor(e[0] / cell)
            ky = math.floor(e[1] / cell)
            out = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j in buckets.get((kx + dx, ky + dy), []):
                        if j // 2 == idx // 2:
                            continue
                        o = ends[j]
                        if math.hypot(e[0] - o[0], e[1] - o[1]) <= tol:
                            out.append(j)
            return out

        def find_partner(idx: int):
            """Endpoint indices that could join onto ends[idx], nearest first."""
            e = ends[idx]
            kx = math.floor(e[0] / cell)
            ky = math.floor(e[1] / cell)
            found = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j in buckets.get((kx + dx, ky + dy), []):
                        if j // 2 == idx // 2:
                            continue
                        piece = j // 2
                        if used[piece]:
                            continue
                        o = ends[j]
                        d = math.hypot(e[0] - o[0], e[1] - o[1])
                        if d <= tol:
                            found.append((d, j))
            found.sort()
            return [j for _d, j in found]

        used = [False] * n
        for start in range(n):
            if used[start]:
                continue
            used[start] = True
            chain = list(pieces[start])
            # The endpoint indices of the two open ends of the chain.
            head = 2 * start
            tail = 2 * start + 1

            for _ in range(n):
                # Grow the tail first.
                grew = False
                for j in find_partner(tail):
                    piece = j // 2
                    p = pieces[piece]
                    if j % 2 == 1:
                        # Its END is the junction — flip it so it starts
                        # there.
                        p = p[::-1]
                    joined = _join_pieces(chain, p, tol)
                    if joined is None:
                        continue  # adjacent strand, not the same line
                    chain = joined
                    used[piece] = True
                    tail = 2 * piece + (1 if j % 2 == 0 else 0)
                    grew = True
                    break
                if grew:
                    continue
                # Then the head.
                grew = False
                for j in find_partner(head):
                    piece = j // 2
                    p = pieces[piece]
                    if j % 2 == 0:
                        # Its START is the junction — flip it so it ends
                        # there.
                        p = p[::-1]
                    joined = _join_pieces(p, chain, tol)
                    if joined is None:
                        continue
                    chain = joined
                    used[piece] = True
                    head = 2 * piece + (1 if j % 2 == 0 else 0)
                    grew = True
                    break
                if not grew:
                    break
            merged.append((level, chain))
    return merged


def clip_to_lon_range(points, west: float, east: float):
    """Split a polyline at the boundaries of [west, east], keeping the parts inside.

    A line that leaves the window and comes back is cut into the pieces
    that are actually visible; the cut points are interpolated onto the
    boundary so the line still ends exactly at the edge.
    """
    if len(points) == 0:
        return []
    out: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []

    for i, (lon, lat) in enumerate(points):
        inside = west <= lon <= east
        if inside:
            if not current and i > 0:
                # Entering: the previous point was outside, so it came in
                # through the side it was on.
                plon, plat = points[i - 1]
                bound = west if plon < west else east
                t = (bound - plon) / (lon - plon) if lon != plon else 0.0
                t = max(0.0, min(1.0, t))
                current.append((bound, plat + (lat - plat) * t))
            current.append((lon, lat))
        elif current:
            # Leaving: the boundary is the side the line went out of.
            # Picking the wrong one here produced a wildly interpolated
            # point and a line that shot across the map.
            plon, plat = points[i - 1]
            bound = west if lon < west else east
            t = (bound - plon) / (lon - plon) if lon != plon else 0.0
            t = max(0.0, min(1.0, t))
            current.append((bound, plat + (lat - plat) * t))
            out.append(current)
            current = []
    if current:
        out.append(current)
    return [seg for seg in out if len(seg) >= 2]


def contour_isobars(grid, lats, lons, interval: float = ISO_INTERVAL_HPA):
    """Contour the whole field. Returns [(level_hpa, [(lon, lat), ...]), ...]."""
    import numpy as np

    grid = smooth_field(grid, grid_spacing_deg(lats, lons))

    # Drop the polar rows. Every longitude on a pole row shares one
    # latitude, so a contour that lands there comes out as a perfectly
    # straight line running along the pole. No chart shows them.
    keep = np.abs(lats) <= LAT_LIMIT_DEG
    grid = grid[keep, :]
    lats = lats[keep]

    # Contour on a TORUS: the field is periodic in longitude, so two
    # copies side by side make the antimeridian seamless — a line that
    # crosses it continues instead of stopping at the grid edge.
    ext_grid = np.concatenate([grid, grid], axis=1)
    ext_lons = np.concatenate([lons, lons + 360.0])

    # The window we keep is the world's [-180, 180] expressed in the
    # extended grid. The seam sits inside it, so a line that wraps the
    # globe is drawn as one continuous curve.
    origin = float(lons[0])
    west, east = origin + 180.0, origin + 540.0
    shift = origin + 360.0

    # Both bounds snap to the 2-decimal lattice the API asks from:
    # `stepLevels()` in weather.ts builds its IN list with
    # Math.round(k*step*100)/100, so 2 decimals is already the contract
    # for every step the ladder offers (0.05 is the finest), and the
    # float error in `floor(...) * interval` (~1e-13) is nothing against
    # a 0.01 grid. Snapping here is what makes a stored level BIT-IDENTICAL
    # to the requested one instead of merely close enough to survive the
    # REAL column's rounding.
    low = round(math.floor(float(np.nanmin(ext_grid)) / interval) * interval, 2)
    high = round(math.ceil(float(np.nanmax(ext_grid)) / interval) * interval, 2)

    # `level` is a FLOAT: the interval can be fractional (0.05 hPa), and
    # `range(low, high + 1, interval)` refuses a float step.
    #
    # EACH LEVEL IS RE-SNAPPED, so the enumeration cannot drift. 0.05 and
    # 0.1 are not dyadic (0.5 and 0.25 are, which is why plain `+=` used
    # to be exact), so `level += interval` would walk off the decimal
    # grid — by ~1e-10 over the whole range, enough to make
    # `level % interval == 0` false while still landing in the same float4.
    # Re-rounding each step keeps the levels exact decimals, which is the
    # same value the API rounds to, so the two sides cannot disagree.
    #
    # The epsilon is now belt-and-braces: level and `high` are the same
    # kind of value, so `<=` matches exactly when they meet.
    EPS = interval * 1e-9
    by_level: dict[float, list[list[tuple[float, float]]]] = {}
    level = round(float(low), 2)
    while level <= high + EPS:
        segments = marching_squares(ext_grid, lats, ext_lons, level)
        # NOTE: no `continue` on an empty level. The increment lives at
        # the BOTTOM of the body, so skipping past an empty level would
        # skip the increment too and the loop would never end.
        if len(segments):
            for line in stitch_segments(segments):
                if len(line) < MIN_LINE_POINTS:
                    continue
                # Round the grid-aligned corners first, then decide which
                # vertices actually earn their place.
                bucket = by_level.setdefault(level, [])
                for part in clip_to_lon_range(line, west, east):
                    # Back to [-180, 180].
                    shifted = [(lon - shift, lat) for lon, lat in part]
                    if len(shifted) >= MIN_LINE_POINTS:
                        bucket.append(shifted)
        level = round(level + interval, 2)

    # A contour arrives as several pieces wherever the field grazes a
    # level. Join them back into continuous isobars FIRST, then filter
    # on connectivity rather than length alone: short pieces that bridge
    # a break are kept, isolated specks and hairs are dropped.
    #
    # Merging first is what closes the gaps — a bridging piece becomes
    # part of a long chain, so the length rule cannot throw it away —
    # and it is also what makes the layer fast to draw: ~250 continuous
    # lines instead of ~5,000 separate pieces.
    #
    # THE MERGE RUNS ON THE RAW PIECES, BEFORE THE ROUNDING. That order
    # is not cosmetic — it is the difference between a chart and a
    # handful of hairs.
    #
    # `merge_isobars()` decides that two pieces belong to the same
    # isobar by asking whether the next piece's start projects ONTO the
    # previous piece's last segment. That overlap is a property of the
    # RAW marching-squares geometry — the contour cut the same corner
    # twice, so the second piece starts back along the first one's last
    # segment. Chaikin rounding MOVES those ends, the projection test
    # starts failing, and the pieces stop joining.
    #
    # Measured on the 2026-11-02 18Z GFS analysis at 2 hPa, the whole
    # world:
    #
    #   round -> thin -> merge (the old order)  2,145 lines, 2.9 % of
    #       the vertices turning more than 40 deg, p95 33.2
    #   merge -> round -> thin (this order)      549 lines, 0.68 %, p95
    #       23.5
    #
    # So the old order was not merging most of the pieces at all: each
    # isobar came out broken into ~4 fragments, and every fragment's
    # end was a hard edge on the map. The new order merges what the
    # merge was written to merge, and the accuracy IMPROVES (p95
    # offset from the pressure field 0.195 -> 0.170 hPa) because a
    # continuous contour is a better contour than four pieces of one.
    merged = merge_isobars(
        [(level, points) for level, chains in by_level.items() for points in chains]
    )
    merged_by_level: dict[int, list[list[tuple[float, float]]]] = defaultdict(list)
    for level, points in merged:
        merged_by_level[level].append(points)

    # AND THE ROUNDING IS THE LAST WORD. Douglas-Peucker replaces a
    # curve with straight chords, so a tolerance above the amplitude
    # the Chaikin rounding leaves behind shaves the rounding straight
    # back off — which is why "more Chaikin" on its own changed almost
    # nothing (2.9 % -> 2.8 % of sharp vertices from two extra rounds).
    # Rounding after the thinning keeps the corners round.
    #
    # The two couplings the ordering still has to respect:
    #   * the DP tolerance stays BELOW the amplitude the Chaikin
    #     rounding leaves behind (~0.06 deg) — 0.01 does;
    #   * the FIELD is smoothed before it is contoured, not after —
    #     rounding the finished polyline does not remove the
    #     analysis-grid staircase, it only rounds each step.
    results: list[tuple[int, list[tuple[float, float]]]] = []
    for level, chains in merged_by_level.items():
        for kept in filter_short_chains(chains):
            if len(kept) >= MIN_LINE_POINTS:
                smoothed = chaikin_smooth(kept)
                results.append((level, simplify(smoothed, SIMPLIFY_TOL_DEG)))
    return results


# ── Persistence ─────────────────────────────────────────────────────────
def store_isobars(lines, run_time: datetime, source: str = "gfs",
                  interval: float = ISO_INTERVAL_HPA) -> int:
    """Replace one source's stored isobars with a fresh set.

    Returns the row count. The DELETE and the INSERTs share one
    transaction so a reader never sees a half-written map.

    The delete is scoped to `source`: the worker stores GFS (the fresher
    analysis) and ECMWF IFS 0.1° (the finer one) side by side, and one
    source's refresh must not wipe the other's lines.
    """
    payload = []
    for level, points in lines:
        wkt = "LINESTRING(" + ", ".join(f"{lon:.4f} {lat:.4f}" for lon, lat in points) + ")"
        payload.append((level, wkt, run_time, source))

    with connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM weather_isobars WHERE source = %s", (source,))
        if payload:
            cur.executemany(
                "INSERT INTO weather_isobars (level_hpa, geom, run_time, source) "
                "VALUES (%s, ST_GeomFromText(%s), %s, %s)",
                payload,
            )
        # Record WHAT was built, not just when. The cycle and the
        # product say the analysis is unchanged; the INTERVAL says how
        # it was cut. Moving the interval from 1 hPa to 0.5 hPa left
        # both unchanged, so the no-op guard declared "already
        # published" and the finer set never shipped.
        cur.execute(
            "INSERT INTO weather_isobars_build (source, run_time, interval_hpa, built) "
            "VALUES (%s, %s, %s, now()) "
            "ON CONFLICT (source) DO UPDATE SET "
            "  run_time = EXCLUDED.run_time, "
            "  interval_hpa = EXCLUDED.interval_hpa, "
            "  built = now()",
            (source, run_time, float(interval)),
        )
    return len(payload)


def stored_build(source: str) -> tuple[str | None, float | None]:
    """(run_time, interval_hpa) for one source — what was last built.

    The cheap "nothing changed" path. The timer polls every 15 minutes
    so a new GFS cycle is picked up within minutes of NOMADS publishing
    it — but ECMWF's IFS 0.1° message takes FOUR MINUTES to fetch and
    contour, and without this guard the isobar worker would re-fetch and
    re-contour the whole world every fifteen minutes to produce the
    same lines.

    BOTH the cycle AND the interval count: the cycle says the analysis
    is new, the interval says it was cut differently. Moving from 1 hPa
    to 0.5 hPa left both of the first two unchanged, so a cycle-only
    comparison declared "already published" and the finer set never
    shipped. `weather_isobars_build` is where the parameters live.
    """
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT run_time, interval_hpa FROM weather_isobars_build "
                "WHERE source = %s",
                (source,),
            )
            row = cur.fetchone()
            if not row:
                return None, None
            value = row["run_time"] if isinstance(row, dict) else row[0]
            if value is None:
                return None, None
            if isinstance(value, datetime):
                stamp = value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            else:
                stamp = str(value)
            interval = row["interval_hpa"] if isinstance(row, dict) else row[1]
            return stamp, (float(interval) if interval is not None else None)
    except Exception as exc:  # a missing table must not stop the build
        log.warning("could not read the published build for %s: %s", source, exc)
        return None, None


def stored_run_time(source: str) -> str | None:
    """The analysis already published for one source, as an ISO stamp."""
    return stored_build(source)[0]


def stored_sources() -> dict[str, str]:
    """{source: ISO run_time} for every source currently in the table."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT source, MAX(run_time) FROM weather_isobars GROUP BY source"
        )
        return {row[0]: row[1].isoformat() for row in cur.fetchall()}


# ── Entry point ─────────────────────────────────────────────────────────
def _build_ecmwf(dry_run: bool = False, force_run: str | None = None) -> bool:
    """Build and store the ECMWF IFS 0.1° isobars. Returns True on success."""
    from . import ecmwf

    run_ref = ecmwf.find_latest_run(force_run)
    if run_ref is None:
        log.warning("no ECMWF IFS run found — keeping the previous lines")
        return False
    date_str, cycle = run_ref
    log.info("using ECMWF IFS run %s %sZ (%s)", date_str, cycle, ecmwf.RESOLUTION)

    # The cheap "nothing changed" path. The IFS 0.1° message takes
    # FOUR MINUTES to fetch and contour — and ECMWF publishes twice a
    # day — so without this the fifteen-minute poll would spend four
    # minutes of every quarter hour re-cutting the same world.
    if not dry_run and force_run is None:
        want = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{cycle.zfill(2)}:00:00Z"
        got_stamp, got_interval = stored_build("ecmwf")
        if got_stamp == want and got_interval == ISO_INTERVAL_HPA:
            log.info("ECMWF IFS analysis %s at %g hPa already published — skipping the fetch",
                     want, ISO_INTERVAL_HPA)
            return True

    grib, _rec = ecmwf.fetch_msl(date_str, cycle)
    grid, lats, lons, run_time = decode_mslp_ecmwf(grib)
    log.info(
        "decoded ECMWF MSLP %dx%d: %.1f..%.1f hPa (run %s)",
        grid.shape[0], grid.shape[1], grid.min(), grid.max(), run_time.isoformat(),
    )

    lines = contour_isobars(grid, lats, lons)
    _log_contour_stats("ECMWF", lines)

    if dry_run:
        print(f"ECMWF IFS run : {date_str} {cycle}Z ({ecmwf.RESOLUTION})")
        print(f"analysis time : {run_time.isoformat()}")
        print(f"polylines     : {len(lines)}")
        return True

    stored = store_isobars(lines, run_time, "ecmwf")
    log.info("stored %d ECMWF isobar rows", stored)
    print(f"stored {stored} ECMWF isobar rows for {run_time.isoformat()}")
    return True


def _build_gfs(dry_run: bool = False, force_run: str | None = None) -> bool:
    """Build and store the NOAA GFS 0.25° isobars. Returns True on success."""
    run_ref = find_latest_run(force_run)
    if run_ref is None:
        log.warning("no GFS run found on NOMADS — keeping the previous lines")
        return False
    date_str, cycle = run_ref
    log.info("using GFS run %s %sZ", date_str, cycle)

    # The cheap "nothing changed" path — the same guard the wind and
    # temperature overlays have. The timer polls every 15 minutes so a
    # new cycle is picked up within minutes of NOMADS publishing it,
    # and without this the worker would re-download and re-contour the
    # whole world every fifteen minutes for the same lines.
    if not dry_run and force_run is None:
        want = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{cycle.zfill(2)}:00:00Z"
        got_stamp, got_interval = stored_build("gfs")
        if got_stamp == want and got_interval == ISO_INTERVAL_HPA:
            log.info("GFS analysis %s at %g hPa already published — skipping the fetch",
                     want, ISO_INTERVAL_HPA)
            return True

    grib, product = fetch_mslp_grib(date_str, cycle)
    grid, lats, lons, run_time = decode_mslp(grib)
    log.info(
        "decoded GFS MSLP %dx%d (%s): %.1f..%.1f hPa (run %s)",
        grid.shape[0], grid.shape[1], product, grid.min(), grid.max(),
        run_time.isoformat(),
    )

    lines = contour_isobars(grid, lats, lons)
    _log_contour_stats("GFS", lines)

    if dry_run:
        print(f"GFS run       : {date_str} {cycle}Z")
        print(f"analysis time : {run_time.isoformat()}")
        print(f"polylines     : {len(lines)}")
        return True

    stored = store_isobars(lines, run_time, "gfs")
    log.info("stored %d GFS isobar rows", stored)
    print(f"stored {stored} GFS isobar rows for {run_time.isoformat()}")
    return True


def _log_contour_stats(label: str, lines) -> None:
    vertices = sum(len(points) for _, points in lines)
    levels = sorted({level for level, _ in lines})
    log.info(
        "%s contoured %d polylines (%d vertices) across %d levels %s..%s",
        label, len(lines), vertices, len(levels),
        levels[0] if levels else "-", levels[-1] if levels else "-",
    )


def run(
    dry_run: bool = False,
    force_run: str | None = None,
    sources: Sequence[str] = ("ecmwf", "gfs"),
) -> int:
    """Build every requested source. One source failing never blocks another.

    Both sources are stored: ECMWF IFS 0.1° is the finer grid but lands
    ~8.5 h after the run, while GFS 0.25° lands ~3.5 h after it. The API
    picks whichever analysis is actually newer for the viewport, so the
    layer is never stuck on a stale cycle just because the finer source
    is slow to publish.
    """
    builders = {"ecmwf": _build_ecmwf, "gfs": _build_gfs}
    ok = False
    for source in sources:
        builder = builders.get(source)
        if builder is None:
            log.error("unknown isobar source %r", source)
            continue
        try:
            ok = builder(dry_run=dry_run, force_run=force_run) or ok
        except SystemExit:
            raise
        except Exception as exc:
            # A broken source must not take the other one down with it.
            log.error("%s source failed: %s", source, exc)
    if not ok:
        log.error("no isobar source could be built")
        return 1
    return 0


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="fetch and contour only")
    parser.add_argument("--run", help="force a cycle, YYYYMMDDHH")
    parser.add_argument(
        "--source",
        action="append",
        choices=["ecmwf", "gfs"],
        help="build only this source (repeatable; default: both)",
    )
    args = parser.parse_args()
    try:
        code = run(
            dry_run=args.dry_run,
            force_run=args.run,
            sources=tuple(args.source) if args.source else ("ecmwf", "gfs"),
        )
    except RuntimeError as exc:
        # A missing optional dependency must not make the systemd timer
        # flap — the map just keeps the previous isobars.
        log.error("isobars unavailable: %s", exc)
        code = 0

    # Skip the interpreter teardown. The database transaction is already
    # committed and the process is about to exit anyway, but the native
    # libraries loaded by eccodes and psycopg are not guaranteed to
    # finalise in a safe order — letting them run makes the systemd unit
    # record SIGSEGV on an otherwise successful run.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    raise SystemExit(main())
