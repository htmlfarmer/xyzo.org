# AI Change Log

**Purpose:** Historical record of all AI-made changes to the XYZO codebase.
**Audience:** Other AIs working on the same project.
**Rule:** If you changed it, document it here.

---

## Template

```markdown
## [YYYY-MM-DDTHH:MM:SSZ] [Agent Name] [Brief Description]

### What Changed
- file1.ts: Description of change
- file2.py: Description of change

### Why It Changed
- Reason for the change

### What To Watch Out For
- Gotchas, dependencies, or risks

### Files Modified
- path/to/file (lines X-Y)
```

---

## Log Entries

---

### 2026-09-09T22:00:00Z — Multiple Agents — UI/UX Cleanup + Your News Fix

**What Changed:**
- `public_html/index.html`: Reorganized bottom bar into 4 groups (Time, View, Tools, Actions)
- `public_html/styles.css`: Added CSS for #tools-toggle and #actions-toggle groups
- `public_html/app.js`: Your News tab now refreshes on switch, smarter scoring
- `public_html/app.js`: Added branded splash screen with dismissal logic
- `public_html/app.js`: Added command bar hint below search
- `public_html/styles.css`: Added mobile scroll indicator for bottom bar

**Why It Changed:**
- Bottom bar had 14 buttons in one row — overwhelming
- Your News tab showed same cached results every time
- No first-paint experience — black screen until map loaded
- Users couldn't discover command bar features

**What To Watch Out For:**
- New CSS classes (#tools-toggle, #actions-toggle) need testing on mobile
- Your News scoring weights may need tuning based on user feedback
- Splash screen timeout (3s) may need adjustment for slow connections

**Files Modified:**
- `public_html/index.html` (bottom bar restructure, splash screen, command hint)
- `public_html/styles.css` (new group styles, scroll indicator)
- `public_html/app.js` (splash dismissal, Your News refresh, scoring improvements)

---

### 2026-09-09T21:30:00Z — Multiple Agents — Emergency Fixes + Vision Document

**What Changed:**
- `api/src/routes/shutdown.ts` (new file): Global shutdown system with complaint tracking
- `api/src/routes/agent.ts` (new file): Agent-to-agent API for AI collaboration
- `api/src/routes/shutdown.ts`: Shutdown middleware in server.ts
- `public_html/app.js`: Stale data banner redesign, complaint handler, shutdown banner
- `public_html/help/index.html`: Emergency shutdown section, multilingual section
- `api/migrations/2026-09-23-global-shutdown.sql`: Shutdown state tables
- `scripts/check-api-paths.sh`: Fixed multi-import regex for validation
- `api/src/routes/locations.ts`: Added `id` field to location search response
- `docs/XYZO_AI_MASTER_PLAN.md`: Complete AI master plan
- `docs/MULTI_AI_COLLABORATION.md`: Multi-AI collaboration protocol
- `README.md`: Updated with permanent product thesis

**Why It Changed:**
- User requested global shutdown feature
- User requested agent-to-agent API
- Stale data banner was ugly and unhelpful
- Search wasn't showing markers (missing location IDs)
- Validation script crashed on multi-import lines
- Needed comprehensive vision document

**What To Watch Out For:**
- Shutdown system requires DB migration before deployment
- Agent API is public, no auth for reads (rate-limited)
- Location search now returns `id` field — callers may depend on it
- `check-api-paths.sh` regex was fragile — test with new imports

**Files Modified:**
- `api/src/routes/shutdown.ts` (new, 180 lines)
- `api/src/routes/agent.ts` (new, 280 lines)
- `api/src/server.ts` (imports, middleware, route registration)
- `public_html/app.js` (stale banner, complaint handler, shutdown banner)
- `public_html/help/index.html` (shutdown section, multilingual section)
- `api/migrations/2026-09-23-global-shutdown.sql` (new)
- `scripts/check-api-paths.sh` (regex fix)
- `api/src/routes/locations.ts` (added `id` to query)
- `docs/XYZO_AI_MASTER_PLAN.md` (new)
- `docs/MULTI_AI_COLLABORATION.md` (new)
- `README.md` (product thesis update)

---

### 2026-09-11T16:30:00Z — AI Assistant — Time Dropdown Wiring Fix (DOMContentLoaded race)

**What Changed:**
- `public_html/app.js` (line ~452): Wrapped the `#flag-btn` click handler in a readyState check + IIFE so it attaches whether DOMContentLoaded has fired or not.
- `public_html/app.js` (line ~11796): Same fix for the `#time-dropdown-btn` / `#time-dropdown-menu` wiring — wrapped in `(function wireTimeDropdown() {...})()` IIFE with readyState check.
- `public_html/app.js` (line ~11815): Added a "DO NOT REMOVE" comment explaining the pattern and why it's critical.
- `public_html/index.html`: Bumped `app.js?v=202609110950` → `app.js?v=202609110941` to bust the browser cache for users who have the broken version cached.
- `tests/test_time_dropdown_wiring.py` (new): 5 Python regression tests including a defensive code-level guard that scans app.js for the anti-pattern (unconditional `addEventListener("DOMContentLoaded", ...)`).
- `tests/canvas-race-condition.test.js`: Added one more Playwright test for the time-dropdown wiring in the "Boot-Fetch Race Coordinator" describe block.

**Why It Changed:**
- User reported: "our 'time' button isn't working — we can't select a time range, we don't see number of articles for each time range on the popup, in fact it doesn't even allow us to see the popup yet."
- Root cause: `app.js` is loaded with `defer`, but the wiring code used `document.addEventListener("DOMContentLoaded", fn)` unconditionally.  When DOMContentLoaded fires BEFORE the defer script runs (which happens in some browsers, especially under load or with certain extensions), the listener queues forever and `fn` never runs — so no event listeners are attached to the time dropdown.
- The Flag button had the same pattern but no `#flag-btn` element exists in HTML, so it was dead code (still got the fix for consistency).
- The popup part of the user's report was likely downstream: the time dropdown not opening meant the user assumed the popup wasn't working either, but pin-click popups work fine.

**What To Watch Out For:**
- **Never use `document.addEventListener("DOMContentLoaded", fn)` unconditionally** in defer-loaded scripts.  Always check `document.readyState === "loading"` first; if false, call `fn` immediately.  The pattern is:
  ```js
  (function wireSomething() {
    function attach() {
      // wiring code that may use addEventListener
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
    } else {
      attach();
    }
  })();
  ```
- The defensive test `test_no_unconditional_domcontentloaded_listener` in `tests/test_time_dropdown_wiring.py` scans app.js source for this anti-pattern.  If you add new wirings, follow the pattern above or this test will fail.
- The `dataset.wired = "1"` marker on wired buttons makes it possible to test whether the wiring actually attached without relying on side effects.

**Files Modified:**
- `public_html/app.js` (readyState-guarded wiring for flag-btn and time-dropdown-btn)
- `public_html/index.html` (cache-bust version bump)
- `tests/test_time_dropdown_wiring.py` (new)
- `tests/canvas-race-condition.test.js` (+1 test)

---

### 2026-09-11T15:50:00Z — AI Assistant — Boot-Fetch Race Coordinator + Canvas Position Fix

**What Changed:**
- `public_html/app.js`:
  - New IIFE `fixMapPositionIfLeafletClobbered()` at ~line 1329 — detects when Leaflet's inline `position: relative` overrides the stylesheet's `position: fixed; inset: 0`, and clears the inline override once `styles.css` has loaded.
  - `rAF(() => map.invalidateSize())` right after `L.map()` — forces Leaflet to re-measure the container after the first paint frame.
  - New "boot-fetch coordinator" state machine at ~line 8580 (`window._bootCoord`):
    - Waits 250ms of `moveend`/`zoomend` silence before firing one canonical fetch
    - Auto-retries once after 500ms if the canonical fetch returned 0 pins, within a 5s boot grace window
    - Becomes inert after `done-ok` or `expired`
  - `reloadPins` gated to absorb moveends during the boot window instead of firing parallel fetches
  - Removed the redundant `map.whenReady(() => setTimeout(fetchPinsForViewport, 1000))` safety net — it made the race worse, not better.
  - New `window._bootFetchComplete(count, ctrl)` hook at the end of `fetchPinsForViewport`'s success path (~line 5268)
- `tests/canvas-race-condition.test.js`: Added 6 tests for the boot coordinator (state transitions, retry path, user-pan cancellation, inert-after-done).
- `tests/test_boot_fetch_coordinator.py`: New Python regression test using Playwright headless mode.
- `docs/boot-fetch-race-postmortem.md`: New postmortem with state-machine diagram, code excerpts, and prevention rules.
- `docs/canvas-race-condition-postmortem.md`: Referenced the companion postmortem.
- `README.md`: Added "Frontend Boot Architecture" section + extended "Known Performance Fixes" table.

**Why It Changed:**
- After the canvas race condition was fixed (2026-09-11 morning), users still reported "no pins" on reload / address-bar typing. The remaining cause was a different bug: `fetchPinsForViewport()` is called from many places during boot (URL hash restore, `whenReady` safety net, time-filter restore, mode-toggle), each one aborts the previous, and whichever lands on a transitional Leaflet bbox wins — frequently returning 0 pins with no retry.
- The existing `pageshow` handler only fired on bfcache restore (`event.persisted === true`), not on fresh navigation. The comment claimed it covered "typing URL again" but it didn't.

**What To Watch Out For:**
- The boot coordinator lives in `app.js` (not a separate module) because `app.js` is already 15K lines and splitting it mid-fix would have created a coordination nightmare with the other AI agents working on the file. **If you're adding a new caller of `fetchPinsForViewport()`, check whether it runs during the boot window.** If it does, defer to `_bootCoord` instead of firing directly:
  ```js
  if (window._bootCoord?.state === "done-ok" || window._bootCoord?.state === "expired") {
    fetchPinsForViewport();
  } else {
    window._bootCoord.isBootFetch = true;  // tag the next fetch as canonical
  }
  ```
- The coordinator's `_bootFetchComplete` hook fires ONLY when `isBootFetch === true`. Normal pan/zoom calls set `isBootFetch = false` (via `reloadPins`'s gate) and don't go through the coordinator's state machine.
- The 5-second boot grace window is intentionally bounded. After it expires, the coordinator stops trying. If you need to retry longer (e.g. for very slow connections), change `BOOT_GRACE_MS` at the top of the coordinator block.
- `reloadPins` is now gated. If you want to bypass the gate (e.g. for a "force refresh" button), set `_bootCoord.isBootFetch = false` BEFORE calling `reloadPins()`, or call `fetchPinsForViewport()` directly.

**Files Modified:**
- `public_html/app.js` (new IIFE ~line 1329, new coordinator ~line 8580, gated reloadPins, hook at ~line 5268)
- `tests/canvas-race-condition.test.js` (+6 tests)
- `tests/test_boot_fetch_coordinator.py` (new)
- `docs/boot-fetch-race-postmortem.md` (new)
- `README.md` (Frontend Boot Architecture section)

---

*End of log. New entries go at the top.*
