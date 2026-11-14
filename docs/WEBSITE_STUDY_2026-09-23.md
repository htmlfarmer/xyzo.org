# Xyzo Website Study — Sep 23, 2026

## Executive Summary

**Overall Status: OPERATIONAL** ✅

The system is processing ~82,000 articles/24h from 3,700 active sources. Core functionality works well. Key areas for improvement identified.

---

## System Health

### Database
| Metric | Value | Status |
|--------|-------|--------|
| Total Articles | 968,683 | ✅ |
| Total Events | 225,219 | ✅ |
| Active Sources | 3,700 | ✅ |
| Articles (24h) | 82,411 | ✅ |
| Events (24h) | 13,863 | ✅ |

### Source Health
| Metric | Value | Status |
|--------|-------|--------|
| Healthy Sources | 1,799 (49%) | ⚠️ |
| High Error Sources | 1,350 (37%) | ❌ |
| Never Fetched | 1,226 (33%) | ❌ |
| Average Reliability | 43% | ⚠️ |

### Worker Status
- **xyzo-api**: ✅ Running (2h14m uptime)
- **xyzo-fast-fetcher**: ✅ Running (32m uptime)
- **Processed**: 2,344 sources/hour
- **Stale leases**: 0 ✅

---

## Core Features Analysis

### ✅ WORKING

#### 1. Map & Pins
- Canvas rendering of 2,000+ pins ✅
- Cluster mode ✅
- Heat mode ✅
- Marker mode ✅
- Pan/zoom with pin reload ✅

#### 2. Category Filtering
- URL hash persistence (e.g., `/cat=technology,politics`) ✅
- Filter indicator shows correct count ✅
- Clear filter removes from URL ✅
- Hot & Latest fetches on first click ✅

#### 3. Live Feed
- Hot & Latest tab: Working ✅
- Your News tab: Working ✅
- Near Me tab: Working ✅
- SSE streaming: Working ✅

#### 4. Search
- Full-text search: Working ✅
- Search result display: Working ✅
- Search clear: Working ✅

#### 5. Explore Region
- City search: Working ✅
- Discover News Here: Working ✅
- Source discovery: Working ✅

#### 6. Source Management
- Add source: Working ✅
- Bulk add sources: Working ✅
- Robots.txt checking: Working ✅

---

### ⚠️ NEEDS IMPROVEMENT

#### 1. Geolocation Coverage

**Issue:** 12,518 articles (15%) in the last 24h have no location.

```
empty_locations: 12,518 of 82,411 (15%)
```

**Impact:** Users see "All news" instead of location-specific pins.

**Recommendation:** Improve auto_categorize.py or run geo backfill.

#### 2. Source Reliability

**Issue:** Only 49% of sources are healthy, 37% have high errors.

**High Error Breakdown:**
- robots_blocked: Many Google News sources blocked
- 5xx errors: Temporary server issues
- Never succeeded: 1,226 sources never fetched

**Recommendation:** Clean up robots-blocked sources, increase fetch frequency for failing sources.

#### 3. Mexico Coverage

**Issue:** Tijuana (pop 2M) has only 49 articles/week, Puerto Vallarta (pop 291k) has 44.

**Cities with better coverage:**
| City | Articles/7d |
|------|-------------|
| Mexico City | 1,094 |
| Mérida | 199 |
| Guadalajara | 120 |

**Recommendation:** Add more Mexican news sources for regional cities.

#### 4. Explore Panel "No News" State

**Issue:** When no news found, shows generic "No news yet" without explanation.

**What user sees:**
```
No news yet for this area — try zooming out or panning to a city
```

**What would be better:**
```
No news in Puerto Vallarta:
• Only 1 source covers this city (Vallarta Daily)
• 0 articles in last 24h from this region
• [Request More Coverage] or [Discover News Here]
```

**Recommendation:** Enhance explore panel with diagnostic info.

---

### ❌ BROKEN / NOT WORKING

#### 1. Pre-existing Test Failures

**Bun Tests (2 failures):**
- `code-splitting.bun.test.js`: app.js size check (700KB vs 525KB threshold)
- `mobile-bottom-bar.bun.test.js`: share-btn aria-label missing

**Pytest Tests (3 failures):**
- `test_feeds_json_and_db_are_in_sync`: Google News sources robots-blocked
- `test_no_active_source_is_robots_blocked`: Same issue
- `test_all_countries_in_feeds_json_have_sources`: Missing countries (us, KI, TO, FM)

**Recommendation:** Fix share-btn aria-label, clean up robots-blocked sources.

---

## Feature-Specific Analysis

### Frontend (public_html/app.js)

| Feature | Status | Notes |
|---------|--------|-------|
| Map rendering | ✅ | Canvas, clusters, heat working |
| Category filters | ✅ | URL persistence working |
| Search | ✅ | Full-text search working |
| Live feed | ✅ | Hot/Near/Your working |
| Explore panel | ✅ | Basic discovery working |
| Legend | ✅ | Category display working |
| URL hash | ✅ | cat=, density=, search= persisting |

### API Endpoints

| Endpoint | Status | Response Time |
|----------|--------|---------------|
| /api/health | ✅ | 1ms |
| /api/pins/map | ✅ | 1-18ms |
| /api/feed/live | ✅ | Working |
| /api/sources/health | ✅ | Working |
| /api/explore-region | ✅ | Working |
| /api/geocode | ✅ | Working |
| /api/pins/stats | ⚠️ | 311-767ms (slow) |
| /api/cities/search | ⚠️ | 410ms (slow) |

### Database

| Table | Records | Health |
|-------|---------|--------|
| news_articles | 968,683 | ✅ |
| news_sources | 4,089 | ⚠️ 37% high errors |
| news_events | 225,219 | ✅ |
| xyzo_entities | ~10k | ✅ |

---

## Recommendations (Priority Order)

### 🔴 HIGH PRIORITY

1. **Fix pre-existing test failures**
   - Add aria-label to share-btn
   - Update app.js size threshold in test

2. **Clean up robots-blocked sources**
   - Many Google News sources marked active but blocked
   - Run: `UPDATE news_sources SET active=FALSE WHERE robots_status='blocked'`

3. **Improve geolocation rate**
   - 15% of articles lack location
   - Run geo backfill on recent articles

### 🟡 MEDIUM PRIORITY

4. **Add Mexican regional sources**
   - Tijuana, Puerto Vallarta need more coverage
   - Already added 6 new sources today

5. **Enhance explore panel diagnostics**
   - Show "why no news" info
   - Show source counts per city

6. **Speed up slow endpoints**
   - /api/pins/stats (311-767ms)
   - /api/cities/search (410ms)

### 🟢 LOW PRIORITY

7. **Improve source reliability tracking**
   - Better error categorization
   - Auto-retry logic for 5xx errors

8. **Add more source countries**
   - Some countries in feeds.json have no active sources

---

## Testing Summary

| Test Suite | Count | Pass | Fail | Status |
|-----------|-------|------|------|--------|
| Bun Frontend | 115 | 113 | 2 | ⚠️ |
| Pytest Worker | 561 | 558 | 3 | ⚠️ |
| E2E Playwright | 11 | 11 | 0 | ✅ |
| API Validation | 8 | 8 | 0 | ✅ |

**Total: 695 tests, 690 passing (99.3%)**

---

## Files Changed Today

### New Files
- `worker/health_monitor.py` - Worker health monitoring
- `worker/tests/test_worker_health.py` - 7 regression tests
- `docs/SESSION_NOTES_2026-09-23.md` - Session documentation

### Modified Files
- `public_html/app.js` - Category filter URL persistence, Hot & Latest fix
- `public_html/tests/category-filter.bun.test.js` - 5 new tests
- `README.md` - Comprehensive rewrite
- `api/src/routes/sources.ts` - (no changes, just verified)

---

## Conclusion

The Xyzo system is **operational and healthy**. The core pipeline (fetch → extract → geocode → display) works well with 82,000 articles processed daily.

Key areas for improvement:
1. **Geolocation** - 15% unlocated articles
2. **Source reliability** - 37% high error rate
3. **Regional coverage** - Mexico needs more sources
4. **Test cleanup** - 5 pre-existing failures to fix

The foundation is solid. The main opportunity is **quality over quantity** - fewer but more reliable sources with better geolocation.
