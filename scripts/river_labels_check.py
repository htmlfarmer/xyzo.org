"""Independent check: are the river labels duplicated / mis-placed?

The river layer labels each GeoJSON FEATURE, but Natural Earth splits one
river into several features — so "Benue" can be drawn twice, 40 px apart,
and the duplicate eats one of the 40 label slots (reported 2026-11-01 as
"odd names like benue benue over Africa").

This script loads the map with the rivers overlay on, reads the rendered
`.river-label` tooltips straight out of the DOM (not the layer's own
bookkeeping), and reports:
  * total labels, distinct names,
  * every name drawn MORE THAN ONCE, with the pixel gap between its
    copies — a duplicate pair closer than MIN_GAP_PX is a defect,
  * labels whose anchor sits far outside the viewport (dead slots).

Run: python3 scripts/river_labels_check.py [--url URL] [--shot out.png]
"""
import argparse
import json
import sys
from collections import defaultdict

from playwright.sync_api import sync_playwright

DEFAULT_URL = ("https://xyzo.org/#-17.4345,-22.1924,4/density=max/"
               "overlay=soil-soilgrids@40,nasa-sat@35,nasa-rain@35,"
               "rivers@100,basins@100,cropland-esa@85,land-cover-esa@25")

# Two copies of one river's name closer together than this are a defect:
# one river, one label. Farther apart than this and they are plausibly
# two different rivers that share a name (e.g. two "San Francisco"
# streams), so we only warn.
MIN_GAP_PX = 600


def collect(page):
    """Read every rendered river label out of the DOM."""
    return page.evaluate(
        """() => [...document.querySelectorAll('.river-label')].map(el => {
            const r = el.getBoundingClientRect();
            return {
                text: (el.textContent || '').trim(),
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                onscreen: r.right > 0 && r.left < innerWidth &&
                          r.bottom > 0 && r.top < innerHeight,
            };
        })"""
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--shot", default="/tmp/opencode/river_labels.png")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        # The rivers fetch + label pass needs a few seconds.
        page.wait_for_timeout(9000)

        labels = collect(page)
        # One redraw pass more, in case the first ran mid-fetch.
        page.wait_for_timeout(2500)
        labels = collect(page)

        page.screenshot(path=args.shot)

        by_name = defaultdict(list)
        for lb in labels:
            by_name[lb["text"]].append(lb)

        dups = {n: ls for n, ls in by_name.items() if len(ls) > 1}
        close_dups = {}
        for n, ls in dups.items():
            for i in range(len(ls)):
                for j in range(i + 1, len(ls)):
                    a, b = ls[i], ls[j]
                    gap = ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5
                    if gap <= MIN_GAP_PX:
                        close_dups.setdefault(n, []).append(round(gap))

        offscreen = [lb for lb in labels if not lb["onscreen"]]
        # Off-screen is only a defect BEYOND the layer's deliberate pad:
        # updateLabels() uses bounds.pad(0.1) so a river entering the
        # view is already labelled — a label within ~15 % of the
        # viewport past each edge is that padding working as intended.
        W = page.viewport_size["width"]
        H = page.viewport_size["height"]
        margin = 0.15
        far_off = [lb for lb in labels
                   if not (-W * margin <= lb["x"] <= W + W * margin
                           and -H * margin <= lb["y"] <= H + H * margin)]

        report = {
            "total_labels": len(labels),
            "distinct_names": len(by_name),
            "duplicate_names": sorted(dups),
            "close_duplicate_gaps_px": close_dups,
            "offscreen_labels": len(offscreen),
            "far_offscreen_labels": len(far_off),
            "page_errors": errors[:5],
            "shot": args.shot,
        }
        print(json.dumps(report, indent=2, ensure_ascii=False))

        print("\n--- duplicated names (all copies) ---")
        for n in sorted(dups):
            pts = ", ".join(f"({l['x']},{l['y']})" for l in dups[n])
            print(f"  {n!r} x{len(dups[n])}: {pts}")

        browser.close()

    # Defects: a name drawn twice within the gap threshold, a label far
    # beyond the padded viewport (a dead slot), or a page error.
    bad = []
    if close_dups:
        bad.append(f"{len(close_dups)} river name(s) drawn twice within "
                   f"{MIN_GAP_PX}px: {sorted(close_dups)}")
    if far_off:
        bad.append(f"{len(far_off)} label(s) placed far off-screen: "
                   f"{[l['text'] for l in far_off]}")
    if errors:
        bad.append(f"{len(errors)} page error(s): {errors[:2]}")
    if bad:
        print("\nFAIL: " + "; ".join(bad))
        return 1
    print(f"\nPASS: {len(labels)} labels, {len(by_name)} distinct names, "
          f"none doubled within {MIN_GAP_PX}px, none far off-screen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
