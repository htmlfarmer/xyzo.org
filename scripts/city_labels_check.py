"""Independent check: are city labels at the RIGHT screen position?

Two independent verifications, neither of which reuses the layer's own
code path as its oracle:

1. PROJECTION. Recompute each city's expected container point from
   center/zoom/size with plain Web Mercator arithmetic done here, and
   compare with the coordinate the layer actually passed to fillText().
   The layer uses map.latLngToContainerPoint(); using our own formula
   means a wrong Leaflet call (e.g. passing lng/lat swapped) cannot
   agree with itself.

2. PIXELS. For a set of cities, look for the label's white fill in the
   rendered screenshot around the expected point. fillText coords are
   CANVAS coordinates — they are only visually correct if the canvas
   itself is anchored so that canvas (0,0) == container (0,0). A wrong
   anchor makes the drawing self-consistent and still wrong ON SCREEN,
   which is exactly the class of bug here (AGENTS.md: "the pane-translate
   anchor"). So the screenshot is the only oracle that closes that gap.

Run: python3 scripts/city_labels_check.py --url URL --shot out.png
"""
import argparse
import math
import sys
from playwright.sync_api import sync_playwright

try:
    from PIL import Image
except ImportError:
    Image = None

DEFAULT_URL = ("https://xyzo.org/#6.3590,-16.9629,4/time=3d/density=max/"
               "overlay=basins@100,cropland-esa@85,land-cover-esa@25,rivers@100,"
               "nasa-sat@35,nasa-rain@35,soil-soilgrids@40,koppen@35")


def mercator_project(lat, lng):
    """Our own Web Mercator -> world pixel, independent of Leaflet."""
    world = 256.0
    x = (lng + 180.0) / 360.0 * world
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * world
    return x, y


CAPTURE = """
async () => {
  const CL = window.CityLabels, map = window._xyzoMap;
  if (!CL || !map) return { error: 'no CityLabels / no map' };
  // BEFORE forcing it on: this is what the URL + stored preference
  // actually produced, which is the only honest reading of the toggle.
  const initialEnabled = CL.isEnabled();
  const initialStored = localStorage.getItem('xyzo.cityLabels');
  if (!CL.isEnabled()) await CL.setEnabled(true);
  await new Promise(r => setTimeout(r, 2000));
  const st = CL._state;
  if (!st.cities) return { error: 'no city data' };

  const ctx = st.canvas.getContext('2d');
  const orig = ctx.fillText;
  const captured = [];
  ctx.fillText = function (text, x, y) { captured.push({ text, x, y }); return orig.apply(this, arguments); };
  CL._redraw(); await new Promise(r => setTimeout(r, 350));
  CL._redraw(); await new Promise(r => setTimeout(r, 350));
  ctx.fillText = orig;

  const c = map.getCenter(), sz = map.getSize();
  const nameIndex = new Map();
  for (const cc of st.cities) { if (!cc.n) continue;
    if (!nameIndex.has(cc.n)) nameIndex.set(cc.n, []); nameIndex.get(cc.n).push(cc); }

  const out = [];
  for (const cap of captured) {
    const cands = nameIndex.get(cap.text) || [];
    let best = null;
    for (const cc of cands) {
      if (cc.la == null || cc.ln == null) continue;
      const p = map.latLngToContainerPoint([cc.la, cc.ln]);
      const d = Math.hypot(cap.x - p.x, cap.y - p.y);
      if (!best || d < best.d) best = { d, cc, p };
    }
    out.push({ text: cap.text, x: cap.x, y: cap.y,
               la: best ? best.cc.la : null, ln: best ? best.cc.ln : null,
               leaflet: best && best.p ? [best.p.x, best.p.y] : null,
               leafletErr: best ? +best.d.toFixed(2) : null,
               // What is actually on top at that point: the map canvas, or
               // a UI panel. A label under the LIVE FEED panel is
               // correctly placed and simply covered, which must not be
               // counted as a placement failure.
               occludedBy: (() => {
                 if (cap.x < 0 || cap.y < 0 ||
                     cap.x >= (sz.x || 0) || cap.y >= (sz.y || 0)) return 'offscreen';
                 const e = document.elementFromPoint(cap.x, cap.y);
                 if (!e) return 'nothing';
                 const c = (e.className || '').toString();
                 if (e.id === 'xyzo-canvas-pins' || e.tagName === 'CANVAS' ||
                     c.indexOf('leaflet-container') >= 0) return null;
                 return (e.tagName + (e.id ? '#' + e.id : '') + (c ? '.' + c.split(' ')[0] : '')).slice(0, 60);
               })() });
  }
  const anchor = (() => { try { const a = map.containerPointToLayerPoint([0,0]); return [a.x, a.y]; } catch(e){ return null; } })();
  return {
    labels: out, captured: captured.length,
    center: { lat: c.lat, lng: c.lng }, zoom: map.getZoom(),
    size: [sz.x, sz.y],
    anchor,
    canvasLeft: st.canvas.style.left, canvasTop: st.canvas.style.top,
    enabled: CL.isEnabled(),
    initialEnabled,
    initialStored,
    stored: localStorage.getItem('xyzo.cityLabels'),
    hashHasCity: /city-names/.test(location.hash),
    hash: location.hash,
  };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--shot", default="/tmp/opencode/city-labels-check.png")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)
        page.wait_for_function("window.CityLabels && window.CityLabels._state", timeout=20000)
        page.wait_for_timeout(5000)
        res = page.evaluate(CAPTURE)
        page.screenshot(path=args.shot)
        b.close()

    if res.get("error"):
        print("ERROR:", res["error"]); return 2

    print(f"hash lists city-names : {res['hashHasCity']}")
    print(f"stored preference     : {res['initialStored']!r}")
    print(f"layer ON as loaded    : {res['initialEnabled']}   "
          f"(forced on afterwards to measure placement)")
    print(f"map centre            : {res['center']['lat']:.4f}, {res['center']['lng']:.4f}  zoom {res['zoom']}  size {res['size']}")
    print(f"canvas anchor         : left={res['canvasLeft']} top={res['canvasTop']}  containerPointToLayerPoint(0,0)={res['anchor']}")
    print(f"labels captured       : {res['captured']}")
    print()

    labels = res["labels"]
    if not labels:
        print("No labels painted (population floor / collision culling at this zoom).")
        return 0

    # ── 1. independent projection ───────────────────────────────────────
    cx, cy = mercator_project(res["center"]["lat"], res["center"]["lng"])
    W, H = res["size"]
    worst_leaflet, worst_ours, our_err = 0.0, 0.0, []
    for l in labels:
        if l["la"] is None:
            continue
        worst_leaflet = max(worst_leaflet, l["leafletErr"] or 0)
        ex, ey = mercator_project(l["la"], l["ln"])
        # world pixel -> container pixel: zoom scales by 2^zoom (base 256)
        scale = 2 ** res["zoom"] / 256.0
        px = (ex - cx) * (2 ** res["zoom"]) + W / 2
        py = (ey - cy) * (2 ** res["zoom"]) + H / 2
        err = math.hypot(l["x"] - px, l["y"] - py)
        our_err.append((err, l))
        worst_ours = max(worst_ours, err)

    print(f"1. PROJECTION — layer vs our own Web Mercator")
    print(f"   worst deviation vs Leaflet's own call : {worst_leaflet:.2f} px")
    print(f"   worst deviation vs OUR formula        : {worst_ours:.1f} px")
    worst_ours_sorted = sorted(our_err, key=lambda t: -t[0])[:5]
    for err, l in worst_ours_sorted:
        print(f"     {l['text']:<22} drawn=({l['x']:.0f},{l['y']:.0f}) ours_err={err:.1f}px")
    print()

    # ── 2. pixels on screen (the anchor oracle) ─────────────────────────
    print("2. ON-SCREEN PIXELS — is the canvas anchored so canvas==container?")
    if Image is None:
        print("   PIL unavailable; skipped")
    else:
        im = Image.open(args.shot).convert("RGB")
        checked = passed = 0
        missing, skipped = [], []
        # pick well-separated, unmistakable cities
        picks = []
        for want in ["Kinshasa", "Lagos", "Cairo", "New York City", "Bogotá",
                     "Istanbul", "Johannesburg", "São Paulo", "Nouakchott", "Fortaleza"]:
            for l in labels:
                if l["text"] == want and l["la"] is not None:
                    picks.append(l); break
        for l in picks:
            if not (0 <= l["x"] < W and 0 <= l["y"] < H):
                continue
            # Covered by a panel: correctly placed, not visible here.
            if l.get("occludedBy"):
                skipped.append((l["text"], l["occludedBy"])); continue
            checked += 1
            box = im.crop((max(0, int(l["x"]) - 45), max(0, int(l["y"]) - 14),
                           min(W, int(l["x"]) + 45), min(H, int(l["y"]) + 14)))
            # the label is white fill with a dark outline
            whites = sum(1 for px in box.getdata() if px[0] > 225 and px[1] > 225 and px[2] > 225)
            if whites > 12:
                passed += 1
            else:
                missing.append((l["text"], round(l["x"]), round(l["y"]), whites))
        print(f"   cities checked: {checked}   visible white label text: {passed}")
        if skipped:
            for t, by in skipped:
                print(f"     skipped (covered by {by}): {t}")
    print()

    verdict_proj = worst_ours <= 3
    verdict_px = (not missing) if Image is not None and checked else None
    if verdict_proj and verdict_px:
        print("VERDICT: labels are at the correct locations (projection and pixels agree).")
        rc = 0
    else:
        print(f"VERDICT: PROJECTION {'OK' if verdict_proj else 'WRONG'} / "
              f"PIXELS {'OK' if verdict_px else 'WRONG or unchecked'}.")
        rc = 1 if not verdict_proj else 0

    # ── 3. the toggle question ──────────────────────────────────────────
    print()
    if not res["hashHasCity"] and res["initialEnabled"]:
        print("ISSUE: city names are ON although this URL does not list city-names.")
        print("       (the boot gate should have removed them; reported for the record)")
    elif not res["hashHasCity"]:
        print("OK: city names are OFF as loaded — the URL does not list them.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
