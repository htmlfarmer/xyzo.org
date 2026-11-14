/**
 * The hard-refresh button, and the row-sort that must not loop.
 *
 * TWO THINGS THIS FILE EXISTS FOR.
 *
 * 1. **`*.js` is served `immutable` for a year** (the Caddyfile's
 *    `@staticAssets` rule), so a NORMAL RELOAD cannot replace a stale
 *    `app.js`: the browser holds that URL and never asks again. If a
 *    deploy edited a file without bumping its `?v=` token, the fresh
 *    `index.html` (it is `no-cache`) still points at the same stale
 *    URL, and only Ctrl+Shift+R fixes it — which is the advice the
 *    owner wanted to be able to give. A page CAN do that itself:
 *    `fetch(url, { cache: "reload" })` bypasses the HTTP cache AND
 *    replaces the stored entry, so priming every script and stylesheet
 *    from the network first leaves fresh bytes behind the immutable
 *    URL.
 *
 * 2. **`appendChild` on a node that is already in place is STILL a
 *    childList mutation** — it removes and re-inserts. The overlay-row
 *    sorter used to re-append an unchanged list, which re-fired its own
 *    MutationObserver, which scheduled another sort… measured 47
 *    mutations in 2 s over a 32-row list, i.e. the rows were moving
 *    ~23×/second while nothing changed. Two consequences: it burned the
 *    frame budget (and `autoQuality()` sheds particles when the frame
 *    rate drops, so the wind animation thinned out for no reason), and
 *    **moving a `<select>` closes its open popup** — which is why the
 *    overlay palette "hid too quickly and wouldn't let me select it".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const offlineJs = readFileSync(join(root, "offline.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const stylesCss = readFileSync(join(root, "styles.css"), "utf8");

describe("the hard refresh", () => {
  test("has a button in the TOOLS section of the control menu", () => {
    expect(indexHtml).toMatch(/id="ctrl-refresh-btn"/);
    // Next to How to — the section a reader opens when they want help.
    const at = indexHtml.indexOf('id="ctrl-refresh-btn"');
    const howTo = indexHtml.indexOf('id="ctrl-tour-btn"');
    expect(at).toBeGreaterThan(howTo);
    expect(indexHtml.slice(at, at + 900)).toMatch(/Hard refresh/);
  });

  test("names the keyboard shortcut, because that is what people are told to press", () => {
    expect(appJs).toMatch(/Ctrl\+Shift\+R/);
    expect(appJs).toMatch(/Cmd\+Shift\+R/);
  });

  test("primes every asset from the NETWORK before reloading", () => {
    // `cache: "reload"` is the whole trick: it bypasses the HTTP cache
    // AND replaces the stored entry, which is what makes a subsequent
    // reload pick up fresh bytes behind an `immutable` URL.
    expect(offlineJs).toMatch(/async function hardRefresh\(\)/);
    expect(offlineJs).toMatch(/cache: "reload"/);
    expect(offlineJs).toMatch(/script\[src\], link\[rel=stylesheet\]\[href\]/);
    expect(offlineJs).toMatch(/u\.origin === location\.origin/);
    // It is defined in offline.js, NOT app.js — see the ordering test
    // below for why that is the whole point of the feature.
    expect(appJs).not.toMatch(/async function hardRefresh\(\)/);
  });

  test("offline.js loads BEFORE app.js, so the button works when app.js does not", () => {
    // `window.hardRefresh` must already be set by the time anything in
    // app.js runs — and, more to the point, by the time a reader whose
    // app.js never ran reaches the notice's "Reload fresh" button.
    // app.js is `defer`, so the tags execute in document order.
    const off = indexHtml.indexOf("offline.js?");
    const app = indexHtml.indexOf("app.js?");
    expect(off).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(off);
    expect(indexHtml.slice(off, app)).toMatch(/defer/);
    // …and offline.js must actually be on the page.
    expect(indexHtml).toMatch(/<script src="offline\.js\?v=\d+/);
  });

  test("drops the service worker's shell too", () => {
    // The SW caches the app shell, so a stale copy would survive an
    // HTTP-cache refresh. It re-registers on the next load.
    expect(offlineJs).toMatch(/navigator\.serviceWorker\.getRegistrations/);
    expect(offlineJs).toMatch(/for \(const k of await caches\.keys\(\)\) await caches\.delete\(k\)/);
  });

  test("reloads even if the priming fails, and keeps the map's hash", () => {
    // A failure must not strand the reader on a dead button — reload
    // anyway, which is still better than nothing. It is `reload()` and
    // not `location.replace(...)`: the hash IS the map's state
    // (`#lat,lng,zoom/overlay=…`), so a hard refresh that discarded it
    // would fix one problem by causing another.
    const fn = offlineJs.slice(offlineJs.indexOf("async function hardRefresh()"));
    expect(fn).toMatch(/location\.reload\(\);/);
    expect(fn).not.toMatch(/location\.replace\(/);
    // The whole thing runs inside try/catch, so an odd DOM or a blocked
    // fetch cannot throw past the reload.
    expect(fn).toMatch(/catch \(_\) \{/);
  });

  test("lights a badge when the server has a newer build", () => {
    // The suggestion: `index.html` is `no-cache`, so it always carries
    // the CURRENT tokens. Comparing its app.js?v= with the one this
    // page booted from says a deploy landed while the tab was open.
    expect(appJs).toMatch(/function checkForNewVersion\(\)/);
    expect(appJs).toMatch(/fetch\("\/index\.html", \{ cache: "reload" \}\)/);
    expect(appJs).toMatch(/ctrl-refresh-badge/);
    expect(indexHtml).toMatch(/id="ctrl-refresh-badge"/);
  });

  test("the badge has a style and cannot be left visible by accident", () => {
    expect(stylesCss).toMatch(/\.ctrl-refresh-badge \{/);
    expect(stylesCss).toMatch(/\.ctrl-refresh-badge\[hidden\] \{ display: none !important; \}/);
  });
});

describe("the overlay rows are sorted WITHOUT looping", () => {
  test("returns early when the order is already right", () => {
    // THE BUG: appendChild on a node already in place is still a
    // childList mutation, so re-appending an unchanged list re-fires
    // the observer. Measured 47 mutations in 2 s over 32 rows.
    const fn = appJs.slice(appJs.indexOf("function applyOverlayRowOrder()"));
    const early = fn.slice(0, fn.indexOf("const frag ="));
    expect(early).toMatch(/if \(keyed\.every\(\(k, i\) => rows\[i\] === k\.el\)\) return;/);
  });

  test("the guard is BEFORE the append, not after it", () => {
    // A guard that ran after the mutation would still have moved every
    // node — and moving a <select> closes its open popup, which is why
    // the palette kept dismissing.
    const fn = appJs.slice(appJs.indexOf("function applyOverlayRowOrder()"));
    const guard = fn.indexOf("rows[i] === k.el");
    const append = fn.indexOf("list.appendChild(frag)");
    expect(guard).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(append);
  });

  test("the observer only watches childList", () => {
    // Reordering moves nodes; it does not change text or attributes.
    expect(appJs).toMatch(/observe\(_overlayList, \{ childList: true \}\)/);
  });
});
