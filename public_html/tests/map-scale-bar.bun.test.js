// map-scale-bar.bun.test.js — the map tells you how far it is.
//
// Owner ask: *"can you show a distance measure on the map for all the
// maps i dont see it is it hiding under the 'help me' tab? its nice to
// know distance based on the zoom level"*.
//
// THERE WAS NOTHING TO HIDE. The 3D globe has had a scale since it was
// written (globe.js: `maplibregl.ScaleControl`), but the FLAT map had
// NO scale control at all — Leaflet's `L.control.scale` was never
// called. So a reader looking for one found the globe's and the flat
// map's absence.
//
// WHERE IT GOES, AND WHY NOT WHERE THE READER LOOKED. The bottom RIGHT
// of the flat map belongs to the "Help me" pill (position: fixed,
// z-index 9998 — it covers whatever sits in that corner) and to Leaflet's
// attribution control; the top left is the zoom bar and the top right
// is the layers dropdown. The bottom LEFT is the only corner with
// nothing in it — and the pill's corner is exactly where the reader
// was looking, which is why the answer to "is it hiding under the help
// me tab?" is "it was not there at all".
//
// MEASURED LIVE (Playwright, 2026-11-12): the flat map reads "2000 km"
// at zoom 2, "10 km" at zoom 10 and "3 km" at zoom 12 — it follows the
// zoom, which is the whole point of a scale — and on a 393×852 phone it
// sits at y 753-774, clear of the bottom bar (whose top edge is 782).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const globeCss = readFileSync(join(ROOT, "globe.css"), "utf8");

describe("the flat map has a scale bar", () => {
  test("Leaflet's scale control is added", () => {
    expect(appJs).toMatch(/L\.control\.scale\(\{/);
    // The bottom left is the only free corner (the "Help me" pill owns
    // the bottom right, and the attribution control is in it).
    expect(appJs).toMatch(/position: "bottomleft"/);
    // Metric only, like the globe's: the site is international, and
    // "both" is two numbers and two rules for one bar.
    expect(appJs).toMatch(/metric: true/);
    expect(appJs).toMatch(/imperial: false/);
  });

  test("the globe has one too, and the two read as one site", () => {
    expect(globeJs).toMatch(/new maplibregl\.ScaleControl\(/);
    // MapLibre's default is a BRIGHT WHITE pill — a hole in the dark
    // globe. Both views get the house look.
    expect(globeCss).toMatch(/\.maplibregl-ctrl-scale\s*\{[^}]*background:\s*rgba\(11,\s*15,\s*20/);
    expect(stylesCss).toMatch(/\.leaflet-control-scale-line\s*\{[^}]*background:\s*rgba\(11,\s*15,\s*20/);
    // The rule's colour is set INLINE by MapLibre, so the override
    // needs !important.
    expect(globeCss).toMatch(/maplibregl-ctrl-scale-line\s*\{[^}]*border-top-color:[^;]*!important/);
  });

  test("on a phone it CLEARS the bottom bar", () => {
    // The bottom bar spans the width of a phone, so the scale has to
    // sit above it — and the bar's top edge is MEASURED
    // (--bottom-bar-top, published by publishChromeEdges()).
    expect(stylesCss).toMatch(/--bottom-bar-top/);
    // THE SELECTOR MUST MATCH LEAFLET'S OWN. The vendored stylesheet
    // sets `.leaflet-bottom .leaflet-control-scale { margin-bottom: 5px }`,
    // and a lower-specificity rule here simply loses — measured: the bar
    // sat at the very bottom, UNDER the bottom bar, which is the same
    // "where did it go?" as not having one.
    expect(stylesCss).toMatch(
      /\.leaflet-bottom \.leaflet-control-scale\s*\{\s*margin-bottom:\s*calc\(var\(--bottom-bar-top/,
    );
  });

  test("it sits UNDER the live panel, never on top of it", () => {
    // The live panel (z-index 400) covers the left edge when it is open
    // and the reader is reading the news; the scale must not float over
    // it.
    expect(stylesCss).toMatch(/\.leaflet-control-scale\s*\{[^}]*z-index:\s*350/);
  });
});
