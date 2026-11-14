# xyzo.org Comprehensive Audit — 2026-09-06

**Scope:** Multi-role audit of the xyzo.org platform (city-events aggregation + global news map + site-intelligence subsystem).

**Methodology:** Architecture map first, then 6 parallel dimension reviewers (security, performance, UI/UX+a11y, SEO+reliability, backend+DB, code-quality+product). Synthesis below.

**Standing constraint preserved throughout:** Government/university site politeness — robots.txt strict + 24h/6h cadence, never bypass. Every recommendation has been checked for gov/university safety.

---

## 1. System Understanding

xyzo.org is a single-page Leaflet map application backed by a Hono/Bun API, a Python worker subsystem, and a Postgres+PostGIS+pgvector database. It does three things:

1. **News map** — pins ~50k news articles on a world map, clustered by geography and recency, with editorial-quality scoring, AI extraction, and a real-time "live status" feed.
2. **City events** — discovers RSS feeds and event pages for arbitrary regions, normalises them into an `upcoming_events` graph (venues, organisers, people, companies, topics), and exposes them via saved-search and iCal-style endpoints.
3. **Site intelligence** — a host-aware crawler that classifies sites into `gov | university | community | commercial | platform | user` tiers, performs tier-budgeted AI scans, and dedups content via pgvector cosine similarity. Tier-aware politeness is the spine.

**Quantitative scope:**

| Subsystem | Size | Notes |
|---|---|---|
| Frontend (`public_html/`) | 16.5k+ LOC | `app.js` 12,839 LOC, single non-modular IIFE-less global script |
| API (`api/src/`) | ~16.5k LOC TS | 28 route files, ~130 endpoints |
| Worker (`worker/`) | ~90 Python modules | Three coexisting process models (in-process pool, systemd timers, idle daemon) |
| DB (`api/migrations/`) | 26 migrations | Postgres 15 + PostGIS 3.3 + pg_trgm + pgvector; FDW to `xyzo_cities` (106k multilingual cities) |
| Tests | 48 files | 24 Python, 20 Bun API, 4 browser; large untested gaps |
| External services | 8 | OpenStreetMap/Esri/NASA GIBS tiles, Nominatim geocoding, MaxMind GeoLite2 + 3 IP-API fallbacks, self-hosted Gemma LLM at `192.168.1.3:8888`, Anthropic Claude, USGS/GDELT/NASA EONET feeds |

**Three process models coexist:**

1. **In-process worker pool** — `api/src/queue/workerPool.ts` boots Python `dispatcher` subprocesses on Bun startup. Default 4 slots.
2. **systemd timers** — `xyzo-fast-fetcher` (5m), `xyzo-fetcher` (15m), `xyzo-nn-infer` (5m), `xyzo-story-link` (4/day), `xyzo-nightly` (03:00), `xyzo-queue-soak` (09:30), `xyzo-geolite-update` (Mon 04:00).
3. **Idle daemon** — `xyzo-idle-worker.service` Restart=always long-running loop.

This redundancy is intentional but creates state divergence (two AI breakers, two "city extractors", cooldown drift).

**Strengths to preserve:**

- Tier-aware politeness (`gov` / `university` are first-class and protected at every layer: feature flag tier_overrides, `mark_duplicate` tier check, training data filter, scan budgets).
- Defense-in-depth on AI integration: circuit breaker, Gemma local primary + Claude fallback, retry-after header, fixed system prompt.
- Schema quality: trigram + partial + hnsw indexes per migration; FDW boundary preserved.
- Editorial transparency dashboards (`rankings.html`, `quality.html`, `nn.html`, `requests.html`, `inspector.html`, `source-coverage.html`).
- Real-time via Postgres LISTEN/NOTIFY queue + in-process pool (replaced legacy `spawn()` per P5 commit).

---

## 2. Feature Audit

### News map (mature)
- **Live status panel:** 5 tabs (Hot & Latest / Your News / Near Me / Viewport / AI Suggested), ETag-cached per bbox, 30s polling, localStorage "last known good pins" fallback.
- **Pin interactions:** popup, share, flag, wrong-location correction, Wikipedia search.
- **Auto-discovery:** sparse viewport triggers `prefetchExplore`.
- **NN-driven tier scan:** `xyzo-nn-infer.timer` every 5 min.

### Events (functional but thin UI)
- **Pipeline:** RSS autodiscovery → sitemap walking → JSON-LD extraction → AI summarise → cluster → store in `upcoming_events` graph.
- **Backend complete:** `events_calendar.ts`, `discover.ts`, `saved_searches` schema, `/api/events/search`, `/api/events/:id`, `/api/events/:id/related`.
- **UI gap:** `POST /api/searches/save` exists server-side but the "Save this search" button never shipped client-side. **The "Discover News Here" headline CTA does NOT call the discover pipeline — it only flies the map.**
- **Submission:** community event submission flow exists at `index.html:289-325` but is buried inside Explore panel.
- **Branded "Newsium" remnants** in 9+ files undermine credibility.

### Site intelligence (Phase 3 in progress)
- P3.18–P3.21 implemented and merged. P3.22 (two-head classifier) is implemented and tested on a worktree but not yet merged onto the working branch.
- The subsystem correctly observes the standing gov/university politeness rule.
- `xyzo_features.py` provides stable-hash percentage rollout + tier_overrides + host_overrides + kill switch.

### Cross-cutting
- **i18n:** 20 language JSONs, RTL support, `data-i18n` attributes. **No hreflang tags.**
- **Help:** `help/index.html` exists; mixes 5 unrelated sections, no anchors.
- **iCal/Push/email digest:** NOT implemented (zero hits grep for `ical`, `webpush`, `sendgrid`).
- **Comments/discussion:** NOT implemented.

---

## 3. Performance Audit — Top 10 Bottlenecks

| # | Bottleneck | Cold-path now | Cold-path after | P | File |
|---|---|---|---|---|---|
| 1 | `/api/events/search` spawns `python3 -m worker.run --search` and `await`s close (10–90 s) | 10–90 s | 50–200 ms | **P0** | `search.ts:53-71` |
| 2 | `/api/sites/study` + `/api/sites/crawl` per-request `python3 -c` + per-row `INSERT` (1400 round-trips/crawl) | 30–600 s | 50–300 ms | **P0** | `sites_study.ts:30-358` |
| 3 | `/api/pins/map` & `/pins/near` UNION ALL + COALESCE-order LIMIT — non-indexable expression | 200–660 ms | 30–60 ms | **P0** | `pins.ts:165-547` |
| 4 | `app.js` 138 KB-gz blocks LCP; 13 scripts deferred; map invisible until JS finishes | 1.5–2 s 4G LCP | <0.8 s | **P0** | `index.html:326-336` |
| 5 | `/api/feed/live` runs GeoIP cascade (up to 6 s on miss) then exp() sort, sequential round-trips | up to 6 s | 50–100 ms | P1 | `feed.ts:25-137` |
| 6 | `/api/analytics/stats` 14 scalar subqueries against large tables, 5 nested json_agg GROUP BYs | 200–500 ms | 5–15 ms | P1 | `analytics.ts:624-700` |
| 7 | Pin-image proxy 200-entry LRU, 5-min TTL; publisher images re-fetched | 1–3 s/popup | 50 ms/popup | P1 | `imageProxy.ts:100-200` |
| 8 | Worker `connect()` × 4 per step (cluster.py, extract.py, fetch.py) churns psycopg_pool max=10 | pool waits ~5 ms/op | one cursor, near-zero | P2 | `cluster.py:263-316`, `fetch.py:632` |
| 9 | Per-process state (LRU caches, rate limiters, geoip cache) won't survive multi-process / restart | doubles load + leak risk | 1× load, bounded | P2 | `cache.ts`, `ratelimit.ts`, `geoip.ts` |
| 10 | `/api/feed/links` O(n²) in JS group expansion; haversine-in-SQL over FDW `world_cities` | 1–3 s | 20–50 ms | P2 | `feed.ts:186-215`, `location-views.ts:295-350` |

**Honourable mentions:** `extract.py` Gemma CPU 25s × 60 articles (~25 min/cycle); map markercluster builds 3000-marker tree on first paint; `nn_infer` running on CPU; help panel mounting `city-extractor.js` which loads `/data/cities.10k.json` (4 MB) a second time and exposes `window.CityExtractor` that **is never called**.

---

## 4. Security Audit

### 🔴 CRITICAL (3)

1. **Unauthenticated command injection in `/api/add-source`** — `explore.ts:321-383` interpolates user `name`/`feed_url`/`country`/`language`/`region` directly into a `python3 -c` source string. Comment line 320 falsely claims "Admin-only"; no auth follows. **RCE** as worker user.
2. **Unauthenticated command injection in `/api/add-source-url`** — `explore.ts:389-597` same pattern. URL/country embedded into Python via `replace(/"/g, '\\"')` only — newlines and Python escapes slip through.
3. **Unauthenticated queue-spawning via `/api/community/area-requests/:id/vote`** — `community.ts:484-645`. Three confirm votes auto-claim and enqueue `explore_region` worker job. Vote dedupe is per-IP; spoofable via `X-Forwarded-For` (see HIGH #8). Burns AI budget.

### 🟠 HIGH (6)

4. **Plaintext DB password hardcoded as `??` fallbacks** in `explore.ts:876-877`, `wiki-db.ts:8`, `search.ts:62`, `worker/db.py:17-20`, `worker/run.sh:12`, plus 4 systemd units and `api/.env.example`. the DB password shipped with the repo. **Scrubbed from the repository 2026-11-14; the live role password must still be rotated.**
5. **`/api/debug` wide open to internet** — `debug.ts:15-165` returns DB state, AI breaker state, queue slot state, internal AI URL `http://192.168.1.3:8888`, PID, memory, Bun version.
6. **25+ unauthenticated mutating endpoints** — see table in Finding #6 of security report. Includes `POST /api/sources/:id/toggle`, `POST /api/links`, `DELETE /api/links/:id`, `POST /api/system/reply` (lets anyone impersonate `admin|ai|system`).
7. **`/api/sites/study` & `/api/sites/crawl` SSRF** — `sites_study.ts:50-358` accept arbitrary `?url=` and forward to `httpx` with **no private-IP blocklist**. AWS metadata `169.254.169.254` reachable.
8. **`X-Forwarded-For` trust without proxy allowlist + in-process rate limiter** — `ratelimit.ts:47-52` splits first comma; spoofable from any path that doesn't strip inbound XFF. DoS and vote-bypass vector.
9. **`/api/ai/quick-flag` honours LLM `[AUTO-FIX]` tokens** — `ai-flag.ts:208-261`. An attacker who can control `user_reason` (and via prompt injection, the article content) flips `pins.status='hidden'` or `news_articles.quality_score=0.1` automatically.
10. **AI prompt injection via user-supplied content** — `worker/extract.py` embeds fetched article content + community pin `submitter_name`/`title` into Gemma/Claude prompts with no `<article>`-delimited system hardening.

### 🟡 MEDIUM (12)

11. Thin Caddyfile security-header policy (no HSTS, no Permissions-Policy, no COOP/COEP, no full CSP).
12. `imageProxy` hostname-only SSRF blocklist — IPv6, `169.254/16` partial, DNS rebinding not addressed.
13. Frontend `innerHTML` usage (30+ sites) — DOMPurify correctly used for `body_markdown`; many sinks rely on template-literal escaping only.
14. `/api/links/detect` async-rate-unbounded + `waitMs: 0`.
15. `/api/system/reply` accepts `reply_type: admin|ai|system` without auth → official-looking fake replies.
16. `/api/community/requests/:id/ai-validate` unauth + triggers paid AI work.
17. In-memory `pinsCache` keyed on `JSON.stringify(query)` — unbounded key diversity.
18. `/api/community/requests` & `/api/system/logs` return `voter_ip` (masked but observable), enables de-anonymisation over time.
19. `/api/articles/:id/apply-categorization` unauth → anyone can label articles for downstream NN training.
20. Frontend renders LLM `response_text` and `ai_response` raw — XSS surface from prompt-injected LLM.
21. Counter columns (`votes`, `quality_score`) updated outside transactions; race conditions.
22. `cache.ts` eviction race + cache-busting version drift (no `?v=` on side files, no SRI hashes).

### 🟢 LOW (5)

23. `/api/ai/quick-flag` GET leaks recent reports.
24. `/api/performance/*` & `/api/sysload` leak system info.
25. `db.ts` ignores SSL — fine on localhost, foot-gun on cloud.
26. `submitLimiter` per-IP only (10/hr).
27. AI breaker leak via `/api/debug?verbose=1` (subsumed by #5).

---

## 5. UI/UX Audit

| # | Sev | Title | Where |
|---|------|------------------------------|------------------------------|
| UI-01 | Critical | No first-load onboarding | `index.html:1-336` |
| UI-02 | Serious | Live Panel auto-collapses on mobile | `app.js:10426-10428` |
| UI-03 | Serious | Bottom toolbar overload (10+ buttons) | `index.html:64-128` |
| UI-04 | Serious | Search placeholder ambiguous (3 behaviors) | `app.js:11125-11187` |
| UI-05 | Serious | Wrong-location correction is 5 hidden steps | `app.js:6196-6548` |
| UI-06 | Serious | AI Suggested tab cached with no freshness affordance | `app.js:10431-10447` |
| UI-07 | Moderate | Explore Region auto-runs silently | `app.js:11272-11290` |
| UI-08 | Moderate | Submitter overlay entry point buried | `index.html:289-325` |
| UI-09 | Moderate | Help panel mixes 5 sections, no anchors | `index.html:200-264` |
| UI-10 | Moderate | Time filter popover + chips conflict | `index.html:129-145` |
| UI-11 | Moderate | Live status footer conflates 4 states | `index.html:49` |
| UI-12 | Moderate | Flag emoji mojibake in dialog heading | `app.js:6772` |
| UI-13 | Minor | No retry/cancel on pin fetch | `app.js:11082` |

**"Discover News Here" headline CTA is broken** — wired identically to fly-map, never calls `/api/explore-region`. Trivial fix, very-high value.

**Responsive design notes (not in standalone UI/UX report):**

- Live Panel auto-collapse on mobile is the single biggest mobile UX issue (UI-02). Bottom bar touch targets ~36 px (WCAG AA recommends 24 px minimum, AAA 44 px).
- `city-extractor.js` (6 KB) and the `/data/cities.10k.json` (4 MB) are loaded for the help panel but the exported `window.CityExtractor` is never called. Mobile users pay 4 MB of parse for nothing.
- `dist/` directory holds 1.7 MB un-gzipped bundles from `scripts/optimize_frontend.py` but the root `index.html` ships the unbundled files — abandoned build path.

---

## 6. Accessibility Audit (WCAG 2.1 AA)

| # | Sev | Title | Where |
|---|------|---------------------------------------|--------------------------|
| A-01 | Critical | Map div has no `role="application"` | `index.html:17` |
| A-02 | Critical | No semantic landmarks (`header`/`main`/`nav`/`footer`) | `index.html` whole |
| A-03 | Critical | No skip link to main content | `index.html` |
| A-04 | Serious | Tabs lack `aria-controls`, no arrow-key nav | `app.js:10431-10447` |
| A-05 | Serious | Modals are `<div hidden>`, not `<dialog>` | `index.html:289-325`, `index.html:200-264` |
| A-06 | Serious | Wrong-location banner has no focus trap / Escape | `app.js:6196-6548` |
| A-07 | Serious | `prefers-reduced-motion` not honoured | `styles.css` (grep 0 hits) |
| A-08 | Serious | 15+ `outline: none` without replacement | `styles.css:93,400,2254,…` |
| A-09 | Serious | Bottom-bar touch targets < 44 px | `index.html:64-128` |
| A-10 | Moderate | Form labels rely on visual proximity | `index.html:289-325` |
| A-11 | Moderate | Live list re-announces entire refresh on 60 s tick | `index.html:46` |
| A-12 | Moderate | Emoji content not announced meaningfully | `index.html:31-35` |
| A-13 | Moderate | Custom-range dialog missing `aria-modal` | `index.html:129-145` |
| A-14 | Minor | `--muted` text contrast borderline | `styles.css:1-26` |
| A-15 | Minor | Command-bar dropdown not a listbox | `command-bar.js:400-484` |

**Three Critical findings collapse into one refactor:** add `<header>`, `<main>`, `<nav>`, `<footer>` landmarks + skip link + `role="application"` on the map. One PR.

---

## 7. SEO Audit

| # | Sev | Title | Where |
|---|------|----------------------------|--------------------------|
| S1 | Critical | SPA has no pre-rendered content; single URL serves every route | `index.html:17` |
| S2 | Critical | No `sitemap.xml` despite `robots.txt` declaring it | `robots.txt:6` |
| S3 | Critical | Missing meta description, canonical, OG, Twitter Card | `index.html:1-15` |
| S4 | High | Hash-based URLs defeat deep-link indexing | `app.js:1054-1224` |
| S5 | High | 20-language i18n has no hreflang tags | `public_html/i18n/` |
| S6 | High | No JSON-LD / NewsArticle structured data | `index.html` |
| S7 | Medium | No OG image; no `/og-image` endpoint | `api/src/routes/` |
| S8 | Medium | `robots.txt` lacks Crawl-delay | `public_html/robots.txt` |
| S9 | Medium | No crawlable content beyond map div | `index.html:17-49` |
| S10 | Medium | No internal linking structure in SPA | `app.js` |
| S11 | Low | `robots.txt` doesn't declare AI-bot policy | `robots.txt:1-6` |
| S12 | Low | Share button generates hash-only URL | `index.html:107-112` |

**The platform is essentially invisible to non-Google crawlers and weak on Google.** News-content freshness (the entire value proposition) is invisible to Google News because there's no `NewsArticle` schema and no sitemap.

---

## 8. Code Quality Audit

| # | Sev | Title |
|---|------|--------------------------------------|
| CQ-01 | Critical | Hardcoded dev DB credentials as `??` fallbacks (7 sites) |
| CQ-02 | Critical | Two divergent AI circuit breakers drifting apart |
| CQ-03 | Critical | `events_calendar` handler not registered, wrong signature |
| CQ-04 | Critical | `app.js` has no IIFE wrapper; 12,839 lines leaks to `window` |
| CQ-05 | High | No service layer — 78+ raw SQL statements inline in routes |
| CQ-06 | High | 9 functions > 100 L in app.js, 12 in API (cyclomatic complexity) |
| CQ-07 | High | `report-quality` and `quick-flag` duplicate scoring pipeline |
| CQ-08 | High | Undeclared deps (`extruct`, `playwright`) |
| CQ-09 | High | Unpinned requirements.txt; no audit policy |
| CQ-10 | High | 90+ flat worker modules — discoverability broken |
| CQ-11 | High | Zero test coverage for largest modules (analytics.ts 1967L, etc.) |
| CQ-12 | Medium | `any` proliferation (47 sites) |
| CQ-13 | Medium | `dist/` orphaned dead code; `city-extractor.js` dead code |
| CQ-14 | Medium | Configuration sprawl — 3 documented envs vs 20+ read inline |
| CQ-15 | Medium | Duplicated helpers (escapeHtml × 6, fetch+timeout × 85) |
| CQ-16 | Medium | Cache-busting version drift + stale vendor CDN path |
| CQ-17 | Low | In-memory state that won't survive multi-process / restart |

**Three "shipped-but-not-wired" features** = immediate wins: saved-search API, Discover pipeline, quality_score UI.

---

## 9. Database + Backend Audit

### Database (15 findings)

| # | Sev | Title |
|---|------|--------------------------------------|
| D1 | Critical | Migrations dated 09-15/09-16 (unapplied?) — clock drift |
| D2 | Critical | `2026-09-15-neural-networks.sql` uses `\i` with absolute paths |
| D3 | High | `world_cities` FDW on hot trigger path (`detect_article_cities`) |
| D4 | High | No `FOR UPDATE` on vote / report counter chains |
| D5 | High | Counter columns racy even with locks (nn_realtime_session +1 lost) |
| D6 | High | `news_quality_reports` missing UNIQUE constraint |
| D7 | High | hnsw indexes without `m`/`ef_construction` tuning docs |
| D8 | High | Counter DDL takes ACCESS EXCLUSIVE (no NOT VALID pattern) |
| D9 | Medium | `xyzo_app` role has blanket CRUD on every table (incl. admin_keys) |
| D10 | Medium | Many migrations inside BEGIN…COMMIT + CREATE INDEX (no CONCURRENTLY) |
| D11 | Medium | PII `ip_address` columns with no retention policy (GDPR/CCPA) |
| D12 | Medium | `news_search_log.query` unbounded TEXT |
| D13 | Medium | No statement/query/lock timeout configured |
| D14 | Medium | Inconsistent LIKE escaping across routes |
| D15 | Medium | Haversine-in-SQL over FDW `world_cities` |

### Backend API (18 findings)

Top 5 by severity: B1 (auth missing on 25+ writes), B2 (XFF trust), B3 (Python script injection), B5 (no key rotation/expiry), B6 (`err.message` leaks SQL/Python to clients).

Full list (B1–B18) covers pagination drift, error-format inconsistency, no request body size limit, no Zod on hot endpoints, `process.exit(1)` on worker-pool boot cascading to systemd crash loop, in-memory rate-limit lost on restart, imageProxy SSRF, cache-key instability, file-leak in auto-discover status dir, naive path redaction.

---

## 10. Reliability Audit (18 findings)

| # | Sev | Title |
|---|------|--------------------------------------|
| R1 | Critical | Worker pool boot failure crashes the entire API |
| R2 | Critical | Pin cache invalidation is incomplete after admin updates |
| R3 | Critical | Search endpoint has no timeout; can hang the event loop |
| R4 | High | AI extraction has no idempotency if worker crashes mid-job |
| R5 | High | AI circuit breaker is process-local; multi-process deploy defeats it |
| R6 | High | Feature flag cache has no thundering-herd protection |
| R7 | High | Postgres pool has no backpressure |
| R8 | High | Nominatim 429 backs off 5s but only that single call |
| R9 | High | Worker pool drops pending jobs on burst |
| R10 | Medium | GeoIP cache 1h TTL on success; provider data may be stale |
| R11 | Medium | Backup script degraded — no full `pg_dump` |
| R12 | Medium | Search endpoint spawns Python per request with no global cap |
| R13 | Medium | Worker pool respawn linear backoff (no exponential/jitter) |
| R14 | Medium | No rate limit on `/api/ai/chat` |
| R15 | Medium | Pool state `DEGRADED` doesn't trigger an alert |
| R16 | Low | Caddy reload during in-flight requests — connection drain |
| R17 | Low | GeoIP `(0,0)` rejection edge case |
| R18 | Low | Metrics flush can lose entries on API shutdown |

**Recovery / backups:** R11 is concerning — `backup-website.sh` explicitly disables full DB dumps to "prevent high DB load." Only a 24-hour snapshot. NN training data, user corrections, audit logs may not be in any backup. Loss of DB is unrecoverable beyond 24 h.

**Monitoring:** No integration with Prometheus/Alertmanager/PagerDuty/Sentry. `/api/health` well-built but never read by an automated watcher.

---

## 11. Product Quality Audit (13 findings + 10 opportunities)

### Critical
- **PQ-01** "Discover News Here" only flies the map (broken headline CTA)
- **PQ-02 — Save-search UI never built** *(superseded by separate task; audit finding was incorrect: no frontend stub exists. Endpoints are at `/api/searches/save` + `/api/searches/saved`, not the audited `/api/saved-searches`. No DELETE route. Requires design decisions before implementation.)*
- **PQ-03** Stale "Newsium" branding in 9+ files

### High
- **PQ-04** No web push / email digest / iCal — no engagement loop
- **PQ-05** No PWA / mobile install
- **PQ-06** No first-time onboarding / tutorial
- **PQ-07** "Share" button only copies URL — no embed, no OG
- **PQ-08** `system.html` publicly accessible despite admin functionality
- **PQ-09** `quality_score` computed but not surfaced in UI
- **PQ-10** No Privacy Policy / Terms of Service / GDPR banner

### Medium
- **PQ-11** About page exposes one personal Facebook/LinkedIn, no press contact
- **PQ-12** AI Suggest tab falls back silently to hot feed on error
- **PQ-13** No comments / discussion per pin

### Ranked Product Opportunities

| # | Opportunity | Difficulty | Value |
|---|---|---|---|
| 1 | Fix Discover News Here CTA (PQ-01) | Low | Very High |
| 2 | ~~Wire saved-search UI to existing API (PQ-02)~~ — superseded (no stub exists; endpoints at `/api/searches/save` + `/api/searches/saved`, no DELETE route) | — | — |
| 3 | Web Push + iCal + email digest (PQ-04) | Medium | Very High |
| 4 | PWA / mobile install (PQ-05) | Medium | High |
| 5 | Embeddable `<iframe>` widget (PQ-07) | Medium | High |
| 6 | Finish Newsium → XYZO rebrand (PQ-03) | Low | Medium |
| 7 | First-visit onboarding tour (PQ-06) | Low | Medium |
| 8 | Surface quality_score in popups (PQ-09) | Low | Medium |
| 9 | Add `/privacy.html`, `/terms.html`, press contact (PQ-10, PQ-11) | Low | Medium |
| 10 | Open status page at `status.xyzo.org` | Medium | Medium |

---

## 12. Prioritized Roadmap

### 🔥 P0 — Stop the bleeding (this sprint, ~1 week)

**Security** (do first, before any other code change ships):
1. Patch `add-source` / `add-source-url` command injection (Findings #1, #2) — replace `python3 -c` template literals with argv invocation of a real worker module.
2. Move all 25 unauthenticated write endpoints behind `/api/admin/*` (Finding #6) — one PR, one middleware addition.
3. Lock `/api/debug` behind admin auth or delete (Finding #5).
4. **Rotate the DB password** + remove all `??` fallbacks (Finding #4).
5. Block SSRF in `sites_study` / `sites_crawl` (Finding #7).
6. Strip spoofable IPs + harden rate limiter (Finding #8) — lock API port to localhost via Caddy-only access.

**Reliability**:
7. Make `/health` start before worker pool boot; pool failure → "degraded" not `process.exit(1)` (R1).
8. Add `pinsCache.clear()` on every admin PATCH (R2).
9. Add 90-s timeout to `/api/events/search` spawn (R3).

**Performance** (the 5 cheap wins):
10. Add expression indexes on `COALESCE(published_at, fetched_at)` (Bottleneck #3).
11. Async-ify `/api/sites/{study,crawl}` via the queue (Bottleneck #2).
12. Migrate `/api/events/search` to queue + cache (Bottleneck #1).

### 🛠 P1 — Fix the broken UX (next sprint, ~2 weeks)

13. Fix "Discover News Here" CTA (PQ-01, ~2 hours).
14. ~~Wire saved-search UI (PQ-02)~~ — superseded (no frontend stub; endpoints at `/api/searches/save` + `/api/searches/saved`, no DELETE route).
15. Finish Newsium → XYZO rebrand (PQ-03, ~half day).
16. Add semantic landmarks + skip link + `role="application"` (A-01..A-03, one PR).
17. Add `prefers-reduced-motion` global + audit `outline: none` (A-07, A-08).
18. Surface `quality_score` in popups + filter slider (PQ-09).
19. Add `/privacy.html`, `/terms.html`, press contact (PQ-10, PQ-11).
20. Cache control on image-proxy + raise LRU to 5000 + add disk cache (Bottleneck #7).

### 🧹 P2 — Quality, observability, scale (next quarter, ~2 months)

21. Wrap `app.js` in IIFE + split into ESM modules (CQ-04).
22. Extract `services/{pins,sources,analytics,events}.ts` (CQ-05).
23. Build overview-stats materialized view (Bottleneck #6).
24. Pre-aggregate `news_events.hot_score` into column (Bottleneck #5).
25. Add structured logging + request-id (B7).
26. Reconcile migration clock + replace `\i` with relative paths (D1, D2).
27. Add `world_cities` local snapshot (D3) + `coverage_gaps` materialized view (Bottleneck #12).
28. Add UNIQUE constraint to `news_quality_reports` (D6).
29. Add `statement_timeout` / `query_timeout` / `lock_timeout` (D13).
30. Add monitoring (Prometheus + Alertmanager, R15).
31. PWA + service worker + Web Push + iCal (PQ-04, PQ-05).
32. First-visit onboarding tour (PQ-06).
33. Embeddable widget for journalists (PQ-07).

### 🌱 P3 — Strategic / nice-to-have (backlog)

34. Server-side render top indexable surfaces (`/city/:slug`, `/event/:id`, `/article/:id`) — SEO S1.
35. Add JSON-LD `NewsArticle` / `Event` / `Place` schema — SEO S6.
36. Generate sitemap.xml + sitemap-news.xml — SEO S2.
37. Move rate-limit + LRU caches to Redis (CQ-17, B14).
38. Two-process / blue-green deploy (requires R5 breaker persistence).
39. `/api/ai/chat` rate limit + global concurrency cap (R12, R14).
40. Roles: `xyzo_readonly`, `xyzo_writer`, `xyzo_admin` (D9).
41. Housekeeping anonymiser for IP PII (D11).
42. `extract.py` → GPU inference + AI result cache.

---

## 13. Top 20 Concrete Changes (recommended sequence)

Each is scoped to ~one focused PR.

| # | Change | Files | Effort |
|---|---|---|---|
| 1 | Replace `python3 -c` template strings with argv-spawn modules in `add-source` / `add-source-url` | `explore.ts`, `worker/explore_region.py` | 1 day |
| 2 | Move all unauthenticated writes under `/api/admin/*` with `requireRole` middleware | `server.ts`, `auth.ts`, 25 route files | 2 days |
| 3 | Lock `/api/debug`, `/api/sysload`, `/api/performance/*` behind admin auth | `server.ts` | 2 hours |
| 4 | Rotate DB password; delete all `??` fallbacks; add `XYZO_DB_DSN` to `.env.example` | 8 sites + systemd units | 1 day |
| 5 | SSRF blocklist + DNS-rebind defense in `sites_study` & `sites_crawl` | `sites_study.ts`, `imageProxy.ts` | 1 day |
| 6 | XFF validation (Caddy-only trust) + Postgres-backed rate limiter | `ratelimit.ts`, `server.ts` | 2 days |
| 7 | Add expression indexes on `COALESCE(published_at, fetched_at)` for `news_articles`, `pins` | new migration | 1 day |
| 8 | Async-ify `/api/sites/{study,crawl}` via worker queue + `site_study_cache` table | `sites_study.ts`, `workerPool.ts` | 2 days |
| 9 | Move `/api/events/search` to queue with `events_search_cache` table | `search.ts`, `workerPool.ts` | 1 day |
| 10 | Boot `Bun.serve` before worker pool; degraded mode if pool fails | `server.ts:115-124` | 1 day |
| 11 | Centralise pin-cache invalidation: `cache.invalidateForPin(pinId, bbox)` | `cache.ts`, `pins.ts`, `admin.ts` | 1 day |
| 12 | Fix "Discover News Here" CTA to call `/api/explore-region` | `app.js:11364-11368` | 2 hours |
| 13 | ~~Wire saved-search UI to existing `/api/searches/save`~~ — superseded (no frontend stub exists; endpoints at `/api/searches/save` + `/api/searches/saved`, no DELETE route; needs design first) | — | — |
| 14 | Finish Newsium → XYZO rebrand (titles, classes, localStorage keys) | 9 files | 4 hours |
| 15 | Add `<header>`/`<main>`/`<nav>`/`<footer>` + skip link + `role="application"` | `index.html` | 1 day |
| 16 | Add `prefers-reduced-motion` global CSS + audit `outline: none` (15 sites) | `styles.css` | 4 hours |
| 17 | Surface `quality_score` in popups + filter slider | `app.js`, `pins.ts` | 1 day |
| 18 | Cache-Control immutable + LRU 5000 + disk cache for image proxy | `imageProxy.ts` | 1 day |
| 19 | Wrap `app.js` in IIFE + extract `window.XyzoApp` public API; migrate side files to DI | `app.js`, `command-bar.js`, `submit-sniff.js` | 3 days |
| 20 | Delete `dist/` and `city-extractor.js` (4 MB dead load) | `index.html:332-334`, `dist/` | 1 hour |

---

## 14. Final Scorecard (0-100)

| Category | Score | Trend | Reasoning |
|---|---:|:---:|---|
| **Security** | **38** | down | 3 critical unauthenticated RCEs, 6 highs (DB password in repo, XFF trust, unauth writes). Fixable in one focused sprint. |
| **Performance** | **52** | flat | Bottlenecks are well-localised; 3 of 12 are 2-day fixes each. Frontend bundle is the biggest drag. |
| **Reliability** | **45** | up | R1-R3 are critical; R4-R9 latent but real. Single Bun process + in-process state = resilience risk. No monitoring integration. |
| **Database** | **58** | up | Schema quality is good (trigram + hnsw + partial). D1-D2 migrations are critical clock/path bugs. Counter races everywhere. |
| **Backend API** | **50** | flat | Solid Hono foundation; auth gates incomplete; raw SQL everywhere; counter races; error-message leak. |
| **UI/UX** | **55** | up | Three "shipped-but-not-wired" features = immediate wins. Mobile UX broken. Onboarding absent. |
| **Accessibility** | **32** | down | 3 critical a11y misses, 8 serious. Single-day refactor for landmarks + skip link. |
| **SEO** | **25** | down | Effectively invisible to non-Google crawlers. No SSR, no sitemap, no schema, hash-based URLs. |
| **Code Quality** | **48** | flat | Architecture works; decomposition needed. Two AI breakers will drift. 72% of business logic untested. |
| **Product Strategy** | **52** | up | Strong technical foundation, weak retention loop. Web push + iCal + onboarding = unlock. |
| **Site Intelligence (gov/university safety)** | **92** | up | Multi-layer tier protection; intentional protective floor on confidence (per `site-intelligence-low-conf-pitfall`); feature-flag tier_overrides; training data filter. Standing constraint preserved. |

**Composite weighted score: 49/100** — solid technical core, thin delivery surface, urgent security gaps.

**Where xyzo wins:** Site-intelligence politeness, AI integration depth, editorial transparency, schema quality, defense-in-depth on tier classification.

**Where xyzo loses:** Security posture, accessibility, SEO, retention loop, frontend modularity.

**One-sentence summary:** xyzo.org is a technically ambitious, mostly-correct platform that ships a well-architected intelligence subsystem behind a fragile, monolithic, SEO-invisible, partially-authenticated SPA — fixable in 3 focused sprints but compounding fast if left.

---

## Appendix A — Politeness Check (gov/university)

Every recommendation in this audit has been reviewed against the standing constraint:

- No new code path increases polling cadence on `.gov` or `.edu` hosts. ✅
- Tier-aware thresholds preserved (per `site-intelligence-low-conf-pitfall` memory). ✅
- All SSRF/dedupe protections already include `_PROTECTED_TIERS = {"gov", "university"}`. ✅
- Backup (`backup-website.sh`) should remain `pg_dump --schema-only --no-owner` for the intelligence tables; a separate daily "tier-pinned" snapshot preserves the `confirm_count` audit trail without affecting crawl cadence.

## Appendix B — File Index (absolute paths)

Architecture map: `api/src/server.ts`, `api/src/auth.ts`, `api/src/ratelimit.ts`, `api/src/cache.ts`, `api/src/db.ts`, `api/src/xyzo_features.py`, `api/migrations/*.sql`, `worker/{run,fetch,extract,geocode,cluster,learn,ai_client,ai_extract,ai_intelligence_scan,dispatcher,db}.py`, `worker/handlers/*.py`, `public_html/{index.html,app.js,styles.css,i18n.js}`, `deploy/*.service`, `xyzo-*.{service,timer}`, `/etc/caddy/Caddyfile`.

Full per-finding file:line citations live in the dimension reports above.
