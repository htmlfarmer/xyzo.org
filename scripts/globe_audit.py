"""Audit every 3D-globe overlay: does it actually render?

Run: python3 scripts/globe_audit.py [--shots DIR]

For each overlay in the globe's layers panel this switches the layer ON
and asks MapLibre, from inside the page:

  * does the layer exist?        map.getLayer(id)
  * is it visible?               layout.visibility
  * does its source exist?       getSource(id)
  * is the source actually LOADED / non-empty?  (tiles fetched, geojson
    features present, image source has a data URL)
  * did anything get painted?    (pixels differ from the basemap alone)

A layer that exists but has no loaded source is the failure mode we are
hunting: the toggle looks like it did something and the map does not
change. Everything is reported as JSON so a test can assert on it.
"""
import argparse
import json
import os
import sys
import tempfile
from playwright.sync_api import sync_playwright

try:
    from PIL import Image
except ImportError:  # the visual verdict degrades instead of crashing
    Image = None

BASE = "https://xyzo.org"
GLOBE = f"{BASE}/globe"

PROBE = r"""
(key) => {
  const map = window.__globeMap;
  if (!map) return { ok: false, why: "no map" };

  // TWO of the overlays are CANVAS ANIMATIONS, not MapLibre layers:
  // `wind` and `ocean-current` are drawn by globe-wind.js into its own
  // canvas, so the structural check cannot see them — and it fails in
  // two different ways:
  //   * `ocean-current` has no MapLibre layer at all → "layer missing";
  //   * `wind`'s prefix match (`id.startsWith("wind-")`) also matches
  //     the SPEED field's `wind-speed-*` layer, which is correctly
  //     HIDDEN while only the animation is on → "layer exists but is
  //     hidden", reported against a layer that is not even its own.
  // Ask the controller instead. Whether it DREW is the screenshot's
  // verdict (the visual rule below still runs), and the frame-to-frame
  // canvas check lives in scripts/globe_wind_audit.py.
  const anims = window.__globeAnimations;
  if (anims && Object.prototype.hasOwnProperty.call(anims, key)) {
    const c = anims[key];
    return {
      key,
      isAnimation: true,
      animation: {
        present: true,
        enabled: !!(c && c._state && c._state.enabled),
        ready: !!(c && typeof c.isReady === "function" && c.isReady()),
        source: c ? c._source : null,
      },
      layerIds: [],
      layerExists: true,
      visible: [{ id: "(canvas)", visibility: "visible", type: "canvas" }],
      sources: [],
      errors: [],
    };
  }

  // MapLibre's getLayer() returns a plain descriptor here (no .get()),
  // so read the style object directly — version-independent.
  const style = map.getStyle();
  const all = (style && style.layers) || [];
  const ids = all
    .filter(l => l.id === key || l.id.startsWith(key + "-") || l.id.startsWith(key + "_"))
    .map(l => l.id);

  const out = { key, layerIds: ids, layerExists: ids.length > 0, visible: [], sources: [], errors: [] };

  const srcIds = new Set();
  for (const l of all) {
    if (!ids.includes(l.id)) continue;
    const vis = (l.layout && l.layout.visibility) || "visible";
    out.visible.push({ id: l.id, visibility: vis, type: l.type });
    if (l.source) srcIds.add(l.source);
    if (l.type === "raster" || l.type === "image") {
      out._paintOpacity = (l.paint && l.paint["raster-opacity"]);
    }
  }

  for (const sid of srcIds) {
    const s = map.getSource(sid);
    const info = { id: sid, exists: !!s };
    if (s) {
      info.type = s.type;
      try {
        if (s.type === "image" || typeof s.url === "string") {
          info.urlLen = (s.url || "").length;
          info.hasImage = info.urlLen > 100;
        }
      } catch (e) { info.urlErr = String(e); }
      try {
        if (typeof s.serialize === "function") {
          const ser = s.serialize();
          info.tileUrlCount = (ser.tiles || []).length;
          info.hasData = !!ser.data;
          if (s.type === "geojson") {
            info.featureCount = ser.data && ser.data.features ? ser.data.features.length : null;
          }
        }
      } catch (e) { info.serializeError = String(e); }
      try { if (typeof s.loaded === "function") info.loaded = s.loaded(); } catch (e) {}
    }
    out.sources.push(info);
  }

  try { out.rendered = map.queryRenderedFeatures().length; } catch (e) {}
  return out;
}
"""


def reset_overlays(page):
    """Turn every overlay off and clear persisted state.

    The globe restores overlays from localStorage["xyzo.globe.settings"],
    so a previous run (or a user who left 15 layers on) makes every
    screenshot a stack of all of them — which reads as "everything is
    broken" when it is really "everything is on at once".
    """
    page.evaluate(
        """() => {
        try { localStorage.removeItem('xyzo.globe.settings'); } catch (e) {}
        const boxes = document.querySelectorAll('input[type=checkbox][data-key]');
        boxes.forEach(b => { if (b.checked) b.click(); });
        return boxes.length;
    }"""
    )
    page.wait_for_timeout(800)


def globe_stats(png_path, skip_x=340):
    """Colour statistics of the rendered globe, for a visual verdict.

    A layer can be structurally perfect (source loaded, visibility on)
    and still paint a solid wash over the planet — which is what
    "doesn't look correct" means in practice. The objective version: if
    one colour covers most of the globe, the overlay is drowning it.

    Read off the SCREENSHOT, not the GL buffer: MapLibre does not set
    preserveDrawingBuffer, so context.readPixels() returns all zeros
    here (verified — every probe came back lit: 0).

    `skip_x` cuts the layers panel out of the frame so its white-on-black
    rows cannot dominate the histogram.
    """
    if Image is None:
        return None
    im = Image.open(png_path).convert("RGB")
    w, h = im.size
    if w <= skip_x + 10:
        return None
    im = im.crop((skip_x, 0, w, h))
    px = im.load()
    cw, ch = im.size

    counts = {}
    lit = 0
    for y in range(0, ch, 3):
        for x in range(0, cw, 3):
            r, g, b = px[x, y]
            if r < 24 and g < 24 and b < 24:   # page background
                continue
            lit += 1
            q = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
            counts[q] = counts.get(q, 0) + 1
    if not lit:
        return {"lit": 0}
    top = max(counts.values())
    return {
        "lit": lit,
        "distinct": len(counts),
        "dominantShare": round(top / lit, 3),
    }


def audit(page, out_dir, shots):
    page.wait_for_function("window.__globeMap !== undefined", timeout=30000)
    page.wait_for_function(
        "() => { const m = window.__globeMap; return m && m.isStyleLoaded && m.isStyleLoaded(); }",
        timeout=30000,
    )
    # let boot overlays settle
    page.wait_for_timeout(3000)

    reset_overlays(page)

    keys = page.eval_on_selector_all(
        "input[type=checkbox][data-key]",
        "els => els.map(e => e.dataset.key)",
    )
    print(f"found {len(keys)} overlay toggles: {keys}", file=sys.stderr)

    results = []
    for key in keys:
        cb = page.query_selector(f'input[data-key="{key}"]')
        if cb is None:
            results.append({"key": key, "ok": False, "problems": ["no checkbox"]})
            continue

        # ISOLATED: everything else off, this one on.
        page.evaluate(
            """(keep) => {
            document.querySelectorAll('input[type=checkbox][data-key]')
              .forEach(b => { const want = b.dataset.key === keep;
                              if (b.checked !== want) b.click(); });
        }""",
            key,
        )
        # give async loaders time
        page.wait_for_timeout(2500)

        info = page.evaluate(PROBE, key)
        info["checked"] = cb.is_checked()

        # Always capture: the visual verdict reads the screenshot, so
        # there is no mode that skips it. Keeping the file is free.
        shot = os.path.join(out_dir, f"globe-{key}.png")
        page.screenshot(path=shot, full_page=False)
        info["stats"] = globe_stats(shot)
        info["shot"] = shot if shots else None
        if not shots:
            try:
                os.remove(shot)
            except OSError:
                pass

        info["problems"] = problems_of(info)
        results.append(info)

        mark = "OK  " if not info["problems"] else "FAIL"
        print(
            f"  {mark} {key}"
            + ("" if not info["problems"] else " | " + "; ".join(info["problems"]))
            + (f"  dom={info['stats'].get('dominantShare')} distinct={info['stats'].get('distinct')}"
               if info.get("stats") and "dominantShare" in info["stats"] else ""),
            file=sys.stderr,
        )

    return results


def problems_of(info):
    """Verdict — type-aware, plus a visual check.

    Only raster/vector sources carry `tiles`; geojson and image sources
    have none BY DESIGN, so asserting on them flags 6 healthy overlays as
    broken (it did). The visual rule catches the opposite failure: a
    source that loads fine and then covers the entire planet.
    """
    problems = []
    if info.get("isAnimation"):
        # A canvas animation has no MapLibre layer and no source BY
        # DESIGN — see the note at the top of PROBE. The controller
        # being switched on is the plumbing check; the screenshot rule
        # at the bottom is the drawing check.
        anim = info.get("animation") or {}
        if not anim.get("present"):
            problems.append("animation controller missing")
        elif not anim.get("enabled"):
            problems.append("animation controller not enabled")
    else:
        if not info.get("layerExists"):
            problems.append("layer missing")
        if info.get("layerExists") and not any(
            v["visibility"] != "none" for v in info.get("visible", [])
        ):
            problems.append("layer exists but is hidden")
        if not info.get("sources"):
            problems.append("layer has no source")

        for s in info.get("sources", []):
            sid = s.get("id")
            if not s.get("exists"):
                problems.append(f"source {sid} missing")
                continue
            st = s.get("type")
            if st == "image" and not s.get("hasImage"):
                problems.append(f"image source {sid} has no image data")
            elif st == "geojson" and s.get("featureCount") == 0:
                problems.append(f"geojson source {sid} has 0 features")
            elif st in ("raster", "vector") and s.get("tileUrlCount") == 0:
                problems.append(f"tile source {sid} has no tile urls")
            if s.get("serializeError"):
                problems.append(f"source {sid} serialize error: {s['serializeError']}")

    # Visual: one colour owning most of the lit globe means the overlay
    # is a solid wash, whatever its plumbing says.
    st = info.get("stats") or {}
    if st.get("lit") and st.get("distinct") is not None:
        if st["dominantShare"] > 0.85:
            problems.append(
                f"looks wrong: one colour is {round(st['dominantShare']*100)}% "
                f"of the globe ({st['distinct']} distinct colours)"
            )
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", action="store_true", help="save a screenshot per overlay")
    ap.add_argument("--out", default="/tmp/opencode/globe-shots")
    ap.add_argument("--json", action="store_true", help="print JSON to stdout")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1,
        )
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(GLOBE, wait_until="domcontentloaded", timeout=60000)
        results = audit(page, args.out, args.shots)

        # panel visible?
        panel = page.query_selector("#globe-panel")
        if panel:
            box = panel.bounding_box()
            panel_info = {"visible": bool(box), "box": box}
        else:
            panel_info = {"visible": False, "box": None}

        browser.close()

    for r in results:
        r["ok"] = not r.get("problems")

    summary = {
        "base": BASE,
        "panel": panel_info,
        "total": len(results),
        "passed": sum(1 for r in results if r.get("ok")),
        "failed": [r["key"] for r in results if not r.get("ok")],
        "results": results,
        "consoleErrors": errors[:20],
    }

    if args.json:
        print(json.dumps(summary, indent=2, default=str))
    else:
        print(f"\n{summary['passed']}/{summary['total']} overlays OK")
        if summary["failed"]:
            print("FAILED:", ", ".join(summary["failed"]))
        if errors:
            print("\nconsole errors:")
            for e in errors[:10]:
                print("  ", e[:200])

    return 0 if not summary["failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
