// viewport-nudge.js — surfaces a friendly "🔍 See new news! Reload to see
// what's here now" toast when the map appears to be showing pins that don't
// match the current viewport.
//
// Background: the "second pan doesn't fill the map with new pins" bug is a
// known bbox/viewport mismatch issue (task #33). While we work the root
// cause, this gives users a clear escape hatch — a one-click reload that
// refetches the pin set for whatever the map is actually showing.
//
// Detection: when a pin fetch completes and the user has panned far enough
// that the bbox we just fetched is now mostly off-screen, we count that as
// a "viewport mismatch". Two mismatches within a short window triggers the
// nudge. This avoids false positives from normal jittery panning.
//
// Relies on window.XyzoNudge (set up by update-check.js). Loads cleanly if
// the map is not present (no-op). Designed to be safe to include on every
// page — the script waits for window.map and otherwise idles.

(function () {
  "use strict";

  // Tuneables. Conservative by design — we never want to annoy real users.
  var MISMATCH_THRESHOLD = 0.5;   // 50% of the fetched bbox must be off-screen
  var MISMATCHES_TO_NUDGE = 2;    // need 2 bad fetches in the window
  var NUDGE_WINDOW_MS = 15_000;   // mismatches must happen within 15s
  var NUDGE_SNOOZE_KEY = "xyzo:viewportNudgeSnoozeUntil";
  var NUDGE_SNOOZE_MS = 5 * 60 * 1000; // "Maybe later" suppresses for 5 min
  var BOOT_GRACE_MS = 4_000;      // don't nudge in the first 4s of life
  var MAX_RETRIES = 30;           // wait up to ~15s for window.map (500ms ticks)
  var RETRY_MS = 500;

  var bootAt = Date.now();
  var mismatches = []; // timestamps of recent mismatches

  function isSnoozed() {
    try {
      var until = Number(localStorage.getItem(NUDGE_SNOOZE_KEY) || 0);
      return until && Date.now() < until;
    } catch (_) {
      return false;
    }
  }

  function setSnooze() {
    try {
      localStorage.setItem(NUDGE_SNOOZE_KEY, String(Date.now() + NUDGE_SNOOZE_MS));
    } catch (_) {}
  }

  // Compute the fraction of `fetchedBbox` (an L.B.R.T tuple) that is still
  // visible inside `currentBounds` (a Leaflet LatLngBounds). Returns a
  // number 0..1 where 1 = fully on-screen, 0 = fully off-screen.
  function overlapFraction(fetchedBbox, currentBounds) {
    var w = Math.max(fetchedBbox.west, currentBounds.getWest());
    var e = Math.min(fetchedBbox.east, currentBounds.getEast());
    var s = Math.max(fetchedBbox.south, currentBounds.getSouth());
    var n = Math.min(fetchedBbox.north, currentBounds.getNorth());
    if (e <= w || n <= s) return 0; // no overlap at all
    var intersectW = e - w;
    var intersectH = n - s;
    // At very high latitudes the width shrinks to zero, so weight overlap
    // by 1/cos(lat) to keep the metric meaningful.
    var latMid = (s + n) / 2;
    var widthWeight = 1 / Math.max(0.05, Math.cos((latMid * Math.PI) / 180));
    var fetchedW = Math.max(0.000001, (fetchedBbox.east - fetchedBbox.west) * widthWeight);
    var fetchedH = Math.max(0.000001, fetchedBbox.north - fetchedBbox.south);
    return (intersectW * widthWeight * intersectH) / (fetchedW * fetchedH);
  }

  function maybeNudge() {
    if (isSnoozed()) return;
    if (Date.now() - bootAt < BOOT_GRACE_MS) return;
    if (typeof window.XyzoNudge === "undefined") return;

    var now = Date.now();
    // Drop mismatches outside the rolling window.
    mismatches = mismatches.filter(function (t) { return now - t <= NUDGE_WINDOW_MS; });
    if (mismatches.length < MISMATCHES_TO_NUDGE) return;

    // Reset so we don't keep re-firing for the same broken state. The next
    // round of mismatches will retrigger if the bug keeps happening.
    mismatches = [];

    window.XyzoNudge.showReload({
      title: "🔍 The pins might be lagging behind the map",
      body: "We spotted a known bug where panning twice can leave older pins on screen. A quick reload pulls fresh pins for whatever you're looking at right now.",
      ctaLabel: "🔄 See new news!",
      onReload: function () {
        try { localStorage.removeItem(NUDGE_SNOOZE_KEY); } catch (_) {}
        window.location.reload();
      },
      onSnooze: function () {
        setSnooze();
      },
    });
  }

  function checkMismatch() {
    if (!window.map) return;
    var perf = window._mapPerf;
    if (!perf || !perf.bbox || !perf.render_end) return;
    // Only consider fetches that actually painted.
    if (perf.aborted) return;

    // The bbox in _mapPerf is the CSV string the fetch used. Re-parse it
    // (w,s,e,n) and compare to the map's current bounds.
    var parts = String(perf.bbox).split(",").map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return;
    var fetchedBbox = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
    var currentBounds = window.map.getBounds();
    if (!currentBounds.isValid()) return;

    var overlap = overlapFraction(fetchedBbox, currentBounds);
    // overlap is the fraction of the FETCHED bbox still on screen. If less
    // than (1 - MISMATCH_THRESHOLD) is on screen, we've moved past it.
    if (overlap < 1 - MISMATCH_THRESHOLD) {
      mismatches.push(Date.now());
      maybeNudge();
    }
  }

  function attach() {
    if (!window.map || typeof window.map.on !== "function") return false;

    // The `_shipMapPerf` hook fires inside requestAnimationFrame right after
    // the canvas paints. By the time we run, the new pins are visible — so
    // comparing fetched bbox to current bounds is meaningful.
    var original = window._shipMapPerf;
    window._shipMapPerf = function () {
      try { if (typeof original === "function") original(); } catch (_) {}
      // Defer one more tick so any synchronous DOM updates settle.
      setTimeout(checkMismatch, 0);
    };

    return true;
  }

  // Wait for window.map to be ready. Some pages initialize the map async.
  function waitForMap(attempts) {
    if (attach()) return;
    if (attempts <= 0) return; // map never showed up — no-op, that's fine
    setTimeout(function () { waitForMap(attempts - 1); }, RETRY_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForMap(MAX_RETRIES); });
  } else {
    waitForMap(MAX_RETRIES);
  }
})();
