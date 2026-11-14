// live-panel-tabs.bun.test.js — the live feed's tab strip and the
// "🤖 AI Suggested" tab behind it. (Owner, 2026-11-13: *"when the live
// feed pops up.. the Ai suggested isn't really showing correctly its all
// smooshed"*.)
//
// TWO SEPARATE DEFECTS, AND THE SECOND ONE IS THE WORSE
//
// 1. THE STRIP WAS SQUEEZED. Five tabs in a 320 px panel, one flex
//    row: each tab got ~58 px, so "🤖 AI Suggested" broke into FOUR
//    lines, every other label into two, and the strip overflowed the
//    panel by 14 px — the last tab was cut off at the panel's edge
//    (measured in the browser: 300 px of content in a 285.8 px box).
//    It is a GRID now: two columns, and the longest label takes the
//    whole last row.
//
// 2. THE TAB NEVER LOADED. It asked `/api/pins?min_confidence=0.85`
//    with NO time window, and the articles leg of that query has no
//    time predicate — so the plan was a sequential scan of the 17 GB
//    `news_articles` table behind a window function. MEASURED live:
//    the query was still running after THIRTEEN MINUTES (four copies of
//    it, each reading 17 GB), and the tab said "Loading AI
//    Suggestions…" for the whole of that time.
//
//    The tab is windowed now: the panel's own time filter, capped at
//    three days, and NEVER unbounded — "all time" is exactly the filter
//    that must not reach this query.
//
// A SOURCE-SHAPE TEST PASSES AGAINST BROKEN CODE, so the measurements
// live in scripts/live_panel_audit.py (Playwright, the shipped page).
// This file pins the CONTRACT that the measurements found.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");

const cssBlock = (selector) => {
  const i = stylesCss.indexOf(selector);
  if (i < 0) return "";
  // A rule block: up to the next closing brace at the same level.
  let depth = 0, j = i;
  for (; j < stylesCss.length; j++) {
    if (stylesCss[j] === "{") depth++;
    else if (stylesCss[j] === "}") { depth--; if (depth === 0) break; }
  }
  return stylesCss.slice(i, j + 1);
};

describe("the tab strip", () => {
  test("it is a GRID with two columns — not one flex row of five", () => {
    const strip = cssBlock(".live-panel-tabs {");
    expect(strip).toContain("display: grid");
    expect(strip).toContain("grid-template-columns: 1fr 1fr");
    // The old flex row gave every tab ~58 px. `flex: 1` on a grid item
    // does nothing, so it must be GONE (it would read as "still a flex
    // row" to the next reader).
    expect(cssBlock(".live-panel-tab {")).not.toContain("flex:");
  });

  test("a label never wraps", () => {
    const tab = cssBlock(".live-panel-tab {");
    expect(tab).toContain("white-space: nowrap");
    // The safety net for a viewport narrower than the design.
    expect(tab).toContain("overflow: hidden");
    expect(tab).toContain("text-overflow: ellipsis");
  });

  test("the longest label — 🤖 AI Suggested — takes the whole last row", () => {
    expect(stylesCss).toMatch(/\.live-panel-tab:last-child\s*\{\s*grid-column:\s*1\s*\/\s*-1;/);
  });

  test("a narrow phone and the largest text size fall back to ONE column", () => {
    // Below ~330 px even a trimmed header cannot fit two columns.
    expect(stylesCss).toMatch(/@media \(max-width: 330px\)[\s\S]{0,200}?\.live-panel-tabs\s*\{\s*grid-template-columns:\s*1fr;/);
    // At A++ (--ui-zoom 1.3) the header's content box is 290/1.3 =
    // 223 px, so a half-column is 111 px — narrower than "🔥 Hot &
    // Latest" needs.
    expect(stylesCss).toMatch(/html\.ts-130 \.live-panel-tabs\s*\{\s*grid-template-columns:\s*1fr;/);
  });

  test("the five tabs are still the five tabs", () => {
    for (const t of ["hot", "your", "near", "local", "neural"]) {
      expect(indexHtml).toContain(`data-tab="${t}"`);
    }
  });
});

describe("the AI Suggested tab", () => {
  test("its query is ALWAYS windowed — the unbounded one is gone", () => {
    // The old URL scanned the whole corpus.
    expect(appJs).not.toContain("/api/pins?min_confidence=0.85&limit=30");
    // The new one asks the map endpoint (the site's hot path) with a
    // `since`, and a window it computes itself.
    expect(appJs).toMatch(/\/api\/pins\/map\?bbox=-180,-85,180,85&limit=\$\{AI_SUGGEST_FETCH\}/);
    expect(appJs).toContain("&since=${encodeURIComponent(since)}");
  });

  test("the window is capped at three days — 'all time' must not reach it", () => {
    expect(appJs).toMatch(/const AI_SUGGEST_MAX_DAYS = 3;/);
    // getSinceDate() answers null for the "All" filter, so the cap is
    // what keeps the query bounded.
    expect(appJs).toMatch(/function aiSuggestedSince\(\)/);
    // THE ARITHMETIC IS THE POINT. A window is [since, now], so a
    // SHORTER window has the LATER start: the answer is the LATER of
    // the reader's `since` and the cap (max), not the earlier one.
    // Taking the earlier would have made the cap WIDEN the window —
    // the default 24 h filter would have asked for three days, and
    // "all time" for the whole corpus.
    expect(appJs).toMatch(/Number\.isFinite\(t\) && t > cap \? t : cap/);
    expect(appJs).not.toMatch(/t < cap \? t : cap/);
  });

  test("it gives up after a timeout instead of saying 'Loading…' for ever", () => {
    expect(appJs).toMatch(/const AI_SUGGEST_TIMEOUT_MS = 25_000;/);
    expect(appJs).toContain("AbortController");
    expect(appJs).toContain("The AI suggestions took too long");
  });

  test("a failed list says so — it never shows a DIFFERENT answer under the same name", () => {
    // The old code fell back to the feed's hot list: a different answer
    // under the tab's name, which the reader cannot see.
    const fn = appJs.slice(appJs.indexOf("async function renderAiSuggestedTab()"),
                           appJs.indexOf("async function renderAiSuggestedTab()") + 3200);
    expect(fn).not.toContain("liveState.feed?.hot");
    expect(fn).toContain("could not be loaded");
  });

  test("the confidence badge is never an invented number", () => {
    // The old code answered `confidence_score || 0.9` — so a story the
    // server had said NOTHING about was shown as "🤖 90% Match".
    const fn = appJs.slice(appJs.indexOf("async function renderAiSuggestedTab()"),
                           appJs.indexOf("async function renderAiSuggestedTab()") + 3200);
    expect(fn).not.toMatch(/confidence_score \|\| 0\.9/);
    expect(fn).toMatch(/it\.confidence_score != null/);
  });

  test("a card says WHERE the story is", () => {
    // The map endpoint carries the country at the top level
    // (`source_country`); the list endpoint carried it inside `location`.
    const fn = appJs.slice(appJs.indexOf("async function renderAiSuggestedTab()"),
                           appJs.indexOf("async function renderAiSuggestedTab()") + 3200);
    expect(fn).toContain("it.source_country");
    expect(fn).toContain("it.place_name");
  });
});
