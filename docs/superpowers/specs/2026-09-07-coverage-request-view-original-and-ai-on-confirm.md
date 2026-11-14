# Coverage Request: View Original Link + AI on Confirm

**Date:** 2026-09-07
**Status:** Design (approved) — ready for plan
**Branch:** `p5/remove-legacy-spawners`

## Problem

Today, when a user submits a coverage request on the Xyzo map, the only feedback they (or anyone reviewing later) get is the success toast and a row on `/requests.html`. The row shows the message and status, but **nothing lets a reviewer see what the requester actually saw**. You have to guess at the geography, the zoom, or which pin was wrong.

Separately, when a community member clicks **✓ Confirm** on a request, the AI only studies the report if the voter also typed a reason. This means most confirm votes silently skip the AI's analysis.

## Goals

1. Every coverage request on `/requests.html` (and the success toast, and admin listings) carries a clickable "🗺 View original" link that opens the main map at the exact view the requester had — including auto-opening the article popup for re-eval requests.
2. Every **✓ Confirm** vote on a coverage request triggers an AI study of the report (idempotent — only the first confirm per request fires the AI).

## Non-Goals

- No changes to admin auth.
- No retroactive AI study of legacy rows.
- No new rate limits (existing per-IP vote rate limit is sufficient).
- No overlay/layer preservation in the deep-link (start minimal: lat/lng/zoom + optional pin).

## Approach

Three layers: capture at submit time, persist with the request, render a link on every surface.

### 1. Capture (at submit time)

| Request type | Already captures | Needs to capture |
|---|---|---|
| **Area coverage** (`recommend-news` → `news_area_requests`) | `bbox_*`, `center_*`, `map_zoom` | — none — |
| **Re-eval** (`news_re_evaluate_requests`) | article_id, lat/lng, message | `map_center_lat`, `map_center_lng`, `map_zoom` (new) |

Frontend change in `public_html/app.js`:
- Re-eval submit handler gathers `map.getCenter()` + `map.getZoom()` and POSTs them as new fields.

### 2. Storage — new migration

File: `api/migrations/2026-09-07-news-reeval-map-view.sql`

```sql
BEGIN;

ALTER TABLE news_re_evaluate_requests
  ADD COLUMN IF NOT EXISTS map_center_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS map_center_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS map_zoom INT;

COMMIT;
```

`news_area_requests` is **unchanged** — it already has `center_*` and `map_zoom`.

### 3. Display — three surfaces

#### Surface A — `public_html/requests.html` cards

In `renderRequest()`, append a link below the title bar:

- **Area request**: `r.bbox`/`r.center`/`r.map_zoom` already exist in the API response. Link → `https://xyzo.org/#<lat>,<lng>,<z>`.
- **Re-eval request**: new fields `map_center_lat/lng/zoom` from the GET response. Link → `https://xyzo.org/#<lat>,<lng>,<z>&pin=<articleId>`.

Fallback for legacy re-eval rows (NULL map fields): use the article's stored lat/lng + zoom 8.

#### Surface B — Success toast in `public_html/app.js` (line ~11580)

The area-request success toast already shows `"View all coverage requests →"`. Add a sibling link immediately before it: `"🗺 View original →"`.

For re-eval requests, add the same link to that handler.

#### Surface C — Admin / debug listings

`/api/recommend-news/recent` and any re-eval admin listing should include the constructed link string in the JSON payload so admin tooling can render it without recomputing.

### 4. AI study on every confirm

**Today:** `requests.html` triggers AI validation only when `vote === 'confirm' && reason && community_status === 'open'`.

**Change:** drop the `&& reason` guard. AI fires on the first confirm regardless. Backend idempotency (existing check on prior `ai_validation` row) ensures it doesn't re-run on subsequent confirms.

**Both vote handlers** must apply this:
- **Re-eval vote handler** (`POST /community/requests/:id/vote` in `community.ts`): drop the existing `&& reason` guard on the AI enqueue (line 341).
- **Area-request vote handler** (`POST /community/area-requests/:id/vote` in `community.ts`): currently has **no** AI trigger at all — add one mirroring the re-eval handler. Run it on the first confirm only, and don't fire it when the row has already been claimed (`applied_at IS NOT NULL`) so the post-validation worker path stays clean.

**Idempotency:** the re-eval handler enqueues unconditionally on the first confirm. To avoid duplicate AI runs when multiple users confirm in quick succession, gate the enqueue on a check for an existing reply row (`SELECT 1 FROM news_re_evaluate_requests WHERE id=$1 AND result->>'ai_validation' IS NOT NULL`). The area-request handler should use a parallel check on `news_area_request_replies` (or a new dedicated table column).

### 5. Link format

| Type | URL |
|---|---|
| Area request | `https://xyzo.org/#<centerLat>,<centerLng>,<mapZoom>` |
| Re-eval request | `https://xyzo.org/#<mapCenterLat>,<mapCenterLng>,<mapZoom>&pin=<articleId>` |

The map app's `parseMapHash()` already handles `lat,lng,zoom`. The `&pin=<id>` suffix needs a small lookup in `app.js`: after `setView`, if `pinId` is present, find the corresponding marker and `marker.openPopup()`. (Pin lookup pattern already exists in `app.js` for the active-pin hash code path.)

## Data Flow

```
USER SUBMITS
─────────────
Map → click "Request coverage"
  app.js gathers { center, zoom, bbox } → POST /api/recommend-news
  → row in news_area_requests
  → toast: "Submitted. 🗺 View original → | View all coverage requests →"

Map → click pin → "Report wrong location"
  app.js gathers { center, zoom, articleId } → POST /api/community/requests
  → row in news_re_evaluate_requests (with map_center_*, map_zoom)
  → toast: "Submitted. 🗺 View original →"


USER REVIEWS
────────────
/requests.html loads
  GET /api/community/area-requests  → rows include bbox, center, map_zoom
  GET /api/community/requests        → rows include map_center_*, map_zoom
  renderRequest() → card with "🗺 View original" link

User clicks ✓ Confirm
  POST /api/community/requests/:id/vote { vote: "confirm" }
  Backend:
    INSERT vote
    IF first confirm AND community_status='open' AND no prior AI reply:
      trigger AI validation (existing endpoint)
      INSERT ai reply row
  Frontend:
    Counter updates
    AI reply appears inline on the card


USER CLICKS VIEW ORIGINAL
─────────────────────────
Browser → /#lat,lng,z&pin=id
  app.js parseMapHash() → { lat, lng, zoom, pinId }
  map.setView([lat, lng], zoom)
  if pinId: findMarker(pinId) → marker.openPopup()
```

## Error Handling

| Case | Behavior |
|---|---|
| Re-eval row with NULL `map_center_lat/lng` | Link uses article lat/lng + zoom 8 |
| Re-eval row with NULL article_id | Drop `&pin=` from link |
| AI validation endpoint errors | Existing path: log + leave `community_status='open'` for retry |
| Multiple rapid confirms | Each vote handler checks for an existing AI reply row before enqueuing → idempotent |
| Vote from old client (no `reason` field) | Treat undefined as missing — no regression |
| Map app loads `&pin=<id>` for missing pin | Silent no-op (popup won't open) |

## Files Changed

| File | Change |
|---|---|
| `api/migrations/2026-09-07-news-reeval-map-view.sql` | **NEW** — add 3 columns |
| `api/src/routes/community.ts` | Accept map fields on re-eval POST + return on GET; drop `&& reason` guard on AI trigger in re-eval vote handler; **add** AI-on-confirm trigger (with idempotency check) to area-request vote handler |
| `public_html/app.js` | Capture map state on re-eval submit; add "View original" link to area-request success toast; add `&pin=<id>` handling in hash parser |
| `public_html/requests.html` | Render "View original" link in `renderRequest()`; drop `&& reason` guard in the existing vote handler; add an area-request vote handler that POSTs to `/community/area-requests/:id/vote` and triggers AI on the first confirm |
| `api/tests/community.reeval-map-view.test.ts` | **NEW** — round-trip test for map fields + AI-on-confirm idempotency |

## Testing

### Automated

- `api/tests/community.reeval-map-view.test.ts`:
  - POST re-eval with `map_center_lat/lng/zoom` → row persists with values
  - POST re-eval without map fields → row persists with NULLs
  - GET `/api/community/requests` → payload includes map fields
  - POST vote `confirm` (no reason) → AI reply row inserted
  - POST vote `confirm` again → no second AI row inserted (idempotent)

### Manual smoke

1. Submit area request from main map → toast shows `🗺 View original →` AND `View all coverage requests →`. Click original link → land on `/` at same center/zoom.
2. Submit re-eval request → toast shows `🗺 View original →`. Click → land on `/` at captured view with article popup open.
3. Open `/requests.html` → both card types show working links.
4. Click ✓ Confirm on open request without reason → AI reply appears.
5. Click ✓ Confirm again → no new AI call (idempotent).
6. Click ✗ Reject → AI NOT triggered.
7. Legacy re-eval row (NULL map fields) → link uses article lat/lng + zoom 8; no crash.

## Rollout

- Migration is additive + idempotent. Safe to apply before code.
- Frontend can deploy independently — old rows simply show fallback behavior.
- No feature flag required.

## Out of Scope

- Showing session_id or IP on the link (privacy).
- Translating / geo-encoding the message field.
- Multi-request AI summarization.
- Preserving map overlays/layers in the deep-link.
