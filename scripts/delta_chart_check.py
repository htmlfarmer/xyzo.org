"""The CHANGE map, measured on the live site.

The owner reported that the delta maps "freeze up the computer and almost
crash it", so this drives them CAREFULLY: one mode at a time, and the
metric is the LONG TASK — the main-thread block that freezes the tab.
Long tasks are what "the computer froze" means to a reader, and they are
measured by the browser itself (PerformanceObserver → "longtask"), not
guessed.

Run: python3 scripts/delta_chart_check.py [--mode 24h] [--step 0.1]
"""
import argparse
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"
MODES = ["24h", "3d", "7d"]

LONG_TASK = """
window.__longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__longTasks.push({ name: e.name, dur: Math.round(e.duration), at: Math.round(e.startTime) });
    }
  }).observe({ entryTypes: ["longtask"] });
} catch (e) { window.__longTasks = []; }
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default=None, help="one window (default: all of them)")
    ap.add_argument("--step", default="0.1", help="the step to select (0.1 … 16)")
    ap.add_argument("--shot", default=None)
    args = ap.parse_args()
    modes = [args.mode] if args.mode else MODES

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:160]))
        page.add_init_script(LONG_TASK)

        page.goto(BASE + "#2.1,16.8,3/overlay=isobars@100", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(8000)

        for mode in modes:
            page.evaluate("() => document.querySelector('.leaflet-control-layers-toggle')?.click()")
            page.wait_for_timeout(1200)
            # Select the step first (the finest is the expensive one).
            page.evaluate("""(step) => {
                const btn = document.querySelector('#isobar-step-switch [data-step="' + step + '"]');
                if (btn) btn.click();
            }""", args.step)
            page.wait_for_timeout(1500)
            page.evaluate("() => { window.__longTasks = []; window.__t0 = performance.now(); }")
            t0 = time.time()
            ok = page.evaluate("""(mode) => {
                const btn = document.querySelector('#isobar-change-switch [data-delta="' + mode + '"]');
                if (!btn) return false;
                btn.click();
                return true;
            }""", mode)
            if not ok:
                print(f"{mode}: NO CHIP FOUND")
                continue
            # Wait for the layer to say it is a delta and to have drawn.
            try:
                page.wait_for_function(
                    """() => {
                        const L = window.IsobarLayer;
                        const st = L && L._state ? L._state : null;
                        return !!(st && st.source === 'delta');
                    }""",
                    timeout=30000,
                )
            except Exception:
                print(f"{mode}: the layer never switched to the delta source")
            page.wait_for_timeout(6000)
            out = page.evaluate("""() => {
                const L = window.IsobarLayer;
                const st = L && L._state ? L._state : null;
                const tasks = window.__longTasks || [];
                const total = tasks.reduce((n, t) => n + t.dur, 0);
                return {
                    source: st ? st.source : null,
                    tasks: tasks.length,
                    totalMs: total,
                    worstMs: tasks.reduce((n, t) => Math.max(n, t.dur), 0),
                    scale: st ? st.deltaScale : null,
                    attribution: (document.querySelector('.leaflet-control-attribution') || {}).textContent || '',
                };
            }""")
            print(f"{mode} @ step {args.step}: {time.time()-t0:.1f}s to draw | "
                  f"long tasks: {out['tasks']} totalling {out['totalMs']} ms (worst {out['worstMs']} ms) | "
                  f"scale ±{out['scale']} hPa | source={out['source']}")
            if args.shot:
                page.screenshot(path=args.shot)
            page.evaluate("() => document.querySelector('.leaflet-control-layers-toggle')?.click()")
            page.wait_for_timeout(800)

        if errs:
            print("PAGE ERRORS:", errs[:4])
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
