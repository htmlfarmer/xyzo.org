#!/usr/bin/env python3
"""search_mobile_audit.py — after a search ON A PHONE, does a tapped result
open a popup that is fully on screen, still, and closable?

WHY THIS SCRIPT EXISTS
----------------------
Every other Playwright script in scripts/ drives a DESKTOP viewport
(1280–1440 px). The phone is where the map is actually used, and the phone
is where the popups broke:

  * a tap used to open the popup SYNCHRONOUSLY (Leaflet's own
    `click → _openPopup` handler), so the popup appeared 0–100 ms INTO the
    700 ms `flyToBounds` that `maybeZoomToCluster()` starts for any pin with
    ≥3 neighbours within 30 km — which, after a search, is nearly every pin;
  * `keepPopupOnScreen()` only ran at `popupopen`, i.e. DURING the flight,
    and nothing re-framed the popup once the flight landed;
  * `#search-status` (the line that says "412 stories in Chicago") is
    `position: fixed; bottom: 58px` and only exists after a search — and the
    framing pass did not reserve it, so the popup could land on top of it;
  * the mobile "Details ▸" button emitted `.popup-details-full` while the
    wiring looked for `.popup-details-content`, so the keywords / related
    stories / locations / reports sections were unreachable on a phone.

THE MEASUREMENTS (one verdict per line, non-zero exit on any failure)
----------------------------------------------------------------------
  1. a `.leaflet-popup` exists after the tap
  2. its bounding box is fully inside the viewport
  3. the ✕ Close button is inside the viewport
  4. tapping the ✕ actually closes the popup
  5. the popup is STILL 1.5 s after the tap (it is not riding a flight)
  6. no page errors and no console errors

Run:  python3 scripts/search_mobile_audit.py [--query chicago] [--headed]
"""
import argparse
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"

# A real phone: iPhone 14 Pro-ish. `is_mobile` + `has_touch` change the
# pointer type, so `pointer: coarse` matches and the app takes its touch
# code paths (the 600 ms settle fallback, the mobile popup branch).
PHONE = {"width": 393, "height": 852}

# Find a pin a finger can actually reach.
#
# `window.__xyzoExportPins()` gives the raw (true-position) pins, but the
# canvas SPREADS overlapping pins apart, so a raw position is not always
# where a marker is drawn. The DOM markers ARE what a finger hits, so they
# are the candidates; `document.elementFromPoint()` is the reachability
# test — it answers "is this point the pin, or is it under the layers
# dropdown / the bottom bar / the live panel?".
CANDIDATES_JS = r"""
() => {
  const out = [];
  const w = window.innerWidth, h = window.innerHeight;
  const seen = new Set();
  const push = (x, y, title, id) => {
    const key = x + ":" + y;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x: Math.round(x), y: Math.round(y), title: title || null, id: id ?? null });
  };
  // 1. the DOM markers — the thing under a finger.
  for (const el of document.querySelectorAll('.leaflet-marker-icon.xyzo-pin')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 6 || y < 6 || x > w - 6 || y > h - 6) continue;
    const hit = document.elementFromPoint(Math.round(x), Math.round(y));
    if (!hit) continue;
    if (!(hit === el || el.contains(hit))) continue;   // something is on top
    if (hit.closest('.pin-dismiss')) continue;          // the per-pin ✕
    push(x, y, el.getAttribute('title'), el.dataset.pinId);
    if (out.length >= 12) break;
  }
  // 2. the canvas pins, via the exporter's raw list.
  if (!out.length && window.__xyzoExportPins) {
    const map = window._xyzoMap;
    const pins = window.__xyzoExportPins() || [];
    for (const p of pins) {
      const lat = p.location?.lat ?? p.lat, lng = p.location?.lng ?? p.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      const c = map.latLngToContainerPoint([lat, lng]);
      const x = Math.round(c.x), y = Math.round(c.y);
      if (x < 6 || y < 6 || x > w - 6 || y > h - 6) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !hit.classList.contains('xyzo-canvas-pins')) continue;
      push(x, y, p.title, p.id);
      if (out.length >= 12) break;
    }
  }
  return out;
}
"""

# The popup's box, in viewport coordinates.
POPUP_BOX_JS = r"""
() => {
  const els = [...document.querySelectorAll('.leaflet-popup')];
  const el = els.find(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).opacity !== '0';
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const close = el.querySelector('.popup-close-btn, .popup-close-btn-mobile');
  const cr = close ? close.getBoundingClientRect() : null;
  return {
    left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    w: r.width, h: r.height,
    vw: window.innerWidth, vh: window.innerHeight,
    close: cr ? { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom,
                  w: cr.width, h: cr.height } : null,
    closeLabel: close ? (close.textContent || '').trim() : null,
    detailsBtn: !!el.querySelector('.popup-details-btn'),
    detailsContent: !!el.querySelector('.popup-details-content, .popup-details-full'),
  };
}
"""


def in_viewport(box, viewport=None, pad=0.0):
    """Is `box` fully inside the viewport? `viewport` is (w, h)."""
    if not box:
        return False
    vw, vh = viewport if viewport else (box.get("vw"), box.get("vh"))
    if vw is None or vh is None:
        return False
    return (box["left"] >= pad and box["top"] >= pad
            and box["right"] <= vw + pad
            and box["bottom"] <= vh + pad)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="chicago")
    ap.add_argument("--url", default=BASE)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--shot", default=None, help="write a PNG here")
    ap.add_argument("--settle-ms", type=int, default=1500,
                    help="how long after the tap the popup must be STILL")
    args = ap.parse_args()

    failures = []
    page_errors = []
    console_errors = []

    def ok(name, cond, detail=""):
        print(("  PASS  " if cond else "  FAIL  ") + name + ("  — " + detail if detail else ""))
        if not cond:
            failures.append(name)

    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=not args.headed)
        ctx = b.new_context(
            ignore_https_errors=True,
            viewport=PHONE,
            is_mobile=True,
            has_touch=True,
            device_scale_factor=3,
        )
        page = ctx.new_page()
        page.on("pageerror", lambda e: page_errors.append(str(e) + "\n" + (getattr(e, "stack", "") or "")))
        page.on("console", lambda m: console_errors.append(m.text)
                if m.type == "error" else None)

        print(f"== phone {PHONE['width']}x{PHONE['height']} · search {args.query!r} ==")
        page.goto(args.url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        page.wait_for_timeout(5000)

        # ── the search ────────────────────────────────────────────────────
        page.fill("#search-input", args.query)
        page.tap("#search-btn")
        # The event search spawns a worker and can take a minute; the pin
        # query is the fast one. Wait for the STATUS LINE to carry a
        # RESULT — "Searching "chicago"…" is already text, so waiting for
        # non-empty text would tap into a search that has not answered.
        try:
            page.wait_for_function(
                """() => {
                     const s = document.querySelector('#search-status');
                     if (!s) return false;
                     const t = (s.textContent || '').trim();
                     return t.length > 0 && !/^Searching/i.test(t);
                   }""",
                timeout=120000)
        except Exception:
            pass
        page.wait_for_timeout(4000)

        status = page.evaluate(
            "() => (document.querySelector('#search-status')||{}).textContent || ''")
        print("  status line:", (status or "").strip()[:120])
        pins_on_map = page.evaluate(
            "() => document.querySelectorAll('.leaflet-marker-icon.xyzo-pin').length")
        print("  DOM pins on the map:", pins_on_map)

        cands = page.evaluate(CANDIDATES_JS)
        print("  reachable pins:", len(cands))
        if not cands:
            print("  FAIL  no reachable pin to tap — the search painted nothing tappable")
            failures.append("a pin is reachable after the search")
            if args.shot:
                page.screenshot(path=args.shot)
            ctx.close()
            b.close()
            return 1
        target = cands[0]
        print("  tapping:", json.dumps(target)[:140])

        # ── the tap ──────────────────────────────────────────────────────
        page.touchscreen.tap(target["x"], target["y"])

        # Watch the popup's box while it opens and settles. A popup that
        # rides a flight MOVES; a settled one does not.
        samples = []
        deadline = 1800
        step = 100
        waited = 0
        while waited <= deadline:
            box = page.evaluate(POPUP_BOX_JS)
            if box:
                samples.append((waited, box))
            page.wait_for_timeout(step)
            waited += step

        if not samples:
            ok("a popup exists after the tap", False, "no .leaflet-popup at all")
        else:
            ok("a popup exists after the tap", True,
               f"{len(samples)} samples, first at t={samples[0][0]} ms")

        # 2. fully inside the viewport
        if samples:
            last = samples[-1][1]
            ok("the popup is fully inside the viewport", in_viewport(last),
               "box=%.0f,%.0f → %.0f,%.0f  viewport=%dx%d"
               % (last["left"], last["top"], last["right"], last["bottom"],
                  last["vw"], last["vh"]))
            # 3. the ✕ is on screen
            ok("the ✕ Close button is inside the viewport",
               bool(last["close"]) and in_viewport(last["close"], (last["vw"], last["vh"])),
               (("close=%.0f,%.0f → %.0f,%.0f" % (last["close"]["left"], last["close"]["top"],
                                                  last["close"]["right"], last["close"]["bottom"]))
                if last["close"] else "no ✕ button in the popup"))
            # 5. STILL
            moved = 0.0
            for i in range(1, len(samples)):
                a, b2 = samples[i - 1][1], samples[i][1]
                moved = max(moved, abs(a["left"] - b2["left"]), abs(a["top"] - b2["top"]))
            still_at = None
            for t, box in samples:
                if t >= args.settle_ms:
                    still_at = box
                    break
            ok(f"the popup is still {args.settle_ms} ms after the tap", moved <= 2.0,
               "max movement %.1f px over the window" % moved)
            if still_at:
                ok("the popup is still inside the viewport at the end",
                   in_viewport(still_at),
                   "box=%.0f,%.0f → %.0f,%.0f" % (still_at["left"], still_at["top"],
                                                  still_at["right"], still_at["bottom"]))
            # the mobile Details button must reach its content
            ok("the mobile Details button has its content block",
               bool(last["detailsBtn"]) and bool(last["detailsContent"]),
               "btn=%s content=%s" % (last["detailsBtn"], last["detailsContent"]))

            # 4. the ✕ closes the popup
            close = last["close"]
            if close and in_viewport(close, (last["vw"], last["vh"])):
                page.touchscreen.tap(int(close["left"] + close["w"] / 2),
                                     int(close["top"] + close["h"] / 2))
                page.wait_for_timeout(900)
                gone = page.evaluate(
                    """() => ![...document.querySelectorAll('.leaflet-popup')]
                              .some(e => { const r = e.getBoundingClientRect();
                                           return r.width > 0 && r.height > 0; })""")
                ok("tapping the ✕ closes the popup", gone)
            else:
                ok("tapping the ✕ closes the popup", False,
                   "the ✕ was not reachable, so it could not be tapped")

        # ── errors ───────────────────────────────────────────────────────
        real_console = [e for e in console_errors
                        if "favicon" not in e.lower()
                        and "Failed to load resource" not in e]
        ok("no page errors", not page_errors, "; ".join(page_errors[:3]))
        ok("no console errors", not real_console, "; ".join(real_console[:3]))

        if args.shot:
            page.screenshot(path=args.shot)
        ctx.close()
        b.close()

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
