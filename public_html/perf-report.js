/**
 * Xyzo performance telemetry — what real readers' browsers actually do.
 *
 * WHY THIS EXISTS (owner, 2026-11-14): *"we need someone on the server
 * side to help us understand how slow or how fast various situations
 * are running on various peoples browsers so we can log them and try
 * and study them on what we can do to speed it up for all users."*
 *
 * Until now the only perf numbers on this site came from lab runs of
 * scripts/wind_perf_audit.py — one machine, one viewport, software
 * rendering. That found the wind's two defects (a dt cap that halved
 * the animation below 10 fps, and strokes that cost 80 % of the layer's
 * canvas time), but it cannot answer the questions that decide what to
 * build next: how many readers are below 30 fps, whether Firefox is
 * really slower than Chrome on THEIR machines, whether a heavy shared
 * link is the problem or a five-year-old laptop is.
 *
 * WHAT IT SENDS — once per session per phase, per day:
 *
 *   settled  12 s after the map appears: the frame cadence of the page
 *            at rest, the long tasks it accumulated during boot, and
 *            the machine it is running on.
 *   wind     12 s after the wind layer switches on: the same numbers
 *            plus the layer's own count/quality and how far the dots
 *            actually travelled on screen (median px/s).
 *
 * Environment, not identity: the browser and OS are PARSED from the UA
 * ("Firefox/153", "Linux") rather than stored raw, there is no IP, no
 * user agent string and no precise location — the hash names the MAP a
 * reader built (the same thing map_move already sends as a bbox), and
 * the session id is the random localStorage key analytics.js has always
 * used. `scripts/retention_prune.py` drops the rows with the rest of
 * the telemetry at 90 days.
 *
 * THREE RULES, each load-bearing:
 *
 *  1. IT NEVER DISTURBS THE PAGE IT IS MEASURING. The sampler is a rAF
 *     loop that pushes one number per frame, and the dot probe reads a
 *     twelfth of the pool every 750 ms. The heavy work (the canvas
 *     micro-benchmark) runs AFTER the cadence window, once.
 *  2. IT NEVER THROWS. Every entry point is wrapped: a telemetry
 *     failure must be invisible to the reader, and a page that cannot
 *     report is a page that should still work.
 *  3. IT NEVER REPORTS TWICE. `xyzo.perf` in localStorage remembers
 *     which phases this session has already sent for this UTC day — so
 *     the server sees at most two rows per reader per day and can
 *     upsert safely.
 *
 * Loaded after analytics.js (it borrows the session id) and before
 * app.js (it must be watching when the map is created). In
 * scripts/bump_frontend.sh's ASSETS.
 */
(function () {
  "use strict";

  const ENDPOINT = "/api/analytics/perf";
  const STORE_KEY = "xyzo.perf";

  // The measurement windows. SETTLE is long enough that boot work
  // (grid decodes, canvas bakes, the pin fetch) has landed and we are
  // measuring the map the reader is LOOKING at, not the download.
  const SETTLE_MS = 12000;
  const SAMPLE_MS = 8000;
  const WIND_SETTLE_MS = 12000;
  const DOT_SAMPLE_MS = 750;
  const MAP_WAIT_MS = 60000;
  const WIND_WAIT_MS = 300000;

  // ── what we are allowed to remember ──────────────────────────────────
  function doneToday() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const v = JSON.parse(raw);
      const day = new Date().toISOString().slice(0, 10);
      return v && v.day === day && Array.isArray(v.phases) ? v.phases : [];
    } catch (_) {
      return [];
    }
  }
  function markDone(phase) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const phases = doneToday();
      if (phases.indexOf(phase) === -1) phases.push(phase);
      localStorage.setItem(STORE_KEY, JSON.stringify({ day: day, phases: phases }));
    } catch (_) { /* private mode: we simply report again next time */ }
  }
  function alreadySent(phase) {
    return doneToday().indexOf(phase) !== -1;
  }

  // ── the environment ──────────────────────────────────────────────────
  //
  // PARSED, never raw: two short strings that say what browser family
  // and major version and which OS, nothing else. The raw UA would be a
  // fingerprint; this is the two columns the report is grouped by.
  function parseEnv() {
    const ua = navigator.userAgent || "";
    let browser = null;
    const rules = [
      [/Firefox\/(\d+)/, "Firefox"],
      [/Edg\/(\d+)/, "Edge"],
      [/OPR\/(\d+)/, "Opera"],
      [/Chrome\/(\d+)/, "Chrome"],
      [/Version\/(\d+).*Safari/, "Safari"],
      [/CriOS\/(\d+)/, "Chrome"],
      [/FxiOS\/(\d+)/, "Firefox"],
    ];
    for (const [re, name] of rules) {
      const m = ua.match(re);
      if (m) { browser = name + "/" + m[1]; break; }
    }
    let os = "other";
    if (/Android/.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if (/Mac OS X/.test(ua)) os = "macOS";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Linux/.test(ua)) os = "Linux";

    // Phone/tablet from the UA first (it is what the OS reports), then
    // from the viewport: a narrow window on a desktop is still a
    // desktop, and the report's "device" column has to mean the thing
    // that decides layout.
    let device = "desktop";
    if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua)) device = "tablet";
    else if (/Mobi|iPhone|Android.*Mobile/.test(ua)) device = "phone";

    return { browser: browser, os: os, device: device };
  }

  // The renderer behind the canvas — the single most useful column for
  // "why is THIS reader slow": llvmpipe / SwiftShader / Software means
  // every pixel of every layer is being painted by the CPU, which is
  // exactly the regime where an animated layer over fifteen overlays
  // costs ~17 ms a frame (measured 2026-11-14).
  function gpuName() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return null;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const name = dbg
        ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return name ? String(name).slice(0, 160) : null;
    } catch (_) {
      return null;
    }
  }

  // A bounded, fixed-shape piece of 2D raster work: 120 filled circles
  // into a 320×200 canvas, 20 frames. It is the same call the wind
  // makes (fill a small disc), so its per-frame cost separates an
  // accelerated canvas from a software one in a way `devicePixelRatio`
  // and the UA never can. Runs ONCE, after the cadence window.
  function probeCanvas() {
    try {
      const c = document.createElement("canvas");
      c.width = 320; c.height = 200;
      const x = c.getContext("2d");
      if (!x) return null;
      const frames = 20;
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) {
        x.clearRect(0, 0, 320, 200);
        x.fillStyle = "rgba(8,12,20,0.5)";
        for (let k = 0; k < 120; k++) {
          const px = ((k * 7 + f) % 300) + 10;
          const py = ((k * 13) % 180) + 10;
          x.beginPath();
          x.arc(px, py, 3, 0, Math.PI * 2);
          x.fill();
        }
      }
      return +((performance.now() - t0) / frames).toFixed(2);
    } catch (_) {
      return null;
    }
  }

  function overlayCount() {
    try {
      const m = /(?:^|\/)overlay=([^/]*)/.exec(location.hash);
      return m && m[1] ? m[1].split(",").filter(Boolean).length : 0;
    } catch (_) {
      return 0;
    }
  }

  function canvasInventory() {
    try {
      const list = document.querySelectorAll("canvas");
      let px = 0;
      for (let i = 0; i < list.length; i++) px += list[i].width * list[i].height;
      return { count: list.length, px: px };
    } catch (_) {
      return { count: 0, px: 0 };
    }
  }

  function navTimings() {
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (!nav) return { dcl_ms: null, load_ms: null };
      return {
        dcl_ms: Math.round(nav.domContentLoadedEventEnd),
        load_ms: Math.round(nav.loadEventEnd),
      };
    } catch (_) {
      return { dcl_ms: null, load_ms: null };
    }
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }

  // ── the cadence window ───────────────────────────────────────────────
  //
  // One rAF loop for SAMPLE_MS, recording the interval between frames
  // plus every long task the page takes while it runs. The long task
  // observer is installed at MODULE LOAD rather than here, so it also
  // catches the boot — which is where the multi-second stalls live.
  const longTasks = [];   // durations in ms
  function observeLongTasks() {
    try {
      // Firefox has no `longtask` entry type — and asking for it prints
      // two console warnings on every page load ("Ignoring unsupported
      // entryTypes", "No valid entryTypes; aborting registration").
      // Those are lines in the READER's console about OUR file, which
      // is the noise the console guard exists to prevent, so support is
      // checked before it is asked for. Cadence alone carries the
      // measurement there.
      const supported = PerformanceObserver && PerformanceObserver.supportedEntryTypes;
      if (Array.isArray(supported) && supported.indexOf("longtask") === -1) return;
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.duration);
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch (_) {
      // No PerformanceObserver at all: the frame cadence still works.
    }
  }

  function sampleWindow(ms, onTick) {
    return new Promise((resolve) => {
      const frames = [];
      const t0 = performance.now();
      let last = t0;
      function tick(t) {
        frames.push(t - last);
        last = t;
        if (onTick) onTick(t - t0, frames);
        if (t - t0 < ms) requestAnimationFrame(tick);
        else {
          const wall = (performance.now() - t0) / 1000;
          const sorted = frames.slice().sort((a, b) => a - b);
          resolve({
            frames: frames.length,
            seconds: +wall.toFixed(2),
            fps: +(frames.length / Math.max(wall, 0.001)).toFixed(1),
            p50_ms: sorted.length ? +percentile(sorted, 0.5).toFixed(1) : null,
            p95_ms: sorted.length ? +percentile(sorted, 0.95).toFixed(1) : null,
            worst_ms: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
          });
        }
      }
      requestAnimationFrame(tick);
    });
  }

  // ── how fast the dots actually move ──────────────────────────────────
  //
  // The perceptual number behind "the wind dots don't move around very
  // fast": median on-screen displacement per second of the live pool.
  // A twelfth of the particles every 750 ms, so the probe costs about
  // 100 projections a second — under 1 % of the frame it is measuring.
  //
  // Respawned particles TELEPORT (they are re-born somewhere else), so
  // a jump over 150 px in half a second is discarded rather than
  // reported as speed: a mean would be dominated by exactly those.
  function sampleDotSpeed(ms) {
    const W = window.WindLayer;
    const map = window._xyzoMap;
    if (!W || !map || !W._stats || !W._stats().enabled) {
      return Promise.resolve(null);
    }
    const st = typeof W._state === "function" ? W._state() : W._state;
    if (!st || !st.particles) return Promise.resolve(null);

    const grabs = [];
    const grab = () => {
      const pool = st.particles;
      const pts = [];
      for (let i = 0; i < pool.length; i += 12) {
        try {
          const p = map.latLngToContainerPoint([pool[i].lat, pool[i].lng]);
          pts.push(p.x, p.y);
        } catch (_) { /* a map mid-resize: skip this sample */ }
      }
      grabs.push({ t: performance.now(), xy: pts });
    };
    grab();
    const iv = setInterval(grab, DOT_SAMPLE_MS);

    return sampleWindow(ms).then((cadence) => {
      clearInterval(iv);
      const speeds = [];
      for (let i = 1; i < grabs.length; i++) {
        const a = grabs[i - 1], b = grabs[i];
        const dt = (b.t - a.t) / 1000;
        if (dt <= 0) continue;
        for (let k = 0; k < Math.min(a.xy.length, b.xy.length); k += 2) {
          const d = Math.hypot(b.xy[k] - a.xy[k], b.xy[k + 1] - a.xy[k + 1]);
          if (!isFinite(d) || d > 150) continue;
          speeds.push(d / dt);
        }
      }
      speeds.sort((x, y) => x - y);
      return {
        cadence: cadence,
        dot_px_per_s: speeds.length ? +percentile(speeds, 0.5).toFixed(1) : null,
        dot_samples: speeds.length,
      };
    });
  }

  // ── the report ───────────────────────────────────────────────────────
  function windStats() {
    try {
      const W = window.WindLayer;
      if (!W || !W._stats) return null;
      const s = W._stats();
      const st = typeof W._state === "function" ? W._state() : W._state;
      return {
        on: !!s.enabled,
        style: (st && st.style) || null,
        density: (st && st.density) || null,
        particles: s.particles,
        fps: s.fps,
        quality: s.quality,
      };
    } catch (_) {
      return null;
    }
  }

  function buildPayload(phase, cadence, dot, env) {
    const canv = canvasInventory();
    const nav = navTimings();
    const wind = windStats();
    const busy = longTasks.reduce((a, b) => a + b, 0);
    return {
      session_id: env.session,
      phase: phase,
      browser: env.browser,
      os: env.os,
      device: env.device,
      hw_concurrency: navigator.hardwareConcurrency || null,
      dpr: window.devicePixelRatio || null,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      overlay_count: overlayCount(),
      panes: document.querySelectorAll(".leaflet-pane").length,
      canvas_px: canv.px,
      gpu: env.gpu,
      probe_ms: env.probeMs,
      fps: cadence ? cadence.fps : null,
      frame_p50_ms: cadence ? cadence.p50_ms : null,
      frame_p95_ms: cadence ? cadence.p95_ms : null,
      frame_worst_ms: cadence ? cadence.worst_ms : null,
      long_tasks: longTasks.length,
      long_busy_pct: +((busy / 1000) / Math.max(cadence ? cadence.seconds : 1, 0.001) * 100).toFixed(1),
      wind: wind,
      dot_px_per_s: dot ? dot.dot_px_per_s : null,
      dcl_ms: nav.dcl_ms,
      load_ms: nav.load_ms,
      view: location.hash.slice(0, 400),
    };
  }

  function send(payload) {
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => { /* telemetry is a footnote on the map, never a feature of it */ });
    } catch (_) { /* never throw */ }
  }

  function sessionId() {
    try {
      // THROUGH `window.` — never the bare identifier. A bare
      // `XyzoAnalytics` only resolves because window properties are
      // also globals, and this function swallows its own exceptions:
      // the day that resolution fails (a sandboxed context, a frame, a
      // renamed export) it would return null, `runPhase` would return
      // early, and telemetry would stop with NOTHING in the log. Ask
      // for the property the same way the guard already does.
      if (window.XyzoAnalytics && window.XyzoAnalytics.sessionId) {
        return window.XyzoAnalytics.sessionId;
      }
      return localStorage.getItem("xyzo.session");
    } catch (_) {
      return null;
    }
  }

  // ── the two phases ───────────────────────────────────────────────────
  function runPhase(phase, waitMs) {
    if (alreadySent(phase)) return Promise.resolve();
    const session = sessionId();
    if (!session) return Promise.resolve();

    return new Promise((resolve) => {
      setTimeout(() => {
        if (alreadySent(phase) || sessionId() !== session) { resolve(); return; }
        const windy = windStats() && windStats().on;
        const done = (cadence, dot) => {
          if (alreadySent(phase)) { resolve(); return; }
          const env = Object.assign(parseEnv(), {
            session: session,
            gpu: gpuName(),
            probeMs: probeCanvas(),   // AFTER the window: it must not
                                      // contaminate the cadence it reports
          });
          send(buildPayload(phase, cadence, dot, env));
          markDone(phase);
          resolve();
        };
        if (windy) {
          sampleDotSpeed(SAMPLE_MS).then((dot) => done(dot ? dot.cadence : null, dot));
        } else {
          sampleWindow(SAMPLE_MS).then((cadence) => done(cadence, null));
        }
      }, waitMs);
    });
  }

  function waitForMap() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window._xyzoMap) { clearInterval(iv); resolve(true); return; }
        if (Date.now() - t0 > MAP_WAIT_MS) { clearInterval(iv); resolve(false); }
      }, 500);
    });
  }

  function watchForWind() {
    const t0 = Date.now();
    let wasOn = false;
    const iv = setInterval(() => {
      let on = false;
      try {
        on = !!(window.WindLayer && window.WindLayer.isEnabled &&
                 window.WindLayer.isEnabled());
      } catch (_) { on = false; }
      if (on && !wasOn && !alreadySent("wind")) {
        wasOn = true;
        clearInterval(iv);
        runPhase("wind", WIND_SETTLE_MS);
      }
      if (Date.now() - t0 > WIND_WAIT_MS) clearInterval(iv);
    }, 1000);
  }

  observeLongTasks();

  waitForMap().then((up) => {
    if (!up) return;
    runPhase("settled", SETTLE_MS);
    watchForWind();
  });

  // Exposed for the test suite and the debug panel.
  window.XYZO_PERF = {
    parseEnv,
    gpuName,
    probeCanvas,
    overlayCount,
    sampleWindow,
    alreadySent,
    markDone,
    // buildPayload and windStats are exported SO THE TEST CAN PROVE
    // CLIENT AND SERVER AGREE: the suite diffs this payload's keys
    // against the keys the route's Zod schema declares, so a field one
    // side adds and the other forgets fails a test instead of being
    // silently dropped at the API boundary.
    buildPayload,
    windStats,
    observeLongTasks,
    ENDPOINT,
    SETTLE_MS,
    SAMPLE_MS,
    WIND_SETTLE_MS,
    _longTasks: longTasks,
  };
})();
