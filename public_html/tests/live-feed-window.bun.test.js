// live-feed-window.bun.test.js — "Hot & Latest" must be HOT.
//
// Reported: the panel "says the same thing day after day" — a 28-day-old
// story sat at #1 under time=3d, and changing 3d -> 24h changed nothing.
//
// Three defects, all fixed together because they read as one symptom:
//
//   1. THE GRAPH TERM WON THE ORDER BY. `graphBoostExpr` multiplied
//      connectivity_score (stored 0..10) and same_event_avg_strength
//      (stored up to 3,357) as if they were 0..1 fractions, and carried
//      NO time factor at all. Measured: graph ≈ 4,600 against a recency
//      term peaking near 500, so five 27-29 day-old events ranked above
//      fresh ones carrying 419/330/223 sources.
//   2. NO WINDOW REACHED THE ROUTE. The client never sent one, the route
//      never read one — so time=3d and 24h were byte-identical.
//   3. THE EXPRESSION WAS WRITTEN OUT THREE TIMES (twice as
//      `graphBoostExpr`, once inlined in the stream's 60-second resync),
//      which is how a fix applied to two of them would have left one.
//
// Verified live after the fix: hours=24 truncates the oldest item to
// 0.91d (control 1.42d), and no window at all returns only 0.2-0.9d-old
// items at the top instead of 28-day-old ones.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const feedTs = readFileSync(join(ROOT, "..", "api", "src", "routes", "feed.ts"), "utf8");

describe("the graph term is one definition, decayed and scaled", () => {
  test("exactly one definition, and it is a factory taking the sql tag", () => {
    const defs = feedTs.match(/const graphBoostExpr = /g) || [];
    expect(defs.length).toBe(1);
    // Factory, because the file's module-scope `const sql = postgres.sql`
    // is undefined at runtime — only `import { sql } from "postgres"`
    // exports a tag — so it has always been dead code shadowed by each
    // handler's `const sql = getDb()`. Evaluating the fragment at module
    // scope threw "undefined is not a function" and 404'd the stream route.
    expect(feedTs).toMatch(/const graphBoostExpr = \(tag: any\) => tag`/);
  });

  test("all three call sites pass their own working tag", () => {
    const uses = feedTs.match(/\+ \$\{graphBoostExpr\(sql\)\}/g) || [];
    expect(uses.length).toBe(3);   // live + stream snapshot + stream resync
  });

  test("no raw un-normalised copy survives anywhere", () => {
    // The original was `COALESCE(g.connectivity_score, 0) * 5.0` with the
    // raw strength multiplied straight in. Exactly one ARITHMETIC use may
    // remain — the factory — and it must be the clamped form. (The other
    // three mentions are `AS graph_connectivity` projections that merely
    // report the value in the response, not score with it.)
    expect((feedTs.match(/COALESCE\(g\.connectivity_score/g) || []).length).toBe(1);
    expect(feedTs).not.toMatch(/COALESCE\(g\.connectivity_score, 0\) \* 5\.0/);
    expect(feedTs).toMatch(/LEAST\(COALESCE\(g\.connectivity_score, 0\) \/ 10\.0, 1\.0\) \* 5\.0/);
  });

  test("it applies the SAME decay as source_count", () => {
    // Without a time factor the graph term scores a 28-day-old event the
    // same as a 28-hour-old one — the reported symptom.
    expect(feedTs).toMatch(/exp\(-0\.05 \* EXTRACT\(EPOCH FROM \(now\(\) - e\.first_reported_at\)\) \/ 3600\)/);
  });

  test("both raw fields are clamped to a fraction", () => {
    // connectivity_score maxes at 10 in the DB; strength at 3,357.
    expect(feedTs).toMatch(/LEAST\(COALESCE\(g\.connectivity_score, 0\) \/ 10\.0, 1\.0\)/);
    expect(feedTs).toMatch(/LEAST\(COALESCE\(g\.same_event_avg_strength, 0\) \/ 1000\.0, 1\.0\)/);
  });
});

describe("a time window reaches the route and filters", () => {
  test("parseSince exists and is used by BOTH endpoints", () => {
    expect(feedTs).toMatch(/function parseSince\(/);
    const calls = feedTs.match(/parseSince\(c\)/g) || [];
    expect(calls.length).toBe(2);   // /feed/live and /feed/live/stream
  });

  test("it accepts the client's `hours` and the ISO `since`", () => {
    expect(feedTs).toMatch(/c\.req\.query\("hours"\)/);
    expect(feedTs).toMatch(/c\.req\.query\("since"\)/);
    expect(feedTs).toMatch(/Date\.parse\(iso\)/);
    // neither present must mean NO cutoff, or existing callers break
    expect(feedTs).toMatch(/return null;/);
  });

  test("the event cutoff is spliced into every event WHERE", () => {
    const cuts = feedTs.match(/\$\{eventCut\}/g) || [];
    expect(cuts.length).toBe(6);   // 3 hot + 3 near
    expect(feedTs).toMatch(/AND e\.first_reported_at >= \$\{since\}/);
  });

  test("the article backfill is cut too, or old articles fill the gap", () => {
    const cuts = feedTs.match(/\$\{articleCut\}/g) || [];
    expect(cuts.length).toBe(3);
    expect(feedTs).toMatch(/COALESCE\(a\.published_at, a\.fetched_at\) >= \$\{since\}/);
  });

  test("the cache key includes the window", () => {
    // Without it a 3d request can be served a 24h response and the time
    // control looks broken even though the queries are correct.
    expect(feedTs).toMatch(/const sinceKey = since \? Math\.floor\(since\.getTime\(\) \/ 60_000\) : "any"/);
    expect(feedTs).toMatch(/\$\{bboxKey\}:\$\{sinceKey\}/);
  });
});

describe("the client sends the window and refetches when it changes", () => {
  test("fetchLiveFeed passes `since` from the shared getSinceDate", () => {
    const block = appJs.slice(appJs.indexOf("async function fetchLiveFeed"));
    const body = block.slice(0, block.indexOf("\n}"));
    expect(body).toMatch(/getSinceDate\(timeFilter\)/);
    expect(body).toMatch(/url\.searchParams\.set\("since", sinceIso\)/);
    // "all" maps to null and must OMIT the parameter
    expect(body).toMatch(/if \(sinceIso\) url\.searchParams\.set/);
  });

  test("it reuses getSinceDate rather than keeping a second mapping", () => {
    // One vocabulary: the map's pin query and the panel's feed must agree
    // by construction, not by two tables kept in step.
    expect(appJs).toMatch(/function getSinceDate\(filter\)/);
    expect(appJs).toMatch(/getSinceDate\(timeFilter\)/);
  });

  test("changing the time control refetches the panel", () => {
    // setTimeFilter only moved the MAP before this; the panel kept its
    // previous window until something unrelated refetched it.
    const fn = appJs.slice(appJs.indexOf("function setTimeFilter"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/fetchLiveFeed\(true\)/);
    // TDZ-safe: `typeof` on a let in its temporal dead zone throws.
    expect(body).toMatch(/typeof liveState !== "undefined"/);
  });
});
