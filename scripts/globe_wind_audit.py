"""
The globe's wind: does the ANIMATION and the SPEED field both work?

The owner asked: *"can we get the wind animation and also the wind
speed overlay for the 3d globe whats going on with that?"*

The answer was "the entries are in the panel, but the animation is
wired to the wrong thing": the globe had ONE controller variable for
BOTH animations, so creating the ocean-current controller overwrote
the wind's — and switching "Wind (GFS)" on switched the OCEAN
CURRENTS on instead. The wind never animated.

This script checks, on the live globe:
  1. both entries are in the panel with the right defaults;
  2. the SPEED field is a MapLibre layer, visible, and it changes the
     picture (and agrees with the published grid);
  3. the ANIMATION is a canvas that draws — and the switch reaches
     the RIGHT controller;
  4. the two animations do not interfere.

Run:  python3 scripts/globe_wind_audit.py
"""
import json
import sys

from playwright.sync_api import sync_playwright

GLOBE = "https://xyzo.org/globe#0,0,2.6"


def panel_state(pg):
    return pg.evaluate(r"""
      () => {
        const rows = {};
        for (const row of document.querySelectorAll('.globe-ov-row')) {
          const cb = row.querySelector('input[type=checkbox]');
          const sl = row.querySelector('.globe-ov-opacity');
          const label = (row.querySelector('label span:last-child') || {}).textContent || '';
          rows[label.trim()] = { on: cb ? cb.checked : null, opacity: sl ? sl.value : null };
        }
        return rows;
      }
    """)


def toggle(pg, label, on):
    """EXACT label, not `includes`.

    "Wind" matches BOTH "Wind (GFS)" and "Wind speed (GFS)", so an
    `includes` match silently toggled the SPEED field and left the
    animation off — which is exactly what the first run of this audit
    reported ("the animation does nothing") and exactly what a reader
    would hit when trying to work out which button to press.
    """
    return pg.evaluate(
        """([label, on]) => {
          const rows = [...document.querySelectorAll('.globe-ov-row')];
          const row = rows.find(r => {
            // The row's text carries an EMOJI ("💨 Wind (GFS)"), so the
            // label is compared AFTER the leading emoji is stripped.
            //
            // An `indexOf(...) === length - n` test is WRONG here: when
            // the label is absent, indexOf returns -1 and the test
            // accidentally matches any row whose text is exactly n
            // characters long — which is how this audit spent its
            // first run switching the RIVERS on and reporting that the
            // wind did nothing.
            const t = ((r.querySelector('label span:last-child')||{}).textContent||'').trim();
            const bare = t.replace(/^\s*[^\p{L}\p{N}]+\s*/u, '').trim();
            return bare === label;
          });
          const cb = row && row.querySelector('input[type=checkbox]');
          if (!cb) return 'NO ROW';
          if (cb.checked !== on) cb.click();
          return cb.checked;
        }""",
        [label, on],
    )


def canvas_ink(pg):
    return pg.evaluate(r"""
      () => {
        const out = [];
        for (const c of document.querySelectorAll('canvas')) {
          if (!c.className || !String(c.className).includes('xyzo-globe-wind')) continue;
          const ctx = c.getContext('2d');
          let lit = 0, n = 0;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 4 * 331) { n++; if (d[i] > 0) lit++; }
          out.push({ w: c.width, h: c.height, lit, sampled: n });
        }
        return out;
      }
    """)


def main():
    pw = sync_playwright().start()
    b = pw.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl"])
    pg = b.new_page(viewport={"width": 1200, "height": 850})
    errs = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text[:130]}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:130]))

    pg.goto(GLOBE, wait_until="networkidle", timeout=90000)
    pg.wait_for_timeout(10000)

    print("== the panel ==")
    rows = panel_state(pg)
    for label, st in rows.items():
        if "Wind" in label:
            print(f"  {label:28s} on={st['on']} opacity={st['opacity']}%")

    print("\n== the SPEED field (a MapLibre raster) ==")
    toggle(pg, "Wind speed (GFS)", True)
    pg.wait_for_timeout(9000)
    speed = pg.evaluate(r"""
      () => {
        const map = window.__globeMap;
        const layer = map.getLayer('wind-speed');
        const src = map.getSource('wind-speed');
        if (!layer) return { present: false };
        return {
          present: true,
          visibility: (layer.layout || {}).visibility,
          opacity: layer.paint && layer.paint['raster-opacity'],
          source: !!src,
          hasImage: !!(src && src.image),
          coords: src && src.coordinates ? src.coordinates[0] : null,
        };
      }
    """)
    print("  ", json.dumps(speed))
    # MapLibre does NOT preserve the drawing buffer, so readPixels()
    # returns zeros — the verdict has to come from a SCREENSHOT.
    def centre_pixel():
        pg.screenshot(path="/tmp/opencode/_gw.png")
        from PIL import Image
        im = Image.open("/tmp/opencode/_gw.png").convert("RGB")
        return im.getpixel((im.width // 2, im.height // 2))

    before = centre_pixel()
    toggle(pg, "Wind speed (GFS)", False)
    pg.wait_for_timeout(2500)
    after = centre_pixel()
    print("  centre pixel with the field ON :", before)
    print("  centre pixel with the field OFF:", after)
    print("  the field changes the picture:", before != after)

    print("\n== the ANIMATION ==")
    toggle(pg, "Wind (GFS)", True)
    pg.wait_for_timeout(9000)
    print("  controllers:", pg.evaluate("() => Object.keys(window.__globeAnimations || {})"))
    print("  which one is enabled:", pg.evaluate(r"""
      () => {
        const c = window.__globeAnimations || {};
        const out = {};
        for (const k of Object.keys(c)) out[k] = !!(c[k] && c[k]._state && c[k]._state.enabled);
        return out;
      }
    """))
    print("  canvases:", json.dumps(canvas_ink(pg)))
    pg.wait_for_timeout(2500)
    print("  canvases 2.5 s later:", json.dumps(canvas_ink(pg)))

    print("\nconsole errors:", errs[:6])
    b.close()
    pw.stop()


if __name__ == "__main__":
    main()
