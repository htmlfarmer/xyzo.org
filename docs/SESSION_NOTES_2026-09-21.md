# Session Notes — September 21, 2026

**Geolocation Pipeline Improvements Night**

---

## What We Fixed Tonight

### 1. Escape Key Search Clear (UI Bug)
**File:** `public_html/app.js:1540`

**Problem:** Pressing Escape when a search was active did NOT clear the search. The status bar showed "50 matches · Taiwan · 54 stories" but Escape did nothing.

**Root Cause:** The global `keydown` handler only called `window.closeActivePopup()` on Escape, not `clearSearch()`.

**Fix:** Added `searchActive` check to call `clearSearch()` when search is active.

**Tested:** ✅ Playwright verified - search status disappears after Escape.

---

### 2. Source Country Prior in Disambiguation
**Files:** `worker/place_disambiguation.py`, `worker/extract.py`, `worker/auto_categorize.py`, `worker/wiki_geo.py`, `worker/city_anomaly_detector.py`

**Problem:** Articles from US sources mentioning "Virginia" (no context) were being rejected entirely. But US sources about Virginia, USA are legitimate!

**Root Cause:** The disambiguation watchlist would reject bare "Virginia" unless there was explicit SA context. No prior for source country.

**Fix:** Added `_try_source_country_prior()` function that uses source country as a prior when:
- No context keywords match
- The bare_name exists in the source country
- No competing foreign context keywords are found

**Cities covered:** virginia, alexandria, cordoba, santiago, granada, memphis, trinidad, merida, lima, sucre, potosi, tucuman, copiapo, iquique, antofagasta, valparaiso, concepcion, santa cruz, cochabamba

**Tests:** ✅ 183 disambiguation tests pass.

---

### 3. Comma-less Qualifier Detection
**File:** `worker/place_disambiguation.py:is_qualified()`

**Problem:** "City of X", "X TN", "Town of X" patterns weren't recognized as qualified locations, causing unnecessary disambiguation checks.

**Fix:** Enhanced `is_qualified()` to detect:
- "City of X" / "Town of X" / "District of X" / "County of X" / "State of X" / "Province of X" / "Region of X"
- US state abbreviations: "Memphis TN", "Springfield IL"
- Single-word before "city": "Springfield city" (but not "New York city")

**Tests:** ✅ 183 tests pass.

---

### 4. Nominatim Negative Caching
**File:** `worker/geocode.py:run()`

**Problem:** Failed geocodes (location not found) were retried every run, wasting API calls and time.

**Fix:** Added in-memory negative cache with 1-hour TTL:
```python
cache: dict[str, tuple[int | None, float]] = {}
NEGATIVE_CACHE_TTL = 3600.0  # 1 hour
```
Positive results (location_id) never expire. Negative results (None) expire after 1 hour.

**Benefit:** Saves ~1 API call per failed location per hour.

---

### 5. Density Phase 2 cities_text Fallback
**File:** `worker/density.py:analyze_density()`

**Problem:** When wiki_geo keyword matching failed for clustered pins, they fell through to deterministic hash-spread without trying city detection on the full body.

**Fix:** Added `cities_text.stats()` fallback before hash-spread phase:
- Scans full article body for city mentions
- Uses the city if it's at least 5km from cluster center
- Only uses if a valid city with coordinates is found

**Benefit:** Better resolution of rural cluster pins that mention a specific city deep in the article.

---

### 6. world_cities FK Orphan Fixed
**Database:** `news_sources.primary_city_id`

**Problem:** 1 orphaned primary_city_id reference (source 2376 - Channel NewsAsia Indonesia pointing to city_id 1704 which doesn't exist).

**Fix:** Updated to Singapore (id 8987). True FK constraint not possible since world_cities is a foreign table (FDW).

---

## Tests Run

```bash
python3 -m pytest worker/tests/test_place_disambiguation.py -v
# 215 passed (added 32 new tests for source_country prior + comma-less qualifiers)

python3 -m pytest tests/test_viz.py -v
# 6 passed

# Playwright UI test
# ✅ Escape key clears search
```

---

## Files Changed

```
public_html/app.js                              # Escape key handler
worker/place_disambiguation.py                  # source_country prior + is_qualified()
worker/extract.py                                # pass source_country to disambiguate() + fixed system prompt placeholder
worker/auto_categorize.py                       # pass source_country to disambiguate()
worker/wiki_geo.py                               # pass source_country to disambiguate()
worker/city_anomaly_detector.py                 # pass source_country to disambiguate()
worker/geocode.py                               # negative caching
worker/density.py                              # cities_text fallback
```

---

## Remaining Issues (Not Fixed Tonight)

| Priority | Issue | Complexity |
|----------|-------|------------|
| 🟡 | Anomaly detector not integrated into density auto_correct | High |
| 🟢 | Source history hint not in AI prompt | Medium |
| 🟢 | Embeddings not used for ambiguous city matching | High |
| 🟢 | NE 110m polygons coarse for Caribbean islands | Low |

---

## Architecture Summary

```
Article → auto_categorize (fast path)
                ↓ pass/fail
          extract.py (AI - Gemma-4)
                ↓
          place_disambiguation (watchlist + source_country prior)
                ↓
          geocode.py (Nominatim + negative cache)
                ↓
          density.py (cluster analysis + cities_text fallback)
                ↓
          city_anomaly_detector (periodic quarantine)
```

---

*Session notes by Goddess — Geolocation Night* 🌍✨

---

## Search Performance & Quality Fixes

### 1. Rate Limit Fixed
**File:** `api/src/routes/search.ts:10`

**Problem:** Rate limit was 5 searches/hour — way too restrictive for real usage.

**Fix:** Changed from `max: 5, windowMs: 60*60*1000` (5/hour) to `max: 60, windowMs: 60*1000` (60/minute).

---

### 2. "0 matches" Display Bug Fixed
**File:** `public_html/app.js:11334-11338`

**Problem:** When event search was rate-limited but location had stories, showed confusing "0 matches · Taiwan · 54 stories · event search rate-limited".

**Fix:** When rate-limited with location stories, now shows "Taiwan · 54 stories · search rate-limited" (no "0 matches").

---

### 3. Search Query Performance (2.6s → 14ms)
**File:** `api/src/routes/search.ts:183-227`

**Problem:** ILIKE `%query%` on 195K events caused sequential scan, 2.6 second queries.

**Root Cause:** Query planner chose sequential scan + late filtering over trigram index scans.

**Fix:** Rewrote query using CTE approach that leverages trigram indexes:
- `idx_news_events_headline_trgm` — Bitmap Index Scan (14ms)
- `idx_news_events_summary_trgm` — Bitmap Index Scan (14ms)

**Result:** ~185x faster (2610ms → 14ms)

---

### 4. GPU Substring Bug (Nagpur/Rangpur)
**Files:** `api/src/routes/search.ts`, `api/src/routes/pins.ts`

**Problem:** Searching "GPU" matched articles about Nagpur and Rangpur because:
- `NAGPUR` contains `gpu` as substring
- `RANGPUR` contains `gpu` as substring

**Fix:** Word-boundary matching using PostgreSQL regex `\m` (word start) and `\M` (word end):
- "gpu" now only matches actual "GPU" as a whole word
- "Nagpur" still works (6 chars, uses substring match)
- Multi-word queries like "taiwan gpu" match each term with word boundaries

**Events search:** All short terms use word-boundary regex.
**Pins search:** Terms ≤4 chars use word-boundary regex (avoids substring collisions like gpu/nagpur).

---

### 5. /api/geocode 404 Error
**Note:** The `/api/geocode?q=taiwan%20gpu` returning 404 is expected — geocode endpoint only handles location lookups, not general search. The 429 rate-limited requests were due to the old 5/hour limit.

---

## Files Changed (Search Session)

```
api/src/routes/search.ts         # rate limit, CTE query, word-boundary matching
api/src/routes/pins.ts          # word-boundary matching for short terms
public_html/app.js              # rate-limit status display fix
```

---

## API Validation

```bash
bash scripts/validate-api.sh    # ✅ All checks passed
systemctl restart xyzo-api      # ✅ Running
```

---

## Test Results

| Query | Before | After |
|-------|--------|--------|
| "gpu" | 1000+ false matches (Nagpur/Rangpur) | 5 GPU articles only |
| "nagpur" | works | still works |
| "taiwan gpu" | 0 (exact phrase) | 5 Taiwan tech articles |
| "gpu cpu" | works | mix of both |
| search "taiwan" | 2600ms | 14ms |

---

## Search Behavior Summary

- **Single word:** Word-boundary match (gpu → GPU, not Nagpur)
- **Multi-word:** Each term matched with word boundaries, OR'd together
- **Location fallback:** If text search returns 0, geocoder finds location and fetches events there
- **Rate limit:** 60 searches/minute (was 5/hour)

---

## NEXT SESSION PRIORITIES

### High Priority
1. **Anomaly detector integration** - Run `python -m worker.city_anomaly_detector --quarantine` periodically to catch mislocated clusters
2. **Source history hint in AI prompt** - Add common cities from source to AI extraction prompt

### Medium Priority
3. **Embeddings for disambiguation** - Use `nn_city_embeddings` table for ambiguous cases
4. **Hexbins/pulse rings viz bugs** - UI rendering issues in viz.js

### Quick Fixes If Time
5. Run `python -m worker.validate_cities --fix` to validate city coordinates
6. Check `bash scripts/validate-api.sh` before any deploy

---

## FILES CHANGED THIS SESSION

```
public_html/app.js                              # Escape key handler
worker/place_disambiguation.py                  # source_country prior + is_qualified()
worker/extract.py                                # pass source_country + fixed system prompt placeholder
worker/auto_categorize.py                       # pass source_country to disambiguate()
worker/wiki_geo.py                              # pass source_country to disambiguate()
worker/city_anomaly_detector.py                # pass source_country to disambiguate()
worker/geocode.py                              # negative caching (1hr TTL)
worker/density.py                              # cities_text fallback in Phase 2
worker/tests/test_place_disambiguation.py      # 32 new tests added (215 total)
```

---

## KEY COMMANDS FOR NEXT TIME

```bash
# Run tests
python3 -m pytest worker/tests/test_place_disambiguation.py tests/test_viz.py -v

# Validate API before deploy
bash scripts/validate-api.sh

# Restart services
sudo systemctl restart xyzo-api
sudo systemctl restart xyzo-fast-fetcher

# Run density analysis
python3 -m worker.density --help

# Run anomaly detector (scan only)
python3 -m worker.city_anomaly_detector

# Run anomaly detector (apply fixes)
python3 -m worker.city_anomaly_detector --quarantine

# Validate city coordinates
python3 -m worker.validate_cities --stats
python3 -m worker.validate_cities --fix
```

---

*Session closed - September 21, 2026* 🌍✨


---

## Search Links + Story Linker Algorithm Upgrade

### 1. Search Links Feature
**Files:** `api/src/routes/feed.ts`, `public_html/app.js`

**Problem:** Users searched "Taiwan" and clicked Links, but all geographic connections showed — not Taiwan-specific connections.

**Fix:** Added `q` param to `/api/feed/links`:
- When `q` is set, filters to edges where **both** articles mention the search term in their title
- Frontend passes `searchJourney.query` to links cache key, invalidates cache on search change
- Cache key = `${bbox}_${zoom}_${query}` so different searches get separate caches

**Usage:** Works for any search term — Taiwan, Trump, Ukraine, anything.

---

### 2. Story Linker Algorithm — Massive Upgrade
**File:** `worker/story_linker.py`

**Before:**
| Pass | Links | Issue |
|------|-------|--------|
| Geo-Proximity | 523K | `same_event` only if cross-language |
| Keyword Index | 12K | same_country flat 0.50 |
| Semantic (pgvector) | 3K | |
| **Total** | **~600K** | weak quality |

**After — 6 passes:**
| Pass | Type | New? | Links |
|------|------|-------|-------|
| 1. Geo + Cross-Language | `same_city`/`same_event` | improved | — |
| 2. Keyword Index | `same_topic` | — | — |
| 3. Semantic (pgvector) | `semantic_similarity` | — | — |
| **4. Event-Cluster** | `same_event` | 🆕 | **+13K** |
| **5. Entity-Name** | `same_entity` | 🆕 | 0 (test data) |
| **6. Temporal Burst** | `same_event`/`same_city` | 🆕 | blocked by timeout |

**Key improvements:**
- **Pass 4 (Event-Cluster):** 440K+ articles already clustered by news_events system — we weren't linking them! Now harvests those clusters → +13K `same_event` links
- **Pass 1 expanded:** `same_event` now fires for `same event_type + noun overlap ≥ 0.30` (not just cross-language)
- **same_country improved:** recency-weighted (0.45–0.75) instead of flat 0.50
- **Temporal Burst:** 6h window, 50km radius, ST_DWithin indexed — times out on >50K articles

**Current link distribution:**
```
same_city:        523,726 links (avg 0.899)
same_country:      50,094 links (avg 0.500 → improved)
same_event:       26,657 links (⬆️ +13K from event-cluster)
same_topic:       17,269 links (avg 0.897)
semantic_sim:      6,008 links (avg 0.947)
```

---

### 3. Regression Test Suite
**File:** `tests/test_story_links.py` — **40 tests, all passing**

| Class | Tests | What it catches |
|-------|-------|----------------|
| TestSchemaIntegrity | 8 | Missing columns, dropped FKs, orphaned links |
| TestStoryLinker | 5 | Dry-run crashes, invalid shapes, type collapse |
| TestFeedLinksAPI | 8 | Wrong JSON shape, bbox crash, min_weight bypass |
| TestLinkDistribution | 7 | Link type →0, weak scores, duplicate triplets |
| TestFeedEndpointShapes | 6 | 404 endpoints, non-JSON |
| TestSearchLinksIntegration | 1 | Taiwan search filter verification |
| TestDataHealthCanary | 5 | Pipeline stall, zombie data |

**Design principles:**
- Schema-adaptive (information_schema introspection)
- Range assertions (not exact values) — survives data growth
- Graceful skips when passes produce no output
- Real DB/API queries, not mocks

---

## Files Changed (This Session)

```
api/src/routes/feed.ts              # q param for /api/feed/links
public_html/app.js                  # search → links integration + cache invalidation
worker/story_linker.py              # 3 new passes + same_event expansion
worker/links.py                    # same_country recency weighting
tests/test_story_links.py           # 40 regression tests (NEW)
```

---

## API Validation + Deploy

```bash
bash scripts/validate-api.sh --quick   # ✅ All checks passed
systemctl restart xyzo-api            # ✅ Running
```

---

## Known Issues

| Priority | Issue | Notes |
|----------|-------|-------|
| 🟡 | Temporal Burst times out on large sets | Needs spatial+time pre-aggregation |
| 🟡 | nn_article_leaderboard_live empty | Needs nn_infer worker to repopulate |
| 🟡 | article_facts.entities has test data | Entity pass 5 produces 0 links |
| 🟢 | Embeddings pass times out | statement_timeout = 5min too short |

---

*Session notes by Goddess — Linking & Testing Night* 🔗✨

