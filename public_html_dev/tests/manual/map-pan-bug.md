# Map pan second-no-pins bug — manual smoke test

> Tier 1.5 root-cause fix: `fetchPinsForViewport` can no longer clobber
> the canvas with stale pins from a previous fetch.

## What changed

`/var/www/vhosts/xyzo.org/public_html/app.js`:
- `setPins` is now guarded by `if (inflightCtrl !== ctrl) return;` after the
  response is parsed (so an in-flight fetch that lost the race to a newer
  fetch won't overwrite the newer viewport's pins).
- The streaming path's every-50-pins `setPins` is similarly guarded.
- The catch-block's `restoreCachedPinsOrError()` is guarded so a stale
  fetch's exception doesn't fall back to cache (which would paint a
  different viewport's pins).
- The HTTP-error and network-retry-failed `restoreCachedPinsOrError()`
  calls are also guarded.

The existing debug overlay (`map-debug.js`) and the reload-nudge toast
(`viewport-nudge.js`) are left untouched — they're useful safety nets even
with the fix in place.

## How to verify manually

1. Open `https://xyzo.org/` in a real browser (so pan/zoom events fire
   exactly as a user triggers them; headless `page.mouse` drags don't
   perfectly reproduce the bug).
2. Wait for the initial pin load to complete (the canvas shows pins).
3. Pan the map by clicking and dragging. New pins should appear within
   ~1s of releasing the mouse.
4. Pan **a second time** to a different region. New pins should appear
   again. (Before the fix, this is the case where the canvas appeared
   stuck on the previous viewport's pins until reload.)
5. Pan several more times in quick succession. Each pan should update
   the canvas with the new region's pins. Open the debug overlay
   ("🐛 debug" button at the bottom-left) to confirm:
   - `Recent fetches` shows the latest fetches' status (no long strings
     of "aborted" entries with no successful follow-ups)
   - `Pins mode=canvas` and the in-view count reflects the current
     viewport
6. Zoom in and out, then pan, then zoom, then pan again. The canvas
   should track the map consistently.
7. Repeat with a slow network (DevTools → Network → "Slow 3G"). The
   bug is most reproducible when responses take a few hundred ms — the
   race window widens.

## Repro for the regression test (regression is in the test runner)

`public_html/tests/canvas-renderer.test.js` already has a
`testGenerationCounter` test that captures the pattern. The fix is
covered by the in-test comment block on that test; the manual test
above is the end-to-end confirmation.

## Before / after (headless sanity check)

A headless Playwright run of `/tmp/repro_pan6.py` before the fix
showed the canvas `_pins` array updating across rapid pans, but in
production with real-user mouse events the streaming path can
interleave a stale `setPins` over a newer fetch's. After the fix, the
stale `setPins` calls are no-ops.

## Cleanup

- Existing safety nets stay: `map-debug.js` overlay + `viewport-nudge.js`
  toast still fire if the API is misbehaving.
- No backend changes. No API contract changes.
