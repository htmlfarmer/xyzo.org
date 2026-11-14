#!/usr/bin/env python3
"""live_panel_audit.py — the live feed's panel: the tab strip, the "AI
Suggested" tab behind it, and the tour that must NOT appear.

WHY THIS SCRIPT EXISTS
----------------------
Owner report (2026-11-13): *"when the live feed pops up.. the Ai
suggested isn't really showing correctly its all smooshed"*.

TWO SEPARATE DEFECTS WERE BEHIND THAT ONE SENTENCE, and only a browser
can see either of them:

  1. THE TAB STRIP WAS SQUEEZED. Five tabs in a 320 px panel, one flex
     row: each tab got ~58 px, so "🤖 AI Suggested" broke into FOUR lines
     and the strip OVERFLOWED the panel by 14 px — the last tab was cut
     off at the panel's edge. Measured on the shipped page: the strip's
     content was 300 px wide in a 285.8 px box.

  2. THE TAB NEVER LOADED. It asked the pins LIST endpoint for
     `min_confidence=0.85` with NO time window, and that query's
     articles leg has no time predicate — so the plan was a sequential
     scan of the 17 GB `news_articles` table behind a window function.
     MEASURED: the query was still running after THIRTEEN MINUTES (four
     copies of it, each reading 17 GB), and the tab said "Loading AI
     Suggestions…" for the whole of that time.

A SOURCE-SHAPE TEST PASSES AGAINST BROKEN CODE, so the gate that
matters is BEHAVIOURAL: this script drives the SHIPPED page and measures
what the reader sees.

THE MEASUREMENTS (one verdict per line, non-zero exit on any failure)
----------------------------------------------------------------------
  A. the tour does NOT open itself on a first visit
  B. every tab label is on ONE line (no four-line "AI Suggested")
  C. the tab strip does not overflow the panel, and every tab is inside it
  D. the "AI Suggested" tab shows real cards, and says WHERE they are
  E. the "AI Suggested" tab answers (it used to never answer at all)
  F. the 🛰️ default-map button puts the OWNER'S map on the screen:
     the base layer is the satellite one, the wind and the pressure
     lines are on, and the URL says the same map

It runs on a DESKTOP and on a PHONE (393×852, `is_mobile` +
`has_touch`, so `pointer: coarse` matches and the app takes its touch
paths) — the phone is where the panel is a sheet and the labels are
squeezed the most — and at the LARGEST text size (A++), where the
header's content box is 290/1.3 = 223 px and a half-column no longer
fits a label.

Run:  python3 scripts/live_panel_audit.py [--headed] [--keep-open]
"""
import argparse
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"

# The owner's default map (2026-11-13) — the one the 🛰️ button restores.
DEFAULT_HASH = "#1.9771,36.1230,4/density=max/overlay=wind-gfs@100,isobars@100/iso=1:pressure/isoSrc=gfs/wind=particles:speed:100"

DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 393, "height": 852}

failures = []


def check(ok, label, detail=""):
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)
    return ok


def open_live_panel(page):
    """The panel starts collapsed (both control windows do). Open it."""
    try:
        page.click("#live-panel-reopen", timeout=8000)
    except Exception:
        page.evaluate(
            "document.getElementById('live-panel')?.classList.remove('collapsed')")
    page.wait_for_timeout(1200)


def measure_strip(page):
    return page.evaluate("""() => {
      const strip = document.querySelector('.live-panel-tabs');
      const panel = document.getElementById('live-panel');
      const pr = panel.getBoundingClientRect();
      const sr = strip.getBoundingClientRect();
      const tabs = [...document.querySelectorAll('.live-panel-tab')].map(t => {
        const r = t.getBoundingClientRect();
        // THE TEXT'S OWN LINE BOXES. A Range over the label's contents
        // yields one client rect PER LINE, so a wrapped label is
        // counted directly — no guessing at line-height, which the
        // panel's --ui-zoom makes unmeasurable from CSS alone.
        const range = document.createRange();
        range.selectNodeContents(t);
        const rects = [...range.getClientRects()].filter(x => x.height > 0 && x.width > 0);
        return {
          tab: t.dataset.tab,
          text: t.textContent.trim(),
          h: Math.round(r.height),
          lines: Math.max(1, rects.length),
          left: Math.round(r.left),
          right: Math.round(r.right),
          cut: t.scrollWidth > t.clientWidth + 1,
        };
      });
      return {
        stripW: Math.round(sr.width),
        stripScrollW: strip.scrollWidth,
        panelLeft: Math.round(pr.left),
        panelRight: Math.round(pr.right),
        tabs,
      };
    }""")


def check_strip(page, tag):
    m = measure_strip(page)
    for t in m["tabs"]:
        check(t["lines"] <= 1,
              f"B[{tag}]. the tab {t['tab']!r} is on ONE line",
              f"{t['text']!r} → {t['lines']} lines, {t['h']} px")
        check(not t["cut"],
              f"B2[{tag}]. the tab {t['tab']!r} is not cut off",
              f"scroll {t['right'] - t['left']} px")
    overflow = m["stripScrollW"] - m["stripW"]
    check(overflow <= 1,
          f"C[{tag}]. the tab strip does not overflow the panel",
          f"content {m['stripScrollW']} px in a {m['stripW']} px box")
    for t in m["tabs"]:
        check(t["right"] <= m["panelRight"] + 1 and t["left"] >= m["panelLeft"] - 1,
              f"C2[{tag}]. the tab {t['tab']!r} is inside the panel",
              f"{t['left']}…{t['right']} vs panel {m['panelLeft']}…{m['panelRight']}")


def check_ai_tab(page, tag):
    page.click('.live-panel-tab[data-tab="neural"]', timeout=8000)
    t0 = time.time()
    deadline = t0 + 30
    cards = 0
    while time.time() < deadline:
        cards = page.evaluate(
            "() => document.querySelectorAll('#live-panel-list .live-item').length")
        if cards:
            break
        page.wait_for_timeout(400)
    elapsed = time.time() - t0
    check(cards > 0,
          f"D[{tag}]. the AI Suggested tab shows cards",
          f"{cards} cards in {elapsed:.1f}s")
    check(elapsed < 30,
          f"E[{tag}]. the AI Suggested tab answers",
          f"{elapsed:.1f}s")
    if cards:
        with_place = page.evaluate("""() => {
          const items = [...document.querySelectorAll('#live-panel-list .live-item')];
          const metas = items.map(it => it.querySelector('.live-item-meta')?.innerText || '');
          // A place reads "Jakarta, ID" — a word and a two-letter code.
          return {
            withPlace: metas.filter(m => /[A-Za-z][A-Za-z .'-]+, ?[A-Z]{2}\\b/.test(m)).length,
            total: items.length,
            first: (metas[0] || '').replace(/\\n/g, ' | '),
          };
        }""")
        check(with_place["withPlace"] > 0,
              f"D2[{tag}]. an AI card says WHERE the story is",
              f"{with_place['withPlace']}/{with_place['total']} cards carry a place"
              f" — {with_place['first'][:60]!r}")


def check_default_map(page, tag):
    # The bar button is hidden below 560 px (the bar has no room on a
    # phone), so a phone reader uses the ⚙ menu's row instead. Both
    # paths must land on the same map.
    bar_visible = page.evaluate("""() => {
      const b = document.getElementById('default-map-btn');
      if (!b) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.right <= window.innerWidth + 1;
    }""")
    try:
        if bar_visible:
            page.click("#default-map-btn", timeout=8000)
        else:
            page.click("#control-menu-btn", timeout=8000)
            page.wait_for_timeout(700)
            page.click("#ctrl-default-map-btn", timeout=8000)
        page.wait_for_timeout(2500)
    except Exception as e:
        check(False, f"F[{tag}]. the default-map button works", str(e)[:90])
        return
    state = page.evaluate("""() => ({ hash: location.hash })""")
    check("wind-gfs" in state["hash"] and "isobars" in state["hash"],
          f"F[{tag}]. the default-map button puts the wind and the pressure lines on",
          state["hash"][:110])
    check("1.9771" in state["hash"] and "36.123" in state["hash"],
          f"F2[{tag}]. the default-map button goes to the owner's view",
          state["hash"][:60])
    check(state["hash"].startswith(DEFAULT_HASH[:28]),
          f"F3[{tag}]. the URL says the same map the button drew",
          state["hash"][:80])
    base = page.evaluate("""() => {
      const m = window._xyzoMap;
      if (!m) return null;
      const names = [];
      for (const k in m._layers) {
        const l = m._layers[k];
        if (l && l._url && /satellite|esri/i.test(String(l._url))) names.push(String(l._url).slice(0, 60));
      }
      return names;
    }""")
    check(bool(base), f"F4[{tag}]. the base layer is the satellite one",
          (base or ["(not found)"])[0])


def check_bottom_bar(page, tag):
    """Every bottom-bar button must be ON SCREEN and hit-testable.

    THE TRAP: the bar is a fixed row of 44 px touch targets plus a
    157 px language switcher, so a phone's 393 px of width is nearly
    full. The LAST item in the bar — the ⚙, and with it the whole
    control menu — hangs off the right edge if anything is added, and a
    button that is off the screen is a button that does not exist.
    """
    rows = page.evaluate("""() => {
      const bar = document.getElementById('bottom-bar');
      const out = [];
      for (const el of bar.querySelectorAll('button')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;   // hidden buttons (e.g. #show-all-btn)
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                             Math.round(r.top + r.height / 2));
        out.push({
          id: el.id || el.className,
          left: Math.round(r.left), right: Math.round(r.right),
          onScreen: r.left >= -1 && r.right <= window.innerWidth + 1,
          onTop: hit ? (hit === el || el.contains(hit)) : false,
        });
      }
      return {w: window.innerWidth, rows: out};
    }""")
    for r in rows["rows"]:
        check(r["onScreen"],
              f"H[{tag}]. the bar button {r['id'][:24]!r} is ON the screen",
              f"{r['left']}…{r['right']} in {rows['w']}")
        check(r["onTop"],
              f"H2[{tag}]. the bar button {r['id'][:24]!r} can be tapped",
              f"hit test at its centre")


def run_profile(browser, tag, viewport, is_mobile=False, text_size=None):
    print(f"\n── {tag} ──")
    ctx = browser.new_context(viewport=viewport, is_mobile=is_mobile,
                              has_touch=is_mobile,
                              device_scale_factor=2 if is_mobile else 1)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)

    if text_size:
        page.evaluate("(c) => document.documentElement.classList.add(c)", text_size)
        page.wait_for_timeout(300)

    # ── A. THE TOUR MUST NOT OPEN ITSELF ─────────────────────────────
    tour_open = page.evaluate(
        "() => document.body.getAttribute('data-tour-open') === '1'")
    check(not tour_open,
          f"A[{tag}]. the tour does not open itself on a first visit",
          "no tour card" if not tour_open else "the tour card was there")
    has_btn = page.evaluate("() => !!document.getElementById('ctrl-tour-btn')")
    check(has_btn, f"A2[{tag}]. ⚙ → TOOLS → 'How to' is still there")

    # …and it still OPENS the tour. The tour no longer shows itself, so
    # the button is the only way in — if it broke, the tour would be
    # gone from the site entirely.
    try:
        page.click("#control-menu-btn", timeout=8000)
        page.wait_for_timeout(700)
        page.click("#ctrl-tour-btn", timeout=8000)
        page.wait_for_timeout(1500)
        tour_shown = page.evaluate(
            "() => document.body.getAttribute('data-tour-open') === '1'")
        check(tour_shown, f"A3[{tag}]. ⚙ → TOOLS → 'How to' opens the tour")
        # …and it closes again.
        page.evaluate("() => window.XYZO_TOUR && window.XYZO_TOUR.stop()")
        page.wait_for_timeout(500)
    except Exception as e:
        check(False, f"A3[{tag}]. ⚙ → TOOLS → 'How to' opens the tour", str(e)[:90])

    open_live_panel(page)
    check_bottom_bar(page, tag)
    check_strip(page, tag)
    check_ai_tab(page, tag)
    check_default_map(page, tag)
    check(not errors, f"G[{tag}]. no page errors",
          "; ".join(errors[:3]) if errors else "none")
    ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--keep-open", action="store_true")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        print("live_panel_audit — the live feed panel")
        run_profile(browser, "desktop", DESKTOP)
        run_profile(browser, "phone", PHONE, is_mobile=True)
        run_profile(browser, "desktop A++", DESKTOP, text_size="ts-130")
        if args.keep_open:
            input("press enter to close…")
        browser.close()

    print()
    if failures:
        print(f"FAILED {len(failures)} check(s): " + "; ".join(failures))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
