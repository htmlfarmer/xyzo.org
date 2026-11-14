/**
 * map-failed-notice.bun.test.js — "The map didn't load."
 *
 * THE OWNER'S ASK (2026-11-06): *"is there something we can do if we
 * detect the map isn't loading correctly to allow users to do a 'hard
 * refresh' and just have them click on something to help them … like a
 * popup that's closable and they can opt out for if needed"*.
 *
 * Two decisions were made with the owner before any code:
 *   1. EXTEND the top notice rather than add a second one — it already
 *      had the ✕, the remembered opt-out and the "Reload fresh" button,
 *      and it never blocks the map.
 *   2. Trigger ONLY when the map actually fails. The existing
 *      `checkForNewVersion()` badge stays where it is: raising this on
 *      every deploy would train people to dismiss it unread.
 *
 * WHAT WAS ACTUALLY MISSING was the DETECTION. Until now the notice
 * fired only on a connection or on failing basemap tiles — never on
 * app.js returning 500, throwing on line 1, or being served stale
 * against a bumped token. Those are precisely the states where a hard
 * refresh is the fix, and they were the one case where the fix was
 * unusable: `hardRefresh()` was a module-level function in app.js, so
 * when app.js never ran, `window.hardRefresh` was undefined and the
 * button degraded to a plain `location.reload()` — which CANNOT bypass
 * the `immutable` year-long cache and would have changed nothing.
 *
 * So this file pins three things: the offer exists and is closable, the
 * detection is exact rather than a timing guess, and the guard rails
 * learned from the tile notice's shipped bugs (an online event erasing
 * it, hide() clearing its own dismissal) hold for the new reason too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const offline = readFileSync(join(root, "offline.js"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "styles.css"), "utf8");

/** The section that owns the boot notice, from its header to repaintTiles. */
const bootSection = offline.slice(
  offline.indexOf("var bootReason"),
  offline.indexOf("function repaintTiles")
);
/** show() up to sync() — where the precedence rules live. */
const showBody = offline.slice(
  offline.indexOf("function show(online)"),
  offline.indexOf("function sync()")
);

describe("the offer itself", () => {
  test("says what happened and what fixes it, in the one notice", () => {
    expect(bootSection).toMatch(/<strong>The map didn't load\.<\/strong>/);
    // It promises a HARD refresh (re-downloads the files) and is honest
    // that a failure after that is ours, not the reader's cache.
    expect(bootSection).toMatch(/re-downloads its files/);
    expect(bootSection).toMatch(/the problem is on our side/);
    // Reused machinery, not a second notice: same button, same ✕.
    expect(bootSection).toMatch(/function repaintBoot\(el\)/);
    expect(bootSection).toMatch(/BOOT_HTML \+ RELOAD_BUTTON \+ DISMISS_BUTTON/);
  });

  test("it is closable, and a closed boot notice STAYS closed", () => {
    // wireDismiss carries the shared dismissal flag, so the ✕ works
    // without boot-specific code — but the reason flag must go with it,
    // or the watchers would think a notice is still up.
    expect(bootSection).toMatch(/function repaintBoot\(el\)/);
    const dismiss = offline.slice(offline.indexOf("function wireDismiss(el)"));
    const body = dismiss.slice(0, dismiss.indexOf("function hide()"));
    expect(body).toMatch(/rememberDismissed\(true\)/);
    expect(body).toMatch(/bootReason = false;/);
    // …and showBoot is gated on that flag.
    const showBoot = offline.slice(offline.indexOf("function showBoot()"));
    const showBootBody = showBoot.slice(0, showBoot.indexOf("function probeBoot()"));
    expect(showBootBody).toMatch(/if \(isDismissed\(\)\) return;/);
  });

  test("nothing can hand a dismissed boot notice back", () => {
    // THE HOLE THIS CLOSED: `sessionStorage` is the only dismissal flag
    // the page had, and `sync()` — called from `load` and from every
    // `online` event — runs `clearDismissal()` as soon as the connection
    // looks fine. A reader who dismissed the boot notice at 5 s then had
    // it erased by a late `load`, and the 45 s backstop re-showed the
    // banner on a page whose map was never coming back. A dismissed
    // notice that reappears is worse than no button at all.
    expect(bootSection).toMatch(/var bootDismissed = false;/);
    // set ONLY by the ✕, and only for the boot wording
    const dismiss = offline.slice(offline.indexOf("function wireDismiss(el)"));
    const body = dismiss.slice(0, dismiss.indexOf("function hide()"));
    expect(body).toMatch(/var wasBoot = bootReason;/);
    expect(body).toMatch(/if \(wasBoot\) bootDismissed = true;/);
    // checked by the probe's gate
    const showBoot = offline.slice(offline.indexOf("function showBoot()"));
    expect(showBoot.slice(0, showBoot.indexOf("function probeBoot()")))
      .toMatch(/if \(bootDismissed\) return;/);
    // and remembered by clearDismissal itself, so every recovery path is
    // covered by ONE guard instead of three call sites.
    const clear = offline.slice(offline.indexOf("function clearDismissal()"));
    const clearBody = clear.slice(0, clear.indexOf("function log("));
    expect(clearBody).toMatch(/if \(bootDismissed\) return;/);
    // …but the map APPEARING is a real resolution, so it forgets it.
    const heal = bootSection.slice(bootSection.indexOf("function healBoot()"));
    const healBody = heal.slice(0, heal.indexOf("function showBoot()"));
    expect(healBody).toMatch(/bootDismissed = false;/);
    expect(healBody.indexOf("bootDismissed = false;"))
      .toBeLessThan(healBody.indexOf("clearDismissal();"));
  });

  test("the Reload fresh button is wired into this wording too", () => {
    // wireReload lives with the button itself (above the boot section),
    // and repaintBoot re-uses it — one button, one handler, four
    // wordings (offline, tiles, boot, offline-again).
    expect(offline).toMatch(/function wireReload\(el\)/);
    expect(bootSection).toMatch(/wireReload\(el\)/);
    expect(offline).toMatch(/window\.hardRefresh = hardRefresh;/);
    // It must work with app.js MISSING — that is the case it exists for.
    const fn = offline.slice(offline.indexOf("async function hardRefresh()"));
    expect(fn).toMatch(/location\.reload\(\);/);
  });
});

describe("the detection is exact, not a timing guess", () => {
  test("the signal is window._xyzoMap, set at app.js's top level", () => {
    expect(bootSection).toMatch(/window\._xyzoMap/);
    // Set synchronously when the Leaflet map is constructed — not inside
    // a callback that a broken boot would never reach anyway.
    const at = appJs.indexOf("const map = L.map(\"map\"");
    expect(at).toBeGreaterThan(-1);
    const exportLine = appJs.indexOf("window._xyzoMap = map;");
    expect(exportLine).toBeGreaterThan(at);
    expect(exportLine - at).toBeLessThan(1200);
    // and never cleared: pageshow resets `_xyzoMapReady`, never the map.
    expect(appJs).not.toMatch(/_xyzoMap = (null|undefined)/);
  });

  test("the probe waits for DOMContentLoaded plus a grace period", () => {
    // app.js is `defer`, so DCL fires only once every deferred script has
    // RUN OR FAILED — which is what makes post-DCL absence of _xyzoMap an
    // exact test rather than a guess. The grace period is MARGIN, not
    // download time: DCL already includes every byte of the 703 KB
    // gzipped defer payload, so it cannot fire before app.js has run.
    expect(bootSection).toMatch(/document\.addEventListener\("DOMContentLoaded", onReady, \{ once: true \}\)/);
    expect(bootSection).toMatch(/var GRACE_MS = 2000;/);
    expect(bootSection).toMatch(/setTimeout\(probeBoot, scriptFailed \? 0 : GRACE_MS\)/);
    // NEVER branch on readyState here. **readyState is already
    // "interactive" while defer scripts execute** — it flips before they
    // run — so `if (readyState === "loading")` is FALSE inside offline.js
    // and the probe would be scheduled from THIS file's execution rather
    // than from app.js's chance. Measured: app.js delayed 8 s by the
    // network raised the notice at 6.8 s over a map that then appeared.
    const watch = bootSection.slice(bootSection.indexOf("function watchBoot()"));
    expect(watch).not.toMatch(/readyState === "loading"/);
    expect(watch).not.toMatch(/readyState !== "loading"/);
    // …and the backstop is measured from here, which is correct: it is
    // for a script that never finishes at all.
    expect(watch).toMatch(/setTimeout\(probeBoot, 45000\)/);
  });

  test("there is a backstop for a script that never finishes", () => {
    // An infinite loop in a defer script blocks DCL entirely, so onReady
    // never runs. 45 s is far past the measured worst healthy case and a
    // false alarm is still self-correcting (healBoot).
    expect(bootSection).toMatch(/setTimeout\(probeBoot, 45000\)/);
    expect(bootSection).toMatch(/45 s/);
  });

  test("a failed same-origin script probes immediately — and only a flag", () => {
    // Registered at PARSE time: a parser script's `error` fires during
    // parsing, long before init() runs at DCL. A listener attached then
    // would have missed every one of them.
    const listener = offline.slice(
      offline.indexOf("// THIS LISTENER IS REGISTERED AT PARSE TIME"));
    const body = listener.slice(0, listener.indexOf("function init()"));
    expect(body).toMatch(/window\.addEventListener\("error", function \(e\) \{/);
    expect(body).toMatch(/\}, true\);/);
    // Capture phase: `error` on a script element does not bubble.
    expect(body).toMatch(/scriptFailed = true;/);
    // Async = a chunk WE appended (loadChunk sets async = true) — a missing
    // optional overlay must not be read as "the map didn't load".
    expect(body).toMatch(/t\.tagName !== "SCRIPT" \|\| t\.async/);
    // Someone else's script failing is not our map failing.
    expect(body).toMatch(/externalOrigin\(t\.src\)/);
    // …and the flag only decides HOW SOON we probe, never whether we
    // show: a failed non-critical script that still let app.js build the
    // map must raise nothing.
    expect(bootSection).toMatch(/setTimeout\(probeBoot, scriptFailed \? 0 : GRACE_MS\)/);
    expect(bootSection).toMatch(/function probeBoot\(\)[\s\S]{0,200}mapIsUp\(\)/);
  });

  test("it only arms on a page that has a map to fail to draw", () => {
    // offline.js is loaded by index.html only today, but the guard is
    // what keeps that from becoming an assumption: any other page would
    // otherwise be told forever that its map failed to load.
    expect(bootSection).toMatch(/if \(!document\.getElementById\("map"\)\) return;/);
    expect(bootSection).toMatch(/return !!\(window\._xyzoMap && document\.getElementById\("map"\)\)/);
    expect(indexHtml).toMatch(/offline\.js\?v=\d+/);
    expect(indexHtml).toMatch(/id="map"/);
  });

  test("the watcher is armed exactly once, from init()", () => {
    expect(offline).toMatch(/watchBoot\(\);/);
    expect(offline).toMatch(/function watchBoot\(\)/);
  });
});

describe("the guard rails from the tile notice's shipped bugs", () => {
  test("being online does NOT erase the boot notice", () => {
    // THE BUG TO NOT REPEAT: window `load` calls sync() → show(true) →
    // hide(), which erased the tile notice moments after it appeared.
    // The connection was never the problem for a boot failure, so
    // show(true) must not touch it — it may only retire the notice if
    // the map has since appeared.
    expect(showBody).toMatch(/if \(bootReason\) \{[\s\S]{0,300}healBoot\(\)/);
    expect(showBody).toMatch(/if \(tileReason\) return;/);
    // It must not fall through to hide() while the reason is still true.
    const idx = showBody.indexOf("if (bootReason) {");
    const hideIdx = showBody.indexOf("hide();");
    expect(idx).toBeGreaterThan(-1);
    expect(hideIdx).toBeGreaterThan(idx);
  });

  test("an offline state outranks a boot failure — but only the WORDING", () => {
    // "You're offline" explains more and the reader can act on it. But
    // bootReason must SURVIVE the swap, or reconnecting would drop the
    // notice entirely instead of restoring it.
    expect(showBody).toMatch(/if \(el && bootReason\) \{\s*repaintOffline\(el\);/);
    // …and when the connection returns, our wording comes back.
    expect(showBody).toMatch(/repaintBoot\(bel\)/);
  });

  test("hide() clears the new reason but NOT the dismissal", () => {
    const i = offline.indexOf("function hide()");
    const body = offline.slice(i, i + 900);
    expect(body).toMatch(/tileReason = false;/);
    expect(body).toMatch(/bootReason = false;/);
    // hide() is what the ✕ calls: clearing the flag there would let the
    // very next probe put the banner back.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/clearDismissal\(\)/);
  });

  test("a recovered situation FORGETS the dismissal", () => {
    // Same rule as the tiles: a dismissal belongs to one resolved
    // situation, not to all time — otherwise a boot failure dismissed
    // today would silence every future one.
    expect(bootSection).toMatch(/function healBoot\(\)/);
    const heal = bootSection.slice(bootSection.indexOf("function healBoot()"));
    const body = heal.slice(0, heal.indexOf("function showBoot()"));
    expect(body).toMatch(/clearDismissal\(\);/);
    expect(body).toMatch(/hide\(\);/);
    expect(body).toMatch(/if \(!mapIsUp\(\)\) return;/);
  });

  test("the tile watcher stands down while a boot notice is up", () => {
    // No imagery and no map at all are different problems; ours is the
    // deeper one, and without this guard tileTick would repaint its own
    // wording over ours every ten seconds.
    const showTiles = offline.slice(offline.indexOf("function showTiles()"));
    const end = showTiles.indexOf("function repaintTiles");
    const body = showTiles.slice(0, end === -1 ? showTiles.length : end);
    expect(body).toMatch(/if \(bootReason\) return;/);
    expect(body).toMatch(/if \(navigator\.onLine === false\) return;/);
  });

  test("the boot notice demotes the API-health banner, one claim at a time", () => {
    expect(bootSection).toMatch(/getElementById\("api-down-banner"\)/);
    expect(bootSection).toMatch(/api\.style\.display = "none"/);
  });

  test("a map that arrives late retires the notice", () => {
    // Otherwise a merely SLOW boot — or a backstop that fired early on a
    // very bad connection — would leave a false alarm standing over a
    // perfectly good map. The 2 s interval runs only while the notice is
    // up, so a healthy page pays nothing.
    expect(bootSection).toMatch(/setInterval\(function \(\) \{\s*if \(bootReason\) healBoot\(\);/);
    expect(bootSection.length).toBeGreaterThan(2000);
  });

  test("app.js has no second copy of the notice or of hardRefresh", () => {
    // Two notice systems is how they drift; two hard-refresh primitives
    // is how the tested one stops being the shipped one.
    expect(appJs).not.toMatch(/The map didn't load/);
    expect(appJs).not.toMatch(/async function hardRefresh\(\)/);
    expect(appJs).not.toMatch(/window\.hardRefresh = hardRefresh;/);
  });

  test("the notice's styling is inherited from the existing banner", () => {
    // No new CSS: it is created with inline styles by the same code
    // path, and the ✕ / button classes are the ones already styled.
    expect(offline).toMatch(/xyzo-notice-dismiss/);
    expect(css).toMatch(/\.xyzo-notice-reload \{/);
    expect(css).toMatch(/\.xyzo-notice-dismiss \{/);
  });
});
