"""
The LIVE ocean currents: do they actually load, every time?

The owner reported: *"it doesn't seem to always load correctly"*.

"Always" is the whole point — there are four ways in, and each one
reaches the layer differently:

  1. the DEFAULT load — since 2026-11-08 the currents are NOT part of
     the first-visit map (they are a 2014 field, and the owner's own
     15-overlay showcase does not carry them), so the default load must
     open WITHOUT them and without an error;
  2. a LINK with `overlay=ocean-currents-live@100`;
  3. a CLICK on the checkbox in the layers dropdown (the layer is
     switched on long after the grid is in hand);
  4. a PAN afterwards (the layer must keep running, and the particles
     must follow the view).

And there are three things the layer can do that look like they work:

  5. the TAB GOES TO THE BACKGROUND and comes back (the Firefox bug —
     the frame chain died on the first background frame and never
     restarted, so the currents were frozen for good);
  6. the PROBE (the legend ships a "Probe" button; it used to do
     NOTHING at all);
  7. the ARROWS style (the legend ships the chip; nothing ever read
     state.style, so it changed the button and not the map).

The study drives each one and reads back:
  · is the layer ON?
  · has the grid arrived?
  · are there PARTICLES? (a layer that is on but has no particles is
    the failure the owner saw)
  · is the canvas actually drawing?
  · does the animation ADVANCE (the ink changes between two frames)?

Run:  python3 scripts/ocean_current_audit.py
      python3 scripts/ocean_current_audit.py --browser firefox
"""
import argparse
import json
import sys

from playwright.sync_api import sync_playwright

FLAT = "https://xyzo.org/"
LINK = ("https://xyzo.org/#17.3926,9.1406,3/density=max/"
        "overlay=koppen@20,wind-gfs@100,ocean-currents-live@100,isobars@100")


def probe(pg):
    return pg.evaluate(r"""
      () => {
        const L = window.OceanCurrentLayer;
        if (!L) return { err: "no layer" };
        const st = L._state;
        const c = document.querySelector("canvas.xyzo-ocean-current");
        let lit = 0;
        if (c) {
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 4 * 53) if (d[i] > 0) lit++;
        }
        return {
          enabled: !!st.enabled,
          hasGrid: !!st.grid,
          particles: st.particles ? st.particles.length : -1,
          canvas: !!c,
          lit,
          raf: st.raf,
        };
      }
    """)


def click_toggle(pg):
    pg.evaluate(r"""
      () => {
        const labels = [...document.querySelectorAll('.leaflet-control-layers-list label')];
        const hit = labels.find(l => (l.textContent || '').includes('Ocean currents'));
        const cb = hit && hit.querySelector('input[type=checkbox]');
        if (cb && !cb.checked) cb.click();
      }
    """)


def hide_tab(pg, hidden):
    """Pretend the tab went to the background (and came back).

    `document.hidden` is overridden and `visibilitychange` is
    dispatched — which is exactly what a browser does when the reader
    switches tabs. Firefox KEEPS FIRING requestAnimationFrame in a
    background tab (throttled to ~1 Hz) where Chrome suspends it, so
    this is the path that only Firefox took.
    """
    pg.evaluate(
        """(hidden) => {
          Object.defineProperty(document, 'hidden',
            { get: () => hidden, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        }""",
        hidden,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--browser", default="chromium",
                    choices=["chromium", "firefox", "webkit"],
                    help="which engine to drive (default: chromium)")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    pw = sync_playwright().start()
    b = getattr(pw, args.browser).launch(headless=not args.headed)
    ctx = b.new_context(viewport={"width": 1280, "height": 860})
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text[:110]}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:110]))

    print(f"===== {args.browser} =====")

    print("== 1. the DEFAULT load ==")
    # The Earth-portrait preset used to switch the currents ON before
    # the grid had even been fetched, and this scenario checked that
    # they came up alive. Since 2026-11-08 the preset is the owner's own
    # 15-overlay map, which does NOT carry the currents — they are a
    # 2014 altimetry field the README calls "NOT live", so a showcase
    # map has no business opening on them. The layer is therefore OFF
    # on a default load, and this scenario now says so: the honest
    # check is that the page opens WITHOUT them and without an error.
    # (Scenario 3 is the one that switches them on — from the same
    # default load, by clicking the checkbox.)
    pg.goto(FLAT, wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(12000)
    a = probe(pg)
    pg.wait_for_timeout(2500)
    b2 = probe(pg)
    print("   ", json.dumps(a))
    print("    2.5 s later:", json.dumps(b2))
    print("    OFF BY DEFAULT (as it must be):", not a.get("enabled"))
    print("    NO ERRORS:", not errs)

    print("\n== 2. a LINK with the layer on ==")
    # A FRESH PAGE, and that is the whole point of this scenario.
    #
    # `pg.goto(FLAT)` followed by `pg.goto(LINK)` is a HASH-ONLY
    # navigation — the same document, so the boot path does NOT run
    # again and the app's own `hashchange` handler only moves the
    # camera (it cannot re-apply the overlay list, because the app
    # rewrites the hash on every move). So until 2026-11-08 this
    # scenario was a FALSE PASS: the currents it found were the ones
    # the DEFAULT MAP had switched on (the old Earth-portrait preset
    # carried `ocean-currents-live@100`), not the link's.
    #
    # A reader opens a shared link in a new tab — a REAL navigation.
    # That is what this scenario now measures.
    pg2 = ctx.new_page()
    pg2.on("console", lambda m: errs.append(f"{m.type}: {m.text[:110]}")
           if m.type == "error" else None)
    pg2.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:110]))
    pg2.goto(LINK, wait_until="domcontentloaded", timeout=90000)
    pg2.wait_for_timeout(12000)
    a = probe(pg2)
    pg2.wait_for_timeout(2500)
    b2 = probe(pg2)
    print("   ", json.dumps(a))
    print("    2.5 s later:", json.dumps(b2))
    print("    ADVANCING:", a.get("particles", 0) > 0 and b2.get("lit", 0) != a.get("lit", 0))
    print("    THE LINK ITSELF SWITCHED IT ON:", a.get("enabled"))
    pg2.close()

    print("\n== 3. a CLICK on the checkbox ==")
    pg.goto(FLAT, wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(9000)
    click_toggle(pg)
    pg.wait_for_timeout(9000)
    a = probe(pg)
    pg.wait_for_timeout(2500)
    b2 = probe(pg)
    print("   ", json.dumps(a))
    print("    2.5 s later:", json.dumps(b2))
    print("    ADVANCING:", a.get("particles", 0) > 0 and b2.get("lit", 0) != a.get("lit", 0))

    print("\n== 4. after a PAN ==")
    pg.evaluate("() => { const m = window._xyzoMap; m.setView([10, 20], 4, { animate: false }); }")
    pg.wait_for_timeout(4000)
    a = probe(pg)
    print("   ", json.dumps(a))
    print("    STILL RUNNING:", a.get("enabled") and a.get("particles", 0) > 0)

    print("\n== 5. the TAB GOES TO THE BACKGROUND and comes back ==")
    # The Firefox bug: the frame chain died on the first background
    # frame and nothing ever restarted it.
    before = probe(pg)
    hide_tab(pg, True)
    pg.wait_for_timeout(2500)
    hidden = probe(pg)
    hide_tab(pg, False)
    pg.wait_for_timeout(1500)
    back1 = probe(pg)
    pg.wait_for_timeout(2500)
    back2 = probe(pg)
    print("    before hiding :", json.dumps(before))
    print("    while hidden  :", json.dumps(hidden))
    print("    back, +1.5 s  :", json.dumps(back1))
    print("    back, +4 s    :", json.dumps(back2))
    # "RESUMED" is the chain being ALIVE, not the pixel count moving.
    # The old check compared only `lit`, a coarse sample of lit pixels:
    # with the trails fading, two samples 2.5 s apart can agree
    # exactly, so the tool printed "RESUMED: False" while the chain
    # was demonstrably running (a new frame was armed, and the
    # particle count had moved). The chain is alive when a frame is
    # PENDING and something is still moving.
    alive = (
        back2.get("raf", 0) != 0
        and (
            back2.get("lit") != back1.get("lit")
            or back2.get("particles") != back1.get("particles")
        )
    )
    print("    RESUMED:", alive,
          "(a frame is pending and the field is still moving)")
    print("    THE CHAIN WAS DEAD WHILE HIDDEN:", hidden.get("raf", 0) == 0)

    print("\n== 6. the PROBE ==")
    pg.evaluate(r"""
      () => {
        const btn = document.getElementById('ctrl-oc-probe-toggle');
        if (btn && !btn.classList.contains('active')) btn.click();
      }
    """)
    pg.wait_for_timeout(600)
    # Move the pointer over the MAP — not over a floating panel, which
    # would swallow the event before Leaflet ever saw it. Several
    # candidate points are tried because the panels move.
    pr = {}
    for x, y in [(760, 180), (900, 300), (640, 460), (1000, 700), (520, 120)]:
        pg.mouse.move(x, y)
        pg.wait_for_timeout(200)
        pg.mouse.move(x + 12, y + 12)
        pg.wait_for_timeout(400)
        pr = pg.evaluate(r"""
          () => {
            const el = document.querySelector('.ocean-current-probe');
            return {
              exists: !!el,
              shown: !!(el && el.style.display === 'block'),
              text: el ? el.textContent : '',
              armed: !!(window.OceanCurrentLayer._state.probeMode),
              blocksClick: window.OceanCurrentLayer.blocksClick(),
            };
          }
        """)
        if pr.get("shown"):
            break
    print("   ", json.dumps(pr))
    print("    THE PROBE READS:", pr.get("shown") and bool(pr.get("text")))

    print("\n== 7. the ARROWS style ==")
    pg.evaluate(r"""
      () => {
        const btn = document.querySelector('#ocean-current-legend .oc-style-btn[data-style="arrows"]');
        if (btn) btn.click();
      }
    """)
    pg.wait_for_timeout(2500)
    ar = probe(pg)
    ar2 = pg.evaluate("() => window.OceanCurrentLayer.getStyle()")
    print("   ", json.dumps(ar), "style:", ar2)
    print("    THE ARROWS STYLE IS LIVE:", ar2 == "arrows" and ar.get("lit", 0) > 0)

    print("\n== 8. the LEGEND tells the truth ==")
    # The field's provenance must be VISIBLE where the reader looks:
    # the composite's own date, how old it is, and the note that
    # explains why the currents stop short of the coast. A legend
    # that says "live" over a 2014 field is the failure this checks.
    lg = pg.evaluate(r"""
      () => {
        const host = document.getElementById('ocean-current-legend');
        if (!host) return { err: 'no legend' };
        const date = host.querySelector('.oc-legend-date');
        const note = host.querySelector('.oc-legend-note');
        const title = host.querySelector('.oc-legend-title span');
        const labels = [...document.querySelectorAll('.leaflet-control-layers-list label')]
          .map(l => (l.textContent || '').trim());
        return {
          title: title ? title.textContent : null,
          date: date ? date.textContent : null,
          stale: date ? date.classList.contains('is-stale') : null,
          note: note ? note.textContent : null,
          checkbox: labels.find(t => t.includes('Ocean currents')) || null,
        };
      }
    """)
    print("   ", json.dumps(lg, ensure_ascii=False))
    print("    THE LEGEND SHOWS THE DATE:", bool(lg.get("date")))
    print("    THE STALE FIELD IS FLAGGED:", lg.get("stale") is True)
    print("    THE COASTAL CAVEAT IS SHOWN:",
          bool(lg.get("note")) and "coast" in (lg.get("note") or "").lower())
    print("    THE NAME DOES NOT CLAIM TO BE LIVE:",
          "live" not in (lg.get("checkbox") or "").lower())

    print("\nconsole errors:", errs[:6])
    ctx.close()
    b.close()
    pw.stop()


if __name__ == "__main__":
    main()
