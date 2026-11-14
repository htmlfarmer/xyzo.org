// control-windows-start-closed.bun.test.js — the first visit shows the
// MAP, not two control windows over it.
//
// Owner ask (2026-11-06): "i think its wiser to not start with the two
// control windows open when someone first visits the website".
//
// Both windows are pinned here because they are ONE rule with two
// halves, and each half has its own trap:
//
//   · LIVE FEED — the trap is the FLASH. The panel is in the markup,
//     so collapsing it only in app.js (a deferred script) paints it
//     open first and slides it away after. The markup must carry the
//     collapsed class, so the panel is closed before any script runs
//     (verified live with app.js blocked: opacity 0, translated
//     off-screen, the reopen pill already showing).
//
//   · LIVE FEED — the trap is the TAB ORDER. `opacity: 0` and
//     `pointer-events: none` do NOT remove an element from the tab
//     order: a keyboard user walking a first visit landed ~35 focus
//     stops inside an invisible panel (tab 10 was #live-panel-toggle,
//     then the tabs, both selects and the location input). The
//     collapsed state needs `visibility: hidden`, delayed past the
//     0.25 s slide-out so the close animation still shows.
//
//   · LAYERS DROPDOWN — the trap is confusing SEMANTICS with START
//     STATE. The constructor stays `collapsed: isPhoneViewport()`
//     because that option decides how the panel behaves once open
//     (sticky on desktop, tap-wired on a phone); the start state is a
//     separate collapse() in the same synchronous block as the
//     constructor, so nothing can paint it open.
//
//   · TOUR — a collapsed live panel is a real-sized box at
//     translateX(-100%), i.e. OFF-SCREEN: a step pointing at it would
//     put the spotlight in the margin. The step points at the button
//     that opens it instead.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const tourJs = readFileSync(join(ROOT, "tour.js"), "utf8");

describe("the Live Feed panel starts closed — before any script runs", () => {
  test("the MARKUP carries the collapsed class (no paint-then-slide flash)", () => {
    const aside = indexHtml.match(/<aside id="live-panel"[^>]*>/);
    expect(aside, "index.html must have the live panel aside").toBeTruthy();
    expect(aside[0]).toMatch(/class="live-panel collapsed"/);
  });

  test("the reopen pill ships visible, so a closed panel is never a dead end", () => {
    const pill = indexHtml.match(/<button id="live-panel-reopen"[^>]*>/);
    expect(pill, "index.html must have the reopen pill").toBeTruthy();
    expect(pill[0]).toMatch(/class="live-panel-reopen visible"/);
  });

  test("setPanelCollapsed(true) runs unconditionally — not only under 768px", () => {
    // The old guard was `if (window.innerWidth < 768)`, so a desktop
    // visitor met a 320px panel over the map on EVERY load.
    //
    // Find the BOOT call, not the toggle's click handler (which is the
    // first `setPanelCollapsed(true)` in the file) and not the mention
    // inside the comment above it: take the last occurrence, which is
    // the bare statement at the end of the toggle block.
    const at = appJs.lastIndexOf("setPanelCollapsed(true);");
    expect(at).toBeGreaterThan(-1);
    // The line itself must be the bare call, not an `if` guard.
    const line = appJs.slice(appJs.lastIndexOf("\n", at) + 1, appJs.indexOf("\n", at));
    expect(line.trim()).toBe("setPanelCollapsed(true);");
    // …and the state literal agrees the panel starts collapsed.
    expect(appJs).toMatch(/collapsed:\s*true,/);
    expect(appJs).toMatch(/home:\s*null,/);
  });
});

describe("the collapsed Live Feed panel must not be keyboard-focusable", () => {
  test("opacity 0 alone leaves it in the tab order — visibility:hidden is pinned", () => {
    const rule = stylesCss.match(/\.live-panel\.collapsed\s*\{[^}]*\}/);
    expect(rule, "styles.css must have a .live-panel.collapsed rule").toBeTruthy();
    expect(rule[0]).toMatch(/visibility:\s*hidden/);
    // Still invisible and inert to the mouse:
    expect(rule[0]).toMatch(/opacity:\s*0/);
    expect(rule[0]).toMatch(/pointer-events:\s*none/);
  });

  test("the hide is DELAYED past the slide-out, and flips back at once on expand", () => {
    const rule = stylesCss.match(/\.live-panel\.collapsed\s*\{[^}]*\}/)[0];
    // `visibility 0s 0.25s` inside .collapsed = stay visible for the
    // 0.25 s close animation, then hide. The BASE .live-panel rule
    // must NOT transition visibility, so expanding reveals it
    // instantly and only the slide is animated.
    expect(rule).toMatch(/visibility\s+0s\s+0\.25s/);
    const base = stylesCss.match(/\.live-panel\s*\{[^}]*\}/);
    expect(base).toBeTruthy();
    expect(base[0]).not.toMatch(/visibility/);
  });
});

describe("the layers dropdown starts closed, but keeps its semantics", () => {
  test("collapse() runs in the SAME block as the constructor", () => {
    const i = appJs.indexOf("L.control.layers(TILE_LAYERS, WEATHER_OVERLAYS, {");
    expect(i).toBeGreaterThan(-1);
    const end = appJs.indexOf("}).addTo(map)", i);
    expect(end).toBeGreaterThan(-1);
    // The first non-comment line after addTo must BE the collapse().
    // (Counting raw characters would measure the explanatory comment,
    // not the code — strip `//` lines first, and start AFTER the
    // `}).addTo(map);` line the slice begins on.)
    const after = appJs.slice(end, end + 600);
    const firstStatement = after
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"))[0];
    expect(firstStatement).toBe("layersControl.collapse();");
  });

  test("the constructor still says isPhoneViewport() — start state is not semantics", () => {
    const i = appJs.indexOf("L.control.layers(TILE_LAYERS, WEATHER_OVERLAYS, {");
    const ctor = appJs.slice(i, appJs.indexOf("}).addTo(map)", i));
    expect(ctor).toMatch(/collapsed:\s*isPhoneViewport\(\)/);
    expect(ctor).not.toMatch(/collapsed:\s*true/);
    expect(ctor).not.toMatch(/collapsed:\s*false/);
  });
});

describe("the tour points at what OPENS the window, not at the hidden box", () => {
  test("the live step's target is a list led by the reopen pill", () => {
    const live = tourJs.slice(tourJs.indexOf('id: "live"'), tourJs.indexOf('id: "globe"'));
    expect(live).toContain('target: ["#live-panel-reopen", "#live-panel"]');
  });

  test("the layers step's target list still covers the open-panel case", () => {
    // When the panel IS open the toggle is display:none (0 × 0), so
    // the step must be able to fall through to the panel itself.
    expect(tourJs).toContain('target: [".leaflet-control-layers-toggle", ".leaflet-control-layers"]');
  });
});
