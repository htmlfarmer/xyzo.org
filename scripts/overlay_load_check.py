#!/usr/bin/env python3
"""
Every overlay still PAINTS when it is switched on.

WHY THIS EXISTS
---------------
An overlay's data used to be fetched at boot, before anyone asked for
it (measured: 38 MB of grid data for layers that were all OFF). The fix
was to fetch it when the layer is switched on instead — which means the
load now happens on a path that was previously never exercised by a
cold start. If any layer's `add` handler stops fetching, the layer
switches on and draws NOTHING, and nothing else on the site would
notice: the checkbox ticks, the legend is there, and the map is blank.

THE TEST IS A SCREENSHOT DIFF AGAINST A MAP THAT NEVER HAD IT ON.
Each layer is measured against the same view with no overlays at all —
the baseline shares no pixels with it, so a layer that paints is
visible in the diff and a layer that paints nothing is not. No layer
names, no pane names, no URL patterns to drift: if it changes the
picture, it passes.

Usage:
  python3 scripts/overlay_load_check.py                  # every overlay
  python3 scripts/overlay_load_check.py --layers temperature,wind-gfs
  python3 scripts/overlay_load_check.py --json reports/overlay_paint.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_URL = "https://xyzo.org/"

# A layer that changes fewer than this fraction of the screen is
# counted as not having painted. 0.05 % is one pixel in 2,000 — far
# below any real overlay, far above the antialiasing noise of two
# identical screenshots.
MIN_DELTA = 0.0005


def log(msg: str) -> None:
    print(f"[overlay-paint] {msg}", flush=True)


def shot(page, path: str) -> None:
    page.screenshot(path=path)


def pixels(path: str) -> list:
    from PIL import Image
    import numpy as np
    return np.asarray(Image.open(path).convert("RGB"), dtype=int)


def overlay_list(browser, url: str):
    """The overlay slugs, read from the live dropdown."""
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(9000)
    rows = page.evaluate(
        """() => {
          const out = [];
          document.querySelectorAll('.leaflet-control-layers-overlays label').forEach(l => {
            if (l.querySelector('input[type=checkbox]')) out.push(l.textContent.replace(/\\s+/g,' ').trim());
          });
          document.querySelectorAll('.leaflet-control-layers-list label').forEach(l => {
            const t = l.textContent.replace(/\\s+/g,' ').trim();
            if (/isobar|pressure/i.test(t) && !out.includes(t)) out.push(t);
          });
          return out;
        }"""
    )
    slugs = page.evaluate(
        "(ns) => ns.map(n => (window.__xyzoLayerSlug ? window.__xyzoLayerSlug(n) : n))", rows)
    ctx.close()
    return [s for s in slugs if s]


def run(browser, url: str, view: str, slug: str | None, outdir: str, tag: str):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:160]))
    page.on("console", lambda m: errors.append(m.text[:160]) if m.type == "error" else None)
    hash_ = view + (f"/overlay={slug}@100" if slug else "")
    path = os.path.join(outdir, f"{tag}.png")
    try:
        page.goto(url + "#" + hash_, wait_until="domcontentloaded", timeout=60000)
        for _ in range(80):
            if page.evaluate("() => !!window._xyzoMap"):
                break
            page.wait_for_timeout(250)
        # let every tile and grid settle
        last = -1
        quiet = 0
        for _ in range(120):
            n = page.evaluate("() => performance.getEntriesByType('resource').length")
            if n == last:
                quiet += 1
                if quiet >= 5:
                    break
            else:
                last, quiet = n, 0
            page.wait_for_timeout(300)
        shot(page, path)
        return {"png": path, "errors": errors}
    finally:
        ctx.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--lat", default="20")
    ap.add_argument("--lng", default="10")
    ap.add_argument("--zoom", default="3")
    ap.add_argument("--layers", default="")
    ap.add_argument("--outdir", default="/tmp/opencode/overlay_paint")
    ap.add_argument("--json", default=os.path.join(REPO, "reports", "overlay_paint.json"))
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    os.makedirs(args.outdir, exist_ok=True)
    view = f"{args.lat},{args.lng},{args.zoom}"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        slugs = ([s.strip() for s in args.layers.split(",") if s.strip()]
                 if args.layers else overlay_list(browser, args.url))
        log(f"{len(slugs)} overlays")

        log("the baseline (no overlays)…")
        base_run = run(browser, args.url, view, None, args.outdir, "baseline")
        base = pixels(base_run["png"])

        results = []
        for i, slug in enumerate(slugs, 1):
            r = run(browser, args.url, view, slug, args.outdir, slug)
            img = pixels(r["png"])
            diff = (abs(img - base).sum(axis=2) > 24)
            frac = float(diff.sum()) / diff.size
            painted = frac >= MIN_DELTA
            results.append({
                "slug": slug,
                "painted": painted,
                "delta_pct": round(frac * 100, 3),
                "errors": r["errors"],
            })
            mark = "ok  " if painted else "FAIL"
            log(f"  [{i}/{len(slugs)}] {mark} {slug:32s} {frac*100:6.3f}% of the screen "
                f"{len(r['errors'])} errors")

        browser.close()

    failed = [r for r in results if not r["painted"]]
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump({"view": view, "url": args.url, "layers": results}, fh, indent=1)

    print()
    if failed:
        print(f"  {len(failed)} OVERLAY(S) SWITCHED ON AND DREW NOTHING:")
        for r in failed:
            print(f"    - {r['slug']}  ({r['delta_pct']} % of the screen, "
                  f"{len(r['errors'])} console errors)")
        for e in [e for r in failed for e in r["errors"]][:5]:
            print(f"      console: {e}")
        return 2
    print(f"  all {len(results)} overlays painted when switched on")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
