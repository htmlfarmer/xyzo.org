# Session Notes — Sep 23, 2026

## Completed

### 1. Category Filter URL Hash Persistence

**Problems Fixed:**
- Category filters (e.g., "technology", "protest") were NOT persisted to URL hash
- Clearing filters did NOT update the URL
- Filter indicator showed wrong count (0 in view) instead of actual filtered count
- "Hot & Latest" tab showed "No stories" on first click

**Root Causes Found & Fixed:**
1. `getMapHash()` didn't include category filters → Added `/cat=${[..._activeCategoryFilters].join(',')}`
2. `parseMapHash()` didn't parse cat= parameter → Added parsing for `cat=cat1,cat2`
3. `restoreMapView()` didn't restore filters from URL → Added restoration logic
4. `clearCategoryFilters()` didn't call `updateUrlHash()` → Added the call
5. `toggleCategoryFilter()` didn't call `updateUrlHash()` → Added the call
6. `updateActiveFilterIndicator()` used total pin count instead of filtered count → Now accepts `filteredCount` parameter
7. Hot & Latest tab only fetched for "your" tab → Changed to `if (name === "your" || name === "hot")`

**URL Format:**
- Before: `/#20.1385,0.0000,2/density=max`
- After: `/#20.1385,0.0000,2/density=max/cat=technology,business,politics`

### 2. Worker Health Monitoring System

**Problem:** Worker crashed at 02:10, leaving 385+ stale fetch leases blocking sources.

**Root Cause:** Worker crashed (OOM or exception), leaving `fetch_in_progress=TRUE` rows that weren't cleared.

**Solution Implemented:**
1. Created `worker/health_monitor.py` - Lightweight health check script
   - Detects stale fetch leases
   - Detects stuck robots.txt checks
   - Detects high-error sources
   - Auto-cleanup option (`--fix`)

2. Created `worker/tests/test_worker_health.py` - 7 regression tests
   - Tests for stale lease cleanup
   - Tests for health monitor functionality
   - Tests for fetch lease system

3. Created cron job for automatic health monitoring (every 5 minutes)

4. Cleared 385 stale leases and restarted worker

**Usage:**
```bash
# Check health
XYZO_DB_DSN="..." python3 -m worker.health_monitor --verbose

# Auto-fix stale leases
XYZO_DB_DSN="..." python3 -m worker.health_monitor --fix

# Cron mode (exit 1 if problems)
XYZO_DB_DSN="..." python3 -m worker.health_monitor --cron
```

### 3. Mexican News Source Expansion

**Problem:** Tijuana and Puerto Vallarta had very limited news coverage (1 source each).

**Sources Added (6 new):**
- El Sol de Tijuana
- Tribuna de Tijuana
- PV Times (Puerto Vallarta)
- El Occidental (Jalisco)
- El Heraldo de Mexico (Jalisco)
- UDG TV (Jalisco)

**Result:** Tijuana now has 4 sources, Puerto Vallarta coverage expanded.

## Test Results

### Frontend Tests (Bun)
```
bun test public_html/tests/category-filter.bun.test.js
13 pass, 0 fail (39 expect() calls)
```

### Worker Tests (pytest)
```
XYZO_DB_DSN="..." python3 -m pytest worker/tests/test_worker_health.py -v
7 pass, 0 fail
```

### API Validation
```
ALL CHECKS PASSED — safe to deploy
```

## Files Changed

### `public_html/app.js`
- `getMapHash()`: Added category filters to URL hash
- `parseMapHash()`: Added parsing for `cat=` parameter
- `restoreMapView()`: Added category filter restoration from URL
- `clearCategoryFilters()`: Now calls `updateUrlHash()`
- `toggleCategoryFilter()`: Now calls `updateUrlHash()`
- `updateActiveFilterIndicator()`: Now accepts `filteredCount` parameter
- Tab switch handler: Now fetches feed for "hot" tab

### `public_html/tests/category-filter.bun.test.js`
- Added 5 new tests for URL persistence

### `worker/health_monitor.py` (NEW)
- Lightweight health monitoring script

### `worker/tests/test_worker_health.py` (NEW)
- 7 regression tests for worker health

### `scripts/worker-health-cron.sh` (NEW)
- Cron script for automatic health monitoring

### `README.md`
- Added testing section
- Added key files documentation

## Pre-existing Test Failures (Not Related to These Fixes)

1. `code-splitting.bun.test.js`: app.js size check (700KB vs 525KB threshold)
2. `mobile-bottom-bar.bun.test.js`: share-btn aria-label check
3. `memory-leaks.test.js`: window is not defined in Bun context
4. `render-mode.test.js`: window is not defined in Bun context

## Known Issues

1. Explore panel "No news" state doesn't explain WHY - could be enhanced with diagnostics
2. Some Mexican sources may have high error counts (needs monitoring)
3. Worker memory usage high (~1GB) - may need optimization
