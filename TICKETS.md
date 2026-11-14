# Xyzo Tickets — Open Work for the Next AI

> **For another AI assistant:** this file lists every actionable task
> we know about, in priority order. Read [`HANDOFF.md`](HANDOFF.md) first
> for project context, constraints, and repo layout. Each ticket below
> has enough detail to act on without re-reading the codebase first.

Tickets fall into three buckets:

- **[BUG]** — confirmed broken in production
- **[FEAT]** — known gap, design already agreed
- **[CLEAN]** — concrete code-quality cleanup

Each ticket lists: **Context**, **Files to touch**, **Acceptance**, **Priority**.

---

## Priority 1 — production-impacting bugs

### T-01 [BUG] xyzo-fetcher.service stalls in auto_categorize (#82)

**Context.** The systemd timer `xyzo-fetcher.timer` runs the 15-min
worker cycle (`worker/run.py` → `worker/auto_categorize.py`). After a
few hours of operation the service hangs mid-cycle with no error in
journald and no DB-side lock held. The fast cycle (`xyzo-fast-fetcher`)
keeps running, so fresh articles still arrive, but `auto_categorize`
stops progressing through the backlog. Hard restart of the service
recovers it temporarily.

**Files to touch.**
- `worker/auto_categorize.py` — main suspect. Look for unbounded DB
  cursor holders, requests sessions without timeouts, or `for r in
  cur.execute(...)` loops that don't yield.
- `worker/dispatcher.py` — secondary. Per `worker/dispatcher.py:198`
  there's an explicit "without running interpreter cleanup" comment
  hinting at lifetime concerns.
- `worker/run.py` — orchestration.

**Repro / capture.**
1. `journalctl -u xyzo-fetcher --since '-1h' -f` while a stall happens.
2. While stalled: `py-spy dump --pid $(pgrep -f worker.run)` if
   available, else `gdb -p` + `py-bt` to capture the stuck frame.
3. Check `SELECT pid, state, query_start, wait_event_type,
   wait_event, query FROM pg_stat_activity WHERE datname='xyzo' AND
   state != 'idle';` to see what DB call the worker is blocked on.
4. Check open file descriptors: `ls -la /proc/$(pgrep -f
   worker.run)/fd | wc -l` — if it climbs unbounded, suspect a leaked
   `requests.Session()` without `with`.

**Likely root causes (ranked).**
1. A `requests.Session()` opened without `with` leaks an HTTP pool;
   after ~hundreds of calls it stops recycling.
2. A deadlock between the AI circuit breaker and the worker pool when
   the AI endpoint returns 503 mid-batch.
3. A `psycopg2` connection in autocommit mode that's holding a tuple
   lock from a long-forgotten cursor.

**Acceptance.** A 24-hour soak with `xyzo-fetcher.timer` active, no
restart, completes at least 90 cycles without a stall. Add a
`requests.Session` context manager + max-keepalive timeout if leaked
HTTP pool is the cause. Add a watchdog `try/except` that re-opens the
DB cursor every N articles.

**Priority.** P0 — blocks the long-tail ingest.

---

### T-02 [BUG] "Opportunity, US" false-positive pin (#17, #18)

**Context.** A pin near a tiny census-designated place called
"Opportunity" in the US (Montana) is being generated for articles
that mention "economic opportunity" or "job opportunity" in unrelated
contexts. The keyword classifier in `worker/auto_categorize.py` is
matching the bare token "opportunity" as a city name.

**Files to touch.**
- `worker/auto_categorize.py` — `classify.city_match()` or equivalent.
- `worker/extract.py` — AI path that emits `location_text`.
- A new backfill migration to fix affected rows.

**Approach.**
1. Add a stopword list of common English words that also happen to be
   US place names ("opportunity", "heaven", "paradise", "freedom",
   "liberty", "prosperity"). The classifier should reject a single
   token that exactly matches a stopword AND has no second token (no
   state/country disambiguator).
2. Require a multi-word match OR a single token + state/country to
   count as a city. Lone-token matches get demoted to `location_text`
   for the AI path to refine.
3. Backfill: identify pins whose `city = 'Opportunity'` AND
   `state != 'MT'`, set `needs_review = true`.

**Acceptance.** No new pins generated for "Opportunity, US" for
articles that don't actually reference the Montana CDP. Existing
misclassified pins re-categorized. Coverage check: legitimate
"Opportunity, MT" references still resolve.

**Priority.** P1 — visible quality regression, single-country scope.

---

### T-03 [BUG] Backend doesn't honor `?before=` cursor in `/api/pins` (#92)

**Context.** The frontend sends `?before=<cursor>` on the second and
later pages of the progressive-pagination loop in search mode
(`public_html/app.js:3652`). The backend `pinsRoute.get("/pins")` in
`api/src/routes/pins.ts` encodes `next_cursor` in the response
(line 136) but never decodes the inbound `before=` parameter — it
ignores it entirely. Result: every page after the first re-fetches
the same first page, so `has_more` is always true and the loop is
either infinite (until `hwCap.maxSafe`) or just dead time.

**Files to touch.**
- `api/src/routes/pins.ts` — decode `before`, add `(created_at, id) <
   cursor_value` to the WHERE clause on both legs of the UNION.
- `api/src/validate.ts` — `ListPinsQuerySchema` already validates
  `before` if it's there; verify and add the schema for the decode
  shape if needed.
- `api/src/cursors.ts` — already has `decodeCursor`; verify it's
  wired.
- `api/tests/pins.test.ts` — add a regression test for "second page
  returns rows strictly older than the cursor".

**Acceptance.**
- `curl "https://xyzo.org/api/pins?limit=5&before=<encoded cursor>"`
  returns up to 5 rows, all with `created_at < cursor.created_at`.
- The frontend's progressive-pagination loop terminates cleanly
  when `has_more` becomes false.
- Schema-only test passes against a hand-shaped Hono app (no live DB
  needed).

**Priority.** P1 — search mode wastes ~5× the necessary DB time per
session.

---

## Priority 2 — known gaps with agreed design

### T-04 [FEAT] Backend auto-widen `/api/pins/map` when sparse (#21)

**Context.** When the user zooms into a region with <N pins (currently
no widening), the canvas renders nearly empty. Server should
automatically widen the bbox in the response, capped at some max
(e.g., continent-scale). Returned `generated_at` should reflect the
post-widen query.

**Files to touch.**
- `api/src/routes/pins.ts` — `/pins/map` handler.
- A small helper `widenIfSparse(rows, requested_bbox, limit)` that:
  1. runs the normal query
  2. if `rows.length < soft_min` (say 10), retries with bbox expanded
     by 1.5×, then 2×, then 3× (still capped at viewport max)
  3. returns rows + a `widened` flag + the actual bbox used

**Acceptance.** When zooming into a region with 0-5 pins, the response
includes more pins (via widening), with a `widened: true` flag and
the actual bbox used. Frontend can show a small notice ("Showing
nearby pins because this area is sparse").

**Priority.** P2 — UX issue, not a correctness bug.

---

### T-05 [FEAT] Frontend keyword fallback for small-city zoom (#20)

**Context.** Companion to T-04. When the server-side widening maxes
out (or returns empty), the frontend should fall back to a keyword
search using the city name from the map's center.

**Files to touch.**
- `public_html/app.js` — `fetchPinsForViewport`'s empty-state branch
  (around the `items.length === 0` site near line 3434-3444).
- `api/src/routes/pins.ts` — `/pins` already supports `?q=`, so just
  add the client-side path.

**Acceptance.** When a viewport returns 0 pins AND widening has been
exhausted, the client retries with `?q=<reverse-geocoded center city>`.
Show a one-time toast explaining what happened.

**Priority.** P2.

---

### T-06 [FEAT] Add 3 RSS feeds for LC Valley region (#22)

**Context.** Coverage gap: Lewis-Clark Valley (ID/WA border, ~70k
population). Three known sources: Lewiston Tribune, KLEW-TV,
Moscow-Pullman Daily News. The discovery flow lives in
`worker/source_discovery.py`; for known sources we just add rows to
`news_sources` and check robots.txt.

**Files to touch.**
- `worker/source_discovery.py` (or directly in DB) — add three rows
  to `news_sources` with correct `feed_url`, `source_country='US'`,
  `tier='community'`.
- Verify robots.txt allows each.
- Schedule them in `worker/feeds.json` if there's a static config.

**Acceptance.** Three new feeds appear in `/api/pins` results within
one worker cycle. None hit a robots.txt disallowed path.

**Priority.** P3.

---

### T-07 [FEAT] Streamed/chunked initial pin response (#13)

**Context.** For very large viewports (zoomed out to world), the
canvas fetch returns up to 2000 pins in one JSON blob. With the
canvas renderer this is fine (single-frame draw), but the JSON parse
+ pin processing adds ~150-300ms latency on slow devices.

**Design choice needed.** NDJSON streaming vs. a single response with
cursor-style pagination that the canvas renderer can start drawing
incrementally. NDJSON is simpler to consume with `ReadableStream`
and matches the canvas renderer's natural "stamp icons as they arrive"
pattern.

**Files to touch.**
- `api/src/routes/pins.ts` — `/pins/map` handler. Set
  `Content-Type: application/x-ndjson`, stream one pin per line.
- `public_html/app.js` — `CanvasPinRenderer.setPins()` accepts
  partial input (already does, since it draws on `_scheduleRedraw`).
- `public_html/app.js` — `fetchPinsForViewport` canvas path: replace
  `await res.json()` with a `ReadableStream` reader + line parser.

**Acceptance.** First pins render within 100ms of fetch start (instead
of waiting for full response). All 2000 pins eventually render in the
same frame.

**Priority.** P3.

---

### T-08 [CLEAN] Add tests for `_strip_cdata` helper (#16)

**Context.** `worker/extract.py` has a `_strip_cdata` helper (added
in task #14 to clean RSS CDATA wrappers from titles/bodies). No
unit tests yet — coverage gap for a small string utility that
matters for ingest correctness.

**Files to touch.**
- `worker/tests/test_strip_cdata.py` — new file. Cover:
  - basic `<![CDATA[...]]>` wrapped string
  - empty CDATA
  - nested or malformed (`<![CDATA[]]` , `CDATA[abc]`)
  - mixed with surrounding whitespace and HTML entities
  - idempotent (already-stripped strings pass through unchanged)

**Acceptance.** 8+ tests pass; coverage of the helper at 100%.

**Priority.** P3 — quick win.

---

## Priority 3 — latent issues / cleanups

### T-09 [CLEAN] Normalize the two pin-shape duality

**Context.** Two pin shapes coexist in the canvas renderer's input:

- **Long (API):** `{ id, source_type, title, location:{lat,lng},
  category, image_url, place_name, ... }`
- **Short (compact cache):** `{ id, st, t, lat, lng, c, pn, img }`

Caught this bug last session: `CanvasPinRenderer` read `p.c` (short
only) and every live-API pin fell through to the "other" icon
(`p.category || p.c || "other"` was the fix). The duality itself is
fragile — every new pin field needs to be remembered in BOTH the API
response and the `savePinsToCache` mapper.

**Files to touch.**
- `public_html/app.js` — `savePinsToCache` (line ~3238) and all
  `pin.c`/`pin.t`/etc. read sites in `CanvasPinRenderer`.
- Pick ONE shape and standardize on it. Recommendation: keep the
  **long shape** in memory everywhere; only the localStorage
  payload uses a shortened form for cache size. Add an explicit
  `toCompact(p)` helper and have only `savePinsToCache` know about
  the short keys.

**Acceptance.** No `pin.c`/`pin.t`/`pin.st` reads anywhere except
inside the cache serialization helper. Add a `console.assert` at
module init that fails fast if a compact key leaks into a render
path.

**Priority.** P2 — latent bug class. The icon fix made this less
urgent but the next new field will re-introduce it.

---

### T-10 [CLEAN] Log silent failures in progressive pagination

**Context.** The progressive-pagination loop in `fetchPinsForViewport`
(around `public_html/app.js:3657`):

```js
const pageRes = await fetch(pageUrl, { signal: ctrl.signal });
if (!pageRes.ok) break;
```

A `!pageRes.ok` (4xx/5xx on a pagination page) silently breaks the
loop. The user sees fewer pins than expected with no indication that
pagination was cut short. `checkServerGuardrails` runs once on the
first page but not on subsequent pages.

**Files to touch.**
- `public_html/app.js` — pagination loop. On `!pageRes.ok`, capture
  the status via the existing `_logFetchError("http", ...)` helper
  and call `hideStaleBanner()` only on success. Don't silently break.

**Acceptance.** Every pagination-page failure appears in
`__xyzoFetchDiagnostics().ring` with kind=`"http"`. The banner does
not appear (only first-page failures do, by design), but the
diagnostic is captured.

**Priority.** P3.

---

### T-11 [CLEAN] Persist image dimensions in localStorage cache

**Context.** `savePinsToCache` saves `image_url` to the compact form
(`img`), but doesn't save the image's natural width/height. On
restore, the popup image is rendered without `width`/`height`
attributes, causing a layout shift when the image loads.

**Files to touch.**
- `public_html/app.js` — `savePinsToCache` to also save `iw`/`ih`.
- `_captureResponseBody` is irrelevant — this is a frontend concern.

**Approach.** Either:
1. On first successful `<img>` load in the popup, save the natural
   size to localStorage; OR
2. (Simpler) Add `width`/`height` attrs to the popup `<img>` from
   `pinData.image_url` and rely on the browser's heuristic once we
   have them. Track with a small in-memory LRU keyed on URL.

**Acceptance.** When restoring cached pins, the popup image reserves
the correct space before the network request completes. No visible
shift.

**Priority.** P3.

---

### T-12 [CLEAN] Document the diagnostic capture pattern

**Context.** Last session we added a diagnostic capture pattern
(`_logFetchError`, `__xyzoFetchDiagnostics`, banner `details`
toggle) — but the pattern is documented only in commit messages.
The next person adding instrumentation should follow the same
shape (kind, ctx object, console group, ring buffer, banner details,
global accessor).

**Files to touch.**
- `AGENTS.md` — add a 5-line subsection "Diagnostic instrumentation
  pattern" describing where to add a new failure site. Reference
  `_logFetchError` as the canonical example.

**Acceptance.** AGENTS.md explains the pattern; future
instrumentation PRs can copy the helper directly.

**Priority.** P3.

---

## Known infrastructure issues (do NOT treat as bugs)

These are pre-existing environment quirks. **Don't burn time
investigating them** unless directly relevant to a ticket.

| Issue | Notes |
|---|---|
| `api/tests/pins.test.ts` truncateAll fails with `must be owner of sequence news_story_links_id_seq` | The `xyzo_app` DB role lacks ownership on auto-created sequences. Run `bun test tests/pins-map.test.ts tests/tags.test.ts` instead — those are schema-only and skip `truncateAll`. |
| `worker/expire_images.py` clears `image_url` after 7 days | Intentional — prevents hotlinking dead publisher URLs. Bump `XYMO_IMAGE_RETENTION_DAYS` to change. See HANDOFF.md §6. |
| `app.js` is ~9000 lines in a single file | Pre-existing no-build constraint. Don't refactor into modules unless asked. |
| `_staleBannerUserDismissed` is module-global | Survives across map states. Pre-existing UX choice. |

---

## When you finish a ticket

1. Update the task in the task list (`TaskUpdate` → `completed`).
2. Commit with a Conventional Commits prefix (`fix:`, `feat:`,
   `chore:`, `docs:`, `test:`) and `Co-Authored-By: Claude <noreply@anthropic.com>`.
3. If the change touches the API or worker, run
   `./scripts/validate-api.sh` + the relevant `bun test` before
   committing.
4. If the change touches the frontend, hard-reload the browser to
   pick up the new `app.js` (no build).
5. If the change deploys, restart `xyzo-api.service`. The frontend
   doesn't need a restart.

---

## Audit 2026-09-06 — new tickets

Generated by the 6-dimension codebase audit. See
[`HANDOFF.md` §10](HANDOFF.md) for the full synthesis (415 items,
131 production-used, 80 orphaned, 76 half-built). T-01..T-12 above
are all closed in commit `ff48a63` (2026-09-06).

### Priority 1 — production-impacting

#### T-13 [BUG] 8 shipped frontend `fetch()` calls target unregistered routes (silent 404s)

**Context.** Confirmed by diffing every `/api/` string in
`public_html` against all 133 registrations:

| Frontend caller | Endpoint called |
|---|---|
| `app.js:2458` | `/api/links/feedback` |
| `app.js:2518,2544` | `/api/links/manual` |
| `app.js:8322,8383` | `/api/locations/search` |
| `app.js:4617` | `/api/pins/spread-positions` (worst — caller swallows failure → `{saved: 0}`) |
| `app.js:12087` | `/api/feedback/bug-report` |
| `nn.html:345,366` | `/api/admin/nn/labels` |
| `ai-status.html:546` | `/api/admin/ai-status/reset` |
| `analytics.js:215` | `/api/search/log` |

Plus 5 more from `public_html/help/index.html`:
`/api/add-source-url`, `/api/analytics/interactions`,
`/api/analytics/problems`, `/api/sources/discover/metrics`,
`/api/sources/rankings` (likely rename — real path is
`/api/analytics/rankings/sources`).

**Files to touch.**
- `public_html/app.js`
- `public_html/help/index.html`
- `public_html/analytics.js`
- `public_html/nn.html`
- `public_html/ai-status.html`
- `api/src/server.ts`

**Acceptance.** Zero fetch targets in `public_html` without a matching
registration. Enforce via a `scripts/check-api-paths.sh` that greps
`public_html` for `/api/` strings and diffs against `server.ts`'s
mounted surface.

---

#### T-14 [BUG] `pins` table has 0 rows yet is the hot path for 8 API routes + 9 worker scripts

**Context.** `api/src/routes/pins.ts` is the largest single API
consumer (510 lines, 6 routes) but `pins` has 0 rows. Either the
`news_articles.published_at → pins` migration flow is broken or the
map endpoint now sources pins from elsewhere (events table?).
Without data, `/api/pins`, `/api/pins/map`, `/api/pins/stats` all
return empty.

**Files to touch.**
- `api/src/routes/pins.ts`
- `worker/cluster.py`
- `worker/extract.py`

**Acceptance.** `pins` count > 0 OR the route file is rewritten to
source from the actual table that has rows, with `HANDOFF.md` §5
updated to match.

---

### Priority 2 — cleanup + half-built

#### T-15 [CLEAN] Resolve CATEGORIES vs EVENT_TYPES divergence in `api/src/validate.ts`

**Context.** CATEGORIES (line 3, 12 values) feeds `CategoryEnum` used
by pin write schemas; EVENT_TYPES (line 88, 14 values) adds `disaster`
and `humanitarian`. `EventTypeEnum` and EVENT_TYPES are imported by
zero routes — the stricter enum is the one actually gating writes. A
worker-assigned `disaster` or `humanitarian` category will fail
validation on POST `/api/admin/pins` and community submit.

**Files to touch.** `api/src/validate.ts`

**Acceptance.** One canonical category list; a test asserting the
worker's emitted event_type values are all accepted by the write-path
schema. Drop the unused exports of `CategoryEnum`, `PrecisionEnum`,
`EventTypeEnum`, EVENT_TYPES (keep the internal consts).

---

#### T-16 [CLEAN] Decide fate of 1,165 lines of consumer-less API routes

**Context.** `events_calendar.ts` (401, 8 routes), `sites_study.ts`
(396, 5 routes), `command.ts` (256, POST `/api/command`),
`story-links.ts` (112, 2 routes) — zero HTTP consumers. `command.ts`
is the clearest cut: `public_html/command-bar.js` is shipped and
loaded (index.html:14) but calls `/api/explore-region`,
`/api/recommend-news`, `/api/ai/chat` directly, never POST
`/api/command`. `sites_study.ts` is documented as deployed/working
in HANDOFF §5 but the UI was never built (worker docstrings at
`legal_scan.py:31` and `site_crawl.py:19` describe the missing UI).

**Files to touch.**
- `api/src/routes/events_calendar.ts`
- `api/src/routes/sites_study.ts`
- `api/src/routes/command.ts`
- `api/src/routes/story-links.ts`
- `api/src/server.ts`

**Acceptance.** Every mounted route has either a consumer or an
explicit `# intentionally API-only` note in `HANDOFF.md`.

---

#### T-17 [BUG] Finish wiring `events_calendar` handler

**Context.** Handler code written (`worker/handlers/events_calendar.py`,
509 lines); schema migrated (`2026-09-06-events-*`) and applied. But
`dispatcher` HANDLERS dict, `kindConfig.ts` JobKind, and worker_kind
enum migration do NOT include `events_calendar`. POST
`/api/events/refresh` does not enqueue polite_poll jobs. Half-finished
feature from 2026-09-06.

**Files to touch.**
- `worker/handlers/events_calendar.py`
- `worker/dispatcher.py`
- `api/src/queue/kindConfig.ts`

**Acceptance.** Register in `dispatcher` HANDLERS + `kindConfig.ts`
JobKind + worker_kind enum migration; wire POST `/api/events/refresh`
to enqueue `polite_poll`; verify a job appears in `discovery_jobs`.

---

#### T-18 [CLEAN] Prune orphaned worker one-shots (~-2000 lines)

**Context.** Dead one-shots with no callers: `_audit_feeds.py` (288,
superseded by `check_feeds.py`), `_compare_rss_vs_web.py` (255,
one-off diagnostic), `backfill_geolocations.py` (240, never wired),
`backfill_images.py` (241, never wired), `build_cities_db.py` (379,
superseded by `load_cities.py` + `migrate_cities.py`),
`build_global_sources.py` (626, no caller), `story_linker.py` (CLI
shell with no caller — live path is
`worker.handlers.links_generate → worker.links.detect_links_batch`),
`add_uncovered_sources.py` (no caller). Keep `expire_images.py`
(HANDOFF §6 documents retention).

**Files to touch.** All listed under `worker/` root.

**Acceptance.** Net -2000 lines; all remaining `worker/` files have
a caller in `run.py`, `dispatcher.py` HANDLERS, or via a documented
API route.

---

#### T-19 [CLEAN] Resolve worker triplicated classifiers + geocode zoo + paywall detector

**Context.** Three sibling classifiers (`classify.py` 281 lines,
`doc_type.py` 110, `classifier.py` 284) — `auto_categorize.py` runs
none of them in prod. Pick `auto_categorize._detect_country_mentions`
(the live one) as winner, OR wire `classifier.py` into `extract.py` /
`site_crawl.url_score`. Four geocode surfaces (`geocode.py` live;
`gazetteer.py` 545, `wiki_geo.py` 615, `granular_geocode.py` 551 all
only self-test imports). Two paywall detectors (`paywall.py`,
`url_validator.py`) — only `url_validator` is wired through
`analytics_inline`.

**Files to touch.**
- `worker/classify.py`, `doc_type.py`, `classifier.py`
- `worker/gazetteer.py`, `wiki_geo.py`, `granular_geocode.py`
- `worker/paywall.py`

**Acceptance.** At most one classifier, one geocode library chain, one
paywall detector per concern; document the winner in HANDOFF §4.

---

#### T-20 [CLEAN] Delete `public_html/feedback-dialog.js` and audit its endpoints

**Context.** Entire module dead. `showFeedbackDialog` (line 7) and
`closeFeedbackDialog` (line 233) never called from `app.js` or any
other frontend file. Replaced in production by `app.js`
`showReportDialog` (line 6931, `/api/analytics/report-quality`) and
`showQuickFlagDialog` (line 6579). However, `/api/pins/{id}/report`
and `/api/pins/{id}/suggest-coords` are NOT called anywhere else —
likely backend-orphaned.

**Files to touch.**
- `public_html/feedback-dialog.js`
- `public_html/index.html`
- `api/src/routes/pins.ts`

**Acceptance.** Either delete `feedback-dialog.js` and its
`<script src=...>` tag in `index.html`, OR rewire `wirePopupActions`
to call `showFeedbackDialog`. Confirm whether
`/api/pins/{id}/report` and `/api/pins/{id}/suggest-coords` can be
deleted from `api/src/routes/pins.ts`.

---

### Priority 3 — debt, drift, doc fixes (one-liners)

Full ticket context lives in the audit synthesis (`HANDOFF.md` §10).
Acceptance for each is the "verify the named artifact exists" check
described in context.

- **T-21 [CLEAN]** Deduplicate the quick-flag surface — `/api/ai/quick-flag` vs `/api/analytics/quick-flag`. *(ai-flag.ts; analytics.ts; app.js)*
- **T-22 [CLEAN]** Verify and finish queue migration for 4 job kinds (`sources_audit`, `links_generate`, `auto_categorize`, `feedback_suggest`). *(sources.ts; links.ts; auto_categorize.ts; feedback.ts)*
- **T-23 [CLEAN]** Fix stale worker docstrings that claim HTTP-driven invocation. *(explore_region.py:11; progress.py:8; legal_scan.py:31; site_crawl.py:19; handlers/community_triage.py:23; learn.py:1208)*
- **T-24 [CLEAN]** Add duplicate-route guard test for the Hono app. *(server.ts)*
- **T-25 [CLEAN]** Remove dead newsium-* deploy units (5 files). *(deploy/newsium-*)*
- **T-26 [CLEAN]** Add `xyzo-nn-infer.{service,timer}` to `deploy/`. *(deploy/xyzo-nn-infer.{service,timer})*
- **T-27 [BUG]** Enable `geolite-update.timer` (currently DISABLED). *(/etc/systemd/system/geolite-update.timer)*
- **T-28 [CLEAN]** Stagger `xyzo-fetcher.timer` off the `:00/:15/:30/:45` herd. *(deploy/xyzo-fetcher.timer)*
- **T-29 [CLEAN]** Collapse or wire up the 17 orphan `nn_*` tables. *(api/src/routes/nn.ts; worker/nn_train.py; worker/nn_infer.py)*
- **T-30 [BUG]** `nn_training_features` storage bloat (1.3M rows, 1306MB, no reader). *(worker/nn_train.py)*
- **T-31 [CLEAN]** Wire or drop `event_*` relational cluster (11 tables, all 0 rows). *(api/src/routes/events_calendar.ts; worker/events_calendar.py)*
- **T-32 [CLEAN]** Close `news_fetch_decisions` (418k rows, 122MB, no reader). *(worker/learn.py; api/src/routes/analytics.ts)*
- **T-33 [BUG]** Verify or re-apply `2026-09-06-coalesce-pins-articles-idx.sql` (old index names still present). *(api/migrations/)*
- **T-34 [CLEAN]** Git-track untracked SQL files (`api/schema*.sql`, `api/migrations/*.sql`, `api/cities_bootstrap*.sql`, `api/cities_schema.sql`).
- **T-35 [CLEAN]** Archive 13 completed one-shot scripts and fix `README.md:562` claim about `backup-website.sh`.
- **T-36 [CLEAN]** Move `worker/test_city_coverage.py` into `worker/tests/`.
- **T-37 [BUG]** Follow-up: 24h soak of `xyzo-fetcher.timer` to satisfy T-01 acceptance (RuntimeMaxSec= + watchdog). *(deploy/xyzo-fetcher.{timer,service}; worker/auto_categorize.py)*
- **T-38 [CLEAN]** Sweep remaining `console.*` usages in `app.js` (~5 violations vs `XLog.*` policy).
- **T-39 [CLEAN]** Decide fate of `ClientPinStore` class (app.js:2858) — wired into popup flow OR deleted (~80 lines).
- **T-40 [CLEAN]** Decide fate of `openLocationExplorerModal` trio (app.js:4267/4331/4342) — wired OR deleted (~80 lines).
- **T-41 [CLEAN]** Verify `_origFetchPins` trio (app.js:2034-2038) — gated by condition OR removed.
- **T-42 [CLEAN]** Annotate or delete stale `2026-08-20-newsium-news-map-design.md` spec (header says "pending re-approval", 17 days old).
- **T-43 [CLEAN]** Resolve half-built `2026-09-07-site-intelligence-nn-and-api` plan (admin endpoints not present).
- **T-44 [CLEAN]** Downscope or write implementation plan for `2026-09-01-quality-engine.md` spec (only P0+P2 shipped).
- **T-45 [CLEAN]** Refresh HANDOFF.md §4, §5, §6, §8 to match audited state (now partially done via §10).
- **T-46 [BUG]** Add watchdog guard to `xyzo-idle-worker.service` (no timer, 10s crash loop is a DOS hazard). *(deploy/xyzo-idle-worker.service)*

### Tickets closed in this audit (T-01..T-12, via commit `ff48a63` 2026-09-06)

| ID | Title | Verification ask |
|---|---|---|
| T-01 | xyzo-fetcher stalls | T-37 captures the follow-up soak |
| T-02 | "Opportunity, US" false-positive | Invoke `worker/backfill_opportunity.py --apply` once and verify zero new pins for bare "Opportunity" |
| T-03 | `?before=` cursor not honored | T-08 latent — also fix `EventListQuerySchema.before` |
| T-04 | Backend auto-widen `/api/pins/map` | Confirmed `pins.ts:262-306` + frontend at `app.js:3757,3766,3778` |
| T-05 | Frontend keyword fallback | Verify the empty-state branch actually fires the `?q=<reverse-geocoded center city>` retry |
| T-06 | 3 LC Valley RSS feeds | Invoke `worker/add_lc_valley_sources.py` once; verify 3 rows in `news_sources` |
| T-07 | Streamed initial pin response | Confirm `Content-Type: application/x-ndjson` and a `ReadableStream` reader in `app.js` |
| T-08 | Tests for `_strip_cdata` | 9 cases covered, exceeds the 8+ acceptance |
| T-09 | Normalize pin-shape duality | Verify with `grep -nE 'p\.(c\|t\|st)\b' public_html/app.js` only `savePinsToCache` and its direct callers remain; CanvasPinRenderer fallback masks, not removes |
| T-10 | Log silent failures in pagination | `app.js:3861` calls `_logFetchError('http', ...)` per ff48a63 |
| T-11 | Persist image dimensions | `app.js:3382-3383` reads `p.image_width \|\| p.iw \|\| dims?.w`; writes `iw/ih` at 3419-3420 |
| T-12 | Document diagnostic capture | `AGENTS.md:106` documents `_logFetchError(kind, context)` with kind examples |
