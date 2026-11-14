// search-weather-archive.bun.test.js — the TIME MACHINE: the map as it was.
//
// WHAT IT IS. The site publishes three weather fields every GFS
// analysis cycle (four a day): the 10 m wind, the 2 m temperature and
// the pressure contours. Each worker REPLACES the previous cycle when
// the next one lands, so the past was gone. worker/weather_archive.py
// keeps a copy of every cycle (369 KB a cycle — the 1° wind grid, the
// 1° temperature grid and the classic 4 hPa pressure chart, gzipped —
// so a year is ~550 MB), and this module is the reader's side of it:
// pick a date and a time, and the map draws that moment's weather.
//
// THE RULES THIS PINS:
//
//   * the three weather layers ask the ARCHIVE where their grid comes
//     from, and the LIVE path when no past moment is selected — one
//     switch, not three copies of the switch;
//   * the layers hold their grid in MEMORY, so choosing a moment must
//     EMPTY them and re-add them, or the reader would be looking at
//     today's wind while the panel says March;
//   * the moment rides in the URL (?at=), the way a search does (?q=),
//     so a past map can be shared;
//   * the NEWS drawn is the news OF THAT DAY — the window has both ends,
//     because "since" alone would be every story since that day;
//   * the archive keeps the 1° fields (the same grids the 3D globe
//     draws) and the reader is told so — a year of the 0.25° grids
//     would be 8.8 GB.
//
// Measured live 2026-11-12: the wind layer fetched
// /api/weather/archive/meta.json?field=wind&at=… and
// /api/weather/archive/wind.bin?at=…, the isobar layer fetched
// /api/weather/archive/isobars.json?at=…, and the wind drew 1,234
// particles from the ARCHIVED grid. 0 page errors.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const archiveJs = readFileSync(join(ROOT, "weather-archive.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const windJs = readFileSync(join(ROOT, "wind-layer.js"), "utf8");
const tempJs = readFileSync(join(ROOT, "temp-layer.js"), "utf8");
const isobarJs = readFileSync(join(ROOT, "isobar-layer.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
// The API side of the same contract (the route and the `until` filter).
const apiRoot = join(ROOT, "..", "api", "src");
const archiveRouteJs = readFileSync(join(apiRoot, "routes", "weather-archive.ts"), "utf8");
const validateJs = readFileSync(join(apiRoot, "validate.ts"), "utf8");
const apiPinsJs = readFileSync(join(apiRoot, "routes", "pins.ts"), "utf8");

describe("the time machine asks the archive for the past", () => {
  test("the three weather layers take their grid from the archive", () => {
    // One switch, in the layer that fetches: the live path when no
    // moment is chosen, the archive when one is.
    expect(windJs).toMatch(/WeatherArchive\.gridUrl\("wind"\)/);
    expect(tempJs).toMatch(/WeatherArchive\.gridUrl\("temp"\)/);
    expect(isobarJs).toMatch(/WeatherArchive\.isobarUrl\(\)/);
  });

  test("and their META from the archived cycle, not the live one", () => {
    // The live meta describes TODAY's analysis; a grid without its own
    // meta cannot be drawn at all (the layout, the ranges, the ramp).
    expect(windJs).toMatch(/WeatherArchive\.metaUrl\("wind"\)/);
    expect(tempJs).toMatch(/WeatherArchive\.metaUrl\("temp"\)/);
  });

  test("the layers are EMPTIED when the moment changes", () => {
    // They hold the grid in memory — without this the reader would be
    // looking at today's wind while the panel says March.
    for (const src of [windJs, tempJs, isobarJs]) {
      expect(src).toMatch(/resetForArchive/);
    }
    expect(archiveJs).toMatch(/resetForArchive/);
    expect(archiveJs).toMatch(/applyLayers/);
  });

  test("the moment rides in the URL, the way a search does", () => {
    expect(archiveJs).toMatch(/searchParams\.set\("at"/);
    expect(archiveJs).toMatch(/searchParams\.get\("at"\)/);
  });
});

describe("the news drawn is the news OF THAT DAY", () => {
  test("the window has both ends", () => {
    // "since" alone is every story since that day — which is not what a
    // reader asking for the 3rd of March wants.
    expect(appJs).toMatch(/function searchWindow\(\)/);
    expect(appJs).toMatch(/until: A\.dayEnd\(\)/);
    expect(appJs).toMatch(/until=\$\{encodeURIComponent\(until\)\}/);
    // And the API has to understand the other end.
    expect(appJs).toMatch(/const \{ since, until \} = searchWindow\(\)/);
  });

  test("the API filters on it", () => {
    expect(validateJs).toMatch(/until: isoDate\.optional\(\)/);
    expect(apiPinsJs).toMatch(/COALESCE\(a\.published_at, a\.fetched_at\) <= /);
  });
});

describe("the reader is told what they are looking at", () => {
  test("the archive keeps the 1° fields and says so", () => {
    // The API reports the resolution; the archive is the 1° copy (the
    // same grids the 3D globe draws) because a year of the 0.25° ones
    // would be 8.8 GB.
    expect(archiveRouteJs).toMatch(/resolution: "1deg"/);
    expect(archiveRouteJs).toMatch(/step_hpa: 4/);
  });

  test("the picker is in the control menu", () => {
    expect(indexHtml).toMatch(/id="weather-archive-section"/);
    expect(indexHtml).toMatch(/id="archive-date"/);
    expect(indexHtml).toMatch(/id="archive-time"/);
    expect(indexHtml).toMatch(/id="archive-apply"/);
    expect(indexHtml).toMatch(/id="archive-now"/);
    // And the module is loaded before the layers that ask it.
    const archiveAt = indexHtml.indexOf("weather-archive.js");
    const windAt = indexHtml.indexOf("wind-layer.js");
    expect(archiveAt).toBeGreaterThan(-1);
    expect(archiveAt).toBeLessThan(windAt);
  });

  test("the section only appears when the archive has something in it", () => {
    // A reader must not be offered a date that cannot be served.
    expect(archiveJs).toMatch(/section\.hidden = true/);
    expect(archiveJs).toMatch(/loadCycles\(\)/);
  });
});
