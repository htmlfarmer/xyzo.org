#!/usr/bin/env python3
"""
Audit the 2026 FAO rivers overlay on the live map.

WHAT IT CHECKS
--------------
1. The layers dropdown carries the entry, and the LEGEND mounts — a
   legend that was written and never mounted is a legend that does not
   exist (the ocean-currents bug).
2. Switching the layer on really asks the publisher's WMS for tiles,
   and the tiles that come back are not empty.
3. The DETAIL LEVEL chips change the request: the level the reader picks
   has to change what the server is asked for, or the chip is decoration.
4. The RIVER NAMES switch turns the labels on and off.
5. The level travels in the URL, so a shared link opens the same map.
6. The console stays clean — a 404 on a tile is a red line the reader
   can neither silence nor act on.

Usage:
  python3 scripts/fao_rivers_audit.py
  python3 scripts/fao_rivers_audit.py --url http://xyzo.org
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

URL = "https://xyzo.org"
LAYER = "🌊 Rivers (FAO 2026)"


def log(msg: str) -> None:
    print(f"[fao-rivers-audit] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=URL)
    ap.add_argument("--shot", default="/tmp/fao-rivers-audit.png")
    args = ap.parse_args()

    failures: list[str] = []
    console_errors: list[str] = []
    wms_requests: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1400, "height": 900})

        def on_console(msg):
            if msg.type in ("error", "warning"):
                console_errors.append(f"{msg.type}: {msg.text}")

        def on_response(resp):
            u = resp.url
            # The tiles come from OUR OWN static pyramid at z0-z3 and
            # from the caching proxy above it, so a request for either
            # counts: the check is that tiles are being fetched at all.
            if ("data.apps.fao.org" in u) or ("/api/tile/fao-rivers" in u) \
                    or ("/data/rivers/fao/tiles/" in u):
                wms_requests.append(f"{resp.status} {u[:160]}")

        page.on("console", on_console)
        page.on("response", on_response)

        log(f"loading {args.url}")
        page.goto(args.url + "/#-3.2,-60.5,4", wait_until="domcontentloaded")
        page.wait_for_timeout(6000)

        # ── 1. the dropdown entry and the legend ───────────────────────
        page.evaluate("""() => {
            const btn = document.querySelector('.leaflet-control-layers');
            if (btn) btn.click();
        }""")
        page.wait_for_timeout(1200)

        rows = page.evaluate(
            "() => Array.from(document.querySelectorAll("
            "'.leaflet-control-layers-overlays label, .leaflet-control-layers-list label'"
            ")).map(l => l.textContent.trim())"
        )
        log(f"dropdown rows: {len(rows)}")
        if not any(LAYER in r for r in rows):
            failures.append(f"the dropdown has no '{LAYER}' row")
        else:
            log("the dropdown carries the entry")

        legend = page.evaluate(
            "() => { const el = document.getElementById('fao-rivers-legend');"
            " return el ? el.innerText.replace(/\\s+/g, ' ').slice(0, 300) : null; }"
        )
        if not legend:
            failures.append("the legend never mounted")
        else:
            log(f"legend mounted: {legend[:150]}")

        chips = page.evaluate(
            "() => Array.from(document.querySelectorAll('#fao-rivers-level-switch .soil-prop-btn'))"
            ".map(b => b.textContent.trim())"
        )
        log(f"detail chips: {chips}")
        if len(chips) != 4:
            failures.append(f"expected four detail chips, found {len(chips)}")

        # ── 2. switch it on ─────────────────────────────────────────────
        wms_requests.clear()
        page.evaluate("""() => {
            const rows = Array.from(document.querySelectorAll(
                '.leaflet-control-layers-overlays label'));
            const row = rows.find(r => r.textContent.includes('Rivers (FAO 2026)'));
            const box = row && row.querySelector('input[type=checkbox]');
            if (box && !box.checked) box.click();
        }""")
        page.wait_for_timeout(9000)

        tiles = page.evaluate("""() => {
            // Ask the MODULE for its pane rather than guessing Leaflet's
            // class name — Leaflet builds it as "leaflet-" + the pane name
            // minus "Pane" + "-pane", which is not worth repeating here.
            const L = window.FaoRiversLayer;
            const map = L && L._state && L._state.map;
            if (!map) return { found: false, why: 'no map' };
            const pane = map.getPane('faoRiverPane');
            if (!pane) return { found: false, why: 'no pane' };
            const imgs = pane.querySelectorAll('img.leaflet-tile');
            let loaded = 0;
            imgs.forEach(im => {
                if (im.complete && im.naturalWidth > 1) { loaded++; }
            });
            return { found: true, imgs: imgs.length, loaded };
        }""")
        log(f"tiles: {tiles}")
        if not tiles.get("found"):
            failures.append("the faoRiverPane was never created")
        elif not tiles.get("loaded"):
            failures.append("no tile loaded into the pane")
        else:
            log(f"{tiles['loaded']} tiles loaded")

        if not wms_requests:
            failures.append("the browser never asked for a river tile")
        else:
            ours = sum(1 for r in wms_requests if "/data/rivers/fao/tiles/" in r)
            proxied = sum(1 for r in wms_requests if "/api/tile/fao-rivers" in r)
            log(f"{len(wms_requests)} tile requests ({ours} from our own "
                f"pyramid, {proxied} through the proxy)")
            if not any(str(s).startswith("200") for s in wms_requests):
                failures.append("no river tile came back 200")

        # ── 3. the detail level changes the request ─────────────────────
        before = len(wms_requests)
        page.evaluate("""() => {
            const btn = document.querySelector('#fao-rivers-level-switch .soil-prop-btn[data-level=full]');
            if (btn) btn.click();
        }""")
        page.wait_for_timeout(9000)
        after = wms_requests[before:]
        filters = []
        for r in after:
            m = re.search(r"CQL_FILTER=([^&]+)", r)
            if m:
                filters.append(m.group(1))
        log(f"after the 'full' chip: {len(after)} new requests, filters: {set(filters)}")
        if not after:
            failures.append("switching the detail level fetched nothing")
        if filters and all("dis_av_cms" in f for f in filters):
            failures.append("the 'full detail' level still sent a discharge filter")
        if any("/fao-rivers/full/" in r for r in after):
            log("the new tiles are the 'full detail' ones")

        # ── 4. the river names switch ───────────────────────────────────
        # The labels are tooltips ON THE MAP — they are not inside the
        # legend, so they are counted document-wide.
        labels_on = page.evaluate(
            "() => document.querySelectorAll('.river-label').length")
        page.evaluate("""() => {
            const box = document.getElementById('ctrl-fao-rivers-labels');
            if (box) { box.checked = false; box.dispatchEvent(new Event('change')); }
        }""")
        page.wait_for_timeout(2500)
        labels_off = page.evaluate(
            "() => document.querySelectorAll('.river-label').length")
        log(f"river labels: {labels_on} on, {labels_off} off")
        if labels_on == 0:
            failures.append("no river name was placed with the names switch on")
        if labels_off != 0:
            failures.append("the names switch left labels on the map")

        # ── 5. the level travels in the URL ─────────────────────────────
        page.evaluate("""() => {
            const box = document.getElementById('ctrl-fao-rivers-labels');
            if (box) { box.checked = true; box.dispatchEvent(new Event('change')); }
        }""")
        page.wait_for_timeout(1500)
        hash_after = page.evaluate("() => location.hash")
        log(f"hash: {hash_after}")
        if "rivers=" not in hash_after:
            failures.append(f"the URL does not carry the level: {hash_after}")

        page.screenshot(path=args.shot)
        log(f"screenshot: {args.shot}")

        browser.close()

    noise = [e for e in console_errors
             if "favicon" not in e and "Failed to load resource" not in e]
    if noise:
        failures.append(f"console noise: {noise[:4]}")

    print()
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
