"""Reproduce: does searching a place move the map to that place?

Types a query into the real search box and reports the map's centre and
zoom before and after, plus the status line — so "it didn't move me" is a
measurement rather than an impression.

Run: python3 scripts/search_place_check.py [--query "el salvador"]
"""
import argparse
import sys
from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="el salvador")
    ap.add_argument("--shot", default=None)
    args = ap.parse_args()

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        # start somewhere far away so a move is unmistakable
        page.goto(BASE + "#-33.8688,151.2093,10", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(6000)

        before = page.evaluate(
            """() => { const c = window._xyzoMap.getCenter();
                       return { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), zoom: +window._xyzoMap.getZoom() }; }"""
        )
        print(f"before : {before['lat']}, {before['lng']}  zoom {before['zoom']}")

        page.fill("#search-input", args.query)
        page.click("#search-btn")
        # The endpoint takes ~8-10s under load; measuring at 6s catches the
        # map mid-request and reports "did not move" for a search that works.
        page.wait_for_timeout(12000)

        after = page.evaluate(
            """() => { const c = window._xyzoMap.getCenter();
                       return { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), zoom: +window._xyzoMap.getZoom(),
                                status: (document.querySelector('#search-status, .search-status, #status')||{}).textContent || null }; }"""
        )
        print(f"after  : {after['lat']}, {after['lng']}  zoom {after['zoom']}")
        moved = abs(after["lat"] - before["lat"]) > 0.5 or abs(after["lng"] - before["lng"]) > 0.5
        print(f"moved  : {moved}")

        if args.shot:
            page.screenshot(path=args.shot)
        b.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
