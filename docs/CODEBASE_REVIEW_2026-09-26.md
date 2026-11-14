# XYZO.ORG Full Codebase & Architecture Review — 2026-09-26

Method: 4 parallel deep subsystem reads (API, ingestion, NLP/geo, frontend) + direct verification of every CRITICAL/HIGH claim against source code and the live PostgreSQL database (read-only). Items marked [VERIFIED] were reproduced personally; items marked [reported] come from the subsystem audits with file:line citations but were spot-checked, not each re-run.

Scope inspected: worker/*.py (all ~50 modules), api/src/** (~21k lines TS, all 40 route files), public_html/** (app.js 16,590 lines + all scripts), systemd units + drop-ins, Caddyfile headers, live DB (schema, 30 largest tables, 34 article indexes, pg_stat_statements, pg_stat_user_indexes), repo docs. Not exhaustively inspected: collab/ proto/, audio/video sub-pipelines, worker/nn/ model files, public_html_dev.

---

## 1. SYSTEM MAP (actual, verified)

```
                     ┌ xyzo-fast-fetcher.timer (*/5m, runs ~40-60min → effectively ~1 sweep/h)
                     │ xyzo-fetcher.timer (*/15m) ── run concurrently, same fleet
                     ▼
worker.run ──► fetch.py  ── lease claim (FOR UPDATE SKIP LOCKED, 300s TTL)
   │            ├─ RSS/Atom (feedparser) + JSON (USGS/GDELT/EONET/ReliefWeb) → insert_articles()
   │            ├─ web type → web_scraper.py  ✗ 100% BROKEN since API drift (951 sources, 0 articles)
   │            ├─ dedupe = UNIQUE(url, source_id) — raw exact text, no normalization
   │            └─ notify SSE + optional NLP trigger (best-effort, silently swallowed)
   ▼
auto_categorize.py (drain ≤10k)  cities_text(title+body[:500→2000]) → country/lang gates
   │                              → place_disambiguation watchlist → _source_fallback ladder
   │                              (body scan → wiki_geo → source profile → largest city → capital)
   ▼
extract.py (Gemma via :3011 → llama :8888)  only for auto-cat misses; ai_cache sha256(title|body[:500])
   ▼
geocode.py  Nominatim (no country boost/viewbox) → news_locations + location_id
   │        ✗ upsert_location() NameError → any NEW place name unbindable since Sep 15
   ▼
cluster.py  event := (location_id, event_type, ±6h) — zero text similarity
   ▼
[side pipelines]  nn_infer (16d — semantically broken) │ populate_embeddings (384d MiniLM — GOOD)
   story_linker 6 passes (+PageRank) │ nn_batch_links │ city_story_* ML (31.8M row features table)
   density.py corrective relocations │ learn.py bandit reliability │ trend compute_* ✗ UNSCHEDULED
   ▼
PostGIS/PG ──► Bun+Hono API :3008 (pool max 10) ──► Caddy ──► Leaflet SPA (canvas pins)
```

Divergences from the conceptual model: (1) no central queue for ingestion — the queue/dispatcher exists but the main loop is timer-driven monoliths; (2) "story linking" runs after clustering and is not fed back to pins; (3) trending endpoints read a materialized velocity table that hasn't updated since 2026-09-13 [VERIFIED via agent; table 489 rows]; (4) embeddings exist and are good (384-dim, HNSW) but power only story_linker — geolocation NN writes 2.26M predictions nothing reads.

## 2. KEY NUMBERS (live, measured 2026-09-26 02:00 PDT)

- news_articles: 1,145,979 rows / 7.4 GB / 34 indexes / ~55k inserts/day / 157k seq scans since boot
- pins: 6 rows (community); news_locations: 11,088; news_events: 266,316 active
- status='unlocated': 76,271 │ extracted with location_id NULL: 77,348 (56,378 have coords but never geocoded because geocode requires location_text)
- 24h window: 11,435 articles with FUTURE published_at (4,747 ≥5h ahead) — from the mktime bug
- sources: 4,089 rows, 3,690 active (2,736 rss / 951 web / 3 json). 1,321 active sources with error_count >100.
- language mix (7d): en 46% (155k), es 54k, pt 23k, hr 21.5k(!), id 18k, de 15k, ar 14k, fa 11k; zh/ja not in top-15
- 169 countries have sources; 162 active in last 7 days — breadth is genuinely global; volume is not
- DB objects ≈ 30 GB; disk 88% full (231 GB free); RAM 46 GB, shared_buffers 8 GB, work_mem 32 MB, 8 cores
- unused indexes ≈ 4–5 GB (both FTS GINs 1.29 GB, word_freq GIN ×2 0.78 GB, both spatial GISTs 132 MB, duplicate HNSW 216 MB, csf_story_city_idx 1.6 GB + pkey 889 MB never used)
- git working tree dirty: ~123 modified/untracked files, incl. 10 API route files and app.js — deployment risk (see Bug F/D2)

## 3. TOP CONFIRMED BUGS (each verified in source or reproduced)

### BUG-1 CRITICAL — Every feed timestamp is skewed +7/8 hours
FILE: worker/fetch.py:166 (_entry_published)
PROBLEM: `datetime.fromtimestamp(time.mktime(t), tz=timezone.utc)` — feedparser's `*_parsed` is a UTC struct; `time.mktime` interprets it in LOCAL time. Server TZ = America/Los_Angeles → every RSS `published_at` is stamped 7–8 h in the future.
WHY: misuse of mktime (local) vs calendar.timegm (UTC).
REPRODUCE: `python3 -c "import time; print(time.mktime((2026,9,26,12,0,0,0,0,0))-43200)"` vs `time.timegm(...)`; live proof: 11,435 articles fetched in last 24 h have published_at > now().
IMPACT: freshness ranking inverted vs true recency; `since` filters leak 8 h early; cluster ±6 h window splits syndicated copies of the same event → duplicate events/pins; source_poll_observations newest/oldest poison future rate prediction.
FIX: `calendar.timegm(t)`; then one-time `UPDATE news_articles SET published_at = published_at - interval '8 hours' WHERE published_at > fetched_at` (guarded); set worker session TimeZone=UTC (db.py pool kwargs) to also neutralize naive-date fallbacks.
CONFIDENCE: 100%

### BUG-2 CRITICAL — All 951 'web' sources permanently broken (and wasting ~1/3 of sweep time)
FILE: worker/web_scraper.py:256
PROBLEM: `allowed, delay, _ = _robots.is_allowed(link)` unpacks a tuple, but `RobotsCache.is_allowed` returns a `RobotsVerdict` dataclass (robots.py:320). TypeError raised on the first link of every scrape, caught by the blanket handler (web_scraper.py:276) → returns []. The identical bug was already fixed in fetch.py:828 (comment documents it) — the scraper copy never got the fix.
REPRODUCE: `SELECT count(*) FROM news_sources ns WHERE source_type='web' AND active AND EXISTS(SELECT 1 FROM news_articles a WHERE a.source_id=ns.id LIMIT 1)` → 0 [VERIFIED].
FIX: use verdict object; add a regression test that scrapes a fixture with mocked robots.
NOTE: fixing this without scheduling changes adds ~7–26 h to a sweep (each web source = 1 page + ≤20 article fetches). Pair with per-type scheduling before enabling.
CONFIDENCE: 100%

### BUG-3 CRITICAL — geocode.upsert_location() raises NameError → new city names can never bind
FILE: worker/geocode.py:306-307
PROBLEM: the `with connect() as conn, conn.cursor() as cur:` line was deleted (commit ca20404, Sep 15); body references `cur` → NameError every call.
IMPACT: (a) any article whose location isn't already in news_locations or coord-matched stays `extracted, location_id NULL` and re-hits Nominatim every cycle — permanent loop; (b) the user-facing "Re-evaluate this pin" flow (feedback.ts:117 → re_evaluate.py:181) crashes 100% since Sep 15; (c) audio geocoding dead.
FIX: restore the context-manager line; add an import-time + one-call smoke test.
CONFIDENCE: 100% (visual + git history)

### BUG-4 CRITICAL — Site kill-switch is public and admin-reset is broken
FILE: api/src/routes/shutdown.ts:59-128, :156-158, :191-193, :219-233
PROBLEM: (1) POST /api/shutdown/complaint: unauthenticated, unrate-limited, and exempt from the shutdown gate (server.ts:79 path.includes("/shutdown")); (2) PUT /api/shutdown/active-users is public → attacker drives the denominator → a single complaint trips shutdown; (3) reset/activate compare the raw `x-admin-key` header textually against `admin_keys.key_hash` (bcrypt) — a real admin can never pass, anyone who leaks the hash (DB dump/logs) can. admin_keys also has revoked_at which this path ignores.
FIX: `requireRole`/`adminAuth` from api/src/auth.ts for reset/activate; rate-limit + captcha/trust signal for complaints; move active-users control behind internal secret.
CONFIDENCE: 100%

### BUG-5 CRITICAL — SSRF suite
- api/src/routes/sniff.ts:272-291 — fetches arbitrary user URL, follows redirects, returns first 500 chars of body. Full read oracle. [VERIFIED file; agent-measured]
- api/src/routes/imageProxy.ts:71-95 — literal-host blocklist bypassable (decimal IP, 127.0.0.2, bracketed ::1, nip.io rebinding, redirect hops).
- Second-order: POST /api/sources/add is public (sources.ts:301; feed_url only `z.string().url()` — any scheme/host) and the root-run fetcher retrieves it within a cycle; robots absence = allow (robots.py:353). Internal metadata endpoints reachable; if response parses, title/body render publicly.
FIX: resolve-then-validate (pin IP, reject private/loopback/link-local/ULA), https-only allowlist, no redirects or re-validate each hop; auth-gate sources/add.
CONFIDENCE: 100% (code), high (impact)

### BUG-6 CRITICAL — Unauthenticated content-mutation & process-spawn endpoints
- POST /api/articles/:id/apply-categorization (auto_categorize.ts:136-221): anyone can rewrite location_text/lat/lng/event_type/status of any article → map poisoning.
- POST /api/nn/refresh (nn.ts:628-646) [VERIFIED]: spawns detached /usr/bin/python3.11 per request, no auth, no rate limit → CPU DoS.
- POST /api/credibility/.../compute, search-intel telemetry routes: unbounded public writes; community request approve action (problems.ts:234) unauthenticated.
FIX: adminAuth or session-bound ownership + rate limits on every write path; queue nn/refresh instead of spawning.
CONFIDENCE: 100%

### BUG-7 CRITICAL — Stored/reflected XSS + no script-src CSP
- app.js:7532: `href="${targetUrl}"` unescaped (targetUrl derives from RSS `canonical_url`), and the inline `onclick` escapes only `'` — a `"` in a feed URL injects attributes into every viewer's popup. Same at :7568. Malicious feed = stored XSS for all users who click the pin.
- app.js:11053 (showStatus): renders `msg` via innerHTML whenever it contains `<`; runSearch interpolates raw `q` (11387, 11562) and initSearchFromUrl auto-executes → reflected XSS via `?q=<img src=x onerror=...>` with zero interaction (2647 hash-restore path identical).
- renderExploreResults 15099-15210: source names (web-discovered!), article titles, worker messages → innerHTML unescaped.
- Caddy serves CSP "frame-ancestors 'none'" only (Caddyfile:547) [VERIFIED] — no script-src.
FIX: route ALL feed/user strings through escapeAttr; allowlist http(s): schemes; replace inline onclick with delegated listeners; after that, ship `script-src 'self'`.
CONFIDENCE: 100%

### BUG-8 HIGH — Lease leak on "recent success" skip
FILE: worker/fetch.py:763-770 [VERIFIED in code]
PROBLEM: sources are claimed (fetch_in_progress=TRUE, last_polled_at=now()) by CLAIM_SQL, then post-filtered away for recent success WITHOUT releasing the lease. Live measurement earlier in the session: 1,837 expired-still-flagged rows (~50% of fleet); self-heals via 300s TTL + startup cleanup but starves the other timer and skews last_polled_at-based politeness.
FIX: move the `last_success_at < now()-300s` predicate INTO CLAIM_SQL's WHERE; never claim rows you intend to skip.
CONFIDENCE: 100%

### BUG-9 HIGH — /pins/map: moderation bypass + inverted filter + index-bypassing spatial predicate + no rate limit
FILE: api/src/routes/pins.ts:424-436, 429-430, 397-412 [VERIFIED]
- Missing `a.hidden_at IS NULL` (the /pins list has it at :76) → hidden stories still render on the default map view.
- `source_type` branch pushes `sql\`FALSE\`` into the PINS leg instead of the articles leg → any source_type param empties pins and returns ALL articles regardless of type (logic inverted vs /pins).
- Spatial test casts geography→geometry (`l.geom::geometry && ST_MakeEnvelope(...)`): the only GiST indexes are geography-ops → cannot be used. EXPLAIN-verified parallel seq scan of 1.14 M rows + hash join, ~0.43 s warm. Out-of-range/malformed bbox escalates to full world-scan (isWorldView) with per-request window dedup ≈1.5 s. GET has no rate limiter at all. Cache key omits `light`/`format` → payload-shape cross-contamination between client types.
FIX: geography-native predicate (`ST_Intersects(l.geom, $1::geography)`) or expression GiST on `(geom::geometry)`; reject bad bbox with 400; add hidden_at; mirror /pins leg-disabling; include light/format in key; add limiter; coalesce in-flight identical misses.
CONFIDENCE: 100%

### BUG-10 HIGH — `unlocated` is a black hole; Nominatim 429/5xx treated as permanent misses
FILE: worker/geocode.py:404-410, 739-744 [VERIFIED count: 76,271]
No scheduled job ever resets unlocated→pending; transient rate-limits become terminal. Also: Geocoder (the default parallel path) has no negative cache; legacy run() violates 1 req/s pacing on the success path (geocode.py:801-859); Nominatim is queried without `countrycodes=`/`viewbox`/`accept-language` — the root cause of homonym misplacement (Virginia ZA class of bugs).
FIX: only mark unlocated on decisive 200-with-no-result; keep 429/5xx as retryable; add one-time reset + weekly re-try job; pass country hint from source country / validation context.
CONFIDENCE: high

### BUG-11 HIGH — Event clustering is bucket-matching, not similarity
FILE: worker/cluster.py:69-88 — event := (location_id, event_type, ±6h of occurred_at), zero text/entity checks. 266,316 active events; any two "crime" articles in Jakarta within 6 h merge. config.CLUSTER exists (config.py:127-155) but cluster.py carries a private, already-drifted copy (24-52). The +8h TZ skew (Bug-1) actively splits true duplicates across buckets.
FIX: short-term — after Bug-1 fix, merge events sharing ≥1 entity + cosine of existing 384-d embeddings >0.8 in same city; store event centroid. Long-term — Section 6 model.
CONFIDENCE: high

### BUG-12 HIGH — Frontend cache/deploy integrity
- app.js?v=202609150000 but app.js was edited Sep 25; Caddy serves *.js `Cache-Control: public, max-age=31536000, immutable` ("content-hashed by the build pipeline" — there is no build pipeline). Returning visitors keep stale JS until a human bumps ?v=.
- deploy.sh copies public_html_dev → public_html, but PROD is 2 days NEWER than dev (536 extra app.js lines incl. boot-coordinator fixes). The next `./deploy.sh` silently reverts production [agent-verified diff].
- Working tree has ~123 uncommitted paths [VERIFIED `git status`] — no way to atomically roll back a deploy.
FIX: content-hash filenames or `no-cache` on *.js until then; sync prod→dev immediately; invert deploy.sh to git-based checkout; commit or stash the tree.
CONFIDENCE: 100%

### BUG-13 HIGH — Trending is stale/fake
news_event_velocity: 489 rows, last updated 2026-09-13; producers event_velocity.py / compute_tfidf.py / compute_pmi.py / compute_event_stats.py have NO systemd unit and no callers → /api/insights/trending serves a 13-day-old snapshot. /api/cities/trending counts `fetched_at` → a fetch storm or newly added source registers as a "city trend"; docstring promises >2× acceleration filter the SQL doesn't implement.
CONFIDENCE: high [agent-measured]

### BUG-14 HIGH — Silent-failure machinery around the AI path
- disambiguation_gemma.py:142-144 concatenates raw SSE `data:` chunk JSON instead of delta.content → json.loads always fails → confidence 0.0 → the "ultimate" 27B disambiguation gate (extract.py:335 ≥0.85) never fires, while still burning a second full LLM call per ambiguous article. Its prompt even encodes a wrong prior ("Cali" + US source ⇒ California).
- place_disambiguation.py:1315 `"\mexico\s+city\b"` (non-raw) → re.error crash [REPRODUCED], swallowed by extract.py:344 `except: pass` → watchlist silently skipped for El Paso/Mérida-class inputs.
- ai_cache key = sha256(title|body[:500]) ignores source country (extract.py:229) → wrong provenance of syndicated copies cross-contaminates; garbage from _regex_fallback (B5: "Apple"/"Wells Fargo" pass to Nominatim with confidence 1.0) gets cached forever.
- Circuit breaker open → bypasses the FREE cache and drops source_country from the fallback (extract.py:233-236).
CONFIDENCE: high

### BUG-15 HIGH — Coordinates and location binding can diverge (pins vanish / teleport)
density.py Phase 2b updates extracted_lat/lng but leaves location_id pointing at the old city (density.py:700-707); wiki_geo "spread" writes `location_text = "X (via source: kw)"` and never resets location_id (wiki_geo.py:494-524). Since /pins/map FILTERS by l.geom but RENDERS extracted_lat (pins.ts:430 vs 491), spread pins that move outside their location's bbox silently disappear; re-geocoding later would feed the "(via …)" junk string to Nominatim. Density cluster merge double-counts pins across clusters (density.py:205-208, no `processed` check).
CONFIDENCE: high

### BUG-16-30 (condensed [reported, file:line cited])
16. RateLimiter Map never prunes expired buckets (ratelimit.ts:17-33) — unbounded; missing-XFF clients share one "unknown" bucket; "cleanup" test asserts behavior that doesn't exist.
17. Pin-ID/article-ID space confusion: hide/unhide auto-reactions `UPDATE pins WHERE id=${article_id}` (analytics.ts:1111-1114 ×4) mutate a random unrelated pin; `DELETE … LIMIT 1` invalid PG syntax (analytics.ts:2099) swallowed → reaction removal silently never works.
18. SSE feed: per-client 60s resync broadcasts to ALL clients (O(N²) messages, N queries) + onAbort registered after slow initial await → disconnect during snapshot leaks zombie timers querying DB forever (feed.ts:463-561).
19. NaN→500 systemic: ~20 endpoints Number(query) without isFinite (feed.ts:72, cities.ts:343, performance.ts:21 + unbounded hours, nn.ts:257…) — trivial error spam; perf summary forces full 570k-row metrics scan.
20. IDOR: /api/analytics/user-location returns precise home lat/lng for any session_id, no auth (analytics.ts:713).
21. /api/nn/coverage permanently 500 (joins world_cities.iso_alpha2 — column doesn't exist on the FDW map) [VERIFIED table]; /api/collab all 500 (tables absent); audio/fetch md5 "auth" can never pass; sitemap tags reference missing news_article_tags (swallowed).
22. world_cities is a FOREIGN TABLE (postgres_fdw): /api/cities/near, /api/command fly-to, /api/city-value/*, locations-search top-up pull the full 45k remote table per request — EXPLAIN shows no predicate pushdown.
23. metrics middleware passes cpuTimeMs into the session_id parameter (server.ts:116 vs metrics.ts:49); cpu_time_ms never recorded; news_performance_metrics 570k rows, no retention, never read by public endpoints except admin aggregates.
24. geoip.ts:194 vs :281 — duplicate `isLocal` definitions; the hoisted winner drops the "unknown" guard → external providers queried with literal "unknown"; code tsc would reject ships because no typecheck runs (no lint/typecheck script).
25. Frontend races: openPinPopup retry chains never cancelled → per-pan timer leak + popup re-open loop after any coordinate-spread re-render (app.js:2008-2015, 5700); SSE reopen pile-up (14510); LocationTracker re-POSTs the same idle view every 30s (2509) — inflated location-views dataset (249 MB); Explore panel OPEN auto-adds sources (auto_add:true, 14965) — hidden write from a read action.
26. Functional frontend: "Read more" wiring looks for .read-more but button class is popup-read-btn (7536 vs 8433) → editorial bodies unreachable and the ONLY DOMPurify call is dead; "3d" time filter not in localStorage whitelist → reverts on reload (11985); topics-clear button accumulates one click listener per time-filter change (12834) → N refetches per click; clusters mode builds up to 2,000 DOM markers on mobile despite 500 maxSafe (5669 vs 4011); ~155-line dead pagination branch (5838-5993).
27. Perf hot paths: CanvasPinRenderer._draw calls updateActiveFilterIndicator (O(n) filter + innerHTML write) every animation frame during drag (4621); spreadOverlappingPins runs per streaming 50-pin chunk over the full accumulated array and each group calls CityEngine.citiesNear = O(10k) haversine scan with no spatial index (city-engine.js:456) → millions of trig ops per dense pan; ~11 moveend handlers fire per pan.
28. Ingestion politeness: gov/university 24h/6h floors erased on every failure (fetch.py:688-695) → failing .gov feeds re-polled every ~5 min forever; error_count never decays on success; 0 auto-retirement of never-succeeding sources (25 dead >30d, 1,321 high-error still in rotation); check_sources --fix disables on a single transient timeout and can store an unvalidated redirect target as new feed_url.
29. robots disk cache: rebuilt per host group (~3,500 file parses/cycle), non-atomic whole-file rewrite, two concurrent timers → torn cache = full robots re-fetch crawl-storm; prod runs as root → /root/.xyzo cache, manual runs use ~asher (split-brain). fast_update.py references non-existent fetch.USER_AGENT → mass false error inflation if ever run; XYZO_FETCH_MAX_CONCURRENT_HOSTS drop-in is a DEAD KNOB nothing reads.
30. Env/unit drift: fetch.py reads NEWSIUM_* while AGENTS.md documents XYZO_*; installed units run as root with the DB password world-readable in /etc/systemd/system/ and hardcoded fallbacks in ≥6 worker files (the DB password); deploy/*.service reference /etc/xyzo/xyzo.env which doesn't exist.

## 4. CITY ↔ STORY RELEVANCE — current vs proposed

Current (verified): a strict first-writer-wins chain with silent last-writer overrides (parser coords → cities_text population-rank → fallback ladder → Gemma/regex → Nominatim → density rewrites), recorded only in an overwritable `auto_categorize_method`, with `location_confidence` effectively constant (1.0/0.95). No evidence fusion, no provenance audit, no re-check when a new stronger signal arrives. Population rank == relevance is the core flaw ("Lagos mention inside a Kaduna story wins", cities_text.py:899-914).

Proposed deterministic-first, learn-where-it-pays model (store as scored candidate rows, not in-place field overwrites):

```
CityStoryScore(a, c) = Σ w_k · s_k        (log-odds space, calibrated)
  s_geo   explicit coords: parser > wikidata > mention-with-coords; distance-decayed exp(-d/50km)
  s_ent   entities whose HQ/place ∈ c, IDF-weighted (rare entities weigh more; "Apple" ≈ 0)
  s_txt   city mention salience: title 3× first-para 2× body 1×, ÷ log(total city mentions) — kills mention spam
  s_src   source prior = log(pop_c / pop_country) + source↔city affinity (learn.py ALREADY computes news_source_city_affinity — unused by placement!)
  s_evt   sibling-event evidence: centroid of event's other articles (after TZ fix)
  s_tmp   temporal plausibility: breaking local event vs foreign wire story
  s_xc    hard veto: cross-country contradiction (keep current gate; fix Bug-14 crashers first)
learned: only the weights w_k + a small logistic stack over the deterministic features, trained on
  nn_user_corrections (grow it first — Re-evaluate has been dead since Sep 15) + editorial corpus.
  Everything else stays deterministic and explainable. The 384-d sentence embedding gives a free
  s_sem = cos(embed(a), centroid(c)) with the existing HNSW infra — no LLM call needed.
```
Decision: argmax with margin rule (winner must beat runner-up by δ, else `needs_review` — add that status). Provenance: append-only `location_assignments(article_id, city_id, score_breakdown jsonb, method, decided_at)` — replaces fighting field overwrites. This is also exactly the `city_story_*` tables' premise (31.8 M features!) — the ML pipeline exists but its outputs never feed placement; wire city_story_ml predictions into the decision instead of building anything new.

## 5. GLOBAL COVERAGE

Good: 162 countries producing articles last week is genuinely broad. Gaps:
- Volume bias: US 44.8k vs CN 3.7k vs entire Africa (ex-NG: sparse) per 7d; China/Japan/Korea wire coverage minimal (zh not top-15 despite CN sources — likely feeds producing en-tagged or NULL lang); Croatia (hr) is 5× over-indexed (21.5k) purely from aggregator volume — popularity bias amplified by world-view per-location caps and trending.
- The 951 broken web sources are the diversity lever: check `SELECT country, count(*) FROM news_sources WHERE source_type='web' GROUP BY 1` before/after Bug-2 fix — likely heavy in small-language regions.
- GDELT rows are content-free (body="image:…", no published_at) yet consume pipeline cycles.
Metrics to adopt: per-country articles/day with population-expected share (log-ratio index); % cities>100k with ≥1 story/week (world_cities join); language entropy; median fetch→pin latency per country; per-continent share of TOP pins (not just articles). Most of this already exists in /api/sources/health + coverage_gaps — add a daily snapshot table + alert.

## 6. SECURITY (top items, all with file refs)

1. Kill-switch DoS (Bug-4) 2. SSRF trio (Bug-5) 3. XSS trio + no script-src CSP (Bug-7) 4. Unauth writes: apply-categorization, sources/add, nn/refresh spawn, credibility compute, problems approve, active-users (Bugs 4/6) 5. IDOR user-location (Bug-20) 6. Secrets: password in world-readable systemd units + hardcoded fallbacks in 6+ files; .env.test in repo; ai-status leaks internal AI URL (ai-status.ts:47); /api/sysload + debug counts expose infra 7. Rate-limiter defects (unbounded Map, shared "unknown" bucket, XFF trust) 8. Telemetry flood paths (search-intel, client-error ×10/call, event-submissions field lengths) 9. image-proxy in-memory cache 200×5 MB = ~1 GB OOM lever 10. SQL: no live injection found (all unsafe() paths use $n or numeric-clamped interpolation) but 4 fragile-by-construction patterns (pins.ts:576, video.ts:236, sites_study marshalling) — one schema relaxation away from injectable; LIKE wildcard escaping inconsistent between routes.

## 7. DATABASE REVIEW (major tables)

| table | size/rows | read/write | verdict |
|---|---|---|---|
| city_story_features | 14 GB / 31.8 M | heavy batch insert via cursor (FETCH 100 ×86 M); API never reads; pkey+3 idx 0 scans | ML training substrate — partition/prune by run date, drop unused csf_story_city_idx (1.6 GB), consider UNLOGGED |
| news_articles | 7.4 GB / 1.14 M | hot reads (196 M idx scans, 157 k seq scans) + heavy single-row UPDATEs (avg 57-93 ms!) | do NOT partition (row count modest); kill unused GIN/GIST/FTS indexes to restore HOT updates; the 34-index table is the write-amp problem |
| nn_article_sentence_embeddings | 1.4 GB / 364 k | 23.6 M idx scans — the GOOD layer | keep; it's the backbone for the Section-6 model |
| nn_prediction_cache | 952 MB | 260 M reads BUT geolocation head outputs never used for placement | prune 2.26 M dead predictions; wire or delete |
| source_poll_observations | 562 MB / 2.57 M | ~never read | BRIN + 90-day retention |
| news_fetch_decisions | 420 MB / 1.5 M | 0 reads | write-only telemetry → retention or drop |
| news_performance_metrics | 86 MB / 570 k | admin-only | aggregate weekly, prune raw |
| news_events | 502 MB / 266 k | feed/events heavy read | will shrink 10× after real clustering |
| pins | 6 rows | — | community pins only; separate ID space from articles — fix Bug-17 |
| world_cities (FDW) | remote 45 k | full pull per request on 6+ endpoints | replicate locally (materialized copy, weekly refresh) + GIN trgm |
| news_locations | 8.4 MB / 11 k | 1.37 M seq scans (!) — small but hit by the cast-bypass predicate | add (geom::geometry) gist or geography-op query |
Index facts: ~4-5 GB never scanned since boot (both FTS GINs, both word_freq GINs, both native-coords GISTs, duplicate HNSW pair, several pkeys of append-only tables). Query facts (pg_stat_statements): the three per-row location UPDATE variants dominate total time (~37 CPU-hours) — batch + drop indexes; story_linker embeddings CTE = 34.8 s mean × 75 calls; feed/events 167 ms × 26.6 k = 4.4 CPU-hours un-cached.
Pool: API max 10 + wiki 5, statement_timeout 30 s; workers open many short-lived processes each with pool 2 — at 8+ timers overlapping, connection spikes matter at max_connections=100; consider pgbouncer transaction-mode later.

## 8. API notes beyond bugs
Zod validation is present and mostly good on hot paths (validate.ts with bbox regex, limit clamps, `\\` LIKE escaping) — inconsistent on newer routes (events_calendar, sources list params, audio, collab). Cursor pagination exists server-side (/pins next_cursor) but the client decoder is dead code. Caching: pinsCache 20 s + searchCache 5 min + wiki 1 h (the ONLY coalesced one); heavy un-cached endpoints: /pins/stats, /tags/top, /sources/health, /stats partial. The internal article-created secret (internal.ts:25-35, constant-time, fail-closed) is the best-implemented auth in the codebase — copy its pattern everywhere.

## 9. FRONTEND notes
Boot = ~12-15 requests in 2 s; boot coordinator (app.js:9506+) tames the worst races but two direct fetchPinsForViewport calls (:11907, :13042) still bypass it. Per pan: ≥2 GET + 1 POST (pins/map NDJSON light ~120-450 KB, /pins/stats, /analytics/log). Idle tab costs 8-10 req/min (health 15 s, ai-status/sysload 30 s, views flush 30 s, tickLive 15 s + SSE). Marker hygiene is genuinely good (diff-render, removeLayer, fixed-ref off()). AbortController + stale-winner guards correctly handle rapid-pan races. localStorage gazetteer copies crowd the 5 MB quota (3.9 MB cities JSON re-stringified). Candidate client-side work (Section 12).

## 10. TESTING
Exists and decent: ~40 api tests (incl. queue, auth tiers, cache semantics, SSE limits), ~40 python tests in tests/ + worker/tests/ (215 passing per AGENTS notes), Playwright infra under worker/xyzo_debug. Missing (and would have caught Bugs 1-4, 7, 8): (a) import+smoke-call of every pipeline function against a fixture DB — all three crashers are import-time-trivial to catch; (b) TZ regression test: fixture "Tue, 22 Sep 2026 21:00:00 GMT" must yield published_at hour==21; (c) robots-verdict contract test shared by fetch+scraper; (d) auth-matrix test: every write route must assert 401/403 without key — one table-driven test kills Bugs 4/6/20 class; (e) XSS lint: ban template `${` inside href/onclick attributes, or Playwright payload test; (f) EXPLAIN budget test: /pins/map bbox must show Index Scan (kills spatial regressions + Bug-9 permanently). Smallest useful suite = those 6 files.

## 11. ARCHITECTURE: KEEP / IMPROVE / REPLACE / REMOVE / ADD

KEEP: lease+CAS+SKIP LOCKED claim model; host-grouped sequential fetching + robots persistence discipline; escapeHtml discipline + canvas pin renderer + abort/stale-winner handling; NDJSON streaming; idempotent analytics batches; postgres.js tagged templates (no real injection found); queue/dispatcher direction; sentence-embedding pipeline + HNSW; world_cities/watchlist disambiguation data itself.
IMPROVE: pins/map query (indexable predicate, projection table instead of per-request window dedup); event clustering (+embedding merge after TZ fix); Nominatim discipline (countrycodes/viewbox/negative cache); AI validation chain (fix crashers, provenance-aware cache keys); rate limiting (shared middleware, not per-route forgetfulness); trending (schedule compute_* or rewire); cache coalescing.
REPLACE: single-row mutable location fields as the source of truth → scored location_assignments; unbounded in-memory Maps (ratelimit, caches) → TinyLRU/Redis; deploy.sh dev→prod copy → git checkout + content-hash; shutdown-state design; sites_study exec-python-from-string.
REMOVE (or wire): web_scraper tuple bug aside — the scraper needs per-type scheduling, not status-quo; fast_update.py (broken + violates host rule); nn/ orphan models; dead code: app.js:5838-5993, problems.ts dup SQL ×8, sources.ts 7 query branches, explore.ts cooldowns, honeypot branch, unused 4-5 GB indexes, 2.26 M unread geolocation predictions, nn_training_features if the ML run is abandoned; xyzo-queue-soak (inactive).
ADD: location_assignments + needs_review status; coverage-SLA metrics table + daily snapshot; retention/partitioning jobs; CI (bun test + pytest + tsc + eslint gate — none runs now; geoip.ts proves tsc never ran); admin audit log; pgbouncer at next connection incident.

## 12. CLIENT-SIDE COMPUTATION CANDIDATES

| server work | client alternative | data needed | cost | verdict |
|---|---|---|---|---|
| per-location cap + world-view thinning (pins.ts window fns) | ship ordered stream; client caps per place_name after render | already in payload | trivial | DO — biggest server win paired with projection table |
| live-feed proximity ranking (feed.ts distanceDenom) | haversine on 30 items client-side | lat/lng present | trivial | DO |
| /pins/stats per pan (extra request) | derive from streamed pins (it counts what was just sent) | — | zero | DO — delete a request |
| citiesNear in spreadOverlappingPins (O(10k)×groups/pan) | bucketed spatial grid from already-loaded cities.min.json | in memory | ms | DO (frontend perf) |
| trending-city chips | client counts over 7d view cache + cached leaderboard | 20-50 KB | trivial | MAYBE |
| dedupe by event | NO — needs event_id truth | — | — | KEEP SERVER |
| geocoding/search NLP | NO — trust + data volume | — | — | KEEP SERVER |

## 13. PRIORITIZED ROADMAP

### 🔴 CRITICAL (week 1)
1. Bug-1 TZ mktime→timegm + one-time backfill correction + session TZ=UTC. Evidence: 11,435 future-dated/24h. Impact: ranking, dedup, clustering correctness. Difficulty S.
2. Bug-3 restore upsert_location context line; restart geocode+re-evaluate flows. S.
3. Bug-2 web_scraper verdict fix, but gate the 951 sources behind a new `web` schedule (see perf-4) before flipping active. M.
4. Bug-4 shutdown auth → adminAuth(); rate-limit complaint; lock active-users write. S.
5. Bug-6/5 auth-gate apply-categorization, sources/add+bulk-add, nn/refresh→queue; sniff/image-proxy resolve-then-validate + https-only. M.
6. Bug-7 escape targetUrl/onclick; showStatus → textContent or escape q; CSP script-src after inline-handler migration. M.
7. Bug-8 lease release for fresh-skip (predicate into CLAIM_SQL). S.
8. Bug-9 pins/map: hidden_at, source_type leg, 400-on-bad-bbox, cache-key fix, GET rate limit. S-M.

### 🟠 HIGH (weeks 2-3)
9. Spatial indexability (geography predicate or (geom::geometry) GIST; split OR via UNION) → map queries ms-class; EXPLAIN budget test.
10. Map projection table / matview for pin dedup (kill 1.4 s window scans); prune 4-5 GB unused indexes; retention jobs for 4 telemetry tables; disk at 88%.
11. Bug-10 unlocated reset + retryable-429 + Nominatim country hints; Bug-15 density/location_id sync.
12. Bug-13 schedule compute_*; fix cities/trending to use published_at + acceleration.
13. Bug-14 fix disambiguation_gemma parsing (or delete the gate), \m regex, source-aware ai_cache key; _regex_fallback gazetteer-validated.
14. Bug-12 SSE O(N²) → single broadcaster; ratelimit Map → TinyLRU; Bug-16/17 ID-space fix (pins.article_id FK), DELETE…LIMIT; NaN→400 coerceInt helper sweep; wire Re-evaluate (unblocks user-corrections training data).
15. Bug-12-deploy: ?v= automation/content-hash; prod→dev sync; commit dirty tree; invert deploy.sh.
16. CI: bun test + pytest + tsc + eslint on deploy path (tsc would reject code shipping today — geoip.ts).

### 🟡 MEDIUM (weeks 4-8)
17. Event similarity merging (384-d + entity overlap); fix story_linker gate (and→or) + nn_batch_links cleanup type + hardcoded model path.
18. Section-4 CityStoryScore v1: log-odds fusion of EXISTING signals incl. unused news_source_city_affinity; location_assignments audit table; needs_review status; batch UPDATEs (37 CPU-hrs saved).
19. world_cities local replica (kills FDW per-request fetch); gov politeness backoff + auto-retirement policy; robots cache singleton + atomic write; root→dedicated service user, secrets to env file, purge hardcoded passwords.
20. Client: per-pan stats request deletion, proximity ranking move, citiesNear spatial bucket, updateActiveFilterIndicator out of rAF; R-series race fixes.
21. Coverage dashboard + expected-vs-observed log-ratio alert; fix spaCy/transformer NER loops (A4/A5) or delete transformer path.

### 🟢 LOW
Dead-code removal (Section 11 REMOVE), collab tables-or-delete, sysload cpu delta, sitemap tags, cache-debug init for all users, LIKE-escaping consistency, 3d-filter persistence, popup-read-btn wiring, doc drift (AGENTS vs units vs code).

## 14. FINAL TEN-LISTS

TOP 10 PROBLEMS: 1 TZ skew; 2 web ingestion 100% broken (coverage lever dormant); 3 geocode upsert crash (new cities unbindable, corrections dead); 4 public kill-switch + broken admin reset; 5 SSRF+unauth-write surface; 6 XSS with no CSP; 7 map query seq-scan/no-limit (DoS + latency); 8 event/pin correctness (clustering, density desync, hidden leak); 9 deploy cache-poisoning by design (immutable stale JS, dev reverts prod); 10 silent-failure culture (except:pass everywhere; trend/velocity/trending stale; unlocated black hole).

TOP 10 OPPORTUNITIES: fix TZ→instant dedupe/ranking quality; re-enable 951 diverse sources on a proper schedule; wire already-computed signals (source affinity, event velocity, 2.26 M NN geolocation preds, 384-d embeddings) instead of new models; location_assignments scored fusion; pin projection table; user-corrections loop (re-evaluate fix = free training labels); client-side per-location cap; coverage dashboard; CI gate; disk/index reclaim (~5 GB).

TOP 10 PERFORMANCE: (1) spatial index usage on map query; (2) prune indexes→HOT updates (57-93 ms→single-digit); (3) projection table vs window dedup; (4) batch the 4 location-UPDATE variants (~37 CPU-h); (5) local world_cities replica; (6) cache coalescing + GET limiter on pins/map; (7) SSE single broadcaster; (8) schedule or drop 34.8 s story-linker queries + incremental passes; (9) frontend: delete per-pan stats + rAF innerHTML + O(10k) citiesNear; (10) retention pruning (88% disk).

TOP 10 ALGORITHMS: (1) calendar.timegm everywhere; (2) gazetteer-validated locations (never trust free-text geocode result without world_cities match); (3) embedding-cosine event merge; (4) CityStoryScore log-odds fusion; (5) IDF-weighted entity evidence; (6) Nominatim countrycodes+viewbox; (7) fix and→or quality gate; (8) acceleration-based trending on published_at, not fetched_at; (9) population-normalized source priors; (10) calibrate the existing city_story ML to feed placement.

TOP 10 DATABASE: (1) geography-op or expression-GiST spatial access; (2) prune ~5 GB dead indexes; (3) pin projection matview; (4) world_cities replica; (5) partition city_story_features by run + BRIN on append tables; (6) retention: metrics/observations/decisions; (7) location_assignments table + needs_review; (8) FK + ID-space fix pins↔articles; (9) CHECK constraints on lat/lng/status; (10) batch UPDATEs + kill row-by-row cluster loops; keep news_articles unpartitioned.

TOP 10 SECURITY: kill-switch; unauth writes (apply-cat/sources-add/nn-refresh); SSRF×3; XSS×3 + CSP; IDOR geo; rate-limiter integrity; secret hygiene (units/code); telemetry floods; image-proxy memory DoS; fragile unsafe-SQL patterns + LIKE escaping.

TOP 10 INFRA/FEATURES: CI+typecheck+lint; content-hash deploy + git-based release; coverage SLA dashboard + alerts (pending backlog, sweep duration, future-dated %, lease-expired counts); pipeline SLO journal alerts (fast-fetcher duration already exceeds its own timer); admin audit log; pgbouncer (next connection spike); feature-flag for scraper re-enable; backfill tooling (unlocated reset, TZ fix); Playwright XSS/perf regressions; status page exposing /api/sources/health + pipeline freshness.

TECHNICAL DEBT (headline): two naming regimes (NEWSIUM_* vs XYZO_*) with dead knobs; installed units ≠ deploy/ units ≠ docs; five parallel location-writing subsystems fighting over mutable fields; ~5 GB unused indexes + 2.26 M unread predictions + multiple dead services (fast_update, transformer NER, worker/nn, collab, soak); Bun ships without tsc; app.js 16.6 k lines (split at natural seams: popups, discovery, live-feed, search); public_html_dev drift.

WHAT I WOULD NOT CHANGE: the lease/SKIP LOCKED fetch core; host-sequential politeness doctrine and robots tracking; the canvas renderer, diff-based markers, and abort/stale-winner fetch discipline; postgres.js parameterization culture; the 384-d embedding pipeline; queue/dispatcher direction; watchlist disambiguation DATA (bugs are in code paths, not the gazetteer); community-correction feedback CONCEPT (just un-break it).

30-DAY PLAN: W1 correctness+security hotfixes (bugs 1-9 class) with the 6 new test files; W2 perf: spatial fix + index pruning + projection table + retention (disk <70%); W3 deploy integrity (content-hash, git deploy, CI gate) + trending/velocity scheduling + silent-failure logging pass; W4 web-scraper staged re-enable (10% → 100% behind new schedule), re-evaluate + correction loop live, coverage dashboard v1.
90-DAY PLAN: CityStoryScore v1 with location_assignments + ML calibration; event similarity clustering + repin cleanup (expect events 266 k → ~60 k, better world-view density); embedding-based needs_review queue + anomaly detector fix (real quarantine); client-side caps + payload diet (z≥8 <150 KB typical pan); NER unification (one writer of entities); secrets/unit reconciliation; load-test /pins/map at 50 RPS with p95 <100 ms; language expansion pass using freed web-source capacity (expect +15-20% non-EN share).
