#!/usr/bin/env python3
"""
Build the LIVE ocean-current overlay for Xyzo.

Source: **NOAA OSCAR** (Ocean Surface Current Analyses Real-time), the
0.25 degree global surface-current product from ESR / NASA PO.DAAC —
served here through **NOAA CoastWatch's ERDDAP**, which needs no
account and no key:

    https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplOscar.csv?u[116][0][...]

The dataset is public domain (US Government work: NOAA / NASA / ESR).
Attribution: "OSCAR Sea Surface Velocity (ESR/NASA PO.DAAC) via NOAA
CoastWatch ERDDAP".

WHAT IS PUBLISHED
-----------------
  public_html/data/ocean/grid.bin     Int16, PLANAR: u in [0, n),
                                      v in [n, 2n), 0.01 m/s per unit
  public_html/data/ocean/meta.json    grid layout, the speed range, the
                                      attribution and the licence

The grid is 1 degree (the source is 1/3 degree; every third point is
taken), which is the same resolution as the site's wind grid, and it is
published as a plain pair of planes so the client can animate it with
the same particle engine the wind layer uses.

WHY A u/v GRID AND NOT THE STATIC PICTURE
------------------------------------------
The site already ships a static frame of the NOAA SOS "Perpetual
Ocean" current field (public_html/data/transport/ocean-currents.png).
That is a PICTURE: it shows where the warm water is, but it cannot
show FLOW, because a picture carries no direction. A u/v pair does:
the client can advect particles along it, and the animation is then a
real animation of the real field.

Usage:
  python3 -m scripts.ocean_currents_build
  python3 -m scripts.ocean_currents_build --verify-only
  python3 -m scripts.ocean_currents_build --time-index 116
"""
from __future__ import annotations

import argparse
import datetime
import gzip
import html as htmllib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "public_html", "data", "ocean")

SOURCE_URL = (
    "https://coastwatch.pfeg.noaa.gov/erddap/files/jplOscar/"
)
SOURCE_PAGE = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplOscar"
ATTRIBUTION = "OSCAR Sea Surface Velocity (ESR / NASA PO.DAAC) via NOAA CoastWatch"
LICENSE = "Public domain — US Government work (NOAA / NASA / ESR)"

# The ERDDAP holds one gzipped NetCDF per five-day composite. The
# newest one is picked by name, so the build always publishes the most
# recent field the mirror carries.
FILE_LISTING = (
    "https://coastwatch.pfeg.noaa.gov/erddap/files/jplOscar/"
)

# The published grid: 1 degree (the source is 1/3 degree and every
# third point is taken), -80..80 latitude (OSCAR stops at 80) and
# 0..360 longitude.
LAT_MIN = -80.0
LAT_MAX = 80.0
LON_MIN = 0.0
ROWS = 161
COLS = 360

USER_AGENT = "xyzo-ocean-currents/1.0 (+https://xyzo.org)"

# ── provenance ─────────────────────────────────────────────────────────
#
# OSCAR's time axis is "days since 1992-10-05". The composite's own
# PERIOD attribute is a Python bytes literal ("b'Sep.26,2014'"), so the
# DATE is read from the NUMERIC axis instead — it is the only place
# the date is unambiguous, and the date is the whole point of the
# freshness gate below.
OSCAR_EPOCH = datetime.date(1992, 10, 5)

# THE FRESHNESS GATE.
#
# The overlay is called "live" and a DAILY timer refreshes it, so a
# composite that is months old must never be published as if it were
# current. This gate exists because of exactly that failure: the
# mirror's newest file has been FROZEN at 2014-09-26 for years (the
# ERDDAP was loaded in February 2015), and the field passed every
# physics check — because no gate ever looked at the DATE.
#
# The field's STRUCTURE is still right, so the build refuses to
# publish a stale composite rather than silently shipping it: the
# reader is told the date in the legend instead.
MAX_AGE_DAYS = 45

# The freshness failure has a DIFFERENT CONSEQUENCE from every other
# gate (see verify() and main()), so it is identified by name.
STALE_PROBLEM = "the composite is FRESH"

# THE COASTAL MASK, MEASURED.
#
# The owner saw the currents stop short of the African coast. That is
# the SOURCE, not this script: OSCAR's surface velocity is an
# altimetry inversion, and satellite altimetry has no valid solution
# in shallow, coastal, river-influenced water. Every altimetry-based
# surface-current product carries the same hole — the daily NOAA
# CoastWatch "Sea Surface Height Anomalies and Geostrophic Currents"
# product was measured on 2026-11-04 and its Gulf of Guinea coverage
# is CELL-FOR-CELL the same.
#
# So the gap is measured and published rather than assumed, and the
# floor below stops a future decode that loses the ocean altogether
# from being published as "a current field".
COASTAL_PROBE_LAT = (0, 12)
COASTAL_PROBE_LON = (0, 9)
COASTAL_COVERAGE_FLOOR = 0.30

# 0.01 m/s per unit, Int16 — the same convention as the wind grid.
SCALE = 100

# The SPEED ramp, published so BOTH views use the SAME one.
#
# It is BRIGHT AT BOTH ENDS, and that is not a style choice: the median
# ocean surface current is 0.11 m/s and most of the ocean is slower
# than 0.3 m/s, so a ramp whose first stop is near-black (#0b1020, the
# wind's published first stop) paints the great majority of the ocean
# in a colour indistinguishable from a dark satellite basemap. The
# animation ran perfectly and the reader saw nothing.
#
# The same lesson the wind learned the hard way — a ramp with a dark
# end has the same problem on a dark map.
RAMP = [
    {"ms": 0.00, "rgb": "#22d3ee"},
    {"ms": 0.12, "rgb": "#0ea5e9"},
    {"ms": 0.30, "rgb": "#4ade80"},
    {"ms": 0.60, "rgb": "#a3e635"},
    {"ms": 1.00, "rgb": "#facc15"},
    {"ms": 1.60, "rgb": "#f97316"},
    {"ms": 2.40, "rgb": "#ef4444"},
    {"ms": 3.30, "rgb": "#f0abfc"},
]


def log(msg: str) -> None:
    print(f"[ocean] {msg}", flush=True)


def fetch_bytes(url: str, timeout: int = 300) -> bytes:
    """Bytes, not text — the composites are binary and decoding them as
    UTF-8 corrupts the gzip stream."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch(url: str, timeout: int = 300) -> str:
    return fetch_bytes(url, timeout).decode("utf-8", "replace")


def newest_source_file() -> str:
    """The newest OSCAR composite the mirror carries.

    The ERDDAP's griddap DATA endpoint is unusable from here (its
    multi-variable query is rejected with "'&' must be followed by a
    .graphicsCommand"), but its FILES endpoint serves the raw
    composites directly, and that is what this builder uses.
    """
    raw = fetch(FILE_LISTING, timeout=180)
    # The ERDDAP listing escapes the file names (oscar&#x5f;vel...),
    # so they are unescaped before they are matched.
    page = htmllib.unescape(raw)
    names = sorted(set(re.findall(r'href="([^"]*oscar_vel[^"]*\.nc\.gz)"', page)))
    if not names:
        raise RuntimeError("no OSCAR composite found in the file listing")
    name = names[-1]
    log(f"newest composite: {name}")
    return name


def fetch_composite(name: str) -> bytes:
    """The gzipped NetCDF, decompressed."""
    url = SOURCE_URL + name
    log(f"downloading {url}")
    raw = fetch_bytes(url, timeout=600)
    return gzip.decompress(raw)


def build() -> tuple[bytes, dict]:
    """Decode the newest composite into the published 1 degree grid."""
    import struct

    import numpy as np
    from scipy.io import netcdf_file

    name = newest_source_file()
    blob_nc = fetch_composite(name)
    tmp = os.path.join(out_dir := OUT_DIR, "_oscarsrc.nc")
    os.makedirs(out_dir, exist_ok=True)
    with open(tmp, "wb") as fh:
        fh.write(blob_nc)
    try:
        src = netcdf_file(tmp, "r", mmap=False)
        u_all = np.array(src.variables["u"][0][0], dtype="float64")
        v_all = np.array(src.variables["v"][0][0], dtype="float64")
        lats = np.array(src.variables["latitude"][:], dtype="float64")
        lons = np.array(src.variables["longitude"][:], dtype="float64")
        period = src._attributes.get("PERIOD", b"")
        if isinstance(period, bytes):
            period = period.decode("utf-8", "replace")
        period = str(period).strip()
        # THE DATE. The numeric time axis is the only unambiguous
        # source of it (see OSCAR_EPOCH above).
        source_date = None
        if "time" in src.variables:
            tdays = int(np.array(src.variables["time"][:]).reshape(-1)[0])
            source_date = OSCAR_EPOCH + datetime.timedelta(days=tdays)
        src.close()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    n = ROWS * COLS
    u = np.zeros(n, dtype="float64")
    v = np.zeros(n, dtype="float64")

    # Every THIRD point of the 1/3 degree source, placed by its own
    # coordinate: OSCAR's longitude axis runs 20E..420E (so it does not
    # break the Pacific), and a value at 15E lives at 375E on that
    # axis. Placing by the COORDINATE, not by the position in the
    # array, is what keeps the continents where they belong.
    step = 3
    for r in range(0, len(lats), step):
        lat = lats[r]
        row = int(round(lat - LAT_MIN))
        if not (0 <= row < ROWS):
            continue
        for c in range(0, len(lons), step):
            lon = lons[c]
            col = int(round(lon)) % COLS
            uu = u_all[r, c]
            vv = v_all[r, c]
            if math.isnan(uu) or math.isnan(vv):
                continue     # land, or outside the product
            u[row * COLS + col] = uu
            v[row * COLS + col] = vv

    out_u = []
    out_v = []
    for i in range(n):
        uu = u[i]
        vv = v[i]
        out_u.append(int(round(max(-32768, min(32767, uu * SCALE)))))
        out_v.append(int(round(max(-32768, min(32767, vv * SCALE)))))

    blob = struct.pack(f"<{2 * n}h", *(out_u + out_v))

    speeds = sorted(
        math.hypot(out_u[i], out_v[i]) / SCALE
        for i in range(n)
        if out_u[i] or out_v[i]
    )
    # The coastal mask, MEASURED (see COASTAL_PROBE_LAT above).
    coverage = gulf_of_guinea_coverage(out_u, out_v)
    meta = {
        "name": "Ocean surface currents",
        "source": SOURCE_PAGE,
        "download": SOURCE_URL,
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        "variable": "ocean surface current",
        "units": "m/s",
        "source_date": source_date.isoformat() if source_date else None,
        "source_age_days": (
            (datetime.date.today() - source_date).days if source_date else None
        ),
        "source_period": period,
        "coastal_coverage": coverage,
        "coastal_coverage_note": (
            "The share of the Gulf of Guinea that carries a current. "
            "The currents stop short of the coast because OSCAR is an "
            "ALTIMETRY inversion and satellite altimetry has no valid "
            "solution in shallow, river-influenced water — the same "
            "mask every altimetry-based surface-current product "
            "carries, measured cell-for-cell against the daily NOAA "
            "CoastWatch geostrophic product."
        ),
        "grid": {
            "file": "grid.bin",
            "cols": COLS,
            "rows": ROWS,
            "lat_min": LAT_MIN,
            "lat_max": LAT_MAX,
            "lon_min": LON_MIN,
            "lat_step": 1.0,
            "lon_step": 1.0,
            "scale": SCALE,
            "layout": "planar_uv",
        },
        "ramp": RAMP,
        "range_ms": [0.0, round(speeds[-1], 2) if speeds else 1.0],
        "observed_ms": [
            round(speeds[int(len(speeds) * 0.5)], 3) if speeds else 0.0,
            round(speeds[int(len(speeds) * 0.999)], 3) if speeds else 0.0,
        ],
        "mean_ms": round(sum(speeds) / len(speeds), 3) if speeds else 0.0,
        "source_file": name,
        "note": (
            "OSCAR surface currents on a 1 degree grid. The published "
            "pair is what the client animates: particles are advected "
            "along u and v, so the picture is the FLOW, not a frame of "
            "it."
        ),
        "disclaimer": (
            "A five-day composite of a satellite-derived product, not a "
            "real-time observation."
        ),
    }
    return blob, meta


def gulf_of_guinea_coverage(out_u: list[int], out_v: list[int]) -> float:
    """The share of the Gulf of Guinea that carries a current.

    The owner saw the currents stop just off the coast of Africa, and
    the answer is the SOURCE: OSCAR is an altimetry inversion, and
    satellite altimetry has no valid solution in shallow, coastal,
    river-influenced water. The northern Gulf of Guinea (the Bight of
    Benin) is exactly that kind of water, so the product leaves it
    empty.

    This measures the hole instead of assuming it, so a future source
    that fills the coast shows up as a number that moved — and a
    decode that loses the ocean altogether fails the floor.
    """
    lo_lat, hi_lat = COASTAL_PROBE_LAT
    lo_lon, hi_lon = COASTAL_PROBE_LON
    total = 0
    wet = 0
    for lat in range(lo_lat, hi_lat + 1):
        for lon in range(lo_lon, hi_lon + 1):
            row = int(round(lat - LAT_MIN))
            col = int(round(lon)) % COLS
            i = row * COLS + col
            total += 1
            if out_u[i] or out_v[i]:
                wet += 1
    return round(wet / total, 4) if total else 0.0


def verify(blob: bytes, meta: dict) -> list[str]:
    """A gate, not a checkpoint.

    Returns the list of FAILURES — an empty list means the field is
    publishable. The caller decides what each failure MEANS, because
    one of them has a different consequence from the rest:

      · a PHYSICS failure means the field is not the ocean, and
        nothing is published at all;
      · a STALE composite means the field is the right shape but too
        old to present as live, so the published grid is left alone
        and the PROVENANCE is refreshed instead — the reader is told
        the date in the legend, and the daily timer alarms.
    """
    import struct

    g = meta["grid"]
    n = g["rows"] * g["cols"]
    scale = g["scale"]
    vals = struct.unpack(f"<{2 * n}h", blob)
    u = vals[:n]
    v = vals[n:]

    def at(lat: float, lon: float) -> tuple[float, float]:
        row = int(round(lat - g["lat_min"]))
        col = int(round(lon)) % g["cols"]
        i = row * g["cols"] + col
        return u[i] / scale, v[i] / scale

    problems: list[str] = []

    def check(label: str, passed: bool, detail: str) -> None:
        log(f"  {'PASS' if passed else 'FAIL'}  {label}: {detail}")
        if not passed:
            problems.append(label)

    # 1. The South Equatorial Current: westward (negative u) just
    #    north of the equator in the central Pacific.
    uu, vv = at(-3.0, -140.0)
    check("South Equatorial Current flows west", uu < -0.05, f"u = {uu:.3f} m/s at 3S 140W")

    # 2. The Gulf Stream is fast and northward off the US coast.
    uu, vv = at(32.0, -79.0)
    check(
        "the Gulf Stream leaves the Florida Straits northward",
        math.hypot(uu, vv) > 0.08 and vv > 0.03,
        f"|v| = {math.hypot(uu, vv):.3f} m/s, v = {vv:.3f} at 32N 79W",
    )

    # 3. The Antarctic Circumpolar Current: fast, and EASTWARD at
    #    every longitude in the Southern Ocean.
    # The ACC circles the globe, but at 52 degrees south it crosses
    # South America, Africa and Australia — and a land cell carries no
    # current, so the samples that are exactly zero are SKIPPED rather
    # than counted as "no current".
    speeds = []
    east = 0
    ocean = 0
    for lon in range(0, 360, 15):
        uu, vv = at(-52.0, lon)
        if uu == 0 and vv == 0:
            continue
        ocean += 1
        speeds.append(math.hypot(uu, vv))
        if uu > 0:
            east += 1
    speeds.sort()
    median = speeds[len(speeds) // 2] if speeds else 0.0
    check(
        "Antarctic Circumpolar Current is fast",
        median > 0.05,
        f"median |v| = {median:.3f} m/s at 52S over {ocean} ocean samples",
    )
    check(
        "the ACC is eastward all the way round",
        # 0.7, not 1.0: the ACC MEANDERS, so at one latitude it is
        # locally westward in a few of its loops. A mirrored field
        # would score near zero, so the threshold still catches one.
        ocean > 0 and east / ocean >= 0.7,
        f"{east}/{ocean} ocean samples at 52S have u > 0",
    )

    # 4. Land must be zero: the Sahara and central Asia carry no
    #    current.
    uu, vv = at(25.0, 15.0)
    check("the Sahara is land (no current)", uu == 0 and vv == 0, f"u = {uu}, v = {vv}")
    uu, vv = at(45.0, 90.0)
    check("central Asia is land (no current)", uu == 0 and vv == 0, f"u = {uu}, v = {vv}")

    # 5. The axes must not be swapped: the Gulf Stream points NORTH
    #    (v > 0) off the US coast, not east.
    uu, vv = at(32.0, -79.0)
    check("the axes are not swapped", vv > 0, f"v = {vv:.3f} at 32N 79W (the Gulf Stream runs north)")

    # 6. The speed distribution must be plausible.
    speeds_all = sorted(
        math.hypot(u[i], v[i]) / scale for i in range(n) if u[i] or v[i]
    )
    if not speeds_all:
        problems.append("the field is empty")
    else:
        med = speeds_all[len(speeds_all) // 2]
        mx = speeds_all[-1]
        check("the median speed is plausible", 0.05 < med < 0.8, f"median = {med:.3f} m/s")
        check("the maximum speed is plausible", 0.5 < mx < 3.5, f"max = {mx:.3f} m/s")

    # 7. THE COASTAL MASK, MEASURED. The currents stop short of the
    #    coast — that is the SOURCE (see COASTAL_PROBE_LAT), so the
    #    gate is a FLOOR, not a target: it stops a decode that lost
    #    the ocean from being published as "a current field", and it
    #    records the number so a future source that fills the coast
    #    shows up as a number that moved.
    coverage = meta.get("coastal_coverage")
    check(
        "the Gulf of Guinea still carries a current",
        coverage is not None and coverage >= COASTAL_COVERAGE_FLOOR,
        f"coverage = {coverage} (floor {COASTAL_COVERAGE_FLOOR}); the "
        f"altimetry mask leaves the shallow Bight of Benin empty",
    )

    # 8. THE FRESHNESS GATE. The overlay is called "live" and a daily
    #    timer refreshes it, so a composite that is months old must
    #    not be published as if it were current. This check exists
    #    because the mirror's newest file froze at 2014-09-26 and
    #    every PHYSICS check passed it.
    age = meta.get("source_age_days")
    if age is None and meta.get("source_date"):
        # The age is recomputed from the DATE whenever it is missing,
        # so a meta published days ago still tells the truth (and the
        # CLIENT computes it the same way).
        try:
            age = (
                datetime.date.today()
                - datetime.date.fromisoformat(str(meta["source_date"]))
            ).days
        except ValueError:
            age = None
    check(
        STALE_PROBLEM,
        age is not None and age <= MAX_AGE_DAYS,
        f"the newest composite is {age} days old (limit {MAX_AGE_DAYS})"
        + ("" if age is None or age <= MAX_AGE_DAYS else
           " — the mirror is frozen; see README Known Issues Q-N1"),
    )

    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the ocean-current overlay")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    grid_path = os.path.join(out_dir, "grid.bin")
    meta_path = os.path.join(out_dir, "meta.json")

    if args.verify_only:
        if not os.path.exists(grid_path):
            log(f"missing {grid_path} — run the build first")
            return 1
        blob = open(grid_path, "rb").read()
        meta = json.load(open(meta_path))
        problems = verify(blob, meta)
        for p in problems:
            log(f"VERIFY FAIL: {p}")
        if problems:
            raise SystemExit(
                "verify() failed — the published grid is not certifiable"
            )
        log("verify() passed")
        return 0

    # A GUEST HOST CAN BE UNREACHABLE, AND THAT IS NOT A CRASH.
    #
    # `build()` starts by asking the ERDDAP for its file listing, and on
    # 2026-11-14 12:14 that answered **HTTP 404** — the traceback it then
    # printed was the whole of the failure, five frames of urllib, with
    # nothing in the log that said WHICH host or WHICH status. The unit
    # failed (correctly: nothing was refreshed), but the reader of the
    # journal got a stack trace instead of a reason.
    #
    # The exit stays NON-ZERO either way: a build that did not refresh
    # the field has to be visible in `systemctl --failed`. What changes
    # is that the reason is now one line, with the URL and the status,
    # and the published grid is said to be untouched (it is: nothing is
    # written until every gate below has passed).
    try:
        blob, meta = build()
    except urllib.error.HTTPError as exc:
        log(f"build failed: the upstream answered HTTP {exc.code} for "
            f"{exc.url} — the published grid is unchanged")
        return 1
    except Exception as exc:
        log(f"build failed: {type(exc).__name__}: {exc} — the published "
            "grid is unchanged")
        return 1
    problems = verify(blob, meta)
    stale = STALE_PROBLEM in problems
    hard = [p for p in problems if p != STALE_PROBLEM]
    for p in hard:
        log(f"VERIFY FAIL: {p}")
    if hard:
        raise SystemExit("verify() failed — refusing to publish")
    if not problems:
        log("verify() passed")

    # The GRID is written only when the field is FRESH. A stale
    # composite keeps the published grid — its shape is right and its
    # date is old — and the META is refreshed so the legend can show
    # the date, but ONLY when the published grid IS this field: a meta
    # that describes a grid that is not the published one is a lie.
    published = None
    if os.path.exists(grid_path):
        published = open(grid_path, "rb").read()
    same_field = published == blob

    def write_meta(m: dict) -> None:
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2, ensure_ascii=False)
        log(f"wrote {meta_path}")

    if stale:
        age = meta.get("source_age_days")
        log(
            f"REFUSING to publish a composite that is {age} days old "
            f"(limit {MAX_AGE_DAYS}) — the published grid is unchanged"
        )
        if same_field:
            write_meta(meta)
        elif published is not None:
            log(
                "the published grid is a DIFFERENT field, so the meta "
                "is left alone — it describes the published grid"
            )
        # A non-zero exit is the alarm: the timer records it every day
        # until the source is fresh again (README Known Issues Q-N1).
        raise SystemExit(1)

    with open(grid_path, "wb") as fh:
        fh.write(blob)
    log(f"wrote {grid_path} ({len(blob) / 1e6:.2f} MB)")
    write_meta(meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
