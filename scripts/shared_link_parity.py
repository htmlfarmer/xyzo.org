"""Playwright round-trip audit: does a SHARED LINK survive 2D -> 3D -> 2D?

Run: python3 scripts/shared_link_parity.py [--hash '#…'] [--shots DIR] [--json]

`globe_handoff_check.py` proves the mechanism with ONE hand-picked pair of
overlays. This audits a WHOLE link — every overlay segment and every
setting segment — and reports, bucket by bucket, what reached the globe
and what came home again:

  * overlays that the globe CAN show but the handoff failed to translate
    (a vocabulary mismatch: the flat map writes `wind-gfs`, the globe
    keys it `wind`) — a silent drop, the worst kind;
  * overlays the globe deliberately does not port (NOT_PORTED, read from
    panel-parity.bun.test.js so the two cannot drift);
  * setting segments the globe does not own (`density=`, `wind=`,
    `rivers=`, `time=`, `base=`, `search=`, `pin=`) — the globe cannot
    honour them, but it must not DESTROY them either, or "Back to the
    map" hands the reader their own link back with the style stripped.

Exit code 0 only when nothing that could have survived was lost.
"""
import argparse
import json
import os
import re
import sys
from playwright.sync_api import sync_playwright

BASE = "https://xyzo.org"
OWNER_HASH = (
    "#72.3024,12.6563,4/density=max/"
    "overlay=wind-gfs@100,basins@100,population-density-worldpop-1-km@45,"
    "koppen@30,cropland-esa@50,land-cover-esa@35,soil-type-hwsd-v2-2@25,"
    "soil-soilgrids@15,ocean-currents-live@100,nasa-rain@30,"
    "rivers-fao-2026@100,geology-macrostrat@25,rivers@100,"
    "wind-speed-gfs@30,isobars@100/"
    "iso=0.1:pressure/isoSrc=gfs/wind=particles:speed/rivers=medium"
)

# The setting segments neither view's globe writer produces. They are
# listed here so the audit can tell "the globe dropped a SETTING" apart
# from "the globe dropped an OVERLAY" — both are losses, but they are
# fixed in different places.
FLAT_ONLY_SETTINGS = ("density", "wind", "rivers", "time", "base", "search", "pin")


def split_hash(h):
    h = (h or "").lstrip("#")
    parts = h.split("/")
    out = {"head": parts[0], "parts": parts[1:]}
    return out


def overlay_entries(h):
    for p in split_hash(h)["parts"]:
        if p.startswith("overlay="):
            return [e for e in p[8:].split(",") if e]
    return []


def part(h, prefix):
    for p in split_hash(h)["parts"]:
        if p.startswith(prefix):
            return p[len(prefix):]
    return None


def read_not_ported():
    """The labels the globe deliberately does not port, from the test."""
    path = os.path.join(os.path.dirname(__file__), "..",
                        "public_html", "tests", "panel-parity.bun.test.js")
    src = open(path, encoding="utf8").read()
    block = src[src.index("const NOT_PORTED = {"):src.index("};", src.index("const NOT_PORTED = {"))]
    return re.findall(r'"([^"]+)":\s*\n?\s*"', block)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hash", default=OWNER_HASH)
    ap.add_argument("--shots", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)

    lost_globe, lost_back, notes = [], [], []
    report = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True,
                                  viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ── 1. the flat map, at the shared link ─────────────────────────
        print("\n1) FLAT MAP at the shared link")
        page.goto(BASE + "/" + args.hash, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        page.wait_for_timeout(9000)

        flat0 = page.evaluate("""() => {
          const m = window._xyzoMap;
          const c = m.getCenter();
          return {
            hash: typeof getMapHash === 'function' ? getMapHash() : location.hash,
            lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), zoom: +m.getZoom(),
          };
        }""")
        if not flat0 or not flat0.get("hash"):
            print("  FAIL  flat map did not expose getMapHash()")
            browser.close()
            return 1
        print(f"  ok    position {flat0['lat']},{flat0['lng']} z{flat0['zoom']}")
        print(f"        hash = {flat0['hash']}")
        if args.shots:
            page.screenshot(path=os.path.join(args.shots, "parity-flat-1.png"))

        requested = overlay_entries(args.hash)
        print(f"        {len(requested)} overlays requested")

        # which of those does the globe actually OFFER? Read the labels
        # the globe cannot port out of the parity test, then ask the LIVE
        # flat map for their slugs (one implementation, no drift).
        not_ported_slugs = set()
        for label in read_not_ported():
            slug = page.evaluate("(n) => window.__xyzoLayerSlug ? window.__xyzoLayerSlug(n) : null", label)
            if slug:
                not_ported_slugs.add(slug)
        print(f"        {len(not_ported_slugs)} overlays are NOT_PORTED by design")

        # ── 2. the globe href, built the way a click builds it ─────────
        href = page.evaluate("""() => {
          const a = document.querySelector('a[aria-label="Open the 3D globe"]')
                 || document.querySelector('.leaflet-control-zoom-world[title="Open the 3D globe"]');
          if (!a) return null;
          a.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
          a.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
          return a.getAttribute('href');
        }""")
        print(f"\n2) GLOBE HREF = {href}")
        if not href:
            print("  FAIL  no globe button")
            browser.close()
            return 1

        # Classify each requested overlay: translate it through the LIVE
        # handoff (so this measures the shipped code, not a copy of it).
        # The verdict is drawn at step 3, against what the globe turned ON.
        resolved = page.evaluate(
            """(keys) => keys.map(k => window.XYZO_HANDOFF
                 ? (window.XYZO_HANDOFF.FLAT_TO_GLOBE[k] || k) : k)""",
            [e.split("@")[0] for e in requested])
        print(f"        handoff translated to: {','.join(resolved)}")

        # ── 3. open the globe ───────────────────────────────────────────
        print(f"\n3) GLOBE at {href}")
        page.goto(BASE + href, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window.__globeMap !== undefined", timeout=60000)
        page.wait_for_timeout(9000)

        globe = page.evaluate("""() => {
          const m = window.__globeMap;
          const c = m.getCenter();
          const ov = {};
          document.querySelectorAll('input[type=checkbox][data-key]').forEach(b => {
            const k = b.dataset.key;
            const sl = document.querySelector(`.globe-ov-opacity[data-key="${k}"]`);
            ov[k] = { on: b.checked, pct: sl ? Number(sl.value) : null };
          });
          return { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4),
                   zoom: +m.getZoom(), overlays: ov, hash: location.hash };
        }""")
        on = {k for k, v in globe["overlays"].items() if v["on"]}
        print(f"  ok    position {globe['lat']},{globe['lng']} z{globe['zoom']}")
        print(f"        globe hash = {globe['hash']}")
        print(f"        layers ON  = {sorted(on)}")

        # ── did each requested overlay actually make it onto the globe? ─
        # Compared against what the globe TURNED ON, never against the
        # href: an untranslated key passes straight through the href and
        # is then dropped by the globe's `if (!st) continue`, so checking
        # the href reports a healthy transfer for a layer that never
        # appeared. That is how the first version of this audit said
        # "0 lost" while three were missing.
        lost_globe, notes = [], []
        for key, tgt in zip([e.split("@")[0] for e in requested], resolved):
            if tgt in on:
                if key != tgt:
                    notes.append(f"renamed for the globe: {key} -> {tgt}")
                pct = dict((e.split("@")[0], e.split("@")[1])
                           for e in requested if "@" in e).get(key)
                got = globe["overlays"][tgt]["pct"]
                if pct is not None and got is not None and int(pct) != got:
                    lost_globe.append(f"{key}: opacity {pct} -> {got} on the globe")
                continue
            if key in not_ported_slugs:
                notes.append(f"not ported (by design): {key}")
            else:
                lost_globe.append(f"{key} -> {tgt}: never enabled on the globe")
        for n in notes:
            print(f"  note  {n}")
        if lost_globe:
            print("  LOST  overlays the globe could draw but did not:")
            for k in lost_globe:
                print(f"          {k}")
        else:
            print("  ok    every portable overlay is ON, at the link's opacity")
        if args.shots:
            page.screenshot(path=os.path.join(args.shots, "parity-globe.png"))

        # the globe must not invent layers nobody asked for
        asked_targets = set(resolved)
        invented = sorted(k for k in on if k not in asked_targets)
        if invented:
            lost_back.append(f"globe enabled layers the link never asked for: {invented}")

        # position must match
        if abs(globe["lat"] - flat0["lat"]) > 0.05 or abs(globe["lng"] - flat0["lng"]) > 0.05:
            lost_back.append(
                f"position moved: {globe['lat']},{globe['lng']} != {flat0['lat']},{flat0['lng']}")

        # isobar settings must match the link
        want_step = part(args.hash, "iso=")
        got_iso = part(globe["hash"], "iso=")
        if want_step and got_iso and want_step.split(":")[0] != got_iso.split(":")[0]:
            lost_back.append(f"isobar step: link {want_step} vs globe {got_iso}")
        want_src = part(args.hash, "isoSrc=")
        got_src = part(globe["hash"], "isoSrc=")
        if want_src and got_src and want_src != got_src:
            lost_back.append(f"isobar source: link {want_src} vs globe {got_src}")
        print(f"        iso={got_iso} isoSrc={got_src}")

        # ── 4. back to the map ──────────────────────────────────────────
        back = page.evaluate("""() => {
          const a = document.querySelector('.globe-back');
          return a ? a.getAttribute('href') : null;
        }""")
        print(f"\n4) BACK HREF = {back}")
        if not back:
            print("  FAIL  no back link")
            browser.close()
            return 1

        # what the back link still carries
        back_overlays = set(e.split("@")[0] for e in overlay_entries(back))
        for e in requested:
            k = e.split("@")[0]
            tgt = resolved[[x.split("@")[0] for x in requested].index(k)]
            if tgt in back_overlays or k in back_overlays:
                continue
            if k in not_ported_slugs:
                lost_back.append(f"overlay lost on the way home (not portable): {k}")
            else:
                lost_back.append(f"overlay lost on the way home: {k}")

        for s in FLAT_ONLY_SETTINGS:
            before = part(args.hash, s + "=")
            after = part(back, s + "=")
            if before and before != after:
                lost_back.append(f"setting `{s}={before}` -> `{after}`")

        print("\n5) FLAT MAP restored from the back link")
        page.goto(BASE + back, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("window._xyzoMap !== undefined", timeout=60000)
        page.wait_for_timeout(9000)
        flat1 = page.evaluate("""() => {
          const m = window._xyzoMap; const c = m.getCenter();
          return { hash: typeof getMapHash === 'function' ? getMapHash() : location.hash,
                   lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4) };
        }""")
        print(f"        hash = {flat1['hash']}")
        if args.shots:
            page.screenshot(path=os.path.join(args.shots, "parity-flat-2.png"))

        report = {
            "requested_overlays": requested,
            "lost_on_globe": lost_globe,
            "lost_on_return": lost_back,
            "notes": notes,
            "globe_hash": globe.get("hash"),
            "back_hash": back,
            "flat0": flat0.get("hash"),
            "flat1": flat1.get("hash"),
            "page_errors": errors[:8],
        }
        browser.close()

    print("\n" + "=" * 72)
    print(f"lost reaching the globe : {len(lost_globe)}")
    for k in lost_globe:
        print(f"   - {k}")
    print(f"lost coming home        : {len(lost_back)}")
    for k in lost_back:
        print(f"   - {k}")
    if errors:
        print("page errors:")
        for e in errors[:6]:
            print("   ", str(e)[:180])

    if args.json:
        print(json.dumps(report, indent=2))

    return 0 if not lost_globe and not lost_back else 1


if __name__ == "__main__":
    sys.exit(main())
