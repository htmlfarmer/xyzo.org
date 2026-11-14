"""Does the WIND ANIMATION survive a cached revisit?

Run: python3 scripts/wind_cache_check.py [--hash '#…'] [--json]

The owner's report: the wind does not show, *"or its very slow on cached
websites — you load it, move the map, change the navigation or 'style'
of the map, then load the old page with cache and it won't work."*

So this drives that exact sequence in Playwright and measures the wind
the same way every time: is the layer enabled, how many particles are
alive, what is the adaptive quality, and — the only verdict that counts —
does the wind pane's CANVAS actually change between two reads 1.5 s
apart. A layer that reports `enabled: true` with a frozen canvas is the
failure this exists to catch.

Scenarios, each measured after the same settle time:

  1. cold          first load in a fresh context
  2. warm          the same URL again in the SAME context (everything
                   served from the browser cache)
  3. reload        after panning and switching the BASEMAP, reload()
  4. goto-same     after panning and switching the basemap, navigate to
                   the same URL again (a real navigation, cache hit)
  5. back          after panning and switching the basemap, go to
                   /globe and come back with goBack() (bfcache where the
                   browser allows it)
  6. wind-style    switch the wind's own style, then back, then reload

Exit 0 only if every scenario's canvas is MOVING.
"""
import argparse
import json
import sys
from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org"
OWNER_HASH = (
    "#37.2828,-24.8730,5/density=max/"
    "overlay=wind-gfs@100,basins@100,population-density-worldpop-1-km@45,"
    "koppen@30,cropland-esa@50,land-cover-esa@35,soil-type-hwsd-v2-2@25,"
    "soil-soilgrids@15,ocean-currents-live@100,nasa-rain@30,"
    "rivers-fao-2026@100,geology-macrostrat@25,rivers@100,"
    "wind-speed-gfs@30,isobars@100/"
    "iso=0.1:pressure/isoSrc=gfs/wind=particles:speed/rivers=medium"
)

MEASURE = r"""() => {
  const W = window.WindLayer;
  if (!W || !W._state) return { err: "no WindLayer" };
  const s = W._state;
  const pane = document.querySelector('.leaflet-wind-pane');
  const cv = pane ? pane.querySelector('canvas') : null;
  let lit = null, sig = null;
  if (cv) {
    try {
      const g = cv.getContext('2d', { willReadFrequently: true });
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, h = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 8) { n++; h = (h * 31 + d[i] + d[i - 1] * 3 + d[i - 2] * 7) | 0; }
      }
      lit = n; sig = h;
    } catch (e) { lit = "ERR " + e; }
  }
  return {
    enabled: W.isEnabled(), style: W.getStyle(), colour: W.getColorMode(),
    grid: !!s.grid, particles: s.particles ? s.particles.length : null,
    qscale: s.qscale == null ? null : +Number(s.qscale).toFixed(2),
    lastFps: Math.round(s.lastFps || 0), raf: s.raf, frames: s.frameCount,
    hidden: document.hidden, vis: document.visibilityState,
    canvas: cv ? { w: cv.width, h: cv.height } : null,
    paneVis: pane ? getComputedStyle(pane).visibility : null,
    paneDisp: pane ? getComputedStyle(pane).display : null,
    canvasDisp: cv ? getComputedStyle(cv).display : null,
    lit, sig,
  };
}"""

INTERACT = r"""() => {
  const m = window._xyzoMap;
  if (!m) return "no map";
  m.panBy([420, 260], { animate: false });
  // switch the BASEMAP through the real layers control
  const labels = [...document.querySelectorAll('.leaflet-control-layers-base label')];
  const dark = labels.find(l => /dark/i.test(l.textContent || ""));
  const cb = dark ? dark.querySelector('input[type=radio]') : null;
  if (cb && !cb.checked) cb.click();
  return { basemap: cb && cb.checked ? dark.textContent.trim() : "unchanged",
           labels: labels.length };
}"""


def settle(page, ms=9000):
    page.wait_for_timeout(ms)
    a = page.evaluate(MEASURE)
    page.wait_for_timeout(1500)
    b = page.evaluate(MEASURE)
    return a, b


def report(name, a, b, extra=None):
    moving = a.get("sig") is not None and a.get("sig") != b.get("sig")
    frames = (a.get("frames"), b.get("frames"))
    ok = moving and a.get("enabled") and (a.get("particles") or 0) > 0
    line = (f"  {'ok  ' if ok else 'FAIL'} {name:14} "
            f"enabled={a.get('enabled')} style={a.get('style')} "
            f"particles={a.get('particles')} q={a.get('qscale')} "
            f"fps={a.get('lastFps')} raf={a.get('raf')}→{b.get('raf')} "
            f"frames={frames[0]}→{frames[1]} hidden={a.get('hidden')}/{b.get('hidden')} "
            f"lit={a.get('lit')}→{b.get('lit')} MOVING={moving}")
    if extra:
        line += f"  [{extra}]"
    print(line)
    return ok, {"scenario": name, "a": a, "b": b, "moving": moving, "ok": bool(ok)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hash", default=OWNER_HASH)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    url = BASE + "/" + args.hash

    results = []
    all_ok = True

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        # Record whether a navigation came back from the back/forward
        # cache — the scenario the owner described, and the one where a
        # rAF loop is most likely to come back frozen.
        page.add_init_script(
            "window.__pageshowPersisted = false;"
            "window.addEventListener('pageshow', e => {"
            "  window.__pageshowPersisted = !!e.persisted; });"
        )
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text)
                if m.type == "error" else None)

        print("\n1) COLD — first load, fresh context")
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        a, b = settle(page)
        ok, r = report("cold", a, b); all_ok &= ok; results.append(r)

        print("\n2) WARM — the same URL again in the SAME context")
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        a, b = settle(page)
        ok, r = report("warm", a, b); all_ok &= ok; results.append(r)

        print("\n3) INTERACT + reload() — pan, switch the basemap, reload")
        print("     interact ->", page.evaluate(INTERACT))
        page.reload(wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        a, b = settle(page)
        ok, r = report("reload", a, b); all_ok &= ok; results.append(r)

        print("\n4) INTERACT + goto the same URL (cache-hit navigation)")
        print("     interact ->", page.evaluate(INTERACT))
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        a, b = settle(page)
        ok, r = report("goto-same", a, b); all_ok &= ok; results.append(r)

        print("\n5) INTERACT + away to /globe + goBack() (bfcache)")
        print("     interact ->", page.evaluate(INTERACT))
        page.goto(BASE + "/globe", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(3000)
        # `commit`, not `domcontentloaded`: a bfcache restore does not
        # re-parse the document, so waiting for DCL would time out on
        # exactly the case this scenario exists to test.
        page.go_back(wait_until="commit", timeout=30000)
        page.wait_for_timeout(3000)
        a, b = settle(page, ms=6000)
        ok, r = report("back", a, b,
                       extra="persisted=" + str(page.evaluate(
                           "() => (window.__pageshowPersisted || null)")))
        all_ok &= ok; results.append(r)

        print("\n6) WIND STYLE changed, then reload")
        print("     style ->", page.evaluate(
            "() => { const W = window.WindLayer; const was = W.getStyle(); "
            "W.setStyle(was === 'flow' ? 'particles' : 'flow'); "
            "return was + ' -> ' + W.getStyle(); }"))
        page.reload(wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        a, b = settle(page)
        ok, r = report("wind-style", a, b); all_ok &= ok; results.append(r)

        if errors:
            print("\nconsole/page errors:")
            for e in errors[:8]:
                print("   ", str(e)[:200])
        browser.close()

    print("\n" + "=" * 78)
    print(f"{sum(1 for r in results if r['ok'])}/{len(results)} scenarios animating")
    if args.json:
        print(json.dumps(results, indent=2, default=str))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
