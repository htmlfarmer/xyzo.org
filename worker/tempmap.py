#!/usr/bin/env python3
"""Build the temperature overlay: the probe grid + the colour ramp meta.

The map's "🌡️ Temperature" layer paints a filled colour field over the
basemap and lets you read a point in **both °F and °C**.

There is no free isobar-style *tile* service for temperature, and the
NASA layers we already show are colour composites whose ramp we do not
control — so the field comes from the NOAA NCEP GFS analysis (2 m air
temperature), the same source and the same 6-hourly cycle as the
pressure lines. One ~48 KB request per run.

Outputs (all under `public_html/data/temp/`, and deliberately NOT .png —
Caddy serves every *.png under public_html `immutable` for a year, which
would freeze stale tiles behind a version token):
    grid.bin    Int16Array (0.1 °C), row-major, row 0 = -90° latitude
    meta.json   colour ramp, grid layout, source, analysis run time

The frontend (`public_html/temp-layer.js`) fetches both, paints the
field into a Mercator-warped canvas, and hands it to `L.imageOverlay`.
That means there is no tile pyramid and no build stamp to keep in sync.

Usage:
    python -m worker.tempmap              # fetch, verify, write
    python -m worker.tempmap --dry-run    # fetch + verify, write nothing
    python -m worker.tempmap --run 2026102518   # force a GFS cycle
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger("xyzo.tempmap")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "temp")

# The ramp is defined as FRACTIONS of the chosen range, not absolute
# temperatures, so the same colour sequence is used whatever the range
# turns out to be. The worker converts each stop to degrees when it
# writes meta.json, and the frontend interpolates between those.
#
# The ends are near-black so a saturated extreme still reads as "the
# coldest / hottest on the map", and the middle sweeps the full spectrum
# so neighbouring temperatures differ visibly.
RAMP_STOPS = [
    (0.00, "#0a0316"), (0.06, "#1e0b3f"), (0.12, "#35147a"),
    (0.18, "#4c1d95"), (0.25, "#4338ca"), (0.32, "#2563eb"),
    (0.39, "#0ea5e9"), (0.46, "#22d3ee"), (0.52, "#2dd4bf"),
    (0.57, "#4ade80"), (0.63, "#a3e635"), (0.69, "#facc15"),
    (0.75, "#fbbf24"), (0.81, "#f97316"), (0.87, "#ef4444"),
    (0.92, "#dc2626"), (0.97, "#991b1b"), (1.00, "#450a0a"),
]

# Guard rails on the adaptive range: narrower than this and a cold (or
# hot) week saturates half the map; wider and the mid-latitudes collapse
# into one colour, which is what made the fixed -80..50 scale look flat.
RANGE_MIN_SPAN_C = 60
RANGE_MAX_SPAN_C = 130

# Values are stored as Int16 in tenths of a degree, so the range must
# stay inside int16 — which the real atmosphere never comes near.
SCALE = 10

# The product the temperature is published from — which IS its
# resolution. The temperature moved from 1° to 0.25° on 2026-11-04 so
# that it matches the isobars, which have always been 0.25°. The
# product string is compared by the no-op, so a resolution change is
# never mistaken for "already published".
PRODUCT = "0p25"

# THE STRING THE NO-OP COMPARES AGAINST — and it is NOT `PRODUCT`.
# `write_meta` publishes it PREFIXED (`"product": f"gfs.{product}"`),
# so meta.json holds **`gfs.0p25`**, while the guard compared the bare
# `0p25`: the run_time half matched and the product half could NEVER
# match, so the skip path was dead code from the day it shipped.
#
# MEASURED 2026-11-06, after the poll went from 6 h to 15 min: two
# consecutive ticks at 23:29 and 23:44 BOTH fetched the GRIB (873 KB),
# decoded, verified and rewrote grid.bin + meta.json + the 1° pair for
# a cycle that had not moved — and `journalctl` held **zero** "already
# published" lines. The format lives in ONE function that the writer
# and the guard both call, so they cannot drift apart again.
def published_product(suffix: str) -> str:
    """How a product suffix is written into meta.json (`gfs.0p25`)."""
    return f"gfs.{suffix}"


PUBLISHED_PRODUCT = published_product(PRODUCT)


def f_of(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def choose_range(grid_c):
    """Pick the ramp's ends from the field itself.

    A fixed -80..50 C bar spends 130 C of colour on a day whose range is
    only ~93 C, so most of the map is a thin slice of the spectrum and
    neighbouring temperatures look the same. Trimming to the 2nd and
    98th percentile and rounding to 10 C costs almost nothing (1.7 % of
    the field saturates at an end) and buys ~1.6x the colour change per
    degree.

    Returns (lo, hi) in Celsius.
    """
    lo_p, hi_p = np_percentile(grid_c, [2.0, 98.0])
    lo = math.floor(lo_p / 10.0) * 10
    hi = math.ceil(hi_p / 10.0) * 10

    while hi - lo > RANGE_MAX_SPAN_C:
        lo += 10
        hi -= 10
    while hi - lo < RANGE_MIN_SPAN_C:
        lo -= 10
        hi += 10
    return float(lo), float(hi)


def ticks_for_range(lo: float, hi: float) -> list[int]:
    """Whole-degree ticks for the legend.

    Anchored at the range's own low end and stepping by 20 °C (10 when
    the whole range is that narrow), so the interior ticks stay evenly
    spaced on the bar; the high end is always labelled too, even when it
    lands off the step.
    """
    step = 10 if (hi - lo) <= 60 else 20
    ticks = list(range(int(lo), int(hi) + 1, step))
    if int(hi) not in ticks:
        ticks.append(int(hi))
    return sorted(set(ticks))


def np_percentile(arr, qs):
    flat = np.asarray(arr, dtype=np.float64).ravel()
    return [float(v) for v in np.percentile(flat, qs)]


# ── Data ────────────────────────────────────────────────────────────────
def fetch_temperature(date_str: str, cycle: str):
    """Fetch the GFS 2 m air temperature and return it in °C.

    THE 0.25° PRODUCT, for the same reason the wind moved to it on
    2026-11-04: the isobars have always been published at 0.25°, so a
    1° temperature beside them was the odd one out — and the overlay
    is a COLOUR FIELD, so its resolution is what the reader sees.

    Measured, the same GFS cycle at 1° and at 0.25°: the temperature
    agrees to a median of 0.0 °C and is at worst **2.4 °C** out (at
    Sydney, where the sea and the continent meet). The cost is 1.98 MB
    raw / ~0.7 MB gzipped against 127 KB / 68 KB — paid only by the
    readers who switch the temperature overlay ON.

    The globe bakes the temperature into an equirectangular picture, so
    it keeps the 1° copy: the SAME field, subsampled, written by the
    same run.
    """
    from .isobars import decode_field, fetch_grib_field

    grib, product = fetch_grib_field(
        date_str, cycle, "TMP", "2_m_above_ground",
        "the GFS 2 m temperature", suffixes=("0p25",),
    )
    grid_k, lats, lons, run_time = decode_field(grib, "2t", "xyzo-tmp-")
    log.info(
        "decoded 2m temperature %dx%d (%s): %.1f..%.1f C (run %s)",
        grid_k.shape[0], grid_k.shape[1], product,
        grid_k.min() - 273.15, grid_k.max() - 273.15, run_time.isoformat(),
    )
    return grid_k - 273.15, lats, lons, run_time, product


def verify(grid_c, lats, lons) -> None:
    """Sanity-check the field before anything is published.

    A decode bug (the row-scan inversion that mirrored the pressure
    field, for example) still produces a *plausible-looking* map — so the
    checks here are about relationships that must hold, not absolutes:
    the equator has to be warmer than the poles, and the numbers have to
    be in a range air on Earth can reach.
    """
    if grid_c.shape != (len(lats), len(lons)):
        raise SystemExit(f"[tempmap] grid shape {grid_c.shape} does not match "
                         f"the axes ({len(lats)}, {len(lons)})")

    lo, hi = float(grid_c.min()), float(grid_c.max())
    if not (-90.0 <= lo <= 0.0) or not (0.0 <= hi <= 70.0):
        raise SystemExit(f"[tempmap] implausible 2m temperature range "
                         f"{lo:.1f}..{hi:.1f} C — refusing to publish")

    def band(lat_min, lat_max):
        rows = (lats >= lat_min) & (lats <= lat_max)
        return float(grid_c[rows].mean())

    equator = band(-10.0, 10.0)
    poles = min(band(70.0, 90.0), band(-90.0, -70.0))
    if equator < 20.0:
        raise SystemExit(f"[tempmap] equator mean {equator:.1f} C is too cold")
    if poles > -15.0:
        raise SystemExit(f"[tempmap] polar mean {poles:.1f} C is too warm")
    if equator - poles < 30.0:
        raise SystemExit(f"[tempmap] equator ({equator:.1f}) must be far "
                         f"warmer than the poles ({poles:.1f})")
    log.info("verified: equator %.1f C, poles %.1f C, range %.1f..%.1f",
             equator, poles, lo, hi)


# ── Writing ─────────────────────────────────────────────────────────────
def write_grid(grid_c, lats, lons, path: str) -> None:
    """Write the probe grid as a little-endian Int16, 0.1 °C per unit.

    Row 0 is the southernmost latitude and column 0 is longitude 0, which
    is what `decode_field` already produces — the frontend indexes it
    directly.

    **Written to a temp file and renamed.** `numpy.tofile(path)` opens in
    "wb" and TRUNCATES first, so a browser fetch landing inside the write
    gets a SHORT file — and `temp-layer.js` throws on exactly that
    (`grid is N values, expected M`), which leaves the overlay blank for
    that reader until they happen to bypass their cache. Same failure and
    same fix as windmap.write_grid: a reader now sees the old complete
    file or the new complete one, never a half-written one.
    """
    raw = np_round_to_int16(grid_c)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        raw.tofile(tmp)
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass
    log.info("wrote %s (%d int16, %.0f KB)", path, raw.size, raw.nbytes / 1024)


def np_round_to_int16(grid_c):
    scaled = np.rint(np.asarray(grid_c, dtype=np.float64) * SCALE)
    if scaled.min() < -32768 or scaled.max() > 32767:
        raise SystemExit("[tempmap] value does not fit int16")
    return scaled.astype("<i2")


def write_meta(grid_c, lats, lons, run_time, product: str, path: str,
               grid_file: str = "grid.bin", note: str | None = None) -> None:
    lo, hi = choose_range(grid_c)
    span = hi - lo

    meta = {
        "source": "NOAA NCEP GFS",
        "variable": "2 m air temperature",
        "product": published_product(product),
        "run_time": run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "US Government work (public domain)",
        # See worker/windmap.py: this worker rewrites meta.json on every
        # cycle, so the attribution has to be emitted HERE or the next
        # run wipes a hand-patched file and the map loses its credit.
        "attribution": "NOAA NCEP GFS — 2 m air temperature",
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
        },
        # Adaptive: the ends are chosen from this run's own field, so
        # nearby temperatures differ visibly instead of sharing a thin
        # slice of a fixed bar. See choose_range().
        "range_c": [lo, hi],
        "range_f": [round(f_of(lo), 1), round(f_of(hi), 1)],
        "observed_c": [round(float(grid_c.min()), 1), round(float(grid_c.max()), 1)],
        "observed_f": [round(f_of(float(grid_c.min())), 1), round(f_of(float(grid_c.max())), 1)],
        # Stops in absolute degrees, converted from the fractional ramp.
        "ramp": [
            {
                "c": round(lo + frac * span, 2),
                "f": round(f_of(lo + frac * span), 1),
                "rgb": rgb,
            }
            for frac, rgb in RAMP_STOPS
        ],
        "ticks": [{"c": t, "f": round(f_of(t), 1)} for t in ticks_for_range(lo, hi)],
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if note:
        meta["note"] = note
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(meta, fh, indent=1)
        fh.write("\n")
    log.info("wrote %s (ramp %.0f..%.0f C)", path, lo, hi)


# ── Entry point ─────────────────────────────────────────────────────────
def current_run_time() -> str | None:
    """The run_time already published, so an unchanged cycle is a no-op.

    The timer fires every 15 min but GFS analysis runs slip, and a
    re-publish of the same analysis would rewrite the grid and bust
    every client's cache for no reason. Comparing run_time makes the
    publish idempotent — the same guard the wind overlay has.
    """
    return _published_meta().get("run_time")


def current_product() -> str | None:
    """The product already published — which IS the resolution.

    The cycle is not the only thing that can change: on 2026-11-04 the
    temperature moved from the 1° product to the 0.25° one, and a
    cycle-only comparison would have declared "already published" and
    never shipped the new grid.
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
    # the GRIB. The timer fires every 15 min and GFS runs slip, so an
    # early tick would otherwise re-fetch, re-verify and rewrite the
    # same files — busting every client cache for data that never
    # moved.
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

    grid_c, lats, lons, run_time, product = fetch_temperature(date_str, cycle)
    verify(grid_c, lats, lons)

    stamp = run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not dry_run and force_run is None:
        if current_run_time() == stamp and current_product() == PUBLISHED_PRODUCT:
            log.info("analysis %s already published — nothing changed", stamp)
            return 0

    if dry_run:
        print(f"run            : {date_str} {cycle}Z")
        print(f"analysis time  : {run_time.isoformat()}")
        print(f"grid           : {grid_c.shape[0]}x{grid_c.shape[1]}")
        print(f"range          : {grid_c.min():.1f} .. {grid_c.max():.1f} C")
        print(f"               : {f_of(grid_c.min()):.1f} .. {f_of(grid_c.max()):.1f} F")
        return 0

    write_grid(grid_c, lats, lons, os.path.join(OUT_DIR, "grid.bin"))
    write_meta(grid_c, lats, lons, run_time, product,
               os.path.join(OUT_DIR, "meta.json"))

    # The globe's picture: the SAME field on a 1° lattice, written by
    # the same run from the same fetch. The globe bakes the temperature
    # into an equirectangular image, so a coarse lattice is right there
    # — and it keeps the 0.7 MB off every globe visit.
    rows = np.arange(0, len(lats), 4)
    cols = np.arange(0, len(lons), 4)
    write_grid(np.ascontiguousarray(grid_c[np.ix_(rows, cols)]),
               lats[rows], lons[cols],
               os.path.join(OUT_DIR, "grid-1deg.bin"))
    write_meta(np.ascontiguousarray(grid_c[np.ix_(rows, cols)]),
               lats[rows], lons[cols], run_time, product,
               os.path.join(OUT_DIR, "meta-1deg.json"),
               grid_file="grid-1deg.bin",
               note="The 0.25° field subsampled to 1° — the globe's bake. "
                    "The flat map reads grid.bin (0.25°).")
    print(f"temperature overlay built for {run_time.isoformat()} "
          f"({grid_c.min():.1f}..{grid_c.max():.1f} C / "
          f"{f_of(grid_c.min()):.1f}..{f_of(grid_c.max()):.1f} F)")
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
        log.error("temperature overlay unavailable: %s", exc)
        code = 0

    # Skip interpreter teardown — eccodes + psycopg are not guaranteed to
    # finalise in a safe order (see worker/isobars.py).
    import sys

    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    raise SystemExit(main())
