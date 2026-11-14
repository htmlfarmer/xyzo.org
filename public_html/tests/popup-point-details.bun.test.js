// popup-point-details.bun.test.js — a pin tells you WHERE it is.
//
// Owner ask: *"when you click on a point.. can you have it show the
// details of that point including the google popup map showing the
// satellite view for example lat/lng and anything else a user might want
// to know about that point... nearest town nearest news... if that takes
// too long dont do it.. just show something so they can see at least the
// lat/lng and a few other things that are fast for us to provide"*
//
// WHAT IS FAST, AND WHAT IS NOT. Everything the popup shows about the
// POINT is already in hand — the pin carries its own coordinates, its
// place, its source and its time — so the numbers cost NOTHING. The
// nearest news is the "Related Stories" section the popup already has
// (the event's other articles). The satellite view is the exception: it
// is a NESTED Leaflet map, so it is a BUTTON and not something the
// popup builds on every tap — the owner's own words: *"if that takes too
// long dont do it"*.
//
// MEASURED LIVE (Playwright, 2026-11-12, a phone and a desktop): the
// popup reads "📍 48.85771° N · 2.34884° E" under the title, the 📡
// button opens the satellite popup (4 Esri tiles), and the ✕ and the
// existing actions still work. 0 page errors.
//
// THE TRAP THAT COST TWO REVISIONS: **the popup's content is 914 px
// long in a 380 px scroll box**, and the content wrapper carries a CSS
// `zoom: 1.15`. So anything placed low in the popup is BELOW THE FOLD —
// and clipped content is not hit-tested, so a button down there is
// invisible AND dead (the first version put the satellite button in a
// block at the bottom, and it did nothing at all). Hence: the numbers
// and the buttons live in the HEADER row, which is always visible.
//
// THE LISTENERS ARE DELEGATED FROM THE POPUP ELEMENT, NOT BOUND TO THE
// BUTTONS — the same rule the close button follows (see
// attachPopupClose): the popup's content is a FUNCTION, so Leaflet
// rebuilds it (setContent) and the buttons are replaced by brand-new
// nodes, and a listener bound to a button dies with the old one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("a pin shows where it is", () => {
  test("the coordinates are in the popup, in both layouts", () => {
    // The mobile branch has its own header, so BOTH must carry the line
    // — otherwise the numbers are a tap away on a phone.
    expect(appJs).toMatch(/function pointCoordsLine\(p\)/);
    expect(appJs).toMatch(/function pinLatLng\(p\)/);
    // Once in the mobile header, once in the desktop header.
    const coords = appJs.match(/pointCoordsLine\(p\)/g) || [];
    expect(coords.length).toBeGreaterThanOrEqual(2);
    // And they are the POINT's own numbers, in a monospaced line.
    expect(stylesCss).toMatch(/\.popup-coords-inline\s*\{[^}]*ui-monospace/);
  });

  test("the satellite view is a BUTTON, not something built on every tap", () => {
    // A nested Leaflet map is a second map and four tiles; opening it
    // automatically would make every pin tap wait for a picture of a
    // field.
    expect(appJs).toMatch(/class="popup-action-btn popup-satellite-btn"/);
    expect(appJs).toMatch(/openSatellitePopup\(\{ lat, lng \}\)/);
  });

  test("the buttons are delegated from the popup element", () => {
    // The content is a FUNCTION: Leaflet rebuilds it on every update,
    // so a listener bound to the button is thrown away with the old
    // node and the button goes dead.
    expect(appJs).toMatch(/el\._xyzoPointWired/);
    // The delegation carries every action button — the satellite, the
    // copy, and the zoom-to-this-place (2026-11-13).
    expect(appJs).toMatch(/closest\("\.popup-satellite-btn, \.popup-copy-coords-btn, \.popup-zoom-here-btn"\)/);
    expect(appJs).not.toMatch(/popup-satellite-btn"\)\.addEventListener/);
  });

  test("the buttons live in the HEADER row, above the fold", () => {
    // The content is 914 px in a 380 px box: a button lower down is
    // clipped, and clipped content is not hit-tested.
    expect(appJs).toMatch(/popup-location-row popup-point-row/);
    // And the popup's content box was given the room the extra row
    // needs, so the EXISTING action row (view, Fix, Report…) stays
    // visible too.
    expect(appJs).toMatch(/maxHeight: 440/);
  });

  test("nothing here waits on a request", () => {
    // The whole point: the details are fast because they are already in
    // hand. No fetch, no geocoder, no tile server.
    const block = appJs.slice(appJs.indexOf("function pointCoordsLine"), appJs.indexOf("function buildPopup"));
    expect(block).not.toMatch(/await fetch/);
    expect(block).not.toMatch(/fetch\(/);
  });
});
