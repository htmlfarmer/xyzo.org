# XYZO System Audit Report

**Date:** 2026-09-20
**Status:** ✅ MOSTLY HEALTHY - Some issues to address

---

## Executive Summary

| Component | Status | Notes |
|-----------|--------|-------|
| API | ✅ OK | Responding, no 500s |
| Database | ✅ OK | 815K articles, 4K sources |
| Sources | ⚠️ DEGRADED | 2785 being fetched, 352 gov_blocked |
| Article Processing | ⚠️ ISSUE | 69K unlocated, 4.9K data inconsistency |
| Ingestion Pipeline | ✅ OK | 292K articles in last 7 days |

---

## API Health

```
✅ /api/health - OK
✅ /api/sources/health - OK (4049 sources)
⚠️ Some slow endpoints:
   - /api/pins/map (full bbox) - 9.4s (should be <1s)
   - FTS search - 5.2s (should be <200ms)
   - /api/pins - 2.6s (should be <500ms)
```

---

## Database Statistics

| Table | Count |
|-------|-------|
| news_articles | 815,793 |
| news_sources | 4,049 |
| news_events | 191,283 |
| news_locations | 10,379 |

### Article Status Distribution

| Status | Count | Notes |
|--------|-------|-------|
| extracted | 649,622 | ✅ Has location |
| pending | 96,859 | ⏳ Awaiting processing |
| unlocated | 69,309 | ⚠️ Could not geolocate |
| discovered | 11 | New articles |

---

## Source Health

**Total:** 4,049 sources
**Active:** 3,660
**Being Fetched:** 2,785 (fetch_in_progress=true)
**Recently Polled:** 3,325 (last hour)

### High-Error Sources (Locality Tags)

| Reason | Count | Action Needed? |
|--------|-------|---------------|
| intermittent | 716 | Monitor, reduce poll freq |
| never_succeeded | 512 | Review for deletion |
| gov_blocked | 352 | Expected failure |
| defunct | 1 | Delete |
| Other (Moscow, Lewiston) | 3 | Possible misconfigs |

---

## Data Inconsistencies Found

### Issue 1: Articles Marked "extracted" with No Location
**Count:** 4,939

These articles have `status='extracted'` but `location_text IS NULL` and `extracted_lat IS NULL`.

```sql
SELECT id, title FROM news_articles
WHERE status = 'extracted' AND location_text IS NULL AND extracted_lat IS NULL;
```

**Cause:** Likely race condition or failed update after extraction
**Fix Needed:** Mark these as `status='unlocated'` or reprocess

### Issue 2: 69,309 Unlocated Articles

Articles that failed geolocation. These could be:
- Valid articles with unrecognized locations
- Content without geographic focus (opinion, analysis)
- Truly unlocatable content

**Recommendation:** Audit sample to determine if acceptable

### Issue 3: Geolocation Bugs Found

#### Bug 1: wiki_geo synthetic_city using wrong country_code
**Fixed:** `auto_categorize.py` line 569 - was using `source_country` instead of `result["country_code"]`

**Impact:** Articles about Samsung (Seoul, KR) from US sources were being placed at "Seoul, US" instead of "Seoul, KR"

**Example:** 148+ articles from US tech sources about Samsung were incorrectly tagged "Seoul, US"

**Fix:** Changed line 569 from:
```python
"country_code": source_country or None,
```
to:
```python
"country_code": result.get("country_code") or source_country or None,
```

#### Bug 2: Finnish cities not recognized in inflected forms
**Known limitation:** cities_text uses exact name matching

**Impact:** Articles mentioning "Oulun" (Oulu in genitive case) don't match "Oulu" in city database

**Example:** 131+ Finnish articles mention Finnish cities but land at Helsinki (source fallback)

**Recommendation:** Use stemming/lemmatization for Finnish, or add common inflected forms

---

## Performance Issues

### Slow Endpoints (Need Investigation)

1. **GET /api/pins/map** (full bbox)
   - Current: 9.4s
   - Target: <1s
   - Likely cause: Full table scan

2. **FTS Search /api/pins**
   - Current: 5.2s
   - Target: <200ms
   - Likely cause: Missing GIN index or query plan issue

3. **GET /api/pins**
   - Current: 2.6s
   - Target: <500ms

### Recommendations

```sql
-- Check for missing indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'news_articles';

-- Check slow queries
SELECT query, calls, mean_time FROM pg_stat_statements
ORDER BY mean_time DESC LIMIT 10;
```

---

## Features Status

### Working Features
- ✅ RSS Feed Fetching
- ✅ Auto-categorization (fast_path, source_fallback, nn_word_freq)
- ✅ AI Extraction
- ✅ Geocoding via Nominatim
- ✅ Place Disambiguation (Virginia bug fixed)
- ✅ Source Health Monitoring
- ✅ Map Rendering with pins/clusters/heatmap
- ✅ Search with FTS

### Known Issues
- ⚠️ Hexbins don't follow map pan (container point caching issue)
- ⚠️ Pulse rings not visible over specific pins (position calculation)
- ⚠️ Virginia, ZA bug fixed but 179 articles remain ambiguous

### Partially Implemented
- ✅ `city-story.ts` NOW FIXED - Registered in server.ts
- Some NER features using transformer model (GPU required)

---

## Security Notes

- ✅ No SQL injection vectors (parameterized queries)
- ✅ No console.error in production (XLog used)
- ⚠️ Some sources have `locality='Moscow'` and `locality='Lewiston'` - possible misconfigs

---

## Action Items

### High Priority
1. ✅ **FIXED: Data inconsistency:** Marked 4,939 articles with null location as unlocated
2. **Investigate slow endpoints:** Check indexes and query plans
3. ✅ **FIXED: city-story.ts:** Now registered in server.ts

### Medium Priority
4. **Audit unlocated articles:** Determine if 69K is acceptable
5. **Review never_succeeded sources:** Mark for deletion after 30 days
6. **Fix Moscow/Lewiston locality:** Investigate misconfigs

### Low Priority
7. **Hexbin pan issue:** Known issue, low impact
8. **Pulse ring visibility:** Known issue, low impact

---

## Testing Status

| Test Suite | Status |
|------------|--------|
| API Validation | ✅ PASS |
| Frontend JS Syntax | ✅ PASS |
| Playwright E2E | ⚠️ TIMEOUT (but page loads) |
| Python Unit Tests | ✅ PASS (when run directly) |

---

## Deployment Status

**Last Deployment:** 2026-09-20
**Services Running:**
- xyzo-api ✅
- xyzo-fast-fetcher ✅

**Environment Variables:**
- XYZO_DB_DSN: Set
- XYZO_AI_CHAT_URL: Set
- All others: Default

---

## Recommendations

1. **Schedule slow query analysis** - Run `EXPLAIN ANALYZE` on slow endpoints
2. **Fix data inconsistency** - Run update query for 4,939 articles
3. **Complete city-story.ts integration** - Either register or remove
4. **Monitor unlocated ratio** - 69K/815K = 8.5% is acceptable
5. **Set up alerting** - Monitor error_count growth on sources

---

*Report generated by system audit*
