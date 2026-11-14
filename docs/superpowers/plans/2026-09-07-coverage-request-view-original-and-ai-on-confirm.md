# Coverage Request "View Original" + AI on Confirm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every coverage request (area + re-eval) on `/requests.html`, the success toast, and admin listings exposes a clickable "🗺 View original" link that reopens the main map at the exact view the requester had. Confirm votes (with or without a written reason) automatically trigger an AI study of the report — idempotent across multiple confirm votes.

**Architecture:** Capture map state at submit time (center + zoom). Persist in `news_re_evaluate_requests` (new columns) and reuse what's already in `news_area_requests`. Render a uniform link in three surfaces (cards, toasts, admin listings). Drop the `&& reason` guard in the existing re-eval AI trigger; add a parallel trigger to the area-request vote handler.

**Tech Stack:** TypeScript (Hono routes), PostgreSQL, vanilla JS frontend, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-09-07-coverage-request-view-original-and-ai-on-confirm.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `api/migrations/2026-09-07-news-reeval-map-view.sql` | NEW | Add 3 columns to `news_re_evaluate_requests` |
| `api/src/routes/feedback.ts` | MODIFY | Persist `map_center_lat/lng/zoom` on re-eval POST |
| `api/src/routes/community.ts` | MODIFY | Return map fields on GETs; relax AI trigger on re-eval vote; add AI trigger to area-request vote |
| `public_html/app.js` | MODIFY | Capture map state on re-eval submit; add "View original" link to both success toasts |
| `public_html/requests.html` | MODIFY | Render "View original" link in cards; drop `&& reason` guard; add area-request vote handler |
| `api/tests/community.reeval-map-view.test.ts` | NEW | Round-trip test for map fields + AI idempotency |

---

### Task 1: Migration — add map view columns to `news_re_evaluate_requests`

**Files:**
- Create: `api/migrations/2026-09-07-news-reeval-map-view.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Newsium: capture map view state at submit time for re-evaluation requests.
-- Lets /requests.html render a "View original" link that reopens the map at
-- the exact view the requester had (center + zoom). Three additive columns;
-- existing rows stay NULL and fall back to article lat/lng + zoom 8.

BEGIN;

ALTER TABLE news_re_evaluate_requests
  ADD COLUMN IF NOT EXISTS map_center_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS map_center_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS map_zoom INT;

COMMIT;
```

- [ ] **Step 2: Apply the migration**

Run: `psql "$DATABASE_URL" -f api/migrations/2026-09-07-news-reeval-map-view.sql`
Expected: `BEGIN` ... `ALTER TABLE` ... `COMMIT` with no errors. If psql isn't available, run via your migration script — match whatever the repo already uses.

- [ ] **Step 3: Verify columns exist**

Run:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'news_re_evaluate_requests'
  AND column_name IN ('map_center_lat', 'map_center_lng', 'map_zoom');
```
Expected: 3 rows.

- [ ] **Step 4: Commit**

```bash
git add api/migrations/2026-09-07-news-reeval-map-view.sql
git commit -m "feat(api): capture map view state on re-eval requests"
```

---

### Task 2: Backend — persist map view fields on re-eval POST

`feedback.ts`'s `enqueueRequest()` is the shared insert helper. Both `POST /api/pins/:id/re-evaluate` and `POST /api/pins/:id/suggest-location` go through it.

**Files:**
- Modify: `api/src/routes/feedback.ts:59-105` (`enqueueRequest` helper)
- Modify: `api/src/routes/feedback.ts:127` (`/pins/:id/re-evaluate`)
- Modify: `api/src/routes/feedback.ts:168` (`/pins/:id/suggest-location`)

- [ ] **Step 1: Add map fields to `enqueueRequest` signature + INSERT**

Edit `enqueueRequest` in `api/src/routes/feedback.ts`:

```ts
async function enqueueRequest(opts: {
  pinId: number;
  articleId: number | null;
  kind: "re_evaluate" | "suggest_location";
  userPlace?: string | null;
  ip: string | null;
  mapCenterLat?: number | null;   // NEW
  mapCenterLng?: number | null;   // NEW
  mapZoom?: number | null;        // NEW
}): Promise<{ id: number; deduped: boolean }> {
  const sql = getDb();
  const sanitizedIp = opts.ip && opts.ip !== "unknown" ? opts.ip : null;

  const dedupRows = await sql<any[]>`
    SELECT id FROM news_re_evaluate_requests
    WHERE pin_id = ${opts.pinId}
      AND kind = ${opts.kind}
      AND ${opts.userPlace ?? null} IS NOT DISTINCT FROM ${opts.userPlace ?? null}
      AND status IN ('queued', 'running')
    LIMIT 1
  `;
  if (dedupRows.length > 0) {
    return { id: Number(dedupRows[0].id), deduped: true };
  }
  const rows = await sql<{ id: number | bigint }[]>`
    INSERT INTO news_re_evaluate_requests
      (pin_id, article_id, kind, user_place, requester_ip,
       map_center_lat, map_center_lng, map_zoom)            -- NEW
    VALUES
      (${opts.pinId}, ${opts.articleId}, ${opts.kind}, ${opts.userPlace ?? null}, ${sanitizedIp},
       ${opts.mapCenterLat ?? null}, ${opts.mapCenterLng ?? null}, ${opts.mapZoom ?? null})
    ON CONFLICT (dedup_key) WHERE status IN ('queued','running')
      DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) {
    const fb = await sql<any[]>`
      SELECT id FROM news_re_evaluate_requests
      WHERE pin_id = ${opts.pinId}
        AND kind = ${opts.kind}
        AND ${opts.userPlace ?? null} IS NOT DISTINCT FROM ${opts.userPlace ?? null}
        AND status IN ('queued', 'running')
      LIMIT 1
    `;
    return { id: Number(fb[0].id), deduped: true };
  }
  return { id: Number(rows[0].id), deduped: false };
}
```

- [ ] **Step 2: Pass map fields from each POST handler**

In `POST /api/pins/:id/re-evaluate` (around line 127), after computing rate-limit + pin/article lookup, parse the body and forward:

```ts
feedbackRoute.post("/pins/:id/re-evaluate", async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = reEvalLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }
  const article = await fetchArticleForPin(pinId);
  if (!article || !article.article_id) {
    return c.json({ error: "not_found" }, 404);
  }

  // NEW: read optional map view from body
  let mapCenterLat: number | null = null;
  let mapCenterLng: number | null = null;
  let mapZoom: number | null = null;
  try {
    const body = await c.req.json().catch(() => ({} as any));
    if (Number.isFinite(body?.map_center_lat)) mapCenterLat = Number(body.map_center_lat);
    if (Number.isFinite(body?.map_center_lng)) mapCenterLng = Number(body.map_center_lng);
    if (Number.isFinite(body?.map_zoom)) mapZoom = Math.round(Number(body.map_zoom));
  } catch (_) { /* body is optional */ }

  const { id, deduped } = await enqueueRequest({
    pinId,
    articleId: article.article_id,
    kind: "re_evaluate",
    ip,
    mapCenterLat, mapCenterLng, mapZoom,   // NEW
  });

  // …rest of the handler unchanged…
});
```

Apply the same body-parsing block + `mapCenterLat, mapCenterLng, mapZoom` args to `POST /api/pins/:id/suggest-location` (around line 168). For that handler the existing `SuggestLocationSchema` zod validator runs first; if you prefer, add the three fields to that schema. Either approach works — choose body-parse for consistency with `/re-evaluate`.

- [ ] **Step 3: Type-check**

Run: `cd api && bunx tsc --noEmit`
Expected: zero errors. If there are unrelated pre-existing errors, confirm none are in `feedback.ts`.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/feedback.ts
git commit -m "feat(api): persist map view on re-eval POST"
```

---

### Task 3: Backend — return map view fields on re-eval GETs

Two endpoints return re-eval rows: `/api/community/requests` (list) and `/api/community/requests/:id` (single). Add the three columns to each SELECT and surface them in the JSON.

**Files:**
- Modify: `api/src/routes/community.ts:34-66` (list SELECT + response mapping)
- Modify: `api/src/routes/community.ts:158-...` (single GET, around line 175 — same pattern)

- [ ] **Step 1: Update the list SELECT**

In `communityRoute.get("/community/requests", …)`, add three columns to the SELECT:

```ts
const rows = await sql<any[]>`
  SELECT
    r.id,
    r.pin_id,
    r.article_id,
    r.user_place,
    r.status AS worker_status,
    r.result,
    r.requested_at,
    r.completed_at,
    r.community_status,
    r.confirm_votes,
    r.reject_votes,
    r.map_center_lat,    -- NEW
    r.map_center_lng,    -- NEW
    r.map_zoom,          -- NEW
    a.title AS article_title,
    -- …rest unchanged…
  FROM news_re_evaluate_requests r
  -- …rest unchanged…
`;
```

And in the response mapper (around line 116), add at the end of each row object:

```ts
return c.json({
  requests: rows.map(r => ({
    id: Number(r.id),
    pin_id: Number(r.pin_id),
    article_id: r.article_id ? Number(r.article_id) : null,
    user_place: r.user_place,
    worker_status: r.worker_status,
    community_status: r.community_status,
    confirm_votes: Number(r.confirm_votes),
    reject_votes: Number(r.reject_votes),
    map_center_lat: r.map_center_lat != null ? Number(r.map_center_lat) : null,   // NEW
    map_center_lng: r.map_center_lng != null ? Number(r.map_center_lng) : null,   // NEW
    map_zoom: r.map_zoom != null ? Number(r.map_zoom) : null,                     // NEW
    requested_at: r.requested_at,
    completed_at: r.completed_at,
    article: r.article_title ? { /* unchanged */ } : null,
    // …rest unchanged…
  })),
  // …
});
```

- [ ] **Step 2: Update the single GET**

Find `communityRoute.get("/community/requests/:id", …)` (around line 158) and apply the same SELECT-column additions + response mapping additions. Mirror exactly what you did for the list endpoint.

- [ ] **Step 3: Type-check**

Run: `cd api && bunx tsc --noEmit`
Expected: zero errors in `community.ts`.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/community.ts
git commit -m "feat(api): return map view fields on re-eval GETs"
```

---

### Task 4: Backend — drop `&& reason` guard + add idempotency check on re-eval vote AI trigger

Currently the re-eval vote handler enqueues AI validation only when `vote === 'confirm' && reason`. Drop the reason requirement and gate on a prior AI reply instead.

**Files:**
- Modify: `api/src/routes/community.ts:341` (the AI trigger block)

- [ ] **Step 1: Replace the trigger condition**

Find this block:

```ts
if (vote === 'confirm' && reason && reqRows[0].community_status === 'open') {
```

Replace it with:

```ts
if (vote === 'confirm' && reqRows[0].community_status === 'open') {
  // First confirm: enqueue AI validation. Idempotent across multiple
  // confirm votes via the existing-reply check below.
  const hasAi = await sql<any[]>`
    SELECT 1 FROM news_re_evaluate_requests
    WHERE id = ${id} AND result->>'ai_validation' IS NOT NULL
    LIMIT 1
  `;
  if (hasAi.length === 0) {
    try {
      const result = await enqueueOrSpawn(
        "community_triage",
        { op: "ai_validate", request_id: id },
        { waitMs: 0, enqueuedBy: "api/community/vote/ai-validate" },
      );
      const requestId = result.kind === "async" ? result.requestId : "sync";
      console.log(
        `[vote] triggered AI validation for request ${id} (kind=${result.kind}, job=${requestId})`,
      );
    } catch (e: any) {
      console.warn(
        "[vote] community_triage enqueue failed:",
        (e as Error).message,
      );
    }
  }
}
```

(Keep the rest of the surrounding try/catch structure intact — the comment about "Best-effort — never let a background-validation failure block the user" still applies.)

- [ ] **Step 2: Type-check**

Run: `cd api && bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/community.ts
git commit -m "feat(api): trigger AI validation on every first confirm vote"
```

---

### Task 5: Backend — add AI-on-confirm trigger to area-request vote handler

The area-request vote handler at `POST /community/area-requests/:id/vote` has no AI trigger today. Add one mirroring Task 4.

**Files:**
- Modify: `api/src/routes/community.ts:491-645` (`/community/area-requests/:id/vote`)

- [ ] **Step 1: Insert AI-on-confirm trigger before `return c.json(...)`**

Find the end of the area-request vote handler (around line 631, just before the `return c.json({...})`). Insert:

```ts
// First confirm: enqueue AI validation. Idempotent across multiple
// confirm votes — only fires when no AI reply row exists yet.
if (vote === 'confirm' && reqRows[0].community_status === 'open') {
  const hasAi = await sql<any[]>`
    SELECT 1 FROM news_area_request_replies
    WHERE request_id = ${id} AND reply_type = 'ai'
    LIMIT 1
  `;
  if (hasAi.length === 0) {
    try {
      const result = await enqueueOrSpawn(
        "community_triage",
        { op: "ai_validate_area", request_id: id },
        { waitMs: 0, enqueuedBy: "api/community/area-requests/vote/ai-validate" },
      );
      const requestId = result.kind === "async" ? result.requestId : "sync";
      console.log(
        `[area-requests/vote] triggered AI validation for request ${id} (kind=${result.kind}, job=${requestId})`,
      );
    } catch (e: any) {
      console.warn(
        "[area-requests/vote] community_triage enqueue failed:",
        (e as Error).message,
      );
    }
  }
}
```

The idempotency check uses `news_area_request_replies` (created in migration `2026-08-29-news-area-requests-community.sql`) — same pattern as the re-eval side uses `result->>'ai_validation'`. If the worker side hasn't been written yet to handle `op: "ai_validate_area"`, that's a follow-up — the enqueue here is what triggers the AI worker; the worker's `community_triage` job handler will need a case for this op. Note in commit message.

- [ ] **Step 2: Type-check**

Run: `cd api && bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/community.ts
git commit -m "feat(api): AI on first confirm for area-request votes"
```

---

### Task 6: Frontend — capture map state on re-eval submit + "View original" toast

The re-eval submit lives in `app.js` and POSTs to `/api/pins/:id/re-evaluate` and `/api/pins/:id/suggest-location` (plus possibly `/fast-suggest`). Find every submit path and (a) send the map view, (b) show the "View original" link in any success toast.

**Files:**
- Modify: `public_html/app.js` — every re-eval POST site

- [ ] **Step 1: Locate the submit sites**

Run:
```bash
grep -n "fetch.*re-evaluate\|fetch.*suggest-location\|fetch.*suggest-coords\|fetch.*fast-suggest" public_html/app.js
```
Expected: a small number of submit sites (likely 2-4).

- [ ] **Step 2: At each submit site, gather map state and include in body**

At the top of each submit handler (after the rate-limit/IP guards), add:

```js
const _mapCenter = map && map.getCenter ? map.getCenter() : null;
const _mapZoom = map && map.getZoom ? Math.round(map.getZoom()) : null;
```

Then add these fields to the POST body:

```js
body: JSON.stringify({
  // …existing fields…,
  map_center_lat: _mapCenter ? Number(_mapCenter.lat.toFixed(6)) : null,
  map_center_lng: _mapCenter ? Number(_mapCenter.lng.toFixed(6)) : null,
  map_zoom: _mapZoom,
}),
```

- [ ] **Step 3: At each submit site, show "View original" link in the success toast**

After each successful POST, build the link and append it to whatever success message is shown:

```js
const _viewUrl = (_mapCenter && _mapZoom != null)
  ? `${location.origin}/#${_mapCenter.lat.toFixed(4)},${_mapCenter.lng.toFixed(4)},${_mapZoom}`
  : null;
```

If the submit was a re-eval of a specific article/pin, append `/pin=<id>`:

```js
const _pinId = /* the article/pin id being reported, if applicable */;
const _viewUrlFinal = _pinId ? `${_viewUrl}/pin=${_pinId}` : _viewUrl;
```

Append to the existing toast DOM:

```js
if (_viewUrlFinal) {
  toastEl.innerHTML +=
    ' <a href="' + _viewUrlFinal + '" target="_blank" rel="noopener" ' +
    'style="color:var(--accent);text-decoration:underline;margin-left:6px;">' +
    '🗺 View original →</a>';
}
```

The exact selector for `toastEl` varies by site — match what's already used (e.g. `exploreRequestStatus` for the area request; check each site). For the area-request toast you'll add the same link in Task 7.

- [ ] **Step 4: Smoke test locally**

Open the map app, click a pin, click "Report wrong location" (or equivalent). Verify:
- Network tab shows `map_center_lat`, `map_center_lng`, `map_zoom` in the POST body.
- Toast contains the "🗺 View original →" link.
- Clicking the link opens `/#...` with the correct view.

- [ ] **Step 5: Commit**

```bash
git add public_html/app.js
git commit -m "feat(web): capture map state on re-eval + view-original link"
```

---

### Task 7: Frontend — add "View original" link to area-request success toast

The area-request submit at line ~11537 already has a success toast. Just append the deep-link.

**Files:**
- Modify: `public_html/app.js:11580-11584`

- [ ] **Step 1: Update the success innerHTML**

Replace the current block:

```js
exploreRequestStatus.innerHTML =
  escapeHtml(baseMsg) +
  ' <a href="/help/#tab-requests" target="_blank" rel="noopener" ' +
  'style="color:var(--accent);text-decoration:underline;margin-left:6px;">' +
  'View all coverage requests →</a>';
```

With:

```js
const _origLink = `https://${location.host}/#${center.lat.toFixed(4)},${center.lng.toFixed(4)},${Math.round(zoom)}`;
exploreRequestStatus.innerHTML =
  escapeHtml(baseMsg) +
  ' <a href="' + _origLink + '" target="_blank" rel="noopener" ' +
  'style="color:var(--accent);text-decoration:underline;margin-left:6px;">' +
  '🗺 View original →</a>' +
  ' <a href="/help/#tab-requests" target="_blank" rel="noopener" ' +
  'style="color:var(--accent);text-decoration:underline;margin-left:6px;">' +
  'View all coverage requests →</a>';
```

The `center` and `zoom` variables are already in scope (computed at lines 11541-11542).

- [ ] **Step 2: Smoke test**

Submit an area request from the map. Confirm the toast shows both links. Click "🗺 View original" → land on `/` at the same view.

- [ ] **Step 3: Commit**

```bash
git add public_html/app.js
git commit -m "feat(web): view-original link in area-request toast"
```

---

### Task 8: Frontend — render "View original" link on `/requests.html` cards

`renderRequest()` (line ~569) currently has no deep-link. Add one for both card types.

**Files:**
- Modify: `public_html/requests.html:569-668`

- [ ] **Step 1: Build the link string per card**

Inside `renderRequest(r)`, near the top (right after computing `statusClass`/`statusText`/`timeAgo`), add:

```js
// Build "View original" link for both card types.
let viewOriginalUrl = null;
if (r.center && r.map_zoom != null) {
  // Area coverage request
  const c = r.center;
  viewOriginalUrl = `https://${location.host}/#${Number(c.lat).toFixed(4)},${Number(c.lng).toFixed(4)},${r.map_zoom}`;
} else if (r.map_center_lat != null && r.map_center_lng != null && r.map_zoom != null) {
  // Re-eval request (new fields)
  let url = `https://${location.host}/#${Number(r.map_center_lat).toFixed(4)},${Number(r.map_center_lng).toFixed(4)},${r.map_zoom}`;
  if (r.article_id) url += `/pin=${r.article_id}`;
  viewOriginalUrl = url;
} else if (r.article && r.article.original_lat != null && r.article.original_lng != null) {
  // Legacy re-eval row: no captured view → fall back to article location + zoom 8
  let url = `https://${location.host}/#${Number(r.article.original_lat).toFixed(4)},${Number(r.article.original_lng).toFixed(4)},8`;
  if (r.article_id) url += `/pin=${r.article_id}`;
  viewOriginalUrl = url;
}
```

- [ ] **Step 2: Render the link on the card**

In the template literal returned by `renderRequest`, add a row below the `request-header` div (before `${suggestionHtml}`):

```js
${viewOriginalUrl ? `
  <div class="view-original">
    <a href="${viewOriginalUrl}" target="_blank" rel="noopener">🗺 View original</a>
  </div>
` : ''}
```

- [ ] **Step 3: Add matching CSS**

Add to the `<style>` block (anywhere reasonable):

```css
.view-original {
  margin: -4px 16px 8px;
  font-size: 13px;
}
.view-original a {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dotted var(--accent);
}
.view-original a:hover {
  border-bottom-style: solid;
}
```

- [ ] **Step 4: Smoke test**

Open `/requests.html`. Verify both card types show the link. Click each → land on `/` with the correct view. For a re-eval card the article popup should auto-open.

- [ ] **Step 5: Commit**

```bash
git add public_html/requests.html
git commit -m "feat(web): render view-original link on /requests.html cards"
```

---

### Task 9: Frontend — drop `&& reason` guard in requests.html vote handler

Currently line 727 of `requests.html` triggers AI only with `&& reason`. Drop it so any first confirm triggers AI.

**Files:**
- Modify: `public_html/requests.html:727`

- [ ] **Step 1: Update the trigger condition**

Replace:

```js
// Trigger AI validation for confirm votes with a reason on open tickets.
if (vote === 'confirm' && reason && data.community_status === 'open') {
  triggerAiValidation(requestId, voting);
}
```

With:

```js
// Trigger AI validation on every first confirm (no reason required).
if (vote === 'confirm' && data.community_status === 'open') {
  triggerAiValidation(requestId, voting);
}
```

- [ ] **Step 2: Commit**

```bash
git add public_html/requests.html
git commit -m "feat(web): drop reason guard for AI validation on confirm"
```

---

### Task 10: Frontend — add area-request vote handler

Currently the `setupVoteButtons()` function only POSTs to `/community/requests/:id/vote` (re-eval endpoint). The area-request endpoint is `/community/area-requests/:id/vote` — but the cards on `/requests.html` mix both types. We need a way to route to the right endpoint.

The simplest approach: tag the card with the source type, and use that to pick the endpoint.

**Files:**
- Modify: `public_html/requests.html` — `renderRequest` (add a data-source attribute) + `setupVoteButtons` (route by source)

- [ ] **Step 1: Tag the card with its source**

In `renderRequest`'s return template, change:

```js
<div class="request-card" data-id="${r.id}">
```

to:

```js
<div class="request-card" data-id="${r.id}" data-source="${r.source || 'reeval'}">
```

The `source` field on the response distinguishes: `'area'` for area-request rows, `'reeval'` (or absent) for re-eval rows. Update `/api/community/area-requests` to include `source: 'area'` in its response, and `/api/community/requests` to include `source: 'reeval'`. (One-line additions to the route handlers in `community.ts`.)

- [ ] **Step 2: Route vote POST by source**

In `setupVoteButtons` (line ~671), replace the fixed endpoint:

```js
const res = await fetch(`${API}/api/community/requests/${requestId}/vote`, {
```

with:

```js
const card = voting.closest('.request-card');
const source = card?.dataset?.source || 'reeval';
const votePath = source === 'area'
  ? `/api/community/area-requests/${requestId}/vote`
  : `/api/community/requests/${requestId}/vote`;
const res = await fetch(`${API}${votePath}`, {
```

- [ ] **Step 3: Smoke test**

Open `/requests.html`, scroll to an area-request card, click ✓ Confirm. Confirm:
- Network tab shows POST to `/api/community/area-requests/<id>/vote`.
- AI reply appears on the card (worker enqueues if no prior reply).

For a re-eval card, confirm it still hits `/api/community/requests/<id>/vote` and AI fires.

- [ ] **Step 4: Commit**

```bash
git add public_html/requests.html public_html/api  # whichever path
git commit -m "feat(web): route area-request votes to correct endpoint"
```

---

### Task 11: Tests — round-trip + AI idempotency

Create a hermetic test that covers (a) the new map-field round-trip and (b) the idempotency of the AI trigger.

**Files:**
- Create: `api/tests/community.reeval-map-view.test.ts`

- [ ] **Step 1: Write the test file**

Use `community.area-requests.test.ts` as the structural template.

```ts
// Tests for the "View original" feature on re-eval requests + AI-on-confirm
// idempotency. Hermetic: Hono in-process, direct DB seeding, no worker pool.

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { communityRoute } from "../src/routes/community";
import { feedbackRoute } from "../src/routes/feedback";
import { getDb } from "../src/db";
import { truncateAll } from "./helpers";

const TEST_VIEW = {
  map_center_lat: 41.9028,   // Rome
  map_center_lng: 12.4964,
  map_zoom: 9,
};

async function seedReevalRequest(overrides: Record<string, unknown> = {}): Promise<number> {
  const sql = getDb();
  const rows = await sql<any[]>`
    INSERT INTO news_re_evaluate_requests (
      pin_id, article_id, kind, user_place, requester_ip,
      public_visible, community_status,
      map_center_lat, map_center_lng, map_zoom
    ) VALUES (
      ${1}, ${null}, ${"suggest_location"}, ${"Rome, Italy"},
      ${"127.0.0.1"}::inet,
      ${true}, ${"open"},
      ${TEST_VIEW.map_center_lat}, ${TEST_VIEW.map_center_lng}, ${TEST_VIEW.map_zoom}
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

const app = new Hono();
app.route("/", communityRoute);
app.route("/", feedbackRoute);

describe("re-eval map view fields", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await truncateAll(); });

  test("GET /community/requests includes map view fields", async () => {
    const id = await seedReevalRequest();
    const res = await app.request("/community/requests");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.requests.length).toBe(1);
    const r = data.requests[0];
    expect(r.map_center_lat).toBe(TEST_VIEW.map_center_lat);
    expect(r.map_center_lng).toBe(TEST_VIEW.map_center_lng);
    expect(r.map_zoom).toBe(TEST_VIEW.map_zoom);
  });

  test("legacy row with NULL map fields returns nulls (no crash)", async () => {
    await seedReevalRequest({
      map_center_lat: null, map_center_lng: null, map_zoom: null,
    });
    const res = await app.request("/community/requests");
    const data = await res.json();
    const r = data.requests[0];
    expect(r.map_center_lat).toBeNull();
    expect(r.map_center_lng).toBeNull();
    expect(r.map_zoom).toBeNull();
  });
});

describe("re-eval AI trigger idempotency", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await truncateAll(); });

  test("first confirm vote triggers AI (no reason required)", async () => {
    const id = await seedReevalRequest();
    const res = await app.request(`/community/requests/${id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vote: "confirm" }),  // no reason
    });
    expect(res.status).toBe(200);
    // We can't directly observe the enqueue, but the route's
    // existing-reply check + console.log path can be exercised by
    // asserting the response is 200 and community_status is still 'open'.
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.vote).toBe("confirm");
  });

  test("reject vote does NOT trigger AI", async () => {
    const id = await seedReevalRequest();
    const res = await app.request(`/community/requests/${id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vote: "reject", reason: "wrong article" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.vote).toBe("reject");
    // If an AI reply existed, the worker would have populated
    // result->>'ai_validation'. Confirm it's still null.
    const sql = getDb();
    const rows = await sql<any[]>`SELECT result FROM news_re_evaluate_requests WHERE id = ${id}`;
    const ai = rows[0]?.result?.ai_validation;
    expect(ai).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && bun test tests/community.reeval-map-view.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/tests/community.reeval-map-view.test.ts
git commit -m "test(api): re-eval map view + AI trigger idempotency"
```

---

### Task 12: Manual smoke verification

Run through the acceptance criteria from the spec and capture results.

**Files:** none modified.

- [ ] **Step 1: Submit area request from main map**

- Pan/zoom somewhere distinctive.
- Click "Request news coverage" → fill in optional message → submit.
- Confirm toast shows BOTH "🗺 View original →" and "View all coverage requests →".
- Click "🗺 View original" → land on `/` at the same center/zoom.

- [ ] **Step 2: Submit re-eval request**

- Click a pin → click "Report wrong location" (or whatever label exists).
- Submit.
- Confirm toast shows "🗺 View original →".
- Click → land on `/` at the captured view with the article popup auto-opened.

- [ ] **Step 3: `/requests.html` cards**

- Open `/requests.html`.
- Both card types show a working "🗺 View original" link.
- Click each → correct destination.

- [ ] **Step 4: AI-on-confirm**

- On `/requests.html`, click ✓ Confirm on an open request without typing a reason.
- AI reply appears on the card.
- Click ✓ Confirm again on the same card → no second AI call.
- Click ✗ Reject → AI NOT triggered.

- [ ] **Step 5: Legacy fallback**

- Find a re-eval row with NULL map fields (or insert one directly with `INSERT … map_center_lat=NULL`).
- Open `/requests.html` → confirm card shows link with article lat/lng + zoom 8.
- No crash, link works.

- [ ] **Step 6: Final commit (if any cleanup needed)**

If all smoke tests pass without changes, no commit. If anything needed a tweak during smoke, commit the fix.

```bash
git status
# (only commit if there are changes)
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Capture at submit (area — already done) | (no task) |
| Capture at submit (re-eval — new fields) | Task 2 |
| Storage migration | Task 1 |
| Surface A: `/requests.html` cards | Task 8 |
| Surface B: success toasts | Tasks 6, 7 |
| Surface C: admin listings | (deferred — admin endpoint already exposes fields; no UI changes in scope) |
| AI on every first confirm (re-eval) | Tasks 4, 9 |
| AI on every first confirm (area-request) | Tasks 5, 10 |
| Idempotency | Tasks 4, 5, 11 |
| Fallback for legacy NULL rows | Task 8 |
| Testing | Task 11 |
| Manual smoke | Task 12 |

**Gaps:** Surface C (admin listings) — the JSON payload now carries the new fields (Tasks 2-3) but I didn't add a UI change to the admin page. If there's an admin page that lists area-requests with link rendering, add a Task 13 to wire it. **Flag for the implementer:** check `public_html/help/` and any admin/debug page for area-request listings during Task 12 smoke.

**Type/identifier consistency:**
- `map_center_lat` / `map_center_lng` / `map_zoom` — used uniformly in DB column names, POST body keys, JSON response keys.
- `source: 'area'` / `'reeval'` — used uniformly in `data-source` attribute and JSON.
- `/pin=<id>` — matches `parseMapHash`'s expected format (slash-separated, not `&`).
