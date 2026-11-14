# Report Story Bug Fix - Test Documentation

## Bug Summary

**Issue**: Public users could not report stories from pin popups. The per-pin "Report" button was calling `/api/analytics/report-quality` which requires admin/editorial authentication, resulting in 401 Unauthorized errors.

**Root Cause**: The `showReportDialog()` function in `flag-quality.js` was using the wrong endpoint. It should use `/api/analytics/quick-flag` (public) instead of `/api/analytics/report-quality` (admin-only).

## Fix Applied

**File**: `public_html/flag-quality.js` (line 514-522)

**Before**:
```javascript
const res = await fetch("/api/analytics/report-quality", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    article_id: pin.id,  // ❌ Wrong field name
    session_id: sessionId,
    report_type: reportType,
    reason: reason || undefined,
  }),
});
```

**After**:
```javascript
const res = await fetch("/api/analytics/quick-flag", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    input: String(pin.id),  // ✅ Correct field name + string conversion
    session_id: sessionId,
    report_type: reportType,
    reason: reason || undefined,
  }),
});
```

## Test Coverage

### 1. Integration Test: `report-story-integration.test.js`

This test verifies the actual code in `flag-quality.js` to ensure:

- ✅ `showReportDialog` uses `/api/analytics/quick-flag` (not `/api/analytics/report-quality`)
- ✅ Payload includes all required fields: `input`, `report_type`, `session_id`
- ✅ `showQuickFlagDialog` also uses the correct endpoint
- ✅ No admin-only endpoints are called from public-facing code
- ✅ Input field is properly converted to string

**Run the test**:
```bash
node public_html/tests/report-story-integration.test.js
```

### 2. Unit Test: `report-story.test.js`

This test mocks the fetch API and verifies:

- ✅ Report dialog calls the correct public endpoint
- ✅ Not using admin-only endpoint
- ✅ All 11 report types are supported
- ✅ Duplicate report handling (409 response)

**Run the test**:
```bash
node public_html/tests/report-story.test.js
```

### 3. Browser Test

Open `public_html/tests/index.html` in a browser to run all tests interactively.

## API Endpoint Comparison

| Endpoint | Auth Required | Use Case |
|----------|---------------|----------|
| `/api/analytics/quick-flag` | ❌ No | Public users reporting stories |
| `/api/analytics/report-quality` | ✅ Yes (editorial/admin) | Admin triage queue |

## Report Types Supported

Both endpoints support these report types:
- `misleading` - Misleading title or content
- `false_info` - False or inaccurate information
- `spam` - Spam or promotional content
- `outdated` - Outdated or no longer relevant
- `duplicate` - Duplicate of another story
- `low_quality` - Low quality journalism
- `offensive` - Offensive or inappropriate
- `paywall` - Full article requires subscription
- `login_required` - Can't read without an account
- `wrong_location` - Wrong location on map
- `other` - Other issue

## Rate Limiting

- `/api/analytics/quick-flag`: 10 requests per hour per IP
- `/api/analytics/report-quality`: 5 requests per hour per IP (admin)

## Auto-Hide Threshold

Stories are automatically hidden when:
- Total reports ≥ 5, OR
- Serious reports (false_info, misleading, spam) ≥ 3

## Regression Prevention

The integration test (`report-story-integration.test.js`) will catch this bug if it's reintroduced. The test:

1. Reads the actual `flag-quality.js` source code
2. Searches for the `showReportDialog` function
3. Verifies it calls `/api/analytics/quick-flag` (not `/api/analytics/report-quality`)
4. Checks the payload structure matches the API schema

If someone accidentally changes the endpoint back to the admin-only version, the test will fail with:
```
✗ BUG DETECTED: showReportDialog is using /api/analytics/report-quality (admin-only endpoint)
```

## Manual Testing Steps

1. Open the map at https://xyzo.org
2. Click on any pin to open the popup
3. Click the "⚠ Report" button
4. Select a report type (e.g., "Misleading title or content")
5. Optionally add a reason
6. Click "Submit Report"
7. **Expected**: Success message with report count
8. **Before fix**: 401 Unauthorized error

## Files Modified

- `public_html/flag-quality.js` - Fixed endpoint and payload structure
- `public_html/index.html` - Bumped cache-bust version
- `public_html/tests/report-story.test.js` - Added unit tests
- `public_html/tests/report-story-integration.test.js` - Added integration tests

## Deployment Checklist

- [x] Fix applied to `flag-quality.js`
- [x] Cache-bust version updated in `index.html`
- [x] Integration tests pass
- [x] Unit tests pass
- [x] Manual testing completed
- [ ] Deploy to production
- [ ] Verify in production
