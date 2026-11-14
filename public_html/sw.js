/* ═══════════════════════════════════════════════════════════════════════
   sw.js — the offline layer.

   Measured before this existed (scripts/offline_audit.py, two
   scenarios, fresh browser profile):

     A. WAN down — xyzo.org reachable, every external host blocked:
        the page booted, 39 local scripts loaded, /api/health 200 and
        /data/temp/meta.json 200 — but **0 of 72 basemap tiles loaded**
        and NO error was shown. The app ran perfectly against an empty
        black rectangle.

     B. fully offline — the navigation itself failed (net::ERR_FAILED):
        nothing had ever been cached, so there was no page to boot.

   This closes both, within the honest limits below.

   WHAT IS AND IS NOT ACHIEVABLE
   ─────────────────────────────
   ✓ The app shell survives: it was already all-local (index.html has no
     external <script>/<link> at all — verified), so once a copy is
     cached the page boots with no network.
   ✓ Local data overlays survive: /data/* is static and versioned by its
     ?v= token, so cache-first is safe.
   ✓ Previously-viewed map tiles survive: the runtime tile cache keeps
     whatever the browser already fetched, so the area you were looking
     at still draws.
   ✗ A brand-new area has no tiles on first offline use. Making that work
     would mean precaching the world — millions of tiles. Not attempted,
     and the offline banner says so rather than pretending otherwise.
   ✗ Live news goes stale: /api/* falls back to the last response, which
     is data, not freshness. The banner must say "last fetched", not
     "up to date".

   Caches are namespaced by VERSION. Bump it to invalidate everything;
   the activate step drops the old ones so a stale shell cannot outlive
   a deploy.
   ═══════════════════════════════════════════════════════════════════════ */
const VERSION = "xyzo-offline-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const API_CACHE = `${VERSION}-api`;
const TILE_CACHE = `${VERSION}-tiles`;

const TILE_HOSTS = [
  "arcgisonline.com",      // Esri basemap — the one that matters most
  "cartocdn.com",          // Carto dark basemap variant
  "gibs.earthdata.nasa.gov",
  "macrostrat.org",
  "mrdata.usgs.gov",
  "data.apps.fao.org",     // WorldPop population WMTS
  "sos.noaa.gov",
  "tile.openstreetmap.org",
  "openmaptiles.org",      // the globe's glyphs
];

// A bounded tile cache. Unbounded, it would eat the origin's storage
// quota and then the browser would evict EVERYTHING including the shell
// — the one thing that must never go. Keep it modest and prefer losing
// an old tile over losing the page.
const TILE_LIMIT = 400;

// The same argument, for DATA_CACHE: it holds every /data tile AND the
// multi-MB probe grids (soil alone is 12.9 MB), so left alone it is the
// cache most likely to spend the origin's quota — and a spent quota is
// what made `cache.put` reject and fail live requests (see cacheFirst).
// ~2000 entries is several heavy sessions' worth of tiles; the trim is
// oldest-first, so the boot-fetched grids are what go, and a reader
// loses an offline copy of a grid rather than an offline copy of the
// page.
const DATA_LIMIT = 2000;

function isTileHost(url) {
  return TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
}

async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  // Delete oldest-first; Cache API preserves insertion order.
  for (const key of keys.slice(0, keys.length - limit)) {
    await cache.delete(key);
  }
}

// ── amortise the trim ──────────────────────────────────────────────────
//
// `trim()` costs a `cache.keys()` — an array of EVERY request in the
// cache — and the handlers used to call it after every single put. With
// a 2000-entry cache and a few hundred tiles a screen that is
// O(entries × tiles): seconds of pure bookkeeping, on the critical path
// of the very tiles it is meant to serve. A count cap needs slack
// anyway (the cache may sit at limit+1), so trim every 64th put and let
// it catch up then.
const TRIM_EVERY = 64;
const trimPuts = Object.create(null);   // cacheName -> puts since last trim
async function maybeTrim(cacheName, cache, limit) {
  if (!limit) return;
  const n = (trimPuts[cacheName] || 0) + 1;
  if (n < TRIM_EVERY) { trimPuts[cacheName] = n; return; }
  trimPuts[cacheName] = 0;
  try { await trim(cache, limit); } catch (_) { /* quota: leave it be */ }
}

/**
 * Fail the request as an ordinary NETWORK error.
 *
 * Never `throw` out of a handler: `respondWith(promise)` rejecting is
 * reported by Firefox as
 *
 *   A ServiceWorker intercepted the request and encountered an
 *   unexpected error.  sw.js:<line>
 *
 * — for a perfectly ordinary failure. The common one is an ABORT:
 * Leaflet drops a tile when you pan, and a reload cancels whatever is
 * in flight, so a page load routinely aborts a dozen image fetches. The
 * page sees the same outcome either way (the fetch failed); only the
 * blame moves, from the worker back to the network where it belongs.
 */
function networkError() {
  return Response.error();
}

/**
 * Fail a TILE as a missing tile, not as an error.
 *
 * Firefox reports an ERROR response exactly the way it reports a
 * rejected promise:
 *
 *   Failed to load 'https://xyzo.org/api/tile/rain/…'. A ServiceWorker
 *   intercepted the request and encountered an unexpected error.
 *   sw.js:416:11
 *
 * …and the common cause is an ABORT, not a failure: the globe's raster
 * source and Leaflet both drop in-flight tiles when the view changes, so
 * a pan or a zoom cancels a dozen fetches as a matter of course. The
 * caller has already cancelled — it discards whatever comes back — so
 * the body never matters; only handing the worker an "error" does.
 *
 * A 1×1 transparent PNG costs nothing and is the SAME answer the
 * tileMirror route gives for a tile that does not exist: the cell is
 * empty, the console stays clean, and a real network failure elsewhere
 * (scripts, JSON) still uses Response.error() so it remains visible.
 */
const TILE_FALLBACK_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);
function tileFallback() {
  return new Response(TILE_FALLBACK_PNG, {
    status: 200,
    headers: { "Content-Type": "image/png", "X-Tile-Mirror": "cancelled_or_unreachable" },
  });
}

/**
 * The onError for /data/ — images only.
 *
 * /data/ serves two very different things: PNG tiles (a climate or soil
 * pyramid, loaded by <img>) and .bin grids (a raw Float field, read with
 * arrayBuffer()). Both are cancelled by an ordinary pan or by switching
 * the layer off, and both would print the Firefox line above.
 *
 * But only ONE of them may be answered with a picture: a transparent PNG
 * handed to a grid fetch decodes as 68 bytes of garbage, and the layer
 * would report a wrong-shaped grid instead of a missing one. So images
 * degrade to the house placeholder (the same answer the image proxy
 * gives for a picture that is gone at the publisher), and everything
 * else keeps Response.error() so a real failure still reaches the
 * layer's own error handling — the wind grid's reload-retry, for one,
 * is built on that catch.
 */
const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|avif|svg|ico)$/i;
function dataFallback(_err, request) {
  let path = "";
  try { path = new URL(request.url).pathname; } catch (_) { return null; }
  return IMAGE_EXT.test(path) ? tileFallback() : null;
}

async function cacheFirst(request, cacheName, limit, onError) {
  // A CACHE PROBLEM MUST NEVER FAIL THE REQUEST.
  //
  // Every await in here can reject: `caches.open` once the origin's
  // quota is spent, `cache.match` if an entry is unreadable, and
  // `cache.put` when there is no room left to write — DATA_CACHE holds
  // every /data tile PLUS multi-MB grids, and a count cap (DATA_LIMIT)
  // cannot express a BYTE budget, so a put can still hit the browser's
  // quota. Before this they propagated straight out of the handler into
  // `event.respondWith(...)`, and Firefox logged:
  //
  //   A ServiceWorker intercepted the request and encountered an
  //   unexpected error.  sw.js:292:11
  //
  // …while a perfectly good network answer was sitting in hand. The
  // fetch FAILED, the Live Feed banner went up, and a hard refresh —
  // which bypasses the worker entirely — "fixed" it. Degrading to "no
  // offline copy" is the correct behaviour; failing the page is not.
  let cache = null;
  try {
    cache = await caches.open(cacheName);
  } catch (_) {
    cache = null;   // no usable cache: still serve from the network
  }

  if (cache) {
    try {
      const hit = await cache.match(request, { ignoreVary: true });
      // AN OPAQUE CACHED RESPONSE MUST NOT ANSWER A CORS REQUEST.
      //
      // The cache is keyed on the URL and ignores the request's MODE. A
      // cross-origin tile loaded through an <img> element is a no-cors
      // request and its response is opaque (status 0, no headers). That
      // opaque response is stored under the tile's URL — and a later
      // fetch() of the SAME url (mode "cors") then gets the opaque
      // response back from the cache, which Chromium rejects outright:
      //
      //   "An 'opaque' response was used for a request whose type is not
      //    no-cors"
      //
      // The Macrostrat geology layer is the case that bites: its TILE url
      // is in TILE_HOSTS, so the tile is cached opaquely, and its point
      // API lives on the same host — so a fetch() of it can be answered by
      // the wrong kind of response.
      //
      // So: an opaque entry may only answer a no-cors request. Anything
      // else goes to the network.
      if (hit && !(hit.type === "opaque" && request.mode !== "no-cors")) return hit;
    } catch (_) {
      /* unreadable entry — treat it as a miss and go to the network */
    }
  }

  // A network failure here is reported to the PAGE, not swallowed — but
  // as a network error rather than as a rejected promise (see
  // networkError): the asset really did fail, and the caller should see
  // exactly what it would have seen with no worker at all.
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    // A cancelled request is not a failed one — see onError/tileFallback.
    if (onError) {
      const alt = onError(err, request);
      if (alt) return alt;
    }
    return networkError();
  }
  // Only store successful, non-opaque-breaking responses. Opaque tile
  // responses (status 0) are exactly what an <img> fetch yields, and
  // they are the point of this cache.
  if (cache && response && (response.ok || response.type === "opaque")) {
    try {
      await cache.put(request, response.clone());
      await maybeTrim(cacheName, cache, limit);
    } catch (_) {
      // Full, or this entry is uncacheable. THE RESPONSE STILL STANDS —
      // we simply have no offline copy of it this time.
    }
  }
  return response;
}

async function networkFirst(request, cacheName, limit, onError) {
  // THE CACHE IS NEVER ALLOWED TO FAIL THE REQUEST — this is the
  // handler behind /api/*, i.e. behind `/api/health`, which is the
  // probe the Live Feed banner is built on. `caches.open` used to sit
  // OUT here, outside any try, and `cache.put` sat inside the try but
  // then fell through to a `throw err` when nothing was cached — so a
  // spent origin quota rejected the promise handed to
  // `event.respondWith(...)`, and Firefox printed:
  //
  //   A ServiceWorker intercepted the request and encountered an
  //   unexpected error.  sw.js:292:11
  //
  // …for a response the network had already produced successfully. The
  // request failed, the banner said the data was unavailable, and a
  // hard refresh — which bypasses the worker — "fixed" it.
  let cache = null;
  try {
    cache = await caches.open(cacheName);
  } catch (_) {
    cache = null;   // no usable cache: still fetch, still answer
  }

  try {
    const response = await fetch(request);
    // NEVER cache a stream. `cache.put` waits for the response BODY to
    // finish, and an SSE body finishes only when the server closes it —
    // so awaiting it here meant the response was never handed to the
    // page, and /api/feed/live/stream hung indefinitely: the Live Feed
    // sat on "loading…" for every visitor once the worker controlled the
    // page. Streams are returned straight through; they are live data,
    // and there is nothing useful to replay anyway.
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const isStream = type.includes("text/event-stream");
    // A tile that does not exist yet is answered with a transparent
    // placeholder (HTTP 200 + X-Tile-Mirror: placeholder). Caching THAT
    // would pin the hole: the origin may well have the tile an hour
    // later, and the worker would go on serving the blank.
    const isPlaceholder =
      (response.headers.get("x-tile-mirror") || "").toLowerCase().startsWith("placeholder");
    if (cache && response.ok && !isStream && !isPlaceholder) {
      try {
        await cache.put(request, response.clone());
        // Amortised — see maybeTrim: an O(entries) keys() after every
        // put is seconds of bookkeeping on a screenful of tiles.
        await maybeTrim(cacheName, cache, limit);
      } catch (_) {
        // Quota, or an entry this cache refuses. THE RESPONSE IS
        // ALREADY IN HAND — a failed cache write must not discard it.
        // This is the line that turns "the cache is full" into "the
        // site still works".
      }
    }
    return response;
  } catch (err) {
    // Offline: the last good answer is better than an error page, but
    // it is STALE — the caller's banner is what tells the reader so.
    //
    // Exact match first. Then ignore the QUERY STRING, because several
    // of our endpoints carry a per-request timestamp: /api/feed/live
    // sends `since=<ISO now>`, so its URL is unique on every page load
    // and an exact-only lookup NEVER matches — the Live Feed sat on
    // "loading…" forever while the health probe (a stable URL) happily
    // answered from cache. A stale feed beats an endless spinner, and
    // the banner already says the data is "already downloaded".
    if (cache) {
      try {
        const hit = (await cache.match(request, { ignoreVary: true })) ||
          (await cache.match(request, { ignoreVary: true, ignoreSearch: true }));
        if (hit) return hit;
      } catch (_) {
        /* the cache is unusable — fall through and report the network error */
      }
    }
    // Only a real network failure reaches here — there is no cached copy
    // to fall back to. Report it as a NETWORK error rather than letting
    // the promise reject (see networkError): the page's own failure
    // handling then runs exactly as it would without a worker, and
    // Firefox stops blaming the worker for an ordinary abort.
    //
    // …UNLESS the caller asked for a benign substitute: an aborted tile
    // is a normal consequence of panning, and Firefox reports the error
    // response below exactly as it would a rejection.
    if (onError) {
      const alt = onError(err, request);
      if (alt) return alt;
    }
    return networkError();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // The document itself is the manifest: fetch it, then pull the local
    // assets it references. A hand-maintained list would drift the moment
    // a new layer ships — the same trap as the hand-maintained overlay
    // tables elsewhere in this codebase.
    //
    // TWO RULES, both learned by watching install never finish:
    //
    // 1. SKIP DYNAMIC ENDPOINTS. The help page carries plain <a> links to
    //    `/api/pins/map?bbox=…` and `<form action="/search/results">`;
    //    the ref regex strips their query strings, so the precache asked
    //    for `/api/pins/map` with NO bbox — which does not answer, it
    //    HANGS. One pending fetch inside Promise.all and the install
    //    event never settles, so the worker stayed `installing` forever,
    //    never activated, and offline navigation had nothing to serve
    //    (measured: active=false installing=true at 9s and still at 20s).
    // 2. BOUND EVERY FETCH. One slow asset must cost seconds, never the
    //    whole worker — a partially warm shell beats no shell at all.
    const SKIP = ["/api/", "/search/results"];
    const FETCH_TIMEOUT_MS = 8000;
    const bounded = (p, ms) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("precache timeout")), ms)),
    ]);

    try {
      const doc = await fetch("/index.html", { cache: "reload" });
      if (doc.ok) await shell.put("/index.html", doc.clone());
      const text = await doc.clone().text();
      const refs = [...text.matchAll(/(?:src|href)="([^"?]+)(?:\?[^"]*)?"/g)]
        .map((m) => m[1])
        .filter((p) => p.startsWith("/") && !p.startsWith("//"))
        // only our own origin's assets; the canonical link is absolute
        .filter((p) => !p.includes("://"))
        .filter((p) => !SKIP.some((s) => p.startsWith(s)));
      await Promise.all([...new Set(refs)].map(async (p) => {
        try {
          const r = await bounded(fetch(p, { cache: "reload" }), FETCH_TIMEOUT_MS);
          if (r.ok) await shell.put(p, r.clone());
        } catch (_) { /* one missing/slow asset must not fail the install */ }
      }));
      const root = await bounded(fetch("/index.html", { cache: "reload" }), FETCH_TIMEOUT_MS);
      if (root.ok) await shell.put("/", root.clone());
    } catch (_) { /* offline install: nothing to precache, runtime fills in */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith("xyzo-") && !n.startsWith(VERSION))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // ── NEVER INTERCEPT A STREAM ─────────────────────────────────────────
  //
  // An `EventSource` request must reach the browser untouched. A service
  // worker that wraps one in `respondWith()` turns every ABORT — the
  // reader navigates, the tab is hidden, the server closes the
  // connection — into a console line the reader can neither silence nor
  // act on:
  //
  //   "Failed to load 'https://xyzo.org/api/feed/live/stream?…'.
  //    A ServiceWorker intercepted the request and encountered an
  //    unexpected error.  sw.js:232:11"
  //
  // **The stream itself was fine** — the Live Feed reconnected and
  // carried on — but the error was printed in the reader's console on
  // every visit, and it pointed at the worker as if the worker were
  // broken.
  //
  // The fix is to NOT respond at all: no `respondWith` means the browser
  // handles the EventSource natively, and an abort is then the browser's
  // own business — silent, as it should be. The `Accept` header is the
  // test, because it is what makes the request a stream in the first
  // place.
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) return;

  // ── navigation: network first, fall back to the cached shell ────────
  // Without this a fully-offline visit has nothing to boot from at all
  // (measured: net::ERR_FAILED on the document itself).
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        await cache.put("/index.html", response.clone());
        return response;
      } catch (_) {
        const cache = await caches.open(SHELL_CACHE);
        const hit = (await cache.match("/index.html")) || (await cache.match("/"));
        if (hit) return hit;
        throw new Error("offline and no cached shell");
      }
    })());
    return;
  }

  // ── mirrored remote tiles: network first, BOUNDED ────────────────────
  //
  // These are tiles, not API answers: /api/tile/mirror/… (the basemaps
  // and the FAO/Macrostrat overlays), /api/tile/fao-rivers/… and
  // /api/tile/rain/…. Putting them in API_CACHE would be a leak — that
  // cache is UNBOUNDED and one view of a 15-overlay link is ~500 tiles,
  // which is the quota blowout Q-N20 records. They go in the bounded
  // TILE_CACHE instead.
  //
  // It is also what keeps the basemap alive OFFLINE now that the client
  // asks us rather than the remote hosts: the external-host branch
  // below never sees them any more, so without this the worker would
  // hold no imagery at all and a network outage would give a blank map.
  //
  // Network-FIRST (not cache-first) because the mirror is the freshness
  // authority: it revalidates each tile against its origin on a TTL, and
  // a cache-first worker would answer from here forever instead. Within
  // the browser's own max-age the fetch below is answered by the HTTP
  // cache without touching the network anyway.
  if (sameOrigin && url.pathname.startsWith("/api/tile/")) {
    event.respondWith(networkFirst(request, TILE_CACHE, TILE_LIMIT, tileFallback));
    return;
  }

  // ── our own API: network first, stale fallback ──────────────────────
  if (sameOrigin && url.pathname.startsWith("/api/")) {
    // A REJECTION MUST NEVER ESCAPE respondWith.
    //
    // Firefox reports a promise that rejects inside respondWith as a
    // load failure BLAMED ON THE WORKER, quoting this very call site:
    //
    //   Failed to load 'https://xyzo.org/api/pins/map?bbox=…'.
    //   A ServiceWorker intercepted the request and encountered an
    //   unexpected error.  sw.js:491:11
    //
    // The reader can neither silence nor act on that line, and it says
    // the worker is broken when it is not. networkFirst() guards every
    // await it makes (a spent quota, an unreadable entry, a rejected
    // fetch all degrade to "no offline copy"), but a guard list is only
    // as complete as the day it was written — one future edit that
    // throws outside a try would bring the line straight back. So the
    // last line of defence sits HERE, at the call site, where it cannot
    // be bypassed by anything inside the function.
    //
    // The fallback is `networkError()`, which is exactly what the
    // failure path inside networkFirst already returns — so the page
    // sees the same TypeError it would have seen anyway and every
    // caller's `catch` keeps working. This guard changes the CONSOLE,
    // not the contract.
    event.respondWith(networkFirst(request, API_CACHE).catch(() => networkError()));
    return;
  }

  // ── our own static data: cache first (versioned by ?v=) ─────────────
  //
  // EXCEPT a meta.json. Those carry the PROVENANCE — the composite's
  // own date, the attribution, the licence, the speed range — so a
  // stale copy served from the cache is a lie the reader cannot see.
  // The ocean-current overlay's meta is the case that bites: it now
  // carries `source_date`, and the layer's legend prints the field's
  // age, so a cached meta without it would silently drop the whole
  // "this field is N years old" line. They are a few hundred bytes,
  // so they go NETWORK-FIRST with the cache as the offline fallback.
  if (sameOrigin && url.pathname.startsWith("/data/")) {
    if (url.pathname.endsWith(".json")) {
      event.respondWith(networkFirst(request, DATA_CACHE));
    } else {
      // Bounded — see DATA_LIMIT. Grids are tens of MB and tiles are
      // hundreds of entries; without a cap this is the cache that
      // spends the quota first.
      event.respondWith(cacheFirst(request, DATA_CACHE, DATA_LIMIT, dataFallback));
    }
    return;
  }

  // ── our own assets: cache first ─────────────────────────────────────
  if (sameOrigin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── external tiles: cache first, bounded ────────────────────────────
  // This is what keeps the map from being a black rectangle when the WAN
  // drops: 0 of 72 basemap tiles loaded in the audit. First visit to an
  // area while offline still has nothing — say so in the banner rather
  // than precaching the world.
  if (isTileHost(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE, TILE_LIMIT, tileFallback));
  }
  // anything else (analytics, remote docs) is left to the browser.
});
