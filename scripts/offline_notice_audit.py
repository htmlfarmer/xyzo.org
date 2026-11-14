"""
The "Map imagery isn't loading" notice — and its X.

The owner asked: *"can we have a way to X out this message its getting in
the way"*. The notice is a NOTICE, not a blocker — nothing on the page
depends on it — and it sits across the TOP of the map, so it is in the
way of the very thing it is talking about.

This script forces the condition the notice reports (the basemap host
unreachable), checks that the notice appears, clicks the X, and checks
that it STAYS gone — including on the next failed tile batch, because
the watcher fires on every batch and a dismissed banner that came back
ten seconds later would be worse than no button at all.

Run:  python3 scripts/offline_notice_audit.py
"""
import sys

from playwright.sync_api import sync_playwright

URL = "https://xyzo.org/#2,10,4"

PROBE = r"""
() => {
  const el = document.getElementById("xyzo-offline-banner");
  const btn = el ? el.querySelector(".xyzo-notice-dismiss") : null;
  const r = btn ? btn.getBoundingClientRect() : null;
  return {
    present: !!el,
    text: el ? (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90) : null,
    hasButton: !!btn,
    buttonBox: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
    buttonLabel: btn ? btn.getAttribute("aria-label") : null,
    dismissed: (() => { try { return sessionStorage.getItem("xyzo.offlineNoticeDismissed") === "1"; } catch (e) { return null; } })(),
  };
}
"""


def main():
    pw = sync_playwright().start()
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 860})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:140]))

    # The basemap host cannot be reached: that is the condition the
    # notice reports.
    #
    # THE ROUTE MUST BE ON THE CONTEXT, NOT THE PAGE. The service
    # worker takes control of the page (clients.claim) and serves the
    # tiles ITSELF — and a request made BY the worker does not go
    # through a page route, so it reached the real network, the tiles
    # LOADED, and the page saw only four failures instead of the twenty
    # that a real outage produces. Four is below the watcher's
    # threshold of eight, so the notice never appeared and the audit
    # reported "no button" for a notice that was working perfectly.
    import re
    BLOCK = re.compile(r"/tile/|MapServer/tile")

    def handler(route):
        if BLOCK.search(route.request.url):
            route.abort()
        else:
            route.continue_()

    ctx.route("**/*", handler)

    pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_timeout(3000)

    # The watcher needs a BATCH of failures before it speaks (eight
    # failures, and more failures than successes). The first view only
    # asks for a handful of tiles, so ZOOM IN: that forces a full new
    # tile set, and a real outage fails all of them.
    pg.evaluate("() => { const m = window._xyzoMap; if (m) m.setZoom(m.getZoom() + 3, { animate: false }); }")
    pg.wait_for_timeout(2500)
    pg.evaluate("() => { const m = window._xyzoMap; if (m) m.setZoom(m.getZoom() - 2, { animate: false }); }")
    pg.wait_for_timeout(4000)

    print("== the notice ==")
    print("  ", pg.evaluate(PROBE))

    btn = pg.query_selector(".xyzo-notice-dismiss")
    if btn:
        btn.click()
        pg.wait_for_timeout(1200)
        print("== after the X ==")
        print("  ", pg.evaluate(PROBE))

        # It must STAY gone: the watcher fires on every failed batch.
        pg.evaluate("() => { const m = window._xyzoMap; if (m) m.setZoom(m.getZoom() + 2, { animate: false }); }")
        pg.wait_for_timeout(3000)
        pg.evaluate("() => { const m = window._xyzoMap; if (m) m.setZoom(m.getZoom() - 1, { animate: false }); }")
        pg.wait_for_timeout(3000)
        print("== after more failed tiles ==")
        print("  ", pg.evaluate(PROBE))
    else:
        print("  NO BUTTON — the notice did not appear at all")

    print("page errors:", errs[:4])
    ctx.close()
    b.close()
    pw.stop()


if __name__ == "__main__":
    main()
