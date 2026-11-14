#!/usr/bin/env python3
"""Build the moisture-transport overlay: IVT, computed from the GFS.

The map's "💧 Moisture transport" layer paints how much water vapour the
atmosphere is MOVING — integrated vapour transport, IVT. It is the
quantity that decides where an atmospheric river will land: the
threshold for "heavy rain" is usually quoted as 250 kg/(m·s), and an
atmospheric river is IVT above 250-300 kg/(m·s) persisting for days.

**IVT is not a GFS product.** The `.idx` of the GFS analysis has no IVT
record — it has `PWAT` (precipitable water, the vertical integral of
humidity with NO wind weighting) and it has the humidity and the wind
at every pressure level. IVT is the integral of the humidity *times*
the wind:

    IVT = (1/g) · ∫ q · V dp        [kg/(m·s)]

so it has to be COMPUTED here, from the same GFS analysis the other
overlays use. It is the same idea as the wind layer — a derived field
that says something the raw fields cannot.

Source (100% free, no key, no rate limit, public domain):
    NOAA NCEP GFS analysis — specific humidity (`SPFH`), zonal wind
    (`UGRD`) and meridional wind (`VGRD`) at thirteen pressure levels.
    https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.YYYYMMDD/HH/atmos/

All thirteen levels of a variable come back in ONE request: the
filter server subsets the product to every requested field at once, so
the whole integral costs three requests, not thirty-nine.

The 1° product on purpose: the grid is held in the browser for the
probe, and IVT varies smoothly.

Outputs (under `public_html/data/ivt/`, and deliberately NOT .png —
Caddy serves every *.png under public_html `immutable` for a year,
which would freeze stale tiles behind a version token):
    grid.bin    Uint16Array (0.1 kg/(m·s) per unit), row-major, row 0 = -90°
    meta.json   colour ramp, grid layout, source, analysis run time

Usage:
    python -m worker.ivt                 # fetch, compute, verify, write
    python -m worker.ivt --dry-run       # fetch + compute + verify only
    python -m worker.ivt --run 2026102518   # force a GFS cycle
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger("xyzo.ivt")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "ivt")

# The pressure levels the integral runs over, in hPa. 1000 hPa is the
# bottom of the atmosphere and 250 hPa the top of the deep troposphere,
# where almost all the moisture transport lives. The standard
# "atmospheric river" definition integrates this same layer.
LEVELS_MB = (1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250)

# Standard gravity, m/s².
G = 9.80665

# The display scale is FIXED, not adaptive, because IVT has ABSOLUTE
# thresholds that the public knows:
#
#   250 kg/(m*s)  the IVT detection threshold for an atmospheric river
#   500 / 750 / 1000 / 1250  the CW3E (Ralph et al. 2019) categories
#                             1 Weak, 2 Moderate, 3 Strong, 4 Extreme
#
# An adaptive scale would move those thresholds every run, and the
# whole point of the layer is that a colour means the same thing every
# day. The scale runs to 1500, which is the top of the AR category
# scale; the rare values above it (a tropical cyclone's core, where IVT
# runs into the thousands) saturate.
RANGE_MIN = 0.0
RANGE_MAX = 1500.0

# The ticks ARE the AR scale.
TICKS = [0, 250, 500, 750, 1000, 1250, 1500]

# The ramp. The stops are absolute values, so each colour lands exactly
# on a threshold: 250 is the AR detection line, 500 the top of
# "Weak", 1000 the bottom of "Strong", 1250 "Extreme".
RAMP_STOPS = [
    (0, "#f7fcf0"),      # nothing
    (50, "#e0f3db"),
    (100, "#ccece6"),
    (200, "#99d8c9"),
    (250, "#66c2a4"),    # the atmospheric-river detection threshold
    (350, "#41b6c4"),
    (500, "#1d91c0"),    # AR category 1 (Weak)
    (750, "#225ea8"),    # AR category 2 (Moderate)
    (1000, "#253494"),   # AR category 3 (Strong)
    (1250, "#081d58"),   # AR category 4 (Extreme)
    (1500, "#4a0b6a"),
]

# Values are stored as Uint16 in units of 0.1 kg/(m·s), so the range
# reaches 6553 kg/(m·s) — past the strongest transport the
# atmosphere produces.
SCALE = 10

# The strongest transport anywhere is a tropical cyclone's core, where
# IVT runs into the thousands. The published AR scale tops out at 1250
# and those systems reach several times that, so the guard has to be
# generous — but not unbounded.
MAX_PLAUSIBLE = 6000.0


def _level_tokens() -> list[str]:
    return [f"{mb}_mb" for mb in LEVELS_MB]


def fetch_ivt(date_str: str, cycle: str):
    """Fetch humidity and wind at every level and integrate them.

    Returns (magnitude, u_component, v_component, lats, lons, run_time,
    product).
    """
    from .isobars import decode_fields, fetch_grib_fields

    levels = _level_tokens()

    q_field = None
    u_field = None
    v_field = None
    lats = lons = None
    run_time = None
    product = None

    for var, ecc_name, slot in (
        ("SPFH", "q", "q"),
        ("UGRD", "u", "u"),
        ("VGRD", "v", "v"),
    ):
        grib, product = fetch_grib_fields(
            date_str, cycle, var, levels,
            f"the GFS {var} profile", suffixes=("1p00",),
        )
        fields = decode_fields(grib, prefix=f"xyzo-ivt-{var.lower()}-")
        if not fields:
            raise RuntimeError(f"the GFS {var} response held no messages")

        by_level: dict[int, dict] = {}
        for f in fields:
            by_level[int(f["level"])] = f

        missing = [mb for mb in LEVELS_MB if mb not in by_level]
        if missing:
            raise RuntimeError(
                f"the GFS {var} response is missing levels {missing}"
            )

        # Stack the levels into one array: (n_levels, n_rows, n_cols).
        stack = np.stack([by_level[mb]["values"] for mb in LEVELS_MB])
        if lats is None:
            lats = by_level[LEVELS_MB[0]]["lats"]
            lons = by_level[LEVELS_MB[0]]["lons"]
            run_time = by_level[LEVELS_MB[0]]["run_time"]
        elif not (np.array_equal(lats, by_level[LEVELS_MB[0]]["lats"])
                  and np.array_equal(lons, by_level[LEVELS_MB[0]]["lons"])):
            raise RuntimeError(
                f"the GFS {var} levels are not on the same grid"
            )

        if slot == "q":
            q_field = stack
        elif slot == "u":
            u_field = stack
        else:
            v_field = stack

        log.info("fetched %s at %d levels", var, len(LEVELS_MB))

    # The integral, by the trapezoidal rule in pressure.
    #
    #   IVT = (1/g) · ∫ q·V dp
    #
    # Each layer contributes the mean of its two ends' q·V times the
    # pressure depth of the layer.
    p = np.array(LEVELS_MB, dtype=np.float64) * 100.0        # Pa
    dp = p[:-1] - p[1:]                                        # > 0
    weight = dp / G                                            # 1/g · dp

    qv_u = (q_field * u_field)
    qv_v = (q_field * v_field)
    ivt_u = np.sum(0.5 * (qv_u[:-1] + qv_u[1:]) * weight[:, None, None], axis=0)
    ivt_v = np.sum(0.5 * (qv_v[:-1] + qv_v[1:]) * weight[:, None, None], axis=0)
    magnitude = np.sqrt(ivt_u ** 2 + ivt_v ** 2)

    log.info(
        "computed IVT %dx%d: %.0f..%.0f kg/(m*s) (run %s)",
        magnitude.shape[0], magnitude.shape[1], magnitude.min(),
        magnitude.max(), run_time.isoformat(),
    )
    return magnitude, ivt_u, ivt_v, lats, lons, run_time, product


def choose_range(magnitude):
    """The display range. FIXED, not adaptive.

    IVT has absolute thresholds the public knows — 250 kg/(m·s) is the
    atmospheric-river detection threshold and 500/750/1000/1250 are the
    CW3E categories — so the scale has to mean the same thing every
    run. See RANGE_MIN / RANGE_MAX.
    """
    return RANGE_MIN, RANGE_MAX


def verify(magnitude, ivt_u, ivt_v, lats, lons) -> None:
    """Sanity-check the computed field before anything is published.

    The relationships that must hold:

    * the magnitude is finite, non-negative and in a range the
      atmosphere can reach;
    * the transport is MUCH stronger over the warm tropical oceans than
      over the polar cap — the moisture is there, and the wind is
      moving it;
    * the transport has a direction, and it is a COHERENT one: a
      scrambled field would have the components pointing every which
      way, so the mean vector would be small next to the mean
      magnitude. A real field has the mean vector comparable to the
      mean magnitude.
    """
    if magnitude.shape != (len(lats), len(lons)):
        raise SystemExit(f"[ivt] grid shape {magnitude.shape} does not match "
                         f"the axes ({len(lats)}, {len(lons)})")
    if not np.all(np.isfinite(magnitude)):
        raise SystemExit("[ivt] the computed field contains non-finite values")

    lo, hi = float(magnitude.min()), float(magnitude.max())
    if lo < 0.0 or hi > MAX_PLAUSIBLE:
        raise SystemExit(f"[ivt] implausible IVT range {lo:.0f}..{hi:.0f} "
                         f"kg/(m*s) — refusing to publish")

    def band(field, lat_min, lat_max):
        rows = (lats >= lat_min) & (lats <= lat_max)
        return field[rows]

    tropics = float(band(magnitude, -15.0, 15.0).mean())
    polar = float(min(band(magnitude, 70.0, 90.0).mean(),
                       band(magnitude, -90.0, -70.0).mean()))
    if tropics < 20.0:
        raise SystemExit(f"[ivt] tropical mean IVT {tropics:.0f} kg/(m*s) is "
                         f"implausibly low — the integral is probably wrong")
    if tropics < 2.0 * max(polar, 1.0):
        raise SystemExit(f"[ivt] the tropics ({tropics:.0f}) must carry far "
                         f"more moisture transport than the polar cap ({polar:.0f})")

    # Direction coherence: |mean vector| / mean magnitude, measured in
    # BLOCKS rather than globally.
    #
    # Globally the mean transport vector is near zero BY DESIGN — the
    # flow is clockwise round the northern hemisphere highs and
    # anticlockwise round the southern ones, so it cancels. A real
    # field is coherent WITHIN a basin and incoherent when averaged
    # over the globe. A scrambled field is incoherent in every block.
    #
    # So the blocks are scored and the MEDIAN is taken: a real field
    # scores high in most of them.
    blocks = []
    n_rows, n_cols = magnitude.shape
    for r0 in range(0, n_rows - 17, 18):
        for c0 in range(0, n_cols - 29, 30):
            mu = float(ivt_u[r0:r0 + 18, c0:c0 + 30].mean())
            mv = float(ivt_v[r0:r0 + 18, c0:c0 + 30].mean())
            mm = float(magnitude[r0:r0 + 18, c0:c0 + 30].mean())
            if mm < 20.0:
                continue  # too dry for the direction to mean anything
            blocks.append(np.hypot(mu, mv) / mm)
    if not blocks:
        raise SystemExit("[ivt] every block of the field is dry — the "
                         "transport is missing entirely")
    coherence = float(np.median(blocks))
    if coherence < 0.5:
        raise SystemExit(f"[ivt] the transport direction is incoherent in "
                         f"most blocks (median coherence {coherence:.2f}) — "
                         f"the field is scrambled")

    if float(np.percentile(magnitude, 99)) < 100.0:
        raise SystemExit("[ivt] the 99th percentile of IVT is under 100 "
                         "kg/(m*s) — there is no atmospheric-river-like "
                         "transport anywhere, which means the field is wrong")

    # The AREA fraction of the globe above the atmospheric-river
    # detection threshold (250 kg/(m*s)). Atmospheric rivers cover a
    # small share of any latitude line — a few per cent — so the area
    # fraction above the threshold is a few per cent too. A field that
    # is wildly off lands outside that band, and so does one that is
    # everywhere (which is what a broken wind field looks like).
    frac_ar = float((magnitude >= 250.0).mean())
    if not (0.005 <= frac_ar <= 0.40):
        raise SystemExit(f"[ivt] {frac_ar * 100:.1f}% of the globe is above "
                         f"the 250 kg/(m*s) atmospheric-river threshold — "
                         f"that is not how the atmosphere looks")

    log.info("verified: tropics %.0f, polar cap %.0f, block coherence %.2f, "
             "range %.0f..%.0f kg/(m*s), %.1f%% above the AR threshold",
             tropics, polar, coherence, lo, hi, frac_ar * 100)


def write_grid(magnitude, path: str) -> None:
    """Write the probe grid as a little-endian Uint16, 0.1 kg/(m·s) per unit."""
    scaled = np.rint(np.asarray(magnitude, dtype=np.float64) * SCALE)
    if scaled.min() < 0 or scaled.max() > 65535:
        raise SystemExit("[ivt] value does not fit uint16")
    raw = scaled.astype("<u2")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw.tofile(path)
    log.info("wrote %s (%d uint16, %.0f KB)", path, raw.size, raw.nbytes / 1024)


def write_meta(magnitude, lats, lons, run_time, product: str, path: str) -> None:
    lo, hi = choose_range(magnitude)

    meta = {
        "source": "NOAA NCEP GFS",
        "variable": "Integrated vapour transport (1000-250 hPa, computed)",
        "product": f"gfs.{product}",
        "run_time": run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "US Government work (public domain)",
        "attribution": "NOAA NCEP GFS",
        "unit": "kg/(m·s)",
        "computed": True,
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
        "range": [lo, hi],
        "observed": [round(float(magnitude.min()), 1),
                     round(float(magnitude.max()), 1)],
        "ramp": [
            {"v": round(float(v), 2), "rgb": rgb}
            for v, rgb in RAMP_STOPS
        ],
        "ticks": TICKS,
        # The atmospheric-river scale (Ralph et al. 2019, CW3E), so the
        # legend can say what a colour MEANS rather than leaving the
        # reader to work it out from a number.
        "ar_scale": {
            "detection": 250,
            "categories": [
                {"name": "Weak", "min": 500},
                {"name": "Moderate", "min": 750},
                {"name": "Strong", "min": 1000},
                {"name": "Extreme", "min": 1250},
            ],
        },
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(meta, fh, indent=1)
        fh.write("\n")
    log.info("wrote %s (ramp %.0f..%.0f kg/(m*s))", path, lo, hi)


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

    if not dry_run and force_run is None:
        pre_stamp = expected_stamp(date_str, cycle)
        if current_run_time() == pre_stamp:
            log.info("analysis %s already published — skipping the fetch", pre_stamp)
            return 0

    magnitude, ivt_u, ivt_v, lats, lons, run_time, product = fetch_ivt(date_str, cycle)
    verify(magnitude, ivt_u, ivt_v, lats, lons)

    stamp = run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not dry_run and force_run is None:
        if current_run_time() == stamp:
            log.info("analysis %s already published — nothing changed", stamp)
            return 0

    if dry_run:
        lo, hi = choose_range(magnitude)
        print(f"run            : {date_str} {cycle}Z")
        print(f"analysis time  : {run_time.isoformat()}")
        print(f"grid           : {magnitude.shape[0]}x{magnitude.shape[1]}")
        print(f"IVT            : {magnitude.min():.0f} .. {magnitude.max():.0f} kg/(m*s)")
        print(f"display range  : {lo:.0f} .. {hi:.0f} kg/(m*s)")
        return 0

    write_grid(magnitude, os.path.join(OUT_DIR, "grid.bin"))
    write_meta(magnitude, lats, lons, run_time, product,
               os.path.join(OUT_DIR, "meta.json"))
    print(f"IVT overlay built for {run_time.isoformat()} "
          f"({magnitude.min():.0f}..{magnitude.max():.0f} kg/(m*s))")
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
        log.error("IVT overlay unavailable: %s", exc)
        code = 0

    import sys

    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    raise SystemExit(main())
