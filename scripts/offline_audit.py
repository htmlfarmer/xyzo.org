"""How ready are we for offline? Measure it, do not guess.

Three phases, because they fail differently — and the blocking has to
happen at DNS level (`--host-resolver-rules`), NOT with `page.route`:
once a service worker exists, its fetches never reach `page.route` at
all, so a route-based "offline" test would silently measure nothing.

  0. ONLINE       — the normal visit. Installs the service worker and
                    warms its caches. This is the visit that makes any
                    of the later phases possible.
  1. WAN DOWN     — xyzo.org resolves, every other host does not. This
                    is the realistic "some link went bad" case: the API
                    and local assets are fine, external tiles are not.
  2. FULLY OFFLINE— xyzo.org itself does not resolve. The document has
                    to come out of the service worker's cached shell.

All three run in ONE persistent profile (launch_persistent_context):
`chromium.launch()` hands out a fresh temp profile each call, so the
service worker installed in phase 0 would not exist in phase 1 and the
test would measure a cold browser three times.

A page that "loads" but shows an unstyled 0x0 map is not ready, so each
phase reports the container size, the completed tiles and the API.
"""
import shutil
import sys
import tempfile

from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org/"

# Everything except xyzo.org dies in phase 1. `EXCLUDE` is what keeps
# the origin itself (and localhost) resolving.
BLOCK_ALL_BUT_ORIGIN = (
    "MAP * 127.0.0.1:1, EXCLUDE xyzo.org, EXCLUDE localhost, EXCLUDE 127.0.0.1"
)
# In phase 2 even xyzo.org is gone — only the service worker can answer.
BLOCK_EVERYTHING = "MAP * 127.0.0.1:1, EXCLUDE localhost, EXCLUDE 127.0.0.1"

PROBE = """() => {
  const map = window._xyzoMap;
  const container = document.getElementById('map');
  const tiles = [...document.querySelectorAll('.leaflet-tile-pane img')];
  return {
    booted: !!map,
    online: navigator.onLine,
    container: container ? container.offsetWidth + 'x' + container.offsetHeight : 'none',
    zoom: map ? map.getZoom() : null,
    tiles: tiles.length,
    tilesComplete: tiles.filter(i => i.complete && i.naturalWidth > 0).length,
    // A tile that finished with no bytes is a FAILED load, not a slow one
    // — without this the audit cannot tell "still loading" from "errored",
    // which is the difference between the tile notice firing and not.
    tilesErrored: tiles.filter(i => i.complete && i.naturalWidth === 0).length,
    scripts: document.querySelectorAll('script[src*="?v="]').length,
    offlineBanner: !!document.getElementById('xyzo-offline-banner'),
    apiBanner: !!document.getElementById('api-down-banner'),
    bannerText: ((document.getElementById('xyzo-offline-banner') ||
                  document.getElementById('api-down-banner')) || {}).textContent || '',
  };
}"""

SW_PROBE = """async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return 'NOT REGISTERED';
  let counts = {};
  if (typeof caches !== 'undefined') {
    for (const k of await caches.keys()) {
      const n = await (await caches.open(k)).keys();
      counts[k.replace('xyzo-offline-v1-', '')] = n.length;
    }
  }
  return `active=${!!reg.active} installing=${!!reg.installing} waiting=${!!reg.waiting} ` +
         `caches=${JSON.stringify(counts)}`;
}"""

API_PROBE = """async () => {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    return 'HTTP ' + r.status;
  } catch (e) { return 'FAILED (' + e.message + ')'; }
}"""


def run_phase(ctx, label, shot=None, set_offline=False):
    page = ctx.new_page()
    errors = []
    logs = []
    page.on("pageerror", lambda e: errors.append(str(e)[:160]))
    # Surface XLog so offline.js's own account of what it did is visible;
    # the banner being absent is otherwise indistinguishable from the
    # banner never having been considered.
    page.add_init_script("window.XYZO_DEBUG = true;")
    page.on("console", lambda m: logs.append(m.text[:200]) if "[offline]" in m.text else None)

    nav_failed = None
    try:
        page.goto(BASE, wait_until="domcontentloaded", timeout=45000)
    except Exception as exc:
        # Phase 2 can legitimately fail if the SW has nothing to serve —
        # that IS the result, not a script bug.
        nav_failed = f"{type(exc).__name__}: {str(exc)[:120]}"

    # Applied AFTER the document exists: measured, set_offline is a no-op
    # before a page has navigated (navigator.onLine stayed True) and
    # flips to False when set afterwards. The navigation itself is
    # already offline in phase 2 — DNS is blocked — so this only makes
    # the browser SAY so, which is what the honest banner reads.
    if set_offline and not nav_failed:
        ctx.set_offline(True)

    page.wait_for_timeout(9000)

    if nav_failed:
        print(f"   navigation FAILED: {nav_failed}")
        page.close()
        return {"booted": False, "note": nav_failed}

    state = page.evaluate(PROBE)
    api = page.evaluate(API_PROBE)
    sw = page.evaluate(SW_PROBE)

    if shot:
        try:
            page.screenshot(path=shot)
        except Exception:
            pass

    print(f"   booted          : {state['booted']}")
    print(f"   navigator.onLine: {state['online']}")
    print(f"   map container   : {state['container']}  zoom={state['zoom']}")
    print(f"   basemap tiles   : {state['tilesComplete']}/{state['tiles']} complete, "
          f"{state['tilesErrored']} errored")
    print(f"   local scripts   : {state['scripts']}")
    print(f"   service worker  : {sw}")
    print(f"   /api/health     : {api}")
    print(f"   banners         : offline={state['offlineBanner']} api={state['apiBanner']}")
    if state["bannerText"]:
        print(f"   banner text     : {state['bannerText'][:110]!r}")
    if logs:
        print(f"   offline.js log  : {logs[-3:]}")
    if errors:
        print(f"   page errors     : {errors[:3]}")

    page.close()
    return dict(state, sw=sw, api=api)


def phase(p, profile, rules, heading, shot=None, set_offline=False):
    print()
    print("=" * 68)
    print(heading)
    print("=" * 68)
    args = [f"--host-resolver-rules={rules}"] if rules else []
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=profile,
        headless=True,
        ignore_https_errors=True,
        viewport={"width": 1280, "height": 800},
        service_workers="allow",
        args=args,
    )
    try:
        # DNS blocking alone does NOT flip navigator.onLine — the browser
        # still believes the network is up, so the honest banner would
        # never be exercised by a resolver rule. set_offline() emulates a
        # genuinely dropped link; it is applied inside run_phase, after
        # the page exists, because before that it is silently a no-op.
        out = run_phase(ctx, heading, shot, set_offline=set_offline)
    finally:
        ctx.close()
    return out


def main():
    profile = tempfile.mkdtemp(prefix="xyzo-offline-")
    with sync_playwright() as p:
        a = phase(p, profile, None,
                  "PHASE 0 — online: install the service worker, warm its caches",
                  "/tmp/opencode/offline-0-online.png")
        b = phase(p, profile, BLOCK_ALL_BUT_ORIGIN,
                  "PHASE 1 — WAN down: xyzo.org resolves, no other host does",
                  "/tmp/opencode/offline-1-wan.png")
        c = phase(p, profile, BLOCK_EVERYTHING,
                  "PHASE 2 — fully offline: xyzo.org itself does not resolve",
                  "/tmp/opencode/offline-2-offline.png",
                  set_offline=True)

    shutil.rmtree(profile, ignore_errors=True)

    print()
    print("=" * 68)
    print("VERDICT")
    print("=" * 68)
    print(f"  online  : boot={a.get('booted')} tiles={a.get('tilesComplete')}/{a.get('tiles')} "
          f"api={a.get('api')}")
    print(f"  wan down: boot={b.get('booted')} tiles={b.get('tilesComplete')}/{b.get('tiles')} "
          f"({b.get('tilesErrored')} errored) api={b.get('api')} "
          f"tileNotice={b.get('offlineBanner')}")
    if b.get("bannerText"):
        print(f"           text: {b['bannerText'][:95]!r}")
    print(f"  offline : boot={c.get('booted')} tiles={c.get('tilesComplete')}/{c.get('tiles')} "
          f"api={c.get('api')} offlineBanner={c.get('offlineBanner')} note={c.get('note')}")
    if c.get("bannerText"):
        print(f"           text: {c['bannerText'][:95]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
