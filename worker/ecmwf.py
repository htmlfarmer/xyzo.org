#!/usr/bin/env python3
"""ECMWF IFS open-data fetcher — mean sea-level pressure at 0.1°.

The GFS analysis the isobar layer was built on is 0.25° (25 km). ECMWF
publishes its IFS control forecast at **0.1° (9 km)**, which is 2.5× finer
and is the finest global MSLP field that is free, openly licensed and
keyless.

    https://data.ecmwf.int/forecasts/20261029/00z/ifs/0p1/oper/
        20261029000000-0h-oper-fc-sfc.grib2

Why this is safe to use:

* **No key, no login, no registration.** The OPeNDATA portal serves the
  open tiers directly. (The CDS *archive* API needs a key — that is a
  different service and is not used here.)
* **CC BY 4.0**, applied in addition to ECMWF's Terms of Use. The terms
  grant commercial use outright: *"Adapt — remix, transform, and build
  upon the material for any purpose, even commercially."* There is no
  NonCommercial and no ShareAlike clause. ECMWF must be acknowledged and
  the acknowledgement must be displayed prominently — see
  `docs/DATA_LICENSES.md` and `public_html/data/licenses` attribution
  strings.
* **Only 2.3 MB for the field we need.** The whole surface file is ~76 MB,
  but ECMWF ships a `.index` sidecar: one JSON object per field with the
  byte offset and length. A single HTTP `Range` request pulls exactly the
  `msl` message out of it.

Why it is NOT a drop-in replacement for GFS:

* **ECMWF is ~8.5 h behind GFS on publication.** The 06z IFS files land at
  roughly 14:30 UTC; the 06z GFS analysis lands at 09:30 UTC. The
  isobar worker therefore stores BOTH sources and the API picks whichever
  analysis is actually newer for the viewport.
* **Its longitude axis starts at 180°, not 0°.** `lon1 = 180` makes the
  decoded longitude array NON-MONOTONIC after the `% 360` wrap — the
  contour code interpolates edge crossings linearly in longitude and
  assumes monotonicity, so an unaligned field puts a distorted isobar near
  the antimeridian. `worker.isobars.align_longitudes()` rolls the columns
  before anything else touches the field.
* **Its smoothing sigma means something different.** The Gaussian sigma
  is in grid CELLS, so the same number smooths 2.5× less in degrees on a
  0.1° grid. The sigma is therefore expressed in degrees and converted
  per grid.

Cloud mirrors carry the identical layout (including the `.index`):

    s3://ecmwf-forecasts/                     (eu-central-1, no account needed)
    https://d2zvc0wgha4k2l.cloudfront.net/
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable

log = logging.getLogger("xyzo.ecmwf")

OPENDATA = "https://data.ecmwf.int/forecasts"

# The IFS control forecast ("oper"). ECMWF renamed HRES to
# "IFS Medium-range Control Forecast" when it added the 0.1° tier.
STREAM = "oper"

# 0p1 = 0.1° (9 km). The 0.25° tier is "0p25" and its files carry no
# surface/pressure suffix — only the 0.1° files are split by vertical
# level group, so the suffix is part of the name.
RESOLUTION = "0p1"
LEVEL_GROUP_SUFFIX = "sfc"


def build_run_url(date_str: str, cycle: str, res: str = RESOLUTION) -> str:
    """The GRIB2 URL for the surface-level fields of one IFS run."""
    return (
        f"{OPENDATA}/{date_str}/{cycle}z/ifs/{res}/{STREAM}/"
        f"{date_str}{cycle}0000-0h-{STREAM}-fc-{LEVEL_GROUP_SUFFIX}.grib2"
    )


def build_index_url(date_str: str, cycle: str, res: str = RESOLUTION) -> str:
    """The `.index` sidecar URL — one JSON record per field."""
    return build_run_url(date_str, cycle, res).replace(".grib2", ".index")


def _candidate_runs(max_days_back: int = 3) -> Iterable[tuple[str, str]]:
    """Yield (YYYYMMDD, HH) newest first, every 6 h back."""
    now = datetime.now(timezone.utc)
    cycle_hour = (now.hour // 6) * 6
    current = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    for _ in range(max_days_back * 4 + 1):
        yield current.strftime("%Y%m%d"), current.strftime("%H")
        current -= timedelta(hours=6)


def find_latest_run(force_run: str | None = None) -> tuple[str, str] | None:
    """Return (YYYYMMDD, HH) of the newest IFS run that is actually published.

    The 0.1° tier only exists from 20 October 2026, and ECMWF's nominal
    dissemination schedule is not a promise — the whole run's tree is
    written in one batch when the last forecast step lands, so every step
    of a run shares one timestamp. The nominal cycle is therefore probed
    with a HEAD request before it is accepted, and the walk falls back
    through the previous cycles.
    """
    if force_run:
        if len(force_run) not in (9, 10):
            raise ValueError("--run must be YYYYMMDDHH")
        return force_run[:8], force_run[8:]

    import httpx

    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        for date_str, cycle in _candidate_runs():
            url = build_index_url(date_str, cycle)
            try:
                resp = client.head(url)
            except Exception as exc:  # network hiccup — try the next cycle
                log.debug("HEAD %s failed: %s", url, exc)
                continue
            if resp.status_code == 200:
                return date_str, cycle
    return None


def find_msl_record(index_text: str, param: str = "msl") -> dict:
    """Locate one field's byte range in an ECMWF `.index` file.

    The index is a JSON-Lines document: one self-contained JSON object
    per field, each carrying `_offset` and `_length`. The surface-level
    `msl` record is the one with `param == "msl"` and `levtype == "sfc"`.
    """
    for line in index_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("param") != param:
            continue
        if rec.get("levtype") != "sfc":
            continue
        if "_offset" not in rec or "_length" not in rec:
            continue
        return rec
    raise RuntimeError(f"no {param!r} field in the ECMWF index file")


def fetch_msl(date_str: str, cycle: str, res: str = RESOLUTION) -> tuple[bytes, dict]:
    """Download the mean-sea-level-pressure message of one IFS run.

    Returns (grib_bytes, index_record). Only the `msl` message is pulled —
    a byte range of ~2.3 MB out of a ~76 MB file.
    """
    import httpx

    index_url = build_index_url(date_str, cycle, res)
    grib_url = build_run_url(date_str, cycle, res)

    with httpx.Client(timeout=300.0, follow_redirects=True) as client:
        idx = client.get(index_url)
        if idx.status_code != 200:
            raise RuntimeError(
                f"ECMWF index HTTP {idx.status_code} for {date_str} {cycle}Z"
            )
        rec = find_msl_record(idx.text)

        start = int(rec["_offset"])
        end = start + int(rec["_length"]) - 1
        resp = client.get(grib_url, headers={"Range": f"bytes={start}-{end}"})
        if resp.status_code not in (200, 206):
            raise RuntimeError(
                f"ECMWF GRIB HTTP {resp.status_code} for {date_str} {cycle}Z"
            )
        if resp.content[:4] != b"GRIB":
            raise RuntimeError("ECMWF range request did not return a GRIB message")

    log.info(
        "ECMWF IFS %s %sZ %s: msl %d bytes (offset %d)",
        res, date_str, cycle, len(resp.content), start,
    )
    return resp.content, rec


def attribution() -> str:
    """The attribution string ECMWF's Terms of Use require to be shown."""
    return (
        "European Centre for Medium-Range Weather Forecasts (ECMWF) — "
        "IFS open data (CC BY 4.0)"
    )
