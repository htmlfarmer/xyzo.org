// offline-layer.bun.test.js — the offline work: service worker + honest
// banners.
//
// Everything here was found by MEASURING (scripts/offline_audit.py,
// three phases in one persistent profile) rather than by reading the
// code, and each rule below is a defect that actually shipped:
//
//   1. The precache treated every href in index.html as a static asset.
//      The help page carries plain <a> links to `/api/pins/map?bbox=…`
//      and a <form action="/search/results">; the query string was
//      stripped, so install asked for `/api/pins/map` with NO bbox —
//      which does not answer, it HANGS. One pending fetch inside
//      Promise.all and the install event never settled: the worker sat
//      at installing=true forever, never activated, and a fully offline
//      visit had nothing to boot from (net::ERR_FAILED on the document).
//   2. The tile notice was shown and then immediately hidden: window
//      `load` calls sync() -> show(true) -> hide(). Log said "shown",
//      probe said false.
//   3. Its recovery rule counted any 6 successes, so 24 successes among
//      48 failures cleared a notice that was still true.
//   4. ApiHealth's banner said "System Upgrade in Progress … We are
//      actively upgrading our server infrastructure" when the READER's
//      connection had dropped — blaming our servers for their wifi.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
const offline = readFileSync(join(ROOT, "offline.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("the service worker installs (it once never did)", () => {
  test("dynamic endpoints are skipped from the shell precache", () => {
    // Without this the install hangs on a parameterless /api/pins/map.
    expect(sw).toMatch(/const SKIP = \["\/api\/", "\/search\/results"\]/);
    expect(sw).toMatch(/!SKIP\.some\(\(s\) => p\.startsWith\(s\)\)/);
  });

  test("every precache fetch is bounded, so one slow asset cannot kill it", () => {
    expect(sw).toMatch(/const FETCH_TIMEOUT_MS = \d+/);
    expect(sw).toMatch(/const bounded = \(p, ms\) => Promise\.race\(/);
    // and the timeout is actually applied to the per-asset fetch
    expect(sw).toMatch(/bounded\(fetch\(p, \{ cache: "reload" \}\), FETCH_TIMEOUT_MS\)/);
  });

  test("the manifest is parsed from index.html, not hand-maintained", () => {
    // A hand-written asset list drifts the moment a layer ships.
    expect(sw).toMatch(/matchAll\(\/\(\?:src\|href\)=/);
    expect(sw).not.toMatch(/PRECACHE_ASSETS\s*=/);
  });

  test("a failed install still leaves the worker able to serve", () => {
    // skipWaiting must run even when the precache threw, or the worker
    // stays in `waiting` behind an old page and never controls it.
    const install = sw.slice(sw.indexOf('addEventListener("install"'));
    const body = install.slice(0, install.indexOf('addEventListener("activate"'));
    expect(body).toMatch(/catch \(_\) \{ \/\* offline install/);
    expect(body).toMatch(/await self\.skipWaiting\(\)/);
  });
});

describe("what the worker caches", () => {
  test("navigations fall back to the cached shell", () => {
    // Without this a fully-offline visit has no document at all.
    expect(sw).toMatch(/request\.mode === "navigate"/);
    expect(sw).toMatch(/cache\.match\("\/index\.html"\)/);
  });

  test("API responses fall back to the last one, ignoring the query string", () => {
    // /api/feed/live sends `since=<ISO now>`, so its URL is unique per
    // page load and an exact-only match NEVER hit — the Live Feed sat
    // on "loading…" forever while /api/health (a stable URL) answered.
    expect(sw).toMatch(/ignoreSearch: true/);
    // the fallback does cache (a stale answer beats an error page)
    expect(sw).toMatch(/await cache\.put\(request, response\.clone\(\)\)/);
  });

  test("an SSE stream is NEVER cached — cache.put waits for a body that never ends", () => {
    // Measured A/B in a browser (both runs SW-controlled, same page):
    //   buggy  -> open=false snapshot=false error=false  (hung, no data)
    //   fixed  -> open=true  snapshot=true
    // `cache.put` reads the response body to completion before it
    // resolves, and an SSE body completes only when the server closes
    // the connection — so awaiting it meant respondWith never resolved,
    // the page never saw the response, and the Live Feed was dead for
    // EVERY visitor once the worker controlled the page. The listener
    // had to be `addEventListener("snapshot")`: the server emits a
    // NAMED event, so `onmessage` never fires and an onmessage-only test
    // reports a false "both broken / both fine".
    expect(sw).toMatch(/const isStream = type\.includes\("text\/event-stream"\)/);
    // The guard is a BLOCK now, not a one-liner: it also skips
    // PLACEHOLDERS (a tile that does not exist yet is a 200 transparent
    // PNG, and pinning that would keep the hole open long after the
    // origin has the real tile).
    expect(sw).toMatch(/response\.ok && !isStream && !isPlaceholder/);
    expect(sw).toMatch(/await cache\.put\(request, response\.clone\(\)\)/);
  });

  test("an SSE stream is NOT INTERCEPTED AT ALL — the browser handles it", () => {
    // The reader reported:
    //   "Failed to load 'https://xyzo.org/api/feed/live/stream?…'.
    //    A ServiceWorker intercepted the request and encountered an
    //    unexpected error.  sw.js:232:11"
    //
    // The stream itself was fine — the Live Feed reconnected and carried
    // on — but the worker turned every ABORT (the reader navigates, the
    // tab is hidden, the server closes the connection) into a console
    // line it could neither silence nor act on, and the line pointed at
    // the worker as if the worker were broken.
    //
    // The fix is to NOT respond: with no `respondWith` the browser owns
    // the EventSource, and an abort is then the browser's own business —
    // silent, as it should be. The `Accept` header is what makes the
    // request a stream in the first place, so it is the test.
    expect(sw).toMatch(/accept\.includes\("text\/event-stream"\)/);
    // …and the guard must come BEFORE the /api/ branch, or the stream
    // is still wrapped by networkFirst.
    const guard = sw.indexOf('accept.includes("text/event-stream")');
    const apiBranch = sw.indexOf('url.pathname.startsWith("/api/")');
    expect(guard).toBeGreaterThan(-1);
    expect(apiBranch).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(apiBranch);
  });

  test("a handler never REJECTS — a failure is reported as a network error", () => {
    // Firefox prints "A ServiceWorker intercepted the request and
    // encountered an unexpected error" for ANY rejection of the promise
    // passed to respondWith — including the routine ones: Leaflet drops
    // a tile when you pan, and a reload cancels whatever is in flight,
    // so a single page load aborts a dozen image fetches. Those showed
    // up as a wall of red sw.js:310 lines for ordinary aborts.
    //
    // `Response.error()` fails the request as a plain network error —
    // exactly what the browser would have done with no worker — so the
    // blame sits with the network instead of the worker.
    expect(sw).toMatch(/function networkError\(\)/);
    expect(sw).toMatch(/return Response\.error\(\)/);
    const cf = sw.slice(sw.indexOf("async function cacheFirst("),
                        sw.indexOf("async function networkFirst("));
    const nf = sw.slice(sw.indexOf("async function networkFirst("),
                        sw.indexOf('self.addEventListener("install"'));
    expect(cf, "cacheFirst still throws").not.toMatch(/throw err/);
    expect(nf, "networkFirst still throws").not.toMatch(/throw err;/);
    expect(cf).toMatch(/return networkError\(\)/);
    expect(nf).toMatch(/return networkError\(\)/);
  });

  test("the tile cache is bounded — unbounded it evicts the shell too", () => {
    expect(sw).toMatch(/const TILE_LIMIT = \d+;/);
    const limit = Number(sw.match(/const TILE_LIMIT = (\d+);/)[1]);
    expect(limit).toBeGreaterThan(50);
    expect(limit).toBeLessThan(5000);
    expect(sw).toMatch(/async function trim\(cache, limit\)/);
    // The trim is AMORTISED rather than run after every put: `trim()`
    // costs a `cache.keys()` — an array of every entry — so running it
    // per tile is O(entries × tiles), seconds of bookkeeping on a
    // screenful of tiles and on their critical path. It runs every
    // TRIM_EVERY-th put instead, and the cache can therefore only
    // overshoot by TRIM_EVERY-1 — still bounded, which is the point.
    expect(sw).toMatch(/await maybeTrim\(cacheName, cache, limit\)/);
    expect(sw).toMatch(/const TRIM_EVERY = \d+;/);
  });

  test("the hosts that actually serve this map's imagery are listed", () => {
    // Dropping any of these makes that layer vanish offline with no
    // error — the exact "0 of 72 tiles, nothing said so" finding.
    for (const h of ["arcgisonline.com", "cartocdn.com", "data.apps.fao.org",
                     "gibs.earthdata.nasa.gov", "macrostrat.org",
                     "tile.openstreetmap.org", "mrdata.usgs.gov",
                     "sos.noaa.gov", "openmaptiles.org"]) {
      expect(sw, `missing tile host ${h}`).toContain(`"${h}"`);
    }
  });

  test("caches are versioned so a deploy can invalidate them", () => {
    expect(sw).toMatch(/const VERSION = "xyzo-/);
    // and stale versions are dropped on activate
    const act = sw.slice(sw.indexOf('addEventListener("activate"'));
    expect(act).toMatch(/caches\.delete\(/);
    expect(act).toMatch(/self\.clients\.claim\(\)/);
  });
});

describe("the banners tell the truth", () => {
  test("the offline banner blames the connection, not our servers", () => {
    // Assert on what is RENDERED, not on the whole file: the header
    // comment quotes the old wording on purpose, to say what it fixed.
    const rendered = [
      offline.slice(offline.indexOf("var OFFLINE_HTML"),
                    offline.indexOf("function show(online)")),
      offline.slice(offline.indexOf("function repaintTiles"),
                    offline.indexOf("var tilesWatched")),
    ].join("\n");
    expect(rendered).toMatch(/You're offline\./);
    expect(rendered).toMatch(/Map imagery isn't loading\./);
    expect(rendered).not.toMatch(/System Upgrade/);
    // app.js carried the false claim; it must stay gone
    expect(appJs).not.toMatch(/System Upgrade in Progress/);
    // (a `app.js < 850_000` size check used to be piggybacked here.
    // Removed 2026-11-01 with every other size ceiling — see the note
    // in code-splitting.bun.test.js.)
  });

  test("a dead TILE host gets its own notice — it is not 'offline'", () => {
    // navigator.onLine stays true when only the imagery hosts are down,
    // so no offline banner is honest — yet the map is a black box.
    expect(offline).toMatch(/Map imagery isn't loading\./);
    expect(offline).toMatch(/function showTiles\(\)/);
  });

  test("being online does NOT clear the tile notice", () => {
    // window `load` calls sync() -> show(true); an unconditional hide
    // there erased the notice moments after it appeared.
    const fn = offline.slice(offline.indexOf("function show(online)"));
    const body = fn.slice(0, fn.indexOf("function sync()"));
    expect(body).toMatch(/if \(tileReason\) return;/);
  });

  test("recovery needs successes to DOMINATE, not merely exist", () => {
    // `o >= 6` cleared a notice that was still true: 24 successes
    // among 48 failures.
    expect(offline).toMatch(/tileReason && o >= 8 && o > f/);
    expect(offline).not.toMatch(/tileReason && o >= 6/);
  });

  test("only Leaflet tiles from OTHER origins count", () => {
    // Article thumbnails are external too; counting them would cry
    // wolf on a healthy load with one broken image.
    expect(offline).toMatch(/classList\.contains\("leaflet-tile"\)/);
    expect(offline).toMatch(/function externalOrigin\(src\)/);
  });

  test("the tile watcher listens in the CAPTURE phase, exactly once", () => {
    // Image load/error do not bubble — a bubble listener never fires.
    expect(offline).toMatch(/window\.addEventListener\("error", function \(e\) \{[\s\S]{0,200}true\);/);
    // and init() can run from two branches, so it must be idempotent
    expect(offline).toMatch(/if \(tilesWatched\) return;/);
    expect(offline).toMatch(/watchTiles\(\);/);
  });

  test("one explanation on screen at a time: ours hides ApiHealth's", () => {
    expect(offline).toMatch(/getElementById\("api-down-banner"\)/);
    expect(offline).toMatch(/api\.style\.display = "none"/);
    // ...and it is handed back when ours goes away
    expect(offline).toMatch(/api\.style\.display = ""/);
  });

  test("an offline state outranks a tile notice", () => {
    // "you're offline" explains more than "the imagery sites are down",
    // so a tile notice must not preempt it.
    const fn = offline.slice(offline.indexOf("function showTiles()"));
    const body = fn.slice(0, functionEnd(fn));
    expect(body).toMatch(/if \(navigator\.onLine === false\) return;/);
  });
});

function functionEnd(src) {
  // first closing of showTiles: it ends at the `function repaintTiles`
  const i = src.indexOf("function repaintTiles");
  return i === -1 ? src.length : i;
}

describe("registration", () => {
  test("offline.js registers the worker and is itself loaded", () => {
    expect(offline).toMatch(/navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
    // guarded: a browser without SW support must not throw during boot
    expect(offline).toMatch(/if \(!\("serviceWorker" in navigator\)\) return;/);
  });

  test("it loads before app.js, once, and is stamped by bump_frontend", () => {
    const appAt = indexHtml.indexOf("app.js?");
    const at = indexHtml.indexOf("offline.js");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    expect(indexHtml.match(/<script src="offline\.js/g).length).toBe(1);
    expect(bump).toMatch(/offline\.js/);
  });

  test("it survives a page with no document body (file://, tests)", () => {
    expect(offline).toMatch(/if \(typeof window === "undefined" \|\| !document\.body\) return;/);
  });
});

// ── a meta.json must NOT be served stale from the cache ──────────────
//
// A meta.json carries the PROVENANCE: the composite's own date, the
// attribution, the licence, the speed range. The ocean-current
// overlay's meta is the case that bites — it carries `source_date`,
// and the layer's legend prints the field's age, so a CACHED meta
// without it would silently drop the whole "this field is N years
// old" line and put the lie back.
//
// The /data/ branch is cache-first (the grids are big and immutable),
// so the meta has to be carved out of it.
describe("the service worker and the data metas", () => {
  test("a meta.json under /data/ goes NETWORK-first", () => {
    expect(sw).toMatch(/url\.pathname\.startsWith\("\/data\/"\)/);
    expect(sw).toMatch(/endsWith\("\.json"\)/);
    const block = sw.slice(sw.indexOf('startsWith("/data/")'));
    expect(block.slice(0, 600)).toMatch(/networkFirst\(request, DATA_CACHE\)/);
  });

  test("the big grids are still cache-first", () => {
    const block = sw.slice(sw.indexOf('startsWith("/data/")'));
    // Bounded since the quota lesson: DATA_CACHE holds every /data tile
    // PLUS the multi-MB grids, and an unbounded cache is what spends the
    // origin quota whose failure then failed live requests.
    expect(block.slice(0, 600)).toMatch(/cacheFirst\(request, DATA_CACHE, DATA_LIMIT/);
    expect(sw).toMatch(/const DATA_LIMIT = \d+;/);
  });

  test("networkFirst falls back to the cache when offline", () => {
    // Otherwise an offline reader gets no meta at all and the legend
    // loses its date line.
    //
    // `limit` is optional and exists for /api/tile/ — mirrored tiles
    // arrive hundreds at a time and API_CACHE is deliberately unbounded
    // (it holds JSON answers), so the caller passes TILE_LIMIT.
    expect(sw).toMatch(/async function networkFirst\(request, cacheName, limit/);
    expect(sw).toMatch(/catch \(err\) \{/);
    expect(sw).toMatch(/networkFirst\(request, TILE_CACHE, TILE_LIMIT/);
  });

  test("a CANCELLED TILE is a missing tile, not an error response", () => {
    // The reader's line, third in the series:
    //   Failed to load 'https://xyzo.org/api/tile/rain/2026-11-07/5/16/6'.
    //   A ServiceWorker intercepted the request and encountered an
    //   unexpected error.  sw.js:416:11
    //
    // The tile itself answers 200 + image/png from the origin — the
    // failure is an ABORT. The globe's raster source and Leaflet both
    // drop in-flight tiles when the view changes, so panning cancels a
    // dozen fetches as a matter of course, and the caller discards
    // whatever comes back.
    //
    // `Response.error()` does NOT silence Firefox: it reports an error
    // response exactly as it reports a rejection. So the tile paths get
    // a benign 1×1 transparent PNG instead — the SAME answer the
    // tileMirror route gives for a tile that does not exist — while
    // scripts and JSON keep Response.error() so a real failure stays
    // visible. (There is a `dataFallback` for the same reason: a
    // transparent PNG handed to a .bin grid fetch decodes as 68 bytes of
    // garbage, so only /data/ images degrade.)
    expect(sw).toMatch(/function tileFallback\(\)/);
    expect(sw).toMatch(/X-Tile-Mirror": "cancelled_or_unreachable"/);
    // Both handlers must take the hook…
    expect(sw).toMatch(/async function cacheFirst\(request, cacheName, limit, onError\)/);
    expect(sw).toMatch(/async function networkFirst\(request, cacheName, limit, onError\)/);
    // …and CONSUME it, in the failure path, before networkError().
    for (const fn of ["cacheFirst", "networkFirst"]) {
      const at = sw.indexOf(`async function ${fn}(`);
      const end = fn === "cacheFirst"
        ? sw.indexOf("async function networkFirst(")
        : sw.indexOf('self.addEventListener("install"');
      const body = sw.slice(at, end);
      const call = body.indexOf("onError(err, request)");
      expect(call, `${fn} never calls onError — the abort still fails`).toBeGreaterThan(-1);
      const fail = body.indexOf("return networkError();");
      expect(fail, `${fn} has no networkError fallback`).toBeGreaterThan(-1);
      expect(call, `${fn} answers the abort with an error anyway`).toBeLessThan(fail);
    }
    // The THREE tile paths pass it; the shell (scripts) and the API do
    // NOT — a failed script or a failed JSON answer must stay visible.
    expect(sw).toMatch(/networkFirst\(request, TILE_CACHE, TILE_LIMIT, tileFallback\)/);
    expect(sw).toMatch(/cacheFirst\(request, TILE_CACHE, TILE_LIMIT, tileFallback\)/);
    expect(sw).toMatch(/cacheFirst\(request, DATA_CACHE, DATA_LIMIT, dataFallback\)/);
    expect(sw).toMatch(/networkFirst\(request, API_CACHE\)/);
    expect(sw).toMatch(/cacheFirst\(request, SHELL_CACHE\)/);
    // …and neither may carry one.
    expect(sw).not.toMatch(/networkFirst\(request, API_CACHE,/);
    expect(sw).not.toMatch(/cacheFirst\(request, SHELL_CACHE,/);
    // /data/ degrades IMAGES only.
    expect(sw).toMatch(/function dataFallback\(_err, request\)/);
    expect(sw).toMatch(/IMAGE_EXT\.test\(path\) \? tileFallback\(\) : null/);
  });

  test("NO cache operation can fail a live request", () => {
    // Reported as: Firefox logging
    //   A ServiceWorker intercepted the request and encountered an
    //   unexpected error.  sw.js:292:11
    // for `/api/health` — a fetch the network had already answered —
    // with the Live Feed banner up, and only a hard refresh (which
    // bypasses the worker) fixing it.
    //
    // Two shapes did it: `caches.open()` sitting OUTSIDE any try, and a
    // `cache.put()` whose rejection escaped into `respondWith`. A full
    // Cache Storage is the trigger — DATA_CACHE holds every /data tile
    // plus the multi-MB probe grids — and a caching failure is not a
    // request failure: the correct behaviour is to serve the response
    // we already have and simply have no offline copy this time.
    //
    // So: the open must be guarded, and every put must be inside a try.
    expect(sw).not.toMatch(/const cache = await caches\.open\(cacheName\)/);
    const puts = [...sw.matchAll(/await cache\.put\(request, response\.clone\(\)\);/g)];
    expect(puts.length, "expected at least the two cache handlers").toBeGreaterThanOrEqual(2);
    for (const m of puts) {
      const before = sw.slice(Math.max(0, m.index - 300), m.index);
      expect(before, "a cache.put is unguarded — a full cache would fail the request")
        .toMatch(/try \{/);
    }
    // The opening of each handler must be the guarded form — measure
    // from the `caches.open` call itself, because the comment above it
    // is deliberately long and a fixed window would miss it.
    for (const fn of ["cacheFirst", "networkFirst"]) {
      const at = sw.indexOf(`async function ${fn}(`);
      expect(at).toBeGreaterThan(-1);
      const body = sw.slice(at, at + 2000);
      const openAt = body.indexOf("cache = await caches.open");
      expect(openAt, `${fn} has no caches.open at all`).toBeGreaterThan(-1);
      expect(body.slice(Math.max(0, openAt - 30), openAt), `${fn} opens the cache unguarded`)
        .toMatch(/try \{/);
    }
  });
});
