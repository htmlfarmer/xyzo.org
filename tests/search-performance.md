## Search Performance Analysis

### Current Performance

| Endpoint | Query | Cold Cache | Warm Cache |
|---|---|---|---|
| `/api/pins?q=ukraine` | text search | ~4.8s | ~0.002s |
| `/api/pins?q=election` | text search | ~1.3s | ~0.003s |
| `/api/events/search` | event search | ~22ms | ~0.001s |

**Source:** Measured on production DB (~299k articles, ~105k events).

### Why `/api/pins?q=` is Slow (1-5s cold)

The query is structurally expensive:

```sql
SELECT ... FROM (
  -- pins leg: fast, ~10k rows in pins table
  SELECT p.id, p.title, ... FROM pins p WHERE p.title ILIKE '%query%'
  UNION ALL
  -- articles leg: expensive
  SELECT a.id, a.title, ...
  FROM news_articles a
  JOIN news_locations l ON l.id = a.location_id   -- + JOIN
  LEFT JOIN news_event_sources nes ON nes.article_id = a.id  -- + JOIN
  WHERE a.status = 'extracted' AND a.location_id IS NOT NULL
    AND (a.title ILIKE '%query%' OR a.summary ILIKE '%query%')
) combined
ORDER BY
  ts_rank_cd(to_tsvector('english', title), plainto_tsquery(...)) * 10000  -- FULL TEXT SCORING ON ALL ROWS
  + nn_feedback_subquery  -- PER-ROW SUBQUERY
  + source_count_boost
  + recency_score
LIMIT 21
```

**Bottlenecks:**

1. **`ts_rank_cd` on all rows before LIMIT** — PostgreSQL must compute FTS relevance scores for every matching row before applying LIMIT. For 100+ matches, this is measurable. The `tsvector` includes `title + summary + body` (via a concatenated FTS column) — computing relevance over large text is expensive.

2. **`nn_feedback` subquery per row** — the feedback subquery in ORDER BY executes once per row in the result set (up to hundreds of executions). Even with an index on `(feedback_target_type, feedback_target_id)`, this adds latency.

3. **5-minute cache too short** — every new search query is a cold cache miss. Users who try different search terms each hit the slow path.

4. **Window function partition** — `ROW_NUMBER() OVER (PARTITION BY COALESCE(nes.event_id, a.location_id) ORDER BY a.fetched_at DESC)` runs on all matching articles before the `event_rank = 1` filter.

### Why `/api/events/search` is Fast (~22ms)

The events search is simple and well-indexed:
- Only ~105k events (vs 299k articles)
- Single-table ILIKE on `headline` + `summary` + `place_name` — no JOINs in the main WHERE
- No `ts_rank_cd` scoring in ORDER BY (just `ORDER BY first_reported_at DESC`)
- Uses trigram GIN indexes efficiently (Bitmap Index Scan on `idx_news_events_headline_trgm`)

### What Makes `/api/pins` Fast (0.002s cached)

The `searchCache` (200 items, 5min TTL) works perfectly for **repeated searches**:
- Same query → served from memory cache
- Cache key is `JSON.stringify(c.req.query())` — so `?q=ukraine` and `?q=ukraine&limit=20` are different cache entries

### Performance Fixes (Priority Order)

#### 1. **[Fastest win] Increase `searchCache` TTL from 5min → 15min**

Every new search term is a cold miss. If popular queries ("ukraine", "election", "trump") are cached for 15min instead of 5min, cache hit rate improves significantly.

```typescript
// api/src/cache.ts
export const searchCache = new SimpleLRUCache<any>(200, 15 * 60_000);  // was 5 * 60_000
```

#### 2. **[Medium effort] Replace `ts_rank_cd` with pre-computed `ts_rank` or drop FTS scoring for small results**

If the query matches < 50 rows, skip expensive FTS scoring and just sort by recency.

```sql
-- Only compute ts_rank_cd for the top N candidates
ORDER BY
  CASE WHEN counter_rank <= 50
    THEN ts_rank_cd(to_tsvector('english', title), plainto_tsquery(...)) * 10000
    ELSE 0
  END + recency_score
```

#### 3. **[Medium effort] Pre-warm cache for trending/popular queries**

Run a cron job that queries top 20 trending topics and pre-populates `searchCache` every 10 minutes:

```python
# worker/prewarm_search_cache.py
TRENDING_TOPICS = ["ukraine", "election", "climate", "economy", ...]
for topic in TRENDING_TOPICS:
    cache_key = f'{{"q":"{topic}","limit":20}}'
    # fetch from DB and populate cache
```

#### 4. **[High effort] Add FTS index on `news_articles.title` only for fast prefix scoring**

The current FTS index includes `title + summary + body`. Scoring on title alone (much shorter) is ~10x faster.

```sql
CREATE INDEX idx_news_articles_title_fts ON news_articles
USING gin(to_tsvector('english', title));
```

Then update the ORDER BY to use the title-only index.

#### 5. **[High effort] Materialize top pins per time bucket**

Pre-compute "top pins for last 24h", "top pins for last 7d" hourly. Search then merges pre-computed buckets with live new pins.

---

### Test Case: Search Performance

```javascript
// tests/search-performance.test.js
test('text search returns within 3s on cold cache', async ({ page }) => {
  const start = Date.now();
  await page.goto(`http://localhost:3000/#0,0,3`);
  await page.fill('#search-input', 'ukraine');
  await page.click('#search-btn');
  await page.waitForFunction(() => window.performance?.now?.() > 0, { timeout: 5000 });
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(3000);  // cold cache
});

test('repeated search hits cache (<100ms)', async ({ page }) => {
  await page.goto(`http://localhost:3000/#0,0,3`);
  await page.fill('#search-input', 'election');
  await page.click('#search-btn');
  await page.waitForTimeout(1000);  // first search caches
  await page.fill('#search-input', 'election');  // same query
  await page.click('#search-btn');
  const start = Date.now();
  // ... measure cached response
  expect(elapsed).toBeLessThan(100);
});
```

### Key Metrics to Monitor

```sql
-- Cache hit rate for searchCache
-- (instrument via middleware or logs)

-- Slowest queries by duration
SELECT query, calls, total_ms, mean_ms, max_ms
FROM pg_stat_statements
WHERE query LIKE '%ILIKE%news_articles%'
ORDER BY mean_ms DESC LIMIT 10;

-- Cache hit ratio (requires instrumentation in SimpleLRUCache)
```

### Realistic "Fast Search" Expectations

| Approach | Cold Query | Warm Cache | Implementation |
|---|---|---|---|
| Today (ILIKE + FTS + cache) | 1-5s | <10ms | Already in place |
| Longer cache TTL (15min) | 1-5s | <10ms | 1-line change |
| Pre-warm popular queries | <100ms | <10ms | Medium effort |
| Skip FTS for small results | ~500ms | <10ms | Medium effort |
| Full-text search with GIN | ~200ms | <10ms | High effort |
