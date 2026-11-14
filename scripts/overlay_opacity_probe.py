"""Probe: does an overlay's OPACITY survive into the URL the reader shares?

Run: python3 scripts/overlay_opacity_probe.py [--pct 37] [--json]

Opens the flat map with a batch of overlays at ONE deliberately odd
opacity, then compares three things per overlay:

  link   what the shared link asked for
  url    what getMapHash() would now write — i.e. what re-sharing gives
  live   what the layer is actually rendering

A `url` that disagrees with `link` means the reader's own stored
preference is leaking into the URL (the map looks right, the shared
link is wrong); a `live` that disagrees means the link never applied.
"""
import argparse
import json
import sys
from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org"

# Slugs across the three shapes of overlay: Leaflet tile layers (which
# carry a numeric options.opacity), module layers with their own
# setOpacity/getOpacity, and canvas/vector layers with neither.
SLUGS = [
    "koppen", "nasa-rain", "soil-soilgrids", "cropland-esa",
    "basins", "rivers", "geology-macrostrat", "magnetic",
    "earthquakes", "faults", "wind-gfs", "wind-speed-gfs",
    "ocean-currents-live", "lightning", "temperature", "isobars",
    "language-regions", "population-density-worldpop-1-km",
    "soil-type-hwsd-v2-2", "rivers-fao-2026",
]

PROBE = r"""
(slugs) => {
  const out = {};
  const hash = typeof getMapHash === "function" ? getMapHash() : "";
  const entries = (hash.split("/").find(p => p.startsWith("overlay=")) || "").slice(8)
    .split(",").filter(Boolean);
  for (const e of entries) {
    const at = e.lastIndexOf("@");
    out[at > 0 ? e.slice(0, at) : e] = { url: at > 0 ? Number(e.slice(at + 1)) : null };
  }
  // The URL does not echo the slug the LINK used — it writes
  // getLayerSlug(name), which derives `earthquakes-usgs` from
  // "🌐 Earthquakes (USGS)". Match on that, or every derived slug is
  // reported as "not enabled".
  const expected = {};
  for (const s of slugs) {
    const name = (typeof resolveLayerName === "function") ? resolveLayerName(s) : null;
    expected[s] = (name && window.__xyzoLayerSlug) ? window.__xyzoLayerSlug(name) : s;
  }
  // What the reader is actually LOOKING AT: the registered layer's own
  // opacity for anything Leaflet paints with (tile/WMS layers), the
  // module's getter for the vector layers whose module owns the restyle.
  // Reading the module's getter alone is wrong for geology and the FAO
  // rivers — their module state is a separate value the layers-dropdown
  // slider never writes, so it reports the DEFAULT while the map is
  // already at the link's opacity.
  const live = {};
  try {
    for (const k of Object.keys(expected)) {
      const name = (typeof resolveLayerName === "function") ? resolveLayerName(k) : null;
      const layer = (typeof WEATHER_OVERLAYS !== "undefined") ? WEATHER_OVERLAYS[name] : null;
      let v = null;
      if (layer && layer.options && typeof layer.options.opacity === "number") {
        v = layer.options.opacity;
      } else {
        const mods = {
          "basins": window.BasinLayer, "rivers": window.RiverLayer,
          "wind-gfs": window.WindLayer, "wind-speed-gfs": window.WindSpeedLayer,
          "ocean-currents-live": window.OceanCurrentLayer,
          "isobars": window.IsobarLayer, "magnetic": window.MagLayer,
          "temperature": window.TempLayer, "lightning": window.LightningLayer,
          "language-regions": window.LanguagesRegionsLayer,
          "soil-type-hwsd-v2-2": window.HwsdLayer,
          "population-density-worldpop-1-km": window.PopulationLayer,
          "rivers-fao-2026": window.FaoRiversLayer,
          "geology-macrostrat": window.GeologyLayer,
          "earthquakes": window.EarthquakeLayer, "faults": window.FaultLayer,
        };
        const m = mods[k];
        if (m && typeof m.getOpacity === "function") { try { v = m.getOpacity(); } catch (_) {} }
      }
      live[k] = v == null ? null : Math.round(v * 100);
    }
  } catch (e) { live.__error = String(e); }
  return { hash, overlays: out, expected, live };
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pct", type=int, default=37)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    pct = args.pct
    overlay = ",".join(f"{s}@{pct}" for s in SLUGS)
    url = f"{BASE}/#{72.3024},{12.6563},4/overlay={overlay}"

    bad = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        page.wait_for_timeout(12000)

        res = page.evaluate(PROBE, SLUGS)
        browser.close()

    print(f"asked for {len(SLUGS)} overlays at {pct}%\n")
    print(f"{'slug':38} {'url':>5} {'live':>5}  verdict")
    for slug in SLUGS:
        # The URL echoes getLayerSlug(name), not the slug the link used.
        want_slug = res["expected"].get(slug, slug)
        e = res["overlays"].get(want_slug)
        if not e:
            print(f"{slug:38} {'--':>5} {'--':>5}  NOT IN URL (expected {want_slug})")
            bad.append(f"{slug}: not enabled at all")
            continue
        urlpct = e.get("url")
        live = res["live"].get(slug)
        problems = []
        if urlpct != pct:
            problems.append(f"URL says {urlpct}, link asked {pct}")
        if live is not None and live != pct:
            problems.append(f"layer renders {live}")
        verdict = "ok" if not problems else "; ".join(problems)
        if problems:
            bad.append(f"{slug}: {verdict}")
        print(f"{slug:38} {str(urlpct):>5} {str(live):>5}  {verdict}")

    print(f"\n{len(bad)} of {len(SLUGS)} overlays do not round-trip their opacity")
    for b in bad:
        print("   -", b)
    if errors:
        print("\npage errors:")
        for e in errors[:6]:
            print("   ", str(e)[:180])
    if args.json:
        print(json.dumps({"asked": pct, "bad": bad}, indent=2))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
