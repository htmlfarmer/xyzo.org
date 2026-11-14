// perf-report.bun.test.js — the reader-side half of the performance
// telemetry (owner, 2026-11-14: *"…so we can log them and try and study
// them on what we can do to speed it up for all users."*).
//
// The module is loaded against STUB TIMERS — every timer, rAF and fetch
// is passed in as a parameter — so a suite can exercise its pure
// functions without the module's own 60-second map poll and 12-second
// phase delay keeping the test process alive. That is also what makes
// the frame-cadence maths testable: the rAF queue is driven by hand.
//
// What is pinned here:
//   1. CLIENT AND SERVER AGREE ON THE PAYLOAD — the keys buildPayload()
//      produces are diffed against the keys the route's Zod schema
//      declares. A field one side adds and the other forgets used to be
//      dropped silently at the API boundary.
//   2. IT IS LOADED, STAMPED, AND BEFORE app.js — so the long-task
//      observer is watching before the map's boot work starts.
//   3. IT NEVER DOUBLE-REPORTS — one session, one day, one row per
//      phase, or the report's session counts are fiction.
//   4. THE CADENCE MATHS — fps/p50/p95 come out of the frame intervals
//      as numbers, not strings.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const perfJs = readFileSync(join(ROOT, "perf-report.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const analyticsTs = readFileSync(
  join(import.meta.dir, "..", "..", "api", "src", "routes", "analytics.ts"),
  "utf8"
);

// ── the loader: stub timers, a hand-cranked rAF, a recording fetch ─────
function loadPerf(opts = {}) {
  const calls = { fetch: [], timeouts: [], intervals: [], raf: [] };
  const store = new Map(Object.entries(opts.store || {}));

  const win = {};
  win.window = win;
  if (opts.map !== false) win._xyzoMap = { ok: true };
  if (opts.wind) win.WindLayer = opts.wind;
  win.XyzoAnalytics = opts.session === null
    ? undefined
    : { sessionId: opts.session || "sess_perf_test" };

  let clock = 0;
  const perf = {
    now: () => clock,
    getEntriesByType: (t) => (t === "navigation" ? [{ domContentLoadedEventEnd: 900, loadEventEnd: 2500 }] : []),
  };
  const documentStub = {
    querySelectorAll: (sel) =>
      sel === "canvas" ? [{ width: 720, height: 450 }, { width: 256, height: 256 }]
      : sel === ".leaflet-pane" ? new Array(36).fill({})
      : [],
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    visibilityState: "visible",
  };
  const navigatorStub = Object.assign(
    { userAgent: opts.ua || "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0" },
    opts.navigator || {}
  );
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const locationStub = {
    // An EMPTY hash must stay empty: `||` would fall back to the
    // default and the "no hash" case would silently measure the
    // default map instead.
    hash: opts.hash !== undefined ? opts.hash : "#2.1,16.9,3/overlay=wind-gfs@100,basins@100",
  };

  const setTimeoutStub = (fn, ms) => { calls.timeouts.push(ms); return calls.timeouts.length; };
  // The interval stub RECORds and then FIRES the callback — but on a
  // MICROTASK, never synchronously. Firing it inline is a trap: the
  // module writes `const iv = setInterval(fn, ms)` and its callback
  // calls `clearInterval(iv)`, so a synchronous fire reads `iv` out of
  // its temporal dead zone, throws, and (with the try/catch here) fails
  // SILENTLY — the poll appears to be registered while the promise it
  // was meant to resolve never settles. That is exactly the shape of
  // bug this suite exists to catch, so the stub must not be the one
  // that causes it.
  const setIntervalStub = (fn, ms) => {
    calls.intervals.push(ms);
    if (fn) queueMicrotask(() => { try { fn(); } catch (_) { /* module must survive its own poll */ } });
    return calls.intervals.length;
  };
  const clearIntervalStub = () => {};
  const rafStub = (cb) => { calls.raf.push(cb); return calls.raf.length; };
  const fetchStub = (url, init) => { calls.fetch.push({ url, init }); return Promise.resolve({ ok: true }); };
  const poStub = function () { this.observe = () => {}; this.disconnect = () => {}; };
  poStub.supportedEntryTypes = ["navigation", "paint"];

  const factory = new Function(
    "window", "localStorage", "document", "location", "navigator", "performance",
    "setTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
    "fetch", "PerformanceObserver", "XLog",
    perfJs
  );
  factory(win, localStorageStub, documentStub, locationStub, navigatorStub, perf,
          setTimeoutStub, setIntervalStub, clearIntervalStub, rafStub,
          fetchStub, poStub, { debug: () => {}, warn: () => {} });

  // Drive one rAF tick at the current clock, returning whether it ran.
  const tick = (dtMs) => {
    clock += dtMs;
    const cbs = calls.raf.splice(0);
    for (const cb of cbs) cb(clock);
    return cbs.length;
  };

  return { P: win.XYZO_PERF, win, calls, store, tick, advance: (ms) => { clock += ms; } };
}

// ── 1. it is loaded, stamped, and early ────────────────────────────────
describe("perf-report.js is wired into the page", () => {
  test("index.html loads it, with a cache token, BEFORE app.js", () => {
    const tag = indexHtml.match(/<script[^>]*src="(perf-report\.js[^"]*)"/);
    expect(tag, "perf-report.js is not loaded by index.html").toBeTruthy();
    expect(tag[1]).toMatch(/\?v=\d+/);
    // Before app.js, or the boot's long tasks have already happened
    // before anyone was watching — the multi-second stalls this table
    // exists for live in the boot.
    expect(indexHtml.indexOf("perf-report.js")).toBeLessThan(indexHtml.indexOf("app.js?"));
    // …and it borrows the session id from analytics.js, so it comes
    // after it.
    expect(indexHtml.indexOf("analytics.js")).toBeLessThan(indexHtml.indexOf("perf-report.js"));
  });

  test("it is in bump_frontend.sh's ASSETS (a token nothing moves is no token)", () => {
    const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");
    expect((bump.match(/^ASSETS=".*"$/m) || [""])[0]).toContain("perf-report.js");
  });

  test("no direct console.* — XLog is the supported path", () => {
    expect(perfJs.match(/^\s*console\.(log|warn|error|debug|info)\(/gm) || []).toEqual([]);
  });

  test("it does not ask Firefox for an entry type Firefox does not have", () => {
    // Measured on the live page: `obs.observe({entryTypes:["longtask"]})
    // ` prints two warnings in Firefox ("Ignoring unsupported
    // entryTypes…", "No valid entryTypes; aborting registration") —
    // console noise about OUR file, on every page load.
    expect(perfJs).toMatch(/PerformanceObserver\.supportedEntryTypes/);
    expect(perfJs).toMatch(/indexOf\("longtask"\) === -1/);
  });
});

// ── 2. it starts itself, and once ──────────────────────────────────────
describe("the module's own wiring", () => {
  test("it polls for the map instead of assuming one exists", async () => {
    const { P, calls } = loadPerf();
    expect(P).toBeTruthy();
    // A poll for _xyzoMap (500 ms) — never a blocking wait, and never
    // a throw on a page with no map. The map poll resolves on a
    // microtask, which is what arms the settled phase's delay AND the
    // wind watcher, so the turn comes first.
    expect(calls.intervals).toContain(500);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.intervals).toContain(1000);
    expect(calls.timeouts).toContain(P.SETTLE_MS);
    expect(P.SETTLE_MS).toBeGreaterThanOrEqual(8000);
    expect(P.SAMPLE_MS).toBeGreaterThanOrEqual(4000);
  });

  test("without a session id it schedules nothing — no id, no row", () => {
    const { calls } = loadPerf({ session: null });
    // The map poll still runs (it has to, to decide there is a map) but
    // no report delay is ever armed, because runPhase() refuses.
    expect(calls.timeouts).not.toContain(12000);
  });

  test("one session reports one phase once per day", () => {
    const { P, store } = loadPerf();
    expect(P.alreadySent("settled")).toBe(false);
    P.markDone("settled");
    expect(P.alreadySent("settled")).toBe(true);
    expect(P.alreadySent("wind")).toBe(false);
    P.markDone("wind");
    // Both phases remembered for TODAY…
    expect(JSON.parse(store.get("xyzo.perf")).phases.sort()).toEqual(["settled", "wind"]);
    // …and a different day forgets them, or the study would see one
    // day's reader and never hear from them again.
    store.set("xyzo.perf", JSON.stringify({ day: "2020-01-01", phases: ["settled", "wind"] }));
    expect(P.alreadySent("settled")).toBe(false);
    // A corrupt entry is treated as "nothing sent", never as a crash.
    store.set("xyzo.perf", "{not json");
    expect(P.alreadySent("settled")).toBe(false);
  });

  test("the endpoint is the route the API actually serves", () => {
    const { P } = loadPerf();
    expect(P.ENDPOINT).toBe("/api/analytics/perf");
    expect(analyticsTs).toContain('"/analytics/perf"');
  });
});

// ── 3. the environment is parsed, not copied ───────────────────────────
describe("what it says about the browser", () => {
  test("the UA is parsed down to two short strings", () => {
    const cases = [
      ["Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0", "Firefox/153", "Linux"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", "Chrome/140", "Windows"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", "Safari/17", "macOS"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", null, "iOS"],
    ];
    for (const [ua, browser, os] of cases) {
      const { P } = loadPerf({ ua, map: false, session: null });
      const env = P.parseEnv();
      if (browser) expect(env.browser).toBe(browser);
      expect(env.os).toBe(os);
      // Nothing else comes across: no full UA, no platform string.
      expect(JSON.stringify(env).length).toBeLessThan(80);
    }
  });

  test("phone vs tablet vs desktop follows the UA", () => {
    const phone = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";
    const tablet = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const desktop = "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0";
    expect(loadPerf({ ua: phone }).P.parseEnv().device).toBe("phone");
    expect(loadPerf({ ua: tablet }).P.parseEnv().device).toBe("tablet");
    expect(loadPerf({ ua: desktop }).P.parseEnv().device).toBe("desktop");
  });

  test("the overlay count comes from the hash the reader built", () => {
    const five = loadPerf({ hash: "#1,2,3/overlay=a@100,b@50,c@10,d@20,e@30" });
    expect(five.P.overlayCount()).toBe(5);
    const none = loadPerf({ hash: "#1,2,3" });
    expect(none.P.overlayCount()).toBe(0);
    const junk = loadPerf({ hash: "" });
    expect(junk.P.overlayCount()).toBe(0);
  });
});

// ── 4. the frame cadence ───────────────────────────────────────────────
describe("the cadence window", () => {
  test("fps, p50, p95 and worst come out as NUMBERS from the intervals", async () => {
    const { P, calls, tick } = loadPerf();
    // 61 frames at a steady 16.67 ms = just over one second of 60 Hz.
    const p = P.sampleWindow(1000);
    for (let i = 0; i < 70; i++) tick(16.67);
    const out = await p;
    expect(out.frames).toBeGreaterThan(55);
    expect(typeof out.fps).toBe("number");
    expect(out.fps).toBeGreaterThan(55);
    expect(out.fps).toBeLessThan(63);
    expect(typeof out.p50_ms).toBe("number");
    expect(out.p50_ms).toBeGreaterThan(15);
    expect(out.p50_ms).toBeLessThan(19);
    expect(typeof out.p95_ms).toBe("number");
    expect(typeof out.worst_ms).toBe("number");
    expect(out.worst_ms).toBeGreaterThanOrEqual(out.p95_ms);
    // The maths is over FRAME INTERVALS, so a stalled frame is visible
    // as a p95/worst rather than being averaged away.
    expect(out.seconds).toBeGreaterThan(0);
  });

  test("one long frame shows up in p95/worst, not in the average", async () => {
    const { P, calls, tick } = loadPerf();
    const p = P.sampleWindow(600);
    for (let i = 0; i < 40; i++) tick(i === 20 ? 400 : 16.67);
    const out = await p;
    expect(out.worst_ms).toBeGreaterThan(300);
    expect(out.p50_ms).toBeLessThan(30);
  });
});

// ── 5. client and server agree ─────────────────────────────────────────
describe("the payload the server declares", () => {
  // The route's own schema, read from source: if analytics.ts stops
  // declaring a field, this diff notices; if the client stops sending
  // one, this diff notices too.
  const schemaKeys = (() => {
    const block = analyticsTs.match(/const PerfSchema = z\.object\(\{([\s\S]*?)\n\}\);/);
    if (!block) return null;
    return [...block[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  })();

  test("PerfSchema is found in the route source", () => {
    expect(schemaKeys).toBeTruthy();
    expect(schemaKeys.length).toBeGreaterThan(20);
  });

  test("buildPayload sends every field the schema declares", () => {
    expect(schemaKeys).toBeTruthy();
    const { P } = loadPerf();
    const payload = P.buildPayload("settled",
      { frames: 120, seconds: 8, fps: 15, p50_ms: 60, p95_ms: 90, worst_ms: 200 },
      { dot_px_per_s: 44.5, dot_samples: 96 },
      { session: "sess_x", gpu: "llvmpipe", probeMs: 7.25 });
    const keys = Object.keys(payload);
    const missing = schemaKeys.filter((k) => !keys.includes(k));
    expect(missing, "these schema fields are never sent by the client").toEqual([]);
    // …and the values are JSON-safe: a BigInt or a NaN here would make
    // JSON.stringify throw (or the API 400) rather than log a row.
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload.phase).toBe("settled");
    expect(payload.session_id).toBe("sess_x");
    expect(payload.gpu).toBe("llvmpipe");
    expect(payload.dot_px_per_s).toBe(44.5);
    expect(payload.overlay_count).toBe(2);
    expect(payload.panes).toBe(36);
    expect(typeof payload.fps).toBe("number");
  });

  test("the wind blob carries the layer's own numbers", () => {
    const { P, win } = loadPerf();
    // A live layer: _stats() plus the state object (a PROPERTY, not a
    // function — calling it as one is how an earlier probe died).
    win.WindLayer = {
      _stats: () => ({ enabled: true, particles: 1234, fps: 7, quality: 0.4 }),
      _state: { style: "particles", density: 100 },
    };
    const w = P.windStats();
    expect(w.on).toBe(true);
    expect(w.style).toBe("particles");
    expect(w.density).toBe(100);
    expect(w.particles).toBe(1234);
    // No layer at all is `null`, never a throw: this runs on every page
    // including the ones with no map.
    const bare = loadPerf();
    expect(bare.P.windStats()).toBeNull();
  });
});
