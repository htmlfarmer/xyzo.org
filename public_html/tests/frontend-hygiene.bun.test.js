/**
 * Frontend hygiene — the invariants that keep app.js from rotting.
 *
 * Every rule here was a real bug:
 *
 *  - DUPLICATE DECLARATIONS: two `startAddLink` functions existed. The
 *    later one shadowed the earlier, so the arc panel's "Link to another
 *    story" button silently called the wrong one (and the shadowing
 *    version was itself half-implemented — it set a variable nothing
 *    ever read). A shadowed declaration is invisible in review and
 *    breaks a feature at runtime.
 *
 *  - UNSTAMPED ASSETS: a frontend file that is not in
 *    bump_frontend.sh's ASSETS keeps its old ?v= token, so cached
 *    browsers never load the new version. This bit the Köppen overlay on
 *    2026-10-22.
 *
 *  - DIRECT console.*: AGENTS.md forbids it — the guard swallows the
 *    output anyway, and XLog is the supported path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

describe("app.js — no shadowed declarations", () => {
  test("no top-level function is declared twice", () => {
    const names = [...appJs.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const seen = new Map();
    const dupes = [];
    for (const n of names) {
      if (seen.has(n)) dupes.push(n);
      seen.set(n, true);
    }
    expect(dupes).toEqual([]);
  });

  test("no top-level const/let is declared twice", () => {
    const names = [...appJs.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]);
    const seen = new Set();
    const dupes = [];
    for (const n of names) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes).toEqual([]);
  });
});

describe("frontend assets — loaded and stamped", () => {
  const layerFiles = readdirSync(ROOT).filter((f) => /-layer\.js$/.test(f));

  test("there are layer modules to check", () => {
    expect(layerFiles.length).toBeGreaterThan(3);
  });

  test("every layer module is loaded by index.html", () => {
    for (const f of layerFiles) {
      expect(indexHtml, `${f} is not loaded by index.html`).toContain(f);
    }
  });

  test("every layer module is in bump_frontend.sh's ASSETS", () => {
    // A file that is not stamped keeps its old ?v= and cached browsers
    // never load it — that is how the Köppen overlay went missing.
    for (const f of layerFiles) {
      expect(bump, `${f} is missing from bump_frontend.sh's ASSETS`).toContain(f);
    }
  });

  test("EVERY script index.html loads carries a ?v= token", () => {
    // A `*.js` is served `max-age=31536000, immutable` for a YEAR, so
    // an unstamped script is FROZEN for a year: every reader who has
    // loaded the page once keeps the copy they first fetched, and no
    // change to it ever reaches them.
    //
    // console-guard.js was the one that bit: it defines window.XLog,
    // which every module logs through, it last changed on 2026-10-21,
    // and it carried NO token until 2026-11-09 — three weeks of
    // readers on a stale copy. The old gate only checked the LAYER
    // modules, and console-guard.js is not one, so nothing noticed.
    //
    // (The vendored libraries were unstamped too, and the asset list
    // only covered the layer modules — the same hole, wider.)
    const tags = [...indexHtml.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(30);
    const unstamped = tags.filter((src) => !src.includes("?v="));
    expect(unstamped, "these scripts are cached for a year and can never update")
      .toEqual([]);
  });

  test("every script index.html loads is in bump_frontend.sh's ASSETS", () => {
    // A token that nothing moves is the same as no token at all: the
    // next build leaves it exactly where it was, and the file is
    // frozen again.
    //
    // THREE EXEMPTIONS, each for a reason (and each still stamped by
    // the script — just by another one):
    //   overlay-opacity.js, map-presets.js → they move ONE AT A TIME
    //     via bump_asset_token.sh, so touching one small file does not
    //     bust the whole page's cache;
    //   help-me-chat.js → a lazy chunk, stamped by the chunk loop.
    const EXEMPT = new Set(["overlay-opacity.js", "map-presets.js",
                            "help-me-chat.js"]);
    const assetsLine = (bump.match(/^ASSETS=".*"$/m) || [""])[0];
    const tags = [...indexHtml.matchAll(/<script[^>]*\ssrc="([^"]+)\?v=\d+"/g)].map((m) => m[1]);
    const missing = tags.filter((a) => !assetsLine.includes(a) && !EXEMPT.has(a));
    expect(missing, "these scripts are not in bump_frontend.sh's ASSETS").toEqual([]);
    // …and the exemptions must stay exemptions-by-name, not a hole:
    // the chunk loop has to know about the chunk.
    expect(bump).toMatch(/help-me-chat\.js/);
  });

  test("the layer modules load BEFORE app.js", () => {
    // app.js registers the overlays from the module globals at parse time.
    const appAt = indexHtml.indexOf("app.js?");
    expect(appAt).toBeGreaterThan(-1);
    for (const f of layerFiles) {
      const at = indexHtml.indexOf(f);
      expect(at, `${f} is not in index.html`).toBeGreaterThan(-1);
      expect(at, `${f} must load before app.js`).toBeLessThan(appAt);
    }
  });
});

describe("frontend — no direct console use", () => {
  test("app.js never calls console.* directly", () => {
    // AGENTS.md: use XLog.warn()/XLog.error()/… — the console guard
    // swallows the output anyway.
    const direct = appJs.match(/^\s*console\.(log|warn|error|debug|info)\(/gm) || [];
    expect(direct).toEqual([]);
  });

  test("the layer modules never call console.* directly", () => {
    for (const f of readdirSync(ROOT).filter((x) => /-layer\.js$/.test(x))) {
      const js = readFileSync(join(ROOT, f), "utf8");
      const direct = js.match(/^\s*console\.(log|warn|error|debug|info)\(/gm) || [];
      expect(direct, `${f} calls console.* directly`).toEqual([]);
    }
  });

  test("globe.js never calls console.* directly either", () => {
    // The globe page is not covered by the *-layer.js scan above, but
    // the same rule applies — XLog is the supported path.
    const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
    const direct = globeJs.match(/^\s*console\.(log|warn|error|debug|info)\(/gm) || [];
    expect(direct, "globe.js calls console.* directly").toEqual([]);
  });
});

describe("the globe page — its assets are stamped too", () => {
  const globeHtml = readFileSync(join(ROOT, "globe.html"), "utf8");

  test("globe.html loads the globe bundle and the vendored MapLibre", () => {
    expect(globeHtml).toContain("globe.js");
    expect(globeHtml).toContain("globe.css");
    expect(globeHtml).toContain("vendor/maplibre-gl/maplibre-gl.js");
  });

  test("every globe asset carries a ?v= token", () => {
    for (const a of ["globe.js", "globe.css", "vendor/maplibre-gl/maplibre-gl.js",
                     "vendor/maplibre-gl/maplibre-gl.css"]) {
      const m = globeHtml.match(new RegExp(a.replace(/[/.]/g, "\\$&") + "\\?v=(\\d+)"));
      expect(m, `${a} has no ?v= token`).toBeTruthy();
    }
  });

  test("bump_frontend.sh stamps the globe page as well", () => {
    expect(bump).toMatch(/globe\.html/);
    for (const a of ["globe.js", "globe.css", "vendor/maplibre-gl/maplibre-gl.js"]) {
      expect(bump, `${a} is not stamped`).toContain(a);
    }
  });
});

describe("lazy chunk URLs never go stale", () => {
  const CHUNKS = ["flag-quality.js", "ai-story-chat.js", "help-me-chat.js"];

  test("bump_frontend.sh stamps chunks in BOTH index.html and app.js", () => {
    // loadChunk('flag-quality.js?v=…') lives inside app.js — the
    // index.html-only stamping loop never touched it, so those URLs
    // froze at 2026090428 (September) while the chunks changed.
    expect(bump).toMatch(/flag-quality\.js/);
    expect(bump).toMatch(/ai-story-chat\.js/);
    expect(bump).toMatch(/help-me-chat\.js/);
    // The chunk loop must iterate app.js, not just the HTML.
    expect(bump).toMatch(/public_html\/app\.js/);
  });

  test("no chunk reference anywhere still carries a pre-October token", () => {
    // Every ?v= on a chunk must be a recent (October) stamp — a frozen
    // September token means cached browsers never pick up the chunk.
    for (const f of ["index.html", "app.js"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const chunk of CHUNKS) {
        const re = new RegExp(chunk.replace(".", "\\.") + "\\?v=(\\d+)", "g");
        for (const m of src.matchAll(re)) {
          expect(Number(m[1]), `${f}: ${chunk} stale token ${m[1]}`).toBeGreaterThan(20261001);
        }
      }
    }
  });
});

describe("lazy chunks — stamped everywhere they are referenced", () => {
  const CHUNKS = ["flag-quality.js", "ai-story-chat.js", "help-me-chat.js"];

  test("bump_frontend.sh stamps chunks in index.html AND app.js", () => {
    // The loadChunk() URLs in app.js went stale at 2026090428 because
    // the bump script only ever touched index.html — changing a chunk
    // left cached browsers on the old one forever.
    expect(bump).toMatch(/flag-quality\.js/);
    expect(bump).toMatch(/ai-story-chat\.js/);
    expect(bump).toMatch(/help-me-chat\.js/);
    expect(bump).toMatch(/public_html\/app\.js/);
  });

  test("every chunk reference carries the SAME token as the main assets", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    const app = readFileSync(join(ROOT, "app.js"), "utf8");
    // The build stamp is the token app.js carries — bump_frontend.sh
    // moves the main assets and the chunks together. Do NOT use "the
    // newest token in the page": overlay-opacity.js and map-presets.js
    // move independently via bump_asset_token.sh (AGENTS.md) and are
    // allowed to hold a newer stamp than the build.
    const current = (html.match(/app\.js\?v=(\d+)/) || [])[1];
    expect(current, "index.html has no stamped app.js").toBeTruthy();
    for (const chunk of CHUNKS) {
      const refs = [...(html + "\n" + app).matchAll(
        new RegExp(chunk.replace(".", "\\.") + "\\?v=(\\d+)", "g"))];
      expect(refs.length, `${chunk} has no ?v= reference`).toBeGreaterThan(0);
      for (const r of refs) {
        expect(r[1], `${chunk} has a stale token ${r[1]} (current ${current})`)
          .toBe(current);
      }
    }
  });
});

describe("the popup shows the story tree", () => {
  test("the related-stories section renders the tree, not the old links panel", () => {
    expect(appJs).toMatch(/popup-tree-branch|popup-tree-items/);
    // The old panel and its dead CSS were removed with it.
    expect(appJs).not.toMatch(/renderPinLinks/);
  });

  test("the tree container is the one the popup markup creates", () => {
    expect(appJs).toMatch(/popup-links-container/);
    expect(appJs).toMatch(/renderPinTree\(el, pin\)/);
  });
});

describe("the story tree renders every branch", () => {
  test("the collapsed long-tail bucket still RENDERS its items", () => {
    // It used to render `b.children.slice(0, 0)` — a bucket with a count
    // on the button but nothing inside, so "Show 55 weak connections"
    // revealed an empty box.
    expect(appJs).not.toMatch(/children\.slice\(0, 0\)/);
    expect(appJs).toMatch(/const collapsed = b\.key === "weak";/);
  });

  test("the weak bucket is collapsed with a button, not removed", () => {
    expect(appJs).toMatch(/popup-tree-more/);
    expect(appJs).toMatch(/Show .* weak connections/);
  });
});

describe("the shared link carries the style", () => {
  test("getMapHash writes `slug@pct` for every overlay", () => {
    expect(appJs).toMatch(/overlayOpacityFor\(name\)/);
    expect(appJs).toMatch(/`\$\{slug\}@\$\{pct\}`/);
  });

  test("parseMapHash reads `slug@pct` and tolerates a bare slug", () => {
    expect(appJs).toMatch(/lastIndexOf\("@"\)/);
    expect(appJs).toMatch(/opacity:\s*null/);
  });

  test("a restored opacity reaches the layer AND the slider", () => {
    expect(appJs).toMatch(/function applyOverlayOpacity\(/);
    expect(appJs).toMatch(/OverlayOpacity\.set\(/);
  });
});
