"""The LIVE pressure chart (not the change map) — how long does IT block?

The owner asked about "isometric pressure in general": the change map was
the one that froze, but the ordinary isobar chart draws the same kind of
thing (thousands of polylines) and deserves the same measurement.

The metric is the LONG TASK — the main-thread block that freezes the tab.

Run: python3 scripts/isobar_speed_check.py [--steps 0.1,0.25,1]
"""
import argparse
import sys

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"

LONG_TASK = """
window.__longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__longTasks.push({ name: e.name, dur: Math.round(e.duration) });
    }
  }).observe({ entryTypes: ["longtask"] });
} catch (e) {}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", default="0.1,0.25,1")
    ap.add_argument("--zoom", default="3")
    args = ap.parse_args()

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:140]))
        page.add_init_script(LONG_TASK)
        page.goto(BASE + f"#2.1,16.8,{args.zoom}/overlay=isobars@100",
                   wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(12000)

        for step in [s.strip() for s in args.steps.split(",")]:
            page.evaluate("() => { window.__longTasks = []; }")
            page.evaluate("""(step) => {
                const btn = document.querySelector('#isobar-step-switch [data-step="' + step + '"]');
                if (btn) btn.click();
            }""", step)
            page.wait_for_timeout(9000)
            out = page.evaluate("""() => {
                const L = window.IsobarLayer;
                const st = L && L._state ? L._state : null;
                const tasks = window.__longTasks || [];
                return {
                    levels: st && st.levels ? st.levels.length : null,
                    source: st ? st.source : null,
                    tasks: tasks.length,
                    total: tasks.reduce((n, t) => n + t.dur, 0),
                    worst: tasks.reduce((n, t) => Math.max(n, t.dur), 0),
                };
            }""")
            print(f"step {step:5}: long tasks {out['tasks']} totalling {out['total']} ms (worst {out['worst']} ms) | levels in the DOM: {out['levels']}")

        if errs:
            print("PAGE ERRORS:", errs[:4])
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
