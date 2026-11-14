# Xyzo — Highlight the Active Headline in the New-Events Panel

**Date:** 2026-08-26
**Status:** Approved (post-brainstorm)
**Author:** Brainstorming session

## Goal

When a user clicks a `.new-item` in the live "New" tab, the map already flies to the event's location (app.js:6059-6068). Add a clear, persistent visual highlight on that row so the user can identify which headline the map is currently centered on. The highlight must persist across the 60-second list refresh, and clear when the user clicks a different headline or clicks empty map.

This is a **front-end-only change** — one CSS class + one small state holder in `app.js`. No API, schema, or worker changes.

## Decisions captured in brainstorming

| Question | Answer |
|---|---|
| Selection lifetime | Stay until click elsewhere (different headline → moves; empty map → clears) |
| Scope | Only the `.new-item` panel (newest-events tab). `.live-item` panel is out of scope. |
| Visual style | Bright accent left-border + tinted teal background + subtle glow halo (builds on the existing `.new-item:hover` accent pattern) |
| Refresh behavior | Persist across the 60s re-render (`fetchLiveFeed(true)` rebuilds the DOM nodes from `innerHTML = html`) |

## Architecture

### Files to modify

- `public_html/styles.css` — add one new rule `.new-item.new-item-active` (and any helpers)
- `public_html/app.js` — add a module-level `_activeHeadlineEventId` state holder; wire three callsites:
  1. Inside the `.new-item` click handler — set state, apply class to clicked node
  2. After the `innerHTML = html` re-render in `renderLivePanel` — walk the new nodes, re-apply class to the one matching the state (idempotent)
  3. When the map background is clicked (existing empty-map handler around app.js:1264) — clear state and class

### Files NOT touched

- `public_html/index.html` — no markup changes
- Any API, worker, or schema file — this is pure UI

### State holder

```js
// app.js — placed near the other UI state holders (around line ~1075 where
// _highlightedEventId lives, but distinct — this is for the news-list panel,
// not for the connection-arc highlight)
let _activeHeadlineEventId = null;
```

Two callers, two rules:
- **Click on `.new-item`**: set `_activeHeadlineEventId = id`, remove `.new-item-active` from all `.new-item` nodes, add it to the clicked one.
- **Click on empty map (not on a marker / arc)**: existing empty-map click handler at app.js:1264-1268 sets `_highlightedEventId = null`. Extend that handler to also clear `_activeHeadlineEventId = null` and remove all `.new-item-active` classes. (Empty-map click is THE natural "I am not viewing anything specific" gesture.)
- **Click on a marker (existing flow)**: marker click opens a popup; it does NOT open or change the news panel. No change needed — but if the user clicks a marker that corresponds to the active headline, we want to keep the highlight. So do nothing on marker click.

### Re-render preservation

In `renderLivePanel()` (app.js:6018-6068), immediately after `livePanelList.innerHTML = html` (line 6056), before the click-listener wiring loop:

```js
// Re-apply the active highlight if the same event_id is still in
// the refreshed list. The list re-renders from scratch on every 60s
// fetchLiveFeed(true), so we can't rely on DOM persistence.
if (_activeHeadlineEventId != null) {
  const active = livePanelList.querySelector(
    `.new-item[data-id="${_activeHeadlineEventId}"]`
  );
  if (active) active.classList.add("new-item-active");
}
```

This MUST run before the click-listener wiring — otherwise we lose the highlight on the first click after a refresh.

### Click handler changes

Existing click handler (app.js:6059-6068):

```js
livePanelList.querySelectorAll(".new-item").forEach((node) => {
  node.addEventListener("click", () => {
    const lat = Number(node.dataset.lat);
    const lng = Number(node.dataset.lng);
    const id = Number(node.dataset.id);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 6), { duration: 0.8 });
    }
  });
});
```

New version:

```js
livePanelList.querySelectorAll(".new-item").forEach((node) => {
  node.addEventListener("click", () => {
    const id = Number(node.dataset.id);
    const lat = Number(node.dataset.lat);
    const lng = Number(node.dataset.lng);

    // Clear any prior active highlight before applying the new one.
    // (Clicking a DIFFERENT headline moves the highlight; clicking the
    // SAME headline is a no-op for state but still re-applies the class.)
    livePanelList
      .querySelectorAll(".new-item.new-item-active")
      .forEach((n) => n.classList.remove("new-item-active"));

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 6), { duration: 0.8 });
      node.classList.add("new-item-active");
      _activeHeadlineEventId = id;
    }
  });
});
```

### Empty-map click clears highlight

There's already a map-click handler that detects "user clicked the map background, not a marker or arc" — it's at app.js:1264-1271:

```js
// Clear highlight when clicking on the map (not on a marker or arc).
map.on("click", () => {
  if (_highlightedEventId != null) {
    _highlightedEventId = null;
    clearMarkerHighlights();
    renderLinks();
  }
});
```

We piggyback on this exact handler. Extend it to also clear the news-panel highlight:

```js
map.on("click", () => {
  if (_highlightedEventId != null) {
    _highlightedEventId = null;
    clearMarkerHighlights();
    renderLinks();
  }
  // NEW: also clear the active news-list highlight when user clicks
  // the map background (not a marker or arc).
  if (_activeHeadlineEventId != null) {
    _activeHeadlineEventId = null;
    document
      .querySelectorAll(".new-item.new-item-active")
      .forEach((n) => n.classList.remove("new-item-active"));
  }
});
```

This is the natural "I am not viewing anything specific" gesture: clicking on empty map area clears BOTH highlights. Clicking a marker does NOT clear them (marker click opens a popup without touching the news list).

## CSS

```css
/* New tab — active (selected) headline. Distinct from hover, persists
   across the 60s re-render, cleared when user clicks elsewhere. */
.new-item.new-item-active {
  background: rgba(94, 234, 212, 0.14);
  border-left-color: var(--accent);
  box-shadow: inset 4px 0 12px -4px rgba(94, 234, 212, 0.55),
              0 0 0 1px rgba(94, 234, 212, 0.18);
}
```

The base `.new-item` rule (styles.css:1784) already has:
- `border-left: 3px solid transparent` (the slot — we fill it)
- `transition: background 0.12s, border-color 0.12s` (animates the change nicely)

So the active state only needs to set the *values* — the transition is inherited for free.

Hover behavior is intentionally unchanged — `.new-item:hover` already does background `rgba(94, 234, 212, 0.06)` which is about 2.3× weaker than the active state (0.14). With both states possible simultaneously, the SPECIFICITY rule is: `.new-item.new-item-active` wins (two classes) over `.new-item:hover` (one class + pseudo). User mousing over the active row sees the active style, not a faded hover.

## Implementation outline

This is small enough to be a single change. Two files, one ~5-line CSS rule, one ~10-line JS change. TDD is overkill for a one-class styling toggle with no logic branches; we'll smoke-test in the browser instead.

1. Add CSS rule (`.new-item.new-item-active`).
2. Add module-level `_activeHeadlineEventId` state holder near other UI state.
3. Wire click handler — clear prior class, set new one, update state.
4. Wire post-render — re-apply class to matching node after `innerHTML` swap.
5. Wire empty-map click — clear state + classes.

## Testing

**Manual smoke test:**

```js
// In browser devtools, after page loads:

// 1. Open DevTools Console, run:
document.querySelectorAll(".new-item").length
// Expect: > 0 (any number — list is rendered)

// 2. Click any headline. Observe:
//    - Map flies to that location
//    - That .new-item gains a brighter background and accent border-left
//    - _activeHeadlineEventId is now that event's data-id (check via:
//      document.querySelector(".new-item.new-item-active")?.dataset.id)

// 3. Click a DIFFERENT headline. Observe:
//    - Old highlight disappears, new one appears
//    - Map flies to new location

// 4. Wait 60+ seconds for the live refresh, or trigger one manually:
//    fetchLiveFeed(true)
//    Observe: same .new-item is still highlighted (same data-id)

// 5. Click empty map area (not on a marker). Observe:
//    - Highlight disappears (all .new-item-active removed)
//    - _activeHeadlineEventId set to null (state cleared)

// 6. Click the SAME headline twice (after clearing in step 5).
//    Observe: highlight re-appears; same data-id.
```

**No automated tests added** — this is a CSS class toggle on a DOM-managed state. The browser is the test.

## Out of scope

- `.live-item` panel (older full-feed panel) — separate surface, can be added if requested
- Persistence across page reload — user's framing was "click → highlight", not "I can come back tomorrow"
- Animations beyond the existing 0.12s transition (no entry/exit animations)
- Keyboard navigation (`Enter` to activate a headline, `Esc` to clear) — defer
- Showing more info about the active headline (e.g., a side panel of sources) — out of scope
- Highlighting the corresponding marker on the map when a `.new-item` is active — already happens via the existing `flyTo` (the marker is visible because the map zooms to it)

## Risks

- **Highlight changes during the click-listener race.** When user clicks, the click handler removes prior class, then adds new class to same node. If we wrote them as separate operations, there could be a one-frame flicker on double-click. We avoid this by removing-then-adding in the same event tick — JS is single-threaded, no actual frame between.
- **Re-render swap drops class even with state preserved.** The fix depends on the post-render re-apply running before the user sees the new DOM. Since `innerHTML = html` is synchronous and `requestAnimationFrame` runs after, we apply within the same tick — invisible.
- **Empty-map click handler layering.** The Leaflet `map.on("click", ...)` fires for ALL map-area clicks including markers and arcs — those have their own `stopPropagation` via Leaflet's event bubbling. We piggyback on the existing handler (`app.js:1265-1271`) which already discriminates via marker/arc click handlers. Adding the news-list clear inside the same `map.on("click")` block means it runs ONLY when neither markers nor arcs handled the click — exactly the desired behavior.
- **`_activeHeadlineEventId` pollled state vs click co-ordination.** No polling — the state is set/cleared in the click handlers. Trivially correct.
