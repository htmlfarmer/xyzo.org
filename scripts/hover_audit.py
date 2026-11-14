"""
The mouse-pointer study.

WHAT IT CHECKS
--------------
The reader's question: *"is the 'mouse over' working and doing a circle
around the story or earthquake or whatever?"*

The answer before this script existed was "only for a story pin, and
only if the pin happened to be somewhere the pointer could reach". The
script measures it, and the fixes it found are:

  1. **The ring was the pin renderer's private element.** The
     earthquakes, the faults and the language regions had no ring at
     all — pointing at one showed nothing. There is now ONE ring
     (`public_html/hover-ring.js`) and every point overlay asks it to
     move, so there is never more than one circle under the cursor.
  2. **The hover card only knew about story pins.** It now takes a
     generic TARGET from any layer (`HoverInfo.setTarget`), so
     hovering an earthquake says what it is.
  3. **The globe had no ring.** It has one now, moved to the feature
     under the cursor.

THE TRAP THIS SCRIPT WALKS INTO
--------------------------------
The first version of this study reported the hover as completely
broken, and it was wrong: it picked the first pin the API returned,
and that pin was often **under the layers dropdown** — so the pointer
moved onto the dropdown, not onto the map. A hover study must only
count a point that the pointer can actually REACH, so every probe
here asks `document.elementFromPoint()` what is really under the
cursor first. (That is also how the dropdown covering the map was
found: a reader aiming at a pin in the top-right corner is aiming at
the dropdown.)

Run:  python3 scripts/hover_audit.py [--globe]
"""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org"
FLAT = BASE + "/#35,140,4"
GLOBE = BASE + "/globe#2,10,2"

PROBE = r"""
() => {
  const ghost = document.querySelector(".xyzo-pin-hover-ghost");
  const hud = document.getElementById("hover-hud");
  const canvas = document.querySelector("canvas.xyzo-canvas-pins");
  const ring = window.HoverRing ? window.HoverRing.owner() : null;
  const g = ghost ? ghost.getBoundingClientRect() : null;
  return {
    ringVisible: ghost ? !ghost.classList.contains("hidden") : false,
    ringOwner: ring,
    ringBox: g ? [Math.round(g.left), Math.round(g.top), Math.round(g.width)] : null,
    cursor: canvas ? canvas.style.cursor : null,
    hudVisible: hud ? !hud.hidden : false,
    hudText: hud ? (hud.textContent || "").replace(/\s+/g, " ").trim().slice(0, 130) : null,
  };
}
"""


def reach(pg, x, y):
    """Is this point something the pointer can actually reach?"""
    return pg.evaluate(
        """([x, y]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          const map = window._xyzoMap;
          const inCanvas = !!(el.classList && el.classList.contains('xyzo-canvas-pins'));
          const inMap = !!(map && map.getContainer() && map.getContainer().contains(el));
          return { tag: el.tagName, cls: String(el.className || '').slice(0, 40), inCanvas, inMap };
        }""",
        [x, y],
    )


def sweep(pg, x, y, r=18):
    """Move the pointer onto a point the way a human does — in steps."""
    for dx in range(-r, 3, 3):
        pg.mouse.move(x + dx, y + (dx // 4))
        pg.wait_for_timeout(35)
    pg.wait_for_timeout(500)


def main():
    gl = "--globe" in sys.argv
    pw = sync_playwright().start()
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text[:140]}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:140]))

    if gl:
        pg.goto(GLOBE, wait_until="networkidle", timeout=90000)
        pg.wait_for_timeout(9000)
        print("== GLOBE ==")
        pt = pg.evaluate(r"""
          () => {
            const map = window.__globeMap;
            if (!map) return null;
            // The pin nearest the CAMERA CENTRE — the centre is on the
            // visible hemisphere by definition, so the nearest pin is
            // too. (querySourceFeatures returns the whole source, back
            // side included, and a pin on the far side projects to a
            // point that is under the planet.)
            const c = map.getCenter();
            const cp = map.project([c.lng, c.lat]);
            const feats = map.querySourceFeatures("pins");
            // map.project() is relative to the MAP CANVAS; the pointer
            // is in PAGE coordinates, so the canvas's own offset has to
            // be added — forget it and the pointer lands somewhere
            // else entirely, which is how this study first reported a
            // working hover as broken.
            const rect = map.getCanvas().getBoundingClientRect();
            let best = null, bestD = Infinity;
            for (const f of feats) {
              const p = map.project(f.geometry.coordinates);
              const d = Math.hypot(p.x - cp.x, p.y - cp.y);
              if (d < bestD) {
                bestD = d;
                best = { x: Math.round(p.x + rect.left), y: Math.round(p.y + rect.top), d: Math.round(bestD) };
              }
            }
            return bestD < 120 ? best : null;
          }
        """)
        print("a story pin at:", pt)
        if pt:
            pg.mouse.move(pt["x"] - 25, pt["y"] - 25)
            pg.wait_for_timeout(300)
            pg.mouse.move(pt["x"], pt["y"])
            pg.wait_for_timeout(900)
            print("ring:", pg.evaluate(r"""
              () => {
                const src = window.__globeMap.getSource('pin-hover-ring');
                if (!src) return 'no source';
                const d = src._data;
                return (d && d.features && d.features.length) ? d.features.length + ' ring feature(s)' : 'none';
              }
            """))
            print("cursor:", pg.evaluate("() => window.__globeMap.getCanvas().style.cursor"))
        print("errors:", errs[:5])
        b.close()
        pw.stop()
        return

    pg.goto(FLAT, wait_until="networkidle", timeout=90000)
    pg.wait_for_timeout(8000)

    print("== FLAT MAP ==")
    print("HUD mode:", pg.evaluate("() => window.HoverInfo.getMode()"))

    # ── 1. a story pin ──────────────────────────────────────────────────
    pt = pg.evaluate(r"""
      () => {
        const map = window._xyzoMap;
        const pins = (window.__xyzoExportPins && window.__xyzoExportPins()) || [];
        const w = window.innerWidth, h = window.innerHeight;
        for (const p of pins) {
          const lat = p.location?.lat ?? p.lat, lng = p.location?.lng ?? p.lng;
          if (typeof lat !== 'number') continue;
          const c = map.latLngToContainerPoint([lat, lng]);
          const x = Math.round(c.x), y = Math.round(c.y);
          if (x < 340 || y < 120 || x > w - 420 || y > h - 150) continue;
          const el = document.elementFromPoint(x, y);
          if (el && el.classList && el.classList.contains('xyzo-canvas-pins')) return { x, y };
        }
        return null;
      }
    """)
    print("a reachable story pin at:", pt, "|", reach(pg, pt["x"], pt["y"]) if pt else "")
    if pt:
        sweep(pg, pt["x"], pt["y"])
        print("  ON the pin:", json.dumps(pg.evaluate(PROBE)))
    pg.mouse.move(700, 880)
    pg.wait_for_timeout(600)
    print("  empty map:", json.dumps(pg.evaluate(PROBE)))

    # ── 2. an earthquake ────────────────────────────────────────────────
    pg.evaluate(r"""
      () => {
        const labels = [...document.querySelectorAll('.leaflet-control-layers-list label')];
        const hit = labels.find(l => (l.textContent || '').includes('Earthquakes'));
        const cb = hit && hit.querySelector('input[type=checkbox]');
        if (cb && !cb.checked) cb.click();
      }
    """)
    pg.wait_for_timeout(4000)
    # The 24 h window has only a handful of events and the view may
    # hold none of them; the 7-day window always does.
    pg.evaluate("() => { try { window.EarthquakeLayer.setWindow('week'); } catch (e) {} }")
    pg.wait_for_timeout(6000)
    # find a REACHABLE earthquake: one that is on screen AND under the
    # pin canvas (not under the dropdown or the live panel)
    eq = pg.evaluate(r"""
      () => {
        const L = window.EarthquakeLayer, m = window._xyzoMap;
        const feats = (L._state.features && L._state.features.features) || [];
        const w = window.innerWidth, h = window.innerHeight;
        const cands = [];
        for (const f of feats) {
          const c = f.geometry.coordinates;
          const pt = m.latLngToContainerPoint([c[1], c[0]]);
          const x = Math.round(pt.x), y = Math.round(pt.y);
          if (x < 340 || y < 120 || x > w - 420 || y > h - 150) continue;
          cands.push({ x, y, mag: f.properties.mag, place: f.properties.place });
        }
        return cands.slice(0, 6);
      }
    """)
    print("candidate earthquakes:", eq)
    hit_eq = None
    for c in eq:
        el = reach(pg, c["x"], c["y"])
        if el and el.get("inCanvas"):
            hit_eq = c
            break
    print("a reachable earthquake:", hit_eq)
    if hit_eq:
        sweep(pg, hit_eq["x"], hit_eq["y"])
        print("  ON the earthquake:", json.dumps(pg.evaluate(PROBE)))

    print("console errors:", errs[:6])
    b.close()
    pw.stop()


if __name__ == "__main__":
    main()
