// map-first-load.bun.test.js — the map must be visible on a COLD first
// load, including in Firefox.
//
// index.html loads styles.css with the `media="print" onload="this.media='all'"`
// async trick. When the stylesheet has not landed yet, Leaflet's
// _initLayout reads `getComputedStyle().position` as `static` and forces
// `position: relative` INLINE. The stylesheet's own
// `#map { position: fixed; inset: 0 }` can then never size the container
// (a relatively positioned element with `inset: 0` is offset, not sized)
// → the map stays 0×0 and the user sees no map at all.
//
// Reproduced in Firefox (the stylesheet arrives after the script on a
// cold cache): container 0 px tall, `style="position: relative"`, no
// tiles. A reload worked because the stylesheet was already cached.
//
// The old fix only looked at the state at script-execution time — where
// `inset` is still "auto" — so it never fired. The check has to run
// AFTER the stylesheet is applied.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

describe("map first load", () => {
  test("the stylesheet is loaded asynchronously (the race exists)", () => {
    expect(indexHtml).toMatch(/styles\.css\?v=\d+"\s+media="print"\s+onload="this\.media='all'"/);
  });

  test("the position fix re-runs after the stylesheet lands", () => {
    expect(appJs).toMatch(/function fixMapPositionIfLeafletClobbered/);
    // A 'load' listener on the stylesheet link…
    expect(appJs).toMatch(/link\.addEventListener\("load", restore/);
    // …plus a few timed retries and a window-load fallback.
    expect(appJs).toMatch(/setTimeout\(restore, \d+\)/);
    expect(appJs).toMatch(/window\.addEventListener\("load", restore/);
  });

  test("the fix clears the inline position override Leaflet forced", () => {
    expect(appJs).toMatch(/el\.style\.position = ""/);
    expect(appJs).toMatch(/map\.invalidateSize\(\{ animate: false \}\)/);
  });

  test("the fix does not depend on a check that only fires late", () => {
    // The old detection required `cs.inset` to be already applied —
    // which is false at script-execution time, so it never fired.
    expect(appJs).not.toMatch(/cs\.inset && cs\.inset !== "auto"/);
  });

  test("a last-resort size keeps the map visible even without the CSS", () => {
    expect(appJs).toMatch(/el\.style\.height = "100vh"/);
    expect(appJs).toMatch(/el\.style\.width = "100vw"/);
  });
});
