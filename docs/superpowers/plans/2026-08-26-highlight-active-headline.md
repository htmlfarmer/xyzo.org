# Highlight Active Headline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent visual highlight on the `.new-item` row corresponding to the story currently being viewed on the map. Clicking a headline moves the highlight; clicking empty map clears it; refreshes preserve it.

**Architecture:** Two-file change. One CSS rule + small module-level JS state holder + three local wirings (click handler, post-render preservation, empty-map clear). No API/worker/schema changes. Browser smoke tests substitute for automated tests.

**Tech Stack:** Vanilla JS + CSS, Leaflet map (existing), no new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-08-26-highlight-active-headline.md`

---

### Task 1: Add the active-state CSS rule

**Files:**
- Modify: `public_html/styles.css:1783-1795` (the `.new-item` rule block — add `.new-item.new-item-active` directly after)

- [ ] **Step 1: Add the rule**

Open `public_html/styles.css` and locate the existing `.new-item` block (around line 1784). The base rule already has `border-left: 3px solid transparent` and a `transition: background 0.12s, border-color 0.12s`, so the active state only needs to set values.

Add this rule directly after the existing `.new-item:last-child { border-bottom: none; }` line (~line 1795):

```css
/* New tab — active (selected) headline. Distinct from :hover, persists
   across the 60s re-render, cleared when user clicks empty map.
   Two-class specificity beats :hover (one class + pseudo). */
.new-item.new-item-active {
  background: rgba(94, 234, 212, 0.14);
  border-left-color: var(--accent);
  box-shadow: inset 4px 0 12px -4px rgba(94, 234, 212, 0.55),
              0 0 0 1px rgba(94, 234, 212, 0.18);
}
```

- [ ] **Step 2: Verify in browser**

Open https://xyzo.org/ (or your local dev URL). In DevTools console, run:

```js
const items = document.querySelectorAll(".new-item");
items[0].classList.add("new-item-active");
```

Expected: the first `.new-item` shows a brighter teal background, an accent-colored left border, and a faint glow halo. Other items remain in their default state.

When done, `items[0].classList.remove("new-item-active")` to restore.

- [ ] **Step 3: Commit**

```bash
git add public_html/styles.css
git commit -m "feat(highlight): .new-item.new-item-active CSS — accent border + tinted bg + glow"
```

---

### Task 2: Add state holder and clear helper

**Files:**
- Modify: `public_html/app.js` — add a module-level state holder adjacent to `_highlightedEventId` (around line 1078), and a small helper function near where the click handler is wired (around line 6059).

- [ ] **Step 1: Add the state holder**

In `public_html/app.js`, find the block around line 1075-1078:

```js
// ── Connection highlight ─────────────────────────────────────────────
// are highlighted in bright red. null = no highlight.
let _highlightedEventId = null;
```

Add the new state holder directly after that comment block, before `let _highlightedEventId = null;`:

```js
// ── News-list highlight ──────────────────────────────────────────────
// ID of the .new-item currently marked as "this is the story the map
// is centered on." Persists across the 60s renderLivePanel re-render.
// null = no headline is the active view. Distinct from
// _highlightedEventId (which controls connection-arc highlighting).
let _activeHeadlineEventId = null;
```

- [ ] **Step 2: Add the clear helper function**

In `public_html/app.js`, find the existing click-listener wiring block (around line 6059 — start of the `livePanelList.querySelectorAll(".new-item").forEach((node) => {` block). Add the helper function directly above that block:

```js
// Clear the active news-list highlight: state + DOM class.
function clearActiveHeadlineHighlight() {
  if (_activeHeadlineEventId == null) return;
  _activeHeadlineEventId = null;
  document
    .querySelectorAll(".new-item.new-item-active")
    .forEach((n) => n.classList.remove("new-item-active"));
}
```

- [ ] **Step 3: Smoke test in console**

Open the page, in DevTools console:

```js
// Set state via the helper:
clearActiveHeadlineHighlight();
// Should be a no-op since state is already null.
clearActiveHeadlineHighlight(); // idempotent

// Manually verify state holder exists:
_activeHeadlineEventId
// Expected: null
```

- [ ] **Step 4: Commit**

```bash
git add public_html/app.js
git commit -m "feat(highlight): add _activeHeadlineEventId state + clearActiveHeadlineHighlight helper"
```

---

### Task 3: Wire the click handler in `renderLivePanel`

**Files:**
- Modify: `public_html/app.js` — replace the existing `.new-item` click-listener block (lines 6059-6068) with one that toggles the highlight; AND insert a post-render re-apply right after `livePanelList.innerHTML = html` (line 6056).

This task combines the click-handler wiring and the post-render preservation because both touch the same `renderLivePanel` function and they're tested together in the browser.

- [ ] **Step 1: Insert the post-render preservation**

Find this line in `renderLivePanel`:

```js
  livePanelList.innerHTML = html;
```

Insert these lines directly after it (before the click-listener wiring):

```js
  // Re-apply the active highlight if the same event_id is still in
  // the refreshed list. The list re-renders from scratch every 60s
  // via fetchLiveFeed(true), so DOM persistence is impossible.
  if (_activeHeadlineEventId != null) {
    const active = livePanelList.querySelector(
      `.new-item[data-id="${_activeHeadlineEventId}"]`
    );
    if (active) active.classList.add("new-item-active");
  }
```

- [ ] **Step 2: Replace the click handler**

Find the existing click handler:

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

Replace with:

```js
  livePanelList.querySelectorAll(".new-item").forEach((node) => {
    node.addEventListener("click", () => {
      const id = Number(node.dataset.id);
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);

      // Clear any prior highlight before applying the new one. (Same
      // tick, so the user never sees a no-highlight frame.)
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

- [ ] **Step 3: Smoke test in browser**

Open the page. In DevTools console:

```js
// Count active highlights (should be 0):
document.querySelectorAll(".new-item.new-item-active").length
// → 0
```

Now click any `.new-item` headline in the panel. Expect:
- The map flies to that location.
- The clicked row gains brighter teal background and accent left-border (compared to neighbors).
- `_activeHeadlineEventId === Number(<clicked>.dataset.id)`.

Click a different headline. Expect:
- Old row un-highlights.
- New row highlights.
- `_activeHeadlineEventId` updates to the new id.

Trigger a manual refresh by running in console:

```js
fetchLiveFeed(true)
```

(then wait a moment for the refresh — or just observe the next time the 60s timer fires). Expect: the same row is still highlighted, with the same data-id.

- [ ] **Step 4: Commit**

```bash
git add public_html/app.js
git commit -m "feat(highlight): click toggles + post-render re-applies persistent highlight"
```

---

### Task 4: Wire empty-map click to clear highlight

**Files:**
- Modify: `public_html/app.js:1264-1271` — extend the existing `map.on("click", ...)` block to also clear the news-list highlight.

- [ ] **Step 1: Extend the map click handler**

Find:

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

Replace with:

```js
// Clear highlight when clicking on the map (not on a marker or arc).
map.on("click", () => {
  if (_highlightedEventId != null) {
    _highlightedEventId = null;
    clearMarkerHighlights();
    renderLinks();
  }
  // Also clear the news-list highlight when user clicks empty map
  // (marker/arc clicks are handled by their own handlers and don't
  // reach this branch in the destructive sense).
  clearActiveHeadlineHighlight();
});
```

Note: `clearActiveHeadlineHighlight` is a no-op when state is already null (per its guard in Task 2), so this is safe to call unconditionally.

- [ ] **Step 2: Smoke test in browser**

Open the page. Click any `.new-item` headline — confirm it highlights. Then click on empty map area (well away from any markers or arcs). Expect:
- The `.new-item-active` row un-highlights.
- `_activeHeadlineEventId === null`.

Click a marker. Expect: marker popup opens, news-list highlight (if any was set) is preserved (marker clicks don't reach the empty-map branch).

- [ ] **Step 3: Commit**

```bash
git add public_html/app.js
git commit -m "feat(highlight): empty-map click also clears active news-list row"
```

---

### Task 5: Browser regression smoke

**Files:** none — this is the final verification across all four code changes together.

- [ ] **Step 1: Verify the full flow**

Run through this exact sequence in the browser:

1. Load the page. Expect: no `.new-item-active` rows. `_activeHeadlineEventId === null`.
2. Click headline A. Expect: A highlights, map flies to A.
3. Click headline B. Expect: A un-highlights, B highlights, map flies to B.
4. Trigger `fetchLiveFeed(true)` from console. Expect: B still highlighted.
5. Click empty map. Expect: B un-highlights. `_activeHeadlineEventId === null`.
6. Click headline C. Expect: C highlights.
7. Wait 60s for the natural refresh (or trigger manually). Expect: C still highlighted.
8. Click marker on the map (not a `.new-item`). Expect: marker popup opens, C still highlighted.
9. Click empty map area. Expect: C un-highlights.

- [ ] **Step 2: Cross-browser check (optional but recommended)**

If a second browser is convenient (Firefox / Safari), load the page there and repeat steps 1-9. The feature is plain DOM API + Leaflet — should be portable, but worth confirming.

- [ ] **Step 3: Final commit if any tweak was made**

If step 1 or 2 surfaced any bug, fix it and amend the appropriate commit (or add a fixup commit). Otherwise no commit — all four feature commits already exist.

```bash
# Only if a fix was needed:
git add <touched-file>
git commit --fixup=<commit-sha-of-the-relevant-feature-commit>
# Or just:
git commit -m "fix(highlight): <description>"
```

---

## Self-review notes

- **Spec coverage:** all 4 decisions (lifetime, scope, visual, refresh) are wired. ✓
- **Placeholder scan:** no "TODO", "TBD", "let me figure out" left in this plan. ✓
- **Type consistency:** state holder `_activeHeadlineEventId` (camelCase) is referenced consistently throughout. Helper `clearActiveHeadlineHighlight` is referenced consistently. CSS class `.new-item-active` is referenced consistently across all JS snippets and the CSS rule. ✓
- **No regressions:** the existing `map.flyTo` call is preserved verbatim with the same arguments; the only added behavior is around it. ✓
- **No TDD:** Per spec decision (small UI toggle, no branching logic worth unit-testing), verification is browser smoke test. Each task has a concrete browser check. ✓
