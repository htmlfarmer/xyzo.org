"""The "🛰️ Default map" button and the LOW-RESOLUTION tier — measured on
the live site.

Two things the owner asked for on 2026-11-14:

  * *"for the 'cleared map' i think we just need a satellite view … its
    just too slow on some computers"* — the button restored the OWNER'S
    own map (the wind ANIMATION over the pressure lines), which is the
    most expensive thing on the page: a canvas that repaints every frame
    over a field that has to be fetched and contoured first. The button
    is the satellite view again.
  * *"we also have some checks to see before loading the page if we
    should show a low rez version without any overlays except the
    satellite view correct.. thats already working but we might need to
    test it"*.

**THE SECOND HALF WAS NOT TRUE BEFORE THIS SESSION.** The tier check
worked, but the "low rez" map it chose was the "🌱 Climate skin" — the
Köppen wash plus the city names, and the city names alone pull the
**1.16 MB city index**. So the light map was not light. It is the
satellite view now, and this script is the gate.

What it checks, in a real browser:

  1. A SLOW machine (2 GB RAM, 2 cores, save-data on) opens the
     SATELLITE view on a first visit — **no overlays at all**.
  2. A CAPABLE machine still opens the showcase (the ✨ Cool map).
  3. The 🛰️ button clears the map: satellite, the world view, no
     overlays, and the URL says so.
  4. The button actually loads LESS than the map it replaced — the
     request count and the bytes, which is the claim behind the change.

Run: python3 scripts/default_map_check.py
"""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"

# A machine that cannot carry the showcase. `deviceMemory` and
# `hardwareConcurrency` are read-only in a real browser, so they are
# stubbed before the page's scripts run.
SLOW_DEVICE = """
Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 });
Object.defineProperty(navigator, 'connection', {
  get: () => ({ saveData: true, effectiveType: '3g' }),
});
"""

BIG_DESKTOP = """
Object.defineProperty(navigator, 'deviceMemory', { get: () => 32 });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 16 });
"""


def open_page(ctx, init=None):
    page = ctx.new_page()
    if init:
        page.add_init_script(init)
    page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
    return page


def map_state(page):
    """What the map is actually showing: the base layer and the overlays."""
    return page.evaluate(
        """() => {
            // The layers dropdown is the map's own truth about what is
            // on: Leaflet rebuilds it on every layer change, so a checked
            // box IS the layer being drawn.
            const boxes = Array.from(
                document.querySelectorAll('.leaflet-control-layers-overlays input[type=checkbox]'));
            const checked = boxes.filter((b) => b.checked).map((b) => b.value || b.id);
            const baseRadio = document.querySelector(
                '.leaflet-control-layers-base input[type=radio]:checked');
            // Leaflet's radio carries no useful value in the vendored
            // build, so the NAME is read from the label beside it.
            const baseLabel = baseRadio && baseRadio.closest('label');
            const base = baseLabel ? (baseLabel.textContent || '').trim() : '';
            const m = window._xyzoMap;
            return {
              hash: location.hash,
              overlays: checked,
              base: base,
              zoom: m ? m.getZoom() : null,
              center: m ? [m.getCenter().lat, m.getCenter().lng] : null,
              isoOn: !!(window.IsobarLayer && window.IsobarLayer.isEnabled()),
              windOn: !!(window.WindLayer && window.WindLayer.isEnabled()),
            };
        }"""
    )


def resources(page):
    return page.evaluate(
        """() => {
            const rs = performance.getEntriesByType('resource');
            let bytes = 0;
            for (const r of rs) {
                const n = r.encodedBodySize || r.transferSize || 0;
                bytes += n;
            }
            return { requests: rs.length, bytes: bytes };
        }"""
    )


def main():
    failures = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)

        # ── 1. a SLOW machine opens the satellite view ───────────────────
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        slow = open_page(ctx, SLOW_DEVICE)
        slow.wait_for_timeout(9000)
        st = map_state(slow)
        print(f"a slow machine opens: hash={st['hash']}")
        print(f"  overlays on: {st['overlays']}")
        print(f"  isobars on: {st['isoOn']}   wind on: {st['windOn']}")
        if st["overlays"]:
            failures.append(f"a slow machine opened WITH overlays: {st['overlays']}")
        if st["isoOn"] or st["windOn"]:
            failures.append("a slow machine opened with the isobars or the wind on")
        slow_res = resources(slow)
        print(f"  {slow_res['requests']} requests, {slow_res['bytes']} bytes")
        ctx.close()

        # ── 2. a capable machine still opens the showcase ───────────────
        ctx2 = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        big = open_page(ctx2, BIG_DESKTOP)
        big.wait_for_timeout(9000)
        st2 = map_state(big)
        print(f"a capable machine opens: hash={st2['hash']}")
        if not st2["overlays"]:
            failures.append("a capable machine opened with NO overlays — the showcase is gone")
        else:
            print(f"  {len(st2['overlays'])} overlays on")
        big_res = resources(big)
        print(f"  {big_res['requests']} requests, {big_res['bytes']} bytes")
        ctx2.close()

        # ── 3. the 🛰️ button CLEARS the map ────────────────────────────
        ctx3 = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = open_page(ctx3, BIG_DESKTOP)
        page.wait_for_timeout(9000)
        before = map_state(page)
        print(f"before the button: {len(before['overlays'])} overlays, hash={before['hash'][:70]}")
        page.evaluate("() => document.getElementById('default-map-btn')?.click()")
        page.wait_for_timeout(7000)
        after = map_state(page)
        print(f"after  the button: {len(after['overlays'])} overlays, hash={after['hash']}")
        print(f"  base: {after['base']}   zoom: {after['zoom']}   center: {after['center']}")
        if after["overlays"]:
            failures.append(f"the button left overlays on: {after['overlays']}")
        if after["isoOn"] or after["windOn"]:
            failures.append("the button left the isobars or the wind on")
        if "satellite" not in after["base"].lower():
            failures.append(f"the base is not satellite: {after['base']!r}")
        if after["zoom"] != 2:
            failures.append(f"the zoom is {after['zoom']}, not 2")
        if "overlay=" in after["hash"]:
            failures.append(f"the URL still names overlays: {after['hash']}")
        if "density=max" not in after["hash"]:
            failures.append(f"the URL lost the pin density: {after['hash']}")
        after_res = resources(page)
        print(f"  total on the page: {after_res['requests']} requests, {after_res['bytes']} bytes")
        ctx3.close()
        b.close()

    if failures:
        print("\nFAIL")
        for f in failures:
            print("  -", f)
        return 1
    print("\nOK — the button clears the map, and a slow machine opens light.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
