// first-load-speed.bun.test.js — the map must be USABLE before it is
// complete.
//
// Owner report: *"markers seem to be taking a long time to load... in
// fact it took more then a few min when my friend tried to load"* and
// then *"seems to take about 30 to 45 seconds... are you sure.???"*.
//
// The first measurement said "6.8 s" and it was WRONG: it measured the
// first markers on THIS box over the loopback, and it sampled the
// resource timing while the heavy responses were still in flight.
//
// What the real measurement showed (2026-11-12, throttled to a slow 3G
// link, the fifteen-overlay URL):
//
//   t=10.6 s   the pins ARRIVE
//   t=30.5 s   the markers are PAINTED        ← a twenty-second gap
//
// The network was not the cause. The main thread was busy decoding and
// painting the 280 tile images of the eight raster overlays the link
// asked for, and the pin canvas drew after all of them.
//
// THE THREE FIXES, and what each one was worth:
//
//   1. THE INITIAL VIEW IS THE LINK'S VIEW. The map used to be created
//      at the world view (z2) and MOVED to the hash's view a moment
//      later, so the browser asked for 16 world tiles, threw them away,
//      and only then asked for the real ones.
//
//   2. THE CITY INDEX IS NOT ON THE CRITICAL PATH. A
//      <link rel="preload"> in the HEAD does not wait for idle — the
//      browser starts it as soon as it parses the HTML. It was the
//      FIRST request on the page (t=0.30 s, before app.js) and it is
//      1.16 MB, so it stole the bandwidth app.js was waiting for.
//
//   3. THE OVERLAYS ARE STAGED. The basemap and the MARKERS come
//      first; the overlays are added a frame later, which is what every
//      map does anyway. The total time to "everything" is the same; the
//      time to a USABLE MAP is twenty seconds shorter.
//
// Measured after: the markers paint at t=12.4 s on the same slow 3G
// link — 12.4 s instead of 30.5 s.
//
// ── AND THE LESSON OF 2026-11-12 (11-12, later the same day) ──────────
//
// The FIRST version of this file was a source-shape test, and it PASSED
// against code that was broken: the boot view was built as an ARRAY and
// read with `.lat` (which is `undefined` on an array), so the map was
// told `setView([undefined, undefined], undefined)` and Leaflet answered
// "Invalid LatLng object". The exception killed the rest of app.js — and
// on Firefox the map was left with NO VIEW AT ALL, so every accessor
// threw "Set map center and zoom first." and the reader got the
// "Connection hiccup — showing cached data" banner instead of markers.
//
// A GATE THAT PASSES AGAINST BROKEN CODE IS NOT A GATE. The BEHAVIOURAL
// gate for this is `scripts/first_load_audit.py`, which drives the
// shipped page in Firefox AND Chromium and asserts that the markers
// arrive with no page errors. The assertions below are the fast,
// no-browser half of it — and each one names the mistake it prevents.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const cityEngineJs = readFileSync(join(ROOT, "city-engine.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

describe("the initial view is the LINK's view", () => {
  test("the map is given a view on the line after the constructor", () => {
    // Leaflet 1.9.4 has NO `setView`/`center`/`zoom` CONSTRUCTOR OPTION
    // (grep the vendored file: `options.setView` — zero hits), so an
    // option of that name is silently ignored and the map is left with
    // NO VIEW. Every accessor then throws "Set map center and zoom
    // first." — which killed the first pin fetch on Firefox.
    const ctor = appJs.indexOf("const map = L.map(");
    expect(ctor).toBeGreaterThan(-1);
    // The view must be set BEFORE any of the app's own machinery is
    // registered — before the first thing that could ask the map a
    // question (whenMapReady, a listener, a fetch).
    const setAt = appJs.indexOf("map.setView(", ctor);
    expect(setAt).toBeGreaterThan(ctor);
    const firstMachinery = appJs.indexOf("function whenMapReady(", ctor);
    expect(firstMachinery).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(firstMachinery);
  });

  test("the boot view is an OBJECT, not an array", () => {
    // The bug: `_bootView` was `[lat, lng, zoom]` and the call site read
    // `_bootView.lat` — undefined on an array — so the map was given
    // `setView([undefined, undefined], undefined)`.
    expect(appJs).toMatch(/_bootView\s*=\s*\([\s\S]{0,200}?\{\s*lat:/);
    // And the call site must read the OBJECT's fields.
    expect(appJs).toMatch(/map\.setView\(_bootView\s*\?\s*\[_bootView\.lat,\s*_bootView\.lng\]/);
    // An array of three would break it again.
    expect(appJs).not.toMatch(/_bootView\s*=\s*\([\s\S]{0,200}?\[\s*_bootHashView\.lat/);
  });

  test("the world view is only the fallback", () => {
    // A reader with no link still gets the world view.
    expect(appJs).toMatch(/map\.setView\(_bootView\s*\?\s*\[_bootView\.lat,\s*_bootView\.lng\]\s*:\s*\[20,\s*0\]/);
  });

  test("the restore does not move a map that is already in place", () => {
    // Otherwise the boot fires a second moveend — and a second pin
    // fetch for the same place.
    expect(appJs).toMatch(/if \(!same\)\s*\{\s*\n?\s*map\.setView\(/);
  });
});

describe("the failure notice tells the TRUTH about the failure", () => {
  test("an exception is not called a network hiccup", () => {
    // The owner's live failure (2026-11-12) showed "Connection hiccup —
    // Brief network issue — Will retry automatically" while the real
    // cause was a crash in the boot. That sends the reader looking for
    // a problem on their side, and "will retry automatically" is a lie:
    // a retry cannot fix a crash.
    expect(appJs).toMatch(/kind === "exception"/);
    expect(appJs).toMatch(/errorType = "Map problem"/);
    // And the network wording stays where it belongs — on a network
    // failure.
    expect(appJs).toMatch(/errorType = "Connection hiccup"/);
  });
});

describe("the city index is fetched when it is NEEDED", () => {
  test("index.html does not preload it", () => {
    // The preload was the first request on the page and it stole the
    // bandwidth app.js was waiting for.
    expect(indexHtml).not.toMatch(/rel=["']preload["'][^>]*cities\.10k\.json/);
  });

  test("city-engine.js does not fetch it at boot", () => {
    // The "idle" warm was not idle: requestIdleCallback fires as soon
    // as the browser has ANY idle time, which during a map boot is the
    // moment it is waiting for app.js.
    expect(cityEngineJs).not.toMatch(/scheduleIdle\(\(\)\s*=>\s*load\(\)\)/);
  });

  test("app.js warms it when the reader touches the search box or the map", () => {
    expect(appJs).toMatch(/searchInput\.addEventListener\("focus"/);
    expect(appJs).toMatch(/mapHost\.addEventListener\("pointerdown"/);
  });
});

describe("the overlays are STAGED behind the markers", () => {
  test("the boot records the overlay names but defers adding the layers", () => {
    expect(appJs).toMatch(/function flushDeferredOverlays/);
    expect(appJs).toMatch(/_deferredOverlayAdds\.push\(\{\s*name:\s*ovName/);
  });

  test("the name is recorded IMMEDIATELY — the hash rewrite is unchanged", () => {
    const addAt = appJs.indexOf("_activeOverlayNames.add(ovName)");
    const deferAt = appJs.indexOf("_deferredOverlayAdds.push");
    expect(addAt).toBeGreaterThan(-1);
    expect(deferAt).toBeGreaterThan(addAt);
  });

  test("the overlays go on after the markers are painted", () => {
    // Two frames: one lets the pin canvas draw, the second lets the
    // browser composite it before 280 tile images arrive to be decoded.
    expect(appJs).toMatch(/requestAnimationFrame\(\(\)\s*=>\s*requestAnimationFrame/);
    expect(appJs).toMatch(/flushDeferredOverlays\(\)/);
  });

  test("the boot path is the one that stages them", () => {
    expect(appJs).toMatch(/_deferOverlayAdds\s*=\s*true/);
    expect(appJs).toMatch(/_deferOverlayAdds\s*=\s*false/);
  });
});
