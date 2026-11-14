"""Does the population overlay actually register, fetch and render?

Checks the whole chain the code alone cannot prove: the layers dropdown
row exists (generic-layers.js loaded and app.js's loop consumed it), tiles
really come back from FAO's WMTS, the pane is where it should be, the
opacity slider reaches the layer, and minZoom really hides it below z6.
"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://xyzo.org/"
NAME_MATCH = "Population density"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        tiles = {"ok": 0, "bad": 0, "urls": []}
        def on_resp(r):
            if "data.apps.fao.org" in r.url:
                if r.status == 200:
                    tiles["ok"] += 1
                else:
                    tiles["bad"] += 1
                    tiles["urls"].append(f"{r.status} {r.url[:110]}")
        page.on("response", on_resp)

        page.goto(URL + "#10,10,7", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(7000)

        # 1. did the module load and register?
        mod = page.evaluate("""() => ({
            hasMod: !!window.PopulationLayer,
            list: window.XYZO_GENERIC_LAYERS || null,
            registered: !!(window.WEATHER_OVERLAYS || null),
        })""")
        print("module loaded      :", mod["hasMod"])
        print("generic layer list :", mod["list"])

        # the layers dropdown row (name is resolved from LAYER_NAME)
        row = page.evaluate("""() => {
          const labels = [...document.querySelectorAll('.leaflet-control-layers-overlays label, .leaflet-control-layers label')];
          const hit = labels.find(l => (l.textContent||'').includes('Population density'));
          if (!hit) return null;
          const cb = hit.querySelector('input[type=checkbox]');
          return { text: hit.textContent.trim().slice(0,60), checked: cb ? cb.checked : null,
                   slider: hit.parentElement ? !!hit.parentElement.querySelector('input[type=range]') : false };
        }""")
        print("layers row         :", row)

        # 2. pane + registration via the map
        pane = page.evaluate("""() => {
          const map = window._xyzoMap;
          const el = map && map.getPane ? map.getPane('populationPane') : null;
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { z: el.style.zIndex, zIndex: cs.zIndex, pe: cs.pointerEvents };
        }""")
        print("pane               :", pane)

        if not row:
            print("\nFAIL: overlay not registered — stopping")
            for e in errs[:5]: print("  err:", e[:200])
            page.screenshot(path="/tmp/opencode/pop-fail.png")
            b.close(); return 1

        # 3. enable it
        page.evaluate("""() => {
          const labels = [...document.querySelectorAll('.leaflet-control-layers label')];
          const hit = labels.find(l => (l.textContent||'').includes('Population density'));
          const cb = hit && hit.querySelector('input[type=checkbox]');
          if (cb && !cb.checked) cb.click();
        }""")
        page.wait_for_timeout(9000)

        state = page.evaluate("""() => {
          const L = window.PopulationLayer;
          const map = window._xyzoMap;
          return {
            enabled: L.isEnabled(),
            zoom: map.getZoom(),
            onMap: !!(L._state && L._state.layer && map.hasLayer(L._state.layer)),
            op: L.getOpacity(),
          };
        }""")
        print("after enabling     :", state)
        print(f"FAO tiles          : {tiles['ok']} ok / {tiles['bad']} bad")
        for u in tiles["urls"][:4]:
            print("   bad:", u)

        # 4. opacity slider
        op_ok = page.evaluate("""() => {
          const labels = [...document.querySelectorAll('.leaflet-control-layers label')];
          const hit = labels.find(l => (l.textContent||'').includes('Population density'));
          const wrap = hit && hit.parentElement;
          const slider = wrap && wrap.querySelector('input[type=range]');
          if (!slider) return { slider: false };
          slider.value = '40';
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
          return { slider: true, value: slider.value,
                   moduleOpacity: window.PopulationLayer.getOpacity() };
        }""")
        page.wait_for_timeout(1500)
        print("opacity slider     :", op_ok)

        # 5. minZoom: go below z6 and check the tiles stop / layer hidden
        low = page.evaluate("""() => {
          const L = window.PopulationLayer;
          L.setEnabled(true);
          return new Promise(r => setTimeout(() => {
            const m = window._xyzoMap;
            m.setZoom(4);
            setTimeout(() => r({ zoom: m.getZoom(), enabled: L.isEnabled() }), 4000);
          }, 500));
        }""")
        low_tiles_before = tiles["ok"]
        page.wait_for_timeout(6000)
        print("at z4             :", low, f"(tiles since: {tiles['ok'] - low_tiles_before})")
        page.screenshot(path="/tmp/opencode/population-zoom4.png")

        # back up to detail zoom
        page.evaluate("() => window._xyzoMap.setZoom(9)")
        page.wait_for_timeout(9000)
        high_before = tiles["ok"]
        page.wait_for_timeout(4000)
        print("back at z9        : tiles ok total", tiles["ok"], f"(new: {tiles['ok'] - high_before})")
        page.screenshot(path="/tmp/opencode/population-zoom9.png")

        if errs:
            print("\npage errors:")
            for e in errs[:6]: print("  ", e[:200])
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
