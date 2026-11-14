# Discovery Progress Tracking Fix - Final Implementation

## Problem Summary

The AI News Discovery feature was not showing real-time progress updates. Users would see "Starting" and "Worker starting..." but no actual step-by-step progress. The issue was that:

1. The `/api/auto-discover` endpoint was using the legacy direct-spawn approach with numeric IDs
2. The worker was updated to use the queue system with UUIDs and progress writers
3. There was a mismatch: auto-discover spawned workers directly but the worker expected queue-based progress tracking
4. The frontend was polling for numeric IDs but the status endpoint only had data for UUIDs

## Solution

Migrated the `/api/auto-discover` endpoint to use the queue system (`enqueueOrSpawn`) instead of direct spawning, ensuring consistent progress tracking across all discovery paths.

## Changes Made

### 1. Backend: `/api/auto-discover` Endpoint Migration

**File**: `api/src/routes/explore.ts`

**Before**:
- Inserted request into `news_area_requests` table
- Spawned Python worker directly with `spawn()`
- Passed `NEWSIUM_AREA_REQUEST_ID` and `NEWSIUM_DISCOVERY_STATUS_FILE` env vars
- Worker wrote status to JSON files
- Returned numeric `request_id`

**After**:
- Inserts request into `news_area_requests` table (for tracking)
- Uses `enqueueOrSpawn("explore_region", ...)` to queue the job
- Job gets a UUID from the queue system
- Worker uses queue's progress writer for real-time updates
- Returns both `request_id` (numeric) and `job_id` (UUID)
- Also queues a follow-up fetch job after 5 seconds

**Key Code Changes**:
```typescript
// Old: Direct spawn
const child = spawn("/usr/bin/python3.11", ["-m", "worker.explore_region", ...], {
  env: { NEWSIUM_AREA_REQUEST_ID: String(requestId), ... }
});

// New: Queue system
const result = await enqueueOrSpawn(
  "explore_region",
  { bbox, auto_add: true, category_hint: null, request_id: requestId },
  { waitMs: 0, enqueuedBy: "api/auto-discover" }
);

return c.json({
  request_id: requestId,
  job_id: result.requestId, // UUID
  status_url: `/api/discovery-status/${result.requestId}`,
  ...
});
```

### 2. Backend: Simplified `/api/discovery-status/:id` Endpoint

**File**: `api/src/routes/explore.ts`

**Before**:
- Checked if ID was UUID or numeric
- UUID path: queried `discovery_jobs` table
- Numeric path: read JSON status files from disk

**After**:
- Only accepts UUIDs (queue system)
- Returns 404 for non-UUID IDs with clear error message
- Removed legacy file-based status handling

**Key Code Changes**:
```typescript
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

if (!isUuid) {
  return c.json({ error: "not_found", message: "Invalid job ID format. Expected UUID." }, 404);
}

// Only queue path now
const job = await getJob(id);
```

### 3. Frontend: Updated `showAutoDiscoverNotification`

**File**: `public_html/app.js`

**Before**:
```javascript
function showAutoDiscoverNotification(message, requestId) {
  _currentDiscoveryRequestId = requestId;
  pollDiscoveryStatus(requestId);
}
```

**After**:
```javascript
function showAutoDiscoverNotification(message, requestId, jobId) {
  // Use jobId (UUID) for polling if available, otherwise fall back to requestId (numeric)
  _currentDiscoveryRequestId = jobId || requestId;
  pollDiscoveryStatus(_currentDiscoveryRequestId);
}
```

### 4. Frontend: Updated All Call Sites

Updated three locations where `showAutoDiscoverNotification` is called to pass both `request_id` and `job_id`:

1. **Line 7724** (auto-discover from low pin count):
   ```javascript
   showAutoDiscoverNotification(data.message, data.request_id, data.job_id);
   ```

2. **Line 10345** (auto-discover from coverage check):
   ```javascript
   showAutoDiscoverNotification(data.message || 'Discovering news sources...', data.request_id, data.job_id);
   ```

3. **Line 12699** (auto-discover from explore button):
   ```javascript
   showAutoDiscoverNotification(data.message, data.request_id, data.job_id);
   ```

### 5. Worker: Enhanced Progress Updates

**File**: `worker/explore_region.py`

Added granular progress updates throughout the discovery pipeline:

- **City Detection**: Shows local DB check, Nominatim queries, city counts
- **Country Detection**: Shows reverse geocoding progress point-by-point
- **Web Search**: Shows domain probing with percentages and success/failure
- **AI Discovery**: Shows AI query status and results
- **RSS Validation**: Shows validation progress with percentages and results
- **Source Addition**: Shows addition progress with percentages and results

**Example Progress Updates**:
```python
# City detection
progress.update(step="cities", detail="Checking local database for known cities...")
progress.update(step="cities", detail=f"Found {len(db_cities)} cities in local database")

# Web search probing
progress.update(
    step="web_search",
    detail=f"Probing {idx}/{total_domains} ({pct}%): {domain}...",
    counters={"domains_probed": probed_count}
)

# RSS validation
progress.update(
    step="validate",
    detail=f"Validating {idx}/{total} ({pct}%): {name}",
    counters={"sources_validated": len(validated)}
)
```

## How It Works Now

1. **User triggers discovery** (auto-discover or explore button)
2. **Backend creates request** in `news_area_requests` table (numeric ID)
3. **Backend enqueues job** via `enqueueOrSpawn` (gets UUID)
4. **Backend returns both IDs** to frontend: `request_id` and `job_id`
5. **Frontend polls** `/api/discovery-status/{job_id}` (UUID)
6. **Worker writes progress** via queue's progress writer
7. **Status endpoint reads** from `discovery_jobs.state` JSONB column
8. **Frontend displays** real-time step-by-step progress

## Progress Tracking Flow

```
Frontend                Backend                 Queue                   Worker
   |                       |                      |                       |
   |-- POST /auto-discover -->|                    |                       |
   |                       |-- INSERT request ---->|                       |
   |                       |-- enqueueOrSpawn ---->|                       |
   |                       |                      |-- assign UUID -------->|
   |                       |                      |-- dispatch to slot --->|
   |<-- {request_id, job_id} ----------------------|                       |
   |                       |                      |                       |
   |-- GET /discovery-status/{job_id} ----------->|                       |
   |                       |                      |-- read job.state ---->|
   |<-- {current_step, step_detail, progress} ----|                       |
   |                       |                      |                       |
   |                       |                      |        progress.update(step, detail)
   |                       |                      |<-- write to state ----|
   |                       |                      |                       |
   |-- GET /discovery-status/{job_id} ----------->|                       |
   |<-- {current_step, step_detail, progress} ----|                       |
   |                       |                      |                       |
```

## Testing

To test the fix:

1. Open https://xyzo.org
2. Navigate to an area with low coverage (e.g., rural area)
3. Wait for auto-discover to trigger, or click "Explore" button
4. Watch the discovery status panel update in real-time:
   - "Checking local database for known cities..."
   - "Found 3 cities in local database"
   - "Searching the web: {query}..."
   - "Probing 1/5 (20%): example.com..."
   - "✓ example.com — found 2 feed(s)"
   - "Validating 1/10 (10%): Source Name"
   - "✓ Source Name — 150 entries"
   - etc.

## Benefits

1. **Real-time progress**: Users see exactly what's happening at each step
2. **Consistent architecture**: Both explore-region and auto-discover use the same queue system
3. **Better UX**: Granular progress updates make long operations feel responsive
4. **Reliable tracking**: Queue system provides persistence and retry logic
5. **Simplified code**: Removed legacy file-based status handling

## Files Modified

1. `api/src/routes/explore.ts` - Migrated auto-discover to queue system, simplified status endpoint
2. `public_html/app.js` - Updated notification function and call sites to use job_id
3. `public_html/index.html` - Bumped cache version
4. `worker/explore_region.py` - Added granular progress updates throughout pipeline

## Migration Notes

- Old numeric IDs from `news_area_requests` are still created for tracking
- New UUIDs from `discovery_jobs` are used for progress polling
- Both IDs are returned to frontend for backward compatibility
- Legacy file-based status files in `logs/discovery-status/` are no longer used
- The `/api/discovery-cancel/:id` endpoint still handles legacy numeric IDs for cleanup
