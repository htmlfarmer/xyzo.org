"""The pressure CHANGE map's window in the URL — measured on the live site.

Owner ask: *"can you make sure the url is updated when someone clicks on
[the 24 h change button]"*.

The window used to live only in localStorage: the chip changed the map, the
address bar did not move, and the SHARE button copies `location.href`
verbatim — so a reader who switched to the change map and pressed Share
handed over a link to the ORDINARY chart.

This drives the real page in a real browser and checks the four things
that matter:

  1. clicking the chip MOVES the URL (and it says WHICH window);
  2. switching back to the ordinary chart DROPS the segment;
  3. a COLD link carrying `delta=24h` opens on the CHANGE map, and it
     does NOT overwrite the reader's own stored window — a link is a
     VIEW, not a settings change;
  4. the SAME link pasted into an already-open tab (a same-document
     navigation, where the boot-time restore never runs) applies it too.

Run: python3 scripts/isobar_delta_url_check.py
"""
import sys

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"
HASH = "#2.5480,40.4297,3/overlay=isobars@100/iso=0.1:pressure"
LINK = "#2.5480,40.4297,3/overlay=isobars@100/delta=24h"


def hash_of(page):
    return page.evaluate("() => window.location.hash")


def chip_state(page, delta):
    return page.evaluate(
        """(d) => {
            const b = document.querySelector('#isobar-change-switch [data-delta="' + d + '"]');
            const L = window.IsobarLayer;
            const st = L && L._state ? L._state : null;
            return {
                found: !!b,
                active: !!(b && b.classList.contains('is-active')),
                pressed: b ? b.getAttribute('aria-pressed') : null,
                window: st ? st.deltaWindow : null,
                source: st ? st.source : null,
            };
        }""",
        delta,
    )


def wait_for_map(page):
    page.wait_for_function("window._xyzoMap !== undefined", timeout=40000)


def main():
    failures = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
        errs = []

        # ── 1. the chip moves the URL ───────────────────────────────────
        page = ctx.new_page()
        page.on("pageerror", lambda e: errs.append(str(e)[:200]))
        page.goto(BASE + HASH, wait_until="domcontentloaded", timeout=60000)
        wait_for_map(page)
        page.wait_for_timeout(6000)
        before = hash_of(page)
        if "delta=" in before:
            failures.append(f"the URL carried a delta BEFORE any click: {before}")

        page.evaluate("() => document.querySelector('.leaflet-control-layers-toggle')?.click()")
        page.wait_for_timeout(1200)
        found = page.evaluate(
            """() => {
                const b = document.querySelector('#isobar-change-switch [data-delta="24h"]');
                if (!b) return false;
                b.click();
                return true;
            }"""
        )
        if not found:
            failures.append("NO 24h CHIP FOUND")
        else:
            page.wait_for_timeout(2500)
            after = hash_of(page)
            print(f"hash before the click: {before}")
            print(f"hash after  the click: {after}")
            if "delta=24h" not in after:
                failures.append(f"the URL did not carry delta=24h after the click: {after}")
            st = chip_state(page, "24h")
            print(f"chip: {st}")
            if not st["active"]:
                failures.append("the 24 h chip did not become active")
            if st["window"] != "24h":
                failures.append(f"the layer's window is {st['window']!r}, not '24h'")

            # ── 2. switching back DROPS the segment ─────────────────────
            # The ordinary chart is the default and there is exactly one
            # way to spell it, so a segment that says "the default" can
            # only add a way to be wrong.
            page.evaluate(
                """() => {
                    const b = document.querySelector('#isobar-change-switch [data-delta=""]');
                    if (b) b.click();
                }"""
            )
            page.wait_for_timeout(2500)
            back = hash_of(page)
            print(f"hash back on the ordinary chart: {back}")
            if "delta=" in back:
                failures.append(f"the URL still carries a delta on the ordinary chart: {back}")
            st = chip_state(page, "24h")
            if st["active"]:
                failures.append("the 24 h chip is still active on the ordinary chart")

        # ── 3. a COLD link opens on the CHANGE map ─────────────────────
        # The reader's OWN stored window is "7d" before the link opens.
        # After opening a link that says `delta=24h` the MAP must show
        # the 24 h change map (the link is a view) and the STORED window
        # must still be "7d" (a link is not a settings change).
        #
        # A FRESH PAGE, on purpose: a `page.goto()` whose only difference
        # is the hash is a SAME-DOCUMENT navigation — the page does not
        # reload, the boot-time restore never runs, and the hashchange
        # handler does the work instead. Both paths are tested; they are
        # two different tests.
        page.evaluate("() => localStorage.setItem('xyzo.isobarDelta', '7d')")
        cold = ctx.new_page()
        cold.on("pageerror", lambda e: errs.append(str(e)[:200]))
        cold.goto(BASE + LINK, wait_until="domcontentloaded", timeout=60000)
        wait_for_map(cold)
        cold.wait_for_timeout(9000)
        st = chip_state(cold, "24h")
        print(f"a COLD link: {st}")
        if st["window"] != "24h":
            failures.append(f"the cold link's window was not applied: {st['window']!r}")
        if not st["active"]:
            failures.append("the chip row did not follow the window that arrived with no click")
        if st["source"] != "delta":
            failures.append(f"the cold link did not draw the CHANGE map (source={st['source']!r})")
        h = hash_of(cold)
        if "delta=24h" not in h:
            failures.append(f"the URL lost the window it was opened with: {h}")
        stored = cold.evaluate("() => localStorage.getItem('xyzo.isobarDelta')")
        print(f"stored window after opening someone else's link: {stored!r}")
        if stored != "7d":
            failures.append(f"opening a link OVERWROTE the reader's own stored window ({stored!r})")

        # ── 4. the SAME link pasted into an OPEN tab ───────────────────
        # A pasted link is a same-document navigation: the boot-time
        # restore never runs, so the hashchange handler is the only thing
        # that can apply it. Without that the address bar would promise
        # a picture the map is not drawing.
        warm = ctx.new_page()
        warm.on("pageerror", lambda e: errs.append(str(e)[:200]))
        warm.goto(BASE + HASH, wait_until="domcontentloaded", timeout=60000)
        wait_for_map(warm)
        warm.wait_for_timeout(6000)
        warm.evaluate(
            """() => {
                const b = document.querySelector('#isobar-change-switch [data-delta="24h"]');
                if (b) b.click();
            }"""
        )
        warm.wait_for_timeout(2500)
        # Back to the ordinary chart, then paste a link that asks for the
        # 24 h change map.
        warm.evaluate(
            """() => {
                const b = document.querySelector('#isobar-change-switch [data-delta=""]');
                if (b) b.click();
            }"""
        )
        warm.wait_for_timeout(2000)
        warm.evaluate("(h) => { window.location.hash = h; }", LINK)
        warm.wait_for_timeout(4000)
        st = chip_state(warm, "24h")
        print(f"a PASTED link into an open tab: {st}")
        if st["window"] != "24h":
            failures.append(f"the pasted link's window was not applied: {st['window']!r}")
        if not st["active"]:
            failures.append("the chip row did not follow the pasted window")

        if errs:
            failures.append(f"page errors: {errs[:3]}")
        b.close()

    if failures:
        print("\nFAIL")
        for f in failures:
            print("  -", f)
        return 1
    print("\nOK — the URL follows the change window, and a link restores it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
