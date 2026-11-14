#!/usr/bin/env python3
"""Build the wind overlay: the particle-flow grid + the speed ramp meta.

The map's "💨 Wind" layer animates streamlines over the basemap and lets
you read a point in m/s, km/h and knots.

There is no free wind *tile* service — every one is either behind a paid
key or a proprietary tile server — so the field comes from the NOAA NCEP
GFS analysis (10 m u/v wind), the same source and the same 6-hourly cycle
as the pressure lines and the temperature map. Two ~48 KB requests per
run. The browser never talks to a weather API: the worker fetches once,
writes two files, and Caddy serves them statically.

Outputs (all under `public_html/data/wind/`, and deliberately NOT .png —
Caddy serves every *.png under public_html `immutable` for a year, which
would freeze a stale grid behind a version token):
    grid.bin    Int16Array, planar: u in [0, n), v in [n, 2n),
                0.01 m/s per unit, row 0 = -90° latitude
    meta.json   speed ramp, grid layout, source, analysis run time

The frontend (`public_html/wind-layer.js`) samples the grid at each
particle's own latitude/longitude every frame — in GEOGRAPHIC space, not
screen space — and projects through Leaflet, so a particle's flow is
correct during a pan and needs no field rebuilt on every view change.

Nothing is rewritten when the GFS cycle has not advanced — the timer runs
every 6 h but the publish is a no-op unless the analysis time changed.

Usage:
    python -m worker.windmap              # fetch, verify, write
    python -m worker.windmap --dry-run    # fetch + verify, write nothing
    python -m worker.windmap --run 2026102518   # force a GFS cycle
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger("xyzo.windmap")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "wind")

# Ramp expressed as FRACTIONS of the display range, not absolute speeds,
# so a calm day and a stormy one use the same colour sequence. The worker
# converts each stop to m/s in meta.json.
#
# The far end runs into magenta/violet on purpose: the mid-latitude jet
# is the most dramatic thing on a wind map and it should look like it —
# fast wind reads as "energy", not just "a different blue".
#
# THE LOW END IS BRIGHT ON PURPOSE (2026-11-06). It used to start at
# #0b1020 — near-black — so everything below 3.6 m/s (13 km/h) was
# painted in a colour that VANISHED against the dark satellite basemap.
# Measured on the live map at the reader's own URL: of the wind's lit
# pixels, **60 % were painted in that near-black end** (and 91 % on a
# phone). The wind was running and animating perfectly and the reader
# could not see most of it — "the wind isn't always working".
#
# This is the same defect the ocean currents had, and the same fix (the
# ramp is bright at both ends). The HUE SEQUENCE and every stop's m/s
# are unchanged — only the three darkest stops were lifted, so the key
# still reads "blue = calm, cyan/green = fast". The ramp is published
# in meta.json, so the flat map, the 3D globe, the legend and the
# export all read the SAME lifted ramp.
RAMP_STOPS = [
    (0.00, "#1d4ed8"), (0.05, "#3b82f6"), (0.12, "#38bdf8"),
    (0.20, "#0ea5e9"), (0.30, "#22d3ee"), (0.40, "#4ade80"),
    (0.50, "#a3e635"), (0.60, "#facc15"), (0.70, "#fb923c"),
    (0.80, "#f43f5e"), (0.90, "#e879f9"), (1.00, "#c026d3"),
]

# Int16 holds ±327.67 m/s at 0.01 m/s per unit; the real atmosphere tops
# out near 150 m/s, so this leaves headroom for a decode bug to fail
# loudly in verify() instead of silently clipping.
SCALE = 100

# The product the wind is published from — which IS its resolution.
#
# The wind used to be published at 1° and moved to 0.25° on 2026-11-04:
# the same GFS cycle at 1° and at 0.25° agrees exactly at nineteen of
# twenty sampled points and is **78°** out at Nairobi and **41°** out at
# Sydney, so the 1° grid could not carry the answer where the flow has
# structure finer than a degree. The product string is compared by the
# no-op, so a resolution change is never mistaken for "already
# published".
PRODUCT = "0p25"

# THE STRING THE NO-OP COMPARES AGAINST — and it is NOT `PRODUCT`.
# `write_meta` publishes it PREFIXED (`"product": f"gfs.{product}"`),
# so meta.json holds **`gfs.0p25`**, while the guard compared the bare
# `0p25`: the run_time half matched and the product half could NEVER
# match, so the skip path was dead code from the day it shipped.
#
# MEASURED 2026-11-06, after the poll went from 6 h to 15 min: over 70
# minutes `journalctl` held **zero** "already published" lines and
# **sixteen** writes — every tick decoded both components and rewrote
# grid.bin (**4,056 KB**), meta.json and the 1° pair for a cycle that
# had not moved (23:29, 23:44, … all `using GFS run 20261107 00Z`).
# The format lives in ONE function that the writer and the guard both
# call, so they cannot drift apart again — same fix in tempmap.py.
def published_product(suffix: str) -> str:
    """How a product suffix is written into meta.json (`gfs.0p25`)."""
    return f"gfs.{suffix}"


PUBLISHED_PRODUCT = published_product(PRODUCT)

# Guard rails on the absolute values. Anything outside this is a decode
# problem, not weather.
MAX_PLAUSIBLE_MS = 150.0

# Display range: the 1st..99th percentile of the speed field, snapped.
RANGE_MIN_MS = 8.0
RANGE_MAX_MS = 55.0


# ── Data ────────────────────────────────────────────────────────────────
def fetch_wind(date_str: str, cycle: str):
    """Fetch GFS 10 m u/v wind and return them in m/s.

    THE 0.25° PRODUCT, ON PURPOSE — the resolution was the last real
    accuracy limit on this overlay.

    The wind used to be published at 1° because the grid is held in the
    browser and 0.25° was thought to be too heavy for "a vector field
    whose direction barely changes across a cell". **That last part is
    wrong, and it was measured.** The SAME GFS cycle at 1° and at 0.25°,
    at twenty points:

        direction   median 0°   p90 11°   worst 78°
        speed       median 0.0 m/s        worst 4.2 m/s

    Nineteen of the twenty points agree exactly, and then Nairobi is
    **78°** out and Sydney **41°** out — the two places where the flow
    has structure finer than a degree (the Albertine convergence zone
    and the Australian sea breeze). A reader pointing at those two
    places was being told the wind blew from the north when the
    analysis said north-east. That is the "our wind direction is wrong"
    report, and no amount of verification changes it: the field was
    too coarse to carry the answer.

    The cost is 3.96 MB raw / ~2.8 MB gzipped, against 255 KB / 196 KB.
    It is paid by the readers who switch the wind layer ON, which is
    the right place to pay it. The globe's wind is a TEXTURE with no
    numbers in it, so it keeps the 1° grid — written by the SAME run
    from the SAME field, so the two cannot disagree.
    """
    from .isobars import decode_field, fetch_grib_field

    results = {}
    for short, long_name in (("10u", "UGRD"), ("10v", "VGRD")):
        # The NOMADS filter server's level token is "10_m_above_ground"
        # (with the underscore), not the eccodes shortName form
        # "10m_above_ground" — the latter 500s and forces a fallback to
        # the full 42 MB product. Same convention as "2_m_above_ground"
        # for the temperature overlay.
        grib, product = fetch_grib_field(
            date_str, cycle, long_name, "10_m_above_ground",
            f"the GFS 10 m {long_name} wind", suffixes=("0p25",),
        )
        grid, lats, lons, run_time = decode_field(grib, short, f"xyzo-{short}-")
        results[short] = (grid, product, run_time)
        log.info(
            "decoded %s %s %dx%d: %.2f..%.2f m/s (run %s)",
            long_name, short, grid.shape[0], grid.shape[1],
            float(grid.min()), float(grid.max()), run_time.isoformat(),
        )

    grid_u, product, run_time = results["10u"]
    grid_v = results["10v"][0]

    if grid_u.shape != grid_v.shape:
        raise SystemExit(
            f"[windmap] u and v grids disagree: {grid_u.shape} vs {grid_v.shape}"
        )
    return grid_u, grid_v, lats, lons, run_time, product


def coarsen_to_1deg(grid_u, grid_v, lats, lons):
    """The same field on a 1° lattice — for the globe's texture.

    A SUBSAMPLE of the 0.25° field, not a second download and not the
    GFS 1° product: one fetch, one analysis, one truth. The globe
    draws 900 streaks on a sphere and shows no numbers, so a coarse
    texture is the right thing there and the 2.8 MB is not.
    """
    step = 4  # 0.25° -> 1°
    rows = np.arange(0, len(lats), step)
    cols = np.arange(0, len(lons), step)
    return (
        np.ascontiguousarray(grid_u[np.ix_(rows, cols)]),
        np.ascontiguousarray(grid_v[np.ix_(rows, cols)]),
        lats[rows],
        lons[cols],
    )


def speed_of(grid_u, grid_v) -> np.ndarray:
    return np.hypot(grid_u, grid_v)


def verify(grid_u, grid_v, lats, lons) -> None:
    """Sanity-check the field before anything is published.

    A decode bug still produces a *plausible-looking* wind map — one
    where every particle drifts the same way is exactly what a row-scan
    inversion or a swapped u/v looks like. So these checks are about
    relationships that must hold on Earth, not absolutes.

    WHAT THESE CHECKS DO NOT CATCH: a field mirrored about the
    equator. The mid-latitudes are windier than the tropics in BOTH
    hemispheres, so a mirrored field passes every check below. The
    defence against that is structural — worker/isobars.py cross-checks
    the GRIB header's own first/last latitudes against jScansPositively
    — plus worker/wind_verify.py, which re-decodes the same cycle with
    the message's own index arithmetic and compares the published grid
    with it cell by cell.
    """
    if grid_u.shape != (len(lats), len(lons)):
        raise SystemExit(f"[windmap] grid shape {grid_u.shape} does not match "
                         f"the axes ({len(lats)}, {len(lons)})")

    if grid_u.shape != grid_v.shape:
        raise SystemExit(f"[windmap] u {grid_u.shape} and v {grid_v.shape} differ")

    speed = speed_of(grid_u, grid_v)
    hi = float(speed.max())
    if hi > MAX_PLAUSIBLE_MS:
        raise SystemExit(f"[windmap] max wind {hi:.1f} m/s is not air on Earth — "
                         f"refusing to publish")

    if not np.isfinite(grid_u).all() or not np.isfinite(grid_v).all():
        raise SystemExit("[windmap] NaN/Inf in the wind field — refusing to publish")

    def band(lat_min, lat_max):
        rows = (lats >= lat_min) & (lats <= lat_max)
        if not rows.any():
            raise SystemExit(f"[windmap] no grid rows in {lat_min}..{lat_max}")
        return speed[rows].mean()

    # 1. The trade winds blow through the doldrums: the tropics must be
    #    the calmest band on the planet, and the mid-latitude westerlies
    #    must outrun them.
    tropics = band(-15.0, 15.0)
    midlat = max(band(35.0, 55.0), band(-55.0, -35.0))
    if midlat <= tropics:
        raise SystemExit(
            f"[windmap] mid-latitudes ({midlat:.2f} m/s) must be windier than "
            f"the tropics ({tropics:.2f} m/s) — got a mirrored or scrambled field"
        )

    # 2. Not everything may point the same way. The magnitude of the mean
    #    UNIT vector is 1.0 when every cell is identical and near 0 when
    #    directions are scattered; a genuine global field is well under.
    mean_u = grid_u.mean()
    mean_v = grid_v.mean()
    mean_speed = float(speed.mean())
    coherence = math.hypot(float(mean_u), float(mean_v)) / max(mean_speed, 1e-6)
    if coherence > 0.9:
        raise SystemExit(
            f"[windmap] direction coherence {coherence:.3f} — every cell points "
            f"the same way, which means u and v are not independent fields"
        )

    # 3. The trades are easterly (negative u) in the tropics, and the
    #    westerlies are positive u at mid-latitudes. Both at once is the
    #    signature of a correctly ordered GFS field.
    trop_rows = (lats >= -20.0) & (lats <= 20.0)
    trade_u = float(grid_u[trop_rows].mean())
    mid_rows = (lats >= 35.0) & (lats <= 55.0)
    westerly_u = float(grid_u[mid_rows].mean())
    if trade_u > 0 and westerly_u < 0:
        raise SystemExit(
            f"[windmap] trades are westerly ({trade_u:.2f}) and the mid-latitudes "
            f"are easterly ({westerly_u:.2f}) — u is sign-flipped"
        )

    log.info(
        "verified: mean %.2f m/s, max %.1f m/s, coherence %.3f, "
        "tropics %.2f, mid-lat %.2f",
        mean_speed, hi, coherence, tropics, midlat,
    )


# ── Writing ─────────────────────────────────────────────────────────────
def choose_range(speed) -> tuple[float, float]:
    """Display range from the field's own 1st..99th percentile.

    A fixed 0..50 m/s bar spends most of its colour on speeds that never
    occur, so a typical day renders as one pale blue. Trimming to the
    distribution buys visible contrast per step.
    """
    flat = np.asarray(speed, dtype=np.float64).ravel()
    lo_p, hi_p = (float(v) for v in np.percentile(flat, [1.0, 99.0]))

    lo = 0.0
    hi = float(np.clip(round(hi_p), RANGE_MIN_MS, RANGE_MAX_MS))
    if hi - lo < RANGE_MIN_MS:
        hi = RANGE_MIN_MS
    return lo, hi


def write_grid(grid_u, grid_v, lats, lons, path: str) -> None:
    """Write the grid as little-endian Int16, planar, 0.01 m/s per unit.

    Planar rather than interleaved: the browser reads a whole component
    at a time, and splitting the buffer in half is a single length/2
    rather than a stride loop. Row 0 is the southernmost latitude,
    column 0 is longitude 0 — the same convention as decode_field and
    as the temperature grid.

    **WRITTEN TO A TEMP FILE AND RENAMED — and the rename is the point.**
    `numpy.tofile(path)` opens in "wb", which TRUNCATES, and the second
    component was then APPENDED to it — so for the whole duration of the
    write any concurrent reader saw a HALF grid, at exactly n*2 bytes.
    A browser fetch landing in that window gets
    `buf.byteLength !== n*4`, `load()` throws, `onAdd`'s catch sets
    `state.enabled = false` and **the wind never starts**. Worse, that
    truncated response is a perfectly ordinary 200 with the right
    headers, so it is CACHEABLE — the browser (and the service worker's
    data cache) keep serving half a grid for the rest of the day, and
    the only thing that fixes it is bypassing the cache: which is
    exactly the "the wind only shows after a hard refresh" report.
    `os.replace()` is atomic within a filesystem, so a reader now sees
    either the previous complete file or the new complete one.
    """
    u16 = np_round_to_int16(grid_u, "u")
    v16 = np_round_to_int16(grid_v, "v")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        u16.tofile(tmp)
        with open(tmp, "ab") as fh:
            v16.tofile(fh)
        os.replace(tmp, path)
    finally:
        # A crash mid-write must not leave a half file beside the real
        # one for something else to trip over.
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass
    total = u16.nbytes + v16.nbytes
    log.info("wrote %s (%d int16 x2, %.0f KB)", path, u16.size, total / 1024)


def np_round_to_int16(grid, name: str):
    scaled = np.rint(np.asarray(grid, dtype=np.float64) * SCALE)
    if scaled.min() < -32768 or scaled.max() > 32767:
        raise SystemExit(f"[windmap] {name} does not fit int16")
    return scaled.astype("<i2")


def write_meta(speed, grid_u, grid_v, lats, lons, run_time,
               product: str, path: str, grid_file: str = "grid.bin",
               note: str | None = None) -> None:
    lo, hi = choose_range(speed)
    span = hi - lo

    meta = {
        "source": "NOAA NCEP GFS",
        "variable": "10 m wind",
        "units": "m/s",
        "product": published_product(product),
        "run_time": run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "US Government work (public domain)",
        # Leaflet prints this in the bottom-right corner of the map; a
        # published meta.json without it is a licence breach the licence
        # test (data-licences.bun.test.js) cannot see past. It belongs
        # HERE, not in the artifact: this worker rewrites meta.json every
        # cycle, so hand-editing the published file is wiped on the next
        # run (which is exactly what happened on 2026-10-29).
        "attribution": "NOAA NCEP GFS — 10 m wind",
        "grid": {
            "file": grid_file,
            "cols": int(len(lons)),
            "rows": int(len(lats)),
            "lat_min": float(lats[0]),
            "lat_max": float(lats[-1]),
            "lon_min": float(lons[0]),
            "lat_step": float(round(abs(lats[1] - lats[0]), 6)),
            "lon_step": float(round(abs(lons[1] - lons[0]), 6)),
            "scale": SCALE,
            # Planar: u occupies [0, rows*cols), v occupies [n, 2n).
            "layout": "planar_uv",
        },
        "range_ms": [lo, hi],
        "observed_ms": [round(float(speed.min()), 2), round(float(speed.max()), 2)],
        "observed_kmh": [round(float(speed.min()) * 3.6, 1),
                         round(float(speed.max()) * 3.6, 1)],
        "mean_ms": round(float(speed.mean()), 2),
        # Stops in absolute m/s, converted from the fractional ramp.
        "ramp": [
            {"ms": round(lo + frac * span, 2),
             "kmh": round((lo + frac * span) * 3.6, 1),
             "rgb": rgb}
            for frac, rgb in RAMP_STOPS
        ],
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if note:
        meta["note"] = note
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(meta, fh, indent=1)
        fh.write("\n")
    log.info("wrote %s (ramp %.1f..%.1f m/s)", path, lo, hi)


def current_run_time() -> str | None:
    """The run_time already published, so an unchanged cycle is a no-op.

    The timer fires every 15 min and GFS analysis runs slip, and a
    re-publish of the same analysis would rewrite 4 MB and bust every
    client's cache for data that never moved. Comparing run_time makes
    the publish idempotent.
    """
    return _published_meta().get("run_time")


def current_product() -> str | None:
    """The product already published — which IS the resolution.

    The cycle is not the only thing that can change: on 2026-11-04 the
    wind moved from the 1° product to the 0.25° one, and the no-op
    compared the CYCLE alone — so the new resolution was never
    published, because the cycle had not moved. The product string
    (`gfs.0p25`) names the resolution, so comparing it catches that
    too.
    """
    return _published_meta().get("product")


def _published_meta() -> dict:
    path = os.path.join(OUT_DIR, "meta.json")
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def expected_stamp(date_str: str, cycle: str) -> str:
    """The analysis validity time of a GFS cycle, as meta.json stores it.

    The f000 product is the analysis for its own cycle, so the validity
    time is simply that cycle's date and hour — no GRIB decode required
    to know whether anything has changed.
    """
    d = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    return f"{d}T{cycle.zfill(2)}:00:00Z"


# ── Entry point ─────────────────────────────────────────────────────────
def run(dry_run: bool = False, force_run: str | None = None) -> int:
    from .isobars import find_latest_run

    run_ref = find_latest_run(force_run)
    if run_ref is None:
        log.error("no GFS run found on NOMADS")
        return 1
    date_str, cycle = run_ref
    log.info("using GFS run %s %sZ", date_str, cycle)

    # Cheapest possible "nothing changed" path: compare the cycle AND
    # the product against what is already published BEFORE downloading
    # ~1 MB of GRIB. The timer fires every 15 min and GFS runs slip, so
    # an early tick would otherwise re-fetch, re-verify and rewrite the
    # same file — busting every client cache for data that never moved.
    #
    # The PRODUCT is part of the comparison because the cycle is not the
    # only thing that can change: the resolution moved from 1° to 0.25°
    # on 2026-11-04, and a cycle-only comparison would have declared
    # "already published" and never shipped the new grid.
    if not dry_run and force_run is None:
        pre_stamp = expected_stamp(date_str, cycle)
        if current_run_time() == pre_stamp and current_product() == PUBLISHED_PRODUCT:
            log.info("analysis %s (%s) already published — skipping the fetch",
                     pre_stamp, PRODUCT)
            return 0

    grid_u, grid_v, lats, lons, run_time, product = fetch_wind(date_str, cycle)
    verify(grid_u, grid_v, lats, lons)
    speed = speed_of(grid_u, grid_v)

    stamp = run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not dry_run and force_run is None:
        existing = current_run_time()
        if existing == stamp and current_product() == PUBLISHED_PRODUCT:
            log.info("analysis %s already published — nothing changed", stamp)
            return 0

    if dry_run:
        lo, hi = choose_range(speed)
        print(f"run            : {date_str} {cycle}Z")
        print(f"analysis time  : {run_time.isoformat()}")
        print(f"grid           : {grid_u.shape[0]}x{grid_u.shape[1]}")
        print(f"speed          : {speed.min():.1f} .. {speed.max():.1f} m/s")
        print(f"               : {speed.min()*3.6:.1f} .. {speed.max()*3.6:.1f} km/h")
        print(f"display range  : {lo:.1f} .. {hi:.1f} m/s")
        return 0

    write_grid(grid_u, grid_v, lats, lons, os.path.join(OUT_DIR, "grid.bin"))
    write_meta(speed, grid_u, grid_v, lats, lons, run_time, product,
               os.path.join(OUT_DIR, "meta.json"))

    # The globe's texture: the SAME field on a 1° lattice, written by
    # the same run from the same fetch. The globe draws 900 streaks on a
    # sphere and shows no numbers, so a coarse texture is right there —
    # and it keeps the 2.8 MB off every globe visit.
    cu, cv, clats, clons = coarsen_to_1deg(grid_u, grid_v, lats, lons)
    write_grid(cu, cv, clats, clons, os.path.join(OUT_DIR, "grid-1deg.bin"))
    write_meta(speed_of(cu, cv), cu, cv, clats, clons, run_time, product,
               os.path.join(OUT_DIR, "meta-1deg.json"),
               grid_file="grid-1deg.bin",
               note="The 0.25° field subsampled to 1° — the globe's texture. "
                    "The flat map reads grid.bin (0.25°).")

    print(f"wind overlay built for {run_time.isoformat()} "
          f"({speed.min():.1f}..{speed.max():.1f} m/s, "
          f"mean {speed.mean():.1f})")
    return 0


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="fetch + verify only")
    parser.add_argument("--run", help="force a GFS cycle, YYYYMMDDHH")
    args = parser.parse_args()
    try:
        code = run(dry_run=args.dry_run, force_run=args.run)
    except RuntimeError as exc:
        # Same posture as the isobar worker: a missing optional
        # dependency must not make the timer flap.
        log.error("wind overlay unavailable: %s", exc)
        code = 0

    # Skip interpreter teardown — eccodes + psycopg are not guaranteed to
    # finalise in a safe order (see worker/isobars.py).
    import sys

    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    raise SystemExit(main())
