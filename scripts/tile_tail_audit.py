#!/usr/bin/env python3
"""
tile_tail_audit.py — WHICH overlay tiles arrive last, and when did the
screen stop changing?

Owner report (2026-11-19): *"if you load a page.. not all the tiles will
load but if you wait like 2 min or 3 min finally the last tiles will all
turn blue.. it kinda takes time and you maybe even have to pan around
the map."*

map_speed_audit.py answers "how many bytes does this overlay cost". This
answers a different question: **which tiles never arrived, and did the
ones that did arrive belong to the layers the link asked for.**

WHY CDP AND NOT RESOURCE TIMING
-------------------------------
`performance.getEntriesByType('resource')` only lists a resource once it
is DONE. A tile that is still in flight when the run ends is invisible
there — which is precisely the tile this audit exists to find. So it uses
the CDP Network domain (requestWillBeSent / responseReceived /
loadingFinished / loadingFailed), which reports every request including
the ones that never finish, and it polls the DOM for the Leaflet tile
images the reader is actually looking at.

The DOM probe reports `.leaflet-tile` images that are not `complete`.
NOTE: the wind layer renders `<canvas>` tiles, and a canvas has no
`complete` property — so `!complete` counts them as pending for ever.
Those are reported separately as `canvasTiles` and are NOT pending.

Usage:
  python3 scripts/tile_tail_audit.py --wait 120
  python3 scripts/tile_tail_audit.py --throttle "Regular 3G" --wait 240
  python3 scripts/tile_tail_audit.py --json reports/tile_tail.json --shot /tmp/t.png

Pass --url to audit a different link (defaults to the owner's nine-
overlay link, which is the case that regressed).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

# The owner's link — nine overlays, and the one that showed the defect.
DEFAULT_URL = (
    "https://xyzo.org/#6.6537,-65.7202,6/density=max/overlay="
    "rivers@100,tectonic-faults-usgs@100,soil-soilgrids@20,"
    "cropland-esa@40,population-density-worldpop-1-km@20,koppen@20,"
    "rivers-fao-2026@90,wind-gfs@100,isobars@100/iso=0.1:pressure/"
    "isoSrc=auto/wind=particles:colourful:100/rivers=medium"
)

# What each URL pattern says about which layer is asking.
LAYERS = [
    ("/tile/mirror/esri-imagery", "basemap-esri"),
    ("/tile/mirror/esri-street", "basemap-esri"),
    ("/tile/mirror/esri-dark", "basemap-esri"),
    ("/tile/mirror/esri-light", "basemap-esri"),
    ("/tile/mirror/esri-natgeo", "basemap-esri"),
    ("/tile/mirror/esri-terrain", "basemap-esri"),
    ("/tile/mirror/osm", "basemap-osm"),
    ("/tile/mirror/opentopo", "basemap-opentopo"),
    ("/tile/mirror/macrostrat", "geology"),
    ("/tile/mirror/worldpop", "POPULATION"),
    ("/tile/mirror/hwsd", "soil-hwsd"),
    ("/api/tile/fao-rivers", "rivers-fao"),
    ("/data/koppen/", "koppen"),
    ("/data/soil/", "soil"),
    ("/data/cropland/", "cropland"),
    ("/data/rivers/", "rivers-data"),
    ("/data/faults/", "faults"),
    ("/data/gem-faults/", "faults"),
    ("/data/earthquakes/", "earthquakes"),
    ("/api/weather/isobars", "isobars"),
    ("/data/wind/", "wind-grid"),
    ("/api/tile/rain", "nasa-rain"),
    ("/api/tile/night", "nasa-night"),
    ("/api/tile/satellite", "nasa-sat"),
]

# Everything that is a picture the map draws, i.e. worth attributing.
TILE_HINTS = (
    "/api/tile/",
    "/data/koppen/",
    "/data/soil/",
    "/data/cropland/",
    "/data/rivers/",
    "/data/faults/",
    "/data/gem-faults/",
    "/data/earthquakes/",
    "/data/etopo/",
    "/data/basins/",
    "/data/wind/",
    ".png",
    ".jpg",
    ".webp",
)


def layer_of(url: str) -> str:
    for pat, name in LAYERS:
        if pat in url:
            return name
    if "/data/" in url:
        return "data:" + url.split("/data/")[1].split("/")[0]
    if "/api/tile/" in url:
        return "tile:" + url.split("/api/tile/")[1].split("/")[0]
    if "/api/" in url:
        return "api:" + url.split("/api/")[1].split("?")[0][:32]
    if "tile." in url or "/tiles/" in url:
        return "ext-tile"
    return "other"


def is_tile(url: str) -> bool:
    return any(h in url for h in TILE_HINTS)


# Split <img> tiles (which have `complete`) from <canvas> tiles (which do
# not — the wind layer paints canvases, and counting them as pending is
# the false positive that makes this probe look alarming when nothing is
# wrong).
PROBE = r"""() => {
  const imgs = [...document.querySelectorAll('.leaflet-tile')]
                 .filter(e => e.tagName === 'IMG');
  const canv = [...document.querySelectorAll('.leaflet-tile')]
                 .filter(e => e.tagName !== 'IMG');
  const pending = imgs.filter(i => !i.complete);
  const broken  = imgs.filter(i => i.complete && i.naturalWidth === 0);
  return {
    imgTiles: imgs.length,
    canvasTiles: canv.length,
    pending: pending.length,
    broken: broken.length,
    pendingSample: pending.slice(0, 6).map(i => (i.src || '').slice(0, 150)),
    brokenSample: broken.slice(0, 6).map(i => (i.src || '').slice(0, 150)),
  };
}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--wait", type=int, default=120, help="seconds to watch")
    ap.add_argument("--poll", type=float, default=2.0, help="probe interval")
    ap.add_argument("--json", default="")
    ap.add_argument("--shot", default="")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument(
        "--throttle",
        default="",
        help="Regular 3G | Fast 3G | Slow 3G | Fast 4G (CDP network emulation)",
    )
    ap.add_argument(
        "--overlay-quiet",
        type=int,
        default=15,
        help="stop early once no overlay tile has been seen for N seconds",
    )
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    presets = {
        "Slow 3G": (500 * 1024 / 8, 400),
        "Fast 3G": (1.6 * 1024 * 1024 / 8, 150),
        "Regular 3G": (750 * 1024 / 8, 100),
        "Fast 4G": (9 * 1024 * 1024 / 8, 70),
    }

    events: dict[str, dict] = {}
    console: list[str] = []
    failures: list[str] = []
    t0 = time.time()
    snapshots: list[dict] = []
    last_overlay_at: float | None = None

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        cdp.send("Network.enable")
        if args.throttle:
            dl, lat = presets.get(args.throttle, (0, 0))
            if not dl:
                print(f"unknown --throttle {args.throttle!r}", file=sys.stderr)
                return 2
            cdp.send(
                "Network.emulateNetworkConditions",
                {
                    "offline": False,
                    "latency": lat,
                    "downloadThroughput": dl,
                    "uploadThroughput": dl / 2,
                },
            )

        def note(m):
            rid = m.get("requestId")
            if not rid:
                return None
            return events.setdefault(
                rid,
                {
                    "url": "",
                    "t_start": None,
                    "t_end": None,
                    "status": None,
                    "size": 0,
                    "from_cache": False,
                    "failed": None,
                },
            )

        def on_req(m):
            e = note(m)
            if e is None:
                return
            e["url"] = m["request"]["url"]
            e["t_start"] = (time.time() - t0) * 1000
            if is_tile(e["url"]) and any(
                x in e["url"] for x in ("/data/", "/api/tile/")
            ):
                nonlocal last_overlay_at
                last_overlay_at = time.time() - t0

        def on_resp(m):
            e = note(m)
            if e is None:
                return
            r = m.get("response", {})
            e["status"] = r.get("status")
            e["from_cache"] = bool(
                r.get("fromDiskCache") or r.get("fromPrefetchCache")
            )

        def on_fin(m):
            e = note(m)
            if e is None:
                return
            e["t_end"] = (time.time() - t0) * 1000
            e["size"] = m.get("encodedDataLength", 0)

        def on_fail(m):
            e = note(m)
            if e is None:
                return
            e["t_end"] = (time.time() - t0) * 1000
            e["failed"] = m.get("errorText", "")

        cdp.on("Network.requestWillBeSent", on_req)
        cdp.on("Network.responseReceived", on_resp)
        cdp.on("Network.loadingFinished", on_fin)
        cdp.on("Network.loadingFailed", on_fail)

        page.on(
            "console",
            lambda m: console.append(f"{m.type}: {m.text[:220]}")
            if m.type in ("error", "warning")
            else None,
        )
        page.on(
            "requestfailed",
            lambda r: failures.append(f"{r.url[:150]} :: {r.failure}"),
        )

        page.goto(args.url, wait_until="domcontentloaded", timeout=90000)

        quiet_streak = 0.0
        while time.time() - t0 < args.wait:
            page.wait_for_timeout(int(args.poll * 1000))
            try:
                snap = page.evaluate(PROBE)
            except Exception as e:  # page mid-navigation
                snap = {"error": str(e)[:80]}
            snap["t"] = round(time.time() - t0, 1)
            snapshots.append(snap)
            done = sum(1 for e in events.values() if e["t_end"] is not None)
            print(
                f"[{snap.get('t', 0):6.1f}s] img={snap.get('imgTiles', '-'):>4} "
                f"canvas={snap.get('canvasTiles', '-'):>3} "
                f"pending={snap.get('pending', '-'):>4} "
                f"broken={snap.get('broken', '-'):>3}  "
                f"req={len(events):4d} done={done:4d}",
                flush=True,
            )
            # Stop early once the map has been quiet AND a real run of
            # overlay tiles has been seen — so the default run does not
            # have to sit for the full --wait on a healthy page.
            if last_overlay_at is not None and snap.get("pending", 0) == 0:
                if time.time() - t0 - last_overlay_at > args.overlay_quiet:
                    print(
                        f"  quiet for {args.overlay_quiet}s after the last "
                        f"overlay tile — stopping early",
                        flush=True,
                    )
                    break

        if args.shot:
            page.screenshot(path=args.shot)
        browser.close()

    tiles = {k: v for k, v in events.items() if v["url"] and is_tile(v["url"])}
    now_ms = (time.time() - t0) * 1000

    print("\n=== TILE TAIL: last 20 tiles to finish ===")
    tail = sorted(
        (v for v in tiles.values() if v["t_end"] is not None),
        key=lambda v: v["t_end"],
        reverse=True,
    )[:20]
    for v in tail:
        print(
            f"  {v['t_end']:8.0f}ms [{layer_of(v['url']):16s}] st={v['status']} "
            f"cache={v['from_cache']} {v['url'][:105]}"
        )

    inflight = [v for v in tiles.values() if v["t_end"] is None]
    print(f"\n=== STILL IN FLIGHT at end: {len(inflight)} ===")
    for v in inflight[:25]:
        st = v["t_start"] or 0
        print(f"  age={now_ms - st:8.0f}ms [{layer_of(v['url']):16s}] {v['url'][:105]}")

    by = defaultdict(lambda: {"n": 0, "done": 0, "last": 0.0, "bytes": 0})
    for v in tiles.values():
        b = by[layer_of(v["url"])]
        b["n"] += 1
        if v["t_end"] is not None:
            b["done"] += 1
            b["last"] = max(b["last"], v["t_end"])
            b["bytes"] += v["size"]
    print("\n=== per layer ===")
    for k, v in sorted(by.items(), key=lambda kv: -kv[1]["last"]):
        flag = "  <-- MISSING" if v["done"] < v["n"] else ""
        print(
            f"  {k:18s} n={v['n']:4d} done={v['done']:4d} "
            f"last={v['last']:8.0f}ms  {v['bytes'] / 1024:9.0f}KB{flag}"
        )

    # THE HEADLINE. A layer the link named that drew zero tiles is the
    # defect this audit exists for — say so in one line.
    drawn = {k for k, v in by.items() if v["done"] > 0}
    expected = {
        "soil",
        "cropland",
        "koppen",
        "POPULATION",
        "rivers-fao",
        "faults",
    }
    missing = sorted(expected - drawn)
    print("\n=== verdict ===")
    if missing:
        print(f"  MISSING OVERLAY LAYERS: {', '.join(missing)}")
    else:
        print("  every expected overlay layer drew tiles ✓")

    last_snap = snapshots[-1] if snapshots else {}
    print(
        f"  last DOM probe: img={last_snap.get('imgTiles')} "
        f"canvas={last_snap.get('canvasTiles')} "
        f"pending={last_snap.get('pending')} "
        f"broken={last_snap.get('broken')}"
    )
    print(f"  console errors/warnings = {len(console)}")
    for c in console[:20]:
        print("     ", c)
    print(f"  request failures = {len(failures)}")
    for f in failures[:20]:
        print("     ", f)

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(
            json.dumps(
                {
                    "url": args.url,
                    "throttle": args.throttle,
                    "tiles": list(tiles.values()),
                    "snapshots": snapshots,
                    "console": console,
                    "failures": failures,
                    "missing_layers": missing,
                },
                indent=1,
                default=str,
            )
        )
        print(f"  wrote {args.json}")

    return 1 if missing or inflight else 0


if __name__ == "__main__":
    sys.exit(main())
