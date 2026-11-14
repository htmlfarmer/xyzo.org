#!/usr/bin/env python3
"""pressure_delta.py — archive the pressure FIELD, so the CHANGE can be drawn.

WHAT THIS IS. The isobar layer draws the pressure of a single analysis.
This worker archives the raw mean-sea-level-pressure field of every
cycle, and the API differences two of them to draw the CHANGE — the
pressure anomaly, the Δp map a synoptic chart calls the tendency.

WHY THE FIELD AND NOT THE LINES. A difference of two sets of contour
lines is not a field — you cannot subtract a polyline. So the archive
holds the FIELD (1°, 130 KB a cycle, ~190 MB a year) and the delta is
computed from it on demand, for ANY window and ANY past cycle. Storing
the delta per window instead would cost 1.5 GB a year for a field that
is 190 MB.

WHY 1° AND NOT 0.25°. The change patterns are synoptic-scale — a
thousand kilometres — so the coarse field contours cleanly. It is also
what the globe draws (the same 1° grids the wind and temperature
overlays publish), and it is 190 MB a year instead of 2.1 GB.

WHY IT BACKFILLS. NOMADS keeps about ten days of GFS analyses. The
24-hour change is the window everyone asks for, and it must work on the
day this ships rather than in a week — so the last ten days are fetched
once and archived, and from then on the archive answers every window
from 24 hours up to a full year.

The 24 h window is what works on day one. The lunar cycle (29.53 d),
the seasonal quarter (91.3 d) and the year (365.25 d) light up as the
archive fills — which is the honest answer: a year-long change cannot be
computed until a year of fields exists.

Run:
    python3 -m worker.pressure_delta --archive
    python3 -m worker.pressure_delta --stats
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.db import connect  # noqa: E402
from worker.isobars import (  # noqa: E402
    decode_mslp,
    fetch_grib_field,
    find_latest_run,
)

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_ROOT = Path(os.environ.get("XYZO_WEATHER_ARCHIVE", str(ROOT / "data" / "weather_archive")))

# The 1° product only: the archive holds a FIELD to difference, and the
# coarse field is what the change patterns need (and what fits in a year
# of disk).
PRODUCT_SUFFIX = "1p00"

# 0.05 hPa per unit — THE GCD OF THE LADDER.
#
# The chart's steps are 0.10, 0.25, 0.5, 1, 2, 4, 8 and 16 hPa, and
# 0.25 is NOT a multiple of 0.1 — so a grid at 0.1 hPa per unit could
# not hold a 0.25 hPa level at all, and the lines would land between
# the units. The isobar worker already cut its levels at 0.05 hPa for
# exactly this reason ("every entry in STEP_CHOICES must be a whole
# multiple of ISO_INTERVAL_HPA"); the delta grid uses the same lattice.
#
# The pressure itself is ~1000 hPa, so 1000 / 0.05 = 20,000 units —
# inside int16 (±32,767) ✓, and the CHANGE (a few tens of hPa) is
# hundreds of units ✓.
SCALE = 20

# How many cycles to backfill from NOMADS. It keeps roughly ten days.
BACKFILL_CYCLES = 40  # 10 days x 4 cycles

# The windows the change map offers. The key is what the API and the
# button share; the days are the reference cycle's distance back.
WINDOWS: list[tuple[str, float, str]] = [
    ("24h", 1.0, "the last day"),
    ("3d", 3.0, "three days"),
    ("7d", 7.0, "a week"),
    ("moon", 29.53059, "one lunar cycle (29.53 days)"),
    ("season", 91.3125, "a quarter of the year"),
    ("year", 365.25, "a full year"),
]


def log(msg: str) -> None:
    print(f"[pressure-delta] {msg}", flush=True)


def cycle_key(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%d%H")


def cycle_dir(dt: datetime) -> Path:
    return ARCHIVE_ROOT / cycle_key(dt)


def mslp_path(dt: datetime) -> Path:
    return cycle_dir(dt) / "mslp-1deg.bin"


def mslp_meta_path(dt: datetime) -> Path:
    return cycle_dir(dt) / "mslp-meta.json"


def fetch_cycle_field(date_str: str, cycle: str):
    """The 1° MSLP field of one cycle, or None if it is not on NOMADS."""
    try:
        grib, product = fetch_grib_field(
            date_str, cycle, "PRMSL", "mean_sea_level",
            "the MSLP field", suffixes=(PRODUCT_SUFFIX,),
        )
    except Exception as e:
        log(f"fetch failed for {date_str} {cycle}Z: {e}")
        return None
    try:
        grid, lats, lons, run_time = decode_mslp(grib)
    except Exception as e:
        log(f"decode failed for {date_str} {cycle}Z: {e}")
        return None
    return grid, lats, lons, run_time, product


def write_field(dt: datetime, grid, lats, lons, product: str) -> int:
    """Write the field as a little-endian Int16 (0.1 hPa per unit).

    Written to a temp file and renamed: a reader must never see a
    half-written field, because the difference of two half-written fields
    is not a small error — it is a wrong map.
    """
    scaled = np.rint(np.asarray(grid, dtype=np.float64) * SCALE)
    if scaled.min() < -32768 or scaled.max() > 32767:
        raise SystemExit("[pressure-delta] value does not fit int16")
    raw = scaled.astype("<i2")
    d = cycle_dir(dt)
    d.mkdir(parents=True, exist_ok=True)
    tmp = f"{mslp_path(dt)}.{os.getpid()}.tmp"
    try:
        raw.tofile(tmp)
        os.replace(tmp, mslp_path(dt))
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    meta = {
        "source": "NOAA NCEP GFS",
        "variable": "mean sea-level pressure",
        "units": "hPa",
        "product": f"gfs.{PRODUCT_SUFFIX}",
        "run_time": dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "US Government work (public domain)",
        "attribution": "NOAA NCEP GFS — mean sea-level pressure",
        "grid": {
            "file": "mslp-1deg.bin",
            "cols": int(len(lons)),
            "rows": int(len(lats)),
            "lat_min": float(lats[0]),
            "lat_max": float(lats[-1]),
            "lon_min": float(lons[0]),
            "lat_step": float(round(abs(lats[1] - lats[0]), 6)),
            "lon_step": float(round(abs(lons[1] - lons[0]), 6)),
            "scale": SCALE,
            "layout": "row_major",
            "row0": "south",
        },
        "range_hpa": [float(np.nanmin(grid)), float(np.nanmax(grid))],
    }
    mslp_meta_path(dt).write_text(json.dumps(meta, indent=1))
    return raw.size


def archive_cycle(date_str: str, cycle: str) -> bool:
    run_dt = datetime.strptime(f"{date_str}{cycle}", "%Y%m%d%H").replace(tzinfo=timezone.utc)
    if mslp_path(run_dt).exists():
        log(f"{cycle_key(run_dt)} already archived")
        return False
    fetched = fetch_cycle_field(date_str, cycle)
    if fetched is None:
        return False
    grid, lats, lons, run_time, product = fetched
    n = write_field(run_time, grid, lats, lons, product)
    log(f"archived {run_time.isoformat()}: {n} int16 ({n * 2 / 1024:.0f} KB)")
    return True


def recent_cycles(count: int) -> list[tuple[str, str]]:
    """The last `count` analysis cycles, newest first."""
    now = datetime.now(timezone.utc)
    current = now.replace(hour=(now.hour // 6) * 6, minute=0, second=0, microsecond=0)
    out = []
    for _ in range(count):
        out.append((current.strftime("%Y%m%d"), current.strftime("%H")))
        current -= timedelta(hours=6)
    return out


def stats() -> dict:
    cycles = []
    if ARCHIVE_ROOT.exists():
        for d in sorted(ARCHIVE_ROOT.iterdir()):
            if d.is_dir() and (d / "mslp-1deg.bin").exists():
                cycles.append(d.name)
    total = sum(
        (ARCHIVE_ROOT / c / "mslp-1deg.bin").stat().st_size for c in cycles
    ) if cycles else 0
    # Which windows can be answered right now: the reference cycle has
    # to exist in the archive.
    have = sorted(cycles)
    available = []
    for key, days, _label in WINDOWS:
        ok = False
        if have:
            newest = datetime.strptime(have[-1], "%Y%m%d%H").replace(tzinfo=timezone.utc)
            want = newest - timedelta(days=days)
            for c in have:
                dt = datetime.strptime(c, "%Y%m%d%H").replace(tzinfo=timezone.utc)
                if abs((dt - want).total_seconds()) <= 6 * 3600:
                    ok = True
                    break
        available.append({"window": key, "days": days, "available": ok})
    return {
        "archive_root": str(ARCHIVE_ROOT),
        "cycles": len(cycles),
        "bytes": total,
        "mb": round(total / 1e6, 2),
        "projected_year_mb": round((total / max(len(cycles), 1)) * 4 * 365 / 1e6, 1),
        "oldest": have[0] if have else None,
        "newest": have[-1] if have else None,
        "windows": available,
    }


def archive(backfill: bool = True) -> dict:
    run_ref = find_latest_run()
    if run_ref is None:
        log("no GFS run found on NOMADS — nothing to archive")
        return {"archived": 0}
    date_str, cycle = run_ref
    log(f"current GFS cycle: {date_str} {cycle}Z")
    n = 0
    if archive_cycle(date_str, cycle):
        n += 1
    if backfill:
        for d, c in recent_cycles(BACKFILL_CYCLES):
            if d == date_str and c == cycle:
                continue
            if archive_cycle(d, c):
                n += 1
    log(f"archived {n} cycle(s)")
    return {"archived": n}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", action="store_true", help="archive the current cycle (and backfill)")
    ap.add_argument("--stats", action="store_true", help="what the archive holds")
    ap.add_argument("--no-backfill", action="store_true", help="only the current cycle")
    args = ap.parse_args()

    if args.stats:
        print(json.dumps(stats(), indent=2))
        return 0
    if args.archive:
        archive(backfill=not args.no_backfill)
        print(json.dumps(stats(), indent=2))
        return 0
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
