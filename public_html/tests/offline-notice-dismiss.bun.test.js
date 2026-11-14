// offline-notice-dismiss.bun.test.js — the "Map imagery isn't loading"
// notice must be dismissible, and dismissing it must work.
//
// The owner asked: *"can we have a way to X out this message its
// getting in the way"*. The notice sits across the TOP of the map, so
// it is in the way of the very thing it is talking about — and it is a
// NOTICE, not a blocker: nothing on the page depends on it.
//
// Two things this pins:
//   1. the notice carries a real X (a <button>, so it is focusable and
//      announced), and the X hides it;
//   2. **the dismissed notice STAYS gone.** The tile watcher fires on
//      every failed batch of tiles, so a dismissed banner that
//      reappeared ten seconds later would be worse than no button at
//      all. The dismissal is remembered for the SESSION and forgotten
//      as soon as the situation RESOLVES — the tiles come back, or the
//      connection returns — so a genuinely NEW outage warns again.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const offline = readFileSync(join(ROOT, "offline.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const css = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("the notice can be sent away", () => {
  test("both wordings carry the X", () => {
    expect(offline).toMatch(/DISMISS_BUTTON/);
    expect(offline).toMatch(/function repaintTiles[\s\S]{0,400}DISMISS_BUTTON/);
    expect(offline).toMatch(/function repaintOffline[\s\S]{0,200}DISMISS_BUTTON/);
  });

  test("the X is a real button with an accessible name", () => {
    expect(offline).toMatch(/<button type="button" class="xyzo-notice-dismiss"/);
    expect(offline).toMatch(/aria-label="Dismiss this notice"/);
    expect(offline).toMatch(/title="Dismiss"/);
  });

  test("the API-DOWN banner carries an X too", () => {
    // Owner ask 2026-11-10: *"can we correct it so we can also close
    // it with an X when this message pops up?"* — the "⚡ Live data is
    // unavailable" banner, which is a SEPARATE notice from the tile
    // one (app.js's ApiHealth) and had no way to be closed at all.
    //
    // It uses the HOUSE class, so it is the same 28 px target, the
    // same 44 px on a coarse pointer and the same focus ring as the
    // tile notice's X — one class, one look, two notices.
    expect(appJs).toMatch(/id="api-down-dismiss"/);
    expect(appJs).toMatch(/class="xyzo-notice-dismiss" id="api-down-dismiss"/);
    expect(appJs).toMatch(/aria-label="Dismiss this notice" title="Dismiss"/);
  });

  test("the API banner's dismissal STAYS dismissed and is FORGOTTEN on recovery", () => {
    // The health check runs every 15 s, so a dismissed banner that
    // reappeared a moment later would be worse than no button at all.
    // The dismissal is remembered for the SESSION…
    expect(appJs).toMatch(/sessionStorage\.setItem\(this\._DISMISS_KEY, "1"\)/);
    expect(appJs).toMatch(/sessionStorage\.getItem\(this\._DISMISS_KEY\) === "1"/);
    // …and forgotten when the situation RESOLVES (the API answers
    // again), so a genuinely NEW outage warns the reader.
    expect(appJs).toMatch(/this\._rememberDismissed\(false\)/);
    // The retry loop must not re-create a dismissed banner.
    expect(appJs).toMatch(/if \(!this\._down && !this\._isDismissed\(\)\)/);
    // And the X's own click must NOT clear the flag — it is cleared
    // where the situation resolves, not where the banner goes.
    const at = appJs.indexOf('id="api-down-dismiss"');
    expect(at).toBeGreaterThan(-1);
    const handler = appJs.slice(at, at + 900);
    expect(handler).toMatch(/addEventListener\("click"/);
    expect(handler).toMatch(/this\._rememberDismissed\(true\)/);
    expect(handler).toMatch(/this\._down = true;/);
    expect(handler).toMatch(/el\.remove\(\)/);
    // Its OWN key: closing "live data is unavailable" must not also
    // close "the imagery isn't loading".
    expect(appJs).toMatch(/_DISMISS_KEY: "xyzo\.apiDownDismissed"/);
  });

  test("clicking it hides the banner and stops it coming back", () => {
    expect(offline).toMatch(/function wireDismiss\(/);
    expect(offline).toMatch(/btn\.addEventListener\("click"/);
    expect(offline).toMatch(/rememberDismissed\(true\)/);
    expect(offline).toMatch(/tileReason = false;/);
    // The tile watcher must not put it back.
    expect(offline).toMatch(/function showTiles\(\)[\s\S]{0,300}if \(isDismissed\(\)\) return;/);
  });

  test("the dismissal is remembered for the session and forgotten on recovery", () => {
    expect(offline).toMatch(/sessionStorage\.setItem\(DISMISS_KEY, "1"\)/);
    expect(offline).toMatch(/sessionStorage\.getItem\(DISMISS_KEY\) === "1"/);
    // FORGOTTEN when the situation resolves: the tiles come back, or
    // the connection returns — so a NEW outage warns again.
    expect(offline).toMatch(/function clearDismissal\(\)/);
    expect(offline).toMatch(/clearDismissal\(\);[\s\S]{0,400}hide\(\);/);
  });

  test("hide() must NOT clear the dismissal", () => {
    // hide() is what the X calls. If it cleared the flag, the very
    // next failed tile batch would put the banner back.
    const i = offline.indexOf("function hide()");
    const body = offline.slice(i, i + 900);
    expect(body).toMatch(/tileReason = false;/);
    // The COMMENTS mention clearDismissal(); only a CALL would clear it.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/clearDismissal\(\)/);
  });

  test("the X is styled, and cannot be pushed off the banner", () => {
    expect(css).toMatch(/\.xyzo-notice-dismiss \{/);
    expect(css).toMatch(/position:\s*absolute;/);
    expect(css).toMatch(/right:\s*8px;/);
    // A 28 px target is small for a thumb: on a coarse pointer it
    // grows to the 44 px floor.
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]{0,600}\.xyzo-notice-dismiss[\s\S]{0,200}width:\s*44px;/);
    // The banner reserves room for the button so the text cannot run
    // under it.
    expect(offline).toMatch(/padding:10px 46px 10px 18px/);
  });

  test("the banner OFFERS a hard refresh — where a stale map is standing", () => {
    // The owner ask: *"we might need to suggest a hard refresh or have
    // that as an option on the page to refresh it"*.
    //
    // The hard-refresh button already exists (⚙ → TOOLS), but it is
    // three clicks deep in a menu nobody opens when the map looks wrong.
    // The notice banner is EXACTLY where a reader with a stale map is
    // standing, so the offer is made there — and both wordings carry it.
    expect(offline).toMatch(/RELOAD_BUTTON/);
    expect(offline).toMatch(/function repaintTiles[\s\S]{0,600}RELOAD_BUTTON/);
    expect(offline).toMatch(/function repaintOffline[\s\S]{0,300}RELOAD_BUTTON/);
    // A real button with an accessible name.
    expect(offline).toMatch(/<button type="button" class="xyzo-notice-reload"/);
    expect(offline).toMatch(/title="Re-download the map files and reload/);
    // It calls the site's own hard refresh (which pulls every script and
    // stylesheet from the network, drops the service worker and its
    // caches, and reloads) — and falls back to a plain reload.
    expect(offline).toMatch(/function wireReload\(/);
    expect(offline).toMatch(/window\.hardRefresh/);
    expect(offline).toMatch(/location\.reload\(\);/);
    // And the page exposes it — FROM OFFLINE.JS, not app.js. It has to
    // live here: the whole reason this button exists is that app.js may
    // be what failed (stale immutable URL, a 500, a throw), and while it
    // was defined in app.js the button silently fell back to a plain
    // reload that cannot bypass the immutable cache.
    expect(offline).toMatch(/window\.hardRefresh = hardRefresh;/);
    const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
    // app.js must not carry a second copy: two hard-refresh primitives
    // would drift, and the one that drifted would be the one nobody
    // tests. It calls window.hardRefresh instead.
    expect(appJs).not.toMatch(/async function hardRefresh\(\)/);
    expect(appJs).toMatch(/typeof window\.hardRefresh === "function"/);
    // Styled, and in the text flow so it never covers the message.
    expect(css).toMatch(/\.xyzo-notice-reload \{/);
    expect(css).toMatch(/margin-left:\s*8px;/);
  });

  test("the audit script exists and routes at the CONTEXT", () => {
    const py = readFileSync(join(ROOT, "..", "scripts", "offline_notice_audit.py"), "utf8");
    expect(py).toMatch(/ctx\.route\(/);
    expect(py).toMatch(/xyzo-notice-dismiss/);
    // The service worker takes control of the page and serves the
    // tiles ITSELF, and a request made BY the worker does not go
    // through a PAGE route — so the page route left 20 of the 24 tiles
    // loading and the notice never appeared.
    expect(py).not.toMatch(/pg\.route\(/);
  });
});
