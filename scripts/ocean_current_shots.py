"""Screenshots of the OSCAR ocean-current overlay, in Firefox.

Owner report (2026-11-04): *"did you notice that the Ocean currents
(live) stop just off the coast of africa?"* — and a request for a
screenshot of it.

This takes the two pictures that answer it:

  1. the MAP at the reported view, with the layers dropdown closed so
     the currents and the African coast are both visible;
  2. the LEGEND, cropped, showing the composite's own date and age
     and the note that explains why the currents stop short of the
     coast.

Run:  python3 scripts/ocean_current_shots.py
      python3 scripts/ocean_current_shots.py --browser chromium
"""
import argparse
import json

from playwright.sync_api import sync_playwright

# The view from the owner's report.
MAP_URL = ("https://xyzo.org/#1.4720,6.1963,5/time=3d/density=max/"
           "overlay=koppen@20,wind-gfs@100,population-density-worldpop-1-km@20,"
           "soil-soilgrids@20,cropland-esa@40,land-cover-esa@15,rivers@100,"
           "basins@100,geology-macrostrat@25,ocean-currents-live@100,"
           "nasa-rain@55,isobars@100/iso=1:pressure/wind=particles:colourful")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", default="/tmp/opencode")
    ap.add_argument("--browser", default="firefox",
                    choices=["firefox", "chromium", "webkit"])
    ap.add_argument("--wait", type=int, default=20000)
    args = ap.parse_args()

    pw = sync_playwright().start()
    b = getattr(pw, args.browser).launch(headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text[:160]}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:160]))

    pg.goto(MAP_URL, wait_until="domcontentloaded", timeout=120000)
    pg.wait_for_timeout(args.wait)

    # ── 1. the map, with the dropdown closed ──────────────────────────
    # The layers panel is right-anchored and covers the right half of
    # the screen — and the right half is where the African coast is.
    pg.evaluate(r"""
      () => {
        for (const el of document.querySelectorAll('.leaflet-control-layers-expanded')) {
          el.classList.remove('leaflet-control-layers-expanded');
        }
        const l = document.querySelector('.leaflet-control-layers-list');
        if (l) l.style.display = 'none';
      }
    """)
    pg.wait_for_timeout(2500)
    state = pg.evaluate(r"""
      () => {
        const L = window.OceanCurrentLayer;
        if (!L) return { err: 'no layer' };
        const s = L._state;
        const c = document.querySelector('canvas.xyzo-ocean-current');
        let lit = 0;
        if (c) {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 0) lit++;
        }
        return { enabled: !!s.enabled, hasGrid: !!s.grid,
                 particles: s.particles.length, lit, style: s.style,
                 source_date: s.meta ? s.meta.source_date : null,
                 coastal_coverage: s.meta ? s.meta.coastal_coverage : null };
      }
    """)
    print("state:", json.dumps(state))
    map_out = f"{args.out_dir}/ocean-currents-africa.png"
    pg.screenshot(path=map_out)
    print("wrote", map_out)

    # ── 2. the legend, cropped ───────────────────────────────────────
    pg.evaluate(r"""
      () => {
        const btn = document.querySelector('.leaflet-control-layers-toggle');
        if (btn) btn.click();
        // Step 1 hid the list to see the map; put it back.
        const l = document.querySelector('.leaflet-control-layers-list');
        if (l) l.style.display = '';
      }
    """)
    pg.wait_for_timeout(1500)
    pg.evaluate(r"""
      () => {
        const host = document.getElementById('ocean-current-legend');
        if (host) host.scrollIntoView({ block: 'center' });
      }
    """)
    pg.wait_for_timeout(1500)
    legend = pg.evaluate(r"""
      () => {
        const host = document.getElementById('ocean-current-legend');
        if (!host) return { err: 'no legend' };
        const date = host.querySelector('.oc-legend-date');
        const note = host.querySelector('.oc-legend-note');
        const labels = [...document.querySelectorAll('.leaflet-control-layers-list label')]
          .map(l => (l.textContent || '').trim());
        return {
          date: date ? date.textContent : null,
          stale: date ? date.classList.contains('is-stale') : null,
          note: note ? note.textContent : null,
          checkbox: labels.find(t => t.includes('Ocean currents')) || null,
        };
      }
    """)
    print("legend:", json.dumps(legend, ensure_ascii=False))
    el = pg.query_selector("#ocean-current-legend")
    if el:
        crop = f"{args.out_dir}/ocean-currents-legend.png"
        el.screenshot(path=crop)
        print("wrote", crop)

    if errs:
        print("console errors:")
        for e in errs[:8]:
            print("  ", e)
    else:
        print("console errors: none")
    ctx.close()
    b.close()
    pw.stop()


if __name__ == "__main__":
    main()
