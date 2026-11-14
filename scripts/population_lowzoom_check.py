"""Reproduce the reported case: population density at z4 and z3.

The two URLs use the slug the flat map DERIVES from LAYER_NAME
("population-density-worldpop-1-km"), so this also proves the hash
restore resolves it — a derived slug that did not resolve would leave
the checkbox unticked and the map blank, which is a different bug from
minZoom and worth distinguishing.
"""
import sys
from playwright.sync_api import sync_playwright

URLS = [
    ("z4", "https://xyzo.org/#21.7391,90.9668,4/density=max/base=light/overlay=population-density-worldpop-1-km@100"),
    ("z3", "https://xyzo.org/#21.6983,91.0547,3/density=max/base=light/overlay=population-density-worldpop-1-km@100"),
    ("z2", "https://xyzo.org/#21.7391,90.9668,2/density=max/base=light/overlay=population-density-worldpop-1-km@100"),
]


def main():
    shot = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/pop-lowzoom.png"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        tiles = {"ok": 0, "bad": 0, "codes": []}
        def on_resp(r):
            if "data.apps.fao.org" in r.url:
                if r.status == 200:
                    tiles["ok"] += 1
                else:
                    tiles["bad"] += 1
                    tiles["codes"].append(r.status)
        page.on("response", on_resp)

        # start from the LAST url (each case is a fresh load)
        for label, url in URLS:
            tiles.update(ok=0, bad=0, codes=[])
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
            page.wait_for_timeout(8000)

            st = page.evaluate("""() => {
              const L = window.PopulationLayer;
              const m = window._xyzoMap;
              const el = m.getPane('populationPane');
              const on = L && L.isEnabled();
              // count the layer's own <img> tiles actually in the DOM
              let imgs = 0, loaded = 0;
              if (el) for (const im of el.querySelectorAll('img')) {
                imgs++; if (im.complete && im.naturalWidth > 0) loaded++;
              }
              // is it ticked in the layers dropdown?
              const labels = [...document.querySelectorAll('.leaflet-control-layers label')];
              const hit = labels.find(l => (l.textContent||'').includes('Population density'));
              const cb = hit && hit.querySelector('input[type=checkbox]');
              return {
                zoom: m.getZoom(),
                enabled: on, onMap: !!(L._state && L._state.layer && m.hasLayer(L._state.layer)),
                paneZ: el ? el.style.zIndex : null,
                paneDisplay: el ? getComputedStyle(el).display : null,
                tileImgs: imgs, tileLoaded: loaded,
                checkbox: cb ? cb.checked : null,
                paneVisible: el ? getComputedStyle(el).visibility : null,
              };
            }""")
            print(f"[{label}] zoom={st['zoom']} enabled={st['enabled']} onMap={st['onMap']} "
                  f"checkbox={st['checkbox']} paneZ={st['paneZ']} "
                  f"imgs={st['tileImgs']} loaded={st['tileLoaded']} "
                  f"| FAO {tiles['ok']} ok / {tiles['bad']} bad {st['tileImgs'] and ''}")
            if label == "z4":
                page.screenshot(path=shot)

        if errs:
            print("page errors:", errs[:5])
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
