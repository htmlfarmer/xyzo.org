# Canvas Renderer Race Condition — Post-Mortem

## Date: 2026-09-11
## Severity: High (core feature broken on first load)
## Impact: All users clicking shared links from email/social media

---

## Symptoms

1. **First load from shared link**: Map shows tiles but no pins. "No pins in view for 24 hours" banner appears.
2. **Reload (Ctrl+Shift+R)**: Works perfectly — pins appear.
3. **Type URL in address bar**: Works on second attempt, fails on first.
4. **No console errors**: Silent failure.

## Root Cause

The canvas pin renderer (`CanvasPinRenderer`) draws pins onto an HTML `<canvas>` element overlaid on the Leaflet map. The rendering pipeline is:

```
fetchPinsForViewport() → canvasRenderer.enable() → canvasRenderer.setPins() → _scheduleRedraw() → _draw()
```

The `_draw()` method calls `this._map.getSize()` to determine canvas dimensions. On first load from a shared link:

1. **`defer` scripts execute** after DOM parsing but potentially before CSS layout is fully committed by the browser
2. **`restoreMapView()` calls `map.setView()`** which triggers an async `moveend` event
3. **`moveend` handler fires `fetchPinsForViewport()`** → `canvasRenderer.enable()` → `_scheduleRedraw()` → `_draw()`
4. **`_draw()` sees `map.getSize() = {x: 0, y: 0}`** because Leaflet's internal size cache hasn't been updated from the DOM yet
5. **Canvas is created at 0×0** — pins are drawn off-screen
6. **On reload**, everything is cached and layout is instant → works

### Why Playwright couldn't reproduce it

Playwright's headless Chromium has different timing characteristics:
- No CSS font loading delays
- No GPU compositing delays  
- Layout is committed synchronously in most cases
- The race condition requires specific browser timing that Playwright doesn't exhibit

The user's real browser (likely Chrome on desktop) has:
- Font loading that delays CSS layout
- GPU compositing pipeline
- Async layout reflow from `position: fixed; inset: 0`

## The Fix (Three-Layer Defense)

### Layer 1: `_draw()` retry loop (`app.js:3864-3882`)
```javascript
if (mapSize.x < 10 || mapSize.y < 10) {
  if (this._drawRetries < 60) {
    this._drawRetries++;
    this._rafId = requestAnimationFrame(() => this._draw());
  }
  return;
}
```
Retries up to 60 frames (~1 second) via `requestAnimationFrame`. This catches the case where `_draw()` runs before layout is committed.

### Layer 2: `ResizeObserver` + `invalidateSize()` (`app.js:3795-3816`)
```javascript
this._ro = new ResizeObserver(() => {
  this._map.invalidateSize({ animate: false });  // Force Leaflet to recalculate
  const sz = this._map.getSize();
  if (sz.x > 10 && sz.y > 10) {
    this._drawRetries = 0;
    this._scheduleRedraw();
  }
});
```
Watches the map container. When it gets sized, calls `invalidateSize()` to force Leaflet to update its internal size cache from the actual DOM dimensions. This bridges the gap between "container is sized" and "Leaflet knows about it."

**Key insight**: `ResizeObserver` fires when the container is sized, but `map.getSize()` can still return 0×0 because Leaflet caches the size internally. `invalidateSize()` forces the recalculation.

### Layer 3: `setPins` 500ms fallback (`app.js:3844-3875`)
```javascript
if (!this._hasDrawnOnce) {
  this._hasDrawnOnce = true;
  setTimeout(() => {
    if (this._enabled && this._canvas) {
      const sz = this._map.getSize();
      if (sz.x > 10 && sz.y > 10 && this._canvas.width < 10) {
        this._scheduleRedraw();
      }
    }
  }, 500);
}
```
If the canvas is still 0-sized 500ms after `setPins` was called, force a redraw. This catches edge cases where both the rAF retry loop and ResizeObserver missed the layout commit.

### Layer 4: Boot guard in `fetchPinsForViewport` (`app.js:4609-4627`)
```javascript
if (!window._xyzoMapReady) {
  const sz = map.getSize();
  if (sz.x > 0 && sz.y > 0) {
    window._xyzoMapReady = true;
  } else if (window._xyzoBootUnready < 3) {
    window._xyzoBootUnready++;
    setTimeout(fetchPinsForViewport, 200);
    return;
  }
}
```
Defers the initial API fetch up to 3 × 200ms if the map container isn't sized yet.

### bfcache handler (`app.js:8490-8510`)
```javascript
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  window._xyzoMapReady = false;
  window._xyzoBootUnready = 0;
  canvasRenderer._drawRetries = 0;
  fetchPinsForViewport();
});
```
When the browser restores the page from bfcache (typing URL again), the `pageshow` event fires with `persisted: true`. We reset all state and force a fresh fetch.

## Debugging Tools

### On-page diagnostics
```javascript
window.__xyzoFetchDiagnostics()
// Returns: { boot: { mapReady, retries, mapSize, canvasEnabled, canvasPins, lastDrawnCount }, ... }
```

### Console logging
```javascript
window.XYZO_DEBUG = true  // Enable XLog output
// Then check console for [boot] messages during retry
```

### Visible indicators
- "No pins in view for 24 hours" banner now includes "🔄 Reload page" button
- Search with 0 results shows "Clear search & show all pins" button

## Test Coverage

`tests/canvas-race-condition.test.js` — 4 test cases:
1. Pins render on first load from shared link
2. Pins render after bfcache restore
3. ResizeObserver triggers redraw on viewport resize
4. Diagnostics include boot state

## Files Changed

| File | Change |
|------|--------|
| `public_html/app.js` | Canvas renderer fixes, boot guard, bfcache handler, reaction system, search UX |
| `public_html/city-engine.js` | Cape Cod aliases |
| `public_html/index.html` | Version bump, app.js cache-bust |
| `api/src/routes/analytics.ts` | Reaction endpoint |
| `api/migrations/2026-09-11-analytics-reactions.sql` | Reactions table |
| `tests/canvas-race-condition.test.js` | Regression tests |

## Prevention

1. **Never call `_draw()` synchronously after `enable()`** — always defer to rAF
2. **Always check `map.getSize()` before relying on dimensions** — Leaflet's internal cache can be stale
3. **Use `invalidateSize()` after any container size change** — don't trust Leaflet's cached size
4. **Test on real devices** — Playwright's headless Chromium doesn't exhibit the race condition
5. **Test with `position: fixed; inset: 0` containers** — CSS layout timing varies by browser
