#!/usr/bin/env python3
"""
Fetch the FAO AQUASTAT "Rivers (Global, edition 2026)" network to our own
disk.

WHY
---
The layer draws the real global river network — every reach on Earth
with a catchment of 10 km² or an average flow of 0.1 m³/s — and the
publisher's WMS renders it in ~2 s a tile (25-48 s for a whole-world
tile). We now serve the tiles through our own caching proxy, so the
publisher is only asked once per tile; but the FIRST reader of an area
still waits, and the first reader of the WORLD waits a minute.

So we take our own copy: one download, and the tiles are ours to
render, to cache and to serve.

LEGAL
-----
The FAO labels this layer **CC BY 4.0**. The upstream product it is
derived from — HydroRIVERS, and the HydroSHEDS version 1 core layers
it was extracted from — carries its own licence (Appendix A of the
HydroSHEDS Technical Documentation v1.4), which grants:

  * free use for **non-commercial AND commercial** use;
  * the right to integrate the data into Derivative Works and
    distribute those to end users;
  * with three conditions we must honour:
      - the Exhibit B attribution travels with the product's metadata;
      - the data is NOT to be distributed as a stand-alone product
        (so: no raw-data download link, no raw-data API);
      - end-user terms at least as protective as the licence.

We are doing none of the forbidden things: this copy is the SOURCE for
a rendered map layer, it lives outside the web root, and it is
published as map tiles, not as a dataset. See docs/DATA_LICENSES.md.

THE SERVICE, AND ITS TWO TRAPS
------------------------------
The publisher exposes it over WFS. Two things about that service are
worth writing down, because both cost an hour if you rediscover them:

  * **IT ONLY PAGES WITH A STABLE SORT.** `startIndex` without
    `sortBy` throws `java.lang.RuntimeException: java.io.IOException`
    (measured) — the server cannot resume a query whose order is not
    deterministic. `sortBy=hyriv_id` pages cleanly, and the ids are
    contiguous, so a page's last id is the next page's first id minus
    one. That continuity is what `verify()` checks.
  * **THE PAGE CAP IS 40,000.** `maxFeatures` above that is capped
    server-side, so the pages are 40,000 features each.

Usage:
  python3 scripts/river_network_fetch.py            # fetch, verify
  python3 scripts/river_network_fetch.py --verify-only
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "data", "rivers_fao_2026")

# THE LICENCE TEXT COMES FROM THE BUILDER, NOT FROM HERE.
#
# Two files carry the upstream attribution — this manifest (the copy,
# outside the web root) and the PUBLISHED meta.json (which the builder
# writes). They must not be two copies of one licence statement: the
# builder could not reproduce the published one, so a rebuild dropped it
# and the licence test failed. One text, imported from the publisher.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from river_network_build import (  # noqa: E402
    UPSTREAM,
    UPSTREAM_ATTRIBUTION,
    UPSTREAM_CITATION,
)

WFS_URL = "https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wfs"
TYPE_NAME = "aquamaps:river_network"
PAGE = 40000
UA = "xyzo-river-fetch/1.0 (+https://xyzo.org)"

# The rivers that must be in the copy, and where they are. A fetch that
# silently returns a different layer (or half of one) is caught here.
PROBES = [
    ("Amazon", -3.2, -60.0),
    ("Nile", 15.5, 32.5),
    ("Congo", -1.5, 20.0),
    ("Yangtze", 30.5, 112.5),
]


def log(msg: str) -> None:
    print(f"[river-fetch] {msg}", flush=True)


def page_url(start: int) -> str:
    q = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typeName": TYPE_NAME,
        "srsName": "CRS:84",
        "outputFormat": "application/json",
        "maxFeatures": str(PAGE),
        # THE STABLE SORT — without it the server cannot page.
        "sortBy": "hyriv_id",
        "startIndex": str(start),
    }
    return WFS_URL + "?" + urllib.parse.urlencode(q)


def fetch_page(start: int, timeout: int = 600) -> bytes:
    req = urllib.request.Request(page_url(start), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_page(raw: bytes):
    try:
        doc = json.loads(raw.decode("utf-8"))
    except Exception as exc:                       # noqa: BLE001
        raise RuntimeError(f"page at {start} is not JSON: {exc}") from exc
    feats = doc.get("features") or []
    if not feats:
        raise RuntimeError(f"page at {start} returned no features")
    ids = [int(f["properties"]["hyriv_id"]) for f in feats]
    return feats, min(ids), max(ids)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--max-pages", type=int, default=0,
                    help="stop after N pages (a trial run)")
    args = ap.parse_args()
    out = args.out

    if args.verify_only:
        return 0 if verify(out) else 2

    os.makedirs(out, exist_ok=True)
    manifest_path = os.path.join(out, "manifest.json")

    start = 0
    page_no = 0
    total = 0
    first_id = None
    last_id = None
    t0 = time.time()
    while True:
        if args.max_pages and page_no >= args.max_pages:
            log(f"stopping after {page_no} pages (--max-pages)")
            break
        raw = fetch_page(start)
        feats, lo, hi = parse_page(raw)
        name = f"page-{page_no:04d}.geojson.gz"
        path = os.path.join(out, name)
        with gzip.open(path, "wt", compresslevel=6) as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh,
                      separators=(",", ":"))
        if first_id is None:
            first_id = lo
        if last_id is not None and lo != last_id + 1:
            print(f"[river-fetch] GAP: page {page_no} starts at {lo}, "
                  f"the last page ended at {last_id}", file=sys.stderr)
            return 3
        last_id = hi
        total += len(feats)
        page_no += 1
        start += len(feats)
        log(f"page {page_no}: {len(feats)} features "
            f"(ids {lo}..{hi})  total {total}  "
            f"{time.time() - t0:.0f}s")
        if len(feats) < PAGE:
            break

    manifest = {
        "source": "FAO AQUASTAT — Rivers (Global, edition 2026)",
        "service": f"{WFS_URL} (typeName={TYPE_NAME})",
        "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "features": total,
        "pages": page_no,
        "page_size": PAGE,
        "hyriv_id_first": first_id,
        "hyriv_id_last": last_id,
        "license": "CC BY 4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "upstream": UPSTREAM,
        "upstream_attribution": UPSTREAM_ATTRIBUTION,
        "upstream_citation": UPSTREAM_CITATION,
        "note": (
            "The 2026 edition is published as a SERVICE only (no shapefile), "
            "so this copy was paged out of the WFS. It is the SOURCE for the "
            "rendered tile layer and lives OUTSIDE the web root: the upstream "
            "licence does not permit the data to be distributed as a "
            "stand-alone product."
        ),
    }
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=1)

    log(f"done: {total} features in {page_no} pages, "
        f"ids {first_id}..{last_id}, {time.time() - t0:.0f}s")
    return 0 if verify(out) else 2


def verify(out: str) -> bool:
    """The gate: the copy must be COMPLETE and CORRECT."""
    manifest_path = os.path.join(out, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"[river-fetch] no {manifest_path}", file=sys.stderr)
        return False
    with open(manifest_path) as fh:
        man = json.load(fh)

    ok = True
    # 1. THE PAGES MUST BE CONTIGUOUS. A gap means the copy is a
    #    arbitrary subset of the network, and the map would show rivers
    #    that are not connected to anything.
    pages = sorted(f for f in os.listdir(out) if f.startswith("page-"))
    if len(pages) != man["pages"]:
        print(f"[river-fetch] {len(pages)} page files, the manifest says "
              f"{man['pages']}", file=sys.stderr)
        ok = False
    total = 0
    last = None
    for name in pages:
        path = os.path.join(out, name)
        with gzip.open(path, "rt") as fh:
            feats = json.load(fh)["features"]
        if not feats:
            print(f"[river-fetch] {name} is empty", file=sys.stderr)
            ok = False
            continue
        ids = [int(f["properties"]["hyriv_id"]) for f in feats]
        if last is not None and min(ids) != last + 1:
            print(f"[river-fetch] GAP in {name}: starts at {min(ids)}, "
                  f"the previous page ended at {last}", file=sys.stderr)
            ok = False
        last = max(ids)
        total += len(feats)
    if total != man["features"]:
        print(f"[river-fetch] the pages hold {total} features, the manifest "
              f"says {man['features']}", file=sys.stderr)
        ok = False
    log(f"the copy holds {total} features, ids up to {last}")

    # 2. THE GREAT RIVERS MUST BE IN IT. A swapped axis or a truncated
    #    fetch still produces a plausible-looking file.
    for name, lat, lng in PROBES:
        found = None
        best = 2.0
        for page in pages:
            path = os.path.join(out, page)
            with gzip.open(path, "rt") as fh:
                for f in json.load(fh)["features"]:
                    for line in f["geometry"]["coordinates"]:
                        for x, y in line:
                            d = ((y - lat) ** 2 + ((x - lng) * 0.85) ** 2) ** 0.5
                            if d < best:
                                best = d
                                found = name
        good = found is not None
        log(f"probe {name:10s} -> {'found' if good else 'NOT FOUND'}")
        if not good:
            ok = False
    return ok


if __name__ == "__main__":
    raise SystemExit(main())
