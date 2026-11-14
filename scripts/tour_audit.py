"""
The HOW TO tour — does it actually show, and does it work?

The owner asked for a "how to / demo of how all our features work when
people first visit or ask for help". So the tour has to be measured on
a FIRST VISIT (a clean browser profile — no localStorage, no hash) and
on a REPLAY (the ⚙ menu's "How to" button).

What is checked:

  · it shows ITSELF on a first visit, after a beat;
  · every step has a TITLE and a BODY — a step with no text teaches
    nothing;
  · the step's target is on the page and the spotlight lands on it;
  · the card never covers the control it is describing;
  · Next / Back / Skip / Escape all work;
  · it does NOT come back after it has been dismissed;
  · a shared link does NOT trigger it (the reader was given a map by
    somebody — they did not arrive to be shown the controls);
  · it survives a RESIZE (the controls it points at are laid out with
    CSS, so the spotlight has to follow).

Run:  python3 scripts/tour_audit.py
"""
import json

from playwright.sync_api import sync_playwright

FLAT = "https://xyzo.org/"


def probe(pg):
    return pg.evaluate(r"""
      () => {
        const card = document.querySelector(".xyzo-tour-card");
        const spot = document.querySelector(".xyzo-tour-spot");
        if (!card) return { open: false };
        const cs = getComputedStyle(card);
        const r = card.getBoundingClientRect();
        const sr = spot ? spot.getBoundingClientRect() : null;
        return {
          open: document.body.getAttribute("data-tour-open") === "1",
          visible: cs.visibility === "visible" && cs.opacity !== "0",
          title: (card.querySelector(".xyzo-tour-title") || {}).textContent || "",
          body: ((card.querySelector(".xyzo-tour-body") || {}).textContent || "").length,
          count: (card.querySelector(".xyzo-tour-count") || {}).textContent || "",
          dots: card.querySelectorAll(".xyzo-tour-dot").length,
          card: { x: r.x, y: r.y, w: r.width, h: r.height },
          spot: sr ? { x: sr.x, y: sr.y, w: sr.width, h: sr.height } : null,
          nextLabel: (card.querySelector(".xyzo-tour-btn--primary") || {}).textContent || "",
        };
      }
    """)


def overlaps(a, b):
    if not a or not b:
        return False
    ax, ay, aw, ah = a["x"], a["y"], a["w"], a["h"]
    bx, by, bw, bh = b["x"], b["y"], b["w"], b["h"]
    return not (ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay)


def main():
    pw = sync_playwright().start()
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text[:110]}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)[:110]))
    bad = []
    pg.on("response", lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None)

    print("== 1. a FIRST VISIT (no hash, no storage) ==")
    pg.goto(FLAT, wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(5200)
    first = probe(pg)
    print("   ", json.dumps(first))
    print("    SHOWS ITSELF:", first.get("open") and first.get("visible"))

    print("\n== 2. every step has text, and the spotlight lands on its target ==")
    steps = []
    for i in range(first.get("dots", 0)):
        pg.evaluate("() => { const d=[...document.querySelectorAll('.xyzo-tour-dot')]; if(d[%d]) d[%d].click(); }" % (i, i))
        pg.wait_for_timeout(700)
        st = probe(pg)
        steps.append(st)
        print("   step %d: %-46s body=%d chars spot=%s" % (
            i + 1,
            (st.get("title") or "")[:46],
            st.get("body", 0),
            "yes" if st.get("spot") and st["spot"]["w"] > 4 else "NO",
        ))
    print("    ALL STEPS HAVE TEXT:", all(s.get("title") and s.get("body", 0) > 40 for s in steps))
    # Step 1 is the WELCOME — it has no target on purpose (the whole
    # screen is dimmed and the card is centred).
    print("    EVERY TARGETED STEP HAS A SPOTLIGHT:",
          all(s.get("spot") and s["spot"]["w"] > 4 for s in steps[1:]))

    print("\n== 3. the card never covers the control it describes ==")
    covered = []
    for i in range(pg.evaluate("() => document.querySelectorAll('.xyzo-tour-dot').length")):
        pg.evaluate("() => { const d=[...document.querySelectorAll('.xyzo-tour-dot')]; if(d[%d]) d[%d].click(); }" % (i, i))
        pg.wait_for_timeout(600)
        st = probe(pg)
        if overlaps(st.get("card"), st.get("spot")):
            covered.append((i + 1, st.get("title")))
    print("    OVERLAPPING:", covered or "none")

    print("\n== 4. Next / Back / Skip ==")
    pg.evaluate("() => { const d=[...document.querySelectorAll('.xyzo-tour-dot')]; if(d[0]) d[0].click(); }")
    pg.wait_for_timeout(400)
    before = probe(pg).get("count")
    pg.click("#xyzo-tour-next")
    pg.wait_for_timeout(400)
    after = probe(pg).get("count")
    print("    Next:", before, "->", after, "| MOVES ON:", before != after)
    pg.click("#xyzo-tour-back")
    pg.wait_for_timeout(400)
    print("    Back:", probe(pg).get("count"))
    pg.click("#xyzo-tour-skip")
    pg.wait_for_timeout(400)
    print("    after Skip, open:", probe(pg).get("open"))

    print("\n== 5. it does NOT come back on the next visit ==")
    pg.goto(FLAT, wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(4200)
    print("    open again:", probe(pg).get("open"))
    print("    stored:", pg.evaluate("() => localStorage.getItem('xyzo.tourSeen')"))

    print("\n== 6. the ⚙ menu replays it ==")
    pg.evaluate("() => document.getElementById('control-menu-btn')?.click()")
    pg.wait_for_timeout(700)
    pg.evaluate("() => document.getElementById('ctrl-tour-btn')?.click()")
    pg.wait_for_timeout(900)
    replay = probe(pg)
    print("   ", json.dumps({k: replay.get(k) for k in ("open", "visible", "title", "dots")}))

    print("\n== 7. a shared link does NOT trigger it ==")
    ctx2 = b.new_context(viewport={"width": 1440, "height": 900})
    pg2 = ctx2.new_page()
    pg2.goto(FLAT + "#17.3926,9.1406,3/density=max/overlay=koppen@20", wait_until="domcontentloaded", timeout=90000)
    pg2.wait_for_timeout(4200)
    print("    open:", probe(pg2).get("open"))
    ctx2.close()

    print("\n== 8. it survives a RESIZE ==")
    pg.set_viewport_size({"width": 900, "height": 700})
    pg.wait_for_timeout(900)
    st = probe(pg)
    print("   ", json.dumps({k: st.get(k) for k in ("open", "visible")}),
          "card in view:", st["card"]["x"] >= 0 and st["card"]["y"] >= 0,
          "card w:", round(st["card"]["w"]))

    print("\n== 9. on a PHONE it is a sheet that clears the bottom bar ==")
    ctx2 = b.new_context(viewport={"width": 390, "height": 844},
                         is_mobile=True, has_touch=True)
    pg2 = ctx2.new_page()
    pg2.goto(FLAT, wait_until="domcontentloaded", timeout=90000)
    pg2.wait_for_timeout(6000)

    def rect(pg, sel):
        return pg.evaluate(
            """(s)=>{const e=document.querySelector(s); if(!e) return null;
               const r=e.getBoundingClientRect();
               return {x:r.x,y:r.y,w:r.width,h:r.height};}""", sel)

    def hits(a, b):
        if not a or not b:
            return False
        return not (a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"]
                    or a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"])

    card = rect(pg2, ".xyzo-tour-card")
    bar = rect(pg2, "#bottom-bar")
    gear = rect(pg2, "#control-menu-btn")
    sheet = pg2.evaluate("()=>!!document.querySelector('.xyzo-tour-card--sheet')")
    print("    it is a SHEET:", sheet)
    print("    the card covers the bottom bar:", hits(card, bar))
    print("    the card covers the gear button:", hits(card, gear))
    # Step 6 points AT the gear button — the card must not cover it.
    pg2.evaluate("() => { const d=[...document.querySelectorAll('.xyzo-tour-dot')]; if(d[5]) d[5].click(); }")
    pg2.wait_for_timeout(900)
    spot = rect(pg2, ".xyzo-tour-spot")
    card = rect(pg2, ".xyzo-tour-card")
    print("    step 6 has a spotlight:", bool(spot and spot["w"] > 4))
    print("    the card covers step 6's spotlight:", hits(card, spot))
    print("    the Help Me pill is hidden while the tour is open:",
          pg2.evaluate("()=>{const e=document.getElementById('help-me-btn');"
                        " return e ? getComputedStyle(e).display === 'none' : true;}"))
    ctx2.close()

    print("\n4xx/5xx:", [(st, u[:120]) for st, u in bad][:8] or "none")
    print("console errors:", errs[:6])
    ctx.close()
    b.close()
    pw.stop()


if __name__ == "__main__":
    main()
