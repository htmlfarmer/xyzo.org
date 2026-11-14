/* ═══════════════════════════════════════════════════════════════════════
   offline.js — service worker registration and an HONEST offline banner.

   Kept out of app.js on purpose: app.js was 8 bytes under its
   850,000-byte runaway ceiling, and this file needs none of its scope.

   TWO THINGS THE AUDIT FOUND (scripts/offline_audit.py):

   1. Nothing registered a service worker, so a fully-offline visit could
      not even load the document (net::ERR_FAILED on the navigation).
      sw.js fixes that; this file is what turns it on.

   2. The only offline signal was ApiHealth, which shows the API-down
      banner — and that banner's text is "System Upgrade in Progress …
      We are actively upgrading our server infrastructure". When the
      READER's connection has dropped, that is simply false: it blames
      our servers for their wifi. This file listens for online/offline
      directly and says what actually happened, and suppresses the
      misleading one while it is showing.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var BANNER_ID = "xyzo-offline-banner";

  // ── the DISMISS button ───────────────────────────────────────────────
  //
  // The banner sits across the TOP of the map, so it is in the way of
  // the very thing it is talking about — and it is a NOTICE, not a
  // blocker: nothing on the page depends on it. The reader asked for
  // an X, so there is an X.
  //
  // Dismissing it must ALSO stop it coming straight back: the tile
  // watcher fires on every failed batch of tiles, so a dismissed
  // banner that reappeared ten seconds later would be worse than no
  // button at all. The dismissal is remembered for the SESSION (a
  // reload in the same tab keeps it), and it is FORGOTTEN as soon as
  // the situation RESOLVES — the tiles come back, or the connection
  // returns — so a genuinely NEW outage warns the reader again.
  var DISMISS_KEY = "xyzo.offlineNoticeDismissed";

  function isDismissed() {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; }
    catch (_) { return false; }
  }

  function rememberDismissed(v) {
    try {
      if (v) sessionStorage.setItem(DISMISS_KEY, "1");
      else sessionStorage.removeItem(DISMISS_KEY);
    } catch (_) {}
  }

  function clearDismissal() {
    // A BOOT dismissal belongs to the boot situation, and that situation
    // is only resolved when the map actually APPEARS (healBoot). Every
    // other recovery path — the connection returning, the imagery coming
    // back — says nothing about it, and clearing the flag there would
    // hand the reader back a notice they had already dismissed: the
    // `load`/`online` sync runs `clearDismissal()` and the 45 s backstop
    // would re-show the banner on a page whose map never comes up.
    if (bootDismissed) return;
    try { sessionStorage.removeItem(DISMISS_KEY); } catch (_) {}
  }

  function log(...args) {
    if (window.XLog && typeof XLog.debug === "function") XLog.debug(...args);
  }

  // The X itself. A real <button> (so it is focusable and announced),
  // absolutely positioned to the right of the banner's text.
  var DISMISS_BUTTON =
    '<button type="button" class="xyzo-notice-dismiss" ' +
    'aria-label="Dismiss this notice" title="Dismiss">' +
    '\u2715</button>';

  // "Reload fresh" — the OFFER, next to the X.
  //
  // The reader who arrives at a stale map has ONE thing that fixes it:
  // a hard refresh. The button that does it exists (⚙ → TOOLS → Hard
  // refresh), but it is three clicks deep in a menu nobody opens when
  // the map looks wrong — and this banner is EXACTLY where a reader
  // with a stale map is standing. So the offer is made here.
  //
  // It calls this file's OWN hardRefresh() (defined just below) — so it
  // works even when app.js never ran, which is the case it exists for.
  var RELOAD_BUTTON =
    '<button type="button" class="xyzo-notice-reload" ' +
    'title="Re-download the map files and reload — or press Ctrl+Shift+R">' +
    'Reload fresh</button>';

  function wireReload(el) {
    var btn = el.querySelector(".xyzo-notice-reload");
    if (!btn || btn._xyzoWired) return;
    btn._xyzoWired = true;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      log("[offline] hard refresh requested");
      try {
        if (typeof window.hardRefresh === "function") {
          window.hardRefresh();
          return;
        }
      } catch (_) {}
      location.reload();
    });
  }

  // ── the hard refresh itself ──────────────────────────────────────────
  //
  // THIS LIVES HERE, NOT IN app.js. A normal reload cannot replace a
  // stale `app.js`: `*.js` is served `immutable` for a year, so the
  // browser holds that URL and never asks again — which is precisely
  // the state this page's Reload fresh button exists to break the reader
  // out of. So the refresh must work when **app.js is what is broken**
  // (a 500, a stale copy, a syntax error, a deploy that landed without a
  // token bump): it must be defined in a file that loads independently.
  // It used to be a module-level `hardRefresh()` in app.js, exported as
  // `window.hardRefresh` — and if app.js never ran, the button silently
  // degraded to `location.reload()`, which cannot bypass the immutable
  // cache and would have changed nothing.
  async function hardRefresh() {
    // Give the reader a sign the click registered — this takes a second
    // on a slow connection, and a button that does nothing for a second
    // reads as a dead button. (The element may not exist on a page whose
    // app.js never ran; that is exactly when this is being called.)
    var btn = document.getElementById("ctrl-refresh-btn");
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    try {
      // Re-request every script and stylesheet from the network rather
      // than the disk cache. `fetch` is used instead of reloading first
      // so the reload happens only after the fresh copies are confirmed:
      // on a flaky connection, reloading first would re-run the same
      // stale markup we are trying to replace.
      var urls = {};
      var els = document.querySelectorAll(
        "script[src], link[rel=stylesheet][href]");
      for (var i = 0; i < els.length; i++) {
        var raw = els[i].src || els[i].href;
        if (!raw) continue;
        var u;
        try { u = new URL(raw, location.href); } catch (_) { continue; }
        if (u.origin === location.origin) urls[u.href] = true;
      }
      await Promise.all(Object.keys(urls).map(function (u) {
        return fetch(u, { cache: "reload", credentials: "same-origin", keepalive: true })
          .then(function (r) { return r.ok; })
          .catch(function () { return false; });
      }));

      // The service worker caches the shell too, so a stale copy would
      // survive an HTTP-cache refresh. Drop it; it re-registers and
      // re-precaches on the next load. Unregister FIRST — deleting a
      // live worker's cache is immediately repopulated by its next fetch.
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        for (var _r of await navigator.serviceWorker.getRegistrations()) {
          await _r.unregister().catch(function () { return false; });
        }
      }
      if (window.caches && caches.keys) {
        for (const k of await caches.keys()) await caches.delete(k);
      }
    } catch (_) {
      // A failure here must not strand the reader on a dead button —
      // reload anyway, which is still better than nothing.
    }
    // Reload, not `location.replace`: the hash IS the map's state
    // (`#lat,lng,zoom/overlay=…`), and a hard refresh that threw the
    // reader's position away would fix one problem by causing another.
    location.reload();
  }
  // Export before the reload so the notice's button works even if app.js
  // never runs — which is the case the button exists for.
  window.hardRefresh = hardRefresh;

  function wireDismiss(el) {
    var btn = el.querySelector(".xyzo-notice-dismiss");
    if (!btn || btn._xyzoWired) return;
    btn._xyzoWired = true;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      // Was this the BOOT notice? Record it before the flags are
      // cleared — clearDismissal() refuses to forget a boot dismissal
      // until the map itself appears, so an unrelated recovery (the
      // connection returning, the imagery coming back) cannot hand it
      // back before the 45 s backstop fires.
      var wasBoot = bootReason;
      rememberDismissed(true);
      // The banner goes, and the reason goes with it: the watcher must
      // not think a tile notice or a boot notice is still up.
      tileReason = false;
      bootReason = false;
      if (wasBoot) bootDismissed = true;
      hide();
      log("[offline] notice dismissed");
    });
  }

  // ── the banner ────────────────────────────────────────────────────────
  function hide() {
    var el = document.getElementById(BANNER_ID);
    if (el) el.remove();
    tileReason = false;
    bootReason = false;
    // NOTE: the dismissal is NOT cleared here. hide() is also what the
    // dismiss button calls, and clearing the flag there would let the
    // very next failed tile batch put the banner back. The flag is
    // cleared where the situation genuinely RESOLVES instead — see
    // clearDismissal().
    // Let the API-health banner speak again: it was suppressed only
    // while we were claiming the outage was the reader's connection.
    var api = document.getElementById("api-down-banner");
    if (api) api.style.display = "";
  }

  var OFFLINE_HTML =
    "<strong>You're offline.</strong> " +
    "Live pins and search need a connection — what you can still see " +
    "is the map and the data already downloaded. " +
    "It will reconnect by itself.";

  function repaintOffline(el) {
    el.innerHTML = OFFLINE_HTML + RELOAD_BUTTON + DISMISS_BUTTON;
    wireDismiss(el);
    wireReload(el);
  }

  function show(online) {
    var el = document.getElementById(BANNER_ID);
    if (online) {
      // A BOOT failure is not resolved by being online — the connection
      // was never the problem. Retire the notice if the map has since
      // appeared; if an "you're offline" message had replaced our
      // wording, put ours back (the reason is still true); otherwise
      // leave it standing.
      if (bootReason) {
        healBoot();
        if (bootReason) {
          var bel = document.getElementById(BANNER_ID);
          if (bel) { tileReason = false; repaintBoot(bel); }
        }
        return;
      }
      // The connection is back and there is no tile outage: the
      // situation has RESOLVED, so a dismissal is forgotten — a later,
      // genuinely new outage must warn the reader again.
      if (!tileReason) clearDismissal();
      // Being online does NOT clear a TILE notice. A dead basemap host
      // with a healthy connection is exactly "you're online, the imagery
      // isn't" — and window `load` calls sync() once every image has
      // settled, so an unconditional hide here erased the notice moments
      // after it appeared (first audit run: log said "shown", probe said
      // false). The notice clears when tiles recover, in tileTick.
      if (tileReason) return;
      hide();
      return;
    }
    // If a TILE notice or a BOOT notice is up and the connection has now
    // actually dropped, replace its wording: "you're offline" explains
    // more than either, and the early return below would otherwise keep
    // the weaker claim on screen. bootReason STAYS true — only the
    // wording is demoted — so reconnecting restores our notice instead of
    // dropping it (see the online branch above).
    if (el && tileReason) {
      tileReason = false;
      repaintOffline(el);
      return;
    }
    if (el && bootReason) {
      repaintOffline(el);
      return;
    }
    if (el) return;

    // The API-health banner is a separate claim ("our server is down").
    // Only one explanation should be on screen at a time, and ours is
    // the one we can actually prove from here.
    var api = document.getElementById("api-down-banner");
    if (api) api.style.display = "none";

    el = document.createElement("div");
    el.id = BANNER_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.cssText = [
      "position:fixed;top:0;left:0;right:0;z-index:10001",
      "background:linear-gradient(90deg,#3b1d1d,#1e1b4b)",
      "color:#f8fafc;padding:10px 46px 10px 18px",
      "font:13px/1.4 system-ui,-apple-system,sans-serif",
      "text-align:center",
      "border-bottom:1px solid rgba(245,158,11,.5)",
      "box-shadow:0 4px 16px rgba(0,0,0,.45)",
    ].join(";");
    repaintOffline(el);
    document.body.prepend(el);
    log("[offline] banner shown");
  }

  function sync() {
    show(navigator.onLine !== false);
  }

  // ── basemap imagery that cannot be reached ──────────────────────────
  // A dead TILE HOST is not "offline": your connection, the API and the
  // local assets are all fine, so navigator.onLine stays true and no
  // offline banner is honest — yet the map is a black rectangle. Measured
  // in the audit's WAN-down phase: 0 of 72 basemap tiles loaded and
  // NOTHING said so; the app ran perfectly against an empty box.
  //
  // So watch Leaflet's own tiles for failures. Counting is over a
  // rolling window and requires failures to OUTNUMBER successes, because
  // a couple of flaky tiles in a healthy load is normal and must not
  // cry wolf; a load where most tiles fail is not.
  var tileFails = [];
  var tileOks = [];
  var WINDOW_MS = 10000;
  var tileReason = false;   // is the banner up BECAUSE of tiles?

  function isLeafletTile(el) {
    return !!el && el.tagName === "IMG" &&
      !!(el.classList && el.classList.contains("leaflet-tile"));
  }

  function externalOrigin(src) {
    try {
      return new URL(src, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  function tileTick(ok) {
    var now = Date.now();
    (ok ? tileOks : tileFails).push(now);
    var cut = now - WINDOW_MS;
    tileFails = tileFails.filter(function (t) { return t >= cut; });
    tileOks = tileOks.filter(function (t) { return t >= cut; });

    var f = tileFails.length;
    var o = tileOks.length;
    if (f >= 8 && f > o) {
      showTiles();
    } else if (tileReason && o >= 8 && o > f) {
      // Imagery recovered — take the notice down rather than leaving a
      // stale warning over a map that is now drawing. Successes must
      // DOMINATE, not merely exist: with 48 failures and 24 successes a
      // fixed `o >= 6` hid the notice again seconds after showing it,
      // which is how the first audit run reported "banner=False" while
      // the log said "tile notice shown".
      tileReason = false;
      // The imagery came back — the situation RESOLVED, so a dismissal
      // is forgotten and a future outage warns again.
      clearDismissal();
      if (navigator.onLine !== false) hide();
    }
  }

  function showTiles() {
    if (tileReason) return;
    // The reader has already read this notice and sent it away. It
    // must not come back on the next failed tile batch.
    if (isDismissed()) return;
    // An actual offline state outranks this one: it explains more.
    if (navigator.onLine === false) return;
    // And a map that never started outranks it too — no imagery and no
    // map at all are different problems, and ours is the deeper one.
    if (bootReason) return;
    tileReason = true;
    var el = document.getElementById(BANNER_ID);
    if (el) { repaintTiles(el); return; }
    var api = document.getElementById("api-down-banner");
    if (api) api.style.display = "none";
    el = document.createElement("div");
    el.id = BANNER_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.cssText = [
      "position:fixed;top:0;left:0;right:0;z-index:10001",
      "background:linear-gradient(90deg,#3b1d1d,#1e1b4b)",
      "color:#f8fafc;padding:10px 46px 10px 18px",
      "font:13px/1.4 system-ui,-apple-system,sans-serif",
      "text-align:center",
      "border-bottom:1px solid rgba(245,158,11,.5)",
      "box-shadow:0 4px 16px rgba(0,0,0,.45)",
    ].join(";");
    repaintTiles(el);
    document.body.prepend(el);
    log("[offline] tile notice shown");
  }

  // ── the MAP ITSELF never came up ──────────────────────────────────────
  // The two watchers above prove what is MISSING from the page (a
  // connection, imagery). This one proves what is missing from the APP:
  // app.js returned a 500, threw on the first line, was served stale
  // against a bumped token, or never finished downloading — in every one
  // of those cases the reader is looking at chrome over a blank rectangle
  // and NOTHING on the page says so. That is exactly the state where a
  // hard refresh is the fix, and it is the one case the offer could not
  // be made: `hardRefresh()` lived in app.js, so when app.js is what
  // failed, `window.hardRefresh` was undefined and the button degraded to
  // a plain reload that cannot bypass the `immutable` cache (it now lives
  // in this file — see the section above).
  //
  // THE SIGNAL IS `window._xyzoMap`. app.js is `defer`, so
  // `DOMContentLoaded` fires only once every deferred script has run or
  // failed; `_xyzoMap` is assigned at its top level the moment the
  // Leaflet map is constructed (not inside any callback) and is never
  // cleared. After DCL + a grace period it is therefore an exact test,
  // not a timing guess. If it ever appears later the notice takes itself
  // down (healBoot), so a merely SLOW boot cannot leave a false alarm
  // standing.
  var bootReason = false;     // is the banner up BECAUSE the map failed?
  var bootDismissed = false;  // the reader sent THIS notice away (this page)
  var scriptFailed = false;   // a same-origin parser <script> failed to load

  var BOOT_HTML =
    "<strong>The map didn't load.</strong> " +
    "The page opened but the map never started. A hard refresh " +
    "re-downloads its files — that fixes a stale copy; if it still " +
    "fails, the problem is on our side.";

  function repaintBoot(el) {
    el.innerHTML = BOOT_HTML + RELOAD_BUTTON + DISMISS_BUTTON;
    wireDismiss(el);
    wireReload(el);
  }

  function mapIsUp() {
    // Both, not either: `_xyzoMap` is the app's own evidence and `#map`
    // is the page's. Requiring the element keeps this honest if offline.js
    // is ever loaded by a page that has no map to fail to draw.
    try {
      return !!(window._xyzoMap && document.getElementById("map"));
    } catch (_) {
      return false;
    }
  }

  // The map arrived after we had already given up on it — take the
  // notice down AND forget the dismissal, so the NEXT genuine failure
  // warns again (the same rule the tile watcher uses: a dismissal
  // belongs to one resolved situation, not to all time).
  function healBoot() {
    if (!bootReason) return;
    if (!mapIsUp()) return;
    bootReason = false;
    // The map is up, so the situation is over — and with it the
    // reader's opt-out (both the in-memory one and the session flag
    // clearDismissal() now guards). A future failure warns again.
    bootDismissed = false;
    hide();
    clearDismissal();
    log("[offline] map came up — boot notice retired");
  }

  function showBoot() {
    if (bootReason) return;
    // Offline outranks everything: "you're offline" explains more than
    // "the map didn't start", and the reader can act on it.
    if (navigator.onLine === false) return;
    // The reader has read THIS notice and sent it away. Two flags: the
    // in-memory one survives whatever else recovers (see clearDismissal),
    // the session one survives a reload.
    if (bootDismissed) return;
    if (isDismissed()) return;
    // This claim outranks the tile one: no map at all is more
    // fundamental than no imagery, and tileTick would otherwise keep
    // repainting its own wording over ours. An element exists whenever
    // tileReason does (showTiles creates it), so this demotes it.
    var el = document.getElementById(BANNER_ID);
    if (el) tileReason = false;
    if (!el) {
      var api = document.getElementById("api-down-banner");
      if (api) api.style.display = "none";
      el = document.createElement("div");
      el.id = BANNER_ID;
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.style.cssText = [
        "position:fixed;top:0;left:0;right:0;z-index:10001",
        "background:linear-gradient(90deg,#3b1d1d,#1e1b4b)",
        "color:#f8fafc;padding:10px 46px 10px 18px",
        "font:13px/1.4 system-ui,-apple-system,sans-serif",
        "text-align:center",
        "border-bottom:1px solid rgba(245,158,11,.5)",
        "box-shadow:0 4px 16px rgba(0,0,0,.45)",
      ].join(";");
      document.body.prepend(el);
    }
    bootReason = true;
    repaintBoot(el);
    log("[offline] boot notice shown");
  }

  function probeBoot() {
    if (mapIsUp()) {
      healBoot();
      return;
    }
    showBoot();
  }

  function watchBoot() {
    // Only on a page that HAS a map element. Any other page loaded
    // offline.js (there is none today) would otherwise be told, forever,
    // that its map failed to load.
    if (!document.getElementById("map")) return;

    // ALWAYS wait for the REAL DOMContentLoaded — never branch on
    // `readyState`. **`readyState` is already `"interactive"` while defer
    // scripts are executing** (it flips before they run, and DCL fires
    // after them), so a readyState check here schedules the probe 6 s
    // after offline.js instead of after app.js has had its chance.
    // MEASURED: with app.js delayed 8 s by the network, that raised
    // "The map didn't load." at 6.8 s over a healthy map which then
    // appeared — a false alarm on a merely slow connection, which is the
    // one thing this must never do. DCL is the event that means every
    // defer script (app.js included) has run or failed, and it has NOT
    // fired by the time this file executes — offline.js is itself a
    // defer script above app.js — so the listener is always safe.
    //
    // A same-origin parser <script> that failed makes this an immediate
    // probe instead of the grace period: there is no point waiting when
    // we already know something broke. It is only a FLAG — probeBoot() is
    // what decides — so a failed non-critical script that still let
    // app.js build the map raises nothing. (Note it only catches a
    // failure that resolves AFTER this file ran; an instant 404 fires
    // during parsing, before any defer script, and is covered by the
    // grace period instead.)
    //
    // The grace period is pure MARGIN, not download time: DCL already
    // includes waiting out every byte of the 703 KB gzipped defer
    // payload (measured 0.8 s from navigation here, ~7 s at 100 KB/s),
    // and it fires only once app.js has executed.
    var GRACE_MS = 2000;
    function onReady() {
      setTimeout(probeBoot, scriptFailed ? 0 : GRACE_MS);
    }
    document.addEventListener("DOMContentLoaded", onReady, { once: true });

    // BACKSTOP for a script that never finishes (an infinite loop in a
    // defer script blocks DCL entirely, so onReady never runs). 45 s
    // clears the measured worst healthy case by a wide margin: the whole
    // defer payload is 703 KB gzipped, ~7 s of download at 100 KB/s and
    // ~1.4 s at 500 KB/s. A false alarm here is still self-correcting —
    // healBoot() retires the notice the moment the map appears.
    setTimeout(probeBoot, 45000);

    // Keep watching while the notice is up: the map may still be coming
    // (heal), and if it never does the notice stays — which is correct.
    setInterval(function () {
      if (bootReason) healBoot();
    }, 2000);
  }

  // THIS LISTENER IS REGISTERED AT PARSE TIME, NOT FROM init() — see the
  // note below. It sits in the boot section on purpose: nothing here
  // touches the DOM, so it is safe to run while the document is still
  // parsing (which is when offline.js itself runs).
  if (document.getElementById("map")) {
    window.addEventListener("error", function (e) {
      var t = e && e.target;
      // Only parser-inserted scripts: `async` is true for the chunks we
      // append at runtime (loadChunk sets it), so a missing OPTIONAL
      // overlay is filtered out — only a script the DOCUMENT needed to
      // boot counts. And only ours: an extension's script failing is not
      // our map failing.
      if (!t || t.tagName !== "SCRIPT" || t.async) return;
      if (!t.src) return;
      if (externalOrigin(t.src)) return;
      scriptFailed = true;
      log("[offline] same-origin script failed:", t.src);
    }, true);
  }

  function repaintTiles(el) {
    el.innerHTML =
      "<strong>Map imagery isn't loading.</strong> " +
      "The sites that serve the basemap can't be reached from here — " +
      "the pins, overlays and data you already have still work. " +
      "If the map looks out of date rather than empty, a hard refresh " +
      "re-downloads it." +
      RELOAD_BUTTON + DISMISS_BUTTON;
    wireDismiss(el);
    wireReload(el);
  }

  var tilesWatched = false;
  function watchTiles() {
    // Idempotent: init() can run from either the load handler or the
    // already-complete branch, and a duplicated listener would count
    // every failure twice and trip the threshold on a healthy load.
    if (tilesWatched) return;
    tilesWatched = true;
    // Capture phase: image load/error events do not bubble, so a
    // bubble-phase listener never sees them.
    window.addEventListener("error", function (e) {
      var t = e.target;
      if (!isLeafletTile(t) || !externalOrigin(t.src)) return;
      tileTick(false);
    }, true);
    window.addEventListener("load", function (e) {
      var t = e.target;
      if (!isLeafletTile(t) || !externalOrigin(t.src)) return;
      tileTick(true);
    }, true);
  }

  // ── the service worker ───────────────────────────────────────────────
  // Registered after load so it never competes with the first paint, and
  // guarded: a browser without SW support (or a file:// page) must not
  // throw during boot.
  function register() {
    if (!("serviceWorker" in navigator)) return;
    try {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(function (reg) { log("[offline] sw registered", reg.scope); })
        .catch(function (e) { log("[offline] sw register failed", e); });
    } catch (e) {
      log("[offline] sw register threw", e);
    }
  }

  function init() {
    if (typeof window === "undefined" || !document.body) return;

    // Fires on the transition itself; also poll once at start in case the
    // page loaded with the radio already down (the event has been and
    // gone by then, and navigator.onLine is the only thing that knows).
    window.addEventListener("online", function () {
      sync();
      // A recovered connection should refresh the live data rather than
      // leave the stale copy on screen with no explanation.
      try {
        if (typeof fetchLiveFeed === "function") fetchLiveFeed(true);
        if (typeof fetchPinsForViewport === "function") fetchPinsForViewport();
      } catch (_) {}
    });
    window.addEventListener("offline", function () { sync(); });
    window.addEventListener("load", function () {
      sync();
      register();
    });
    // Tile watching is independent of connectivity events: a dead basemap
    // host does not fire `offline`, which is exactly why it needs its own
    // signal. Boot watching is independent of BOTH for the same reason:
    // app.js failing to run fires neither.
    watchTiles();
    watchBoot();

    // If the page was opened offline, `load` may already have fired.
    if (document.readyState === "complete") {
      sync();
      register();
    } else {
      sync();
    }
  }

  window.XyzoOffline = { show: show, hide: hide, sync: sync, register: register, init: init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
