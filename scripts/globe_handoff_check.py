"""Playwright end-to-end: does the SAME map survive 2D -> 3D -> 2D?

Run: python3 scripts/globe_handoff_check.py [--shots DIR]

Before view-handoff.js this was not wired at all: the globe button was a
bare href="/globe" and "Back to the map" a bare href="/", so switching
views threw away the position, every overlay and every opacity.

This drives the real pages:

  1. open the flat map at a hash that enables two overlays at two
     specific opacities, at a specific position
  2. read the globe button's href AFTER a pointerdown (it is rebuilt at
     click time on purpose — a href read at boot would carry the boot view)
  3. open that href and assert the globe shows the same position, the
     same overlays, and the same opacities
  4. change the view on the globe, read "Back to the map"
  5. open IT and assert the flat map came back with the same thing

Exit code 0 only if every assertion holds.
"""
import argparse
import json
import os
import sys
from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org"
FLAT = f"{BASE}/"
GLOBE = f"{BASE}/globe"

# Two overlays with distinctive opacities that use DIFFERENT vocabularies
# on each side (temperature <-> temp, basins <-> basins). 70/55 are odd
# enough that a default could never match them by accident.
LAT, LNG, ZOOM = 12.3456, 76.5432, 7.0
FLAT_HASH = f"#{LAT},{LNG},{ZOOM}/overlay=temperature@70,basins@55"


def fail(msg, errors):
    print(f"  FAIL  {msg}")
    for e in errors[:6]:
        print(f"        {e}")
    return False


def ok(msg):
    print(f"  ok    {msg}")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)

    checks = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        console = []
        page.on("pageerror", lambda e: console.append(str(e)))

        # ── 1. flat map with two overlays and a position ───────────────
        print("\nFLAT MAP -> GLOBE")
        page.goto(FLAT + FLAT_HASH, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(7000)

        flat_state = page.evaluate(
            """() => {
            const m = window._xyzoMap;
            if (!m) return null;
            const c = m.getCenter();
            const names = [...(window.__xyzoActiveOverlayNames ? window.__xyzoActiveOverlayNames() : [])];
            return { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), zoom: +m.getZoom(), names };
        }"""
        )
        if not flat_state:
            print("  FAIL  flat map exposed no _xyzoMap")
            browser.close()
            return 1
        checks.append(ok(f"flat map at {flat_state['lat']},{flat_state['lng']} z{flat_state['zoom']}"))
        # The map's OWN centre, not the coordinates the hash asked for:
        # Leaflet snaps to the view it can actually render, so comparing
        # against the requested value reports a false failure.
        ACT_LAT = flat_state["lat"]
        ACT_LNG = flat_state["lng"]

        # read the globe button href the way a click does.
        # NB: `.leaflet-control-zoom-world` matches TWO elements — the
        # "whole earth" zoom control (href "#") AND the 3D globe button.
        # Selecting the first one silently reports an empty handoff.
        href = page.evaluate(
            """async () => {
            const a = document.querySelector('a[aria-label="Open the 3D globe"]')
                   || document.querySelector('.leaflet-control-zoom-world[title="Open the 3D globe"]');
            if (!a) return null;
            a.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
            a.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
            return a.getAttribute('href');
        }"""
        )
        print(f"        globe href = {href}")
        if not href:
            checks.append(fail("no globe button found", console))
            browser.close()
            return 1

        # ── the href must carry position + both overlays, translated ───
        probs = []
        if "proj=globe" not in href:
            probs.append("missing proj=globe")
        if f"{ACT_LAT},{ACT_LNG}" not in href:
            probs.append(f"missing position {ACT_LAT},{ACT_LNG}")
        if "temp@70" not in href:
            probs.append("temperature not translated to temp@70")
        if "basins@55" not in href:
            probs.append("basins@55 absent")
        if "temperature@" in href:
            probs.append("untranslated flat slug leaked through")
        checks.append(ok("globe href carries position + translated overlays")
                     if not probs else fail("globe href incomplete", probs))

        # ── 2. open the globe from that href ───────────────────────────
        if not href.startswith("/"):
            raise SystemExit(f"globe href is not a path: {href!r}")
        target = BASE + href
        page.goto(target, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window.__globeMap !== undefined", timeout=40000)
        page.wait_for_timeout(6000)

        globe_state = page.evaluate(
            """() => {
            const m = window.__globeMap;
            const c = m.getCenter();
            const out = { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), overlays: {} };
            document.querySelectorAll('input[type=checkbox][data-key]').forEach(b => {
                const k = b.dataset.key;
                const sl = document.querySelector(`.globe-ov-opacity[data-key="${k}"]`);
                out.overlays[k] = { on: b.checked, pct: sl ? Number(sl.value) : null };
            });
            return out;
        }"""
        )
        print(f"        globe at {globe_state['lat']},{globe_state['lng']}")

        probs = []
        if abs(globe_state["lat"] - ACT_LAT) > 0.01 or abs(globe_state["lng"] - ACT_LNG) > 0.01:
            probs.append(
                f"position {globe_state['lat']},{globe_state['lng']} != {ACT_LAT},{ACT_LNG}")
        t = globe_state["overlays"].get("temp", {})
        b = globe_state["overlays"].get("basins", {})
        if not t.get("on"):
            probs.append("temp not enabled")
        if t.get("pct") != 70:
            probs.append(f"temp opacity {t.get('pct')} != 70")
        if not b.get("on"):
            probs.append("basins not enabled")
        if b.get("pct") != 55:
            probs.append(f"basins opacity {b.get('pct')} != 55")
        checks.append(ok("globe shows the same position + overlays + opacities")
                     if not probs else fail("globe did not receive the flat map's view", probs))

        # is temp actually rendered, with its opacity applied?
        paint = page.evaluate(
            """() => {
            const m = window.__globeMap;
            const l = m.getLayer('temp');
            if (!l) return { layer: false };
            return {
              layer: true,
              visibility: (l.layout && l.layout.visibility) || 'visible',
              opacity: m.getPaintProperty('temp', 'raster-opacity'),
              hasSource: !!m.getSource('temp'),
            };
        }"""
        )
        probs = []
        if not paint.get("layer"):
            probs.append("temp layer missing")
        if paint.get("layer") and paint.get("visibility") == "none":
            probs.append("temp hidden")
        if paint.get("opacity") is not None and abs(paint["opacity"] - 0.70) > 0.01:
            probs.append(f"raster-opacity {paint.get('opacity')} != 0.70")
        checks.append(ok(f"temp layer visible, raster-opacity={paint.get('opacity')}")
                     if not probs else fail("temp not applied on the globe", probs))

        if args.shots:
            page.screenshot(path=os.path.join(args.shots, "handoff-globe.png"))

        # ── 3. change something on the globe, then go back ─────────────
        page.evaluate(
            """() => {
            const b = document.querySelector('input[data-key="lightning"]');
            if (b && !b.checked) b.click();
        }"""
        )
        page.wait_for_timeout(1200)

        back = page.evaluate("""() => {
            const a = document.querySelector('.globe-back');
            return a ? a.getAttribute('href') : null;
        }""")
        print(f"        back href = {back}")
        probs = []
        if not back:
            probs.append("no back link")
        else:
            if "proj=" in back:
                probs.append("proj= leaked to the flat map")
            if "temperature@70" not in back:
                probs.append("temperature not translated back")
            if "basins@55" not in back:
                probs.append("basins@55 not carried back")
            if "lightning" not in back:
                probs.append("overlay added on the globe did not reach the back link")
            if f"{ACT_LAT},{ACT_LNG}" not in back:
                probs.append("position not carried back")
        checks.append(ok("back link carries position + overlays (translated)") if not probs
                     else fail("back link incomplete", probs))

        # ── 4. open it and confirm the flat map agrees ─────────────────
        target = BASE + back if back and back.startswith("/") else (BASE + "/" if not back else back)
        page.goto(target, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(7000)

        back_state = page.evaluate(
            """() => {
            const m = window._xyzoMap;
            if (!m) return null;
            const c = m.getCenter();
            return { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), hash: location.hash };
        }"""
        )
        probs = []
        if not back_state:
            probs.append("flat map did not come up")
        else:
            if abs(back_state["lat"] - ACT_LAT) > 0.01 or abs(back_state["lng"] - ACT_LNG) > 0.01:
                probs.append(
                    f"position {back_state['lat']},{back_state['lng']} != {ACT_LAT},{ACT_LNG}")
            h = back_state.get("hash", "")
            if "temperature@70" not in h:
                probs.append("temperature@70 missing from restored hash")
            if "basins@55" not in h:
                probs.append("basins@55 missing from restored hash")
            if "lightning" not in h:
                probs.append("lightning (added on the globe) missing from restored hash")
        checks.append(ok("flat map restored position + overlays + the globe's addition")
                     if not probs else fail("flat map did not restore", probs))

        if args.shots:
            page.screenshot(path=os.path.join(args.shots, "handoff-flat.png"))

        browser.close()

    passed = sum(1 for c in checks if c is True)
    total = len(checks)
    print(f"\n{passed}/{total} handoff checks passed")
    if console:
        print("page errors:")
        for e in console[:6]:
            print("   ", str(e)[:200])

    if args.json:
        print(json.dumps({"passed": passed, "total": total}, indent=2))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
