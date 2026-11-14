"""Does the colour picker actually appear, and actually change colours?

Checks the whole chain: the control is injected on a value overlay, its
options are the real palettes, changing one repaints (the legend gradient
and the baked field must follow — a control that only moves its own
dropdown is the failure mode), categorical layers get NO control at all,
and the choice survives a reload.
"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://xyzo.org/"


def row_for(page, label_text):
    return page.evaluate(
        """(txt) => {
        const rows = [...document.querySelectorAll('.leaflet-overlay-row')];
        const r = rows.find(x => (x.textContent || '').includes(txt));
        if (!r) return null;
        const sel = r.querySelector('select.leaflet-overlay-palette-select');
        return {
          hasSelect: !!sel,
          value: sel ? sel.value : null,
          options: sel ? [...sel.options].map(o => o.value) : [],
          labels: sel ? [...sel.options].map(o => o.textContent) : [],
        };
    }""",
        label_text,
    )


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        page.goto(URL + "#20,78,5", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(7000)

        # make sure the layers panel is expanded
        page.evaluate("""() => {
          const l = document.querySelector('.leaflet-control-layers');
          if (l && !l.classList.contains('leaflet-control-layers-expanded')) {
            const t = document.querySelector('.leaflet-control-layers-toggle');
            if (t) t.click();
          }
        }""")
        page.wait_for_timeout(1500)

        print("=== which rows got a palette control ===")
        for label in ["Temperature (GFS)", "Lightning density", "Population density",
                      "Köppen Climate", "Soil (SoilGrids)", "Relief (ETOPO)"]:
            info = row_for(page, label)
            if info is None:
                print(f"  {label:22} ROW NOT FOUND")
            else:
                print(f"  {label:22} select={info['hasSelect']} "
                      f"value={info['value']!r} opts={info['options']}")

        # --- change temperature's palette and prove the PAINT changed ---
        before = page.evaluate(
            """() => {
            const bar = document.getElementById('temp-legend-bar');
            return bar ? (bar.style.backgroundImage || null) : 'no-bar';
        }"""
        )
        changed = page.evaluate(
            """() => {
            const rows = [...document.querySelectorAll('.leaflet-overlay-row')];
            const r = rows.find(x => (x.textContent||'').includes('Temperature (GFS)'));
            const sel = r && r.querySelector('select.leaflet-overlay-palette-select');
            if (!sel) return { ok: false, why: 'no select' };
            const want = [...sel.options].find(o => o.value === 'rainbow' || /rainbow/i.test(o.textContent));
            if (!want) return { ok: false, why: 'no rainbow option', opts: [...sel.options].map(o=>o.value) };
            sel.value = want.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, picked: want.value, stored: localStorage.getItem('xyzo.overlayPalette') };
        }"""
        )
        page.wait_for_timeout(4000)
        after = page.evaluate(
            """() => {
            const bar = document.getElementById('temp-legend-bar');
            const L = window.TempLayer;
            return { bar: bar ? (bar.style.backgroundImage || null) : 'no-bar',
                     palette: L && L.getPalette ? L.getPalette() : null };
        }"""
        )
        print("\n=== temperature palette change ===")
        print("  change:", changed)
        print("  before:", (str(before)[:110] + '…') if before and len(str(before)) > 110 else before)
        print("  after :", (str(after['bar'])[:110] + '…') if after['bar'] and len(str(after['bar'])) > 110 else after['bar'])
        print("  module palette:", after['palette'])
        bar_changed = bool(before) and bool(after['bar']) and before != after['bar']
        print("  LEGEND BAR CHANGED:", bar_changed)

        # --- population uses the filter path ---
        pop = page.evaluate(
            """() => {
            const rows = [...document.querySelectorAll('.leaflet-overlay-row')];
            const r = rows.find(x => (x.textContent||'').includes('Population density'));
            const sel = r && r.querySelector('select.leaflet-overlay-palette-select');
            if (!sel) return { ok: false };
            const thermal = [...sel.options].find(o => /thermal|hue/i.test(o.textContent));
            if (!thermal) return { ok: false, opts: [...sel.options].map(o=>o.textContent) };
            sel.value = thermal.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            const pane = window._xyzoMap.getPane('populationPane');
            return { ok: true, picked: thermal.textContent,
                     filter: pane ? pane.style.filter : null,
                     stored: localStorage.getItem('xyzo.overlayPalette') };
        }"""
        )
        print("\n=== population filter path ===")
        print(" ", pop)

        # --- reload: does the choice persist AND get re-applied? ---
        page.goto(URL + "#20,78,5", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(8000)
        persisted = page.evaluate(
            """() => {
            const L = window.TempLayer;
            const pane = window._xyzoMap.getPane('populationPane');
            return { tempPalette: L && L.getPalette ? L.getPalette() : null,
                     popFilter: pane ? pane.style.filter : null,
                     stored: localStorage.getItem('xyzo.overlayPalette') };
        }"""
        )
        print("\n=== after reload ===")
        print(" ", persisted)

        if errs:
            print("\npage errors:", errs[:5])
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
