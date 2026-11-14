#!/usr/bin/env python3
"""
first_load_audit.py — does a reader get a MAP, or an error notice?

WHAT THIS IS
------------
The owner's report: *"markers seem to be taking a long time to load... in
fact it took more then a few min when my friend tried to load"*, then
*"seems to take about 30 to 45 seconds... are you sure.???"*.

The first measurement of that was wrong three ways — it timed the FIRST
markers, it ran over the loopback, and it sampled the resource timing
while the heavy responses were still in flight. The honest measurement
(throttled slow-3G) found a twenty-second gap between the pins ARRIVING
and the markers being PAINTED, caused by the main thread decoding 280
tile images.

**AND THEN THE READER PASTED A LIVE FAILURE**, which is worth more than
any measurement:

    📡 Connection hiccup
    cached 1h ago — Brief network issue — showing cached data.
    { "kind": "exception", "errorMessage": "Set map center and zoom first." }

That is Leaflet refusing to answer because the map had **no view**: the
boot had been changed to set the view from the link's hash, and it was
done with a constructor option Leaflet 1.9.4 does not have — so the map
was left with no view at all, and the FIRST pin fetch (which asks the
map for its bounds) died.

**SO THIS AUDIT IS ABOUT THE THING THAT ACTUALLY BROKE**, and it runs in
**BOTH BROWSERS**, because the failure only showed on Firefox:

  * no page errors (an exception in the boot kills the rest of app.js);
  * the map HAS a view (`getZoom()` works — Leaflet's `_checkIfLoaded`
    throws "Set map center and zoom first." when it does not);
  * the MARKERS arrive (the pin canvas has pins);
  * the container has a HEIGHT (the Firefox first-load race leaves it at
    0 px, and the map is then invisible);
  * the overlays the link asked for are ON;
  * **and the stale-data banner is NOT showing** — a reader who gets
    "Connection hiccup — showing cached data" has been given a failure
    notice where a map belongs.

THE URL is the owner's own fifteen-overlay link, because that is the
case that broke.

Usage:
    python3 scripts/first_load_audit.py                # both browsers
    python3 scripts/first_load_audit.py --browser firefox
    python3 scripts/first_load_audit.py --url "<url>"
"""
from __future__ import annotations

import argparse
import sys
import time

from playwright.sync_api import sync_playwright

# The owner's own report — a shared link with fifteen overlays on it.
DEFAULT_URL = (
    "https://xyzo.org/#46.5589,-117.0758,7/density=max/"
    "overlay=wind-gfs@100,basins@100,koppen@100,soil-soilgrids@65,rivers@100,"
    "cropland-esa@50,population-density-worldpop-1-km@25,land-cover-esa@60,"
    "soil-type-hwsd-v2-2@30,wind-speed-gfs@30,tectonic-faults-usgs@100,"
    "nasa-rain@30,etopo@55,isobars@100/iso=0.25:pressure/isoSrc=gfs/"
    "wind=particles:speed:100"
)

# The selectors that can carry the "showing cached data" notice.
STALE_SELECTORS = [
    "#stale-data-banner",
    "#stale-banner",
    ".stale-data-banner",
    ".stale-banner",
    "[data-stale-banner]",
]


def check(page, url: str, wait_s: int) -> tuple[bool, list[str]]:
    """Load the URL and report on what the reader ends up with."""
    problems: list[str] = []
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.on(
        "console",
        lambda m: errors.append("console: " + m.text[:160]) if m.type == "error" else None,
    )

    t0 = time.time()
    page.goto(url, wait_until="domcontentloaded", timeout=120_000)
    page.wait_for_function("window._xyzoMap !== undefined", timeout=60_000)

    # When do the markers arrive?
    painted = None
    deadline = time.time() + 90
    while time.time() < deadline and painted is None:
        page.wait_for_timeout(400)
        try:
            n = page.evaluate("() => (window._canvasPinRenderer?._pins||[]).length")
        except Exception:
            n = 0
        if n and n > 0:
            painted = time.time() - t0
    page.wait_for_timeout(max(0, wait_s - int(time.time() - t0)))

    def safe(expr: str):
        try:
            return page.evaluate(expr)
        except Exception as exc:  # a throwing accessor IS a finding
            return f"THREW: {str(exc)[:120]}"

    zoom = safe("() => window._xyzoMap.getZoom()")
    if isinstance(zoom, str):
        problems.append(f"the map has NO VIEW — getZoom() {zoom}")
    elif zoom is None:
        problems.append("the map has NO VIEW — getZoom() returned nothing")

    box = safe(
        "() => { const r = document.getElementById('map').getBoundingClientRect();"
        " return [Math.round(r.width), Math.round(r.height)]; }"
    )
    if isinstance(box, list) and (box[1] < 50 or box[0] < 50):
        problems.append(f"the map container has no size — {box}")

    pins = safe("() => (window._canvasPinRenderer?._pins||[]).length")
    if not pins:
        problems.append("no markers arrived")

    overlays = safe(
        "() => document.querySelectorAll('.leaflet-control-layers-overlays input:checked').length"
    )
    if not overlays:
        problems.append("none of the link's overlays are on")

    stale = safe(
        "() => { for (const s of %s) { const el = document.querySelector(s);"
        " if (el && !el.hidden && el.offsetParent !== null) return el.textContent.slice(0, 80); }"
        " return ''; }" % repr(STALE_SELECTORS)
    )
    if stale:
        problems.append(f"the stale-data notice is showing: {stale!r}")

    if errors:
        problems.append(f"page errors: {errors[:3]}")

    return (not problems), problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--browser", default="both", choices=["chromium", "firefox", "both"])
    ap.add_argument("--wait", type=int, default=20, help="seconds to wait after the markers")
    args = ap.parse_args()

    browsers = ["chromium", "firefox"] if args.browser == "both" else [args.browser]
    failed = 0
    with sync_playwright() as p:
        for name in browsers:
            launcher = getattr(p, name)
            browser = launcher.launch(headless=True)
            ctx = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            try:
                ok, problems = check(page, args.url, args.wait)
            except Exception as exc:
                ok, problems = False, [f"the audit itself failed: {exc}"]
            finally:
                ctx.close()
                browser.close()
            if ok:
                print(f"  ✓ {name}: the reader gets a map")
            else:
                failed += 1
                print(f"  ✗ {name}:")
                for p_ in problems:
                    print(f"      - {p_}")
    if failed:
        print(f"\n  {failed} browser(s) FAILED — a reader would see a failure notice, not a map.")
        return 1
    print("\n  all browsers OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
