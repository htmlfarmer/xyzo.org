#!/usr/bin/env python3
"""
Measure how fast the wind marks actually MOVE, and what the page costs.

WHAT THIS IS FOR
----------------
The owner's report (2026-11-14): *"the wind dots don't move around very
fast on Firefox"* on a specific shared link with fifteen overlays on.
"Slow" is three different defects and they need three different numbers:

  * **choppy**   — few frames per second (main thread or raster is
                   saturated). The dots jump between frames.
  * **crawling** — the dots genuinely cover less ground per second.
                   `step()` caps dt at 0.1 s, so below 10 fps the
                   display time itself is lost and the animation runs
                   slower than real time.
  * **thin**     — the FPS guard shed the pool (`qscale` 1 → 0.4) and
                   there are a third as many dots as the link asked for.

So the headline numbers this tool produces are:

  fps / frame p50 / p95 / worst   — how choppy
  dots_px_per_s (median)          — how fast the dots travel ON SCREEN
                                    (the perceptual number; ~69 px/s is
                                    what the layer targets at 60 fps)
  long tasks / main busy %        — what is stealing the frames
  particles / quality             — what the guard did to the pool
  canvases, panes, overlays       — the page's own weight

METHOD
------
One fresh browser context per browser, one page load per run, then a
SWEEP of densities inside that same page (`WindLayer.setDensity()`),
because re-loading fifteen overlays to change one slider would measure
the network four times and the slider never.

Dot speed is measured as the MEDIAN displacement of the live particle
pool over short (500 ms) windows. The median, not the mean: a particle
respawns (teleports) every ~1.3–3 s, so a fraction of any sample is a
jump across the map, and the mean would report those as "speed".

Headless Firefox and Chromium both rasterise on the CPU here, so the
ABSOLUTE numbers are worse than a GPU laptop's — but the Firefox-vs-
Chromium ratio and every trend (density 100 → 50 → 25, wind on vs off)
are real, and that is what this tool exists to compare.

Usage:
  python3 scripts/wind_perf_audit.py
  python3 scripts/wind_perf_audit.py --browsers firefox
  python3 scripts/wind_perf_audit.py --densities 100,50,25 --seconds 8
  python3 scripts/wind_perf_audit.py --wind off --densities ''        # page only
  python3 scripts/wind_perf_audit.py --url 'https://xyzo.org/#...' --json reports/wind_perf.json
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The owner's own test case (2026-11-14): fifteen overlays, particles,
# world view. This is the URL every number in the README row for this
# session was measured on.
DEFAULT_URL = (
    "https://xyzo.org/#2.1089,16.8750,3/density=max/"
    "overlay=wind-gfs@100,basins@100,koppen@100,soil-soilgrids@65,"
    "rivers@100,cropland-esa@50,population-density-worldpop-1-km@25,"
    "land-cover-esa@60,soil-type-hwsd-v2-2@30,wind-speed-gfs@30,"
    "tectonic-faults-usgs@100,nasa-rain@30,etopo@85,isobars@100/"
    "iso=0.25:pressure/isoSrc=gfs/wind=particles:speed:100"
)

# The URL with the wind overlay stripped — the SAME page with nothing
# animating, which is the only honest baseline for "what does the wind
# cost": a baseline that shares the wind's pixels subtracts the very
# thing being measured.
def url_without_wind(url: str) -> str:
    parts = url.split("overlay=", 1)
    if len(parts) != 2:
        return url
    head, rest = parts
    tail_sep = rest.find("/")
    if tail_sep < 0:
        return head + "overlay="
    names, after = rest[:tail_sep], rest[tail_sep + 1:]
    keep = [n for n in names.split(",") if not n.startswith("wind-gfs")]
    return head + "overlay=" + ",".join(keep) + "/" + after


# ── what runs INSIDE the page ───────────────────────────────────────────
#
# Returns a plain object; Python does the statistics. Kept as one
# evaluate() so the window is measured contiguously rather than as a
# series of round-trips.
MEASURE_JS = """
({ seconds, windowMs }) => new Promise((resolve) => {
  const out = { errors: [] };
  const W = window.WindLayer;
  const map = window._xyzoMap;
  try {
    out.env = {
      ua: navigator.userAgent,
      hw: navigator.hardwareConcurrency || null,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      deviceMemory: navigator.deviceMemory || null,
      hash: location.hash.slice(0, 400),
      overlayCount: (function () {
        var m = /(?:^|\\/)overlay=([^/]*)/.exec(location.hash);
        return m && m[1] ? m[1].split(",").filter(Boolean).length : 0;
      })(),
      panes: document.querySelectorAll(".leaflet-pane").length,
      canvases: (function () {
        var list = document.querySelectorAll("canvas"), px = 0;
        for (var i = 0; i < list.length; i++) px += list[i].width * list[i].height;
        return { count: list.length, px: px };
      })(),
    };
  } catch (e) { out.errors.push("env:" + e.message); }

  const snapWind = () => {
    if (!W || !W._stats) return null;
    const s = W._stats();
    const st = (W._state)
      ? (typeof W._state === "function" ? W._state() : W._state) : {};
    return {
      enabled: s.enabled, particles: s.particles, fps: s.fps,
      quality: s.quality, loaded: s.loaded, style: st.style || null,
      density: st.density || null, qscale: st.qscale || null,
    };
  };
  out.windStart = snapWind();

  // ── rAF cadence ─────────────────────────────────────────────────────
  const frames = [];
  const longTasks = [];
  let obs = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (e) { out.errors.push("longtask:" + e.message); }

  // ── dot speed: median displacement over short windows ───────────────
  // Particles respawn (teleport) every ~1.3–3 s, so a long window is
  // mostly jumps. Short windows + a median keep the respawn tail out.
  // `_state` is the state OBJECT (not a function) — accept either shape
  // so this tool cannot die on the property-vs-function mismatch.
  const st0 = () => (W && W._state)
    ? (typeof W._state === "function" ? W._state() : W._state) : null;
  const samples = [];   // each: { t, xy: Float64Array [x0,y0, x1,y1, ...] }
  const sampleEvery = windowMs;
  const grab = () => {
    const st = st0();
    if (!W || !st || !st.particles || !map) { samples.push(null); return; }
    const ps = st.particles;
    const a = new Float64Array(ps.length * 2);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      let cp;
      try { cp = map.latLngToContainerPoint([p.lat, p.lng]); } catch (_) { cp = null; }
      a[i * 2] = cp ? cp.x : NaN;
      a[i * 2 + 1] = cp ? cp.y : NaN;
    }
    samples.push({ t: performance.now(), xy: a });
  };

  const t0 = performance.now();
  grab();
  const sampler = setInterval(grab, sampleEvery);
  let last = t0;
  function tick(t) {
    frames.push(t - last);
    last = t;
    if (t - t0 < seconds * 1000) requestAnimationFrame(tick);
    else {
      clearInterval(sampler);
      if (obs) { try { obs.disconnect(); } catch (_) {} }
      finish(performance.now());
    }
  }
  requestAnimationFrame(tick);

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function pct(arr, p) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function finish(t1) {
    const wall = (t1 - t0) / 1000;
    out.cadence = {
      frames: frames.length,
      seconds: +wall.toFixed(2),
      fps: +(frames.length / wall).toFixed(1),
      p50_ms: +median(frames).toFixed(1),
      p95_ms: +pct(frames, 0.95).toFixed(1),
      worst_ms: +Math.max.apply(null, frames).toFixed(1),
      // Frames slower than 100 ms are where step()'s dt cap starts to
      // LOSE display time — the dots then move slower than real time.
      over_100ms: frames.filter((f) => f > 100).length,
      over_50ms: frames.filter((f) => f > 50).length,
    };
    const lt = longTasks;
    out.longTasks = {
      count: lt.length,
      total_ms: Math.round(lt.reduce((a, b) => a + b, 0)),
      p95_ms: lt.length ? Math.round(pct(lt, 0.95)) : 0,
      worst_ms: lt.length ? Math.round(Math.max.apply(null, lt)) : 0,
      busy_pct: +((lt.reduce((a, b) => a + b, 0) / 1000) / wall * 100).toFixed(1),
    };

    // Dot speed from consecutive position samples.
    const speeds = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (!a || !b) continue;
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0) continue;
      const A = a.xy, B = b.xy;
      for (let k = 0; k < A.length / 2; k++) {
        const dx = B[k * 2] - A[k * 2], dy = B[k * 2 + 1] - A[k * 2 + 1];
        if (!isFinite(dx) || !isFinite(dy)) continue;
        const d = Math.hypot(dx, dy);
        // > 150 px in half a second is a respawn (teleport) or an
        // off-screen recycle, not motion.
        if (d > 150) continue;
        speeds.push(d / dt);
      }
    }
    out.dotSpeed = {
      windows: Math.max(0, samples.length - 1),
      samples: speeds.length,
      p50_px_per_s: speeds.length ? +median(speeds).toFixed(1) : null,
      p90_px_per_s: speeds.length ? +pct(speeds, 0.9).toFixed(1) : null,
    };

    out.windEnd = snapWind();
    resolve(out);
  }
})
"""


def percentile(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(p * len(s)))]


# ── the pixel check ─────────────────────────────────────────────────────
#
# "How many wind pixels are ON SCREEN?" — the question an fps number
# cannot answer, and the one that matters most: a renderer that draws
# nothing is the fastest renderer there is.
#
# Method: screenshot the page, hide ONLY the wind pane, screenshot
# again, and count the pixels that changed. Those pixels are the wind's
# contribution to the screen by construction. Isolating by hide/show
# rather than reading the canvas is deliberate — `getImageData` reads
# the BACKING STORE, which keeps its ink while a clipping ancestor
# hides it, and that is precisely how an invisible wind was reported as
# healthy ("the canvas ink is unchanged").
def _screen_pixels_for_wind(page, threshold=18):
    """Pixels on screen that belong to the wind pane. 0 == invisible."""
    import io as _io

    import numpy as np
    from PIL import Image

    pane = """() => [...document.querySelectorAll('.leaflet-pane')]
        .find(x => /wind/i.test(x.className) && !/windSpeed/i.test(x.className))"""

    def snap():
        return np.asarray(
            Image.open(_io.BytesIO(page.screenshot())).convert("RGB")
        ).astype("int16")

    if not page.evaluate("() => !!(%s)" % pane):
        return None
    page.wait_for_timeout(400)
    shown = snap()
    page.evaluate("() => { const p = %s; if (p) p.style.display = 'none'; }" % pane)
    page.wait_for_timeout(600)
    hidden = snap()
    page.evaluate("() => { const p = %s; if (p) p.style.display = ''; }" % pane)
    page.wait_for_timeout(300)
    diff = np.abs(shown - hidden).max(axis=2)
    return int((diff > threshold).sum())


def pixel_gate(report):
    """Refuse to publish an fps win that drew nothing.

    Returns (ok, message). A run whose wind pane contributes zero
    screen pixels is a broken renderer, whatever its fps says — and it
    is exactly the run that would otherwise be quoted as a triumph.
    """
    for name, rep in report.get("browsers", {}).items():
        if "error" in rep:
            continue
        for r in rep.get("runs", []):
            px = r.get("wind_screen_px")
            if px is None:
                continue
            if px == 0:
                return False, (
                    "%s / %s: the wind pane drew 0 pixels on screen — "
                    "the fps figure (%.1f) is measuring a renderer that "
                    "draws nothing. Refusing to report it as a win."
                    % (name, r.get("label"), r["cadence"]["fps"])
                )
    return True, "wind visible on every run"


def run_browser(pw, name, url, seconds, window_ms, densities, settle_ms, headless):
    launcher = getattr(pw, name)
    if name == "firefox":
        # A FRESH Firefox profile stalls on its FIRST navigation —
        # measured: goto never commits within 60 s, while Chromium
        # commits in 1.5 s and the same Firefox profile navigates fine
        # on its SECOND attempt. The stall is the profile's network
        # warm-up (DoH/TRR probing and the predictor), not the site:
        # with `network.trr.mode = 5` (never DoH) the first goto commits
        # in 0.7 s and the map is up in 1.8 s. Without these prefs every
        # Firefox run of this tool reports a 60 s "load time".
        browser = launcher.launch(
            headless=headless,
            firefox_user_prefs={
                "network.trr.mode": 5,
                "network.dns.disablePrefetch": True,
                "network.predictor.enabled": False,
                "browser.shell.checkDefaultBrowser": False,
                "datareporting.policy.dataSubmissionEnabled": False,
            },
        )
    elif name == "chromium":
        browser = launcher.launch(headless=headless, args=["--no-sandbox"])
    else:
        browser = launcher.launch(headless=headless)
    try:
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        console_errors = []
        page.on("pageerror", lambda e: console_errors.append(str(e)[:300]))
        page.on(
            "console",
            lambda m: console_errors.append("console:" + m.text[:200])
            if m.type == "error"
            else None,
        )

        t_goto = time.time()
        # `commit`, not `domcontentloaded`: DCL on this link waits for
        # every deferred script of a fifteen-overlay boot, and a cold
        # run can sit there for minutes. The two waits below are what
        # actually matter (the map, and the wind being live), each with
        # its own progress line so a stall is visible rather than a
        # single opaque timeout at the end.
        page.goto(url, wait_until="commit", timeout=120_000)
        print("  … committed in %.1fs" % (time.time() - t_goto), flush=True)
        page.wait_for_function(
            "() => window._xyzoMap && window.WindLayer", timeout=240_000
        )
        print("  … map up in %.1fs" % (time.time() - t_goto), flush=True)
        # Wind may be in the hash; if it is, wait for it to be live so
        # the sweep starts from a running animation.
        wants_wind = "wind-gfs" in url
        if wants_wind:
            page.wait_for_function(
                "() => window.WindLayer.isEnabled && window.WindLayer.isEnabled()",
                timeout=300_000,
            )
            print("  … wind live in %.1fs" % (time.time() - t_goto), flush=True)
        load_s = time.time() - t_goto
        page.wait_for_timeout(settle_ms)

        # ── THE PIXEL CHECK ─────────────────────────────────────────────
        # Every fps number this tool prints is only meaningful if the
        # wind is actually ON SCREEN. It was not: `contain: paint` on
        # the wind pane (2026-11-20) clipped the 0 × 0 pane's contents
        # to nothing, and this tool reported 51 fps for a wind nobody
        # could see — an fps gain with zero pixels, published as a win.
        #
        # So measure the wind's OWN pixels the only way that survives
        # clipping: screenshot with the pane shown, hide it, screenshot
        # again, diff. Reading the canvas with getImageData does NOT
        # work — the backing store keeps its ink while the pane clips it
        # away, which is how "the canvas ink is unchanged" coexisted
        # with an invisible wind.
        wind_px = None
        if wants_wind:
            try:
                wind_px = _screen_pixels_for_wind(page)
                print("  … wind on screen: %s px" % (
                    "INVISIBLE (0)" if wind_px == 0 else "{:,}".format(wind_px)
                ), flush=True)
            except Exception as e:  # noqa: BLE001 — never kill the run
                print("  … pixel check FAILED: %s" % e, flush=True)

        results = []
        for d in densities:
            if d is not None:
                page.evaluate("(d) => window.WindLayer.setDensity(d)", d)
                page.wait_for_timeout(2000)
            m = page.evaluate(
                MEASURE_JS, {"seconds": seconds, "windowMs": window_ms}
            )
            m["density_setting"] = d
            m["label"] = "density=%s" % ("off" if d is None else d)
            m["wind_screen_px"] = wind_px
            results.append(m)

        return {
            "browser": name,
            "load_s": round(load_s, 2),
            "runs": results,
            "page_errors": console_errors[:20],
            "page_error_count": len(console_errors),
        }
    finally:
        browser.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--browsers", default="firefox,chromium",
                    help="comma list: firefox,chromium,webkit")
    ap.add_argument("--densities", default="100,50,25",
                    help="comma list of WindLayer density %% to sweep; "
                         "empty string = no wind at all (page baseline)")
    ap.add_argument("--seconds", type=float, default=8.0,
                    help="measurement window per density")
    ap.add_argument("--window-ms", type=int, default=500,
                    help="dot-speed sample interval")
    ap.add_argument("--settle-ms", type=int, default=6000,
                    help="wait after load before the first sample")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--no-wind", action="store_true",
                    help="strip wind-gfs from the URL first: the SAME "
                         "page with nothing animating, which is the only "
                         "honest baseline for what the wind costs")
    ap.add_argument("--json", default="", help="write the full report here")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    url = url_without_wind(args.url) if args.no_wind else args.url

    densities = []
    if args.densities.strip():
        for tok in args.densities.split(","):
            tok = tok.strip()
            if tok:
                densities.append(int(tok))
    else:
        densities = [None]

    if args.no_wind:
        # Nothing is animating — a density sweep would measure the same
        # page three times.
        densities = [None]

    report = {"url": url, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "seconds": args.seconds, "browsers": {}}

    with sync_playwright() as pw:
        for name in [b.strip() for b in args.browsers.split(",") if b.strip()]:
            print("── %s ──" % name, flush=True)
            try:
                rep = run_browser(pw, name, url, args.seconds,
                                  args.window_ms, densities, args.settle_ms,
                                  headless=not args.headed)
            except Exception as e:  # noqa: BLE001 — report, don't die
                print("  FAILED: %s" % e, flush=True)
                report["browsers"][name] = {"error": str(e)}
                continue
            report["browsers"][name] = rep
            print("  load %.1fs · %d page error(s)" %
                  (rep["load_s"], rep["page_error_count"]), flush=True)
            for r in rep["runs"]:
                c, w, ds, lt = r["cadence"], r.get("windEnd"), r["dotSpeed"], r["longTasks"]
                print("  %-14s fps %5.1f  p50 %6.1fms  p95 %6.1fms  worst %6.1fms  "
                      ">100ms %d  dots %6.1f px/s  particles %s q %s  longtasks %d (%.0f%% busy)"
                      % (r["label"], c["fps"], c["p50_ms"], c["p95_ms"], c["worst_ms"],
                         c["over_100ms"],
                         ds["p50_px_per_s"] or -1,
                         (w or {}).get("particles"), (w or {}).get("quality"),
                         lt["count"], lt["busy_pct"]), flush=True)

    # Cross-browser headline comparison.
    if len(report["browsers"]) > 1:
        print("\n── comparison (density=100) ──")
        for name, rep in report["browsers"].items():
            if "error" in rep:
                print("  %-10s ERROR %s" % (name, rep["error"]))
                continue
            r0 = rep["runs"][0]
            c, ds = r0["cadence"], r0["dotSpeed"]
            print("  %-10s fps %5.1f · p95 %6.1fms · dots %6.1f px/s · "
                  "particles %s @q%s · longtasks %d"
                  % (name, c["fps"], c["p95_ms"], ds["p50_px_per_s"] or -1,
                     (r0.get("windEnd") or {}).get("particles"),
                     (r0.get("windEnd") or {}).get("quality"),
                     r0["longTasks"]["count"]))

    # THE GATE. An fps number with no pixels beside it is how an
    # invisible wind got published as a 51 fps win (2026-11-20). Check
    # it BEFORE the report is written, so a failing run fails loudly
    # and still leaves its evidence on disk.
    gate_ok, gate_msg = pixel_gate(report)
    report["pixel_gate"] = {"ok": gate_ok, "message": gate_msg}
    print("\n── pixel gate ──\n  %s" % gate_msg, flush=True)

    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w") as f:
            json.dump(report, f, indent=2)
        print("\nwrote %s" % args.json)
    return 0 if gate_ok else 1


if __name__ == "__main__":
    sys.exit(main())
