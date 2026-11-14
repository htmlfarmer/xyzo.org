"""Measure the READABILITY of every key in the layers dropdown.

The layers dropdown is a WHITE panel and every key in it must be painted
for a white background. The soil-type key (HWSD v2.2) was the one that
was not: it used `var(--fg)` — the DARK theme's foreground — so the
thirty-four soil names were painted #e6edf3 on white, a contrast ratio
of **1.18:1**. The owner reported it as "its difficult to see the soil
types on the drop down", and the fix was one line of CSS plus the
measurement below, which now guards every key rather than just that one.

WHAT IS MEASURED: every TEXT element inside every key, against the
background actually painted behind it. A swatch (an empty coloured dot)
is not a label and is not measured — the first version of this script
measured one and reported the basins key as "invisible" at 2.05:1, which
was a false positive.

Run: python3 scripts/legend_contrast_check.py [--json]

Exits non-zero if any key is under the WCAG AA ratio for body text
(4.5:1) or under 12 px — a key nobody can read is a key that is not
there.
"""
import argparse
import json
import re
import sys

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"
MIN_RATIO = 4.5
MIN_PX = 11   # the site's floor for small print (the colour-bar ticks)


def _lum(rgb):
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb[:3]
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def _rgb(colour):
    nums = [float(n) for n in re.findall(r"[\d.]+", colour)[:3]]
    return nums if len(nums) == 3 else [0.0, 0.0, 0.0]


def _ratio(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


MEASURE = """() => {
  const list = document.querySelector('.leaflet-control-layers-list');
  const control = document.querySelector('.leaflet-control-layers');
  if (!list || !control) return { error: 'no layers control' };
  // Walk up for the first painted background — the dropdown is white,
  // but a key may sit on its own tinted block.
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = getComputedStyle(node).backgroundColor;
      const m = c.match(/[\\d.]+/g);
      if (m && (m.length < 4 || parseFloat(m[3]) > 0.5)) return c;
      node = node.parentElement;
    }
    return 'rgb(255,255,255)';
  };
  const out = [];
  for (const el of list.querySelectorAll('[id$="-legend"], #hwsd-legend')) {
    if (!el.id) continue;
    const texts = [];
    for (const cand of el.querySelectorAll('*')) {
      if (cand.children.length) continue;           // a leaf only
      const t = (cand.textContent || '').trim();
      if (t.length < 2) continue;                    // an empty swatch
      const cs = getComputedStyle(cand);
      texts.push({
        text: t.slice(0, 30),
        cls: (cand.className || '').toString().slice(0, 34),
        color: cs.color,
        bg: bgOf(cand),
        size: parseFloat(cs.fontSize) || 0,
      });
    }
    out.push({ id: el.id, texts, hidden: !!el.hidden });
  }
  return { keys: out, panel: getComputedStyle(control).backgroundColor };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.goto(BASE + "#2.1,16.8,3", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_timeout(9000)
        page.evaluate("() => document.querySelector('.leaflet-control-layers-toggle')?.click()")
        page.wait_for_timeout(2500)
        data = page.evaluate(MEASURE)
        b.close()

    if data.get("error"):
        print("ERROR:", data["error"])
        return 2

    results = []
    for key in data["keys"]:
        worst = None
        for t in key["texts"]:
            ratio = _ratio(_rgb(t["color"]), _rgb(t["bg"]))
            row = {**t, "ratio": round(ratio, 2),
                   "ok": ratio >= MIN_RATIO and t["size"] >= MIN_PX}
            if worst is None or row["ratio"] < worst["ratio"]:
                worst = row
        if worst:
            results.append({"id": key["id"], **worst})

    if args.json:
        print(json.dumps({"panel": data["panel"], "keys": results}, indent=2))
    else:
        print(f"panel background: {data['panel']}")
        print(f"{'key':28} {'ratio':>8} {'px':>5}  worst text")
        for r in sorted(results, key=lambda x: (x["ratio"], x["size"])):
            flag = "OK" if r["ok"] else ("INVISIBLE" if r["ratio"] < 3 else "LOW")
            print(f"{r['id'][:28]:28} {r['ratio']:7.2f} {r['size']:5.0f}  {r['text'][:24]:24} {flag}")

    bad = [r for r in results if not r["ok"]]
    if bad:
        print(f"\n{len(bad)} key(s) below {MIN_RATIO}:1 or {MIN_PX}px:")
        for r in bad:
            print(f"  {r['id']}: {r['ratio']}:1 at {r['size']}px  "
                  f"({r['color']} on {r['bg']}) — “{r['text']}”")
        return 1
    print(f"\nAll {len(results)} keys readable (≥ {MIN_RATIO}:1, ≥ {MIN_PX}px).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
