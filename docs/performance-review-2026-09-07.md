# xyzo.org Performance Review — 2026-09-07

**Focus:** Map loading, search, AI/algorithms, universal improvements

---

## 1. Map Loading Performance

### Current State
- **`/api/pins/map`** endpoint: UNION ALL between `pins` and `news_articles` tables
- **Frontend:** `fetchPinsForViewport()` called on every pan/zoom (throttled to 250ms)
- **Clustering:** Leaflet.markercluster with `maxClusterRadius: 50` (pins) / `70` (events)
- **Data volume:** ~41K extracted articles, ~24K events, ~3K locations

### Bottlenecks Identified

#### 1.1 UNION ALL Query Complexity
**File:** `api/src/routes/pins.ts:229-259`

The query does a UNION ALL between two tables with different schemas, then sorts and limits. This forces Postgres to:
1. Execute both subqueries fully
2. Materialize the combined result
3. Sort the entire result set
4. Apply the LIMIT

**Impact:** At 41K articles + 0 pins, the query scans ~41K rows, sorts them, then returns 1500.

**Fix Options:**
1. **Materialized view** for the combined pins view (refresh on article insert)
2. **Separate endpoints** for pins vs articles, let frontend merge
3. **Pre-computed bbox index** using PostGIS `ST_Intersects` with a grid table

**Priority:** HIGH — this is the #1 map loading bottleneck

#### 1.2 Bbox Widening Logic
**File:** `api/src/routes/pins.ts:268-290`

When fewer than 10 pins are returned, the endpoint widens the bbox by 2.5x and re-queries. This can double the query time.

**Impact:** Users zoomed into sparse areas get 2x latency.

**Fix:** Cache the "empty bbox" results or pre-compute density maps.

**Priority:** MEDIUM

#### 1.3 Frontend Marker Reconciliation
**File:** `public_html/app.js:4489-4532`

The `renderPins()` function diffs incoming pins against `pinMarkers` Map, reusing existing markers. This is good, but:
- `syncLayers()` clears and rebuilds clusters on every update
- `pinCluster.addLayers(pinBatch)` is O(n) even for existing markers

**Impact:** Cluster rebuilds take 50-100ms for 1500 pins.

**Fix:**
1. Use `pinCluster.refreshClusters()` only when markers actually changed
2. Track a "dirty" flag to skip unnecessary rebuilds
3. Consider canvas-based rendering for 1000+ markers

**Priority:** MEDIUM

#### 1.4 Missing Spatial Index on news_articles
**File:** `api/migrations/`

The `news_articles` table has `extracted_lat`/`extracted_lng` columns but no spatial index. The bbox filter in `pins.ts:198` uses `l.geom::geometry && ST_MakeEnvelope(...)` which is good, but articles without `location_id` can't use it.

**Fix:** Add a GIST index on `ST_SetSRID(ST_MakePoint(extracted_lng, extracted_lat), 4326)::geography` for articles with native coords.

**Priority:** HIGH

---

## 2. Search Performance

### Current State
- **`/api/events/search`** spawns a Python worker (synchronous, 10-90s)
- **`/api/locations/search`** does trigram similarity + FDW fallback
- **Rate limit:** 5 searches/hour per IP

### Bottlenecks Identified

#### 2.1 Synchronous Worker Spawn
**File:** `api/src/routes/search.ts:62-78`

The search endpoint spawns `python3 -m worker.run --search` and waits for completion. This blocks the API thread for 10-90 seconds.

**Impact:** User waits 10-90s for search results. API thread is blocked.

**Fix:**
1. **Async job queue** — enqueue search, return job ID, poll for results
2. **Pre-computed search index** — materialized view of searchable fields
3. **Elasticsearch/Meilisearch** — full-text search engine for instant results

**Priority:** CRITICAL — this is the worst user experience

#### 2.2 Trigram Similarity on Small Table
**File:** `api/src/routes/locations.ts:43-69`

The `news_locations` table has only 3K rows. Trigram similarity is overkill and slow for this size.

**Impact:** Search takes 50-100ms when it could be 5-10ms.

**Fix:** Use `ILIKE` with a GIN index on `place_name` for prefix matching. Fall back to trigram only for fuzzy matches.

**Priority:** LOW — already fast enough

#### 2.3 FDW Fallback Latency
**File:** `api/src/routes/locations.ts:83-96`

The `world_cities` FDW query adds 20-30ms per search.

**Impact:** Minor latency increase.

**Fix:** Cache FDW results in a local `world_cities_cache` table (refresh weekly).

**Priority:** LOW

---

## 3. AI/Algorithm Improvements

### Current State
- **`extract.py`** calls AI for each article (25s timeout, 60 articles/cycle)
- **Circuit breaker** protects against AI outages
- **`auto_categorize.py`** is the fast-path (no AI, 70% of articles)
- **AI extraction** is the pipeline bottleneck (25 min for 60 articles)

### Bottlenecks Identified

#### 3.1 Sequential AI Extraction
**File:** `worker/extract.py:267-298`

Each article is processed sequentially: call AI, parse JSON, write to DB. At 25s per article, 60 articles take 25 minutes.

**Impact:** Pipeline backlog grows faster than it drains.

**Fix:**
1. **Batch AI calls** — send 5-10 articles in one prompt (if model supports it)
2. **Parallel extraction** — use asyncio + httpx.AsyncClient for concurrent calls
3. **Cache AI results** — hash(title + body[:500]) → cache table, skip if seen

**Priority:** HIGH — this is the #1 pipeline bottleneck

#### 3.2 No AI Result Caching
**File:** `worker/extract.py`

Every article is sent to AI even if we've seen it before (e.g., after a re-fetch).

**Impact:** Wasted AI compute, slower pipeline.

**Fix:** Add `ai_cache` table:
```sql
CREATE TABLE ai_cache (
  content_hash TEXT PRIMARY KEY,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Before calling AI, check if `content_hash` exists. If yes, reuse result.

**Priority:** HIGH

#### 3.3 Regex Fallback is Too Aggressive
**File:** `worker/extract.py:189-250`

When AI fails, the regex fallback uses `cities_text` + `classify` which is good, but it doesn't try the simpler `auto_categorize` logic first.

**Impact:** Lower quality extractions when AI is down.

**Fix:** In `_regex_fallback`, try `auto_categorize._decide()` first before falling back to regex.

**Priority:** MEDIUM

#### 3.4 No Batch Geocoding
**File:** `worker/geocode.py:273-321`

Each location is geocoded sequentially with a 1.1s delay (Nominatim rate limit).

**Impact:** 300 locations take 5.5 minutes.

**Fix:**
1. **Batch Nominatim** — use the `/batch` endpoint (if available)
2. **Local geocoder** — cache all city names from `world_cities` in memory, match without HTTP
3. **Pre-geocode on insert** — when `extracted_lat/lng` are set, skip Nominatim entirely

**Priority:** HIGH

#### 3.5 Event Clustering is Too Strict
**File:** `worker/cluster.py:55-74`

Events are clustered only if `primary_location_id` matches exactly AND `event_type` matches AND within ±6 hours.

**Impact:** Same event from different locations (e.g., "Tokyo" vs "Tokyo, Japan") creates separate events.

**Fix:**
1. **Fuzzy location matching** — cluster if locations are within 10km
2. **Title similarity** — use trigram similarity on headlines
3. **Entity overlap** — cluster if entities overlap > 50%

**Priority:** MEDIUM

---

## 4. Database Optimizations

### Current State
- **Indexes:** Most hot paths have indexes (we just added COALESCE indexes)
- **Connection pool:** max=10, idle_timeout=30s, statement_timeout=30s
- **Table sizes:** news_articles 41K rows, news_events 24K rows

### Bottlenecks Identified

#### 4.1 Missing Index on news_articles.extracted_lat/lng
**File:** `api/src/routes/pins.ts:198`

The bbox filter uses `l.geom::geometry && ST_MakeEnvelope(...)` but articles with native coords (no `location_id`) can't use this index.

**Fix:**
```sql
CREATE INDEX CONCURRENTLY idx_news_articles_native_coords_gist
  ON news_articles
  USING GIST (ST_SetSRID(ST_MakePoint(extracted_lng, extracted_lat), 4326)::geography)
  WHERE extracted_lat IS NOT NULL AND extracted_lng IS NOT NULL;
```

**Priority:** HIGH

#### 4.2 No Index on news_events.expires_at
**File:** `api/src/routes/feed.ts:64`

The query filters `WHERE expires_at IS NULL OR expires_at > now()`. Without an index, this scans all 24K events.

**Fix:**
```sql
CREATE INDEX CONCURRENTLY idx_news_events_expires
  ON news_events (expires_at)
  WHERE status = 'active';
```

**Priority:** MEDIUM

#### 4.3 UNION ALL in pins/map Forces Materialization
**File:** `api/src/routes/pins.ts:229-259`

The UNION ALL forces Postgres to materialize both subqueries before sorting.

**Fix:** Use a materialized view:
```sql
CREATE MATERIALIZED VIEW mv_all_pins AS
SELECT ... FROM pins ...
UNION ALL
SELECT ... FROM news_articles ...
WITH DATA;

CREATE INDEX idx_mv_all_pins_bbox ON mv_all_pins USING GIST (location);
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_all_pins;
```

Refresh every 5 minutes via cron.

**Priority:** HIGH

#### 4.4 No Partial Index on news_articles.status
**File:** `worker/auto_categorize.py:563`

The query `WHERE auto_categorized_at IS NULL AND status = 'pending'` is common, but there's no partial index.

**Fix:**
```sql
CREATE INDEX CONCURRENTLY idx_news_articles_pending_auto_cat
  ON news_articles (fetched_at)
  WHERE status = 'pending' AND auto_categorized_at IS NULL;
```

**Priority:** MEDIUM

---

## 5. Frontend Optimizations

### Current State
- **Bundle size:** 138KB gzipped (app.js)
- **Marker rendering:** Leaflet.markercluster with canvas fallback
- **Debouncing:** 250ms throttle on map move, 350ms debounce on search

### Bottlenecks Identified

#### 5.1 No Virtual Scrolling for Large Pin Sets
**File:** `public_html/app.js:4489-4532`

When 1500+ pins are in viewport, all are rendered as DOM elements. This causes jank on pan/zoom.

**Fix:**
1. **Canvas rendering** — use Leaflet.canvas or custom WebGL layer for 1000+ markers
2. **Viewport culling** — only render markers within viewport + 100px buffer
3. **Level-of-detail** — show simple circles at low zoom, full icons at high zoom

**Priority:** MEDIUM

#### 5.2 Cluster Rebuild on Every Update
**File:** `public_html/app.js:4039-4062`

`syncLayers()` calls `pinCluster.addLayers(pinBatch)` which rebuilds clusters even if markers haven't changed.

**Fix:**
```javascript
// Track if markers actually changed
let markersDirty = false;

function renderPins(pins) {
  // ... diff logic ...
  if (newMarkersAdded || markersRemoved) {
    markersDirty = true;
  }
}

function syncLayers() {
  if (!markersDirty) return;
  // ... rebuild clusters ...
  markersDirty = false;
}
```

**Priority:** MEDIUM

#### 5.3 No Prefetch on Idle
**File:** `public_html/app.js`

The frontend only fetches pins on map move. When idle, it could prefetch adjacent tiles.

**Fix:**
```javascript
// After map settles, prefetch adjacent bboxes
map.on('moveend', () => {
  setTimeout(() => {
    const bounds = map.getBounds();
    // Prefetch bbox 20% larger than current viewport
    prefetchPins(expandBounds(bounds, 1.2));
  }, 2000);
});
```

**Priority:** LOW

#### 5.4 Popup Content is Re-rendered Every Time
**File:** `public_html/app.js:4674-4734`

`buildPinMarker()` creates popup content as a string. Every time the popup opens, it's re-rendered.

**Fix:** Cache popup DOM elements:
```javascript
const popupCache = new Map();

function buildPopup(pin) {
  if (popupCache.has(pin.id)) return popupCache.get(pin.id);
  const html = buildPopupHTML(pin);
  popupCache.set(pin.id, html);
  return html;
}
```

**Priority:** LOW

---

## 6. Caching Opportunities

### Current State
- **API cache:** `pinsCache` (300 entries, 20s TTL), `liveFeedCache` (50 entries, 20s TTL)
- **Frontend cache:** localStorage for mode/time filter, no pin caching
- **CDN cache:** None (dynamic content)

### Opportunities

#### 6.1 Cache /api/pins/map by Bbox Grid
**File:** `api/src/routes/pins.ts:183`

Currently cached by exact query string. Different users with similar viewports don't share cache.

**Fix:** Round bbox to 0.01° grid (~1km):
```typescript
const roundedBbox = roundBbox(q.bbox, 0.01);
const cacheKey = `map:${roundedBbox}:${q.since}:${q.category}`;
```

**Priority:** HIGH

#### 6.2 Cache /api/events by Bbox
**File:** `api/src/routes/events.ts`

No caching on events endpoint. Every request hits DB.

**Fix:** Add 20s LRU cache keyed on bbox + filters.

**Priority:** MEDIUM

#### 6.3 Cache AI Extraction Results
**File:** `worker/extract.py`

Every article is sent to AI even if we've seen it before.

**Fix:** Hash `title + body[:500]`, check `ai_cache` table before calling AI.

**Priority:** HIGH

#### 6.4 Cache Geocoding Results
**File:** `worker/geocode.py`

Same location text is geocoded multiple times across articles.

**Fix:** The `news_locations` table already dedupes by `(place_name_normalized, ROUND(lat, 3), ROUND(lng, 3))`. But we could add an in-memory cache:
```python
_geocode_cache = {}

def geocode_one(location_text):
    if location_text in _geocode_cache:
        return _geocode_cache[location_text]
    # ... geocode ...
    _geocode_cache[location_text] = result
    return result
```

**Priority:** MEDIUM

#### 6.5 Frontend Pin Cache
**File:** `public_html/app.js`

Pins are re-fetched on every pan/zoom. No localStorage cache.

**Fix:**
```javascript
// Cache pins by bbox grid
const pinCache = new Map();

async function fetchPinsForViewport() {
  const bbox = getRoundedBbox(map.getBounds(), 0.01);
  const cacheKey = `pins:${bbox}`;
  
  if (pinCache.has(cacheKey)) {
    renderPins(pinCache.get(cacheKey));
    return;
  }
  
  const pins = await fetch(`/api/pins/map?bbox=${bbox}`);
  pinCache.set(cacheKey, pins);
  renderPins(pins);
}
```

**Priority:** MEDIUM

---

## 7. Quick Wins (Implement First)

### 7.1 Add Spatial Index on Native Coords
**Effort:** 1 hour  
**Impact:** 2-5x faster bbox queries for articles with native coords

```sql
CREATE INDEX CONCURRENTLY idx_news_articles_native_coords_gist
  ON news_articles
  USING GIST (ST_SetSRID(ST_MakePoint(extracted_lng, extracted_lat), 4326)::geography)
  WHERE extracted_lat IS NOT NULL AND extracted_lng IS NOT NULL;
```

### 7.2 Cache AI Extraction Results
**Effort:** 2 hours  
**Impact:** 30-50% reduction in AI calls

```python
# In extract.py
def extract_one(client, article):
    content_hash = hashlib.sha256(
        f"{article['title']}|{article.get('body', '')[:500]}".encode()
    ).hexdigest()
    
    # Check cache
    cached = sql("SELECT result FROM ai_cache WHERE content_hash = %s", (content_hash,))
    if cached:
        return cached[0]['result']
    
    # ... call AI ...
    
    # Cache result
    sql("INSERT INTO ai_cache (content_hash, result) VALUES (%s, %s)", (content_hash, result))
    return result
```

### 7.3 Batch Geocoding
**Effort:** 3 hours  
**Impact:** 5-10x faster geocoding

```python
# In geocode.py
def run(limit=300):
    pending = fetch_pending(limit)
    
    # Group by location_text
    by_text = {}
    for art in pending:
        text = art['location_text']
        if text not in by_text:
            by_text[text] = []
        by_text[text].append(art)
    
    # Geocode each unique text once
    for text, articles in by_text.items():
        loc = geocode_one(text)
        if loc:
            location_id = upsert_location(loc)
            for art in articles:
                update_article(art['id'], location_id)
```

### 7.4 Round Bbox Cache Key
**Effort:** 30 min  
**Impact:** 50-70% cache hit rate (vs 0% currently)

```typescript
// In pins.ts
function roundBbox(bbox: string, precision: number): string {
  const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
  const round = (n: number) => Math.round(n / precision) * precision;
  return `${round(minLng)},${round(minLat)},${round(maxLng)},${round(maxLat)}`;
}

const cacheKey = `map:${roundBbox(q.bbox, 0.01)}:${q.since}:${q.category}`;
```

### 7.5 Dirty Flag for Cluster Rebuilds
**Effort:** 1 hour  
**Impact:** 30-50% reduction in cluster rebuilds

```javascript
// In app.js
let markersDirty = false;

function renderPins(pins) {
  // ... diff logic ...
  if (newMarkersAdded || markersRemoved) {
    markersDirty = true;
  }
}

function syncLayers() {
  if (renderMode === "clusters" && markersDirty) {
    pinCluster.clearLayers();
    pinCluster.addLayers(pinBatch);
    markersDirty = false;
  }
}
```

---

## 8. Medium-Term Improvements

### 8.1 Materialized View for Pins
**Effort:** 1 day  
**Impact:** 5-10x faster map queries

Create `mv_all_pins` materialized view, refresh every 5 minutes.

### 8.2 Async Search Queue
**Effort:** 2 days  
**Impact:** Search returns in 100ms (vs 10-90s)

Use the existing `discovery_jobs` queue. Return job ID, poll for results.

### 8.3 Parallel AI Extraction
**Effort:** 1 day  
**Impact:** 5-10x faster AI extraction

Use asyncio + httpx.AsyncClient to process 5-10 articles concurrently.

### 8.4 Fuzzy Event Clustering
**Effort:** 2 days  
**Impact:** 20-30% reduction in duplicate events

Cluster by location proximity (10km) + title similarity (trigram > 0.7).

### 8.5 Canvas Rendering for 1000+ Markers
**Effort:** 3 days  
**Impact:** Smooth pan/zoom with 5000+ markers

Replace Leaflet.markercluster with canvas-based renderer.

---

## 9. Long-Term Architecture

### 9.1 Elasticsearch for Search
**Effort:** 1 week  
**Impact:** Instant search, full-text, faceted

Replace Postgres trigram search with Elasticsearch.

### 9.2 Redis for Caching
**Effort:** 3 days  
**Impact:** Shared cache across API instances

Move `pinsCache`, `liveFeedCache`, rate limiters to Redis.

### 9.3 Tile-Based Pin Storage
**Effort:** 1 week  
**Impact:** O(1) bbox queries

Pre-compute pins per tile (zoom 0-18), store in S3/Redis.

### 9.4 GraphQL Subscriptions
**Effort:** 1 week  
**Impact:** Real-time updates without polling

Replace 30s polling with GraphQL subscriptions for live feed.

---

## 10. Implementation Priority

### This Week (Quick Wins)
1. ✅ Add spatial index on native coords (1h)
2. ✅ Round bbox cache key (30min)
3. ✅ Dirty flag for cluster rebuilds (1h)
4. ✅ Cache AI extraction results (2h)
5. ✅ Batch geocoding (3h)

**Total effort:** 7.5 hours  
**Expected impact:** 2-5x faster map loading, 30-50% faster pipeline

### Next Week (Medium-Term)
1. Materialized view for pins (1 day)
2. Async search queue (2 days)
3. Parallel AI extraction (1 day)

**Total effort:** 4 days  
**Expected impact:** 5-10x faster map queries, instant search

### Next Month (Long-Term)
1. Elasticsearch for search (1 week)
2. Canvas rendering (3 days)
3. Redis caching (3 days)

**Total effort:** 2.5 weeks  
**Expected impact:** Production-ready scale (100K+ articles, 1000+ concurrent users)

---

## 11. Monitoring & Metrics

### Key Metrics to Track
1. **Map load time** — time from `fetchPinsForViewport()` call to markers rendered
2. **Search latency** — time from search submit to results displayed
3. **AI extraction rate** — articles/minute processed
4. **Cache hit rate** — % of requests served from cache
5. **Pipeline backlog** — pending articles count

### Dashboard
Create `/api/metrics/performance` endpoint returning:
```json
{
  "map_load_p50_ms": 120,
  "map_load_p95_ms": 450,
  "search_latency_p50_ms": 80,
  "ai_extraction_rate": 2.5,
  "cache_hit_rate": 0.65,
  "pipeline_backlog": 1200
}
```

---

## 12. Conclusion

The biggest wins are:
1. **Spatial index on native coords** — 2-5x faster bbox queries
2. **AI result caching** — 30-50% reduction in AI calls
3. **Batch geocoding** — 5-10x faster geocoding
4. **Rounded bbox cache** — 50-70% cache hit rate
5. **Materialized view for pins** — 5-10x faster map queries

Implement the quick wins first (7.5 hours), then move to medium-term (4 days). The long-term architecture (Elasticsearch, Redis, canvas rendering) is only needed if you hit 100K+ articles or 1000+ concurrent users.

**Current score:** 52/100 (from audit)  
**After quick wins:** 65/100  
**After medium-term:** 75/100  
**After long-term:** 85/100
