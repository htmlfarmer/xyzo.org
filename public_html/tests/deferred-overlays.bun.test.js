/**
 * deferred-overlays.bun.test.js — the staged overlays must be released
 * on EVERY outcome of the boot pin fetch, not only on a successful one.
 *
 * THE BUG (owner report, 2026-11-19): *"if you load a page.. not all the
 * tiles will load but if you wait like 2 min or 3 min finally the last
 * tiles will all turn blue… you maybe even have to pan around the map."*
 *
 * `restoreMapView()` STAGES the overlays a shared link names: it records
 * the name immediately (so the hash rewrite is unchanged) and defers the
 * actual `layer.addTo(map)` until the markers have been painted. That is
 * deliberate and is measured — adding nine overlays up front makes the
 * browser decode 280 tile images on the main thread before the pin canvas
 * draws (AGENTS.md "The Markers Waited for the Browser to Decode 280
 * Tile Images").
 *
 * The defect was WHERE the deferred queue got drained. It had exactly one
 * call site: inside `if (items.length > 0)` in fetchPinsForViewport. So
 * every other way out of that function dropped the queue on the floor:
 *
 *   • the 25 s auto-abort firing while the NDJSON body was still streaming
 *   • an HTTP 5xx, a network error, an exception
 *   • an EMPTY result (`items.length === 0` — a sparse area is normal)
 *   • a fetch superseded by a newer one (the stale `inflightCtrl` guard)
 *   • the markers-off / content-layers-off early returns, which never
 *     reach the `try` block at all
 *
 * Measured against the owner's own link over a throttled Regular-3G
 * connection: `/api/pins/map` answered **200**, and **215 s later** the
 * overlay tiles had still never been requested — only the 28 basemap
 * tiles had ever loaded. The reader saw a basemap and waited, and the
 * overlays only appeared when some later fetch happened to succeed with
 * pins, i.e. when they panned.
 *
 * These tests pin the shape that makes that impossible: the drain lives
 * in the fetch's `finally` (every outcome settles there), the early exits
 * drain themselves, and a backstop catches a boot where no fetch runs at
 * all.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

/** The body of fetchPinsForViewport — everything from its declaration to
 *  the `function filterToViewport` that follows it. */
function fetchPinsBody() {
  const start = appJs.indexOf("async function fetchPinsForViewport");
  expect(start).toBeGreaterThan(-1);
  const end = appJs.indexOf("function filterToViewport", start);
  expect(end).toBeGreaterThan(start);
  return appJs.slice(start, end);
}

/** The `finally` block of fetchPinsForViewport. */
function fetchPinsFinally() {
  const body = fetchPinsBody();
  const at = body.lastIndexOf("} finally {");
  expect(at).toBeGreaterThan(-1);
  return body.slice(at);
}

/** The staging call site in applyLayersFromParsedHash. */
function stagingSite() {
  const at = appJs.indexOf("_deferredOverlayAdds.push");
  expect(at).toBeGreaterThan(-1);
  return appJs.slice(at, at + 900);
}

describe("the staged overlays are released on EVERY pin-fetch outcome", () => {
  test("the fetch's `finally` drains the queue — the one path every exit shares", () => {
    // This is THE fix. Before it the only drain was inside
    // `if (items.length > 0)`, so an abort / 5xx / empty result /
    // exception / superseded fetch stranded every overlay the link named.
    expect(fetchPinsFinally()).toMatch(/scheduleDeferredOverlayFlush\(\)/);
  });

  test("the `finally` only skips when a NEWER fetch has taken over", () => {
    // A superseded fetch must not start 280 tile decodes before the
    // fetch that now owns the canvas paints its markers. But the guard
    // must be an IDENTITY guard, not a success guard: releasing when
    // this was the last fetch (or when none is in flight) is required.
    const fin = fetchPinsFinally();
    expect(fin).toMatch(/inflightCtrl\s*===\s*ctrl/);
    expect(fin).toMatch(/stillMine\s*\|\|\s*!inflightCtrl/);
  });

  test("the success branch uses the SHARED helper, not its own frame chain", () => {
    // Two independent `requestAnimationFrame(() => requestAnimationFrame`
    // chains around one queue are how the two paths drift. The helper is
    // idempotent, so both paths may call it unconditionally.
    const body = fetchPinsBody();
    const successAt = body.indexOf("if (items.length > 0)");
    expect(successAt).toBeGreaterThan(-1);
    expect(body.slice(successAt, successAt + 700)).toMatch(
      /scheduleDeferredOverlayFlush\(\)/,
    );
  });

  test("every drain goes through the one helper", () => {
    const body = fetchPinsBody();
    const calls = body.match(/scheduleDeferredOverlayFlush\(\)/g) || [];
    // success branch + finally + the two early returns. The old code had
    // ZERO of these — it called flushDeferredOverlays() directly, once.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // …and nothing inside the fetch reaches past the helper to the raw
    // drain, which would bypass the two-frame markers-first ordering.
    expect(body.match(/(?<!function )flushDeferredOverlays\(\)/g) || []).toEqual([]);
  });
});

describe("the early exits that never reach the `try` drain themselves", () => {
  test("markers-off and content-layers-off return paths release the queue", () => {
    const body = fetchPinsBody();
    const first = body.indexOf("canvasRenderer.setPins([])");
    expect(first).toBeGreaterThan(-1);
    // Both blocks setPins([]) then clearAllMarkers() then return; both
    // must have drained the queue before that return, because the
    // `finally` they skipped is the only other drain.
    const both = body.slice(0, body.indexOf("// ── Boot guard"));
    expect(both.match(/scheduleDeferredOverlayFlush\(\)/g) || []).toHaveLength(2);
  });

  test("the boot-guard retry does NOT drain (a retry is still coming)", () => {
    const body = fetchPinsBody();
    const guard = body.indexOf("map not sized yet");
    expect(guard).toBeGreaterThan(-1);
    const slice = body.slice(guard, guard + 400);
    expect(slice).toMatch(/setTimeout\(fetchPinsForViewport, 200\)/);
    expect(slice).not.toMatch(/scheduleDeferredOverlayFlush/);
  });
});

describe("a boot where NO pin fetch runs still releases the overlays", () => {
  test("staging arms a backstop", () => {
    // Staging without a backstop is the exact shape of the bug: a queue
    // whose only drain is a function that does not always run.
    expect(stagingSite()).toMatch(/armOverlayFlushBackstop\(\)/);
    expect(appJs).toMatch(/function armOverlayFlushBackstop/);
  });

  test("the backstop waits for a legitimate flush, then bounds the wait", () => {
    const at = appJs.indexOf("function armOverlayFlushBackstop");
    expect(at).toBeGreaterThan(-1);
    const fn = appJs.slice(at, appJs.indexOf("\n}", at));
    // It must defer to a flush already queued and to an in-flight fetch,
    // or it would beat the normal path and steal the markers ordering…
    expect(fn).toMatch(/_overlayFlushScheduled/);
    expect(fn).toMatch(/inflightCtrl/);
    // …and it must not re-arm for ever (a hidden tab pauses rAF, which
    // would leave the "already scheduled" branch stuck true).
    expect(fn).toMatch(/OVERLAY_BACKSTOP_MAX_MS/);
    expect(fn).toMatch(/flushDeferredOverlays\(\)/);
  });

  test("the backstop window is finite and longer than one re-arm", () => {
    const backstop = Number(
      (appJs.match(/const OVERLAY_BACKSTOP_MS = (\d+)/) || [])[1],
    );
    const max = Number(
      (appJs.match(/const OVERLAY_BACKSTOP_MAX_MS = (\d+)/) || [])[1],
    );
    expect(Number.isFinite(backstop)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(backstop).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(backstop);
  });

  test("the ceiling OUTLASTS the pin fetch's own 25 s auto-abort", () => {
    // Every pin fetch is guaranteed to settle: fetchPinsForViewport arms
    // setTimeout(…, 25000) which aborts the fetch, and an abort still
    // runs the `finally` that flushes. So the backstop must never beat
    // it — if it did, overlays would decode AHEAD of the markers, which
    // is exactly the ordering staging exists to prevent, reintroduced by
    // the safety net meant to guarantee the release instead.
    const abort = Number(
      (appJs.match(/setTimeout\(\(\) => \{ try \{ ctrl\.abort\(\); \} catch \(_\) \{\} \}, (\d+)\)/) || [])[1],
    );
    const max = Number(
      (appJs.match(/const OVERLAY_BACKSTOP_MAX_MS = (\d+)/) || [])[1],
    );
    expect(Number.isFinite(abort)).toBe(true);
    expect(abort).toBe(25000);
    expect(max).toBeGreaterThan(abort);
  });

  test("the fetch records that it was ATTEMPTED, for the backstop to read", () => {
    const body = fetchPinsBody();
    const at = body.indexOf("_pinFetchAttempted = true");
    expect(at).toBeGreaterThan(-1);
    // …and it must be set before the function's OWN `try`, so no exit
    // from that try can leave the backstop believing no fetch ever ran.
    // Match the 2-space-indented block opener: the body also contains
    // inner `try {` statements (the abort shim, the coordinator hook)
    // that sit AFTER it and would make a bare indexOf lie.
    const outerTry = body.search(/^\s{2}try \{$/m);
    expect(outerTry).toBeGreaterThan(-1);
    expect(at).toBeLessThan(outerTry);
  });
});

describe("draining re-arms the clocks for the next batch", () => {
  test("flush resets the staging timestamp and the attempt flag", () => {
    const at = appJs.indexOf("function flushDeferredOverlays");
    expect(at).toBeGreaterThan(-1);
    const fn = appJs.slice(at, appJs.indexOf("\n}", at));
    expect(fn).toMatch(/_overlayStagedAt = 0/);
    expect(fn).toMatch(/_pinFetchAttempted = false/);
    expect(fn).toMatch(/_overlayFlushScheduled = false/);
  });

  test("the helper is idempotent so every path may call it", () => {
    const at = appJs.indexOf("function scheduleDeferredOverlayFlush");
    expect(at).toBeGreaterThan(-1);
    const fn = appJs.slice(at, appJs.indexOf("\n}", at));
    // Guards BEFORE the assignment, or a second caller in the same tick
    // queues a second frame chain and the two paths race.
    const guardAt = fn.indexOf("_overlayFlushScheduled");
    const armAt = fn.indexOf("_overlayFlushScheduled = true");
    expect(guardAt).toBeGreaterThan(-1);
    expect(armAt).toBeGreaterThan(guardAt);
    expect(fn).toMatch(/_deferredOverlayAdds\.length/);
  });
});

describe("the markers-first ordering the staging exists for is preserved", () => {
  test("the release still waits two frames", () => {
    // The whole point of staging: one frame for the pin canvas to draw,
    // one for the browser to composite it, then 280 tile images decode.
    expect(appJs).toMatch(
      /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{\s*flushDeferredOverlays\(\);/,
    );
  });

  test("the name is still recorded IMMEDIATELY, so the hash rewrite is unchanged", () => {
    const addAt = appJs.indexOf("_activeOverlayNames.add(ovName)");
    const deferAt = appJs.indexOf("_deferredOverlayAdds.push");
    expect(addAt).toBeGreaterThan(-1);
    expect(deferAt).toBeGreaterThan(addAt);
  });
});
