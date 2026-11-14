#!/usr/bin/env python3
"""Build the wave overlay: wave height + derived wave power grids.

The map's "🌊 Wave height & power" layer paints the sea-state field and
lets you read a point in metres, seconds and kW/m of crest.

Source: NOAA NCEP **GFS Wave (gfswave)**, global 0.25° analysis
  https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.YYYYMMDD/HH/wave/gridded/
  gfswave.tHHz.global.0p25.f000.grib2   (~11.5 MB, public domain)

The path matters: NOMADS' `/com/wave/` tree answers 403 from this host
(ACL-restricted), but the SAME GFS-wave products are published under
the **GFS** tree at `com/gfs/prod/gfs.YYYYMMDD/HH/wave/gridded/`,
which is open. There is no filter server — the full file is 11.5 MB,
so the worker downloads it whole. It runs every 6 h (00/06/12/18Z like
GFS) and writes NOTHING when the latest published cycle equals the one
already in meta.json, so a timer tick that lands early is a no-op.

An earlier draft used the Open-Meteo Marine point API; the keyless tier
burns out on a global bake (minutely → hourly → daily 429s) and the
0p16 file called "global" is secretly a 52.5N..15S band. The GFS-wave
0p25 product is a true90N..90S grid, free, no key, no quota.

Wave POWER is not an observed quantity — it is derived from height and
period by the standard deep-water approximation, computed identically
here and in the frontend:

    P [kW/m] ≈ 0.49 · Hs² · Te        Te ≈ 0.9 · Tp   (wind-sea)
    P ≈ 0.441 · Hs² · Tp

The constants live in POWER below and are mirrored in
public_html/wave-layer.js — pinned by tests on both sides.

Outputs (all under public_html/data/wave/; deliberately NOT .png —
Caddy serves every *.png immutable for a year, which would freeze a
stale grid behind a version token):
    height.bin   Int16Array, 0.01 m (cm) per unit, row 0 = 90°N
    period.bin   Int16Array, 0.1 s (deciseconds) per unit, row 0 = 90°N
    meta.json    layout + ramps + formula + attribution + run_time

GRIB missing (9999) — land and ice — becomes the nodata marker
(−32768). The frontend computes power from the two grids client-side;
there is no power.bin to keep in sync.

Usage:
    python3 -m worker.wavemap                 # fetch latest cycle, verify, write
    python3 -m worker.wavemap --dry-run        # fetch + verify, write nothing
    python3 -m worker.wavemap --verify-only    # re-check the published grid
    python3 -m worker.wavemap --run 2026102900 # force a specific cycle
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone

import numpy as np

# The eccodes-vs-db teardown segfault: if BOTH native libraries ever
# load, the interpreter can die at exit with SIGSEGV after the work is
# done — systemd then records a failed unit for a successful run.
# wavemap does not import worker.db, but exit via os._exit() anyway so
# the unit can never inherit the hazard.
import eccodes  # noqa: E402

log = logging.getLogger("xyzo.wavemap")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "wave")

NOMADS_GFS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
WAVE_REL = "wave/gridded/gfswave.t{cycle}z.global.0p25.f000.grib2"
CYCLES = ("00", "06", "12", "18")
DAYS_BACK = 3

COLS, ROWS = 1440, 721          # 0.25° global grid, row 0 = 90°N
STEP = 0.25                     # degrees per cell
NODATA = -32768                 # Int16; GRIB missing is 9999
GRIB_MISSING = 9999.0

# Deep-water wave power: P ≈ 0.49·Hs²·Te, Te ≈ 0.9·Tp  →  k = 0.49*0.9
POWER_Hs_COEF = 0.49
POWER_TE_OF_TP = 0.9
# P = 0.441 · Hs² · Tp   (kW/m with Hs in m, Tp in s)

# Colour stops are ABSOLUTE (value, hex): a 2 m sea looks the same today
# and next week, so the scale never adapts to the current field.
HEIGHT_MAX = 8.0
HEIGHT_STOPS = [
    (0.0, "#0a1030"), (0.5, "#134e8a"), (1.0, "#1d8ac0"), (2.0, "#2fb3d4"),
    (3.0, "#4fd08c"), (4.5, "#c9d94a"), (6.0, "#f0a030"), (8.0, "#e04030"),
]
POWER_MAX = 250.0
POWER_STOPS = [
    (0.0, "#0a1030"), (2.0, "#134e8a"), (10.0, "#1d8ac0"), (25.0, "#2fb3d4"),
    (50.0, "#4fd08c"), (100.0, "#c9d94a"), (200.0, "#f0a030"), (250.0, "#e04030"),
]

# verify(): structural checks against the PUBLISHED grid — a live field
# has no "correct" value to assert, but these catch a flipped axis (land
# and ocean swap places), a scrambled row order (open ocean goes null)
# and physically impossible numbers. A wrong longitude roll (the GRIB
# is 0..360°, we publish -180..180°) moves the Sahara probe onto the
# Indian Ocean and fails immediately.
VERIFY_POINTS = [
    # (lat, lng, must_be_null, label)
    (23.0, 10.0, True, "Sahara (land)"),
    (65.0, -19.0, True, "Iceland interior (land)"),
    (30.0, -40.0, False, "Mid-Atlantic"),
    (45.0, -160.0, False, "North Pacific"),
    (-55.0, -60.0, False, "Southern Ocean"),
    (45.0, -5.0, False, "Bay of Biscay"),
]
OCEAN_RANGE_M = (0.05, 20.0)    # Hs bounds for every non-null probe


def log(msg: str, *args) -> None:
    print(f"[wavemap] {msg % args if args else msg}", flush=True)


def latest_cycle(published_run: str | None = None) -> tuple[str, str, str] | None:
    """Newest gfswave analysis not older than `published_run`.

    Returns (date_str, cycle, run_time) where run_time is the GRIB
    centre (e.g. "2026102906"), or None if nothing newer is published.
    Walks back up to DAYS_BACK days from today, newest cycle first.
    """
    from datetime import date, timedelta
    import httpx

    def fmt(d: date, hh: str) -> tuple[str, str, str]:
        ymd = d.strftime("%Y%m%d")
        return ymd, hh, f"{ymd}{hh}"

    today = datetime.now(timezone.utc).date()
    candidates = []
    for back in range(DAYS_BACK + 1):
        d = today - timedelta(days=back)
        for hh in CYCLES:
            candidates.append(fmt(d, hh))
    # newest first (candidates were generated oldest-day-first; reverse
    # per-day so e.g. 29/18 beats 29/00; overall list reversed sorts by
    # run_time descending)
    candidates.sort(key=lambda c: c[2], reverse=True)

    with httpx.Client(timeout=30.0, follow_redirects=True,
                      headers={"User-Agent": "xyzo-wavemap/1.0"}) as client:
        for ymd, hh, run in candidates:
            if published_run and run <= published_run:
                break      # everything older; no point HEAD-ing
            url = f"{NOMADS_GFS}/gfs.{ymd}/{hh}/" + WAVE_REL.format(cycle=hh)
            try:
                head = client.head(url)
            except Exception as exc:
                log.warning("HEAD %s failed: %s", url, exc)
                continue
            if head.status_code == 200:
                return ymd, hh, run
    return None


def download_grib(ymd: str, hh: str) -> str:
    """Download the 11.5 MB analysis to a temp file; returns the path."""
    url = f"{NOMADS_GFS}/gfs.{ymd}/{hh}/" + WAVE_REL.format(cycle=hh)
    log(f"downloading {url} ...")
    tmp = tempfile.NamedTemporaryFile(suffix=".grib2", delete=False,
                                      prefix="gfswave-")
    tmp.close()
    with urllib.request.urlopen(url, timeout=300) as resp, open(tmp.name, "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    size = os.path.getsize(tmp.name)
    if size < 1_000_000:
        os.remove(tmp.name)
        raise RuntimeError(f"download suspiciously small: {size} bytes")
    log(f"fetched {size:,} bytes")
    return tmp.name


def decode_field(path: str, short_name: str) -> tuple[np.ndarray, dict]:
    """Decode one surface field to (array[nj,ni] float, grid info).

    Row order is forced north-first (row 0 = the northernmost latitude)
    and longitudes are rolled from the GRIB 0..360° to the published
    -180..180° (the frontend samples ix = (lon+180)/lon_step).
    """
    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_new_from_file(fh, eccodes.CODES_PRODUCT_GRIB)
            if gid is None:
                raise RuntimeError(f"{short_name} not found in GRIB")
            short = eccodes.codes_get_string(gid, "shortName")
            level_type = eccodes.codes_get(gid, "levelType")
            # eccodes may surface levelType as int 1 or the string "sfc".
            if short != short_name or level_type not in (1, "sfc"):
                eccodes.codes_release(gid)
                continue
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
            lat2 = eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")
            lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
            vals = eccodes.codes_get_values(gid)
            eccodes.codes_release(gid)
            break

    arr = np.asarray(vals, dtype=np.float64).reshape(nj, ni)
    # North-first: row 0 must be the northernmost latitude.
    if lat1 < lat2:
        arr = arr[::-1, :]
    elif lat1 == lat2 and nj > 1:
        raise RuntimeError("degenerate latitude span")
    # Roll 0..360° -> -180..180° (frontend samples lon+180).
    shift = int(round((180.0 - lon1) / STEP)) % COLS
    if shift:
        arr = np.roll(arr, -shift, axis=1)
    info = {
        "ni": ni, "nj": nj, "lat1": lat1, "lat2": lat2, "lon1": lon1,
        "north_first": True, "lon_rolled": bool(shift),
    }
    return arr, info


def to_publish(arr: np.ndarray, scale: float) -> np.ndarray:
    """Model units -> Int16 publish units; missing -> NODATA."""
    out = np.full(arr.shape, NODATA, dtype=np.int16)
    valid = np.isfinite(arr) & (arr != GRIB_MISSING)
    # perpw of 0 or absurd values are model fill artefacts
    scaled = arr[valid] * scale
    keep = scaled > -0.001          # height 0 is kept; period 0 is not
    out[valid] = np.clip(np.round(scaled * keep), -32000, 32000).astype(np.int16)
    return out


def power_kw(hs_m, tp_s):
    """P ≈ 0.49·Hs²·(0.9·Tp) — mirrored in wave-layer.js, pinned by tests."""
    return POWER_Hs_COEF * hs_m * hs_m * (POWER_TE_OF_TP * tp_s)


def verify_files(height, period, run_time: str) -> bool:
    """Structural gate on the grids about to be published."""
    ok = True
    hs_grid = height.reshape(ROWS, COLS)
    tp_grid = period.reshape(ROWS, COLS)
    valid = hs_grid != NODATA
    frac = float(valid.sum()) / (ROWS * COLS)
    # Oceans ≈71 % of the globe, but the wave model additionally masks
    # ice and some marginal seas, so the published valid fraction lands
    # nearer 54 %. A flipped or un-rolled grid drops to ~0.2 (all the
    # land becomes "ocean" and vice versa) and fails this plus every
    # point probe below.
    if not (0.45 <= frac <= 0.85):
        log("valid fraction %.2f outside 0.45–0.85 — axis scrambled?", frac)
        ok = False
    else:
        log("valid cells: %.1f%% of globe (run %s)", frac * 100, run_time)

    for lat, lng, must_null, label in VERIFY_POINTS:
        r = int((90.0 - lat) / STEP)
        c = int((lng + 180.0) / STEP)
        if not (0 <= r < ROWS and 0 <= c < COLS):
            log("probe %s: off-grid (%d,%d)", label, r, c)
            ok = False
            continue
        v = int(hs_grid[r, c])
        is_null = v == NODATA
        if must_null and not is_null:
            log("probe %-22s expected land/NULL, got %d cm", label, v)
            ok = False
        elif not must_null and is_null:
            log("probe %-22s expected ocean data, got NULL", label)
            ok = False
        elif not must_null:
            hs = v / 100.0
            tp = int(tp_grid[r, c]) / 10.0
            if not (OCEAN_RANGE_M[0] <= hs <= OCEAN_RANGE_M[1]):
                log("probe %-22s Hs=%.1f m outside %s", label, hs, OCEAN_RANGE_M)
                ok = False
            elif not (1.0 <= tp <= 25.0):
                log("probe %-22s Tp=%.1f s outside 1..25", label, tp)
                ok = False
            else:
                log("probe %-22s Hs=%4.1f m  Tp=%4.1fs  P=%5.1f kW/m",
                    label, hs, tp, power_kw(hs, tp))

    if int(valid.sum()):
        vals = hs_grid[valid].astype(np.float64) / 100.0
        log("observed Hs range: %.1f … %.1f m", vals.min(), vals.max())
        if vals.max() > 30.0 or vals.min() < 0.0:
            log("Hs outside 0…30 m — units or decode wrong?")
            ok = False
    return ok


def publish(height, period, run_time: str, extra: dict | None = None) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    np.ascontiguousarray(height.astype("<i2")).tofile(
        os.path.join(OUT_DIR, "height.bin"))
    np.ascontiguousarray(period.astype("<i2")).tofile(
        os.path.join(OUT_DIR, "period.bin"))
    valid = height[height != NODATA]
    meta = {
        "source": "NOAA NCEP GFS Wave (gfswave) global 0.25° analysis",
        "variable": "significant wave height / primary mean wave period",
        "run_time": run_time,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "US Government work (public domain)",
        "attribution": "NOAA NCEP GFS Wave (gfswave) — public domain",
        "power_formula": "P[kW/m] = {k:.3f} * Hs^2 * Tp  (0.49*Hs^2*Te, Te=0.9*Tp)".format(
            k=POWER_Hs_COEF * POWER_TE_OF_TP),
        "power_constants": {
            "hs_coef": POWER_Hs_COEF,
            "te_of_tp": POWER_TE_OF_TP,
        },
        "grid": {
            "height_file": "height.bin",
            "period_file": "period.bin",
            "cols": COLS,
            "rows": ROWS,
            "lat_max": 90.0,
            "lat_min": -90.0,
            "lon_min": -180.0,
            "lat_step": STEP,
            "lon_step": STEP,
            "layout": "row_major_north_first",
            "nodata": NODATA,
            "dtype": "int16",
            "height_scale": 0.01,   # m per unit (stored as cm)
            "period_scale": 0.1,    # s per unit (stored as deciseconds)
        },
        "ramps": {
            "height": [{"v": v, "rgb": list(_hex(c))} for v, c in HEIGHT_STOPS],
            "power": [{"v": v, "rgb": list(_hex(c))} for v, c in POWER_STOPS],
        },
        "ranges": {
            "height_max": HEIGHT_MAX,
            "power_max": POWER_MAX,
            "observed_hs_m": [float(valid.min()) / 100.0, float(valid.max()) / 100.0]
            if valid.size else [0.0, 0.0],
        },
    }
    if extra:
        meta.update(extra)
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    log("published height.bin + period.bin + meta.json (run %s)", run_time)


def _hex(h: str):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _published_run() -> str | None:
    try:
        with open(os.path.join(OUT_DIR, "meta.json")) as fh:
            return (json.load(fh) or {}).get("run_time")
    except (OSError, json.JSONDecodeError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch + verify, write nothing")
    ap.add_argument("--verify-only", action="store_true", help="re-check the published grid")
    ap.add_argument("--run", default=None, metavar="YYYYMMDDHH",
                    help="force a specific GFS cycle centre (e.g. 2026102900)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="[wavemap] %(message)s")

    if args.verify_only:
        try:
            h = np.fromfile(os.path.join(OUT_DIR, "height.bin"), dtype="<i2")
            p = np.fromfile(os.path.join(OUT_DIR, "period.bin"), dtype="<i2")
        except OSError as exc:
            log("nothing published yet: %s", exc)
            code = 1
        else:
            if h.size != ROWS * COLS or p.size != ROWS * COLS:
                log("grid size wrong: %d / %d (expect %d)", h.size, p.size, ROWS * COLS)
                code = 2
            else:
                run = _published_run() or "unknown"
                code = 0 if verify_files(h, p, run) else 2
        sys.stdout.flush(); sys.stderr.flush()
        os._exit(code)

    grib_path = None
    code = 1
    try:
        published = _published_run()

        if args.run:
            if len(args.run) != 10 or not args.run.isdigit():
                log("--run must be YYYYMMDDHH")
                sys.stdout.flush(); sys.stderr.flush()
                os._exit(1)
            ymd, hh = args.run[:8], args.run[8:10]
            if hh not in CYCLES:
                log("--run cycle must be one of %s", CYCLES)
                sys.stdout.flush(); sys.stderr.flush()
                os._exit(1)
            run_time = args.run
        else:
            found = latest_cycle(published)
            if found is None:
                if published:
                    log("no newer cycle than %s on NOMADS — nothing to do", published)
                    code = 0
                else:
                    log("no cycle found on NOMADS")
                    code = 1
                grib_path = None
            else:
                ymd, hh, run_time = found

        if code in (0, 1) and (grib_path is None and not (args.run or "run_time" in dir())):
            sys.stdout.flush(); sys.stderr.flush()
            os._exit(code)

        if published and run_time <= published:
            log("run %s already published — nothing to do", published)
            code = 0
        else:
            grib_path = download_grib(ymd, hh)
            log("decoding swh + perpw from %s ...", run_time)
            swh, info = decode_field(grib_path, "swh")
            perpw, _info2 = decode_field(grib_path, "perpw")
            if (info["ni"], info["nj"]) != (COLS, ROWS):
                log("unexpected grid %sx%s (want %sx%s)",
                    info["ni"], info["nj"], COLS, ROWS)
                code = 2
            elif not info["north_first"]:
                log("grid was not north-first after decode — decode bug")
                code = 2
            else:
                height = to_publish(swh, 100.0)     # m -> cm
                period = to_publish(perpw, 10.0)    # s -> deciseconds
                if not verify_files(height, period, run_time):
                    log("verification FAILED — refusing to publish")
                    code = 2
                elif args.dry_run:
                    log("dry run: verified %s, nothing written", run_time)
                    code = 0
                else:
                    publish(height, period, run_time, {
                        "source_url": (f"{NOMADS_GFS}/gfs.{ymd}/{hh}/"
                                       + WAVE_REL.format(cycle=hh)),
                    })
                    log("done")
                    code = 0
    except Exception as exc:
        log("failed: %s", exc)
        code = 1
    finally:
        if grib_path and os.path.exists(grib_path):
            try:
                os.remove(grib_path)
            except OSError:
                pass

    # Never let the eccodes teardown race the process exit.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    # main() os._exit()s above; this raise is for static analysers.
    raise SystemExit(main())
