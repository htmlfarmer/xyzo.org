# AI News Discovery Progress Tracking Fix

## Problem

The AI News Discovery feature was taking too long and not showing sub-steps in the progress UI. Users would see the main steps (cities, countries, search, discover, validate, add) but not the detailed progress within each step, making it unclear what was happening during long operations.

## Root Cause

The worker was calling `progress.update()` at step boundaries, but:

1. **Long blocking operations** (AI discovery, web search, RSS validation) had no intermediate progress updates
2. **Sub-step details** (which city is being searched, which feed is being validated) weren't being sent to the UI
3. **Progress percentages** were coarse-grained and didn't reflect actual work being done

## Solution

Added granular progress updates throughout the discovery pipeline:

### 1. City Detection (`find_cities_in_bbox`)
- Added `progress` parameter
- Shows "Checking local database for known cities..."
- Shows "Found X cities in local database" or "Local DB lookup failed, querying Nominatim..."
- Shows "Querying Nominatim for city/town locations..."

### 2. Country Detection (`find_countries_in_bbox`)
- Added `progress` parameter
- Shows "Checking local database for countries..."
- Shows "Found X countries in local database" or "Local DB lookup failed, reverse geocoding..."
- Shows "Reverse geocoding point X/5..." for each sample point

### 3. Web Search (`discover_news_sources_via_web`)
- Enhanced probing phase with percentage progress
- Shows "Probing X/Y (Z%): domain.com..."
- Shows "✓ domain.com — found N feed(s)" on success
- Shows "✗ domain.com — no RSS feeds found" on failure
- Added counters: `domains_probed`, `feeds_found`

### 4. AI Discovery (`discover_news_sources_with_ai`)
- Added `progress` and `ctx` parameters
- Shows "Querying AI for RSS sources covering {region}..."
- Shows "AI returned N source suggestions" on success
- Shows "AI returned no sources" or "AI discovery failed: {error}" on failure
- Shows "Using fallback regional sources" when falling back

### 5. RSS Validation Loop
- Added percentage progress: "Validating X/Y (Z%): Source Name"
- Shows "✓ Source Name — N entries" on success
- Shows "✗ Source Name — error message" on failure
- Added counter: `sources_validated`

### 6. Source Addition Loop
- Added percentage progress: "Adding X/Y (Z%): Source Name (Country)"
- Shows "✓ Added Source Name (id=N)" on success
- Shows "→ Skipped Source Name — reason" on skip
- Added counter: `sources_added`

### 7. Existing News Search
- Enhanced breakdown: "Found existing coverage: N articles, N events, N sources"

## Technical Details

### Progress Writer Interface

The `ProgressWriter` interface accepts:
```python
progress.update(
    step="validate",           # Current step name
    detail="Validating 3/10 (30%): BBC News",  # Human-readable detail
    counters={"sources_validated": 3}  # Numeric counters
)
```

### Status Writer Batching

The API's `StatusWriter` batches progress updates:
- Flush interval: 250ms
- Batch threshold: 10 updates
- Terminal events flush immediately

This means progress updates are sent to the frontend every ~250ms during active work, providing smooth real-time feedback.

### Frontend Polling

The frontend polls `/api/discovery-status/:id` every 2 seconds and updates:
- Current step (highlighted in UI)
- Step detail (shown below step title)
- Progress bar (percentage complete)
- Counters (articles fetched, sources added, etc.)
- Recent articles/sources (live marker streaming)

## Files Modified

1. **worker/explore_region.py**
   - `find_cities_in_bbox()`: Added progress parameter and updates
   - `find_countries_in_bbox()`: Added progress parameter and updates
   - `discover_news_sources_via_web()`: Enhanced probing progress
   - `discover_news_sources_with_ai()`: Added progress/ctx parameters and updates
   - `explore_region()`: Updated validation and addition loops with granular progress

2. **public_html/tests/report-story-integration.test.js**
   - Fixed validation script false positive (changed `/api/analytics/` to `analytics`)

## Testing

To test the improved progress tracking:

1. Open the map and navigate to an area with low coverage
2. Click "Explore" in the bottom bar
3. Click "Discover News Here"
4. Watch the progress panel update in real-time with:
   - City detection progress
   - Country identification progress
   - Web search queries and domain probing
   - AI discovery status
   - RSS validation with success/failure for each feed
   - Source addition with success/skip for each source

## Expected Behavior

- **Fast operations** (local DB lookups): Instant completion, minimal progress updates
- **Medium operations** (Nominatim queries): 1-3 seconds, shows query progress
- **Slow operations** (AI discovery): 10-15 seconds, shows "Querying AI..." then result
- **Long operations** (RSS validation): 1-2 seconds per feed, shows each validation result
- **Very long operations** (full discovery): 30-60 seconds total, smooth progress throughout

## Performance Impact

- **Minimal overhead**: Progress updates are lightweight JSON objects
- **Batched writes**: StatusWriter batches updates to avoid DB thrashing
- **No blocking**: Progress updates don't block the main work
- **Network efficient**: Frontend polls every 2s, not every update

## Future Improvements

1. **Streaming progress**: Use Server-Sent Events (SSE) instead of polling for real-time updates
2. **Estimated time remaining**: Calculate ETA based on historical operation durations
3. **Cancellable operations**: Add "Cancel" button to abort long-running discoveries
4. **Progress persistence**: Save partial progress to resume after crashes
5. **Parallel operations**: Run web search and AI discovery in parallel with separate progress streams
