## Test Case: Time Dropdown Bug (z-index + missing 3d count)

### Bug 1: Menu Invisible (Fixed)

**Symptom:** Time dropdown button click toggles `hidden` attribute but menu never appears visually. `getBoundingClientRect()` returns `width: 0, height: 0`.

**Root Cause (2 layers):**

1. **Stacking context isolation:** `#bottom-bar` has `z-index: 500` which creates a new stacking context. The `.time-dropdown-menu` was INSIDE `#bottom-bar` with `z-index: 10000` — but z-indices only win against siblings WITHIN the same stacking context. The `.leaflet-container` at root level had `z-index: 800` which visually covered everything, including the dropdown menu region, regardless of the menu's high z-index.

2. **CSS `[hidden]` override:** The menu HTML had the `hidden` attribute (`<div id="time-dropdown-menu" hidden>`). The CSS rule `.time-dropdown-menu[hidden] { display: none; }` was more specific than the inline `style.display: block` set by JS. The browser rendered `display: none` visually even though JS had set `style.display = "block"`.

**Why `width: 160` but invisible:** The `getBoundingClientRect()` reported dimensions correctly because the element was in the layout tree — but Leaflet's map pane (`z-index: 800`) was painted on top of it in the root stacking context, covering it completely.

**Fix:**
- Moved `#time-dropdown-menu` outside `#bottom-bar` to the document root, so its `z-index: 10000` competes in the root stacking context (above Leaflet's `z-index: 800`).
- Changed menu open/close from `menu.hidden = !menu.hidden` to explicit `menu.style.display = "block"/"none"` with `menu.removeAttribute("hidden")` / `menu.setAttribute("hidden", "")` to avoid the `[hidden]` CSS rule overriding inline styles.

**Test steps:**
1. Open map at xyzo.org
2. Open DevTools console, set `window.XYZO_DEBUG = true`
3. Click time dropdown button
4. Menu should appear visually ABOVE the Leaflet map
5. `document.getElementById('time-dropdown-menu').style.display` should be `'block'`
6. `document.getElementById('time-dropdown-menu').getBoundingClientRect().width` should be `> 0`

---

### Bug 2: "3 days" count always shows 0

**Symptom:** Time dropdown shows "3 days (0)" while all other options show real counts.

**Root Cause:** The `/api/pins/stats` endpoint SQL query did NOT include a `count_3d` column. The frontend uses `counts["3d"] ?? 0` which falls through to 0.

```sql
-- Missing from the query:
COUNT(*) FILTER (WHERE time_anchor >= now() - interval '3 days') AS count_3d,
```

And the returned JSON was missing `"3d"`:
```typescript
// Wrong:
counts: { "24h": ..., "7d": ..., "30d": ..., "all": ... }
// Correct:
counts: { "24h": ..., "3d": ..., "7d": ..., "30d": ..., "all": ... }
```

**Fix:** Added `count_3d` to the SQL query and `"3d"` to the returned counts object.

**Test steps:**
1. `curl http://localhost:3008/api/pins/stats | python3 -m json.tool`
2. Verify response has `"3d"` key with a non-zero count (or verify the SQL has `count_3d`)
3. Open map, open time dropdown
4. Verify "3 days" shows a real number (not 0)

---

### Prevention Checklist

- [ ] Dropdown menus that need to appear ABOVE map content must be siblings to the map in the DOM (not children of fixed-position bars)
- [ ] Test z-index: always verify with Leaflet map visible and zoomed in
- [ ] Avoid `hidden` attribute for JS-controlled visibility — use `style.display` only
- [ ] All dropdown/filter options must have corresponding backend counts — if frontend has "3d", backend must return "3d"
- [ ] Add per-option count validation to UI tests: each `data-time` button's displayed count should match API response
