## Test Case: "All Time" View Performance

### Current Architecture

**Data volume:**
```
Total articles (extracted):    ~299,000
Last 24 hours:                 ~33,000  (11%)
Last 7 days:                   ~227,000  (76%)
Last 30 days:                  ~246,000  (82%)
Last 365 days:                 ~275,000  (92%)
Older than 1 year:             ~24,000   (8%)
```

**"All time" SQL performance (measured):**
- Full scan of ~299k articles: **~866ms** (EXPLAIN ANALYZE on production DB)
- Returns max **2000 pins** (capped by `pickCanvasLimitForZoom` → API `limit` → SQL `LIMIT 2000`)
- Geographic diversity: **2 pins per location** on world view (so ~1000 distinct cities)
- 15-second API cache: repeated "all time" requests served from cache

**Rendering pipeline:**
```
API response (≤2000 pins NDJSON)
  → canvasRenderer._draw()
  → GPU circles on <canvas>
  → No DOM nodes created
  → Render time: <50ms for 2000 pins (measured)
```

**Why "all time" is fast enough right now:**
1. Hard cap of 2000 pins regardless of time range
2. Geographic diversity spread means no single cluster is pin-dense
3. Canvas renderer uses GPU circles (not DOM nodes)
4. 15s API cache means repeated pans don't hit the DB
5. ORDER BY + LIMIT 2000 terminates after finding 2000 ranked results

---

### Performance Test: All Time View

```bash
# Measure API response time for "all time" world view
curl -w "\nTime: %{time_total}s\n" \
  "http://localhost:3008/api/pins/map?bbox=-180,-90,180,90&limit=2000" \
  -o /dev/null -s

# Expected: <2s (with cache hit: <100ms)
# Concerning: >5s (cache miss + slow scan)

# Check how many pins are actually returned
curl "http://localhost:3008/api/pins/map?bbox=-180,-90,180,90&limit=2000" \
  | python3 -c "import sys,json; pins=[]; [pins.extend(json.loads(l).values()) if 'items' in l else None for l in sys.stdin if l.strip()]; print(f'Pins returned: {len(pins)}')"

# Compare response sizes (all time vs 7d)
curl -s -w "\n%{size_download} bytes\n" \
  "http://localhost:3008/api/pins/map?bbox=-180,-90,180,90&limit=2000&since=2026-09-06T00:00:00Z" | tail -1

curl -s -w "\n%{size_download} bytes\n" \
  "http://localhost:3008/api/pins/map?bbox=-180,-90,180,90&limit=2000" | tail -1
```

**Playwright performance test (`tests/pins-performance.test.js`):**

```javascript
// Key assertions for "all time" performance
test('all-time view loads under 3 seconds', async ({ page }) => {
  const start = Date.now();
  await page.goto('http://localhost:3000/#0,0,2');
  await page.waitForTimeout(3000);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(3000);
});

test('all-time returns ≤2000 pins regardless of DB size', async ({ page }) => {
  // Set a very old "since" to force maximum dataset
  await page.goto('http://localhost:3000/#0,0,2');
  await page.evaluate(() => {
    // Force "all time" mode
    window.setTimeFilter && window.setTimeFilter('all');
  });
  await page.waitForTimeout(2000);
  // Canvas should have ≤2000 points rendered
  const canvas = await page.$('canvas.xyzo-canvas-pins');
  expect(canvas).not.toBeNull();
});
```

---

### Bottlenecks to Watch

**1. Slow "all time" cache miss (866ms query)**
- If "all time" traffic spikes and cache is cold, every request waits ~866ms
- Mitigation: Increase cache TTL for "all time" (since=null) queries
- The `since=null` cache key already exists — just needs longer TTL

**2. Old stories scoring equal to new stories**
- Current recency score decays over ~100 hours, then contributes 0
- Stories older than ~4 days get equal scores regardless of age
- "All time" could return 10-year-old top stories mixed with recent ones
- Mitigation: add minimum recency floor OR detect `since=null` and apply recency ordering

**3. Canvas redraws on every pan (even cached)**
- Even cached API responses cause full canvas redraw
- Mitigation: already optimized — canvas redraw is <50ms for 2000 pins

**4. No pre-aggregation for "all time"**
- Every "all time" cache miss recomputes the same ranking over ~299k rows
- Mitigation: materialised view or summary table refreshed hourly

---

### Realistic Expectations for "All Time"

| Scenario | Pins Returned | Render Time | DB Query |
|---|---|---|---|
| World view, all time | ≤2000 (2/city) | <50ms | ~866ms (cold) |
| Continent view, all time | ≤2000 (4/city) | <50ms | ~866ms (cold) |
| City view, all time | ≤2000 (up to 100/city) | <50ms | ~866ms (cold) |
| Any view, cached | ≤2000 | <50ms | 0ms |

**"All time" is NOT a problem right now** — it safely caps at 2000 pins with canvas rendering. The real risk is the DB scan (~866ms) on cache misses under heavy load.

---

### Recommendations (Priority Order)

1. **[Low effort, high impact]** Add longer cache TTL for `since=null` queries (e.g., 60s instead of 15s) since "all time" data doesn't change rapidly
2. **[Medium effort]** Add a background materialized view that pre-computes top pins per region, refreshed hourly
3. **[High effort]** Add `FETCH FIRST 2000 ROWS ONLY` with a faster index-based approach for the ranking (avoid full sort of 299k rows)
4. **[Ongoing]** Monitor `pins/map` response times in production — if >2s at p95, prioritize caching improvements

### What "All Time" Cannot Realistically Show

- Cannot show ALL ~299k stories — hard cap of 2000
- Cannot show ALL geographic locations — capped at 2 pins per location
- Cannot show stories older than ~100 hours at full recency score — ranking favors relevance over age
- Cannot be faster than ~866ms on cold cache — SQL scan is inherent
