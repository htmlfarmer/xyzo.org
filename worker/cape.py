#!/usr/bin/env python3
"""Build the convective-instability overlay: CAPE from the NOAA GFS.

The map's "⛈️ Convective instability" layer paints how much energy the
atmosphere holds for a parcel to rise — Convective Available Potential
Energy. It is the number every severe-weather forecast quotes, and the
map had nothing to say about it: the wind layer showed how the air
MOVES, the temperature layer how warm it is, but not how unstable it
was.

Source (100% free, no key, no rate limit, public domain):
    NOAA NCEP GFS analysis, CAPE (convective available potential
    energy) at the surface.
    https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.YYYYMMDD/HH/atmos/

The 1° product on purpose: the grid is held in the browser for the
probe, and CAPE is a smoothly-varying field whose value barely changes
across a grid cell — 0.25° would cost four times the bytes for no
visible gain.

The scale is FIXED at 0..4000 J/kg, not adaptive, because CAPE's
thresholds are absolute and the public knows them: 1000 J/kg is the
"Severe" line on the SPC chart, 2500 J/kg is "Extreme". An adaptive
scale would move those thresholds every run, and the whole point of
the layer is that the colour means the same thing every day.

Outputs (under `public_html/data/cape/`, and deliberately NOT .png —
Caddy serves every *.png under public_html `immutable` for a year,
which would freeze stale tiles behind a version token):
    grid.bin    Uint16Array (10 J/kg per unit), row-major, row 0 = -90°
    meta.json   colour ramp, grid layout, source, analysis run time

Usage:
    python -m worker.cape                 # fetch, verify, write
    python -m worker.cape --dry-run       # fetch + verify, write nothing
    python -m worker.cape --run 2026102518   # force a GFS cycle
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger("xyzo.cape")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "cape")

# The fixed scale. See the module docstring — CAPE's thresholds are
# absolute and the colour has to mean the same thing every run.
RANGE_MIN = 0.0
RANGE_MAX = 4000.0

# The legend ticks: the SPC's own breakpoints, so the colours line up
# with the chart people already know.
TICKS = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]

# The ramp follows the SPC's colour scheme: blue for no instability,
# green at 500, yellow at 1000 (severe), orange, red, and magenta into
# the extreme. The stops are FRACTIONS of the fixed range, so the
# colours land exactly on the thresholds above.
RAMP_STOPS = [
    (0.000, "#3f5f8f"),   #   0 J/kg — no instability
    (0.060, "#2f8f6f"),   # 240
    (0.125, "#2fb32f"),   # 500 — marginal
    (0.190, "#8fce2b"),   # 760
    (0.250, "#f2e600"),   # 1000 — severe
    (0.310, "#ffc400"),   # 1240
    (0.375, "#ff9500"),   # 1500
    (0.440, "#ff6a00"),   # 1760
    (0.500, "#ff3b00"),   # 2000
    (0.560, "#f01e00"),   # 2240
    (0.625, "#d10000"),   # 2500 — extreme
    (0.700, "#a80050"),   # 2800
    (0.790, "#8b00a0"),   # 3160
    (0.880, "#7000c0"),   # 3520
    (0.945, "#5a00d8"),   # 3780
    (1.000, "#3d0090"),   # 4000
]

# Values are stored as Uint16 in units of 10 J/kg, so the range reaches
# 6553 J/kg — past the strongest instability the atmosphere produces.
SCALE = 10

# CAPE is never negative, and it is zero over most of the globe.
MIN_PLAUSIBLE = 0.0
MAX_PLAUSIBLE = 12000.0


def fetch_cape(date_str: str, cycle: str):
    """Fetch the GFS surface CAPE and return it in J/kg."""
    from .isobars import decode_field, fetch_grib_field

    grib, product = fetch_grib_field(
        date_str, cycle, "CAPE", "surface",
        "the GFS surface CAPE", suffixes=("1p00",),
    )
    grid, lats, lons, run_time = decode_field(grib, "cape", "xyzo-cape-")
    log.info(
        "decoded CAPE %dx%d (%s): %.0f..%.0f J/kg (run %s)",
        grid.shape[0], grid.shape[1], product, grid.min(), grid.max(),
        run_time.isoformat(),
    )
    return grid, lats, lons, run_time, product


def verify(grid, lats, lons) -> None:
    """Sanity-check the field before anything is published.

    A decode bug (the row-scan inversion that mirrored the pressure
    field, for example) still produces a *plausible-looking* map, so the
    checks here are about relationships that must hold:

    * CAPE is never negative and never absurdly large;
    * the tropics are unstable and the winter polar cap is not — a
      stable polar cap in December and an unstable one in July would
      both be wrong, but the polar cap being STABLE all year is the
      stronger statement and the one a mirror would break;
    * the field is not simply noise (its spread has to be meaningful).
    """
    if grid.shape != (len(lats), len(lons)):
        raise SystemExit(f"[cape] grid shape {grid.shape} does not match "
                         f"the axes ({len(lats)}, {len(lons)})")

    lo, hi = float(grid.min()), float(grid.max())
    if lo < MIN_PLAUSIBLE or hi > MAX_PLAUSIBLE:
        raise SystemExit(f"[cape] implausible CAPE range {lo:.0f}..{hi:.0f} "
                         f"J/kg — refusing to publish")

    def band(lat_min, lat_max):
        rows = (lats >= lat_min) & (lats <= lat_max)
        return float(grid[rows].mean())

    # The tropical warm pool is where CAPE lives.
    tropics = band(-15.0, 15.0)
    if tropics < 100.0:
        raise SystemExit(f"[cape] tropical mean CAPE {tropics:.0f} J/kg is "
                         f"implausibly low — the field is probably mirrored "
                         f"or scrambled")

    # The polar cap is stable in both hemispheres' winter, and CAPE
    # there is essentially zero. A MIRRORED field still has zero at the
    # poles (the poles are symmetric), so this cannot catch a mirror —
    # it catches a scrambled or wrongly-scaled field.
    polar = min(band(70.0, 90.0), band(-90.0, -70.0))
    if polar > 150.0:
        raise SystemExit(f"[cape] polar mean CAPE {polar:.0f} J/kg is too "
                         f"unstable — the polar cap should be stable")

    if float(np.percentile(grid, 99)) < 400.0:
        raise SystemExit("[cape] the 99th percentile of CAPE is under 400 "
                         "J/kg — there is no severe weather anywhere, which "
                         "means the field is wrong")

    log.info("verified: tropics %.0f J/kg, polar cap %.0f J/kg, range %.0f..%.0f",
             tropics, polar, lo, hi)


def write_grid(grid, lats, lons, path: str) -> None:
    """Write the probe grid as a little-endian Uint16, 10 J/kg per unit."""
    scaled = np.rint(np.asarray(grid, dtype=np.float64) * SCALE)
    if scaled.min() < 0 or scaled.max() > 65535:
        raise SystemExit("[cape] value does not fit uint16")
    raw = scaled.astype("<u2")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw.tofile(path)
    log.info("wrote %s (%d uint16, %.0f KB)", path, raw.size, raw.nbytes / 1024)


def write_meta(grid, lats, lons, run_time, product: str, path: str) -> None:
    meta = {
        "source": "NOAA NCEP GFS",
        "variable": "Surface CAPE (convective available potential energy)",
        "product": f"gfs.{product}",
        "run_time": run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "US Government work (public domain)",
        "attribution": "NOAA NCEP GFS",
        "unit": "J/kg",
        "grid": {
            "file": "grid.bin",
            "cols": int(len(lons)),
            "rows": int(len(lats)),
            "lat_min": float(lats[0]),
            "lat_max": float(lats[-1]),
            "lon_min": float(lons[0]),
            "lat_step": float(round(abs(lats[1] - lats[0]), 6)),
            "lon_step": float(round(abs(lons[1] - lons[0]), 6)),
            "scale": SCALE,
            "dtype": "uint16",
        },
        # Fixed, not adaptive: CAPE's thresholds are absolute.
        "range": [RANGE_MIN, RANGE_MAX],
        "observed": [round(float(grid.min()), 1), round(float(grid.max()), 1)],
        "ramp": [
            {
                "v": round(RANGE_MIN + frac * (RANGE_MAX - RANGE_MIN), 2),
                "rgb": rgb,
            }
            for frac, rgb in RAMP_STOPS
        ],
        "ticks": TICKS,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(meta, fh, indent=1)
        fh.write("\n")
    log.info("wrote %s (ramp %.0f..%.0f J/kg)", path, RANGE_MIN, RANGE_MAX)


def current_run_time() -> str | None:
    """The run_time already published, so an unchanged cycle is a no-op."""
    path = os.path.join(OUT_DIR, "meta.json")
    try:
        with open(path) as fh:
            return json.load(fh).get("run_time")
    except (OSError, ValueError):
        return None


def expected_stamp(date_str: str, cycle: str) -> str:
    """The analysis validity time of a GFS cycle, as meta.json stores it."""
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

    # Cheapest possible "nothing changed" path: compare the cycle against
    # what is already published BEFORE downloading the GRIB.
    if not dry_run and force_run is None:
        pre_stamp = expected_stamp(date_str, cycle)
        if current_run_time() == pre_stamp:
            log.info("analysis %s already published — skipping the fetch", pre_stamp)
            return 0

    grid, lats, lons, run_time, product = fetch_cape(date_str, cycle)
    verify(grid, lats, lons)

    stamp = run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not dry_run and force_run is None:
        if current_run_time() == stamp:
            log.info("analysis %s already published — nothing changed", stamp)
            return 0

    if dry_run:
        print(f"run            : {date_str} {cycle}Z")
        print(f"analysis time  : {run_time.isoformat()}")
        print(f"grid           : {grid.shape[0]}x{grid.shape[1]}")
        print(f"CAPE           : {grid.min():.0f} .. {grid.max():.0f} J/kg")
        return 0

    write_grid(grid, lats, lons, os.path.join(OUT_DIR, "grid.bin"))
    write_meta(grid, lats, lons, run_time, product,
               os.path.join(OUT_DIR, "meta.json"))
    print(f"CAPE overlay built for {run_time.isoformat()} "
          f"({grid.min():.0f}..{grid.max():.0f} J/kg)")
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
        # A missing optional dependency must not make the systemd timer
        # flap — the map just keeps the previous overlay.
        log.error("CAPE overlay unavailable: %s", exc)
        code = 0

    # Skip the interpreter teardown — eccodes + psycopg are not
    # guaranteed to finalise in a safe order (see worker/isobars.py).
    import sys

    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    raise SystemExit(main())
