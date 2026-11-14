# Boot-Fetch Race Condition — Post-Mortem

## Date: 2026-09-11
## Severity: Medium-High (intermittent, user-visible "empty map" on every reload)
## Impact: All users, especially those who retype the URL or hit F5

---

## Symptoms

1. **Type `xyzo.org` in address bar**: Sometimes the map shows tiles but no pins. The "System Notice" banner may appear.
2. **F5 / Reload**: ~30-50% of the time, the map loads but no pins are visible until the user pans/zooms.
3. **Hard refresh (Ctrl+Shift+R)**: Works (re-randomizes timing enough that the bug doesn't manifest).
4. **No console errors**: Silent failure. The `System Notice` banner is sometimes triggered by the global error handler but often nothing surfaces.
5. **User debug packet** shows:
   ```json
   "boot": {
     "mapSize": { "x": 1920, "y": 0 },   ← height 0 is the canvas issue
     "canvasEnabled": true,
     "canvasPins": 1500,                  ← data IS in JS state
     "lastDrawnCount": 0                  ← but never drawn
   }
   ```
   OR (after the canvas fix):
   ```json
   "boot": {
     "mapSize": { "x": 1920, "y": 1080 },  ← canvas OK
     "canvasPins": 0,                       ← API returned 0
     "lastDrawnCount": 0
   }
   ```

There are actually **two distinct bugs** with similar symptoms. This postmortem covers #2; see `docs/canvas-race-condition-postmortem.md` for #1.

---

## Root Cause

`fetchPinsForViewport()` is called from many places nearly simultaneously during boot:

| Caller | Line | Trigger |
|--------|------|---------|
| `restoreMapView()` | ~2370 | URL hash → `map.setView()` → `moveend` → `reloadPins()` |
| `map.whenReady(() => setTimeout(fetchPinsForViewport, 1000))` | ~8584 | 1s after map is ready |
| Time-filter restore | ~10416, ~10484 | localStorage restore |
| Mode-toggle / refresh button | ~715, ~9390 | Various UI actions |
| `pageshow` bfcache handler | ~8604 | bfcache restore only |

Each call aborts any in-flight request:

```js
// fetchPinsForViewport() ~line 4769
if (inflightCtrl) {
  try { inflightCtrl.abort(); } catch (_) {}
}
const ctrl = new AbortController();
inflightCtrl = ctrl;
```

And the response handler silently discards late-arriving responses from superseded requests:

```js
// fetchPinsForViewport() ~line 4849
if (inflightCtrl !== ctrl) return;
```

So the **last call wins**. If that call's bbox computation lands on a transitional Leaflet state (mid-`setView` animation, mid-resize), the API gets a degenerate bbox and returns 0 pins. The user sees an empty map. **Until they manually pan, the map stays empty — there's no retry.**

### Why hard refresh "fixed" it

Hard refresh re-randomizes the timing of the calls (cold caches, no lingering timers). Sometimes the last call wins on a settled bbox and returns pins. It's the same race, just with better luck.

### Why the existing `pageshow` handler didn't help

```js
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return; // ← only fires for bfcache restore
  ...
  fetchPinsForViewport();
});
```

The comment claims "When the user types the URL again (or hits back), the browser may restore the page from the back-forward cache (bfcache)." But **typing `xyzo.org` and hitting Enter is NOT a bfcache restore — it's a fresh navigation** (`event.persisted === false`). The handler silently returns. The comment's intent doesn't match what the browser actually does for that action.

### Why Playwright originally had trouble reproducing it

Playwright's `goto()` waits for `load`/`domcontentloaded`/`networkidle`, all of which happen AFTER Leaflet's boot animations have settled. The race window (the few hundred milliseconds between `L.map()` and the first settled bbox) is closed by the time Playwright probes state. In real browsers — especially with slow CSS font loading, GPU compositing, or first-paint work — the window stays open much longer and the race fires.

---

## The Fix: Boot-Fetch Coordinator

A small state machine added at the bottom of `app.js` (around line 8580, right before `map.whenReady`). All the boot-time triggers now defer to it instead of fighting each other.

### State machine

```
                            move/zoom
                              │
                              ▼
    ┌────────────────►  idle   │  (no settle timer running)
    │                          │
    │                          │  moveend / zoomend
    │                          ▼
    │              settled-pending
    │                          │  SETTLE_MS (250ms) of silence
    │                          ▼
    │                       in-flight
    │                          │  response arrives
    │                  ┌───────┴───────┐
    │                  ▼               ▼
    │              pins > 0       pins === 0
    │                  │               │
    │                  ▼               │  BOOT_RETRY_MS (500ms)
    │              done-ok            ▼
    │                            done-empty
    │                                  │  retry fires
    │                                  ▼
    │                             done-retry
    │                                  │  retry response
    │                          ┌───────┴───────┐
    │                          ▼               ▼
    │                       pins > 0      pins === 0
    │                          │               │
    │                          ▼               ▼
    │                      done-ok    done-empty-gave-up
    │
    └────────── BOOT_GRACE_MS (5s) expires ───► expired
```

After reaching `done-ok` or `expired`, the coordinator becomes **inert** — it does nothing on subsequent `moveend` events. Normal pan/zoom behaviour is unchanged.

### Code (key parts)

```js
// ── Boot-fetch coordinator ────────────────────────────────────────────
const SETTLE_MS = 250;
const BOOT_GRACE_MS = 5000;
const BOOT_RETRY_MS = 500;

const _bootCoord = {
  state: "idle",           // current state from the diagram above
  isBootFetch: false,      // flag: next fetch is the canonical boot fetch
  moveTimer: null,
  retryTimer: null,
};
window._bootCoord = _bootCoord;

// Wait for 250ms of moveend/zoomend silence before firing the fetch.
function _bootCoordMarkSettled() {
  if (_bootCoord.state !== "idle" && _bootCoord.state !== "settled-pending") return;
  if (_bootCoord.state === "idle") _bootCoord.state = "settled-pending";
  if (_bootCoord.moveTimer) clearTimeout(_bootCoord.moveTimer);
  _bootCoord.moveTimer = setTimeout(() => {
    _bootCoord.moveTimer = null;
    if (_bootCoord.state !== "settled-pending") return;
    _bootCoord.state = "in-flight";
    _bootCoord.isBootFetch = true;
    if (typeof reloadPins === "function") reloadPins();
    else fetchPinsForViewport();
  }, SETTLE_MS);
}

// Hook the coordinator into move/zoom events.  No-op once done-ok/expired.
map.on("movestart", () => {
  if (_bootCoord.state === "done-ok" || _bootCoord.state === "expired") return;
  _bootCoordCancelTimers();
  _bootCoord.state = "idle";
});
map.on("moveend", () => _bootCoordMarkSettled());
map.on("zoomend", () => _bootCoordMarkSettled());

// Hook into fetchPinsForViewport's success path.
window._bootFetchComplete = function (count, ctrl) {
  if (!_bootCoord.isBootFetch) return;
  _bootCoord.isBootFetch = false;
  _bootCoord.pinCount = count;
  if (count > 0) {
    _bootCoord.state = "done-ok";
    return;
  }
  if (_bootCoord.state === "done-retry") {
    _bootCoord.state = "done-empty-gave-up";  // one retry only
    return;
  }
  _bootCoord.state = "done-empty";
  _bootCoord.retryTimer = setTimeout(() => {
    _bootCoord.state = "done-retry";
    _bootCoord.isBootFetch = true;
    reloadPins();
  }, BOOT_RETRY_MS);
};
```

The hook fires from `fetchPinsForViewport`'s success path, right after `setPins`:

```js
// fetchPinsForViewport() ~line 5268
const hashPin = parseMapHash(window.location.hash)?.pinId;
if (hashPin) openPinPopup(hashPin);

try {
  const current = (canvasRenderer?._pins?.length) || 0;
  window._bootFetchComplete?.(current, ctrl);
} catch (_) { /* never fatal */ }
```

### Gating `reloadPins`

`reloadPins` is the canonical `moveend` → `fetchPinsForViewport()` path. Without gating, every `moveend` during boot would fire its own fetch, racing with the coordinator. The fix:

```js
const reloadPins = throttle(() => {
  // If the boot coordinator is still settling, defer to it instead of
  // firing our own fetch — both paths would race and whichever lands
  // last would supersede the canonical boot fetch.
  if (window._bootCoord && (
    _bootCoord.state === "idle" ||
    _bootCoord.state === "settled-pending"
  )) {
    _bootCoord.isBootFetch = true;
    return;
  }
  _mapPerf.move_end = performance.now();
  // ... existing perf instrumentation ...
  fetchPinsForViewport();
}, 250);
```

### Removed the redundant `map.whenReady` safety net

```js
// BEFORE (caused the race to fire more often)
map.whenReady(() => {
  setTimeout(() => {
    if (!window._xyzoMapReady) fetchPinsForViewport();
  }, 1000);
});

// AFTER (coordinator handles it)
map.whenReady(() => {
  setTimeout(() => {
    if (_bootCoord.state === "in-flight" || ...) return;
    if (window._xyzoMapReady) _bootCoordMarkSettled();
    // No direct fetchPinsForViewport() — coordinator owns the lifecycle.
  }, 1000);
});
```

---

## Why "one retry" instead of "retry until success"

The user (and this AI's brief) asked for "retry once after ~500ms". Reasoning:

- **Network errors** are caught by a separate path (`catch` block) that calls `restoreCachedPinsOrError()` and shows the stale banner. That's the right behaviour.
- **Empty bbox** is not a network error — the API responded successfully with `{ items: [], count: 0 }`. A retry within a few hundred ms is meaningful (the bbox may have settled by then), but **a longer retry chain is the wrong tool** — the API is genuinely saying "no pins match this bbox" and the user is better served by seeing the empty state and panning manually.
- An infinite retry loop wastes API quota, leaks AbortControllers, and never gives up. We tried it during development and watched API calls pile up at 50+/sec.

The grace window (5s) is the upper bound — after that, the coordinator becomes inert even if everything is empty.

---

## Test Coverage

`tests/canvas-race-condition.test.js` was extended to cover:

1. **Coordinator state reaches `done-ok`** within 5s of page load
2. **Coordinator state reaches `expired`** within 5s even if nothing fires
3. **Empty-first-fetch triggers retry** (verified via `__xyzoBootCoordinator` mock + Playwright route intercept)
4. **Single retry**: a 2nd empty result does NOT trigger a 3rd call
5. **User pan during boot** cancels the pending retry (no phantom re-fetch)
6. **Coordinator becomes inert** after `done-ok` — normal pan/zoom calls fetch directly

Plus a Python regression test at `tests/test_boot_fetch_coordinator.py` that exercises the same scenarios via headless Playwright in CI.

---

## Files Changed

| File | Change |
|------|--------|
| `public_html/app.js` | Boot-fetch coordinator (state machine), `reloadPins` gate, removed redundant `whenReady` fetch, `_bootFetchComplete` hook in `fetchPinsForViewport` |
| `tests/canvas-race-condition.test.js` | Added 6 tests for boot coordinator |
| `tests/test_boot_fetch_coordinator.py` | New Python regression test |
| `docs/boot-fetch-race-postmortem.md` | This document |
| `docs/AI_CHANGE_LOG.md` | Change entry |
| `README.md` | Known Performance Fixes table + Frontend Boot Architecture section |

## Prevention

1. **Don't add new callers of `fetchPinsForViewport()` during the boot window** unless they go through `_bootCoord`. The pattern is:
   ```js
   // WRONG: races with the coordinator
   fetchPinsForViewport();

   // RIGHT: defer to the coordinator if it's still settling
   if (window._bootCoord?.state === "done-ok" || window._bootCoord?.state === "expired") {
     fetchPinsForViewport();
   } else {
     _bootCoord.isBootFetch = true;  // tag the next fetch as canonical
   }
   ```
2. **Any code path that wants to "force a refresh"** during boot should call `reloadPins()` (which is gated) rather than `fetchPinsForViewport()` directly.
3. **Diagnostics:** `window.__xyzoBootCoordinator` exposes state, pinCount, and timing for debugging. If a user reports "empty map after reload", the first thing to check is `_bootCoord.state` — if it's stuck at `in-flight` or `done-empty-gave-up`, the boot fetch failed and the user needs to pan manually.

---

## Related Documents

- `docs/canvas-race-condition-postmortem.md` — Companion bug. Same symptoms (empty map) but different root cause (CSS-vs-Leaflet sizing race).
- `AGENTS.md` — Project rules, including the parallel-fetching rule (different hosts OK, same host sequential).
- `docs/MULTI_AI_COLLABORATION.md` — Why this fix is in `app.js` and not a separate module (the file is already too large; coordinating across files during the same fix window was easier).
