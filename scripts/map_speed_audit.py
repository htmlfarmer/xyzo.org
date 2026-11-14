#!/usr/bin/env python3
"""
Measure what every map overlay costs the reader.

WHAT THIS IS
------------
The site has 31 overlays in the layers dropdown, and each one is a
different answer to "how much does this cost to switch on?" — a
different number of tiles, a different payload, a different source. There
was no way to compare them: the per-layer audits (`fao_rivers_audit.py`,
`globe_audit.py`, …) each answer a *correctness* question about one
layer, and they wait with a fixed `wait_for_timeout`, which measures
nothing.

So this measures the SAME thing for every layer, the same way.

THE METHOD: A DELTA AGAINST A BASELINE
--------------------------------------
A run with no overlays at all is the **baseline** — the shell, the
basemap, the pins, the feed. A run with exactly one overlay is the
**subject**. The difference between them is that overlay's cost.

**MEASURE THE LAYER AGAINST A MAP THAT NEVER HAD IT ON.** This is the
same rule the wind's dark-halo fix used, and the reason is the same:
a baseline that shares the layer's pixels subtracts the very thing
being measured, and a real improvement then reads as nothing. The
baseline here never had ANY overlay on, so it shares nothing.

**EVERY RUN IS A FRESH BROWSER CONTEXT**, so the HTTP cache, the
service worker's caches and the page are all cold. The first run of a
layer therefore pays for the publisher's cold work; a second run of the
SAME area does not. `--warm` measures the second case, which is what
every reader after the first actually experiences.

WHAT IS MEASURED
----------------
  * **requests** and **bytes** — from the browser's own Resource Timing
    API (`performance.getEntriesByType('resource')`), so the numbers are
    the browser's, not an estimate. `encodedBodySize` is the compressed
    size that went over the wire.
  * **t_quiet** — the moment the network stopped moving, i.e. when the
    reader can see everything that was going to arrive. Polled until the
    resource count stops growing for `QUIET_MS`.
  * **t_first** — the first resource that belongs to the subject, by the
    URL patterns the overlays are known to use. Reported as a hint, not
    as the headline number.
  * **t_map** — when the map itself was usable (`window._xyzoMap` exists
    and the container has a size).
  * **console errors** — a layer that paints but spams the console is
    not fast in any sense a reader cares about.

Usage:
  python3 scripts/map_speed_audit.py                     # every overlay, cold
  python3 scripts/map_speed_audit.py --warm              # …and warm
  python3 scripts/map_speed_audit.py --layers isobars,rivers-fao-2026
  python3 scripts/map_speed_audit.py --zoom 5 --lat 2.99 --lng 85.12
  python3 scripts/map_speed_audit.py --json reports/map_speed.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_URL = "https://xyzo.org/"

# How long the network must be quiet before we call the run finished.
QUIET_MS = 1200
# How long we are prepared to wait for that.
MAX_WAIT_MS = 90_000
# How long we wait between polls of the resource list.
POLL_MS = 250

# The patterns the overlays' own resources use. This is a HINT for
# "when did this layer's own content start arriving" — the headline
# numbers are the delta against the baseline, which need no pattern.
LAYER_URL_HINTS = {
    "isobars": ("/api/weather/isobars",),
    "rivers": ("/data/rivers/",),
    "rivers-fao-2026": ("/api/tile/fao-rivers", "/data/rivers/fao/tiles"),
    "soil-soilgrids": ("/data/soil/",),
    "soil-hwsd": ("/data/soil/hwsd",),
    "cropland-esa": ("/data/cropland/",),
    "land-cover-esa": ("/data/cropland/",),
    "temperature": ("/data/temp/",),
    "lightning": ("/data/lightning/",),
    "phytoplankton": ("/data/phytoplankton/",),
    "magnetic": ("/data/mag/",),
    "wind-gfs": ("/data/wind/",),
    "wind-speed-gfs": ("/data/wind/",),
    "basins": ("/data/basins/",),
    "languages": ("/data/languages/",),
    "language-regions": ("/data/languages/",),
    "geology-macrostrat": ("tiles.macrostrat.org",),
    "geologic-contacts-usgs": ("mrdata.usgs.gov",),
    "city-names": ("/data/cities",),
    "waves": ("/data/waves/",),
    "cape-gfs": ("/data/cape/",),
    "ivt-gfs": ("/data/ivt/",),
    "ocean-currents-live": ("/data/ocean",),
    "ocean-currents-ecco": ("/data/transport/ocean",),
    "earthquakes-usgs": ("/data/earthquakes/",),
    "faults-usgs": ("/data/faults/",),
    "salinity": ("/data/salinity/",),
    "etopo": ("/data/etopo/",),
    "population": ("/data/population/",),
    "transportation": ("/data/transport/",),
    "nasa-satellite": ("/api/tile/satellite",),
    "nasa-rain": ("/api/tile/rain",),
    "nasa-night": ("/api/tile/night",),
    "facebook": ("/data/facebook/",),
}


def log(msg: str) -> None:
    print(f"[map-speed] {msg}", flush=True)


def host_of(url: str) -> str:
    try:
        return url.split("/")[2]
    except Exception:
        return "?"


def measure(page, timeout_ms: int = MAX_WAIT_MS):
    """Run one page and return what the browser recorded.

    Returns a dict with the navigation timings, the resource list and
    the moment the network went quiet.
    """
    page.evaluate("() => { window.__mapSpeedStart = performance.now(); }")
    t0 = time.time()
    last_count = -1
    stable_since = None
    quiet_at = None

    while (time.time() - t0) * 1000 < timeout_ms:
        count = page.evaluate(
            "() => performance.getEntriesByType('resource').length")
        if count != last_count:
            last_count = count
            stable_since = time.time()
        elif stable_since and (time.time() - stable_since) * 1000 >= QUIET_MS:
            quiet_at = (time.time() - t0) * 1000
            break
        page.wait_for_timeout(POLL_MS)

    data = page.evaluate(
        """() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const res = performance.getEntriesByType('resource').map(e => ({
            name: e.name,
            dur: Math.round(e.duration),
            size: e.encodedBodySize || 0,
            transfer: e.transferSize || 0,
            start: Math.round(e.startTime),
            type: e.initiatorType,
          }));
          const map = window._xyzoMap;
          const el = document.getElementById('map');
          return {
            dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
            load: nav ? Math.round(nav.loadEventEnd) : null,
            mapReady: !!(map && el && el.getBoundingClientRect().width > 0),
            resources: res,
          };
        }"""
    )
    data["quiet_ms"] = round(quiet_at) if quiet_at is not None else None
    data["wall_ms"] = round((time.time() - t0) * 1000)
    return data


def aggregate(resources):
    """Requests, bytes and the slowest resources, grouped by host."""
    by_host = defaultdict(lambda: {"requests": 0, "bytes": 0})
    total_bytes = 0
    for r in resources:
        h = host_of(r["name"])
        by_host[h]["requests"] += 1
        by_host[h]["bytes"] += r["size"]
        total_bytes += r["size"]
    slowest = sorted(resources, key=lambda r: -r["dur"])[:5]
    return {
        "requests": len(resources),
        "bytes": total_bytes,
        "by_host": dict(by_host),
        "slowest": [
            {"url": r["name"][-90:], "ms": r["dur"], "kb": round(r["size"] / 1024, 1)}
            for r in slowest
        ],
    }


def first_for(resources, hints):
    """The first resource matching this layer's URL patterns."""
    if not hints:
        return None
    for r in sorted(resources, key=lambda r: r["start"]):
        if any(h in r["name"] for h in hints):
            return {"url": r["name"][-90:], "ms": r["start"], "kb": round(r["size"] / 1024, 1)}
    return None


def run_case(browser, base_url: str, view: str, slug: str | None, warm: bool):
    """One measured run: a fresh context, one overlay (or none)."""
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:160]))
    page.on("console", lambda m: errors.append(m.text[:160]) if m.type == "error" else None)

    hash_ = view
    if slug:
        hash_ = f"{view}/overlay={slug}@100"
    try:
        page.goto(base_url + "#" + hash_, wait_until="domcontentloaded", timeout=60000)
        # The map must exist before we can talk about what it loads.
        for _ in range(80):
            if page.evaluate("() => !!window._xyzoMap"):
                break
            page.wait_for_timeout(250)
        data = measure(page)
        data["errors"] = errors
        data["agg"] = aggregate(data["resources"])
        data["hints"] = LAYER_URL_HINTS.get(slug or "", ())
        data["first"] = first_for(data["resources"], data["hints"])
        return data
    finally:
        ctx.close()


def fmt_kb(n: int) -> str:
    return f"{n/1024:,.0f} KB" if n < 1024 * 1024 else f"{n/1024/1024:.1f} MB"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--lat", default="20")
    ap.add_argument("--lng", default="10")
    ap.add_argument("--zoom", default="3")
    ap.add_argument("--layers", default="",
                    help="comma-separated slugs (default: every overlay in the dropdown)")
    ap.add_argument("--warm", action="store_true",
                    help="also measure the second visit (the caches are warm)")
    ap.add_argument("--json", default=os.path.join(REPO, "reports", "map_speed.json"))
    ap.add_argument("--baseline-only", action="store_true")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    view = f"{args.lat},{args.lng},{args.zoom}"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])

        # ── the overlay list, read from the live dropdown ──────────────
        if args.layers:
            slugs = [s.strip() for s in args.layers.split(",") if s.strip()]
        else:
            ctx = browser.new_context(viewport={"width": 1400, "height": 900})
            page = ctx.new_page()
            page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(9000)
            rows = page.evaluate(
                """() => {
                  const out = [];
                  document.querySelectorAll('.leaflet-control-layers-overlays label')
                    .forEach(l => {
                      const cb = l.querySelector('input[type=checkbox]');
                      if (!cb) return;
                      out.push(l.textContent.replace(/\\s+/g, ' ').trim());
                    });
                  // the isobar row is injected beside the base list, not
                  // inside the overlay list
                  document.querySelectorAll('.leaflet-control-layers-list label')
                    .forEach(l => {
                      const t = l.textContent.replace(/\\s+/g, ' ').trim();
                      if (/isobar|pressure/i.test(t) && !out.includes(t)) out.push(t);
                    });
                  return out;
                }"""
            )
            names = page.evaluate(
                "(ns) => ns.map(n => (window.__xyzoLayerSlug ? window.__xyzoLayerSlug(n) : n))",
                rows)
            ctx.close()
            slugs = [s for s in names if s]
            log(f"{len(slugs)} overlays found in the dropdown")

        # ── the baseline ───────────────────────────────────────────────
        log("measuring the BASELINE (no overlays)…")
        base = run_case(browser, args.url, view, None, False)
        log(f"  baseline: {base['agg']['requests']} requests, "
            f"{fmt_kb(base['agg']['bytes'])}, quiet at {base['quiet_ms']} ms, "
            f"{len(base['errors'])} console errors")

        base_urls = {r["name"] for r in base["resources"]}

        results = []
        if not args.baseline_only:
            for i, slug in enumerate(slugs, 1):
                log(f"[{i}/{len(slugs)}] {slug}…")
                cold = run_case(browser, args.url, view, slug, False)
                # **NO DELTA AGAINST THE BASELINE, AND NO HAND-KEPT
                # URL TABLE.** The baseline varies run to run — the pins,
                # the feed and the basemap move by more than most layers
                # cost — so a difference went NEGATIVE and reported a
                # layer as "saving" bytes. And a slug→pattern table
                # drifts the moment a layer is renamed (measured: the
                # fault layer's slug had changed and it attributed 0).
                #
                # What is honest and cannot drift: **this run's own
                # totals, plus every resource the baseline did NOT make**
                # — those belong to this layer by construction.
                own = [r for r in cold["resources"]
                       if r["name"] not in base_urls]
                row = {
                    "slug": slug,
                    "cold": {
                        "requests": cold["agg"]["requests"],
                        "bytes": cold["agg"]["bytes"],
                        "own_requests": len(own),
                        "own_bytes": sum(r["size"] for r in own),
                        "quiet_ms": cold["quiet_ms"],
                        "first": cold["first"],
                        "errors": cold["errors"],
                        "by_host": cold["agg"]["by_host"],
                    },
                }
                if args.warm:
                    warm = run_case(browser, args.url, view, slug, True)
                    row["warm"] = {
                        "requests": warm["agg"]["requests"],
                        "bytes": warm["agg"]["bytes"],
                        "quiet_ms": warm["quiet_ms"],
                    }
                results.append(row)
                c = row["cold"]
                log(f"    this run {c['requests']} req / {fmt_kb(c['bytes'])}, "
                    f"of which this layer {c['own_requests']} req / "
                    f"{fmt_kb(c['own_bytes'])}; quiet at {c['quiet_ms']} ms, "
                    f"{len(c['errors'])} errors")

        browser.close()

    # ── the report ───────────────────────────────────────────────────
    report = {
        "view": view,
        "url": args.url,
        "baseline": {
            "requests": base["agg"]["requests"],
            "bytes": base["agg"]["bytes"],
            "quiet_ms": base["quiet_ms"],
            "dcl": base["dcl"],
            "load": base["load"],
            "errors": base["errors"],
        },
        "layers": sorted(results, key=lambda r: -r["cold"]["own_bytes"]),
    }
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump(report, fh, indent=1)
    log(f"wrote {args.json}")

    print()
    print(f"  baseline: {base['agg']['requests']} requests, "
          f"{fmt_kb(base['agg']['bytes'])}, quiet at {base['quiet_ms']} ms")
    print()
    print(f"  {'overlay':30s} {'own req':>7s} {'own bytes':>10s} {'quiet ms':>9s}  {'first':>8s}  errors")
    print("  " + "-" * 84)
    for r in report["layers"]:
        c = r["cold"]
        first = c["first"]["ms"] if c["first"] else None
        print(f"  {r['slug'][:30]:30s} {c['own_requests']:7d} {fmt_kb(c['own_bytes']):>10s} "
              f"{str(c['quiet_ms']):>9s}  {str(first):>8s}  {len(c['errors'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
