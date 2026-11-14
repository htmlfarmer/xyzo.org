# Xyzo Development Rules

## Update the README with EVERY change (CRITICAL)

**If you change anything — a new overlay, a fixed bug, a swapped
licence, a new test, a changed number — update `README.md` in the same
session.** Not afterwards, not "later": during the change.

`README.md` opens with **"⚠️ Update this file before you close a
session"**, which lists the four places every change touches:

1. the **`## System Health`** status table — one row, what changed;
2. the **`## Data Quality & Provenance`** table — if a dataset or
   licence moved;
3. the affected **overlay's own section** — new numbers, new command,
   the trap you just learned;
4. **`## Known Issues`** — anything you did *not* fix.

Then run `bun test public_html/tests/*.bun.test.js` and say so.

A change that lands without its README line makes every other line in
the file suspect, and turns the next close-out into archaeology instead
of a diff. The close-out bar is **"the docs match the code and the
tests are green"**.

## Parallel Fetching Rules (CRITICAL)

**Rule: Different hosts = parallel OK. Same host = sequential only.**

- ✅ Fetch from `bbc.co.uk` and `reuters.com` at the same time — different hosts, no shared rate limit
- ❌ Never fetch from `bbc.co.uk` twice at the same time — same host, will get rate-limited or banned
- Within same host: sequential requests with per-host throttle (respect robots.txt Crawl-delay, min 1s)
- Group sources by hostname, run host groups concurrently via ThreadPoolExecutor
- Skip sources that succeeded in the last 5 minutes (no point re-fetching fresh RSS)

**Implementation:** `worker/fetch.py` — `fetch_all()` groups by host, uses `ThreadPoolExecutor(max_workers=8)`

## API Design Rules

- All list endpoints return `{ items: [...], count: N }` shape
- All mutation endpoints return `{ ok: true, ... }` or `{ error: "code" }`
- Use Zod schemas for request validation (`@hono/zod-validator`)
- Rate limit all public endpoints (use `RateLimiter` from `ratelimit.ts`)

## Database Rules

- Use `postgres.js` tagged templates for queries (SQL injection safe)
- Always use parameterized queries, never string interpolation
- The `xyzo_app` DB user needs SELECT on all tables (run `GRANT SELECT ON ALL TABLES IN SCHEMA public TO xyzo_app;` after adding tables)

## Frontend Rules

- All JS in `public_html/app.js` (no build step, vanilla JS)
- Use `CityEngine` for client-side city detection
- Use `escapeHtml()` for all user content in HTML
- Leaflet for maps, DOMPurify for HTML sanitization
- **NEVER use `console.warn/error/log/debug` directly** — use `XLog.warn()`, `XLog.error()`, `XLog.log()`, `XLog.debug()` (silent unless `window.XYZO_DEBUG = true`)
- `console-guard.js` loads FIRST and suppresses third-party noise (Leaflet deprecations, ResizeObserver, ad-tech)
- To add new suppression patterns: edit `SUPPRESS_PATTERNS` in `public_html/console-guard.js`
- **Firefox's `MouseEvent.mozPressure` / `mozInputSource` deprecation notices ARE suppressible, and the guard now does it (2026-11-09).** The old comment said they "cannot be suppressed from JavaScript — they are browser-native warnings generated at the C++ level". **That was wrong**, and the proof is that the vendored Leaflet contains **zero** occurrences of "pressure": nothing reads the property. **Leaflet 1.1.1 copies the DOM event with `for (var j in src)`** (its `Util.extend`), and Firefox keeps `mozPressure`/`mozInputSource` as **enumerable getters on `MouseEvent.prototype`** — so that loop READS them, and reading a deprecated property is what prints the notice. **THE FIX:** make the two getters **non-enumerable** (the getter itself is untouched, so a direct read still works and still warns). Measured in Firefox on the live map: before, both warnings on every click; after, **silent** — with the map, the satellite popup and its mini map all unaffected.
- **`console-guard.js` had NO `?v=` TOKEN until 2026-11-09** — and a `*.js` is served `max-age=31536000, immutable` for a year, so **every reader who had loaded the page since 2026-10-21 was running a frozen copy** (it defines `window.XLog`, which every module logs through). **16 of index.html's 67 scripts had no token at all** — `console-guard.js`, `i18n.js`, `command-bar.js`, `analytics.js`, `presence.js`, `city-engine.js`, `submit-sniff.js`, `debug-panel.js`, `update-check.js`, `viewport-nudge.js`, `cache-debug.js` and the five vendored libraries. **ALL of them are stamped now**, and `bump_frontend.sh`'s `ASSETS` list covers them. **The gate is `frontend-hygiene.bun.test.js`**: every `<script src>` in index.html must carry a `?v=`, and every one of them must be in that list (with three named exemptions — `overlay-opacity.js` and `map-presets.js` move one at a time via `bump_asset_token.sh`, and `help-me-chat.js` is a lazy chunk stamped by the chunk loop).
- To debug: set `window.XYZO_DEBUG = true` in DevTools console
- **`app.js` has NO size ceiling** — removed 2026-11-01 by owner
  decision, and **do not re-add one.** There was an asserted 850,000-byte
  limit (`code-splitting.bun.test.js` plus five other files), added
  2026-10-29 as a "runaway-growth ceiling". It was never a speed guard
  and it measured the wrong quantity: **app.js ships as ~245 KB
  GZIPPED** (not 850 KB), **all 62 scripts on the page are `defer`**, and
  it is served **`immutable` for a year** — so size costs a one-time
  first visit, not per-visit render time. Worse, it had become the
  binding constraint on every frontend change: the population overlay
  went into a registry instead of being named inline (README records
  "8 bytes" of margin as the reason), state-abbrev search moved 3.4 KB
  into `city-engine.js`, and the layers-tap fix deleted six uncalled
  functions purely to get back under it. A gate you have to dismantle
  code to pass has stopped being a guard.
  **The rule that still stands is architectural, not a byte count:** code
  NOT needed at boot goes behind **`loadChunk()`** (the pattern already
  used for `flag-quality.js` / `ai-story-chat.js`), so `app.js` grows
  freely but stays the part every screen needs. And **never delete
  comments to make room** — they are the record of *why*.

## Shared Search Links (`?q=` / `#search=` / `#pin=`)

A link with a query must work on a cold load. Three defects made a
shared link silently do nothing (2026-10-27):

- **Leaflet has NO `isStyleLoaded()`** — zero hits in
  `vendor/leaflet/leaflet.js`. The guard `if (map && map.isStyleLoaded())`
  threw a `TypeError`, and the `catch (e) {}` around it swallowed it, so
  the boot search never ran. Use **`whenMapReady(fn)`** in app.js, which
  wraps Leaflet's `map.whenReady()` — it runs the callback on the next
  tick if the map is already loaded and otherwise when it loads.
  `map.once("load", fn)` is NOT enough: it does nothing when the load
  event has already fired.
- **`runSearch()` must set `searchActive = true` BEFORE its fetches.**
  It guards on `!searchActive` after the awaits (`if (ctrl.signal.aborted
  || !searchActive || _searchAbortCtrl !== ctrl) return;`), and the flag
  was only set at the very END of the function. A caller that did not
  come from a keystroke — `?q=` and `#search=` both set
  `searchInput.value` programmatically, which fires no `input` event —
  therefore bailed after the fetches: no pins rendered and the status
  stuck on `Searching "…"`.
- **Never call `runSearch()` synchronously from a script-level IIFE.**
  It reads `debouncedTextSearch`, a `const` declared ~150 lines later;
  calling it before that binding is initialised throws
  `Cannot access 'debouncedTextSearch' before initialization`. Defer it
  (`setTimeout(run, 0)`).
- **`openPinPopup()` looks the marker up by BOTH number and string**
  (`findMarkerById`): both marker maps are keyed by the numeric id but
  the id arrives from a URL hash as a string. `eventMarkers.get(String(id))`
  never matched, so a shared link to an EVENT marker could not open at
  all. It also retries for ~16 s while the search is still loading — one
  500 ms retry was not enough.
- **Never swallow an error silently** in a boot path — log it with
  `XLog.warn()` so a dead code path is visible instead of invisible.

Pinned by `public_html/tests/search-boot-recovery.bun.test.js`.

## Saved Searches — stale-while-revalidate (2026-11-09)

**A REPEAT SEARCH MUST NOT MAKE THE READER WAIT FOR AN ANSWER THEY HAVE
ALREADY SEEN.** A text search is the slowest thing on the site: the pin
query ranks with `ts_rank_cd` over the whole corpus and measures **3–50 s**
cold, and the event search spawns a Python worker for another **30–90 s**.

**THE MEMORY ANSWER DECIDES THE DESIGN: THE QUERY IS FREE AND THE
RESULTS ARE NOT.**

| | |
|---|---|
| the **query** | a key of a few dozen bytes — **free** |
| the **results** | **1.5 MB** for 1,000 pins (1,620 B a pin) |
| …of which `word_freq` | **711 KB (45 %)** — and the popup fetches its keywords on demand from `/api/pins/:id/words` |
| the **slimmed** copy | **773 KB** a search |

So:

- **The browser keeps the answers in `public_html/saved-searches.js` —
  INDEXEDDB, which is DISK, not RAM.** The copies are slimmed (no
  `word_freq`), capped at the **12 most recent** searches (≈ **9 MB of
  disk**), and expire after **7 days**. Nothing is added to the tab's
  memory beyond what the live search already puts there. **IndexedDB,
  not `localStorage`**: a 773 KB answer would blow the localStorage quota
  in five searches.
- **The server's copy IS RAM, so it is byte-budgeted**
  (`api/src/cache.ts`): the search cache had a **200-ENTRY** limit and a
  search answer is up to 1.5 MB — a **300 MB ceiling** on the API
  process's memory, and **an entry-count limit cannot express a memory
  limit**. It is now a **64 MB budget** (~40 full answers).

**THE TTL STAYS A HARD 5 MINUTES.** A cached answer older than that
would be yesterday's news served as if it were this morning's. The
"popular searches are always fast" idea is served by the BROWSER's copy,
which announces its own age — not by a server cache that never expires.

**THE FRAMING IS NOT SAVED AS A DECISION.** A saved answer is framed by
the **same function** that frames a live search (`frameSearchRegion`), so
a saved search can never put the map somewhere a fresh one would not.
What is saved is the pin list, the event list, and the two small lookups
the framing needs (the geocode and the location match).

**THE KEY CARRIES THE TIME WINDOW, NOT THE TIMESTAMP.** `getSinceDate()`
snaps to a **60-second boundary**, so a timestamp in the key changes
every minute and the saved answer is never found again — which is
exactly what happened when this was first built (the saved copy was
written and never read back). The key is
`query | window | tag`, where the window is `24h` / `all` / `custom:7`.
The pin DENSITY is a rendering setting, so it is not in the key.

**THE ORDER IS THE FEATURE.** The saved answer is painted **before** the
slow pin query is awaited:

```js
const fastFetches = Promise.all([...]).then(v => ({ok:true,v}), e => ({ok:false,e}));
const saved = await savedPromise;      // ← painted here
const fetched = await fastFetches;     // ← awaited here
```

The fetch promise is settled into a value rather than allowed to reject:
it is awaited LATER, and an un-awaited rejection is an unhandled
rejection.

**THE READER IS TOLD BOTH TIMES**: "Showing saved results from
11/9/2026 · searching for newer…" and then "… · updated ✓".

Measured on the live site (API cache cold): **t = 0.23 s** → the saved
answer on the map; **t = 1.80 s** → the fresh answer and the note.

Pinned by `public_html/tests/saved-searches.bun.test.js` (13).

## Where a Search Frames the Map (2026-11-09)

**A search must frame the STORIES.** Owner report: *"when i search for
'artificial intelligence' it find some articles but zooms in to an area
that doesnt have any stories.. cant we quickly calculate that 'region'
and zoom out to the best area?"* — the URL ended at `#49.7961,9.8988,10`
(Würzburg, zoom 10) and a second run at `#34.1618,-33.3984,2` (the middle
of the South Atlantic).

**ONE implementation: `frameSearchRegion()` in `app.js`.** `runSearch()`
and `runTextSearch()` each used to carry their own copy of the gate, and
they had already drifted — one read `geoMatchesQuery`, the other
`geoStrong`; one read `event_count`, the other `events_count`. Two copies
of a gate is how they drift; `fitToResults()` and `collectAllLatLngs()`
are gone with them.

**A place may only frame the map when it is a REGION.**

- `/api/geocode?q="artificial intelligence"` answers with the **"Center
  for Artificial Intelligence and Robotics"** in Würzburg — an **ELEVEN
  METRE** bounding box — and `/api/locations/search` answers with a junk
  row named **exactly** "Artificial Intelligence" pointing at that same
  door. The old gate was **NAME EQUALITY**, so it passed, and the map
  flew to the door and zoomed to 10. **"climate"** answers with the
  **Climate Pledge Arena** in Seattle (a stadium, 150 m) and
  **"nvidia"** with the headquarters (~100 m).
- **A box narrower than `MIN_REGION_DEG` (0.05° ≈ 5.5 km) is a POINT OF
  INTEREST** — a building, a campus, a stadium — and is rejected. The
  rejection also keeps the building out of the STATUS LINE: naming it
  there is naming the thing we just refused to zoom to.
- **A real place still wins, unchanged**: "el salvador" → the country
  (13.70, -88.91 z9), "tokyo" → the city (35.69, 139.69 z7). The strict
  name-equality gate, the extent cap (`< 25°` × `< 40°`) and the
  box-centre agreement are all still there.

**Otherwise the region comes from the RESULTS — and the raw ones.**

- The points are the story locations (`storyPoints()`), **never the
  rendered markers' positions**: a renderer's spread position is a lie
  about where a story happened (the exporter keeps `_rawPins` for the
  same reason).
- The events of the resolved location (`locEvents`) are deliberately NOT
  among them — they are the stories OF that place, and when the place is
  rejected they would drag the region back onto it.
- **A result set that spans the world (`WORLD_SPAN_DEG` 90°) is framed by
  the WORLD VIEW**, because the box of a worldwide set has its centre in
  an empty ocean — the "artificial intelligence" box centred at
  34.16, -33.40, some 2,300 km from the nearest story.

**THE MAP MUST MOVE QUICKLY.** The event search spawns a Python worker
and can take **30–90 s**. It is now **started before the framing and
awaited after it**, so it overlaps the framing instead of delaying it
(measured on the live site: the map moves at **4.2 s** instead of
**14 s**). The promise must never reject — an abort returns
`{ error: "aborted" }` and the guard after the await drops it, or an
aborted search leaves an unhandled rejection behind.

**THE PINS QUERY IS STILL SLOW** (30–50 s cold) and the region cannot be
computed before the stories arrive — README Q-N28.

**A LOCATION ROW MUST BE CORROBORATED BY THE GEOCODER.** They are
independent oracles, and a row whose name happens to equal the query is
only a place if the geocoder agrees on WHERE it is. Measured
(2026-11-09): searching "ai" — `/api/locations/search` answers with a
junk row named **"AI" on Long Island, New York (353 events)** and
`/api/geocode` answers with **ANGUILLA**; the two are 2,700 km apart,
the name-equality gate passed, and the map flew to a place called "AI"
at zoom 6. **The row must be within `ANCHOR_AGREE_DEG` (6°) of the
geocoder's answer**, and a row that matched the name and was not
corroborated is dropped from the map **and** from the status line, and
its stories are not fetched at all. **No geocode answer means nothing to
contradict the row**, so the row stands (the "Anguilla" case, where both
agree).

**THE NAME COMPARISON FOLDS THE ACCENTS** — a reader types "wurzburg"
or "sao paulo", not "Würzburg" and "São Paulo", and the row in the table
carries the accents.

**A SEARCH FOR A COUNTRY MUST NOT LAND ON A CITY (2026-11-11).**
Owner report: *"i just searched for 'china' and it zooms into
`#12.6283,-87.1326,9` … it also says **No news found near Chinandega,
Chinandega Department, NI** … this is a generalized problem"*, then
*"a search for 'india' zooms into indianapolis"*. **ONE DEFECT:
`detectCitySearch()` PREFIX-MATCHES**, and the query is a prefix of a
bigger city's name in every case — measured matrix: **china →
Chinandega NI · india → Indianapolis · peru → Perugia IT · florida →
Florida, CUBA · maine → Maine Township IL · korea → Koreatown CA ·
virginia → Virginia, SOUTH AFRICA** — and the city branch then fetches
pins **by bbox, not by query**, hence "No news found near Chinandega"
for a search about China. **NO STRUCTURAL RULE CAN FIX IT**:
"china"→Chinandega and "chica"→Chicago are both mid-word prefixes of a
city name, and prefix matching must keep working while the reader types
("new" → NYC, "kansas c" → Kansas City). The difference is that one
query NAMES A COUNTRY, so:

- **`BIG_PLACE_NAMES` in `city-engine.js` is the list** — ISO 3166
  country names plus the forms people type ("usa", "ivory coast",
  "burma", "holland"), normalised by one `normPlace()` on both sides,
  plus the 51 US state NAMES derived from `US_STATES` (one table, not
  two). `detectCitySearch()` returns **null** for an exact match, so the
  query falls through to `/api/geocode` + `/api/pins?q=` — all THREE
  city-path call sites (`runSearch`, `runTextSearch`, the search-mode
  pin fetch) go through that one function, so a guard in any one caller
  would leave the other two hijacked.
- **THE GEOCODER ANSWERS IN THE LOCAL SCRIPT**, so the name gate would
  still reject the country once the city path steps aside — measured
  live: `china` → **中国**, `japan` → **日本**, `korea` → **대한민국**,
  `brazil` → Brasil, `turkey` → Türkiye, `peru` → Perú.
  `frameSearchRegion()` therefore accepts an answer that is BOTH
  `place_type === "administrative"` (a country or a state — Nominatim
  answering "turkey" with Turkey, **TEXAS** is a town and still loses)
  AND for a query **on the list** (a topic never reaches the clause, so
  the point-of-interest and corroboration rules are untouched). The list
  arrives as a **parameter** with a safe default — the framing function
  stays a pure function of its arguments, which is what lets the tests
  run it against a stub map with no `window`; **every one of the four
  call sites passes it**, or that path silently keeps the old behaviour.
- **THE EXTENT CAP IS THE LARGEST REAL COUNTRY, NOT A CITY'S**: the old
  `25° × 40°` rejected China (44.9° × 61.3°), India, Brazil, Canada
  (41.7° × 88.7°) and Australia (46.2° × 96°), so a country search fell
  back to a point at zoom 6 showing a slice. It is **`60° × 100°`** now,
  which still rejects the **United States (86° × 360° — Wake and Guam)**,
  **Russia (360° across the antimeridian)**, continents and the world —
  fitting those would zoom out to the whole planet, which is the failure
  the cap exists for. The cap was never what protected against Tokyo's
  prefecture (15.7° × 18.4° passes any sane cap): the box-centre
  agreement is.

**KNOWN, NOT FIXED:** while TYPING, "china" still passes through
"chin" → Chinandega for one keystroke — the guard matches the whole
query and cannot know the letters not yet typed (README Q-N31).

**A SEARCH MUST NOT SCAN THE CORPUS (2026-11-11).** A text search is
the slowest thing on the site, and it was slow for THREE reasons that
have nothing to do with each other. All three are now pinned by the
shape of the statement:

- **ONE UN-INDEXABLE LEG INSIDE AN `OR` MAKES THE WHOLE `OR`
  UN-INDEXABLE.** The text predicate ORs five legs; four are served by
  the trigram GIN indexes, and `discovery_query ILIKE '%q%'` (guarded by
  `source_kind = 'web_discovered'`) was served by NOTHING — so the
  planner fell back to a parallel **seq scan of the 3.8 M-row table**
  (397,043 buffers, 3.1 GB of I/O, for 978 rows) to look at **20
  rows**. `2026-11-11-search-text-indexes.sql` adds a partial GIN
  index over exactly those twenty rows. **THE LESSON: an `OR` is only as
  indexable as its LEAST indexable leg.**
- **THE FUZZY BRANCH IS WORD SIMILARITY (`%>`), NOT WHOLE-STRING
  SIMILARITY.** `similarity(title, t) > 0.3` compares the WHOLE title
  with a 5-letter word, so it can only reach 0.3 against a SHORT title,
  and the index scan for it starts from the query's three trigrams —
  1,149,700 index tuples and 584,762 heap rechecks for 1,584 rows
  (**25,463 ms**). `title %> t` compares the query with a WORD in the
  title: **102 ms**, and it finds "Chinese companies bag contracts…" for
  "china", which the substring rule misses ("chinese" does not contain
  "china"). **THE THRESHOLD IS SET EXPLICITLY**
  (`set_config('pg_trgm.word_similarity_threshold', …, true)` — it is a
  per-CONNECTION GUC, so a plain `SET` on the pool could land on a
  different connection than the query, and a server whose default had
  been changed would silently change every search).
- **THE STATEMENT MUST BE PLANNED WITH ITS REAL PARAMETERS.** The text
  is the same for every search, so after five executions Postgres
  switches to a GENERIC plan — which cannot know the parameter is a
  selective trigram and re-picks the seq scan: **718 ms custom vs
  37,679 ms generic**. The search runs with `plan_cache_mode =
  force_custom_plan`.

**THE ENTITY BRANCH MUST BE INDEXABLE TOO.** A known company carries an
implicit location ("nvidia" → Santa Clara). Matching it with
`a.extracted_location ILIKE '%city%'` is a free-text match on 3.59 M
rows — the second un-indexable leg (**155,931 ms**). The city is
resolved to its `news_locations` row first (45 k rows, a millisecond)
and the article side became `location_id = ANY(...)` — which keeps
35,231 of the 35,291 rows the text form matched.

**`/api/locations/search` COUNTS ONLY THE MATCHED LOCATIONS.** It runs
on EVERY search. Its aggregate was UNCORRELATED — it counted the
articles of all 45,231 locations before it could answer about a handful
(**2,050 ms**). Counting the matched locations with an index-only
`(location_id, published_at) WHERE status = 'extracted'` count: **67.7
ms**.

**THE PRE-INDEX (2026-11-11).** The popular queries are answered IN
ADVANCE: `search_preindex` holds the answer, and
`worker/search_preindex.py` keeps it current on a 15-minute timer.

- **WHAT IS STORED IS THE ANSWER, NOT THE STORIES.** The payload points
  at live rows, so a title, an image and a timestamp are always
  current; only the SELECTION is precomputed.
- **THE BUILDER CALLS OUR OWN API** — a second copy of the search SQL in
  Python would be a second implementation, and the second implementation
  is the one that drifts. It sends **`X-Search-Fresh: 1`**, which makes
  the API skip BOTH the RAM cache and the pre-index: without that the
  builder would fetch the stored answer and copy it over itself, and
  the store would never get fresher.
- **THE KEY CARRIES THE TIME WINDOW, NOT THE TIMESTAMP** — "24h" is
  asked for as `since=<now − 24h, snapped to the minute>`, so a key
  built from the timestamp would change every minute.
  `windowKeyFor()` derives the window from the AGE of `since`.
- **AN ANSWER SAYS HOW OLD IT IS** (`built_at` + `X-Search-Source`), and
  an entry older than six hours is not served at all.
- **THE LIST OF WHAT TO PRECOMPUTE IS THE REAL DEMAND.**
  `search_query_stats` is written by the search path now; it had ONE
  row in it (only `/api/searches/save` wrote to it).

Pinned by `public_html/tests/search-region.bun.test.js` (25),
`public_html/tests/search-place-navigation.bun.test.js` (rewritten against
the shared function — the same assertions, a new home) and
`public_html/tests/search-country-hijack.bun.test.js` (17 — runs the
SHIPPED city-engine against the real `cities.10k.json`, and the framing
against live-API fixtures).

## A Short Query Matches a WHOLE WORD (2026-11-09)

Owner report: *"the strories dont seem to be related mostly becuase the
ltters ai show up not ARTIFICIAL INTELLLEGENCE"*.

**THE PIN SEARCH MATCHED BARE SUBSTRINGS.** `GET /api/pins?q=ai` used
`ILIKE '%ai%'`, so **said**, **rain**, **air**, **detail**, **campaign**
and **again** all counted. Measured on the corpus (2.99 M articles):

| | titles |
|---|---|
| contain the letters "ai" somewhere | **558,168** |
| contain the WORD "ai" | **59,100** |
| → the noise | **499,582** |

**THE RULE** (`api/src/lib/wordmatch.ts` — ONE implementation, shared
with the event search, which already matched whole words, so the same
query could answer with two different sets of stories):

- a term of **≤ 3 characters** matches a whole word (`\m…\M`);
- a longer term keeps the substring match, because **"coronavirus" must
  still find "coronaviruses"**, which a word boundary would miss.

**THE PHRASE BRANCH WAS THE LAST HOLE.** "ai" has expansion terms
("artificial intelligence", "machine learning", "neural network", "deep
learning") so it took the multi-term path — whose phrase match was still
a bare substring, and that phrase is what drowned the expansions. The
phrase now takes the same rule as a term. **After the fix all 1,000
results for "ai" carry "AI"/"artificial intelligence"/"machine
learning"; zero noise** — and the query got FASTER (3.8 s against
22–50 s for the long-term path).

**THE COST:** the dotted spelling of an acronym (**"A.I."**) is **578
titles** and is not matched by `\m…\M` — 1 % of the AI corpus.

**THE PLACE GATE IS NOT A NAME GATE.** `norm()` compares the whole
query with the place name, so a place named exactly like the query
always wins it — which is right for "el salvador" and wrong for "ai".
The corroboration rule above is what tells them apart.

Pinned by `api/tests/pins-search-wordmatch.test.ts` (mutation-checked: it
fails against the pre-fix code).

## The Chip Bar Must Not Offer a Word That Names Nothing (2026-11-09)

**THE EXTRACTOR'S PROMPT SHOWED A COPYABLE EXAMPLE.** It read:

```
"topic_tags": ["3-6", "short", "topic", "tags"]
```

and **many models copied it verbatim**: those four words are literal
tags on thousands of articles ("3-6" 2,741 · "short" 1,482 · "tags" 1,395
· "topic" 1,265), and the chip bar offered a chip labelled **"topic"**. A
reader who clicked it got a map of articles about nothing in particular —
which is exactly what it looks like.

**THE AGENTS.MD RULE ALREADY SAID IT**: *"never put a reusable example
sentence in the system prompt, and strip meta-language from the output"*.
The prompt now shows an empty list and asks for the tags in prose.

**BUT THE DATA ALREADY HOLDS THE ROWS**, so there are THREE fixes:

- the **prompt** shows `"topic_tags": []` and asks for 3–6 topical tags;
- the **extractor** (`worker/extract.py::_clean_topic_tags`) strips the
  four words before writing them, and falls back to the article's event
  type when nothing is left;
- **`/api/tags/top` filters them**, so the rows already in the table
  cannot reach the chips.

Pinned by `api/tests/tags-structural.test.ts` (mutation-checked).

## Cross-Field Verification of the GFS Overlays

The map paints three fields from ONE GFS analysis cycle: the pressure
(isobars), the 2 m temperature and the 10 m wind. They share the
decoder, so a decoder bug corrupts all three at once — and each
overlay's own `verify()` is a *relationship* check that cannot tell a
mirrored field from a correct one (the mid-latitudes are windier than
the tropics in BOTH hemispheres; the equator is warmer than the poles
in both).

**`worker/gfs_verify.py` is the audit.** It checks each published
grid against the raw GRIB message re-decoded with the message's own
index arithmetic, AND checks the three fields against each other:

```bash
python3 -m worker.gfs_verify              # all three + the cross-checks
python3 -m worker.gfs_verify --field wind
python3 -m worker.gfs_verify --offline     # no network
python3 -m worker.gfs_verify --json
```

- **THE WIND vs THE PRESSURE — the geostrophic balance.** In a
  balanced atmosphere the flow runs roughly parallel to the isobars,
  with the LOW pressure on its LEFT in the northern hemisphere. The
  geostrophic wind can be computed from the pressure field alone
  (V_g = k × ∇p / (ρf)), so the pressure field is an INDEPENDENT
  WITNESS for the wind: a mirrored, swapped or sign-flipped wind
  cannot line up with the pressure gradient. Surface friction turns
  the flow slightly ACROSS the isobars, towards the low — and the
  SIGN of that component is checked too.
- **THE WIND vs THE TEMPERATURE — advection.** The wind carries air
  with it, so the temperature it comes FROM has to be the cold side.
- **THE ISOBARS** are checked against the pressure field they are
  drawn from: the pressure read at a point ON a served line has to
  equal that line's own level. **THE FIELD MUST BE THE ONE THE LINES
  WERE CUT FROM, ON THE SOURCE'S OWN GRID.** The GFS isobars are
  contoured from the **0.25°** PRMSL (`worker/isobars.py`: `GFS_PRODUCTS`
  tries `0p25` first, `1p00` only as the fallback), and the ECMWF ones
  from the IFS **0.1°** message. Reading the 1° product instead is not
  a rounding difference — the two fields differ by far more than the
  contouring error, and the 1° field is blurred **four times as hard**
  (`smooth_field()`'s sigma floor is two CELLS: 0.5° on the 0.25° grid,
  2.0° on a 1° one). Measured on the 2026-11-04 18Z analysis: the
  1°-against-0.25°-lines comparison reported a p95 of **1.35 hPa**
  (a false alarm), the 0.25°-against-0.25° comparison **0.029 hPa**.
  **The isobars were never wrong; the audit was measuring the wrong
  field.** `fetch_raw_isobar()` in `worker/gfs_verify.py` owns the
  per-source resolution; `fetch_raw()`'s default stays **1p00** because
  the published wind and temperature grids ARE 1°.
- **The control matters**: the tool mirrors the wind field on purpose
  and the cross-check has to notice. A check that cannot fail is worse
  than no check.

The smoothing is the one the isobar worker uses — `worker/isobars.py::
smooth_field()`, called with the grid's OWN spacing. **Do not
re-implement the sigma**: a second implementation is a second source of
truth, and the one that drifts is the one nobody checks. The sigma is a
PHYSICAL width (`FIELD_SMOOTH_SIGMA_DEG = 0.5`), so the 0.25° grid gets
2 cells and the 0.1° grid 5 — the same half-degree of blur. The
two-CELL floor only bites on a 1° grid, and it binds identically on
both sides (worker and audit), so it is not a discrepancy — it is a
discrepancy only when the two sides read DIFFERENT grids.

**THE GATE'S TOLERANCE IS A MEASUREMENT, NOT A GUESS.** The p95
tolerance is **0.4 hPa** (`ISO_P95_TOL_HPA`) and the mean tolerance
**0.25 hPa** (`ISO_MEAN_TOL_HPA`). The p95 figure was **2.5 hPa** until
11-04, on the reasoning that the contouring moves a line "by up to the
grid spacing — over high terrain that is a couple of hPa". It does not:
the Chaikin amplitude is ~0.06° and the Douglas-Peucker tolerance
0.01°, so the movement is ~0.07° — a third of a cell at 0.25°. MEASURED
against the field each source's lines were cut from, over three GFS
cycles and five boxes, the artefact is **p95 0.029–0.048 hPa** (GFS) and
**0.011–0.018 hPa** (ECMWF) — so the old allowance was **52× the
artefact**, and the gate could not see a displacement of a whole grid
cell (one 0.25° row measures p95 0.698, one column 0.491). At 0.4 hPa
the gate is 8× the worst measured artefact and catches every one of
them. **Re-measure before changing it**, and keep the constants and the
tests in step — `worker/tests/test_gfs_verify.py` asserts the GATE's
own constants, so the test and the gate cannot drift apart.

**THE AUDIT'S OWN ARITHMETIC CAN FORGE THAT MEASUREMENT.** For one
build cycle (11-05 → 11-06) the tolerances were raised to **1.0 / 0.5**
and the single-cell mutation test weakened to a TWO-cell shift, on the
strength of "measured p95 0.51 hPa at the 0.5 hPa interval". Those
numbers were `int(level_hpa)` in `_stored_isobar_lines()`: every
half-level was compared against the whole hPa below it, so the gate was
measuring **its own truncation** (up to 0.999 hPa of it) — and it
collapsed **108 distinct stored levels to 27** distinct compared values.
The fix is one line (float, not int); re-measured at the 0.05 lattice
the artefact is **p95 0.032 hPa (GFS) / 0.010 (ECMWF)**, and the
tolerances are back at **0.4 / 0.25 / 0.6** with that test shifting
**one** cell again (0.698 for a row, 0.491 for a column — the two
figures the 0.4 was calibrated on). **A tolerance is only as honest as
the arithmetic that produced its evidence**: before trusting a
re-measurement, check what the checker itself did to the numbers.

The pressure/temperature/wind workers each run on their own 6-hourly
timer, and a timer that fires BEFORE the new cycle is published on
NOMADS finds the previous cycle still current — so one overlay can be
a cycle behind the others. That is a warning, not a failure.

Pinned by `worker/tests/test_gfs_verify.py` (synthetic fields with an
analytic geostrophic wind, so the expected answer is worked out on
paper, plus the published artefacts against the live analysis).

## Layers Dropdown — collapsed on EVERY viewport (2026-11-06)

The dropdown is created with `collapsed: isPhoneViewport()`, then
`layersControl.collapse()` runs immediately after `addTo(map)`.

- **BOTH VIEWPORTS START CLOSED** (owner, 2026-11-06: *"don't start
  with the two control windows open when someone first visits"*). A
  first visit shows the **map**; the reader opens a panel when they
  want one. The start state is the explicit `collapse()` in the SAME
  synchronous block as the constructor — nothing can paint it open.
  The Live Feed panel is the other half of the same rule: its markup
  now ships `class="live-panel collapsed"` (so it is closed even
  before `app.js` runs — verified with `app.js` blocked) and
  `setPanelCollapsed(true)` runs unconditionally instead of only under
  768 px.
- **The constructor option is `isPhoneViewport()`, NOT `collapsed:
  true`, because the option decides SEMANTICS, not the start state.**
  `collapsed: false` (desktop) is what keeps the panel **sticky once
  opened** — Leaflet only binds map-click → collapse and mouseleave →
  collapse when `collapsed: true`, which is the *"suddenly disappears
  while you are reaching for a slider"* bug. `collapsed: true` (phone)
  is what gives Leaflet its tap-to-open wiring (`mouseenter →
  _expandSafely`) that the touch handler builds on. So desktop is
  CONSTRUCTED open (its `_initLayout` calls `expand()`) and closed
  again one line later; the toggle's `click` handler sits OUTSIDE the
  `collapsed && …` guard in `_initLayout`, so a `collapsed: false`
  control still re-expands on a click — that path already shipped (open
  → ✕ → click the toggle to reopen).
- **`collapsed: false` makes the map untappable on a phone.** The panel
  is ~365 × 2400 px on a 390 × 844 screen — it covers the entire
  viewport, so **every tap lands on a layer row and no pin can be
  tapped**. Tap the toggle to open, ✕ or tap outside to close.
- **The toggle must answer `touchend`, not just `click`.** Leaflet hides
  the toggle while the panel is expanded and the panel then occupies the
  toggle's box. Chrome synthesises the click from a touch ~300 ms later
  and re-hit-tests at the touch point — by then the panel is there, so
  the click lands on the panel's first row and the dropdown never opens.
  `app.js` binds a `touchend` handler that toggles the panel
  synchronously before the synthesised click is dispatched. Without it a
  phone user cannot open the dropdown at all.
- **The ✕ is created on EXPAND, not only on layer change.**
  `mountLayersCloseButton()` early-returns while the panel is collapsed,
  and expanding it fires neither `overlayadd` nor `overlayremove` — so a
  MutationObserver on the panel's `class` attribute re-runs `attach()`
  whenever anyone expands it (the toggle, the touch handler, or Leaflet).
  Without it the panel opens with no close affordance.
- **Tapping outside an open panel also closes it** — Leaflet only does
  that for a mouse click.

Pinned by `tests/test_mobile_pins.js`.

## Popup Close Buttons

- **Every popup must render a close button.** Leaflet's own × is hidden by CSS (`.leaflet-container a.leaflet-popup-close-button { display: none !important }`) because a custom `.popup-close-btn` (desktop) / `.popup-close-btn-mobile` (mobile) replaced it. A popup without a custom button therefore has **no way to be closed at all** — the map is created with `closePopupOnClick: false`, so clicking the map does not dismiss it either.
- The search-result popup (`buildEventPopup`) shipped without one (2026-10-27) and so did the "N stories here" cluster popup and the Wikipedia marker popup. All three have it now.
- **The wiring is centralised**: `attachPopupClose(el)` finds `.popup-close-btn, .popup-close-btn-mobile` and calls `window.closeActivePopup()`. It is called from the central `map.on("popupopen")` handler (so a popup builder added later cannot forget it) and from `wirePopupActions()` / `wireEventPopupActions()`. It is idempotent — `el._xyzoCloseWired` stops the same element being wired twice.
- **THE LAYERS TOGGLE MUST ANSWER TOUCH DIRECTLY.** Leaflet hides the toggle while the panel is expanded and the panel then occupies the toggle's box. Chrome synthesises the click from a touch ~300 ms later and re-hit-tests at the touch point — by then the panel is there, so the click lands on the panel's first base-layer row and the dropdown never opens. Every other map control is fine (the zoom buttons answer to a touch), so this is specific to the toggle. `app.js` binds a `touchend` handler that toggles the panel synchronously before the synthesised click is dispatched. Without it a phone user cannot open the layers dropdown at all.
- **THE LISTENER MUST BE DELEGATED FROM THE POPUP ELEMENT, never bound to the button.** Leaflet's `Popup.update()` calls `_updateContent()`, and the popup content is a FUNCTION (`bindPopup(() => buildPopup(...))`) — so a zoom, a pan or a position change **rebuilds the content DOM and replaces the button**. The canvas pin path rebuilds it outright when the full pin data lands (`popup.setContent(buildPopup(pinData))`).
  A listener bound to the button is thrown away with the old node, and because the idempotency flag lives on the popup element `attachPopupClose` returned early and never wired the replacement — so the ✕ did nothing. The popup element survives the rebuild, so the listener goes there and resolves the button with `closest()` at click time. (Broken 2026-10-28; fixed by delegation.)
- The handler must call `window.closeActivePopup()` and **never `map.closePopup()`** — the latter skips `_isUserExplicitClose`, and the popupclose handler then auto-restores the popup 50 ms later, so the user cannot dismiss it. It must not call `stopPropagation()` either: that stops the capture-phase listener from ever seeing the click.
- Pinned by `public_html/tests/popup-close-button.bun.test.js` and `public_html/tests/mobile-close-popup-regression.bun.test.js`.

## A Popup Must Not Open While the Map Is Moving (2026-11-11)

**THE MEASURED BUG.** After a search on a **phone**, tapping a result
opened a popup at **558,−474 → 927,−94** in a 393×852 viewport: the **✕
Close was 464 px above the top of the screen and 441 px past the right
edge**, so it could not be tapped and the popup could not be closed.
**Four of the nine checks** in `scripts/search_mobile_audit.py` failed.

- **ONE HELPER WAITS FOR THE SETTLE: `openPopupWhenSettled()`.** The
  DOM-marker path, the **canvas-pin** path and the **event-marker** path
  all call it — each of them used to open the popup on its own timing.
  Leaflet's own `click → _openPopup` handler (registered by
  `bindPopup()`) opened the popup **synchronously**, 0 ms into the
  **700 ms** `flyToBounds` that `maybeZoomToCluster()` starts for any pin
  with ≥3 neighbours within 30 km — which, after a search, is nearly
  every pin. It is removed from both markers
  (`marker.off("click", marker._openPopup)`).
- **THE FALLBACK IS A BOUND, NOT A DEADLINE.** A 700 ms flight is
  **longer** than the 600 ms coarse-pointer wait, so a fallback that
  simply fired opened the popup 600 ms **into** the flight — the very
  bug. It **re-arms** while the map is moving (up to 3 s), and it fires
  **once** (a sequence number supersedes an earlier request).
- **`keepPopupOnScreen()` RE-FRAMES ON `moveend`/`zoomend`** — but never
  against a **user drag** (`_mapMoveByUser`): the popup is anchored to
  its pin, so the reader is allowed to walk away from it.
- **THE FRAMING PANS THE MAP, AND THE SIGN IS THE MAP'S.** `map.panBy(
  [dx, dy])` moves the map's **CENTRE** by (dx, dy), so the popup —
  anchored to its pin — moves the **OTHER** way. The correction is the
  **opposite** sign to the screen-space error. It had the same sign, and
  every correction pushed the popup further off: measured, the popup
  walked from 34 px past the right edge to **970 px above the top** in
  **four** corrections, each DOUBLE the last.
- **ROUND THE CORRECTION BEFORE THE ZERO TEST.** Leaflet rounds the
  offset itself and its `panBy([0, 0])` fires `moveend` **without
  moving** — a fractional correction fed the framing pass into itself
  and the reader got *"Maximum call stack size exceeded"*.
- **THE FRAMING RESERVES `#search-status`** (the line that says "All news
  in Chicago · 9 stories" — `position: fixed; bottom: 58px`, and it only
  exists **after a search**) and uses the **measured `--bottom-bar-top`**
  for the bottom edge, not the bar's height (~14 px short on a phone).
- **THE MOBILE "Details ▸" BUTTON IS NOT DEAD.** One class name —
  `.popup-details-content` — in the markup AND in `wirePopupActions()`.
  The mobile branch used to emit `.popup-details-full` while the wiring
  looked for the other name, so the keywords / related stories /
  locations / reports were unreachable on a phone.
- **`restoreActivePopup()`'s STANDALONE POPUP IS WIRED** like any other
  (close button + action buttons). The popup state carries the **pin
  data**, so a restored popup is not a dead one.
- **THE CANVAS SHIFT HACK READS THE POPUP'S OWN ELEMENT**
  (`e.popup.getElement()`), not a document-wide query — which returns
  the **first** popup in the document, possibly a fading one — and it
  **stops when the map settles**.
- **A SEARCH ENDS THE ONBOARDING TOUR** (`endTourForSearch()`). The
  tour card is the only thing the tour puts on the **pointer path**
  (z-index 9998, above the popup pane; a bottom sheet on a phone), and
  measured, the element at the ✕'s own coordinates was
  `xyzo-tour-title` — the tap landed on the tour, not on the button.
- **THE MOBILE GATE IS `scripts/search_mobile_audit.py`** — the first
  audit here that drives a **phone** (393×852, `is_mobile`, `has_touch`,
  real `touchscreen.tap`). Every other Playwright script in `scripts/`
  drives a desktop viewport, and the phone is where this broke.
- Pinned by `public_html/tests/search-mobile-popup.bun.test.js` (16).

## The Zoom Is the Reader's Choice (2026-11-13)

Owner ask: *"rather then autozooming in on a pin thats in a city we need
to give people the option after the popup opens to zoom in someplace in
the popup after they click on the news pin."*

- **A PIN CLICK DOES NOT MOVE THE MAP.** `maybeZoomToCluster()` used to
  fly the map to a city-level view of the pin's neighbours **unasked** —
  the reader's view of the world was taken away by a pin they had merely
  tapped. Both click paths (the canvas `_activatePin` and the DOM
  marker handler) now open the popup where the reader already is.
- **THE POPUP CARRIES THE ZOOM.** A 🔎 button in the **action row**
  (beside the coordinates and the satellite button), wired by
  **delegation from the popup element** — the popup's content is a
  function, so a listener bound to the button dies with the old node.
- **THE BUTTON ALWAYS DOES SOMETHING.** `zoomToPlace()` shows the
  cluster when three or more stories are nearby (`maybeZoomToCluster`
  now returns whether it zoomed) and the place itself otherwise, at
  `Math.max(map.getZoom(), 11)` — never zoomed out. **A button that
  does nothing is worse than no button.**
- **THE BUTTON IS IN THE ACTION ROW, NOT BELOW THE FOLD.** The popup's
  content is ~914 px in a ~380 px box: a control lower down is
  invisible **and** un-hittable (clipped content is not hit-tested).
- **THE OVERFLOW BADGE STILL FLIES TO ITS CLUSTER** — a cluster badge
  ("43 stories here") is not a story pin.
- **THE POPUP STILL WAITS FOR THE MAP TO SETTLE** — the small pan to
  the pin is an animation, and the ✕ Close moves with it.
- Pinned by `public_html/tests/popup-zoom-to-place.bun.test.js` (6).

## Writing a File Can TRUNCATE It, and `node --check` Will Not Tell You (2026-11-13)

- **`Path.write_text()` OPENS THE FILE IN "w" MODE — IT TRUNCATES
  FIRST, THEN ENCODES.** A Python string that cannot be encoded (a lone
  surrogate, say) raises `UnicodeEncodeError` **after** the file has
  been truncated: the file was left at **0 bytes**, and the LIVE SITE
  served an empty `app.js` until the token was bumped.
- **`node --check` PASSES ON AN EMPTY FILE.** An empty file is valid
  JavaScript, so the syntax check said nothing and the shell chain
  carried on to the next command.
- **SO: CHECK THE SIZE AFTER EVERY WRITE** (`ls -l`, or assert the
  length grew in the script), and never write a lone surrogate — use
  `\U0001F50E` or the literal character, not `\ud83d\udd0e`.
- A `?v=` bump is the recovery: `*.js` is served `immutable` for a
  year, so a reader who loaded the page during the window keeps the
  empty file until the token changes.

## The Owner Caught a Regression of This Session's Own (2026-11-12)

- **LEAFLET 1.9.4 HAS NO `setView`/`center`/`zoom` CONSTRUCTOR OPTION.**
  The vendored file has zero hits for `options.setView`; Leaflet's Map
  takes its view from `map.setView(...)` and nothing else. An option of
  that name is **silently ignored** and the map is left with **NO VIEW**,
  and every accessor then throws (`_checkIfLoaded` → *"Set map center and
  zoom first."*). So the FIRST pin fetch — the one that asks the map for
  its bounds — dies, and the reader gets a failure notice instead of
  markers. **Set the view on the line AFTER the constructor.**
- **AN ARRAY HAS NO `.lat`.** The boot view was built as
  `[lat, lng, zoom]` and read with `.lat` — undefined on an array — so
  the map was told `setView([undefined, undefined], undefined)` and
  answered *"Invalid LatLng object"*, which killed the rest of app.js
  (including the Firefox container-height fix). **Build it as an
  OBJECT.**
- **A SOURCE-SHAPE TEST PASSED AGAINST THE BROKEN CODE.** The first
  version of the first-load test asserted the shape, and the shape
  matched — the code read exactly as intended and did exactly the wrong
  thing. **A GATE THAT PASSES AGAINST BROKEN CODE IS NOT A GATE.** The
  behavioural gate is `scripts/first_load_audit.py`: it drives the
  shipped page in **Firefox AND Chromium** and asserts no page errors,
  that the map has a view, that the markers arrive, that the container
  has a height, that the link's overlays are on, and that the
  stale-data notice is NOT showing. **Firefox is in it because the
  failure only showed there.**
- **AN EXCEPTION IS NOT A NETWORK PROBLEM.** The banner used to say
  *"Connection hiccup — brief network issue — will retry automatically"*
  about a crash in the boot, which sends the reader looking for a
  problem on their side and promises a retry that cannot help. It now
  says **"Map problem"** for `kind === "exception"`.
- Pinned by `public_html/tests/first-load-speed.bun.test.js` (12,
  mutation-checked) and `scripts/first_load_audit.py`.

## The Markers Waited for the Browser to Decode 280 Tile Images (2026-11-12)

Owner report: *"markers seem to be taking a long time to load... it took
more then a few min when my friend tried to load"*, then *"seems to take
about 30 to 45 seconds... are you sure.???"*.

- **MEASURE THE FINISHED PAGE, ON THE READER'S NETWORK.** The first
  measurement said "6.8 s" and was wrong three ways: it measured the
  FIRST markers, not the finished page; it ran over the loopback; and
  it sampled `performance.getEntriesByType('resource')` while the heavy
  responses were **still in flight** (an entry appears only when the
  response has FINISHED). **The truth on a throttled slow-3G link: the
  pins arrive at t=10.6 s and the markers are painted at t=30.5 s.**
- **THE GAP WAS THE MAIN THREAD, NOT THE NETWORK.** The browser was
  decoding and painting the **280 tile images** of the eight raster
  overlays the link asked for, and the pin canvas drew after all of
  them.
- **THE INITIAL VIEW IS THE LINK'S VIEW.** The map used to be created
  at the world view (z2) and moved to the hash's view a moment later —
  so the browser asked for **16 world tiles it threw away**, and they
  competed with app.js for bandwidth. The hash is parsed BEFORE the map
  exists and the view goes in as the constructor's own view.
- **A `<link rel="preload">` IN THE HEAD IS NOT AN IDLE FETCH.** The
  browser starts it as soon as it parses the HTML: the 1.16 MB city
  index was the **first request on the page (t=0.30 s, before app.js)**
  and it stole the bandwidth app.js was waiting for. The preload is
  gone; the index is fetched when the reader touches the search box or
  the map. **And `requestIdleCallback` is not idle either** — it fires
  as soon as the browser has ANY idle time, which during a map boot is
  the moment it is waiting for app.js.
- **THE OVERLAYS ARE STAGED BEHIND THE MARKERS.** The basemap and the
  markers come first; the overlays are added a frame later. The names
  are recorded immediately, so the hash rewrite is unchanged. The total
  time to "everything" is the same; the time to a USABLE MAP is twenty
  seconds shorter.
- **THE FIRST VISIT IS STAGED TOO.** The curated "cool map" preset
  names thirteen overlays and reaches the map through the SAME
  `applyLayersFromParsedHash`, so the flag wraps the whole boot
  restore — the shared link's hash AND the preset.
- Measured: markers painted at **12.4 s (slow 3G)**, 4.2 s (4G),
  2.9 s (loopback) — against 30.5 s, 9.0 s and 11.5 s before.
- Pinned by `public_html/tests/first-load-speed.bun.test.js` (9).

## The Pre-Index Must Answer the SHAPE the Reader Asked (2026-11-12)

- **A SMALLER LIMIT IS SERVED BY SLICING A BIGGER STORED ANSWER.** The
  stored answer is the RANKED list and the ranking does not depend on
  the limit, so the first N of a 1,000-pin answer is exactly what the
  live query would have answered for N. Only `has_more` and
  `next_cursor` are recomputed (the cursor points at the last row kept).
  A limit BIGGER than anything stored falls through to the live query.
  Without this, a reader asking for 100 pins of a query stored at 1,000
  paid the whole live search for an answer already on disk.
- **THE PREFIX MATCH IS A `LIKE`, NOT A RANGE.** The stored key is
  `query | window | tag | limit`, so the rows for one query are a prefix
  of that key — but `>= prefix AND < prefix || U+FFFF` MISSES them,
  because the collation's idea of where U+FFFF sorts is not the byte
  order (measured). The table is a few thousand rows and the equality
  columns carry an index, so `LIKE prefix || '%'` is the right tool.
- **BUILD BOTH WINDOWS.** The builder's list is `["24h", "all"]`; the
  timer used to pass `--window 24h`, which restricted it to one — and
  "all" is the expensive one (the whole corpus), so it is the window
  that most needs a stored answer.
- Pinned by `api/tests/pins-search-preindex.test.ts` (8).

## The Related Stories Are Links, And a Background Job Is A Guest (2026-11-12)

- **THE RELATED STORIES GO TO THE ARTICLE.** The tree API carries each
  article's `url` — the publisher's own page — and the popup rendered
  the headline as plain text with a click that FLEW THE MAP instead. The
  headline is now a **link** (target=_blank, URL escaped ✓) and the **◎
  button** beside it is the map move, so neither action is lost. A
  reader who opens the tree wants the STORY, not a camera move.
- **A BACKGROUND JOB THAT SHARES A DATABASE WITH THE READER IS A GUEST.**
  The pre-index builder runs one heavy search query per entry (the
  ranking runs over the whole corpus), and running a thousand of them
  back-to-back took the box to **load average 23** — while a reader's
  markers took **minutes**. It now pauses **two seconds between
  entries** and builds **at most 60 per pass**; the timer asks for a
  slice, so the whole list still refreshes without starving the site.
  **MEASURE THE READER'S PATH BEFORE OPTIMISING THE JOB.**
- Pinned by `public_html/tests/popup-related-stories.bun.test.js` (5).

## The CHANGE MAP — three defects that froze the computer (2026-11-13)

Owner report: *"they do load however they freeze up the computer and
almost crash it.. rather then trying it out by clicking on it first make
sure it loads fast without selecting that setting because it will most
likely crash the system. try the other 'delta' modes too and speed the
load times up in general"*.

Measured on the real 24-hour delta (the 2026-11-12 → 2026-11-13
analysis, on the 1° field the archive holds):

- **THE LEVELS RAN FROM -180 TO +180 hPa** — the **longitude** range,
  applied to a chart about a *change* in pressure, which lives around
  zero. For the 0.10 hPa step that is **3,601 levels** where the field
  spans ~840, and every one of them is a full pass over the 65,160
  cells: **234 million cell tests**. The levels now come from the
  **field's own range** (`contourLadder` walks `first … last`, not
  `-180 … 180`).
- **THE FIELD WAS NEVER BLURRED.** The **live** chart is contoured from a
  Gaussian-blurred field (`worker/isobars.py::smooth_field` — σ = 2
  cells, **wrapping in longitude** and **nearest at the poles**), because
  the analysis carries structure below synoptic scale and contoured raw
  it breaks into thousands of fragments. The change map skipped that, so
  it contoured the GRIB's own noise — and a **difference of two fields is
  TWICE the noise**. `delta-contour.js::smoothField()` now applies the
  same rule (σ = max(2 cells, 0.5°/spacing)), which cuts the 0.10 hPa
  chart from 28,171 lines to 12,024 and gives the change map the same
  character as the live one.
- **THE WHOLE WORLD WAS CONTOURED AND THEN TRIMMED TO THE VIEWPORT**, so
  every pan paid for the whole globe. The client already holds the whole
  field (130 KB), so it contours **only the viewport's cells**
  (`cellRangeFor()` — the rows from the latitude, the columns a
  **WRAPPING** span because the grid is periodic).

**BEFORE → AFTER** (the shipped code, the real field, best of three
runs): the 0.10 hPa step goes from 4,247 ms / 28,171 lines / 916,632
points to **1,572 ms / 12,024 lines / 583,362 points** at the world
view, and from 5,372 ms to **41 ms** at a continent, 3,933 ms to **4 ms**
at a country, 4,154 ms to **0 ms** at a city.

**THE METRIC IS THE LONG TASK** — the main-thread block that freezes the
tab, measured by the browser (`PerformanceObserver` → `longtask`):
`scripts/delta_chart_check.py` (the change map) and
`scripts/isobar_speed_check.py` (the ordinary chart, which was never the
problem: 463 / 169 / **0 ms** at 0.10 / 0.25 / 1 hPa).

**A REWRITE OF THE HOT LOOP MUST BE PROVED, NOT ASSUMED.** The loop was
rewritten (it allocated ten arrays a cell) and the proof is a comparison
against the previous implementation over a whole synthetic field: the two
produce **byte-identical lines at every level**. **THE BUG THE REWRITE
NEARLY SHIPPED:** the 16 marching-squares cases list **PAIRS** of edges
(a saddle cuts two) and an early version walked the list as flat
elements — which drew a degenerate point instead of the saddle's two
segments and silently destroyed whole lines. **A SOURCE-SHAPE TEST PASSES
AGAINST BROKEN CODE** (the same trap the first-load gate fell into on
11-12): the proof has to be the OUTPUT.

**THE COST OF THE BLUR IS ONE PASS OVER 65,160 CELLS** (19–30 ms), paid
once per fetch — not per level.

Pinned by `public_html/tests/delta-contour.bun.test.js` (the saddle,
the blur, the range and the cell range) and measured by
`scripts/delta_chart_check.py`.

## The CHANGE MAP — the Δp chart (2026-11-12)

Owner ask: *"a 'secular' version of the pressure maps.. the 'change in the
last 24 hours map'.. 1 moon cycle meaning 29.(moon phase).. 1/4 (per season)
a year 1/2 a year 1/3 1/6 a year 1/8 a year 2/3 a year or one full
year"* — and *"we still want to support 0.10 hPa 0.25 0.5 1 2 4 8 16 hPa
for all the new maps as well"*.

- **THE ARCHIVE HOLDS THE FIELD, NOT THE LINES.** A difference of two
  sets of contour lines is not a field — you cannot subtract a polyline.
  `worker/pressure_delta.py` archives the 1° pressure field of every
  cycle (130 KB a cycle, **190 MB a year**) and the API differences two
  of them ON DEMAND, for any window and any past cycle. Storing the
  delta per window would cost **1.5 GB a year** for a field that is
  190 MB.
- **THE CLIENT CONTOURS IT** (`public_html/delta-contour.js`), which is
  what makes the whole ladder work: **0.10, 0.25, 0.5, 1, 2, 4, 8 and
  16 hPa all work from ONE fetch**, and the server never contours a
  delta — so there is exactly ONE contouring implementation for the
  change maps and nothing to drift.
- **THE GRID IS AT 0.05 hPa PER UNIT — THE GCD OF THE LADDER.** 0.25
  is NOT a multiple of 0.1, so a 0.1 hPa grid could not hold a 0.25 hPa
  level at all. The isobar worker already cuts at 0.05 hPa for exactly
  this reason; the delta grid uses the same lattice.
- **THE CHANGE MAP GETS ITS OWN DIVERGING RAMP** — blue where the
  pressure fell, red where it rose — because the pressure ramp means
  nothing on a map of differences. The scale is the largest |change| on
  the WHOLE map, so a line does not change colour as the reader pans.
  The labels are **signed and carry their unit**.
- **A WINDOW THE ARCHIVE CANNOT REACH IS A 404 THAT SAYS SO** — never a
  silent empty answer. The chips are greyed out with the reason.
- **THE PIECES ARE STITCHED.** Marching squares cuts a contour wherever
  the field grazes the level, so one line arrives as hundreds of pieces.
  The stitch rounds its keys (two cells sharing an edge compute that
  edge's crossing point in their own order, so the floats differ in the
  last bits) and walks BOTH ways (marching squares stores a segment in
  whichever direction its case listed the edges).
- Pinned by `api/tests/weather-delta.test.ts` (3) and
  `public_html/tests/delta-contour.bun.test.js` (8).

## The TIME MACHINE — a year of the weather maps (2026-11-11)

Owner ask: *"can we also save the 'maps' wind maps and temperature for 1
year.. so for example people can type in the date and see what it looks
like for the past year.. maybe also keep the time too.. if it takes less
then a few gigabyets its maybe worth it.. pressure wind temp and maybe
news for that day? why not?"*

**THE THREE WEATHER WORKERS REPLACE THE PREVIOUS CYCLE WHEN THE NEXT
ONE LANDS, so the past was not a lookup — it was gone.**
`worker/weather_archive.py` copies every GFS analysis cycle (four a day)
into `data/weather_archive/<cycle>/`, and
`GET /api/weather/archive/{wind.bin,temp.bin,isobars.json,meta.json}?at=<iso>`
serves it.

- **THE ARCHIVE KEEPS THE 1° GRIDS AND THE 4 hPa CHART — AND THE
  SIZE IS WHY.** Measured: **369 KB a cycle → 552 MB a year ✓.** The
  0.25° grids would be 6.2 MB a cycle (**9 GB a year**) and the
  0.05 hPa isobar lattice the worker cuts is **39,320 rows (297 MB) a
  cycle** (**350 GB a year**). The 1° grids are the same fields the 3D
  globe draws ("the SAME field, subsampled by the SAME worker run"), so
  the archive is a copy of something the site already serves.
- **IT COPIES, IT DOES NOT RE-COMPUTE.** A second implementation of a
  field is a second source of truth, and the second source of truth is
  the one that drifts. The archive copies the published grids and
  exports the isobar lines in the API's own item shape.
- **THE READER PICKS A MOMENT; THE ARCHIVE ANSWERS THE CYCLE THAT WAS
  IN EFFECT** — the nearest one at or before it. The stored files are
  gzip and are served **as gzip**, so the browser decompresses them
  transparently and the layer receives the bytes it expects.
- **THE THREE WEATHER LAYERS ASK THE ARCHIVE WHERE THEIR GRID COMES
  FROM** — and for their **own archived meta**: the live meta describes
  *today's* analysis, and a grid without its own meta cannot be drawn.
- **THE LAYERS HOLD THEIR GRID IN MEMORY, so a new moment must EMPTY
  THEM** (`resetForArchive()` on each layer) and re-add them — or the
  reader would be looking at today's wind while the panel says March.
- **THE NEWS DRAWN IS THE NEWS OF THAT DAY.** The window has BOTH ends
  (`since` and the new `until`), because `since` alone would be every
  story since that day.
- **THE MOMENT RIDES IN THE URL** (`?at=`, the way a search rides in
  `?q=`), so a past map can be shared.
- **THE ARCHIVE LIVES OUTSIDE THE WEB ROOT AND OUTSIDE GIT**
  (`data/weather_archive/`, gitignored): it is a runtime artefact, like
  `data/nn_models/`, and it is served through the API rather than as
  static files.
- **IT STARTS TODAY** — the fields were never stored, so there is no
  year of history to recover (README Q-N34).
- Pinned by `api/tests/weather-archive.test.ts` (7) and
  `public_html/tests/search-weather-archive.bun.test.js` (9).

## Hover HUD (`public_html/hover-info.js`)

One cursor-following card with three user-selectable modes (Off / Pins /
Everything), chosen in the control menu (⚙ → MAP → Hover) and persisted
in `localStorage["xyzo.hoverMode"]`. Study:
`docs/TOOLTIP_STUDY_2026-10-28.md`.

- **The canvas renderer feeds the HUD via `xyzo:pin-hover` CustomEvent**,
  reusing the hit-test it already runs for the hover ghost — never write
  a second hit-test per mousemove. `CanvasPinRenderer._handleMouseMove`
  dispatches with the already-computed `hitPin`; `_handleMouseLeave`
  dispatches `pin: null`. The leave listener must be a **bound method**
  (`this._onMouseLeave = this._handleMouseLeave.bind(this)`) so
  `disable()` can `removeEventListener` it — an anonymous arrow leaks.
- **"Everything" mode replaces the layers' own hover boxes, never stacks
  them.** `HoverInfo.suppressesProbes()` returns true only in that mode;
  every layer whose mousemove handler shows a hover box (climate, temp,
  wind, soil, mag, wave, cropland, etopo, lightning, phytoplankton) must
  check it before calling `updateProbe`. Without the check, three probe
  boxes fight the HUD for the same patch of screen — the exact problem
  the HUD exists to solve.
- **TWENTY-ONE LAYERS FEED THE HUD** (2026-11-05): isobars ⛅
  (interpolated between bracketing levels), climate, temperature, wind,
  wind speed, CAPE, IVT, waves, the OSCAR currents, soil, **the HWSD
  soil TYPE**, cropland/land cover, magnetic, lightning, phytoplankton,
  relief, rivers (nearest named within ~38 km), languages (nearest point
  within ~28 km), earthquakes, faults and the language regions. Each
  exposes `sampleAt(latlng) → string | null`; it must return null when
  the layer is off or its grid isn't loaded. The HUD additionally checks
  `isEnabled()` and wraps each call in try/catch — one bad sampler must
  not kill the card.
- **A LAYER THAT STANDS ITS OWN PROBE BOX DOWN MUST BE IN THE HUD, OR
  ITS READING VANISHES.** The HWSD soil-type layer was missing from
  `SAMPLERS`, and the effect was worse than a missing row: its own hover
  box **stands down** in "Everything" mode (every probe does, so the
  card never has two things saying the same thing), so with no HUD row
  to replace it the soil type was simply **not on the screen**. Measured
  on the live map: the box read "Technosols" and the card — coordinates,
  pin, nothing else — had no soil in it at all. **A probe box and a HUD
  row are two halves of one thing**: a layer may have either, and if it
  has the first it must have the second.
- **A PROBE THAT STANDS DOWN MUST GO AWAY, NOT FREEZE.** Every probe
  layer checks `HoverInfo.suppressesProbes()` on mousemove and returns
  early — but a box that merely STOPS UPDATING keeps the last text it
  was given, so it goes on saying the same thing the card now says.
  `hover-info.js` therefore announces the mode change
  (`xyzo:hover-mode`) and the layer **hides** its box when the card
  takes over. Two boxes stating one reading is the exact thing the HUD
  exists to prevent.
- **LINE layers (isobars, rivers) sample SEGMENT distance, not vertex
  distance.** A cursor in the middle of a long segment is far from every
  vertex — a vertex scan misreads "on the line" as "miles away", which
  is exactly the reading the HUD exists to give. Planar
  point-to-segment with `lng·cos(lat)` scaling; the isobar sampler
  blends against the nearest segment of a DIFFERENT level for the
  interpolated `≈1008 hPa`.
- **Per-layer on/off lives in `localStorage["xyzo.hoverHudOff"]`** (JSON
  array of window names). `HoverInfo.isSamplerEnabled(name)` /
  `setSamplerEnabled(name, on)`; the checkbox list
  (`#hover-sampler-list`, rendered only while mode is "all") wires one
  delegated `change` listener (`host._xyzoWired`). The HUD card itself
  stays `pointer-events: none` — the checkboxes live in the control
  menu, never on the card.
- **Expensive layers stay out of the HUD**: geology is a network fetch;
  basins are a 650k-vertex ray-cast. Both keep their click-Probe flow.
  Image-only overlays (salinity, ocean, Facebook, transportation) hold
  no numbers to read. Do not add any of them to `SAMPLERS`.
- **The HUD never steals clicks** (`pointer-events: none`) and hides on
  `movestart` (dragging) and container `mouseleave`. It is
  `position: fixed` on `document.body`, z-index 800.
- `hover-info.js` loads BEFORE `app.js` and is in `bump_frontend.sh`'s
  `ASSETS`. app.js calls `HoverInfo.init(map)` after the other layer
  inits; the control-menu picker buttons call `HoverInfo.setMode()`.
- Pinned by `public_html/tests/hover-info.bun.test.js` (module contract,
  13 samplers, toggle round-trip, exclusions) plus each layer's own
  `sampleAt` tests.

## Interaction Preferences — text size, double-click submit, saved styles, satellite offer

Owner spec 2026-10-29 (elderly-usability sweep). Control menu rows:
MAP → Text size; MY STYLE → Save this view. Pinned by
`public_html/tests/interaction-prefs.bun.test.js`.

- **Text size zooms INNER CONTENT ONLY.** `zoom` multiplies every
  specified length on the element — including `top: var(--panel-top)`,
  `height: calc(100vh …)` and a centered `transform: translateX(-50%)`.
  Zooming `.live-panel` itself pushes it down and past the viewport
  bottom; zooming `.bar-dropdown` slides it off centre. The target list
  (`.live-panel-header/list/status`, popup content wrapper,
  `explore-panel > *`, `#help-panel > *`, `.overlay-card > *`,
  `.bar-dropdown > *`, `.nav-links`) is inner content — keep it that
  way. Default is A+ (115 %): `html { --ui-zoom: 1.15 }`, with
  `html.ts-100` / `html.ts-130` overrides. An **early `<head>` script**
  applies the stored class before first paint — never move it after the
  stylesheet or the page flashes at the wrong size.
- **Double-click is the "add a story" gesture.** `L.map` is created
  with `doubleClickZoom: false` — the first empty-map click leaves a
  `.submit-hint` chip (`pointer-events: none`, so it cannot swallow the
  second click); only a second click within **500 ms / 40 px** reaches
  `openSubmitAtPoint`. Every probe's `blocksClick()` guard sits BEFORE
  this gate — arming a probe must keep working as a single click.
  Never re-enable `doubleClickZoom` without redesigning the gate.
- **RIGHT-CLICK IS NEVER INTERCEPTED — the native menu must survive.**
  Owner constraint 2026-10-29: Inspect / Save image / extensions on the
  map. A page cannot ADD items to the browser's context menu, so the
  satellite affordance hangs off the LONE click instead: 520 ms after
  the first click (just past the double-click gate) the `.submit-hint`
  chip morphs — `.is-satellite`, `pointer-events: auto`, text
  "🛰️ View satellite of this spot" — and clicking it opens
  `openSatellitePopup()`. A slower "double-click" was never a submit
  (the gate already closed), so the morph steals nothing; a real
  double-click calls `hideSubmitHint()` BEFORE `openSubmitAtPoint`, so
  the offer never floats over the submitter. Pins: no
  `contextmenu` listener may ever exist (`preventDefault` on it is
  forbidden), the morph sits inside `showSubmitHint` AFTER the gate,
  and the chip's own click `stopPropagation()`s (it lives inside the
  map container — a bubbling click would be a phantom tap).
- **The satellite popup: Esri mini-map + outbound links, never
  embedded Google/Bing tiles.** `openSatellitePopup()` opens a dark
  popup with a nested Leaflet map on the Satellite basemap's own
  World Imagery URL (`TILE_LAYERS["🛰️ Satellite"]._url`, attribution
  from its options), **PLAIN tiles (never `crossOrigin` — Esri answers
  Origin-bearing requests with flat placeholder JPEGs where a plain
  <img> of the same URL returns real imagery, and a tainted canvas
  cannot be read anyway so pixel-classifying plain tiles is
  impossible), starting at z12 (Esri has no z16 imagery for much of
  the world — ocean, interior Suriname: HTTP 200 + a flat #CCCCCC
  JPEG — which is what shipped as "the map doesn't show up";
  z12+ matches whatever the Satellite basemap itself can show there
  and the zoom buttons push in from there)**,
  `scrollWheelZoom: false` (the page keeps its wheel), plus
  `Google Satellite ↗` (`/maps/@lat,lng,16z/data=!3m1!1e3`
  — the satellite deep link; worst case it degrades to regular Maps at
  the same point) and `Bing Aerial ↗` (`style=a`). Linking out is free
  and legal; EMBEDDING their tiles would be a licence breach — see
  `docs/DATA_LICENSES.md`. The popup carries the house
  `.popup-close-btn` (the central `popupopen` → `attachPopupClose`
  wires it **by delegation from the `.leaflet-popup` element**), so the
  content root's `stopPropagation` must SKIP close-button clicks —
  stopping everything left ✕ dead (the 2026-10-29 bug). `click`/
  `dblclick` are `stopPropagation()`ed inside the content so mini-map
  pan/zoom can never reach the outer click gate (two bubbling taps =
  phantom submitter), the right-click menu is never touched (Inspect
  works over the popup and mini map), and the nested map is
  `.remove()`d on `popupremove` — a leaked Leaflet instance keeps
  drawing tiles forever. Coordinates wrap to [-180,180] before
  they enter a URL. Pinned by `interaction-prefs.bun.test.js`.
- **THE MINI MAP'S HOST IS FOUND THROUGH THE POPUP, NEVER BY A
  DOCUMENT-WIDE ID LOOKUP (2026-11-08).** Owner report: *"Uncaught
  Error: Map container is already initialized"* out of
  `openSatellitePopup`. `document.getElementById("sat-popup-map")`
  returns the FIRST element with that id in the DOCUMENT, and the
  popup pane can hold **more than one satellite popup at once** — the
  one fading out (Leaflet removes a closed popup's container **200 ms
  AFTER** the close) and any ghost the auto-restore re-opened. Leaflet
  **refuses to initialise a container that already carries a map**, so
  the wrong element means an uncaught error in the reader's console
  (the build runs in a timer, outside the try/catch) — and when it
  does initialise, it initialises the WRONG one, so **the popup the
  reader is looking at shows an empty grey box where the satellite
  should be** (measured in Firefox: a second satellite popup inside
  the fade put the map in the OLD, fading popup; the visible host had
  no `_leaflet_id` and no children at all). **THE RULES:** the host is
  `popup.getElement().querySelector(".sat-popup-map")` — the popup's
  OWN element; an element that still carries a `_leaflet_id` (an
  orphaned map — Leaflet re-sets a popup's content as innerHTML, which
  destroys the element the map was built on while the map keeps
  running) is **replaced with a fresh one** before the map is built;
  the pending build is **cancelled when the popup closes**; the popup's
  **`contentupdate`** event moves the map to the new element; and a
  failure is **logged** (`XLog.warn`), never thrown at the reader.
- **Saved styles replay through `applyLayersFromParsedHash`** — the
  same path a shared URL uses, so a saved style and a pasted link can
  never diverge. `applySavedStyle` does the REMOVAL half itself first
  (the hash path only adds); the isobar layer is not a
  `WEATHER_OVERLAYS` entry and needs its own
  `IsobarLayer.setEnabled(false)` + `__syncIsobarToggle()`, mirroring
  the hash-apply special case. Storage: `localStorage["xyzo.savedStyles"]`,
  newest first, capped at 8.
- The early text-size script in `index.html` reads `xyzo.textSize`
  (values `"100"` / `"115"` / `"130"`; missing = `"115"` default).

## First-Load Map Race (Firefox, cold cache)

`index.html` loads `styles.css` asynchronously
(`media="print" onload="this.media='all'"`). When the stylesheet has not
landed yet, Leaflet's `_initLayout` reads `position: static` and forces
`position: relative` **inline** — and the stylesheet's own
`#map { position: fixed; inset: 0 }` can never size the container after
that (a relatively positioned element with `inset: 0` is offset, not
sized). The map then stays **0×0** and the user sees no map at all.

Reproduced in Firefox on a cold first load (the stylesheet arrives after
the script): container 0 px tall, `style="position: relative"`, no tiles.
A reload worked because the stylesheet was already cached. Chromium
usually wins the race.

**Rule:** the fix (`fixMapPositionIfLeafletClobbered()` in app.js) must
re-check **after** the stylesheet is applied — on the link's `load`
event, plus timed retries and a `window.load` fallback. A check that
only inspects `cs.inset` at script-execution time never fires (the CSS
has not landed, so `inset` is still "auto"). A last-resort inline
`height: 100vh` keeps the map visible even if the stylesheet never
arrives (blocked by an extension, for example).

Pinned by `public_html/tests/map-first-load.bun.test.js`.

## Layers Dropdown (top-right stack icon)

The Leaflet layers dropdown is the **single place** for map layers. It
holds, in order: base layers → overlays (NASA imagery + Köppen climate,
each with an opacity slider) → **🔗 Story links** → the Köppen class key.

**Rules:**
- A row injected into the dropdown must be a **sibling** of
  `.leaflet-control-layers-overlays`, never a child: Leaflet rebuilds
  that list on every layer change, so a row inside it is wiped by the
  first overlay toggle.
- **…AND IT MUST BE A CHILD OF `.leaflet-control-layers-list`, NEVER A
  SIBLING OF IT.** Those are two different mistakes and only one of
  them is visible in the code review: the `<section
  class="leaflet-control-layers-list">` WRAPS the two lists Leaflet
  empties, **and it is the element Leaflet hides when the dropdown
  collapses**. `insertAdjacentElement("afterend", …)` on the *section*
  puts the row in `.leaflet-control-layers` — outside the scroll box
  and outside the toggle, so a **closed** panel (the state every first
  visit starts in) shows the row floating beside the stack button.
  Measured 2026-11-06 on the HWSD soil key: section `display:none` /
  0 × 0, legend **221 × 329 at (1207, 64)**, while `#soil-legend`
  mounted correctly measured 0 × 0. **Three elements, only one safe:**
  `.leaflet-control-layers-overlays` (emptied), `.leaflet-control-layers-list`
  (persists *and* collapses), `.leaflet-control-layers` (persists but
  escapes both). Use `section.appendChild(host)` — the pattern climate,
  geology and etopo already used. Pinned by `hwsd-layer.bun.test.js`.
- Nothing about a layer may float over the map. The climate legend and
  the links toggle used to be permanent panels in the right column —
  both live in the dropdown now (`mountLegendIntoLayersControl()` in
  climate-layer.js, `mountLinksRow()` in app.js).
- The Story links checkbox keeps the id `ctrl-links-toggle` so the
  existing `setLinksEnabled()` / `refreshLinksToggleTitle()` paths keep
  working; it is a plain Leaflet checkbox, so **do not** rewrite its
  text content (it carries the label).

## API Restarts & the 502 Storm (2026-10-23)

`xyzo-api` was restarted **28 times in 6 hours**: the api_watchdog
(`*/2` cron) treated a slow `/api/pins/stats` as a hung API, and the
unit's `ExecStartPre=validate-api.sh --quick` took **84 s** — so every
restart was an 84-second outage in which Caddy answered 502 (the
browser console filled with `/api/feed/live/stream` and
`/api/feed/links` failures).

Fixed:
1. `validate-api.sh --quick` now **skips the API timing sweep** (step 6)
   → the ExecStartPre takes <1 s and a restart is ~2.5 s (Caddy's
   `lb_try_duration 20s` covers the gap → no 502s).
2. The watchdog only restarts on a **liveness** failure (`/api/health`,
   `/api/version`) — a slow heavy COUNT is a load problem, not a hung
   process.
3. `/api/pins/stats` uses range scans over
   `idx_articles_pub_loc` (migration
   `2026-10-23-pins-stats-index.sql`) instead of one full scan of
   news_articles per call.

**After changing `api/src/`:** bump the `?v=` token in index.html —
`app.js?v=…` was missed on 2026-10-22 and cached browsers ran an API
without the Köppen overlay registration.

## Story Links (connection arcs)

`GET /api/feed/links` drives the edges from the **articles in view**
(newest 1,200) with a LATERAL over the source/target indexes on
`news_story_links` (36.6 M rows). The old form scanned the whole link
table with an OR of four geometry tests: 65 s per viewport, so the
browser's fetch timed out and the arcs never rendered. A viewport query
is now ~0.1–2 s.

## Story Tree (per-story relationship tree)

`GET /api/pins/:id/tree` and `GET /api/events/:id/tree` — the answer to
"click a pin → what else is connected to **this story**?". See
`docs/STORY_TREE_2026-10-27.md` for the full measurements.

**The pin is an EVENT; the link graph is ARTICLE↔ARTICLE.** A pin is a
cluster of articles (median 1 member, p99 = 40, worst = 3,212). The old
`GET /api/links/:articleId` answered for ONE article of that cluster, so
it returned nothing for most pins. The tree resolves the pin to its event
and ranks the whole cluster's neighbourhood.

**THE RANKING MUST NOT TRUST `link_strength`.** 89 % of `ai_detected` rows
sit in [0.9, 1.0] and the relationship model returns `same_story` at 0.99
for articles about different countries — the `ai_detected` links are
effectively a *same-language, same-day* matcher. The score is
`0.70·semantic_cos + 0.20·keyword_containment + 0.10·link_strength×type`,
and `ai_detected` carries a **type weight of 0**.

**NEVER split the `OR` into a BitmapOr.** `WHERE (source_article_id = v.id
OR target_article_id = v.id) ORDER BY link_strength DESC LIMIT n` cannot
preserve the index order, so it compiles to a Bitmap Heap Scan plus a
**Sort per article**. Split it into a `UNION ALL` of two ordered
`LATERAL`s and it becomes an Index Only Scan with a Limit.

**The fan-out must be bounded.** `JOIN LATERAL (SELECT … ORDER BY
link_strength DESC LIMIT n)` per member turns a 42.9 M-row table into an
index-only scan that stops early (22 ms for a 3,212-member event). Taking
every link of every member scanned 77,915 rows and took 1.5–3.5 s.

**`idx_news_story_links_src_cover` / `_tgt_cover` exist for a reason.**
Without a covering index the fan-out does a random heap read into the
25 GB table per link row, and a COLD query measured **26.6 s**. With the
covering indexes the same query is 84–552 ms.

**THERE IS A HARD CEILING.** The level query runs under
`statement_timeout = 6000` (`withTimeout()` in `story-tree.ts`); on a
timeout it re-runs without the semantic candidates and returns
`meta.timed_out: true`. The contract is 10 s per click.

**THE SEMANTIC SEEDS MUST BE THE CLICKED ARTICLE.** A stale cluster can
hold five unrelated stories (840 such clusters hold 25 % of all event
membership). One event contained a router-bug article AND eight Ballon
d'Or articles; seeding from an arbitrary member returned the Ballon d'Or
stories as "most related" to a router story. The seeds are the root
article plus its **verified** siblings.

**Siblings are filtered by cosine.** A cluster member is only "the same
story, another outlet" if its cosine to the clicked article's embedding is
≥ 0.45. The rest are counted in `siblings.excluded` — presenting them as
"same story, other outlets" is simply wrong.

**`xyzo-embeddings.timer` must stay enabled.** It was disabled from
2026-09-15 to 2026-10-27, which left every recent article without a
vector and Pass 3 of the story linker blind. The composed text is now
`title | title | summary[:150]` — the location and event type used to be
appended, which made two unrelated stories from the same city embed
almost identically. `--force` re-encodes rows that already have a vector;
the worker falls back to CPU on CUDA OOM (the shared GPU abandoned whole
batches — 8,192 articles lost in one backfill).

**HNSW updates leave dead entries.** After a bulk re-encode, `REINDEX
INDEX nn_article_sentence_embeddings_emb_hnsw_idx` is needed or the index
keeps returning pre-update vectors.

## Overlay Opacity Controls

Every entry in the Leaflet layers dropdown (the NASA imagery overlays and
the Köppen climate wash) gets an **opacity slider + % readout** next to
its checkbox, so an enabled layer can be dialled independently.

- Implemented in `public_html/overlay-opacity.js` (`window.OverlayOpacity`),
  loaded **before** `app.js`; `app.js` calls `OverlayOpacity.restore()` +
  `OverlayOpacity.mount(WEATHER_OVERLAYS)` right after it creates
  `L.control.layers(...)`.
- The slider lives **outside** the `<label>` (it is a sibling in a
  `.leaflet-overlay-row` flex row) — a slider *inside* the label would
  toggle the layer's checkbox every time it is dragged.
- Values are stored per layer name in `localStorage["xyzo.overlayOpacity"]`
  and re-applied on load, so a slider set last week is still in effect.
- **Every slider row carries a dotted leader** from the layer's name to
  its slider (`name · · · · · slider%`) — with 20+ overlays the pairing
  no longer reads by position alone (2026-10-29). `makeLeader()` in
  `overlay-opacity.js` builds a decorative span (`aria-hidden`,
  `pointer-events:none`); `mount()` and `mountRow()` insert it BETWEEN
  the label and the slider wrap (label → leader → wrap, or the dots
  land after the slider). The label flex is `0 1 auto` — it hugs its
  text so the leader fills the gap; long names still shrink/wrap.
  Pinned by `overlay-opacity.bun.test.js` (insertion order + CSS).
- Styles: `.leaflet-overlay-row`, `.leaflet-overlay-leader`,
  `.leaflet-overlay-opacity`,
  `.leaflet-overlay-opacity-val` (styles.css).

## Climate Overlay Rules (Köppen-Geiger)

- Overlay assets live in `public_html/data/koppen/` and are **generated** — never edit them by hand
- **The source is Beck et al. 2018, CC BY 4.0, 1 km**: `worker/data/koppen/Beck_KG_V1_present_0p0083.tif` (43200×21600, uint8, 1..30 with 0 = ocean). Rebuild with `python3 scripts/koppen_build.py`. Fetch the source from `https://ndownloader.figshare.com/files/12407516` (71 MB zip) if it is not cached.
- **Licence: CC BY 4.0** — no NonCommercial, no ShareAlike. This replaced the Peel et al. 2007 source (CC BY-NC-SA 2.5), which was the site's one licence exposure. See `docs/DATA_LICENSES.md` §4. Do not reintroduce a source with a restriction beyond attribution.
- **Never swap in `gdal2tiles.py`**: it mis-aligns this dataset's tile rows (overview geotransform drift) and silently shifts the climate zones north. The build warps to EPSG:3857 itself with `GRA_NearestNeighbour` and slices the pyramid by hand.
- **The build warps the SOURCE FILE straight to Web Mercator, never through a downsampled intermediate.** The pipeline used to re-read Beck at `RASTER_DEG = 0.05°` (5.6 km) and warp *that*, so the 1-km source was degraded 6× before the tiles were cut. `MER_SIZE` is now 32768 (1,223 m/px, within 1.3× of the source) and `max-zoom` 7 — `32768/128 = 256`, so z7 tiles slice the master raster **1:1 with no resampling**. Going to z8 would oversample a 928 m grid.
- **`MAX_NATIVE_ZOOM` in `climate-layer.js` must equal the pyramid depth.** It was 5 while the build produced 6, so every map zoom above 5 fetched z5 tiles and upsampled them — the deeper levels were dead bytes on disk. Raising the constant (not just the build) is what made the detail reachable.
- **The build probes 11 known locations (Sahara, Congo, Amazon, Arabia, Moscow, Siberia, Australia, US Great Plains, Antarctica, Svalbard, India's monsoon coast) against both the source raster and the warped raster, and refuses to publish on mismatch — **never bypass `verify()` / `verify_mercator()`**. Two probes encode Beck-vs-Peel differences: the Amazon interior is **Af** (Beck) not Am (Peel), and Beck has a **Csc** class the older map lacked.
- Class ids must survive the warp untouched → `GRA_NearestNeighbour` only, never bilinear/cubic on the classified band
- Tiles are `.png` → Caddy serves them `immutable` for a year. Bump `BUILD` in `public_html/climate-layer.js` when the assets change
- Overlay renders in its own `climatePane` (z-index 350): above `tilePane` (200), below `overlayPane` (400) where the pin canvas lives. **app.js creates the pane** (it owns the map) and calls `ClimateLayer.init(map)`.
- **The switch is the layers-control entry**: the overlay is registered in `WEATHER_OVERLAYS` as **"🌍 Köppen Climate"**, so it appears as a checkbox in the Leaflet layers dropdown next to the NASA overlays. There is NO separate floating control next to the Layers button — the dropdown is the single source of truth (and what the URL hash machinery reads).
- **The 30-class key lives INSIDE the same dropdown** (`mountLegendIntoLayersControl()` injects it into `.leaflet-control-layers-list`, below the overlay list). The dropdown is collapsed by default, so nothing about the climate is on screen unless the user opens the layer list. There is NO floating climate panel: the `<details id="climate-legend">` block was removed from `index.html`.
- **Probe** (tap-to-read, for devices without hover) sits next to the key title and is only shown when the pointer is coarse (`(pointer: coarse)` / `navigator.maxTouchPoints`) — Leaflet's own `leaflet-touch` class is useless here, desktop Chrome exposes `window.TouchEvent` too.
- **Bump the `?v=` cache-buster** in `index.html` whenever `app.js` changes. It was missed on 2026-10-22: `app.js` gained the Köppen registration but its token stayed at the older stamp, so cached browsers never got the overlay entry in the dropdown.
- `public_html/climate-layer.js` **must load BEFORE `app.js`** (app.js needs `ClimateLayer.getTileLayer()` to register the overlay). The module therefore cannot touch the map at load time — app.js hands it the map via `ClimateLayer.init(map)`
- The **Probe** toggle lives in the climate legend panel (top-right, next to the icon legend), which only appears while the overlay is on
- `window.ClimateLayer.blocksClick()` gates the click-to-submit flow while probe mode is on — app.js's map click handler must keep that guard
- The URL hash must not be rewritten before the map has restored its view (`_mapViewRestored` guard in `updateUrlHash()`) — otherwise the overlay's startup `updateUrlHash()` clobbers the position of a shared `#lat,lng,zoom` link

- **THE PRESET HASH CARRIES `iso=` AND `wind=<style>:<colour>` TOO.** `map-presets.js` parses only `base=`, `density=`, `overlay=`, `iso=` and `wind=` — the grammar a preset speaks is deliberately the same one a shared URL speaks, so a preset, a pasted link and a saved style can never diverge. A segment the parser does not know is **silently dropped**, which is how a preset naming the isobar detail opened at the reader's own step instead of the curated one. **`iso=` carries the line colour as well as the step** (`iso=4:red` — parsed with a regex, kept by `sanitizeState()` as `isoColour`), or a preset naming a colour would parse and then throw it away. Both segments are written by `getMapHash()` only when their layer is on, omitted when they are the default (the same rule as `density=`), applied before the layer is enabled, and carried by `captureStyle`/`applySavedStyle`/`captureMapState`.
- **EVERY Cool MAPS PRESET IS A GLOBAL VIEW — zoom ≤ 3** (owner rule, 2026-11-01). The guard test walks every preset and fails on any zoom above 3, so a future one cannot quietly ship zoomed in. The bound is `≤ 3`, not `== 3`: a farther-out preset (zoom 2) is *more* global, not less.
- **The step chips repaint in `setStep()`, not in the click handler.** A step that arrives in a link or in a preset changes the step with no click at all, so a painter reachable only from the handler leaves the dropdown saying "4 hPa" while the map draws 1 hPa. `paintStep()` is module-scope for exactly that reason.

## Isobar Layer Rules (pressure contours)

- The source is **NOAA NCEP GFS `PRMSL`** (mean sea-level pressure), **0.25° global** — free, no key, no rate limit, public domain. There is no free isobar tile service, so the lines are computed, not fetched as tiles.
- **Do not swap in Open-Meteo.** It serves MSLP as plain JSON with CORS, but its free tier counts **each location as one call** (600/min, 10,000/day) — a global grid does not fit. GFS it is.
- `worker/isobars.py` contours the field with marching squares at **0.05 hPa** and replaces the whole `weather_isobars` table in one transaction. **The interval is a BUILD PARAMETER recorded in `weather_isobars_build`** — the no-op guard compares the cycle AND the product AND the interval, because moving from 1 hPa to 0.25 changed neither of the first two and the finer set never shipped until the third was added. `xyzo-isobars.timer` polls every 15 min (the analysis is 6-hourly; see "The GFS Poll Cadence" below). The published set is a **superset** of the classic 4 hPa synoptic chart — the contour of one level does not depend on the interval used to enumerate the levels, so the API's `step` param (`0.1|0.25|0.5|1|2|4|8|16`, default 4) thins ONE dataset instead of holding two copies, and 4 reproduces the classic chart exactly.
- **THE INTERVAL MUST BE THE GCD OF EVERY OFFERED STEP — and it must stay one uniform number.** Adding a 0.10 chip does not work by editing the chip: a step is only honest if every multiple of it is in the table, and `0.1` is not a multiple of `0.25`, so `step=0.1` against today's lattice returns **only every 0.5 hPa line while the chip claims 0.10** — a well-formed response that lies. The ladder's GCD is `0.05` (0.1 = 2×0.05, 0.25 = 5×0.05, 0.5 = 10×0.05 …), so 0.05 is the coarsest uniform cut that serves every chip, and **every entry in `STEP_CHOICES` must be a whole multiple of `ISO_INTERVAL_HPA`** — `isobar-step.bun.test.js` reads both files and asserts exactly that, because no test downstream can see the failure: the API's enum accepts the step and returns a perfectly well-formed subset. A **cheaper cut exists and is rejected**: the union of the 0.1 and 0.25 lattices is 12 levels per hPa instead of 20 (40 % less contouring; 8 of every 20 levels published now are unreachable by any current chip) — but `interval_hpa` is ONE number and a partial lattice cannot be described by it, so recording `0.05` for a union would make a later genuine 0.05 cut look already-published. That is the "finer set never shipped" trap, and 40 % of a background build is cheaper than it.
- **A FINER INTERVAL IS NOT A NOISIER CHART — the noise lives in the FIELD, not in the choice of level.** The Gaussian smoothing (`FIELD_SMOOTH_SIGMA_DEG = 0.5`) takes the analysis-scale wobble out BEFORE the contour is cut, so halving the interval adds lines without adding fragments. Measured on the 2026-11-02 12Z GFS analysis: **76.6 % at 2 hPa and 76.9 % at 1 hPa** of lines shorter than 20° (under 5°: 58.8 % against 59.1 %). **Measured again on the 2026-11-05 00Z GFS analysis, all the way down: 54.8 % at 1 hPa, 55.0 % at 0.5, 54.8 % at 0.25** (under 5°: 20.0 %, 19.5 %, 19.5 %) — and the line count doubles each halving (**1,117 → 2,240 → 4,459**), then scales with 1/interval (**4,531 → 11,266 → 22,544 lines** at 0.25 / 0.1 / 0.05. **Measured again on the 2026-11-06 18Z GFS field all the way down to 0.05: 39.9 % at 0.25, 39.7 % at 0.1, 39.7 % at 0.05** of lines shorter than 20° (under 5°: 12.9 / 12.8 / 12.7 %) — flat across a five-times-finer cut). The two series differ because they were measured over different boxes with different arc definitions; what matters is that the share does not GROW as the interval shrinks. If it ever starts climbing, the smoothing is what broke — not the interval. The superset property is pinned by `worker/tests/test_isobars.py::test_the_fine_set_is_a_SUPERSET_of_the_coarse_one`, which asserts the 4 hPa levels are **vertex-for-vertex identical** to the 1 hPa set's multiples of 4, and by `api/tests/weather-isobars.test.ts`, which seeds its OWN rows (the test DB's `weather_isobars` table is empty — a test that returns early on an empty table passes forever and checks nothing).
- **The step chips are EIGHT now (`0.1 / 0.25 / 0.5 / 1 / 2 / 4 / 8 / 16`) and they must carry `soil-prop-btn`.** The container class `.soil-prop-switch` only styles the ROW (flex + gap); the buttons need the class of their own, like every other chip in that white dropdown. Without it they rendered as bare default `<button>`s. **Every step on that ladder must be a whole multiple of `ISO_INTERVAL_HPA` (0.05)** — see the GCD rule above. The 0.1 chip's label is the one label written **`0.10 hPa`** rather than the raw number, because that is the name the owner asked for it by; every other chip still prints its own value unchanged.
- **THE DETAIL STEP IS IN THE URL, AS `/iso=<hPa>`.** The hash is the promise "share the exact map", and the step was the one isobar setting the promise did not keep: it lived only in `localStorage["xyzo.isobarStep"]`, so a link reproduced the layer but not the setting and the reader got **their** step, not the sender's. Three rules, each load-bearing:
  - **Write it WHENEVER the isobars are on — including at the default 4.** Omitting it at the default leaves the reader's own stored step to decide, so a sender on 4 hPa hands a receiver on 1 hPa a link that opens at 1 hPa: the same map, different lines.
  - **A link's step is a VIEW, not a preference.** `setStep(step, { persist: false })` skips the localStorage write, because opening someone else's map must not overwrite the reader's own stored choice — the same rule every layer preference follows at boot.
  - **The step is applied BEFORE the layer is enabled.** `setStep()` only refetches when the layer is already on, so step-then-enable costs ONE fetch instead of two — and it is the fetch that carries the right step.
  Pinned by `public_html/tests/isobar-step.bun.test.js`.
- **THE LINE COLOUR IS CHOOSABLE, AND IT IS IN THE URL TOO, AS `/iso=<hPa>:<colour>`.** Owner ask: *"can we have a way to select the color of the pressure lines near the detail switch — for example red is easy to see… or various random styles?"* A second chip row (`#isobar-colour-switch`, `.soil-prop-switch` / `.soil-prop-btn`, mounted by `mountColourControl(stepRow)` from **inside `mountStepControl`** — app.js must never mention it, that would be a second source of truth) sits directly under the detail switch with **six** choices, each carrying a **DOT** so the reader picks by looking. Rules, each load-bearing:
  - **Two FAMILIES, because they answer two different questions.** A single **INK** (`red` / `white` / `black`, carrying an `ink:` hex) answers *"where are the isobars?"* on a basemap that swallows them — the pressure is then read from the labels and the probe, not from the hue, and `resolveColourStops()` returns **null** so `isobarColor()` paints every line the same colour. A **RAMP** (`pressure` / `rainbow` / `turbo`) keeps the pressure encoded in the hue; a scheme is applied with `RampStyles.recolor()`, which rewrites the COLOURS and keeps the POSITIONS, because the pressure is what the probe reads and the labels print. **Every non-ink id must exist as a key in `ramp-styles.js`'s `RAMPS`** — a chip naming a scheme the palette does not have silently falls back to the published key, so the reader picks "Turbo" and gets "By pressure" with nothing saying so.
  - **`COLOUR_CHOICES` MUST BE DECLARED ABOVE THE `state` LITERAL.** The literal calls `readStoredColour()`, which reads that list; a `const` below it is in its **temporal dead zone** and the WHOLE module fails to evaluate — no `window.IsobarLayer`, no layer, no isobars, and no line of the file ever runs. This shipped: the isobars were dead on the flat map while the globe (which has its own copy of the ramp) kept drawing, and the error was swallowed. A source-order test pins it, because that is exactly the bug a runtime test only catches by loading the page.
  - **Changing it REPAINTS, it never refetches.** The level rides on the polyline (`level: level`), so `repaintLines()` walks the group and re-reads each line's own pressure from the new scheme. `setColour()` drops the cached `state.colourStops` (set it to `undefined`) **before** repainting — a cached stops array makes every chip after the first a no-op — and must contain no `refresh()` / `fetch()` / `state.loaded = null`.
  - **The colour is written ALWAYS, not only when it differs from the default** — the same reason the step is: omitting it leaves the RECEIVER's stored scheme to decide, so a sender on "By pressure" hands a receiver on "red" a link that opens in red. It is **applied before the layer is enabled** and with **`persist: false`** (a link is a VIEW), exactly like the step, and the layer announces it with a `xyzo:isobar-colour` CustomEvent that app.js turns into a hash rewrite.
  - **The globe must mean the same thing by the same token.** `globe.html` loads the shared **`ramp-styles.js`** (it is in `bump_frontend.sh`'s *globe* stamp loop as well as the flat ASSETS list — a tag the stamp loop does not know about keeps a stale `?v=` forever), `ISO_INKS` in `globe.js` mirrors the flat map's three hex inks (a test compares them), `resolveIsoStops()` runs through the same `recolor`, and its hash writer emits `iso=<step>:<colour>` **always**. Its `globeIso()` reads the segment with a **regex**: `Number("1:red")` is NaN and the validity check would drop the whole segment.
  - **The swatch is the colour itself, or the scheme's own gradient** (`swatchFor()`), never a promise of a colour the map does not draw.
  Pinned by `public_html/tests/isobar-colour.bun.test.js` (26 tests: the two families, the source order, the repaint-without-refetch, the URL grammar in all three readers — app.js, map-presets.js, globe.js — and the globe's ink parity).
- **THE CHANGE MAP'S WINDOW IS IN THE URL TOO, AS `/delta=<window>`.** Owner ask (2026-11-14): *"can you make sure the url is updated when someone clicks on `<button … data-delta="24h">24 h</button>`"*. The window lived only in `localStorage["xyzo.isobarDelta"]`, so the chip changed the map, the address bar did not move, and the **share button copies `location.href` VERBATIM** — a reader who switched to the change map and pressed Share handed over a link to the ORDINARY chart. The change map is a **different picture of the same atmosphere**, so it travels with the step, the colour and the analysis. Rules, each load-bearing:
  - **Write it ONLY when a window is chosen** — the ordinary chart is the default and there is exactly ONE way to spell it, so a segment that says "the default" can only add a way to be wrong. This is the **one** isobar segment that is *not* written always (the step has eight values, and the reader's own stored one would decide otherwise).
  - **A link's window is a VIEW, not a preference.** `setDeltaWindow(win, { persist: false })` skips the localStorage write.
  - **It is applied BEFORE the layer is enabled**, because it decides WHAT the fetch asks for (`/api/weather/pressure/delta?window=…` instead of `/api/weather/isobars`) — one fetch, carrying the right window.
  - **Only the windows the layer OFFERS are accepted** (`DELTA_WINDOWS`). A hand-edited link must not be able to ask the archive for a window that does not exist.
  - **The chip row is repainted from `setDeltaWindow()` ITSELF** (`paintDeltaRow()`), because a window can arrive with NO click at all (a link, a saved style) and a chip row that says "pressure" while the map draws the change map is a control lying about what is on screen.
  - **The URL moves BEFORE the archive answers** — the reader pressed a chip; the address bar should say so at once. The layer announces it with a `xyzo:isobar-delta` CustomEvent and app.js turns that into a hash rewrite.
  - **THE SAME GRAMMAR IN ALL THREE READERS** — app.js (the URL), `map-presets.js` (a preset and the auto-saved last-used map) and the saved style ("MY STYLE"), so a preset, a pasted link and a saved style can never diverge.
  - **A PASTED LINK IS A SAME-DOCUMENT NAVIGATION** — the page does not reload, so the boot-time restore never runs and the `hashchange` handler is the only thing that can apply the link. It now applies the step, the colour, the analysis **and** the window; before, it enabled the isobar layer and left every one of its settings behind, so pasting `/iso=0.25:red/delta=24h` into an open tab promised a picture the map was not drawing.
  - **THE GLOBE AND THE TIME MACHINE DO NOT HONOUR IT** (README Q-N41): the globe carries the segment through as a "flat only part" and draws the ordinary chart, and an archived moment wins over the window by design.
  Pinned by `public_html/tests/isobar-delta-url.bun.test.js` (15) and measured by `scripts/isobar_delta_url_check.py` (Playwright, the live site).
- **THE HASH MUST DESCRIBE THE VIEW, NOT THE PREFERENCE.** `overlayOpacityFor()` reads the **live layer opacity**. The stored opacity is the *preference*, and the two disagree exactly when a shared link set an opacity: the link's value goes on the layer, and the boot snapshot then rolls the stored preference back (a link is a view, not a settings change). Reading the store first is what made the URL describe the preference instead of the map — the picture said 35 % and the link said 85 %. **A link's opacity is a VIEW value too** (`OverlayOpacity.applyView()`): it goes on the layer and the slider, it is remembered so the slider remount cannot clobber it (the remount re-applies the stored value, and it runs a tick after the boot snapshot — so without the override the link's opacities were silently discarded milliseconds after being applied), and it does **not** touch the store. The reader moving a slider ends the override: a choice wins.
- **The order of the contouring steps is load-bearing.** The field is Gaussian-smoothed (σ = 2 cells) → contoured → **merged → Chaikin-rounded → Douglas-Peucker-thinned**. Three couplings break the result if you reorder them:
  - **The DP tolerance must stay below the amplitude the Chaikin rounding leaves behind** (~0.06°). At 0.04° the simplification undid the smoothing and the staircase came back.
  - **The field must be smoothed before contouring**, not after — rounding the finished polyline does not remove the analysis-grid staircase, it only rounds each step.
  - **THE MERGE MUST RUN BEFORE THE ROUNDING, AND THE ROUNDING MUST BE THE LAST WORD.** These are two halves of one fact. `merge_isobars()` decides that two pieces are the same isobar by asking whether the next piece's start projects ONTO the previous piece's last segment — an overlap that exists only in the RAW marching-squares geometry, because the contour cut the same corner twice. Chaikin MOVES those ends, the projection test starts failing, and the pieces stop joining. And Douglas-Peucker replaces a curve with straight chords, so a tolerance above the Chaikin amplitude shaves the rounding straight back off — which is why "more Chaikin" on its own changed almost nothing (measured on the real GFS analysis: two extra rounds moved the share of sharp vertices from 2.9 % to 2.8 %, and a LOOSER DP made it four times worse). The old order (round → thin → merge) therefore did not merge most of the pieces at all: every isobar came out broken into ~4 fragments, and **every fragment's end was a hard edge on the map**. Measured on the 2026-11-02 18Z GFS analysis at 2 hPa, whole world: **2,145 lines → 549 lines**, vertices turning more than 40° **2.90 % → 0.68 %**, p95 turn **33.2° → 23.5°**, and the p95 offset from the pressure field **0.195 → 0.170 hPa** — *more* accurate, because a continuous contour is a better contour than four pieces of one. Measured on the PUBLISHED 1 hPa data over the North Atlantic, before → after: hard corners (>40°) **2.46 % → 0.48 %**, the worst corner **125° → 104°**, and the lines in that box **336 → 64** — one continuous curve each. Pinned by `worker/tests/test_isobars.py::TestContourOrder` (mutation-checked: restoring the old order fails it).
- **Merge the pieces into continuous isobars before storing them.** A contour arrives as thousands of pieces — marching squares cuts the line wherever the field grazes the level, and the stitch cannot rejoin them because their ends do not coincide. `merge_isobars()` joins pieces that genuinely OVERLAP; the world goes from ~5,000 pieces to ~1,000 continuous isobars. Two consequences: the map draws ~1,000 SVG paths instead of ~5,000, and the piece that used to bridge a break is now part of a long chain, so the length rule can no longer throw it away and open a gap. **The merge has to run on the RAW pieces — see the ordering rule above; rounding them first is what stopped it merging.**
- **The join must be a real overlap, not just a near neighbour.** Two pieces whose ends are within `MERGE_TOL_DEG` are often two ADJACENT PARALLEL STRANDS of the same isobar, not two halves of one line. Joining those doubles the line back on itself, which shows as a 0.25° staircase — 45 px at zoom 8. The test is that the next piece's start must project ONTO the previous piece's last segment (the parameter along that segment between 0 and 1); if it does not, they are separate strands and must be left apart. The piece whose END is the junction is flipped, and the previous piece's overshoot is cut off at the junction — a naive concatenation leaves a visible back-step, and joining the wrong end teleports the line across the map.
- **Use `ST_Simplify`, not `ST_SimplifyPreserveTopology`, in the isobar query.** The isobars are independent lines that never touch, so preserving topology buys nothing and costs 10x (74 ms against 7 ms for the whole query).
- **Filter short fragments on CONNECTIVITY, never on length alone.** A contour arrives as several pieces wherever the field grazes a level, so `filter_short_chains()` drops a short piece only when it has **fewer than two neighbouring chains of the same level** (see `BRIDGE_TOL_DEG`). Two neighbours = it bridges a break in an isobar and must stay; one = a hair off the line; zero = a speck. A plain "keep lines longer than 2°" rule removed the bridging pieces and made the isobars visibly stop and start — 197 confirmed breaks from 4,342 dropped fragments.
- **Resolve the marching-squares saddle cells with the asymptotic decider** (the value at the cell centre). Picking one pairing blindly makes the contour cross itself — a visible "lightning bolt".
- **Contour on a torus** (two copies of the grid side by side) and clip to the window afterwards. Rolling the grid and duplicating one column instead leaves a seam, and a line that crosses the antimeridian is cut in two.
- **Drop the polar rows before contouring** (|lat| > 85°). Every longitude on a pole row shares one latitude, so a contour that lands there becomes a perfectly straight line along the pole.
- **The stitch must follow the geometry.** At a branch point several segments share a node; taking any free segment teleports the line across the map. Pick the candidate whose direction continues the line (cosine similarity).
- **The clip must cut at the side the line went out of.** Picking the wrong boundary produced a wildly interpolated point (a latitude of -168 when its neighbours were at -45) and a line that shot across the map.
- **Import `worker.db` (psycopg) BEFORE `eccodes`.** The other order makes the interpreter segfault while tearing the two native libraries down: the work completes, but systemd records the run as SIGSEGV and the timer looks failed. `worker/isobars.py` imports `.db` at module level for exactly this reason, and exits via `os._exit()`.
- **`weather_isobars.geom` is GEOMETRY, not GEOGRAPHY.** PostGIS's geography `&&` computes a *geodesic* bbox: for a viewport wider than the globe it raises `Antipodal (180 degrees long) edge detected!` or silently returns a handful of rows instead of the whole world.
- The **checkbox lives under the base layers** in the layers dropdown, but it is injected into `.leaflet-control-layers-list` — the **parent** of `.leaflet-control-layers-base` — with `base.insertAdjacentElement("afterend", row)`. Leaflet's `Control.Layers._update()` empties **both** `_baseLayersList` and `_overlaysList` and rebuilds them on every layer change, so a row *inside* either one is wiped by the first overlay toggle.
- The isobar row gets its opacity slider through `OverlayOpacity.mountRow()` (it lives outside the overlays list, so the generic `mount()` never sees it).
- The layer renders in its own `isobarPane` (z-index **360**): above `climatePane` (350), below `overlayPane` (400) where the pin canvas lives.
- **Labels are placed in screen space and re-placed on every view change** (`drawLabels()`), because the contour vertices sit on the 0.25° analysis grid. Three rules are load-bearing:
  - **A label is spaced ALONG a line, not one per polyline** (`LABEL_SPACING_PX`). A single isobar arrives as many short chains; one label per chain stamped "1020" twelve times in a row on one line. A chain shorter than half a spacing still gets one label at its own midpoint, or a fragmented isobar goes unlabelled altogether.
  - **Only lines that are on screen are labelled**, ranked by their *visible* length (`b.visible - a.visible`), not their total length. Otherwise an isobar that is mostly off-screen eats the label budget and the viewport shows nothing.
  - **Same-level labels are de-duplicated by distance** (`LABEL_MIN_GAP_PX`). Without it every fragment of one isobar independently puts its value on the map.
- The **first fetch waits 600 ms** for the map view to settle. On a shared link the map starts at the boot view (the whole world) and moves to the linked position a moment later — fetching straight away pulled 253 KB of world-wide isobars for a city-level view (now 49 KB).
- **The layer refetches when the viewport wants more detail than it is holding.** The API simplifies to the viewport (`span / 2500`, clamped 0.015–0.2°) and returns that value as `tolerance`; `loadedCovers()` refuses to reuse data whose tolerance is more than twice the one the current viewport wants. Without this, switching the layer on at world zoom returned 0.2° data and it stayed angular all the way down to city zoom.
- `public_html/isobar-layer.js` **must load BEFORE `app.js`**, and its asset must be in `scripts/bump_frontend.sh`'s `ASSETS` list — a new frontend file that is not stamped keeps a stale `?v=` and cached browsers never load it.
- `public_html/isobar-debug.html` draws the isobars on a blank background — the only way to judge the line quality without the basemap and the pins in the way. `?view=lat,lng,zoom&src=<url>`.

## Temperature Overlay Rules (GFS 2 m colour field)

- The source is **NOAA NCEP GFS `TMP` at `2_m_above_ground`**, **0.25° global** since 2026-11-04 — free, no key, public domain, on the same 6-hourly cycle as the pressure lines. Both workers share `fetch_grib_field()` / `decode_field()` in `worker/isobars.py`.
- **Fetch the 0.25° product (`suffixes=("0p25",)`) — the 1° rule is REVERSED.** The temperature was published at 1° until 2026-11-04, on the reasoning that *"the colour barely changes across a grid cell"* — measured, the same cycle at 1° and at 0.25° agrees to a median of 0.0 °C and is at worst **2.4 °C** out (at Sydney, where the sea and the continent meet). It was also the odd one out beside the **0.25° isobars**. The cost is 1.98 MB raw / ~0.7 MB gzipped against 68 KB, and it is paid only by the readers who switch the overlay ON. **The globe reads the 1° copy** (`grid-1deg.bin` + `meta-1deg.json`) — the SAME field, subsampled by the SAME worker run, so the two cannot disagree.
- **Never build this overlay as PNG tiles.** Every `*.png` under `public_html` is served `immutable` for a year, so a regenerated pyramid is invisible behind a stale version token — the incident that hid the Köppen layer on 2026-10-22. `grid.bin` and `meta.json` are not in Caddy's immutable list, so they revalidate. The layer is a custom `L.GridLayer` whose tiles are painted in the browser instead.
- **Tile rows must be linear in MERCATOR y.** These are Web Mercator tiles, so sampling in latitude would shift the temperature bands against the basemap; sample through `tileLat()` (the inverse Mercator transform). An `imageOverlay` was tried instead and rejected: it spans one copy of the world, so panning past the antimeridian left a visible gap.
- **`createTile` must call `done()` asynchronously** (`setTimeout(…, 0)`). Leaflet inserts the tile only after `createTile` returns, and `_tileReady` only marks a tile loaded if it already knows about it — calling back synchronously left every tile at `visibility: hidden`, i.e. painted but invisible.
- **Bake the field once, then blit.** `createTile` must NOT sample the grid per pixel: at 65k bilinear lookups a tile it cost ~23 ms a tile, half a second for a screenful and 2 s for a full redraw. The field is painted once into a single 1024² canvas (`buildBaked()`, ~68 ms) and every tile is then a `drawImage` of the right sub-rectangle (~0 ms). 1024 is ~2.8 px/degree against a 1° source — finer than the data, so a bigger canvas only costs time (the bake is quadratic: 260 ms at 2048). Tiles that straddle the antimeridian are drawn as two blits, not clipped.
- **A bare `GridLayer` has no `setOpacity`**, unlike `TileLayer`, and the layers dropdown calls `setOpacity` on every overlay. The subclass must provide it or the slider throws.
- **The probe and the colour must read the same buffer** (`state.grid`), so the number under the cursor is the colour under the cursor. A second data source would eventually disagree with the ramp.
- **Both units, always**: the legend carries a °C row and an °F row derived by `fOf()` (never duplicated arithmetic), and the probe prints both — `23.7℃ 74.7℉`.
- **The colour scale is ADAPTIVE, not fixed.** `choose_range()` takes the 2nd/98th percentile of this run's field and rounds to 10 °C. A fixed −80…+50 bar spends 130 °C of colour on a day whose range is only ~90 °C, so the mid-latitudes collapse into a thin slice of the spectrum and neighbouring temperatures look the same — that is the "flat" look. Guard rails: never narrower than 60 °C (a calm week would saturate the whole map) or wider than 130 °C. The ramp stops are defined as **fractions** and converted to degrees per run, and the legend ticks come from the chosen range, so the client never hard-codes a range.
- `worker/tempmap.py`'s **`verify()` is a gate, not a checkpoint**: it checks relationships (the equator must beat the poles by 30 °C, the range must be air on Earth) because a row-order decode bug still produces a plausible-looking temperature map. Never bypass it.
- The legend is injected into `.leaflet-control-layers-list` (the parent of the base/overlays lists) — never into a list Leaflet empties. Same reason as the climate key and the isobar row.
- `xyzo-tempmap.timer` runs `python3 -m worker.tempmap` every 15 min (the analysis is 6-hourly; see "The GFS Poll Cadence" below). Like the isobar worker it exits via `os._exit()` and imports `worker.db` before `eccodes`, or systemd records a SIGSEGV on a successful run.
- The **Probe** button in the legend arms tap-to-read on touch devices; while armed, `TempLayer.blocksClick()` must keep returning true and app.js's click-to-submit guard must stay.

## Wind Overlay Rules (GFS 10 m streamlines)

- The source is **NOAA NCEP GFS `UGRD`/`VGRD` at `10_m_above_ground`**, 1° global — free, no key, public domain, on the same 6-hourly cycle as the isobars and the temperature map. All three share `fetch_grib_field()` / `decode_field()` in `worker/isobars.py`.
- **THE PHYSICS IS NOT THE PROBLEM — the rendering is.** `u` is eastward, `v` is northward, and a degree of longitude is `111320 · cos(lat)` metres, so the same ground distance covers fewer degrees the further north you go. `worker/gfs_verify.py` checks the result against the geostrophic balance (the wind runs roughly along the isobars, with the low on its left in the northern hemisphere), and on a Web Mercator screen the direction of a ground vector is **`(u, -v)`**. Both halves of that are load-bearing; the cos(lat) one was a real bug once (the flow near the poles raced sideways).
- **THE TRAIL IS TRIMMED BY LENGTH (`TRAIL_PX`), NOT BY FRAME COUNT.** A particle's speed decides how far it moves per frame, so a fixed frame count meant a 2 m/s wind drew a four-pixel dot — the slow half of the map was invisible, and a field of isolated four-pixel dashes does not read as a field. The length trim keeps every streak legible and the SPEED is carried by the colour, which is what the ramp is for. Do not go back to a frame count.
- **THE PUBLISHED RAMP IS NOW BRIGHT AT ITS LOW END TOO** (2026-11-06). "By speed" is the published ramp from `public_html/data/wind/meta.json`, and it used to start at **`#0b1020` — near-black** — so **everything below 3.6 m/s (13 km/h) was painted in a colour that vanished against the dark satellite basemap**. The owner report was *"the wind isn't always working"*, and the wind was NOT broken: it was running, animating and drawing 16,828 lit pixels on the reader's own URL — of which **10,126 (60 %) were in that near-black end**, and **91 % on a phone**. The layer's own comment had named the defect all along ("the published ramp starts near-black… so a calm wind is invisible on a dark satellite AND on a bright one"), and its answer had been two OTHER modes. **The ramp itself is now bright at both ends, exactly as the ocean currents were fixed** — the three darkest stops lifted (`#0b1020 → #1d4ed8`, `#132038 → #3b82f6`, `#1b3a5c → #38bdf8`), the **hue sequence and every stop's m/s unchanged**, so the key still reads "blue = calm, cyan = fast". **The source of truth is `worker/windmap.py::RAMP_STOPS`** and the published `meta.json` is patched to match — a test asserts the two cannot drift, because the map, the 3D globe, the legend and the export all read the published ramp. **After: 21,070 lit pixels, 100 % of them bright.**
- **FOUR STYLES, THREE COLOUR MODES, and the site's palette picker.** The layer owns its own legend (`#wind-legend`, injected into `.leaflet-control-layers-list` — the PARENT of the overlay list, because Leaflet empties and rebuilds that list on every layer change). **Streamlines** (trailing streaks), **Flow** (the field as a texture of fibres), **Particles** (moving dots), **Arrows** (static glyphs: length = speed, head = direction — the synoptic reading). Colour: **Colourful** (the default — a full hue sweep, BRIGHT AT BOTH ENDS so even a calm wind is findable on a night ocean), **By speed** (the published ramp), **Mono** (one bright ink, the speed in the alpha — reads over any basemap). The palette picker is the site's own, so the wind needs `setPalette` on its LAYER OBJECT (the dropdown calls `layer.setPalette`, not a module function) — and picking a scheme switches the mode to "By speed", so the select never says one thing while the map shows another.
- **`parseRamp()` TAKES THE STOPS, NOT THE META.** It used to read `meta.ramp`, so handing it the ACTIVE ramp (an array) left the colour LUT empty — and every wind on the map fell back to a flat grey whatever the reader chose. The wind looked monochrome and nothing said why. The ramp is DERIVED at use time (`activeRamp`), never copied into the published meta.
- **THE "FLOW" STYLE MOVES — ITS MARKS TRAVEL ALONG THE WIND.** Each mark is a streaklet that advances along the local flow every frame and leaves a trail on the slowly-fading canvas; its step is PROPORTIONAL to the wind, so a fast wind draws a long fast streak and a slow one a short slow one. Drawing fresh strokes at RANDOM positions instead churns: the picture dissolves and reforms faster than the eye can follow it, and the fibres never go anywhere. `FLOW_FADE` is the dial for how much detail survives (it sets how long a fibre lives); `FLOW_ALPHA` and the streaklet count set how bright it is. The marks get a **bloom under a thin core** — a hairline over a busy satellite is invisible however bright its colour is.
- **THE FLOW RENDERER MUST NOT CALL `containerPointToLatLng` PER STROKE.** That goes through the map's CRS every time, and the renderer asks for thousands of them a frame. `screenToLatLng()` does the Mercator inverse directly from the calibration `recalibrate()` measures.
- **THE WIND SPEED FIELD IS THE SAME DATA.** `wind-speed-layer.js` is a `field-layer.js` wrapper whose speed is the magnitude of the **same u/v grid the animation uses** — one download of `grid.bin`, two layers (`WindLayer.ensureRawData()`). It has its own opacity slider (40 % by default: a wash, not a wall) and its own pane (`windSpeedPane`, 366 — below the animation at 370, above the basemap). **It is registered in `generic-layers.js`'s `XYZO_GENERIC_LAYERS`**, which is what gets it `init(map)` — and without `init` the pane is never created and Leaflet throws when the layer is added.
- **The field-layer family (CAPE, IVT, wave, wind speed) does NOT port to the globe** — it is a probe-backed Leaflet GridLayer. The reason is recorded in `panel-parity.bun.test.js`'s `NOT_PORTED` list, which is the contract.
- **The layer renders in `windPane` (z-index 370): above `tempPane` (355) and `isobarPane` (360), below `overlayPane` (400) where the pin canvas lives. `app.js` creates no pane for it** — the module owns it, and app.js only calls `WindLayer.init(map)` after creating the map.

- **The NOMADS filter-server level token is `10_m_above_ground` (with the underscore)**, not the eccodes shortName form `10m_above_ground`. The latter returns HTTP 500, which silently falls back to downloading the whole 42 MB product — and then `decode_field` trips over `prmsl` as the first message. `"2_m_above_ground"` has the same convention.
- **Fetch the 0.25° product (`suffixes=("0p25",)`) — the 1° rule is REVERSED.** The wind was published at 1° until 2026-11-04, on the reasoning that *"a vector whose direction barely changes across a cell"* — **measured, that is false where it matters**: the SAME GFS cycle at 1° and at 0.25° agrees EXACTLY at nineteen of twenty-four sampled points, and then **Nairobi is 78° out** and **Sydney 41° out** — the two places where the flow has structure finer than a degree. A 1° grid cannot carry the answer there, and no amount of verification changes it: the field was too coarse. The cost is 3.96 MB raw / **~2.8 MB gzipped** against 196 KB, paid only by the readers who switch the wind layer ON. **The globe reads the 1° copy** (`grid-1deg.bin` + `meta-1deg.json`) — the SAME field, subsampled by the SAME worker run, so the two cannot disagree. The globe's wind is 900 streaks on a sphere with no numbers in it, so the coarse texture is the right one there.
- **THE AUDIT MUST FOLLOW THE PUBLISHED GRID'S RESOLUTION.** Four places assumed a 1° lattice and broke when the grid moved: the isobar check's `row = lat + 90` put the pressure in the wrong cells (max diff 34.7 m/s), the mirrored-wind control was hardcoded to 90 rows and crashed, the trade-wind test read the mid-latitude westerlies when it meant the trades, and the antimeridian seam moved from 359.5° to 359.875°. **Never hardcode a row index or a latitude→row formula: derive it from the grid's own `lat_step` / `lon_step`.**
- **Outputs are `grid.bin` + `meta.json`, never `.png`.** Caddy serves `*.png` under `public_html` `immutable` for a year, so a regenerated grid would be invisible behind a stale one — the incident that hid the Köppen layer on 2026-10-22. These two files are not in the immutable list, so they revalidate.
- **Nothing is rebuilt per user.** The worker fetches once per cycle, Caddy serves the two files statically, and the browser reuses them. `windmap.py` compares the published `run_time` **AND the published `product`** and writes **nothing** when GFS has not advanced — an early timer tick must not rewrite 4 MB and bust every cache for free.
- **THE NO-OP MUST COMPARE THE PRODUCT, NOT ONLY THE CYCLE.** The product string (`gfs.0p25`) IS the resolution, and on 2026-11-04 the resolution changed while the cycle did not — so a cycle-only comparison declared *"already published"* and **the new 0.25° grid never shipped**. `current_product()` reads `meta.product` for exactly this reason. The same guard is in `tempmap.py`, and `worker/isobars.py` grew one (it had none, so it re-contoured the whole world on every tick; its no-op reads the stored `run_time` out of PostGIS).
- **Sample particles in GEOGRAPHIC space, not screen space.** The grid is already geographic, so a particle's flow is correct during a pan; a screen-space vector field has to be rebuilt after every move and is briefly wrong while dragging. This is why there is no field-bake step at all.
- **`latLngToContainerPoint` takes ONE latlng.** Calling it as `px(p.lat, p.lng)` hands it a bare number, which coerces to `null` and throws `Cannot read properties of null (reading 'lat')` on frame 1 — killing the rAF loop silently with a layer that looks broken. The call sites must be `px([p.lat, p.lng])`.
- **Re-anchor the canvas on EVERY pan — the pane translate persists.** Leaflet's map-pane keeps `translate3d(x,y,0)` after each drag-pan (only a setView/zoom zeroes it), and the canvas rides inside `windPane` — so drawing at `latLngToContainerPoint` put the whole field paneOffset from its geography (the 2026-10-29 city-labels bug, same shape). `anchorCanvas()` pins the origin to screen (0,0) via `containerPointToLayerPoint([0,0])` and runs from `resize()` **and** the `moveend zoomend` handler (the translate changes with every pan, so a resize-only anchor is not enough). It **degrades, never throws**: a partial map without the inverse transform returns instead of killing `start()`.
- **The hover probe attaches to the MAP CONTAINER, never the pane.** It is positioned at `containerPoint + 14`; a pane child rides the same translate, so the tooltip sat paneOffset from the cursor. The host chain (`getContainer()` → pane → `body`) requires `appendChild` at each step — degrade, never throw (test stubs have containers without `appendChild`). Pinned by `wind-layer.bun.test.js`.
- **`schedule()` must run from `finally`.** An exception mid-frame used to leave `state.raf = 0` with no pending frame and froze the animation permanently. The whole frame body sits in `try/catch/finally`.
- **Longitude wrap, not reject**: a particle crossing the antimeridian must keep flowing. Sample with `(((lng - lon_min) % 360) + 360) % 360`.
- **THE PARTICLE GUARD IS RELATIVE TO THE VIEW, NOT A FIXED WINDOW (2026-11-10).** Owner report: *"what can we do to 'connect the pacific ocean' wind maps.. i like to see the wind particles working across teh pacific.. notice the rigth side has the wind but the left doesn't?"* — at `#18.9998,-168.2666,5`. **LEAFLET'S LONGITUDE SPACE IS CONTINUOUS**: that view's bounds are **west −199.9 … east −136.6**, and the particles on the far side of the dateline are legitimately at −199. **A FIXED `-180 … 185` WINDOW KILLED THEM EVERY FRAME** — and `spawn()` picks the next longitude from `map.getBounds()`, so the replacement died at once too. The western Pacific was blank, and the measurement said so: **1,393 ink samples on the left half of the canvas against 3,832 on the right**. The guard is now `offWorld(p)` — *"more than a whole turn outside the view's window"* — against `state.viewWest` / `state.viewEast`, refreshed **once per frame** in `step()` from `map.getBounds()` (the screen check recycles everything nearer than that). **AFTER: left 9,615 / right 9,590 — 100 %.** **NEVER re-introduce a fixed longitude window here.** The same trap is waiting in any renderer that recycles a particle: the ocean currents and the globe's wind have their own particle code and their own guards — check them before copying one.
- **The sampler's column past the last one WRAPS (`x1 = (x0 + 1) % g.cols`), it does not clamp.** At 359.5°E the two neighbours are 359° and 0°; clamping leaves a one-degree stripe at the dateline where the wind is stale and the particles visibly stall. The latitude axis still clamps (the pole is a real edge).
- **Longitude degrees shrink by `cos(lat)`** (`dLng = u * … / cosLat`), or the flow near the poles races sideways across the screen.
- **The physics lives in `advance(lat, lng, dt)`** — a pure function of the point and the time step, exported as `WindLayer._advance()`. `step()` calls it; nothing else may move a particle. The physics cannot be tested while it is buried in the draw loop.
- **On a Web Mercator map the screen direction of a ground vector is `(u, -v)`**: the `cos(lat)` in the geographic displacement and the `1/cos(lat)` of the Mercator y axis cancel. An easterly wind draws to the right, a northerly one draws upwards.
- **Drawing is batched by (speed × fade) bucket.** A wide stroke is the expensive operation on a software canvas; tracing geometry once into a `Path2D` per bucket and stroking three times (dark halo → bloom → core) collapses ~1,100 stroke calls to ~150. Do not go back to two `stroke()` calls per particle.
- **A BLOOM THE SAME COLOUR AS THE CORE CANNOT HELP OVER A BRIGHT BASEMAP — the streak needs a DARK HALO.** Owner report: *"are you sure the wind animation is working? i click on it doent see anything!!???"* — and it WAS working, measured at his own coordinates (`#46.73,-117,7`): `enabled true`, 1,234 particles, rAF advancing, canvas 1440×900 at `windPane` z379, **228,554 pixels changing per 400 ms**. What was missing was **contrast**: over brown-green satellite terrain a pale cyan hairline has nothing to separate it from, and the bloom — painted in the *same* colour as the core — can only make the GROUND brighter around the line, which is the one thing that cannot help on a light basemap. Each bucket now strokes **`rgba(8,12,20, …)` at 0.5× the bucket's alpha and 5.4 px FIRST**, then the bloom (4.8 px, 0.30 alpha), then the core (**1.6 px**, alpha floor **0.62** — the slow half of the field used to be drawn at 0.52 and disappeared first). A dark halo is invisible against the dark satellite basemap the site opens on and gives the bright core an edge on a light one — the same trick as text with a stroke. The Flow renderer got the same three passes; its canvas ages with `destination-out`, so the halo fades with everything else instead of accumulating into a dark sheet. **MEASURED at that spot against a map where the wind was never switched on**: wind ink (pixels >16/255 from the baseline) **5.20 % → 6.79 %**, and the 2× screenshot pair shows it directly — thin pale dashes → dark-edged streaks. **THE CHART IS STILL THE BIGGER PICTURE**: at `iso=0.1` the isobars change **26.5 %** of the same screen against the wind's **6.8 %**, and the two are the same shape — so "I can't see the wind" with the chart on is still the first thing to ask about.
- **MEASURE THE LAYER AGAINST A MAP THAT NEVER HAD IT ON.** The first before/after used "wind off" as the base, which only works if off == never-on (it does here — turning the layer off clears the canvas, measured `never-on vs after-off = 0.00 %`), and any other state left in the base subtracts the very thing being measured. A baseline that shares the layer's pixels makes a real improvement measure as nothing.
- **Quality adapts**: FPS < 40 sheds particles (floor 0.4), > 56 grows back, with hysteresis. Headless Chromium has no GPU and lands at the floor — that is expected, not a bug. `WindLayer.setQuality(1)` pins it for a representative screenshot; `autoQuality()` releases it.
- `state.grid` is assigned **only after every field is in place** — `start()` gates on it, so assigning it early begins the animation on a half-built grid and assigning it never leaves the layer reporting `loaded: false` with zero particles (the bug it shipped with).
- `worker/windmap.py`'s **`verify()` is a gate, never a checkpoint**: it asserts mid-latitudes out-blow the tropics, direction coherence is low (one direction everywhere means a scrambled field), and the trades are easterly while the westerlies are not. Never bypass it.
- **`verify()` does NOT catch a field mirrored about the equator** — the mid-latitudes are windier than the tropics in BOTH hemispheres, so a mirrored field passes every one of its checks. Two things do catch it, and both are load-bearing:
  1. `worker/isobars.py`'s `check_scan_order()` cross-checks `jScansPositively` against the GRIB header's own `latitudeOfLastGridPointInDegrees`. The header is the only place the truth about the row order lives.
  2. `worker/wind_verify.py` re-decodes the same cycle with the message's OWN index arithmetic (Ni/Nj/lat1/lon1/jScansPositively) and compares the published grid with it **cell by cell**. A mirror, a swapped u/v, a wrong scale, a stale cycle or a one-row shift all fail there.
- **Audit the published grid with `python3 -m worker.wind_verify`** (add `--reference` to cross-check against Open-Meteo's GFS — the same NOAA analysis through a completely different code path, which is the only check that catches a field that decodes correctly but *means* something else). `--offline` does the self-consistency checks alone. The tool is a tool, never part of the publish path.
- **NO GRID RESOLVES WHAT A FINER ONE SEES, AND THE REFERENCE TOLERANCE HAS TO SAY SO.** The cells around a point can disagree among themselves (Tokyo: 1.9…7.1 m/s in one degree of the old 1° grid, and the 0.25° analysis of the same hour says 8.9). The tolerance in `wind_verify.compare_reference()` therefore grows with `local_spread()` — the disagreement between the published grid's own neighbouring cells — and the direction comparison is skipped below 2.5 m/s, where a breeze has no meaningful direction. A fixed tolerance flags coastal points with sharp gradients as failures when nothing is wrong. **The cells are the PUBLISHED grid's own**, so this follows the resolution automatically (it was 1° and is 0.25° since 2026-11-04).
- **The probe must read Leaflet's `e.latlng`, never `e.offsetX`/`e.offsetY`.** Those are relative to the element the event happened on, and the pin canvas (`xyzo-canvas-pins`) is 300 px WIDER than the map and offset by -300 — so it is the event target over most of the map and `offsetX` there is 300 px too big. The probe used to read the wind for a point a third of a screen away from the cursor ("from WNW" where the field said "from N"). Use `map.on("mousemove", e => updateProbe(e.latlng, e.containerPoint))`, like `temp-layer.js` does.
- **`xyzo-windmap.timer` polls it every 15 min** (the analysis is 6-hourly; the poll is what keeps the map from sitting on a stale cycle — see "The GFS Poll Cadence" below). Same rule as the isobar and temperature workers: exit via `os._exit()` and import `worker.db` before `eccodes`, or systemd records a SIGSEGV on a successful run.
- **`wind-layer.js` must load BEFORE `app.js`** (app.js reads `window.WindLayer` at parse time to register the overlay), and it must be in `scripts/bump_frontend.sh`'s `ASSETS` list — a new frontend file that is not stamped keeps a stale `?v=` and cached browsers never load it.
- The layer renders in `windPane` (z-index **370**): above `tempPane` (355) and `isobarPane` (360), below `overlayPane` (400) where the pin canvas lives. **app.js creates no pane for it** — the module owns it, and app.js only calls `WindLayer.init(map)` after creating the map.

## Wind on a Slow Device — the dt cap, the fills, and the frame readout (2026-11-14)

Owner, on a fifteen-overlay link (`wind=particles:speed:100`): *"the wind
dots dont move around very fast on firefox… what we can do to speed this
up for all users… or give some speed tips or options for example less
wind dots or controllable number"*. Three defects were measured on that
exact URL with **`scripts/wind_perf_audit.py`** (Firefox + Chromium, a
density sweep, a wind-off control, and the dots' speed as the MEDIAN
displacement of the live pool):

- **THE dt CAP WAS A SPEED LIMIT.** `step()` advanced the field by
  `min(elapsed, cap)`; the cap was **0.1 s**, so below 10 fps every
  frame threw away the rest of a tenth-second and the animation ran at
  `min(1, 0.1/dt)` of real time. The model's prediction matched the
  measurement (predicted 37/31/40 px/s at 8.2/6.9/8.8 fps, measured
  34.2/29.8/37.4). **`MAX_DT_S = 0.25`** now — real-time pace down to
  4 fps, while a genuine stall is still bounded to a ~17 px step so a
  trail can never be slashed across the map. **Any per-frame constant in
  this file has the same shape of bug**: the Flow style's streaklet step
  and its fibre age were both per-frame and are dt-scaled now too.
- **THE PARTICLES ARE FILLED, NOT STROKED.** A wide round-capped stroke
  is the most expensive call this layer makes: instrumenting the live
  page, `stroke()` was **80 % of every frame spent inside canvas calls**
  (21.1 ms a frame for 1,234 dots in Firefox). The dot is now **three
  concentric discs** — halo → bloom → core at `r`, `r + PARTICLE_BLOOM_R`,
  `r + PARTICLE_HALO_R` — which reproduces the annuli the strokes drew
  (every inner disc paints over the part of the outer one it covers).
  Measured: **24.2 → 13.4 ms a frame**, zero strokes, and the picture is
  unchanged (**mean |Δ| 0.54/255, 0.63 % of pixels > 24 levels, ink
  coverage 1.011×**). Chromium rasters either way in under a millisecond;
  fills cost it ~3 ms a frame — worth it for the browser that was
  struggling. **The dark halo is still mandatory**: the assertion in
  `wind-styles.bun.test.js` accepts *either verb* but will not accept no
  halo (the "you can't see the wind" defect).
- **THE LEGEND REPORTS THE FRAME RATE** — `1,234 dots · 6 fps` beside
  the count (never for **arrows**: they are static, so it would only
  print the display refresh rate), and below `SLOW_FPS` (30) a tip:
  *"Slow here — turn overlays off or lower the density for smoother
  motion."* It clears itself when it stops being true. The density
  control (25–400 %, in the URL as the third field of `wind=`) shipped
  11-10; this is what makes it actionable.
- **THE REST OF THE FRAME IS THE OVERLAY STACK, AND NO CSS FIX EXISTS**
  (~17 ms per overlay layer; hiding the other 35 panes 267 → 50 ms).
  Tested and rejected: `will-change`, `translate3d` (no change), and
  **`contain: paint`, which only "worked" by clipping the map blank**
  because **every Leaflet pane is 0 × 0**. Any future "make it faster"
  change to this renderer therefore needs a **pixel/geometry check
  beside the fps number**. Full measurement in README Q-N39.
- **THE MEASUREMENT TOOL IS `scripts/wind_perf_audit.py`**, and real
  browsers report their own numbers through `client_perf` /
  `POST /api/analytics/perf` (client: `public_html/perf-report.js`,
  two rows per session per day). The `gpu` column is the one that
  separates a CPU-rendered machine from a laptop with a card.

Pinned by `public_html/tests/wind-slow-devices.bun.test.js` (12),
`public_html/tests/perf-report.bun.test.js` (16) and
`api/tests/client-perf.test.ts` (11).

## The GFS Poll Cadence (2026-11-04)

- **THE ANALYSIS IS 6-HOURLY. THE POLL IS 15-MINUTELY.** The GFS and the ECMWF IFS analyses publish at 00/06/12/18Z; HRRR is hourly and covers North America only. **There is no global analysis at 10-minute cadence** — that belongs to *nowcasts*. What is achievable, and what the three workers do, is to **stop sitting on a stale cycle**: `xyzo-{isobars,tempmap,windmap}.timer` poll every **15 minutes** (they used to poll every six hours, so the map could be hours behind, and a run published late could be **missed entirely**).
- **THE POLL MUST BE ALMOST FREE.** Each worker compares the published **cycle AND product** before it downloads anything, so a tick with nothing new costs a couple of HTTP HEADs. The isobar worker's no-op went from **5 minutes to 1 second**, and the ECMWF fetch — four minutes of work for a twice-daily product — is skipped.
- **THE PRODUCT STRING IS PUBLISHED PREFIXED — COMPARE THE SAME FORM OR THE GUARD IS DEAD CODE.** `write_meta` writes `"product": f"gfs.{product}"`, so meta.json holds **`gfs.0p25`** while `PRODUCT` is **`0p25`**: `current_product() == PRODUCT` was **always false**, and the `run_time` half of the `and` could not save it. MEASURED 2026-11-06 after the poll went to 15 minutes — temp ticks at 23:14, 23:29 **and** 23:44 all fetched the GRIB (873 KB), decoded, verified and rewrote `grid.bin` (2,028 KB) + `meta.json` + the 1° pair for **one unchanged cycle**, with **zero** `already published` lines; wind was the same **sixteen times in 70 minutes**, rewriting **4,056 KB** each time. It had gone unnoticed at a 6-hour cadence, where a tick usually *did* find a new cycle — 15 minutes turned it into ~6 MB rewritten **96 times a day**. **The fix is one function both sides call**: `published_product(suffix)` → `PUBLISHED_PRODUCT = published_product(PRODUCT)`, used by the writer **and** by both guard sites in each of `tempmap.py` / `windmap.py`. **The isobar worker never had this bug** — it compares the stored `run_time` **and** `ISO_INTERVAL_HPA` (a number) out of PostGIS, never a product string. Pinned by `TestNoOpProductGuard` in `worker/tests/test_tempmap.py` and `test_windmap.py`: a real round-trip through `write_meta` into a temp file, plus a source pin on both guard sites.
- **THE UNIT FILES LIVE IN `deploy/`.** The live ones under `/etc/systemd/system/` are changed by hand (`sudo systemctl daemon-reload && systemctl restart xyzo-{isobars,tempmap,windmap}.timer`), so `deploy/*.timer` is the version-controlled copy and the two must agree. **SINCE 2026-11-06 THEY DO**: all three live units read `OnUnitActiveSec=15min` and differ from `deploy/` in **0 lines**, next elapse within a quarter-hour, and the first tick afterwards did the cheap ECMWF HEAD probes and downloaded nothing. **THE TRAP: `daemon-reload` EDITS NOTHING.** It only re-reads the unit files, so `daemon-reload && restart` applied to a unit that still says `6h` changes nothing — which is exactly what happened the first time (the interval was `6h` on disk and the command was "done"). The fix is three steps: **edit the file → `daemon-reload` → `restart`**, in that order.
- **A MANUAL RUN AND A TIMER TICK DO NOT MUTEX.** The worker has no cross-process lock: on 2026-11-06 the timer fired at 02:24 UTC while a manual `--source ecmwf` rebuild of the same field was 65 minutes in, and both contoured the world. They wrote the same field at the same interval, each in one transaction, so the table came out identical — wasted CPU (two ~80-minute builds), not corruption. The no-op guard only protects a tick that starts when the PUBLISHED state is already current; it cannot see a build that is in flight. If you start a worker by hand, expect the timer to start a second one.

## What Readers Actually Use (2026-11-05)

`map_settings_usage` records **one row per session per day per
setting**: which overlays were on and at what opacity, which Cool maps
preset was opened, which base layer, and the settings that are not
layers at all (pin density, isobar step/colour/analysis, wind style).

- **THE WRITE REPLACES THE SESSION'S ROWS FOR THE DAY**, it does not
  append. A reader who flips twenty overlays still counts once each, and
  a session that changes its mind does not inflate the aggregate. The
  natural key `(day, session_id, kind, key)` is what makes that
  idempotent — and the table also carries a surrogate `id`, because
  `scripts/retention_prune.py` deletes by `id` and failed with
  *"column id does not exist"* until it had one.
- **THE DROPDOWN IS ORDERED BY IT, AND THE ORDER IS RE-APPLIED.** The
  usage arrives AFTER `L.control.layers(...)` exists, so the ROWS are
  re-ordered in the DOM rather than the control being built in a
  different order (which would need the fetch to block boot). A
  `MutationObserver` on `.leaflet-control-layers-overlays` re-applies it
  because Leaflet rebuilds that list on every layer change. Reordering
  CHILDREN is not hand-rolling the control — the rows stay exactly as
  Leaflet and `OverlayOpacity` built them.
- **THE REPORT KEYS ON THE SLUG; THE DOM SHOWS THE NAME.** The slug
  survives a rename, the name is what the row says, so the client
  resolves one against the other. An unknown row keeps its relative
  order and goes LAST: a layer with no data yet is not worse than one
  with none.
- **`GET /api/analytics/map-settings?preset=<id>` IS THE PRESET TUNING
  NUMBER.** It returns the overlays those sessions had on with
  `pct_of_openers`. A curated "Storm watch" that everybody immediately
  turns the lightning off in has a wrong layer in it. The presets get
  tuned against this once a season of use has accrued — that is the
  honest order; do not tune a preset against a week of data.
- **IT IS TELEMETRY.** No IP, no user agent, no personal data — the
  session id is the random localStorage key `analytics.js` has always
  used. It is pruned with the rest by `retention_prune.py` (90 days).
  Every failure is swallowed: the map is the product, this is a
  footnote on it.

## Isobar Detail Switches (2026-11-05)

- **THE RESPONSE NEEDS A VALIDATOR.** The 0.25 hPa world response is
  **2.3 MB raw / 895 KB on the wire**. Without `Cache-Control` and an
  `ETag` the browser had nothing to revalidate against and
  re-downloaded it on EVERY detail switch — measured 1,151 ms for the
  first switch to 0.25 and 932 ms for the repeat. The route now sends
  `ETag` + `Cache-Control: no-cache` and answers **304 with 0 bytes**
  when the browser already holds those lines. The identity is the query
  plus the analysis it was cut from (the worker's no-op guard refuses to
  re-publish an unchanged cycle, so the geometry cannot move under a
  fixed identity).
- **COMPARE `If-None-Match` WITH THE WEAK PREFIX STRIPPED FROM BOTH
  SIDES.** The value that reaches the browser arrives as `W/"…"`
  (Caddy's proxy adds it), so a strict compare against our own `"…"`
  never matched and every conditional request fell through to a full 200
  — which is the 895 KB download the whole thing exists to avoid. This
  cost a full debug cycle; do not re-introduce the strict compare.
- **THE ISOBARS RENDER THROUGH `L.canvas({ pane: "isobarPane" })`, NOT
  SVG.** A world view at 0.25 hPa is 3,829 polylines, and the SVG
  renderer creates 3,829 DOM `<path>` elements for them. **THE PANE MUST
  BE SET**: a canvas renderer's container otherwise lands in the default
  overlay pane with `pointer-events` on, and a full-map element there
  swallows every click on the map (the same rule as the mouse-pointer
  section below). Note that `L.polyline` creation is only 9-11 ms either
  way — the win is in the browser's PAINT, not in JavaScript.
- **THE CHIP'S OWN STATE CHANGE IS 6-16 ms** throughout, so the reader
  always sees their click register immediately even when the lines take
  half a second. Do not "fix" this by blocking on the fetch.

## Data Licences and Attribution

- **Every dataset's licence, attribution and obligations are audited in `docs/DATA_LICENSES.md`.** Read it before adding an overlay, and update it when you add one.
- **ATTRIBUTION IS ENFORCED BY A TEST, not left to memory.** `public_html/tests/data-licences.bun.test.js` fails if an overlay's published `meta.json` loses its `license` or `attribution`, or if a layer module stops carrying an `attribution` string. Leaflet prints `options.attribution` in the bottom-right corner via `L.Layer.getAttribution()`, so a missing one is a licence breach that nothing else would catch.
- **The Köppen layer's one licence exposure was resolved on 2026-10-29.** Its source was Peel et al. 2007 (CC BY-NC-SA 2.5 — NonCommercial *and* ShareAlike) via Gerrit Hendriksen's KML; it is now **Beck et al. 2018** (`10.6084/m9.figshare.6396959`), **CC BY 4.0** at **1 km** resolution. See `docs/DATA_LICENSES.md` §4. The licence test asserts the NC/SA clauses are gone.
- **A dataset with no open licence is not a candidate.** The Vaisala GLD360 "Lightning Detection" dataset was assessed and REJECTED: it publishes only a 4K *video* (no grid, no numbers) and its creator grants "educational, journalistic, and personal uses" only. The reasons are on record in `docs/DATA_LICENSES.md` §3 so it is not re-proposed from scratch.

## Phytoplankton Overlay Rules (MIT Darwin Project)

- The source is the **MIT Darwin Project's 1994-1999 global ocean ecosystem simulation**, run inside the MITgcm / ECCO-2 physical model and published by NOAA's Science On a Sphere: `https://sos.noaa.gov/catalog/datasets/phytoplankton-model/`. **MITgcm and the Darwin model are under the MIT Licence** (redistributable with the notice); the NASA side is public domain. See `docs/DATA_LICENSES.md` §3a.
- **THE PUBLISHED DISTRIBUTION IS A RENDERING, NOT A DATA PRODUCT.** The files are `2048/00000.png .. 02190.png` (2191 DAILY equirectangular 2048x1024 plate-carrée frames, row 0 = **north**), `colorbar.png`, `labels.txt` and `phytoplankton_2048.mp4`. The monthly maps exist only *inside the frames*, so **the numbers have to be recovered by inverting the dataset's own colour bar** — four ramps, each 0-5 mmol P m⁻², one per type: Prochlorococcus (green), Synechococcus (cyan), Flagellates (yellow), Diatoms (red).
- **The TYPE is decided by the channel structure, not by the nearest ramp point.** At near-zero biomass every ramp's zero end is within ~40 RGB units of every other, so a nearest-point search flips the type at random exactly where the gyres are — and the gyres are the whole point of the map. Use `(0,v,0)` prochlorococcus, `(0,v,v)` synechococcus, `(v,v,0)` flagellates, `(v,0,0)` diatoms.
- **THE LAND MUST BE MASKED WITH NATURAL EARTH, not with the residual alone.** The frames carry a photographic background, and brown desert sits INSIDE the yellow flagellate ramp, so a residual test alone reads the Sahara as flagellates. `scripts/phytoplankton_build.py` rasterises Natural Earth 50m land (public domain) at 2048x1024 and masks it out.
- **The dominant type is the one with the greatest TOTAL biomass, not the greatest mean.** In the oligotrophic gyres the type is the same every month but at a tiny biomass, and a single bright month of another type would otherwise win on the mean.
- `scripts/phytoplankton_build.py` publishes `public_html/data/phytoplankton/`:
  - `meta.json` — grid layout, the four ramps, the alpha rule, the thirteen periods, the licence.
  - `annual.bin` — the annual mean.
  - `m01.bin` … `m12.bin` — one per calendar month.
  - **Each .bin is TWO uint8 planes of 1024x2048, written SEQUENTIALLY** — the type plane (0-3, 255 = none) and then the biomass plane (0-255 of 0-5 mmol). **A `(rows, cols, 2)` array serialises byte-wise, which interleaves the two planes and turns the type plane into garbage.** The verifier caught exactly that.
  - The published grid is **equatorial: row 0 = southernmost**, and column 0 = 180°W.
- **THE COLOUR IS THE DATASET'S OWN RAMP**, so the legend here and the source's legend are the same legend. Alpha is separate: the source says "opacity indicates concentration of the phytoplankton as carbon biomass", so alpha rises with the biomass over a floor of 0.18.
- **The type is CATEGORICAL, so it is read NEAREST.** The biomass is continuous, so it is interpolated — but only across neighbours that share the same dominant type, or a cell on the edge of a diatom patch reports a biomass neither it nor its neighbour has.
- `scripts/phytoplankton_build.py`'s **`verify()` is a gate, never a checkpoint.** It checks that the ocean is modelled and the land is not, that all four types are present and none dominates everything, that the Southern Ocean / Weddell Sea / Arctic are diatom-dominated, that the subtropical gyres are synechococcus, that the equatorial upwelling beats a gyre, that the large phytoplankton carry more phosphorus than the small ones, and that every published period is the right size.
- `public_html/phytoplankton-layer.js` **must load BEFORE `app.js`** (app.js reads `window.PhytoplanktonLayer` at parse time to register the overlay), and it must be in `scripts/bump_frontend.sh`'s `ASSETS` list.
- The layer renders in `phytoplanktonPane` (z-index **357**): above the temperature field (355), below the magnetic field (358).

## Lightning Density Overlay Rules (WWLLN)
- The source is the **WWLLN Global Lightning Climatology (WGLC) v2** — the 5 arc-minute monthly climatology of lightning *stroke* density, 2020-2022. `https://doi.org/10.5281/zenodo.20277101`, **CC BY 4.0**, source NetCDF cached at `worker/data/wglc_climatology_05m_monthly.nc` (144 MB, sha256 pinned in `scripts/lightning_build.py`). Paper: Kaplan & Lau (2021), *Earth Syst. Sci. Data* 13, 3577-3607.
- **Why WGLC and not NASA LIS/OTD.** The map everybody shares (geology.com, NOAA Science On a Sphere) is NASA LIS/OTD at **0.5° ≈ 55 km per cell**, from 1995-2013. WGLC is **5 arc-minutes ≈ 9.3 km per cell** — six times finer — and it is the finest global lightning climatology in the public domain. There is no free 1 km global climatology: the underlying WWLLN *stroke* geolocation is ~1 km, but the published density grid is 5 arc-minutes. Do not promise 1 km.
- **These are STROKE densities, not NASA flash densities, and the numbers run lower.** WWLLN sees cloud-to-ground strokes; LIS counts every flash including intracloud. Maracaibo reads ~46 strokes/km²/yr here against NASA's ~232 flashes/km²/yr; Florida ~9 against ~59. The legend must say "strokes", never "flashes".
- `scripts/lightning_build.py` publishes `public_html/data/lightning/`:
  - `meta.json` — grid layout, colour ramp, alpha stops, `v_max`, `power`, the legend ticks, and the thirteen periods.
  - `grid_annual.bin` — the annual mean, 2160×4320 uint16.
  - `grid_m01.bin` … `grid_m12.bin` — the twelve monthly means, same layout.
  - **uint16 at 1e-4 strokes km⁻² d⁻¹ per unit, LINEAR.** The non-linear part is the colour transform, which lives in the client and is described by `meta.json` (`v_max`, `power`). Do not bake the transform into the file — a data file of encoded ramp positions cannot be read by anything but this client.
  - The grid is **row 0 = southernmost, column 0 = 180°W**, and the coordinates are CELL CENTRES (`lat_min = -89.958333`).
- **Outputs are `.bin` + `.json`, never `.png`.** Caddy serves `*.png` under `public_html` `immutable` for a year, so a rebuilt pyramid is invisible behind a stale version token — the incident that hid the Köppen layer on 2026-10-22. `.bin` is not in the immutable list, so it revalidates. **THE COMPRESSED-ON-THE-WIRE CLAIM WAS FALSE — AND IT IS FIXED NOW (2026-11-07)**: Caddy's catch-all `encode zstd gzip` did **NOT** compress these files — `grid_annual.bin` went out **17.8 MB with no `Content-Encoding` at all**, because Caddy's `encode` only compresses a response whose `Content-Type` is on its compressible list, and `file_server` serves a `.bin` as `application/octet-stream`. **THE TRAP IN FIXING IT, MEASURED ON A THROWAWAY INSTANCE: `encode`'s `match` block REPLACES the default criteria rather than adding to it** — naming `application/octet-stream` in one left the `.bin` uncompressed **and took the compression off the `.js` and `.css` as well**, an explicit list of every default type lost compression for **every type it named**, and the response-header form (`header >Content-Type …`) matched nothing at all. **THE FIX IS TO CHANGE THE TYPE THE EXISTING `encode` SEES** — `@bins path *.bin` + `header @bins Content-Type application/json` in `/etc/caddy/Caddyfile`, whose handler order `headers → encode → file_server` is confirmed with `caddy adapt`. The Content-Type is a deliberate lie, spelled out in that file: the client does `r.arrayBuffer()` and `sw.js` only looks for `text/event-stream`. `caddy validate` then a graceful `caddy reload`. **MEASURED AFTER:** `grid_annual.bin` 18.7 → 2.8 MB, soil `grid.bin` 12,960,000 → 535,247 bytes, across `public_html/data` **465 MB → 74 MB**, and a 15-overlay page load **43.5 MB → 18.2 MB (−58 %)** — with `.js`/`.css` still gzipped, which is the exact failure the `match` approach causes. **The lazy-loading rule in the next section is what stops everyone else paying for a layer they never switched on; this is what stops the layers they DID switch on costing 6× what they should.**
- **THE COLOUR SCALE IS A POWER LAW: `t = (v / v_max) ** 0.4`, with `v_max = 0.15` for EVERY period.** The field's median cell is 3e-5 strokes km⁻² d⁻¹ and its maximum is 0.144 — a factor of 4800. A linear ramp paints the whole world one colour. `v_max` is shared by all thirteen periods so January and July are comparable: the annual field tops out at 0.144 and only 19 cells in 9.3 million exceed `v_max` in any month, so a per-period scale would cost comparability for nothing.
- **ALPHA IS SEPARATE FROM THE RAMP.** 40 % of the globe has no lightning at all and 53 % is below 5e-5; painting that opaque black buries the coastlines under a black rectangle. The alpha ramp is 0 below t=0.05 and 255 by t=0.5.
- **THE PIXEL OFFSET WITHIN A TILE IS `1/(size * n)` OF THE WORLD, NOT `1/size`.** A tile is 1/n of the world (n = 2^z), so one pixel of it is 1/(size·n) of the world. Dividing the within-tile offset by `size` alone spreads the whole globe across every tile: invisible at zoom 0 (n = 1) and at zoom 7 it throws the field hundreds of degrees away from where it belongs. The result is a garbled map that still *looks* like a plausible map, so no screenshot catches it. `LightningLayer._test.pixelLatLon()` is exported so the test suite can pin the mapping.
- **The wash is painted per tile, not baked into a world-sized canvas.** At 9.3 km per cell a canvas big enough to hold the data would be 67 MB of ImageData and the bake would cost a second of jank. A 256 px tile costs about a millisecond, and Leaflet caches tiles.
- **The legend ticks are thinned by RAMP POSITION, not by value.** The scale is a power law, so 0.05 and 0.1 strokes sit 2 % apart in ramp position and their labels overlap completely. `year_ticks()` keeps a tick only if it is at least 0.085 away in t, and always keeps the maximum. The legend shows ONE row of ticks — the annual-equivalent rate, which shares every position with the daily rate because it is a fixed multiple of it — and the per-day rate is in the probe.
- `scripts/lightning_build.py`'s **`verify()` is a gate, never a checkpoint.** It checks the physical relationships: the annual maximum is in the tropics, 60-85 % of the global density is between 30°S and 30°N (NOAA's own figure for this dataset family is "about 70 %"), the poles carry under 1 %, the Sahara is far drier than the Congo, ten known hotspots are present, longitude is not mirrored, July is a northern-hemisphere season and December a southern one, December peaks over the Maritime Continent and July over Mexico, and the published grid round-trips. Never bypass it.
- `public_html/lightning-layer.js` **must load BEFORE `app.js`** (app.js reads `window.LightningLayer` at parse time to register the overlay), and it must be in `scripts/bump_frontend.sh`'s `ASSETS` list.
- The layer renders in `lightningPane` (z-index **356**): above the temperature field (355), below the magnetic field (358) and the isobars (360).
- **THE 3D GLOBE carries the ANNUAL mean only**, baked into an equirectangular canvas and draped as a MapLibre image source (the temperature field's pattern). The month switcher is a flat-map affordance; the globe is a fixed world view. The corners stay off the exact poles (±89.5) — ±90° projects to y=Infinity and the source silently never renders.

## The Layer Keys Must Be READABLE (2026-11-09)

**EVERY KEY IN THE LAYERS DROPDOWN IS ON A WHITE PANEL, AND MUST BE
PAINTED FOR WHITE.** Owner report: *"its difficult to see the soil types
on the drop down"* — with the HWSD soil-type key's HTML pasted.

**THE SOIL-TYPE KEY WAS PAINTED `#e6edf3` ON WHITE — 1.18:1, i.e.
INVISIBLE.** `.hwsd-legend { color: var(--fg) }`, and `--fg` is the pale
foreground of the **DARK** theme. It was the **only one of the
twenty-two keys** in that dropdown painted that way (every other key
measures 12.6–15.9:1) — the same trap the languages legend already had
(AGENTS.md: *"`var(--fg)` renders it invisible there"*).

- The key now uses the palette every other key uses (`#333` labels,
  `#222` title), at **13px** (it was 11px, under the legibility sweep's
  floor), with **13×13 swatches and a stronger border** — several WRB
  colours are pale (Alisols `#ffffbe`, Gypsisols `#fef6a4`, Regosols
  `#fee3a4`) and vanish into white without one — and columns wide
  enough that **"Open inland water" is not cut to "Open inland w…"**.
- **AND IT IS FINDABLE**: the key sat **3,200 px down a 5,000 px
  dropdown**, so a reader who ticked the layer saw the map change and
  **no key at all**. Switching the layer on now scrolls it into view —
  and only when it is not already on screen (`hwsd-layer.js`'s
  `revealLegend()`).

**THE MEASUREMENT IS A GATE, NOT A ONE-OFF.**
`scripts/legend_contrast_check.py` walks every key in the dropdown,
measures every **text** element against the background actually painted
behind it, and fails under **4.5:1** or **11px**. **All 22 keys pass**
(the worst is 4.83:1).

**IT FOUND THE SAME DEFECT IN THE OTHER KEYS**: the licence credits
under nine of them were **#888 on white — 3.54:1**, and the language
count **#999 — 2.85:1**. **A licence credit nobody can read is a licence
problem, not a style one**, so all of them are now **#666 (5.74:1)**.

**A SWATCH IS NOT A LABEL.** The first version of the script measured
the basins key's scheme DOT (an empty coloured span) and reported it
"invisible at 2.05:1" — a false positive. Measure the elements that
carry text.

Pinned by `public_html/tests/hwsd-layer.bun.test.js` (the key must not
use `var(--fg)`, the names are ≥12px, the swatches have an edge, no name
is cut off, and the key is revealed on enable).

## Soil Overlay Rules (SoilGrids 2.0 + OpenLandMap USDA orders)

**Two publishers, one layers-control entry.** Nine properties come from
**ISRIC SoilGrids 2.0** (CC BY 4.0) and one — the USDA orders — from
**OpenLandMap-soildb** (CC BY 4.0). The entry is named **`🟫 Soil`**,
NOT "Soil (SoilGrids)": that name became false when the second
publisher's chip landed, and a name must not claim what the data
cannot support. **The slug stays `soil-soilgrids`**
(`REVERSE_LAYER_SLUGS` in app.js) so every shared link, preset and
bookmark keeps working byte-identically — a slug is an identifier, not
a claim.

- **SoilGrids** is read over `/vsicurl/` from `https://files.isric.org/soilgrids/latest` — free, no key. `scripts/soil_build.py` classifies each property against **ISRIC's own SLD** (`scripts/soil_slds/`), so the legend is the official one and cannot drift from the data.
- **The USDA orders** (`usda`) come from a single **Cloud-Optimised GeoTIFF** at `ceph.opengeohub.org` (32.6 GB, but read by window through its own overviews — never downloaded whole). Its SLD lives on a **different host** (`SLD_URLS` in the builder) and uses a **namespaced tag** (`<sld:ColorMapEntry>`), which `parse_sld()` must tolerate — matching only the bare `<ColorMapEntry>` parses ZERO entries and the failure surfaces much later as "no colour map".
- **The USDA raster holds ~818 SUBCLASS codes, not 12 class ids.** The publisher's SLD maps every code to its parent order ("79" → "1. Alfisols" … "817" → "12. Vertisols"), so classification is a **LUT (code → order)**, not an interval break and not wrb's one-code-one-class value map. The LUT is sized for the whole UInt16 range so nodata (32767) and any surprise value index safely to 0 = transparent instead of throwing mid-build. The **grid stores the PUBLISHED order index (1..12)**, never the raw code — the client looks values up in `meta.classes` by `index`.
- **Never regenerate the SLD cache by hand.** The class breaks and colours are fetched once and reused offline; a hand-edited break makes the map disagree with soilgrids.org.
- Outputs live under `public_html/data/soil/{key}/` (`tiles/{z}/{x}/{y}.png`, `grid.bin` Int16 probe, `meta.json`). **PNGs are Caddy-immutable for a year** — bump `BUILD` in `public_html/soil-layer.js` whenever any pyramid is rebuilt, or cached browsers keep the old colour map. (Adding a NEW property directory does not require a bump: those URLs were never cached.)
- **Ten properties share ONE layers-control entry** (`🟫 Soil`). A property switcher chips row in the dropdown legend swaps the tile URL in place; ten separate checkboxes would drown the dropdown. The two **classification** maps come first — `wrb` (WRB groups, the default) then `usda` (USDA orders) — then `texture`, then the seven continuous properties.
- **THE CORNER CREDIT FOLLOWS THE ACTIVE PROPERTY.** Nine properties credit ISRIC, `usda` credits OpenGeoHub — `PROP_ATTRIBUTION` + `attributionFor(key)` in `soil-layer.js`, applied when the tile layer is rebuilt on every property switch. A single static "SoilGrids" credit would be a **licence breach in the most visible place on the page** while USDA tiles are on screen. The export surface uses **getters** for `attribution`/`source` for the same reason (the export contract preserves accessors — see `export-contract.js`); both publishers are CC BY 4.0, so `licence` stays a literal.
- **The probe reads the same `grid.bin` the tiles were classified from** — never a second data source, or the number under the cursor will eventually disagree with the colour. The client checks `arr.length === width * height` before using a grid; a half-downloaded `grid.bin` must not format `"NaN %"` into the probe.
- `verify()` in the builder is a gate, not a checkpoint: it probes the Sahara (sand-dominated, alkaline), Amazon (clay, acidic), Netherlands, Ganges delta, etc. against the **source** raster; `verify_usda()` does the same for the orders (Kansas → Mollisols, Deccan → Vertisols, Siberia → Gelisols). A flipped axis still produces a plausible-looking map; only the known-places probes catch it.
- `public_html/soil-layer.js` must load **BEFORE `app.js`**, and must be in `scripts/bump_frontend.sh`'s `ASSETS` list. Pane is `soilPane` (z-index **352**).
- Probe mode owns map clicks: `SoilLayer.blocksClick()` must keep returning true while armed, and app.js's click-to-submit guard must stay.
- The builder runs as **`python3 scripts/soil_build.py --layers usda`** — the `-m scripts.soil_build` form in older notes does NOT work (a `scripts` package in site-packages shadows the repo's namespace package).

## Cropland / Land-Cover Overlay Rules (ESA WorldCover)

- The source is **ESA WorldCover 10 m v200 (2021)** (CC BY 4.0), 2,651 three-degree GeoTIFF tiles on the public S3 bucket, read in place over `/vsicurl/`. `scripts/cropland_build.py` warps each source tile into the zoom-level grid and cuts XYZ PNGs for **two modes from the same classified pixels**: cropland-only (class 40) and the full 11-class map.
- **Two layers-control entries, one module**: `🌾 Cropland (ESA)` and `🗺️ Land Cover (ESA)`, both from `public_html/cropland-layer.js`, sharing `meta.json` + `grid.bin` + `class.bin`. Water (class 80) is drawn **transparent** — the basemap already has it — and is also left out of the legend key.
- Tiles are PNG → bump `BUILD` in `cropland-layer.js` after any rebuild. Pane is `croplandPane` (z-index **353**). `CroplandLayer.blocksClick()` gates click-to-submit while probe mode is on.
- `verify()` probes the North China Plain, Ukrainian steppe, US corn belt, Congo basin and mid-Atlantic against the published cropland-share grid. Never bypass it.

## River Overlay Rules (Natural Earth)

- The source is **Natural Earth 10m Rivers + Lake Centerlines** (public domain), already in the repo as `maps/ne_10m_rivers_lake_centerlines.zip`. `scripts/river_build.py` converts it once into `public_html/data/rivers/rivers.geojson` + `meta.json`.
- **Vector, not tiles.** 1,473 lines is far too little for a raster pyramid, and a GeoJSON wash stays crisp at every zoom. The client styles each feature by Natural Earth's `scalerank` (rank 1 = Amazon, always on; rank 9 = a creek, only at street zoom) and filters by `min_zoom`.
- **Labels only for rank ≤ 4 named rivers, and only at zoom ≥ 4.** Without that gate the map drowns in creek names. At most 40 labels, placed at a vertex a third along the longest line so the callout is not stuck on a headwater or a mouth.
- **THE NAMES ARE OFF BY DEFAULT, AND THERE IS NOW A SWITCH FOR THEM (2026-11-08).** This layer had **no way to turn its names off** — they appeared whenever the layer was on, at zoom ≥ 4. Owner ask: *"not to show any labels if the user doesn't want to see them.. so default it without labels"*. **The same rule as the FAO layer** (a name is an option, not the price of admission): the store key is **`xyzo.rivers.labels`**, the fallback is **"0"**, the switch lives in a small legend inside the layers dropdown (`#ctrl-rivers-labels`, mounted with the usual retry until the control exists), and an explicit "on" is remembered. **The names are the good kind** (Natural Earth names its rivers properly — "Missouri", "Mississippi", "Ohio"), but the rule is the reader's and it is the same on both river layers.
- `verify()` requires the Amazon, Nile, Mississippi, Danube, Yangtze and Congo to be found near their true coordinates. A swapped axis fails every probe at once.
- `public_html/river-layer.js` loads BEFORE `app.js` and is in `bump_frontend.sh`'s `ASSETS`. Pane is `riverPane` (z-index **365** — above the isobars and climate washes, below wind and pins). Rivers **never** block map clicks (`blocksClick()` returns false).

## River Overlay Rules — FAO AQUASTAT "Rivers (Global, edition 2026)" (2026-11-05)
The **real** river network: every reach on Earth with a catchment of 10 km² or an average flow of 0.1 m³/s — more than a million reaches, against Natural Earth's 1,473 centrelines. **CC BY 4.0**; attribution is printed in the map's attribution bar.

- **THE TILES COME FROM OUR OWN PROXY** (2026-11-06). `api/src/routes/faoRiversProxy.ts` → **`/api/tile/fao-rivers/<level>/{z}/{y}/{x}`**. It does three things. **(1) THE UPSTREAM URL IS BUILT SERVER-SIDE**, from a whitelist — the level's own filter and the **PUBLISHED** SLD (`data/rivers/fao/meta.json`) — so the **4.3 KB SLD body and the discharge filter no longer ride in every tile request** (the request line was 4.6 KB; it is now ~60 bytes) and **there is no SSRF surface at all**: there is no `?url=` parameter. **(2) THE TILE IS CACHED ON DISK** — `data/fao_rivers_tiles/<edition>/<level>/<z>/<y>/<x>.png`, gitignored and OUTSIDE the web root — so the **second reader of a view is a local file**. The NASA tile proxy's cache is in-memory and dies with the process; this one survives a restart. **(3) A TILE THE PUBLISHER CANNOT PRODUCE ANSWERS 200 WITH A TRANSPARENT PNG** (the house rule: a 404 on a tile is a browser-logged console error). **Measured at the reader's own URL: 36 requests still streaming at 64 s → the whole screen in ~2 s on every visit after the first.** **THE REQUEST COUNT IS 35, NOT 12, AND THAT IS CORRECT**: the layer is on the **standard 256-px slippy grid** (see the `tileSize` trap below — a 512-px grid fetches every tile from the wrong quadrant of the world), so a 1400×900 screen needs 35 of them. The publisher's cost does not depend on the output size, so the tiles are still rendered at 512 px and the browser downscales them into the slot — **sharpness is free, the request count is not**.
- **THE DATA CANNOT COME TO THE CLIENT, AND THE MEASUREMENTS SAY WHY.** Moving work to the client only helps when the DATA is smaller than the work. For this network it is not: the whole thing is **~700 MB** of GeoJSON (a 10° box alone is 28 MB), **one screen's vector data** (WFS by bbox) is **12.3 MB at z8 and 26.8 MB at z5–z7** and takes **8–13 s** to fetch, while **8 raster tiles in parallel** complete the same screen in **2–3 s** (and ~2 s warm from the proxy's disk cache). **The raster WINS because the server renders in parallel and the browser cannot** — and the browser would also have to parse 27 MB before it could draw a line. **THE ONE THING THE RASTER CANNOT DO IS CARRY ATTRIBUTES** (`ORD_FLOW`, `DIS_AV_CMS`, `LENGTH_KM`, `UPLAND_SKM`, `CATCH_SKM`, `HYRIV_ID`): a **±0.02° box returns ONE reach with all six in 1.1 KB**, but the publisher still takes **3.8 s** (the same fixed overhead). Through the same proxy that would be a ~0.1 s click — **that is the recommended next step and it is NOT built yet.**
- **THE GENERAL RULE THIS SUGGESTS.** For an overlay whose data is **large** (rivers, soil grids, climate rasters, population), **cache the rendered tile at the edge and let the client own everything else** — the labels, the level, the legend, the export, the HUD. For an overlay whose data is **small** (labels, probe grids, the wind grid, pins), **send the data and do the work in the browser**, which is what the site already does. **The rivers were the outlier: they had neither a cache nor a small payload**, and the proxy is the missing half.
- **THE TILES AT z0-z4 ARE OUR OWN, RENDERED FROM OUR OWN COPY** (2026-11-06). `scripts/river_network_fetch.py` pages the 2026 edition out of the publisher's WFS into `data/rivers_fao_2026/` (gitignored, **outside the web root** — the upstream licence does not permit the data to be distributed as a stand-alone product), and `scripts/river_tiles_build.py` renders a **static PNG pyramid** from it into `public_html/data/rivers/fao/tiles/<level>/<z>/<x>/<y>.png` — **1,364 tiles, 114 MB, four levels** (z0-z4). **Above z4 the tiles still come from the proxy.** The split is measured: the publisher takes **25-48 s a tile at z1-z2** and ~2 s above z3, so the world views are what we take over. **The copy is the WHOLE NETWORK — 8,477,883 reaches in 212 pages (654 MB, 95 minutes) — and it reproduces the publisher's own counts exactly (273,191 reaches above 100 m³/s, 857,210 above 10)**, which is the proof that nothing was missed. **MEASURED AT THE WORLD VIEW: the whole screen arrives in 0.71 s from our own disk** (18 tiles), where the publisher wanted a minute-plus; **a country-sized z4 view in 1.63 s** (28 tiles), and a zoomed-in z5 view in **2.9 s** once the proxy's disk cache has it (18 s for the very first reader of an area). **THE RENDERER MIRRORS THE PUBLISHED SLD** — the same `ord_flow` and `smooth_200` rules, the same colours, the same widths — and it draws in **WEB MERCATOR** (see the trap below). **TWO THINGS THE BUILD KNOWS AND THE MAP DOES NOT.** **(1) THE FETCH ONLY PAGES WITH A STABLE SORT** — `startIndex` without `sortBy` throws `java.lang.RuntimeException: java.io.IOException` (measured), and the page cap is 40,000. **(2) THE IDS ARE ORDERED BY REGION, NOT BY GEOGRAPHY** — the first 920,000 reaches of the fetch are **North Africa and nothing else**, so a pyramid built from a partial fetch is a picture of one continent. The build's `verify()` checks the pages are contiguous and that four known rivers are in the copy.
- **THE TILE'S NORTH EDGE IS THE LARGER NORTHING — GETTING IT WRONG FLIPS THE TILE.** In EPSG:3857 y grows NORTHWARD, but the slippy ROW index grows SOUTHWARD, so row 0 is the top of the world and its northing is the largest. The renderer had it the other way round and the tile came out **vertically flipped** — and a flipped tile is not a subtle error: measured against the publisher's own rendering of the same ground, the pixel overlap collapsed to **6 %**. The check that catches it is cheap and belongs in the build: **render one tile and compare it with the publisher's own tile for the same square** — after the fix the two are **98 % pixel-identical** (the rest is PIL's hard stroke edges against GeoServer's antialiased ones).
- **THE PUBLISHER'S OWN RENDERING IS THE TEST FIXTURE.** The proxy asks for a tile with the same SLD and the same bbox the builder used, and the two are compared pixel for pixel. That is what caught the flip, and it is what proves our renderer draws the same picture.
- **THE TILE GRID IS THE STANDARD SLIPPY GRID — `tileSize: 512` PUTS THE RIVERS ON THE WRONG CONTINENT** (2026-11-06, and the bug behind *"the rivers look like they are not placed correctly"*). Leaflet's `_pxBoundsToTileRange()` divides the pixel bounds by the **TILE SIZE**, so a layer with `tileSize: 512` asks for a **512-px GRID**: its tile (11, 7) covers the ground of the STANDARD square (22, 14). Our pyramid and the publisher are both cut on the standard 256-px grid, so a 512-px layer fetched every tile from the **north-west QUADRANT of where it belonged** — measured: a tile the map wanted at longitude 85° was fetched from longitude **-56°**, and the rivers were drawn over the Indian Ocean out of Greenland. **It is the same rule the Macrostrat geology layer records** (the CRS scale is fixed at `256 · 2^z`), and it is invisible in a screenshot: the picture still looks like a plausible river network, just from the wrong continent. **THE FIX IS ONE OPTION: `tileSize` STAYS AT THE DEFAULT 256**, and the sharpness comes from the IMAGE instead — the publisher renders the standard square at 512×512 and the browser downscales it into the 256-px slot (free: the publisher's cost is the query, not the rasterising). **THE LINE-WIDTH HIERARCHY NEEDS THOSE PIXELS**: the classes span 1.25 → 0.35 px, and at 22.8 px/° every one of them rounds to 1 px and the hierarchy collapses — so the tiles stay at 512 px. Pinned by `public_html/tests/fao-rivers-layer.bun.test.js` (*"the tile grid is the STANDARD slippy grid — tileSize must stay 256"*).
- **EVERY TILE URL CARRIES A BUILD TOKEN.** A `*.png` under `public_html` is served **`immutable` for a year**, and the proxy answers with `max-age=604800` — so the misaligned tiles stayed in every reader's browser cache for a **week** (proxied) or a **year** (our own static ones), and a rebuilt pyramid was invisible behind an unchanged URL. **A URL is the cache key**, so a `?v=` token is the only thing that invalidates it; bump `TILE_BUILD` whenever the tiles are rebuilt.
- **THE PROXY'S BBOX MUST BE IN WEB MERCATOR (EPSG:3857), NOT IN LAT/LON.** The slippy tile grid is a Mercator grid and Leaflet places a tile by its Mercator square. Asking GeoServer for the same lon/lat extent with `SRS=EPSG:4326` returns a **PLATE CARRÉE** image — the same rivers on a latitude-linear axis — which Leaflet then stretches over a Mercator square. **Measured at z2 the two are visibly different: North America squashed to the top of the tile, Africa pushed down.** At z4 over the equator the error is under a percent and looks PERFECT, which is why it survived an audit — it only bites at low zoom and at high latitude. One line: send the bbox in the same CRS the grid is in.
- **THE PROXY ROUTE MUST BE REGISTERED BEFORE THE NASA ONE.** The NASA proxy's pattern is `/tile/:dataset/:date/:z/:y/:x`, which matches **ANY five-segment path** under `/tile/` — including `/tile/fao-rivers/medium/8/8/8`. The FAO route's first segment is the LITERAL `fao-rivers`, so it claims only its own URLs, but it must be **registered first** or the NASA route answers them with `unknown_dataset` (measured).
- **THE IMAGES ARE 512 px; THE GRID IS 256 px — AND THE TWO MUST NOT BE CONFUSED** (2026-11-06). The publisher renders a 256 px tile of this network in **~2.4 s** and a **512 px** tile of the **SAME AREA** in **~2.4 s** too — the cost is the query and the set-up, not the rasterising — so we ask for **512 px images of the standard square** and let the browser downscale them into Leaflet's 256-px slot. That is free sharpness at no extra upstream cost. **What is NOT free is changing Leaflet's `tileSize`** — see the trap above: it changes the GRID the coordinates live on, and the tiles then come from the wrong continent. **The request count doubled (12 → 35 for a 1400×900 screen) and that is the price of being on the standard grid.** It is paid once: our own pyramid answers z0-z3 from disk (**the world view now arrives in 0.71 s, 18 tiles**), the proxy caches z4+ **on disk**, and the browser caches them in the service worker — so only the FIRST reader of a zoomed-in area waits for the publisher.
- **THE LINES ARE THE PUBLISHER'S WMS, NOT OUR FILES.** `https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wms`, layer `river_network`. The network cannot be shipped — a 10° box of it is **28 MB** of GeoJSON, the world ~700 MB — so the publisher renders it at whatever zoom it is asked for. That is the only reason *"as detailed as possible"* is possible at all.
- **THE DETAIL LEVEL IS A SERVER-SIDE `CQL_FILTER`** on `dis_av_cms` (the long-term average discharge): **Major** ≥ 100 · **Medium** ≥ 10 · **Fine** ≥ 1 · **Full detail** (no filter). The thinning happens on the publisher's side, so the tiles stay small — measured over the lower Amazon, one 256 px tile: **38 KB / 73 KB / 144 KB / 226 KB**.
- **THE PUBLISHER'S OWN STYLE OMITS 59 % OF THE NETWORK.** Its published style (`river_network_v1`) has rules for `ord_flow` **1..6 only** — every reach of order 7 and finer (**42,610 of 71,687** over the lower Amazon) **is not drawn by it at all**. A GetMap for exactly those reaches (`CQL_FILTER=dis_av_cms<1`) answers **HTTP 200 with a tile of ZERO opaque pixels**: no error, an empty map. Our own SLD adds the missing class, and `river_network_build.py::verify()` checks BOTH halves every build (the first alone would pass on a server that merely had no data there).
- **WE DRAW THE CARTOGRAPHY OURSELVES, because theirs is dark-on-light.** Order 1 is `#042946` — near-black navy — and the pale classes carry the fine network, so over this site's default dark basemap the main stems vanish and only the tributaries survive. The client sends its own SLD (GeoServer's **`sld_body`** vendor parameter) from the same attributes (`ord_flow`, `smooth_200`) but **BRIGHT AT BOTH ENDS** — the greatest rivers white, the finest twigs a pale thread, the intermittent reaches a dashed amber. **The SLD is BUILT BY THE BUILDER AND PUBLISHED** (`scripts/river_network_build.py` → `meta.json`), so the legend's key and the map come from the same rows and cannot disagree.
- **TWO GeoServer SLD TRAPS, BOTH MEASURED.** **`ogc:PropertyIsBetween` CRASHES the renderer** — it answers 200 with a ServiceException carrying `java.lang.NullPointerException`, i.e. a blank tile and a silent failure, so a range is an `ogc:And` of `GreaterThanOrEqualTo` + `LessThanOrEqualTo`. And **EVERY MATCHING RULE RENDERS** (not "first match wins"): a cumulative ladder (`ord_flow <= 2`, then `<= 4`, …) painted the whole Amazon in the palest colour of the ramp, so the ranges must be **disjoint** — and each carries `smooth_200 = 'P'`, or a dashed intermittent reach is drawn twice and the solid one covers the dash.
- **THE WMS AXIS ORDER IS A TRAP.** **WMS 1.3.0 + `srs=EPSG:4326` uses the CRS authority's axis order**, which for EPSG:4326 is (latitude, longitude): ask for the Amazon with `bbox=-62,-5,-52,0` and the server renders **ANTARCTICA** — a blank tile, a 200, no error. The client asks for **1.1.1**, where (longitude, latitude) is mandated. **The WFS and the WMS disagree on the same server**: the WFS reads `bbox` as **(miny, minx, maxy, maxx)** whatever `srsName` says, and a bbox plus a `CQL_FILTER` are **mutually exclusive**.
- **THE 2026 NETWORK CARRIES NO NAMES.** Its attributes are hydrology only (`HYRIV_ID`, `NEXT_DOWN`, `ORD_FLOW`, `LENGTH_KM`, `DIST_UP_KM`, `DIST_DN_KM`, `UPLAND_SKM`, `CATCH_SKM`, `DIS_AV_CMS`) — there is no `NAME` on a reach and none can be invented. The names come from the FAO's **classic** rivers layer (`rivers_world_47950`, 86,882 named features) and are published as **5,097 anchor points**. **A NAME IS ONLY LABELLED IF IT IS A RIVER**: `maj_name`/`sub_name` are BASIN names and many are places ("Gobi Interior", "Lake Chad", "Sahara"), so a word list drops them (**62,912 dropped**); trailing digits go too ("Amur1"…"Amur4" are one river's numbered sub-basins).
- **THE NAMES ARE OFF BY DEFAULT ON BOTH RIVER LAYERS (2026-11-08).**
  Owner ask: *"not to show any labels if the user doesn't want to see
  them.. so default it without labels"*. The FAO layer had a switch and
  the Natural Earth layer had **none** — so its names could not be
  turned off at all. **Both now have a switch, and both start OFF**
  (`xyzo.faoRivers.labels` / `xyzo.rivers.labels`); an explicit "on" is
  remembered, so it is a default and not a removal. **WHY, MEASURED ON
  THE SOURCE:** the classic FAO layer the names come from
  (`rivers_world_47950`, 86,882 features) **has no river name** — its 18
  attributes are topology, basin ids and `maj_name` / `sub_name`, which
  are **BASIN** names. So the map prints "Cahokia / Joachim",
  "Mississippi - Missouri" — **601 of 5,097 names are compounds** — plus
  places ("Gobi Interior"), abbreviations ("Ko", "Mu", "Po") and
  **Spanish area descriptions** ("Zona de rios en Chaco Boreal").
- **`a_strahler` IS NOT THE RIVER'S ORDER — the source has two Strahler
  fields and the WRONG ONE LOOKS RIGHT.** `strahler` is the order of a
  **segment**; `a_strahler` is the order of the **basin**, and it is the
  larger of the two in **93.3 %** of the features, so it reads like "the
  river's order". **Measured: gating on it admits 5,830 of 5,858 names
  at zoom 6 (everything) and ranks fragments and places as the greatest
  rivers ("Boumba", "Gulf of Guinea").** **`strahler` is the right
  field** — the gate leaves 769 names at zoom 6, 286 at zoom 4.
- **THE PUBLISHER'S MANGLED ACCENTS ARE NOT RECOVERABLE.** 1,546 of the
  86,882 features carry the UTF-8 of **U+FFFD, encoded a second time**
  ("Ariï¿½ge" for "Ariège"). **Verified at the source** — the live WFS
  sends the bytes `c3 af c2 bf c2 bd` — so the character is gone from
  THEIR data. The builder prints a plain **"?"**. **THE 16 AREA
  DESCRIPTIONS** (in Spanish, which is why the English word list never
  caught them) and the **two-letter abbreviations** (the FAO's
  abbreviated sub-basin labels: "Ko" is a reach of Lake Chad, "Lom" of
  the Danube — the parent is published under its own name, so nothing is
  lost) are dropped.
- **THE UPSTREAM LICENCE MUST SURVIVE A REBUILD.** The builder
  OVERWRITES the published `meta.json`, and it used to drop the
  **upstream** attribution (the Exhibit B statement the HydroSHEDS
  licence requires to travel with the metadata) — it had been published
  once by a builder version that no longer existed, so a rebuild
  **dropped it** and `data-licences.bun.test.js` failed on the published
  file. The text now lives in the builder (`UPSTREAM`,
  `UPSTREAM_ATTRIBUTION`, `UPSTREAM_CITATION`) and the fetch script
  imports it from there: **one statement, two places it travels.**
- **THE LEVEL TRAVELS WITH THE LINK** (`/rivers=full`), the same argument as the isobar step: "Major" and "Full detail" are different maps. A link's level is a **VIEW** — `setLevel(…, { persist: false })` — so opening someone else's map never overwrites the reader's own choice.
- `public_html/fao-rivers-layer.js` loads BEFORE `app.js` and is in `bump_frontend.sh`'s `ASSETS`. Pane is `faoRiverPane` (z-index **371**). Rivers **never** block map clicks (`blocksClick()` → false) and the **labels are `interactive: false`** — a permanent tooltip is interactive by default in Leaflet, and a label that takes a click breaks the click-to-submit flow. `scripts/fao_rivers_audit.py` drives the live map with Playwright.

## Magnetic Overlay Rules (World Magnetic Model)

- The source is the **NOAA NCEI / British Geological Survey World Magnetic Model 2025** (WMM2025, valid 2025.0–2030.0), US Government work — public domain. The entire model is a 3 KB coefficient file (`WMM.COF`: 90 Gauss coefficients, each row carrying both the main-field term and its secular-variation rate). D, I and their annual change all come from this one file. Landing page: `ncei.noaa.gov/products/world-magnetic-model`; the zip is `ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip`.
- **The coefficient file is VENDORED at `worker/data/WMM2025.COF`** (with `WMM2025_TestValues.txt`). NCEI is mid-cloud-migration and their downloads have been intermittently unavailable; a build must never depend on their uptime. `python -m worker.magmap --fetch` refreshes the copy.
- **This is a STATIC model — no timer, no fetch cycle, no GRIB.** The WMM changes over years, not 6 hours (a new one ships every ~5 years; WMM2030 is expected late 2029). Rebuild with `python3 -m worker.magmap` when a new WMM ships or to roll the evaluation date forward. Unlike isobars/tempmap/windmap there is no systemd unit.
- **The verify() gate is NOAA's own published test values** (shipped inside the coefficient zip, ~100 points across dates, altitudes to 94 km and both hemispheres). The synthesis must reproduce D/I to 0.005°, X/Y/Z to 0.0 nT and the secular variation to 0.00001°/yr — the test file quotes D/I to 2 decimals and SV to 6. A sign flip, a transposed Gauss-coefficient index or a missing Schmidt factor fails HERE, never in production: a wrong synthesis still produces a field that *looks* like Earth's. `worker/tests/test_magmap.py` pins this plus the relationship gates (I > 0 at the north pole, I < 0 at the south, blackout = two small polar caps, H positive-definite).
- **The annual change is the ANALYTIC chain-rule rate, NOT a one-year forward difference.** WMM is linear in its coefficients, so Ẋ/Ẏ/Ż is just the synthesis of the (ġ, ḣ) tables, and dD/dt = (X·Ẏ − Y·Ẋ)/H² follows from D = atan2(Y, X). A `D(t+1) − D(t)` finite difference disagrees with NOAA's published dD/dt by up to 0.1°/yr near the dip poles, where D curves fast and H is small — that is exactly the error the SV gate catches (worst test point is lat 89°, H = 1504 nT).
- **Declination must NOT be contoured directly.** D is an angle in [−180, +180]; a cell straddling the ±180 branch cut holds two corners ~358° apart while the true field barely changes, so marching squares draws a FALSE line wherever D wraps. The isogonic line at level L is instead the zero set of the smooth scalar **S_L = Y·cos L − X·sin L** (linear in the smooth X, Y — no branch cut anywhere). That zero set contains BOTH the D = L and D = L+180 lines; the companion **P_L = X·cos L + Y·sin L = ±H** on the zero set tells them apart by SIGN. **Cut each stitched polyline wherever the sign of P_L flips and assign every constant-sign run its own level** (L where P_L > 0, else L+180 wrapped into [−180, 180)). The branches converge at the dip pole where H → 0 and the stitch walks straight through the meeting point — a single level for a whole polyline silently steals the ±100…±180 family (the lines circling each magnetic pole) and drops them into the mid-levels. Inclination lives in [−90, +90] with no wrap, so it is contoured directly.
- **The grid uses the GFS longitude convention: 0..359, NOT −180..179.** The torus-window arithmetic in `contour_scalar` (copied from the isobar pipeline) places the clipping window at `[origin+180, origin+540]` with shift `origin+360`; that formula puts the window EDGES on the antimeridian and the prime-meridian seam in the interior, which is what a flat map in [−180, 180] needs. With an origin of −180 the same formula centres the window on the antimeridian instead and **every contoured line comes out shifted by 180°** — the published lines sample S = 5000+ nT instead of ~0 while still looking like plausible curves.
- **Blackout zones: H < 2000 nT** (NCEI's own error model: that is the Blackout Zone where the compass needle stands vertical and declination is undefined; 2000–6000 nT is the Caution Zone). The worker publishes a `mask.bin`; the wash leaves those cells transparent and the probe reports "Blackout zone — compass unreliable" — the same blank circles NOAA prints on its own charts. Contour lines are CUT at the mask boundary (a line that merely clips the cap must survive; a chart never shows lines inside the blank).
- Contour post-processing reuses the isobar primitives (`marching_squares`, `stitch_segments`, `chaikin_smooth`, `simplify`, `merge_lines`, `filter_short_chains`, `clip_to_lon_range`) — copied, not imported, because `worker/isobars.py` imports `worker.db`/`eccodes` at module level and this worker needs neither. `SIMPLIFY_TOL_DEG = 0.03` stays below the ~0.06° amplitude Chaikin leaves behind (or the staircase returns) and above the noise floor (these lines are smooth on a global scale). The isoporics pass a tighter `simplify_tol=0.01` because Ddot's steeper gradients turn the default tolerance into a visible value error along the published line.
- **Chart lines come in two ranks.** INDEX (major) contours every 10° (1 °/yr for the isoporics) are the labelled, always-visible lines; INTERMEDIATE (minor) contours every 2° (0.25 °/yr) fill in between — the way a topographic map draws thin contours between its bold index contours. Every GeoJSON feature carries `major: true|false`; the frontend hides minors below zoom 4 (at world view they turn the chart into a hairball) and never labels them. Do not collapse the two ranks into one spacing: 10° alone looks sparse at country zoom, 2° alone is unreadable at world zoom.
- **Isoporic lines** (equal annual change of declination, every 0.25 °/yr, `isoporics.geojson`) show where the compass reading is drifting and how fast. Ddot is a plain rate — no angle wrap, no branch cut — so it is contoured directly like inclination. The Ddot = 0 line ("no change") is flagged `special: "nochange"` like the agonic/aclinic lines.
- **The wash ramps are diverging: violet → azure → CYAN (zero) → gold → crimson** (redesigned 2026-10-30). Zero is the meaningful state for every field here (agonic, aclinic, "no change") and must glow, not vanish into the basemap — but it is now a **saturated cyan (#00e5ff, hue 190°, blue side of cyan)**, never green: the old ramp flanked its neon-green plateau with a pale green and a yellow-green, so the chart read "green on both sides of zero" and the ΔD wash — whose plateau covered most of the globe — made the map a green ball. **A pastel centre is just as wrong**: the first fix used ice-white (#a8fbff), and because half the map sits inside the plateau the rendered field came out washed out. Saturated cyan glows *and* stays a colour. **No stop on a diverging ramp may be green-dominant** (`g > r and g > b` fails `verify()`), and the wings stay saturated so wing→centre is a hue change rather than a tint. The sequential ramps (F, H — magnitudes, one-sided) are indigo → violet → rose → amber, also green-free. The ramps carry a FLAT cyan plateau at ±plateau — **6° for D, 3° for I, 4′/yr for ΔD, 2′/yr for ΔI, 12 nT/yr for ΔF/ΔH** (all narrowed on 2026-10-30: a wide flat band spends half the map on one colour, so a narrower one lets the gradient show) — and the stops must ascend in `c`; the shoulder stop is clamped to `min(plateau·2.5, span·0.15)` so it can never land outside the wing stop, with `diverging_ramp()`'s sort kept as a safety net. The SV ramps are expressed in the PUBLISHED unit, arcmin/yr (±120 and ±30), because the wash samples the stored grid and the stops must live in the same units.
- **ALPHA IS SEPARATE FROM THE RAMP, and the wash must not be an opaque sheet** (2026-10-31). Each field publishes its own `{t, a}` table in `meta.fields[k].alpha` — the contract the lightning meta has always used — so the wash is **nearly clear at zero (~40/255) and solid at the wings (~240/255)**. Without it the bake wrote `alpha = 255` everywhere, and the ΔD zero plateau — ~52 % of the globe — painted a flat cyan SHEET over the basemap: measured mean alpha 255, now **116, with 37 % of the globe nearly clear**. The diverging tables derive their transparent band from the **same `plateau` the colour uses**, so the see-through core and the flat cyan band are the same width; the sequential tables (F, H) ghost the weak field and solidify the strong, so the South Atlantic Anomaly reads as a hole — which is what it is. **`check_alpha_tables()` gates them at build time** (`write_outputs()`): a table missing, non-ascending, or with an opaque core (< 80 fails) aborts the publish. A client that receives none falls back to a fully opaque wash (`alphaAt` returns 255), so a **missing table is a silent regression** — that is why the gate exists. The legend bar renders the alpha too (`rgba()` stops): an opaque bar promises a sheet the map does not draw. Both clients consume the table — `mag-layer.js` bakes it into its RGBA LUT, `globe.js` into its equirectangular bake.
- **THE CONTOUR LINES TAKE THE RAMP'S COLOUR, NOT INK** (2026-10-31). AGENTS.md calls the lines the hero of this overlay and they shipped `#111827` — invisible on the dark satellite basemap the site opens on. `styleFor()` now colours each line from the **field's own ramp at the line's own level** (`lineColorFor()`), lifted toward white (35 % for index/minor, 20 % for the specials) so a line at level L still reads **on a wash of ≈ ramp(L)** — the same hue underneath it, which an unlifted line would vanish into. The agonic / aclinic / no-change landmarks sit at level 0, so they land on the cyan glow automatically. The globe's `mag-lines` layer does the same with a **data-driven `["interpolate", ["linear"], ["get","level"], …]`** expression built from the ramp in `renderMagField()`, with `level == 0` pinned to the cyan glow — and it is applied under the `gen` guard so a *failed* fetch for a stale field cannot repaint the lines with the field the user just left.
- Outputs under `public_html/data/mag/`, deliberately **NOT .png** (Caddy serves every `*.png` immutable for a year — the bug that hid the Köppen layer): **eight line sets** (`isogonics` / `isodynamics` / `isohorizontals` / `isoclinics` for D/F/H/I, `isoporics` + `isoporics-{i,f,h}` for ΔD/ΔI/ΔF/ΔH), **eight Int16 planes** `grid_{d,f,h,i,ddot,fdot,hdot,idot}.bin` carrying a **per-field `scale`** at `meta.fields[k].scale` (100 → 0.01°/0.01 arcmin/yr for the angles and angle rates; **0.25 for F, 0.5 for H** — one scale cannot hold a ±180° angle and a 67,000 nT magnitude; `meta.grid.scale` stays 100 only as the default an OLD cached meta.json knows), `mask.bin`, `meta.json`. Each `meta.fields[k]` also carries `label` (the globe builds its component chips from it — **without that label the four chips render EMPTY**, because `magEsc(undefined) === ""`), `unit`, `component`, `mode`, `boz`, `lines`, `line_minor`/`line_major` and `label_step`. No BUILD token is needed: these revalidate.
- **The LINES are the hero; the colour wash is optional and OFF by default.** One layers-control entry `🧭 Magnetic Field (WMM)` serves **four components × two modes = eight fields** through **two chip rows** in the legend (`COMPONENT_ORDER` / `MODE_ORDER`, built from the tables so a field added to the worker appears without editing the markup) — eight checkboxes would drown the dropdown. Switching component or mode swaps the GeoJSON line set AND the wash plane (ONE family at a time, not all eight). The wash is a custom `L.GridLayer` painted client-side into a baked Mercator canvas (temp-layer pattern: bake once, blit per tile, `done()` ASYNC, `setOpacity` shim on the bare GridLayer). The lines are an `L.geoJSON` group (river-layer pattern) with the `setOpacity`/`getOpacity` shim the layers machinery calls — a raw GeoJSON has no such method and its absence aborted the rest of app.js when the rivers shipped it. **`setOpacity()` drives BOTH halves** — the contours *and* the wash, through `addWashToMap()`, which also pushes the slider's value onto the container after `addTo` (a GridLayer does not apply its `opacity` option the way TileLayer does). Until 2026-10-30 the slider only restyled the lines while the wash stayed pinned at its creation value: with the wash on, the whole slider moved the picture's mean luminance from 190.5 to 190.8 — nothing (found with Playwright; now 190 → 178 → … in lockstep with the container's style). `ensureData()` loads the FOUR planes of the active mode up front so the probe shows all four of that mode together.
- Pane is `magPane` (z-index **358** — above climate 350, below isobars 360). `public_html/mag-layer.js` loads BEFORE `app.js` and is in `bump_frontend.sh`'s `ASSETS`. `blocksClick()` returns true while the probe is armed (app.js's click-to-submit guard must keep the check). The probe reads `e.latlng`/`e.containerPoint`, never `offsetX`/`offsetY` (the pin canvas is 300 px wider than the map and offset by −300 — the wind probe shipped that bug).
- The agonic (D = 0) and aclinic (I = 0) lines are flagged `special` in the GeoJSON and rendered thicker/darker with a red label; the label gate shows only |level| multiples of 30 below zoom 5. Pinned by `worker/tests/test_magmap.py` and `public_html/tests/mag-layer.bun.test.js`.

## Human Transportation Overlay Rules (NOAA "Anthropocene")

- The source is **NOAA Science On a Sphere's "Human Transportation"** (`sos.noaa.gov/catalog/datasets/human-transportation/`, file `ftp_mirror/extras/human_transportation/anthropocene.png`), NOAA NESDIS / GSL — US Government work, public domain. Black Marble 2012 night lights + **red** 87,000 daily flights + **blue** 3,500 commercial vessels (~10 % of shipping) + **green** world roads. One frozen equirectangular (2:1) PNG.
- **The asset is a ONE-TIME conversion, not a build pipeline.** The original is 4096×2048 16-bit (31 MB); we ship `public_html/data/transport/human-transportation.png` at **2048×1024 8-bit (522 KB)** — it is a decorative context layer, not a probe-backed grid, and PNG keeps the thin coloured route lines crisp where JPEG would ring. **There is no builder script and no regeneration step**: to re-fetch, curl the FTP-mirror URL and downsample with ffmpeg/Pillow. Do not wire this into `bump_frontend.sh`'s ASSETS — only the JS is stamped, never the PNG.
- **The `.png immutable` rule is CORRECT here, unlike Köppen.** Caddy caches `*.png` for a year, which hid the rebuilt Köppen pyramid behind a stale token (2026-10-22) — but that rule only bites *regenerated* assets. This image is frozen 2012 data that is never rebuilt, so permanent caching is exactly what it should have. Never "fix" this by renaming the file to dodge the rule.
- **`L.GridLayer`, NEVER `L.imageOverlay`.** An imageOverlay spans ONE copy of the world; panning past the antimeridian leaves a blank gap (the documented temp-layer pitfall). The GridLayer repeats, and because its tiles are Web Mercator while the source is equirectangular, **each tile row's latitude must be resolved through the inverse Mercator (`tileLat`)** before mapping to a source row — sampling in latitude-space shifts the routes off the cities they connect. A tile straddling the world edge is drawn as **two `drawImage` blits**, exactly as the temp layer wraps its baked canvas. One `drawImage(img, sx, srcRow, sw, 1, 0, row, W, 1)` per output row is GPU-backed and far cheaper than a per-pixel JS resample.
- **`createTile` must call `done()` ASYNCHRONOUSLY** (`setTimeout(..., 0)`): Leaflet inserts a tile only after `createTile` returns, and a synchronous callback leaves every tile at `visibility:hidden` — the bug temp-layer shipped. A bare `GridLayer` also has **no `setOpacity`**, which the layers dropdown and `OverlayOpacity` slider both call; the subclass must provide `setOpacity`/`getOpacity`.
- **Tiles painted before the `Image` lands are blank forever unless `redraw()` runs on load.** `getTileLayer()`'s `add` handler awaits `ensureImage()` and then calls `state.overlay.redraw()`; the image is warmed at idle (`requestIdleCallback`) so the first toggle is instant.
- **Register `overlayadd` BEFORE the localStorage restore.** `addTo()` fires `overlayadd` synchronously; a listener attached afterwards never sees it, leaving `state.enabled` false with the checkbox looking checked — the 2026-10-28 magnetic-layer bug. The comment in `init()` records why; `transport-layer.bun.test.js` pins the ordering.
- `public_html/transport-layer.js` loads BEFORE `app.js` and is in `bump_frontend.sh`'s `ASSETS`. Pane is `transportPane` (z-index **359** — above mag 358, below isobars 360). `blocksClick()` returns **false**: it is a picture, not a probe, and must never swallow the click-to-submit flow. The layer is a single `WEATHER_OVERLAYS` entry `🛰️ Human Transportation` with forward/reverse URL slugs (`transport`, `transportation`, `human-transportation`, `anthropocene`) so shared links resolve. Exactly ONE `<script>` tag — a duplicate re-runs the IIFE and swaps the live `state` object underneath app.js mid-boot (this happened once during the build; the test now asserts `tags.length === 1`).

## Sea Surface Salinity Overlay Rules (NOAA GFDL CM2.6)

- The source is **NOAA SOS's "Sea Surface Salinity"** (`sos.noaa.gov/catalog/datasets/sea-surface-salinity/`), data from **NOAA GFDL** (the dataset's own readme says "Data Source: GFDL/NOAA") — US Government work, public domain, same status as transportation. The FTP folder `public.sos.noaa.gov/oceans/sss/4096/` holds **1,094 daily equirectangular JPEG frames** (4096×2048) of surface salinity from the CM2.6 model animation. PSA: salinity is PSU — grams of salt per kg of water.
- **The asset is a ONE-TIME conversion** (like transportation — the model output is frozen): frame `sss_4096.cm26_sos_sss_v7_0000.jpg` → `public_html/data/salinity/salinity.png`, 2048×1024, **256-colour palette PNG with land as a transparency index (652 KB)**. Two build rules: (1) land is the SOS pure-black mask — replace it with a magenta sentinel `(255,0,255)`, resize, re-sentinel the coastal blends (`r>150 && b>150 && g<100`), then quantize and set `transparency=` to the index sampled from a KNOWN LAND point (central Africa) — sampling the index any other way silently ships an opaque magenta continent; (2) **quantize with `dither=Image.NONE`** — Floyd-Steinberg grain covers a smooth scientific ramp, and banding at 256 colours is far less objectionable. Verified: 34.2 % transparent vs 34.5 % source land. There is no builder script and no regeneration step.
- **Everything else follows the transportation rules verbatim**: `L.GridLayer` never `imageOverlay`, `tileLat` inverse-Mercator per row, two blits at the world edge, async `done()`, `setOpacity`/`getOpacity` on the subclass, redraw after `ensureImage()`, `overlayadd` registered BEFORE the localStorage restore, image warmed at idle, `blocksClick()` → false, ONE `<script>` tag, in `bump_frontend.sh`'s `ASSETS`.
- Pane is `salinityPane` (z-index **351** — above climate 350, below soil 352; the wash stack, all opt-in). `WEATHER_OVERLAYS` entry `🧂 Sea surface salinity` with slugs `salinity`, `sea-surface-salinity`, `sss`. Attribution (enforced by `data-licences.bun.test.js`): `NOAA GFDL (CM2.6) … via NOAA Science On a Sphere (public domain)`; the row is in `docs/DATA_LICENSES.md` §1.
- **Only ONE of the 1,094 frames ships.** 2.2 GB of animation is not a browser asset; the large-scale structure (salty subtropical gyres, fresh Arctic) is frame-invariant. If animation is ever wanted, ship a thinned strip (every 30th day ≈ 36 frames ≈ 11 MB) as a separate, opt-in decision — do not start fetching frames per user.

## Ocean Currents Overlay Rules (NOAA "Perpetual Ocean" / ECCO)

- The source is **NOAA SOS's "Ocean Currents - Temperature"** (`sos.noaa.gov/catalog/datasets/ocean-currents-temperature/`), data from **NASA's ECCO-2** ocean model (2021-2023; a NASA/JPL–MIT joint project) — US Government work, public domain, same status as transportation and salinity. The FTP folder `public.sos.noaa.gov/oceans/perpetual_ocean/temp/` holds the dataset. **Unlike transportation (one frozen still) and salinity (a 1,094-frame strip), this dataset ships ONLY as video**: `perpetual_ocean_2048.mp4` (313 MB, 2048×1024, 120 s, 3601 frames) plus a colourbar PNG. There is no still to hotlink — one frame must be EXTRACTED with ffmpeg.
- **The asset is a ONE-TIME extraction + edit**: `ffmpeg -ss 60 -i …mp4 -frames:v 1` → `public_html/data/transport/ocean-currents.png`, 2048×1024 palette PNG (~336 KB). Four edits are REQUIRED to make the frame a usable overlay, and each is load-bearing:
  1. **Land made TRANSPARENT** via a Natural Earth 110m land mask (`gdal_rasterize` to a 2048×1024 Byte GeoTIFF, dilate ~4 px with `MaxFilter(9)` so coarse coastlines leave no ocean-coloured fringe), then `transparency=` set to the index sampled from a KNOWN LAND point (central Africa) after quantizing. The SOS frame bakes in opaque green/tan land, which would double up over our basemap — the exact reason salinity replaced its black land with a transparency index.
  2. **Polar caps blanked** (`|lat| > 78`): the source paints Arctic pack ice and Antarctic sea ice / ice sheets as flat grey-white, which is NOT part of the ECCO sea-surface current field. The 110m land polygons do not cover the ice, so it must be cut geometrically.
  3. **Player chrome patched out**: the SOS export burns in a timestamp (bottom-left) and frame counter (bottom-right). Copy a clean row upward over each corner (`frame[H-46:H-4, …] = frame[H-70, …]`) — do NOT crop, or the 2:1 aspect breaks and the equirectangular sampling shifts every current against its coast.
  4. **Warm current cores selectively saturated**: `boost = clip((warm−10)/40, 0, 1)·0.55` where `warm = (R+G)/2 − B`, applied as `R·(1+boost)`, `G·(1+0.6·boost)`, `B·(1−0.35·boost)`. Ocean base sits at warm ≈ −39 and current cores at ≈ +31, so the Gulf Stream / Agulhas / Kuroshio / ACC pop against the navy without lifting the whole field.
- **Quantize with 255 colours + `transparency=`; the palette is ADAPTIVE (`convert('P', palette=ADAPTIVE, colors=255)`).** Dithering is off by default in this path — Floyd-Steinberg grain covers the smooth scientific ramp, and banding at 255 colours is far less objectionable. Verified: land alpha 0, mid-Pacific alpha 255.
- **Everything else follows the transportation/salinity rules verbatim**: `L.GridLayer` never `imageOverlay`, `tileLat` inverse-Mercator per row, two blits at the world edge, async `done()`, `setOpacity`/`getOpacity` on the subclass, redraw after `ensureImage()`, `overlayadd` registered BEFORE the localStorage restore, image warmed at idle, `blocksClick()` → false, ONE `<script>` tag, in `bump_frontend.sh`'s `ASSETS`.
- Pane is `oceanPane` (z-index **361** — above isobars 360, below basins 362; do NOT reuse 360, the isobars already claim it and two washes on one pane fight for the slot). `WEATHER_OVERLAYS` entry `🌊 Ocean Currents (ECCO)` with slugs `ocean`, `ocean-currents`, `perpetual-ocean`, `ecco`, `currents`. Attribution (enforced by `data-licences.bun.test.js`): `NOAA NESDIS / Science On a Sphere — "Ocean Currents - Temperature" (NASA ECCO-2, 2021-2023)`; the row is in `docs/DATA_LICENSES.md` §1.
- **Only ONE frame ships.** 313 MB of animation is not a browser asset; the large-scale structure (Gulf Stream, ACC, subtropical gyres) is frame-invariant over the 120 s loop. If animation is ever wanted, ship a thinned strip as a separate, opt-in decision — do not start fetching frames per user.

## Overlay Pane Stack — every pane needs its OWN z-index

Overlays do not fight for the basemap; they fight **each other**. Two
overlays on one pane z-index is not a subtle ordering problem — the last
one to call `createPane` wins the slot and the other wash never paints
where it should.

**The current stack** (from `public_html/tests/overlay-contracts.bun.test.js`,
which scans the source and is the authority — do not copy it from here):

`etopo 345 → wave 346 → ivt 347 → cape 348 → **population 349** → climate 350 → salinity 351 →
soil 352 → cropland 353 → geology 354 → temp 355 → lightning 356 →
phytoplankton 357 → mag 358 → transport 359 → isobars 360 → ocean 361 →
basins 362 → language regions 363 → lang 364 → rivers 365 → wind speed
366 → faults 367 → earthquakes 368 → ocean currents (live) 369 → **soil
(HWSD v2.2) 370** → FAO rivers 371 → **wind 379** → city labels 380`,
and Leaflet's own `overlayPane` at **400** is where the pins live.
**Free slots today: 372–378.** The wind animation moved **370 → 379** to make room: the
stack was full from 345 to 370, and a ground-level layer at 371+ would
have drawn OVER the wind streaks — exactly the "I can't see the wind"
report. The animation is the topmost weather layer and is already above
the earthquake/fault/ocean-current markers, so 379 changes nothing it
was already above.

**THE UNIQUENESS TEST MUST SCAN THE SOURCE, NOT A TABLE.** It used to
iterate the `OVERLAYS` list in `overlay-contracts.bun.test.js`, and both
collisions that shipped — **cape 346 on wave's 346**, and **languages
357 on phytoplankton's 357** — belonged to layers *nobody had added to
the table*. A duplicate check over an incomplete list can never fire, so
it gave false confidence while two washes silently shared a slot. The
test now reads every `public_html/*.js`, finds each pane name and its z
itself, and checks the extracted set — a new layer is caught whether or
not anyone registers it. `field-layer.js` is skipped (it is a factory:
its `paneZ` is a default each caller overrides) and so are Leaflet's
built-in panes (`tilePane`, `overlayPane`, …).

**Do not trust a comment that claims a slot is free.** `languages-layer.js`
carried *"357 was freed by the indigenous → languages rename"* — it was
not; phytoplankton had it. The comment was updated with the real number
and the reason.

**Two panes must not share a z-index in the EXPORT either.** The exporter
sorts its registrations by `z` to match the map's pane order, so when you
renumber a pane, renumber the module's export `z:` in the same edit.

## A Value Overlay Must BE SEEN (2026-11-04)

**A RAMP WITH A DARK END IS INVISIBLE ON A DARK MAP.** The ocean
currents shipped with a ramp whose first stop was `#0b1020` — the
wind's published first stop. The median ocean surface current is
**0.11 m/s** and most of the ocean is slower than 0.3 m/s, so the
great majority of the ocean was painted in a colour indistinguishable
from a dark satellite basemap. The animation ran perfectly and the
reader saw **nothing**.

The ramp is now **bright at both ends**, and it is **PUBLISHED** in
`meta.json` so the flat map and the globe read the *same* one.

**SEED PARTICLES FROM THE DATA, NOT FROM THE SCREEN.** Picking a
random screen pixel and rejecting it unless the water there was moving
means a view over a continent seeds almost nothing. Build a list of
the grid's WET cells once and seed from it.

**A DEAD PICTURE MUST NOT BE A CONSOLE ERROR.** The image proxy
answers a missing upstream picture with **HTTP 200 and a 1×1
transparent PNG**: an `<img>` that 404s is a console error the reader
can neither silence nor act on (the picture is gone AT THE
PUBLISHER), and two publishers alone account for thousands of dead
links. The client hides a placeholder-sized image on load (it checks
`naturalWidth`), so the layout is unchanged. A malformed request (400)
and our own rate limit (429) stay errors — those are about the
request, not about a missing picture.

## The Service Worker Must NOT Intercept a Stream (2026-11-06)

**AN `EventSource` REQUEST MUST NEVER BE WRAPPED IN `respondWith()`.**
A service worker that wraps one turns every ABORT — the reader navigates,
the tab is hidden, the server closes the connection — into a console line
the reader can neither silence nor act on:

```
Failed to load 'https://xyzo.org/api/feed/live/stream?limit=30&…'.
A ServiceWorker intercepted the request and encountered an unexpected error.
sw.js:232:11
```

The stream itself was fine — the Live Feed reconnected and carried on —
but the worker printed the error on every visit, and the line pointed at
the worker as if the worker were broken.

- **THE FIX IS TO NOT RESPOND AT ALL.** With no `respondWith` the browser
  owns the EventSource, and an abort is then the browser's own business —
  silent, as it should be. The test is the **`Accept` header**, because
  that is what makes the request a stream in the first place:
  `if (accept.includes("text/event-stream")) return;` — and the guard must
  come **BEFORE** the `/api/` branch, or the stream is still wrapped by
  `networkFirst`.
- **NOT CACHING A STREAM IS NOT ENOUGH.** `networkFirst` already skips
  `cache.put` for `text/event-stream` (a stream's body never ends, so
  `cache.put` would hang the response). The error came from the
  `respondWith` wrapper itself, not from the cache write.
- Pinned by `public_html/tests/offline-layer.bun.test.js`.

## The Offline / Tile Notice Can Be Dismissed (2026-11-04)

The "Map imagery isn't loading" banner sits across the **top of the
map** — in the way of the very thing it is talking about — and it is a
**notice, not a blocker**. It carries an **X**: a real `<button>` (so
it is focusable and announced), with a 44 px touch target on a coarse
pointer.

**DISMISSING IT MUST ALSO STOP IT COMING BACK.** The tile watcher
fires on **every failed batch of tiles**, so a dismissed banner that
reappeared ten seconds later would be worse than no button at all:

- the dismissal is remembered in
  `sessionStorage["xyzo.offlineNoticeDismissed"]` (the session);
- it is **forgotten when the situation RESOLVES** — the tiles come
  back, or the connection returns — so a genuinely NEW outage warns
  the reader again;
- **`hide()` must NOT clear the flag**, because `hide()` is what the X
  calls. The flag is cleared where the situation resolves, not where
  the banner goes.

**THE "⚡ Live data is unavailable" BANNER HAS AN X TOO (2026-11-10).**
Owner ask: *"can we correct it so we can also close it with an X when
this message pops up?"* It is a **SEPARATE notice** from the tile one —
`app.js`'s `ApiHealth` polls `/api/health` every 15 s and raises it when
the API does not answer — and it had **no way to be closed at all**. It
now carries the **HOUSE `✕`** (`.xyzo-notice-dismiss`, the same 28 px
target, the same 44 px on a coarse pointer, the same focus ring as the
tile notice's X — one class, one look, two notices), and the dismissal
follows the SAME rule as the tile notice's: **remembered for the
session** (`xyzo.apiDownDismissed` — its OWN key, so closing "live data
is unavailable" does not close "the imagery isn't loading"), **not
cleared by the X's own click** (the health check would put the banner
back within 15 s), and **forgotten when the situation RESOLVES** (the
API answers again) so a genuinely NEW outage warns the reader.
**MEASURED end to end with Playwright** (the API routed to 503): the
banner appears with the X (28×28, `aria-label="Dismiss this notice"`);
the X closes it; it is **still closed 35 s later** (two more health
checks); the API recovers → the dismissal is **forgotten**; a new
outage → **the banner warns again**. 0 page errors.

## "The map didn't load." — the boot-failure notice (2026-11-06)

The top notice has a **third wording**, raised when the **APP** fails
rather than the connection or the imagery: `offline.js` proves
`window._xyzoMap` is absent after `DOMContentLoaded` + a 2 s grace, and
offers **Reload fresh**. Owner ask: *"is there something we can do if we
detect the map isn't loading correctly to allow users to do a 'hard
refresh'… like a popup that's closable and they can opt out for if
needed"* — he chose **extend the existing notice** (not a modal) and
**trigger only when the map fails** (not on the version badge).

- **`hardRefresh()` LIVES IN `offline.js`, NOT `app.js` — this is the
  whole feature.** `*.js` is served `immutable` for a year, so a stale
  `app.js` cannot be replaced by a normal reload; that is exactly the
  state this button exists for. While it was a module-level function in
  app.js exported as `window.hardRefresh`, **the case it was written
  for was the case where it did not exist**: app.js 500s or throws on
  line 1 → no export → the notice's button fell back to
  `location.reload()`, which cannot bypass the immutable cache and would
  have changed nothing. `offline.js` is at index.html line 708, **before
  app.js at 843** (both `defer`), so the export is set before anything
  in app.js runs. **app.js must not grow a second copy** — it calls
  `window.hardRefresh()`, and tests assert exactly one definition.
- **THE PROBE MUST REGISTER ON `DOMContentLoaded` UNCONDITIONALLY —
  NEVER BRANCH ON `readyState`.** `readyState` is already
  **`"interactive"` inside a defer script**: it flips to `interactive`
  *before* deferred scripts execute and `DOMContentLoaded` fires *after*
  them. The first version tested `readyState === "loading"`, found it
  false, and scheduled its probe 6 s after **`offline.js`** instead of
  after **app.js** had had its chance. MEASURED: with app.js delayed 8 s
  by the network it raised **"The map didn't load." at 6.8 s over a map
  that then appeared** — a false alarm on a merely slow connection.
  A test forbids any `readyState` branch inside `watchBoot()`.
- **THE SIGNAL IS `window._xyzoMap`, AND IT IS EXACT.** app.js is
  `defer`, so DCL fires only once every deferred script has **run or
  failed**; `_xyzoMap` is assigned at app.js's **top level** (about 40
  lines in, not inside a callback) and is never cleared. `mapIsUp()`
  requires `_xyzoMap` **and** `#map`, so a page with no map can never be
  told its map failed to load — and `watchBoot()` refuses to arm on one.
- **THE GRACE PERIOD IS MARGIN, NOT DOWNLOAD TIME.** DCL already
  includes waiting out the whole defer payload (**703 KB gzipped**,
  measured ~0.8 s here, ~7 s at 100 KB/s) — everything a slow connection
  costs is *inside* the DCL wait. 2 s covers ordering quirks only. The
  **45 s backstop** is measured from `offline.js` and exists for a script
  that never finishes at all (an infinite loop blocks DCL, so the normal
  probe never runs); a false alarm there is self-correcting because the
  2 s interval calls `healBoot()`.
- **THE FAST PATH IS A FLAG, NEVER A VERDICT.** A capture-phase `error`
  listener (registered at PARSE time — a parser script's error fires
  during parsing, long before `init()` runs) sets `scriptFailed`, which
  only shortens the wait to 0. `probeBoot()` is what decides, so a failed
  **non-critical** script that still let app.js build the map raises
  nothing. `t.async` filters out the chunks `loadChunk()` appends at
  runtime, and `externalOrigin()` filters out everyone else's scripts.
  Note it only catches a failure that resolves *after* `offline.js` ran;
  an instant 404 fires during parsing and is covered by the grace period
  instead — do not claim otherwise in a comment.
- **A BOOT DISMISSAL IS NOT FORGOTTEN WHEN SOMETHING ELSE RECOVERS.**
  `clearDismissal()` returns early while `bootDismissed` is set, because
  `sync()` (from `load` and every `online` event) clears the
  `sessionStorage` flag as soon as the connection looks fine — and the
  45 s backstop would then hand a dismissed notice back on a page whose
  map was never coming up. **Only the map appearing (`healBoot`) forgets
  it.** One guard in `clearDismissal()` covers every recovery path;
  adding a guard at each call site is how one gets missed.
- **PRECEDENCE: offline > boot > tiles**, and it is enforced in both
  directions — `showBoot()` returns early when `navigator.onLine` is
  false, `showTiles()` returns early when `bootReason` is set (or
  `tileTick` repaints its wording over ours every ten seconds), and
  `show(online)` **must not** hide a boot notice: the connection was
  never the problem. Going offline demotes only the *wording*
  (`repaintOffline`) while `bootReason` stays true, so reconnecting
  restores ours instead of dropping it.
- **A LATE MAP RETIRES THE NOTICE.** `healBoot()` hides it and forgets
  the dismissal — without it a merely slow boot or an early backstop
  leaves a false alarm standing over a perfectly good map.
- **`location.reload()`, NEVER `location.replace()`.** The hash IS the
  map's state (`#lat,lng,zoom/overlay=…`); a hard refresh that discarded
  it would fix one problem by causing another.

Measured on the live site (Playwright, fresh context per run): healthy
→ **no notice in 18 s**; `app.js` aborted → **4.74 s**; `app.js`
throws → **5.88 s**; optional lazy chunk missing → **no notice**;
`app.js` 8 s late → **no notice**; Reload pressed with app.js dead →
**navigates**; `_xyzoMap` set afterwards → **gone in < 2 s**; ✕ then
`sync()`/reload → **stays gone**.

Pinned by `public_html/tests/map-failed-notice.bun.test.js` (28),
plus `hard-refresh.bun.test.js` (the primitive's new home and the script
tag order) and `offline-notice-dismiss.bun.test.js`.

## Load Speed — A LAYER'S DATA IS FETCHED WHEN IT IS SWITCHED ON (2026-11-07)

Owner ask: *"can we write some speed tests for everything all the maps
and kinda slowly work on improving the load speed and all that?"*

**MEASURED FIRST: the bare map — ZERO overlays switched on — downloaded
41.5 MB across 188 requests, and 38 MB of it was grid data for layers
that were all OFF.** (Playwright, fresh context, `#20,10,3`, reading
`performance.getEntriesByType('resource')`.) The lightning grid alone
was **17.8 MB**, and every visitor paid it whether or not they had ever
switched the lightning on.

**THE CAUSE WAS TEN LAYERS WITH AN IDLE "WARM":**

```js
const warm = () => ensureData().catch(() => {});
if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 6000 });
```

Its purpose was *"switching the layer on is instant"*. It ran for every
visitor, at idle, **whether or not the layer was ever switched on** —
so it was a cost paid by the readers who were never going to use it,
and only a benefit to the ones who would. **THE TEMPERATURE LAYER
ALREADY HAD THE RIGHT RULE**, with a comment saying exactly why:

> ONLY when the layer is already on. The grid is 2 MB and the layer is
> OFF by default: warming it for every visitor who never switches the
> temperature on put 2 MB on the first page load for nothing.

**THE RULE: warm only `if (state.enabled)`.** Applied to climate,
field-layer (CAPE/IVT), lightning, phytoplankton, mag, wave, ocean,
salinity, transport; and **deleted outright** from `city-labels.js`,
whose warm ran only when the layer was NOT restored on — i.e. it loaded
the 1.2 MB city index for exactly the readers who would never see a
label.

**THE SECOND HALF: THE LEGEND NEEDS THE META, THE MAP NEEDS THE GRID.**
Several layers' **legend mount** also called `ensureData()` — and the
legend lives in the layers dropdown **whether or not the overlay is
on**, so mounting it at boot pulled the whole grid. Split them:

```js
ensureMeta()   // a few KB — the ramp, the range, the run time. At boot.
ensureGrid()   // megabytes — only when the reader asks for the picture.
ensureData()   // both — what the layer's `add` handler wants.
```

`temp-layer.js` and `field-layer.js` gained the split; `climate-layer.js`
already had `ensureMeta`/`ensureGrid` and only needed the call site
changed; lightning and phytoplankton warm `ensureMeta()` alone.

**THE THIRD HALF: A LAYER WITH NO `BASE` HAS NOTHING TO FETCH.** The
field-layer factory also serves the **wind-speed** field, which reads
WindLayer's own grid and passes no `base` of its own. The new
`ensureMeta()` therefore asked for **`/undefined/meta.json` — a 404 on
every single page load** (35 runs, 35 of them). Guard on `BASE`, and
build that one's legend from the data when it lands, as it always did.
A `!BASE` guard in `ensureGrid()` must **reject**, not call
`ensureData()`, or the two call each other for ever.

**THE TEST IS A SCREENSHOT DIFF AGAINST A MAP THAT NEVER HAD IT ON.**
`scripts/overlay_load_check.py` loads each of the 35 overlays in its own
fresh context, screenshots it, and compares against the same view with
no overlays — **no layer names, no pane names, no URL patterns to
drift**: if it changes the picture, it passes. **35/35 painted, 2
console errors** (down from ~41, because the `/undefined/meta.json` 404
is gone). *This gate is the point:* the load now happens on a path a
cold start never used to exercise, so a layer whose `add` handler stops
fetching would switch on, tick its checkbox, show its legend — and draw
nothing, with nothing else on the site noticing.

**THE MEASUREMENT TOOL IS `scripts/map_speed_audit.py`.** It reads the
overlay list from the live dropdown, measures each layer in a fresh
context from the browser's own Resource Timing API, and reports
requests, bytes, the moment the network went quiet and the console
errors. **IT MUST NOT REPORT A DELTA AGAINST THE BASELINE**: the
baseline moves by more than most layers cost (the pins, the feed and
the basemap vary run to run), so the difference went **negative** and
reported layers as *saving* bytes. And a hand-kept slug→URL-pattern
table drifts the moment a layer is renamed (measured: the fault layer's
slug had changed and it attributed **0 requests** to it). Report the
run's own totals plus **every resource the baseline did not make** —
those belong to that layer by construction, and cannot drift.

**MEASURED AFTER: 170 requests, 4.8 MB** — an **8.6× reduction**, and
**ZERO overlay grid files** on a page where nothing is switched on. The
last one out was the **wind grid, 4 MB**: the wind-SPEED field's legend
was getting its meta through `opts.loadData()`, which drags the whole
grid — so the field-layer gained a **`loadMeta` hook** and `WindLayer`
gained **`ensureMeta()`** (1 KB, cached), and a layer whose data belongs
to ANOTHER module now fetches that module's meta directly rather than
its data. **Switched on, a layer fetches its own data and nothing else:**
wind on → the grid arrives and 207,637 pixels draw; wind-speed on → the
same grid, one fetch shared by both layers.

**STILL OPEN: the `.bin` files go out UNCOMPRESSED** (see the lightning
section above) — a reader who switches a large layer on still pays the
raw size. The lazy rule above is what removed the cost for everyone
else.

## The WHY Page — The Account Is Attributed, Never Asserted (2026-11-12)

The about page now carries the origin story: the founder read a map of
the world in the mineral rings of Grand Prismatic Spring, and came home
with two rules — **a map that can change**, and **be careful where you
bring electronics and what you take photos of**.

- **THE ACCOUNT IS ATTRIBUTED, NEVER ASSERTED AS FACT.** The founder's
  words are carried as HIS words ("the founder's account, in his own
  words"), and the page says plainly that nobody has the map of the
  universe — *"anyone who says they do is selling something"*. The
  temptation, on a page that ends with a person saying "trust me", is
  to let the cosmology harden into a claim the site cannot support — and
  the whole commitment of this project is that what it shows is
  **checkable**.
- **THE PRIVATE PARTS OF THE STORY ARE NOT PUBLISHED.** A public page is
  not the place for someone's worst night; the map is the part that
  belongs to everyone.
- **THE THREE MAPS ARE GROUNDED IN WHAT THE SITE HAS** — the ground,
  the globe (the 🌐 button) and the web (the story tree).
- Pinned by `public_html/tests/about-why.bun.test.js` (6).

## A Pin Tells You Where It Is (2026-11-12)

Owner ask: *"when you click on a point.. can you have it show the details
of that point including the google popup map showing the satellite view
for example lat/lng and anything else a user might want to know about
that point... nearest town nearest news... if that takes too long dont do
it.. just show something so they can see at least the lat/lng and a few
other things that are fast for us to provide"*.

- **EVERYTHING THE POPUP SHOWS ABOUT THE POINT IS ALREADY IN HAND** —
  the coordinates, the place, the source, the time. No request, no
  wait, no geocoder. The **nearest news** is the "Related Stories"
  section the popup already had; the **nearest town** is the place badge
  it already had.
- **THE SATELLITE VIEW IS A BUTTON, NOT AN EMBEDDED MAP.** It is a
  NESTED Leaflet map (a second map to build, four Esri tiles to fetch),
  so opening it automatically would make every pin tap wait for a
  picture of a field — the owner's own *"if that takes too long dont do
  it"*. The button opens the existing satellite popup.
- **THE POPUP'S CONTENT IS 914 px LONG IN A 380 px SCROLL BOX**, and
  the content wrapper carries a CSS `zoom: 1.15` — so anything placed
  low in the popup is **below the fold**, and **clipped content is not
  hit-tested**: a button down there is invisible AND dead. **THE NUMBERS
  AND THE BUTTONS GO IN THE HEADER ROW**, which is always visible, and
  the content box was given the room the extra row needs
  (`maxHeight` 380 → 440) so the EXISTING actions stay visible too.
- **THE LISTENERS ARE DELEGATED FROM THE POPUP ELEMENT, NOT BOUND TO
  THE BUTTONS** — the same rule the close button follows (see
  `attachPopupClose`): the popup's content is a FUNCTION, so Leaflet
  rebuilds it and the buttons are replaced by brand-new nodes, and a
  listener bound to a button dies with the old one.
- Pinned by `public_html/tests/popup-point-details.bun.test.js` (5).

## The Scale Bar — the map says how far it is (2026-11-12)

**THE FLAT MAP HAD NO SCALE BAR AT ALL** (the globe always had one:
`maplibregl.ScaleControl`), so a reader looking for a distance measure
found an empty corner. It is now `L.control.scale({ position:
"bottomleft", metric: true, imperial: false, maxWidth: 120 })`.

- **THE BOTTOM LEFT, BECAUSE THAT IS THE ONLY FREE CORNER.** The
  bottom right of the flat map belongs to the **"Help me" pill**
  (position: fixed, z-index 9998 — it covers whatever is in that corner)
  and to Leaflet's attribution; the top left is the zoom bar and the top
  right is the layers dropdown.
- **IT FOLLOWS THE ZOOM** — measured live: "2000 km" at zoom 2, "10 km"
  at zoom 10, "3 km" at zoom 12.
- **ON A PHONE IT MUST CLEAR THE BOTTOM BAR** (which spans the width):
  the bar's top edge is MEASURED (`--bottom-bar-top`), and **the rule
  that does it must carry the same selector as Leaflet's own** — the
  vendored stylesheet sets `.leaflet-bottom .leaflet-control-scale
  { margin-bottom: 5px }`, and a lower-specificity rule here simply
  LOSES (measured: the bar sat at the very bottom, under the bottom bar
  — the same "where did it go?" as not having one).
- **IT SITS UNDER THE LIVE PANEL** (z-index 350 against the panel's
  400), so it never floats over a panel that is reading the news.
- **BOTH VIEWS WEAR THE HOUSE LOOK** — a dark pill, a light rule, the
  number in the map's own type. MapLibre's default is a bright white
  box in the corner of a dark globe, and its rule colour is set INLINE,
  so the override needs `!important`.
- **METRIC ONLY**, like the globe's.
- Pinned by `public_html/tests/map-scale-bar.bun.test.js` (4).

## The Mouse Pointer — ONE ring, and no canvas that eats the map (2026-11-04)

**`L.canvas()` MUST BE TOLD ITS PANE.** Leaflet puts a canvas
renderer's container in the **default overlay pane** — which is where
the **story-pin canvas** lives. The renderer is then appended *after*
the pin canvas and sits **on top of it**, and a canvas is a full-map
element with `pointer-events: auto`, so it **swallows every pointer
event on the map**. The story pins' hover (the ring, the card) dies
the moment such a layer is switched on — silently, and only when that
overlay is on.

    state.renderer = window.L.canvas({ padding: 0.3, pane: PANE });

The layer's pane carries `pointer-events: none`, so the canvas paints
and is invisible to the pointer.

**THERE IS ONE RING ON THE MAP.** `public_html/hover-ring.js` owns the
element (`.xyzo-pin-hover-ghost`). The pin renderer asks it to move;
the earthquakes ask it to move. **Never create a second element with
that class** — two circles could be on screen at once, and a query for
the class could find the wrong one.

**AND THE PIN RENDERER MUST NOT CREATE ONE EITHER.** It used to carry
a *fallback*: if `hover-ring.js` was not on the page it built its own
`.xyzo-pin-hover-ghost` — a second element with the same class, which
is exactly what the rule forbids. There is now **no fallback**: the
renderer asks `HoverRing.el()` and, if the shared module is missing,
says so in the log rather than making a duplicate.

**AND IT MUST NOT REMOVE IT.** `disable()` used to call
`this._ghost.remove()` — and the element it held **was** the shared
one, so **switching the markers layer off deleted the ring from the
earthquakes, the faults and the language regions too**. It now HIDES
the ring, it does not remove it.

**THE HOVER CARD IS NOT ABOUT PINS.** `HoverInfo.setTarget({title,
meta}, owner)` lets any layer put "what is under the cursor" into the
card. Only the owner may clear its own target, so the earthquakes
cannot wipe the ring that belongs to a story pin.

**ON THE GLOBE, USE THE LAYER'S OWN MOUSE EVENT.** A map-wide
`queryRenderedFeatures(point)` does **not** report the features under
the cursor on a sphere — use `map.on("mousemove", "pins", …)`.

**`relativeAge()` TAKES AN AGE, NOT A TIMESTAMP.** Handing it
`props.time` (the epoch) prints the time since 1970 — "20761 d ago".

**A HOVER STUDY MUST ONLY COUNT A POINT THE POINTER CAN REACH.**
Ask `document.elementFromPoint()` first. The first version of
`scripts/hover_audit.py` reported the hover as completely broken
because it picked the first pin the API returned, and that pin was
usually **under the layers dropdown** — so the pointer moved onto the
dropdown, not onto the map.

## The Globe's Gridded Fields Are Baked in MERCATOR (2026-11-04)

**A MapLibre `image` source is a quad in MERCATOR space.** MapLibre
turns its four corners into mercator coordinates and stretches the
texture across that mercator rectangle, so the texture's V axis is
**mercator**, not latitude.

The globe's three gridded fields — the **temperature**, the **lightning
density** and the **magnetic wash** — are painted once and draped as an
image source. They used to be baked in **latitude** (row 0 = +90°,
rows linear in latitude) and draped as if they were mercator, so
**every latitude except the equator was sampled with the wrong row**:
at 45°N the globe painted the Sahara's 38 °C instead of the Bay of
Biscay's 11 °C, and the poles came out hot.

**`public_html/field-bake.js` owns the canonical bake and the ramp.**
It is loaded by BOTH `index.html` and `globe.html`, before the layer
modules and before `globe.js`. The temperature, the lightning and the
magnetic wash all use `XYZO_FIELD_BAKE.bakeMercator()` and
`XYZO_FIELD_BAKE.rampColor()`; the flat map's `temp-layer.js` reads the
same ramp and the same `tileLat()`. **One implementation, two views** —
and the globe then shows the SAME picture as the flat map, because the
flat map's tile grid is Web Mercator too.

- **The quad stops at the MERCATOR LIMIT** (±85.051129), not at ±90°.
  At ±90° the projection is `y = Infinity` and the source **silently
  never renders** — an invisible failure no screenshot catches.
- **A second implementation of the mapping is a second source of
  truth**, and the second source of truth is the one that drifts. Do
  not re-implement `bakeMercator` or `rampColor` in a layer module.
- **NEVER index a ramp by an even step.** Every ramp lookup scans for
  the BRACKETING PAIR (see "Never index a ramp by even spacing").

## The Globe's Animations (2026-11-04)

The wind and the ocean currents are animated on the globe by
**`public_html/globe-wind.js`**, which serves both from their own
published u/v grids.

**EACH ANIMATION NEEDS ITS OWN CONTROLLER — AND THE CONTROLLERS MUST
BE A MAP KEYED BY THE OVERLAY.** Both the wind and the ocean currents
are "a canvas over the map", so both ask for a controller. They used to
write it into the SAME variable, and the second one created (the ocean
currents) **overwrote** the first (the wind): switching "Wind (GFS)"
on switched the OCEAN CURRENTS on instead, and the wind never
animated at all.

**THE GLOBE MUST LOAD `console-guard.js`.** It defines `window.XLog`,
which every module logs through. Without it a failure in any globe
module is **completely silent** — the overlay does nothing and the
console says nothing either, which is how the fault above survived. If
a globe overlay "does nothing", the FIRST question is whether
anything logged.

**THE FRAME CHAIN MUST SURVIVE A HIDDEN TAB.** `step()` returns early
on `document.hidden` **before** the `finally` that re-schedules the
frame — so a frame that arrives while the tab is hidden ends the
chain, and nothing ever restarts it. **Firefox KEEPS FIRING
`requestAnimationFrame` in a background tab (throttled to ~1 Hz) where
Chrome SUSPENDS it**, so in Firefox the first background frame killed
the animation for good: the reader switched tabs, came back, and the
currents were frozen. Chrome never saw it, because its suspended rAF
means `step()` never runs at all while hidden — the same code, a
different browser's scheduling. The fix is the wind layer's shape:
`schedule()` refuses to hold a frame while `document.hidden`,
`pause()` releases the pending one without disabling the layer, and a
`visibilitychange` handler **restarts** the chain when the tab is seen
again. Pinned by `ocean-current-layer.bun.test.js`, which RUNS the
module (a hidden tab must not hold a frame; the tab coming back must
restart the chain).

**The old reason for not porting the wind was wrong.** It used to be
listed as NOT portable because *"particles behind the globe have no
meaningful screen position"*. The right answer is not to refuse to
animate — it is **not to draw the hidden ones**:

- the particles live in **GEOGRAPHIC** space (lat/lng), exactly like
  the flat map's, so the physics is the same and the field cannot
  drift;
- each frame they are PROJECTED with `map.project()` and the streak is
  drawn between the previous and the current screen point;
- a particle on the **far side** of the sphere is **CULLED** by a
  back-face test — the dot product of the point's direction vector
  with the camera's. Without it, the far side is drawn over the front
  of the planet.

## The Live Earthquake / Fault / Ocean-Current Overlays (2026-11-04)

**THE BROWSER MUST NEVER POLL A DATA SOURCE.** Every live overlay on
this site is served from OUR OWN files, refreshed by a timer:

| Overlay | Source | Refreshed by |
|---|---|---|
| 🌐 Earthquakes | USGS ComCat GeoJSON summary feeds | `xyzo-earthquakes.timer` (10 min) |
| 🪨 Tectonic faults | USGS Quaternary Fault and Fold Database + plate boundaries (KML) | on rebuild |
| 🌊 Ocean currents (OSCAR) | OSCAR via NOAA CoastWatch's ERDDAP — **frozen at 2014-09-26** | `xyzo-ocean-currents.timer` (daily, **alarms until a fresh source**) |

Each has a `scripts/*_build.py` that **downloads, verifies and
publishes** under `public_html/data/<name>/`, with a `meta.json` that
carries `license` and `attribution` (the licence test greps for them).

- **A `verify()` is a GATE, not a checkpoint** — it probes the real
  phenomenon, not a count: the South Equatorial Current must flow
  **west**, the Gulf Stream must leave the Florida Straits **northward**,
  the San Andreas must be where the San Andreas is, the newest
  earthquake must be inside the hour window.
- **THE ERDDAP griddap DATA endpoint rejects a multi-variable query**
  (`'&' must be followed by a .graphicsCommand`), but its **files**
  endpoint serves the raw composites directly — use that.

## The Ocean Currents (flat map) — `ocean-current-layer.js` (2026-11-04)

The flat map's **🌊 Ocean currents (OSCAR)** advects particles along the
published OSCAR u/v pair. Its physics are the wind layer's physics,
deliberately: longitude **wraps**, the column past the last one
**wraps**, `cos(lat)` shortens a degree of longitude, the trail is
trimmed by **length**, and `schedule()` runs from `finally`.

**A `verify()` THAT NEVER LOOKED AT THE DATE PUBLISHED A 2014 FIELD
FOR TWELVE YEARS.** The ERDDAP that serves OSCAR was loaded in
**February 2015** and its newest composite is **26 September 2014**
(the number in `oscar_velNNNN.nc.gz` is the day count since
1992-10-05). A **daily timer** had been re-publishing that same
twelve-year-old field since the overlay shipped, and **every physics
gate passed it** — because a gate that checks the Gulf Stream but
never the DATE cannot see a frozen source. `verify()` now has a
**FRESHNESS GATE** (`MAX_AGE_DAYS = 45`): a composite older than that
is **refused**, the published grid is left alone, the meta is
refreshed so the legend can show the date, and the build exits
non-zero — so `xyzo-ocean-currents.timer` **alarms every day** until
a fresh source is configured. **The client and the builder must share
the same limit**, and the client's age is **computed from
`source_date`** rather than read from the meta, so a meta published
days ago still tells the truth today.

**THE CURRENTS STOP SHORT OF THE COAST, AND IT IS THE SOURCE.**
OSCAR is an **altimetry inversion**: satellite altimetry has no valid
solution in shallow, river-influenced water, so the northern Gulf of
Guinea (the Bight of Benin) is empty and the field stops at **6°N**.
This is **not** the build dropping cells — the published grid was
checked **cell-for-cell against the raw NetCDF (0 mismatches)**, and
the **daily** NOAA CoastWatch geostrophic product has the **same hole
in the same cells**. Every altimetry-based surface-current product
carries it, so the legend now **says so** and the measured coverage
is published in `meta.json`.

**A FRESHER SOURCE THAT IS PHYSICALLY WRONG IS STILL WRONG.** The
daily `nesdisSSH1day` field is 37 days old and needs no credential,
but its **absolute** geostrophic velocity blows up near the equator
(the `g/|f|` term against a zonal MDT gradient): **+0.69 m/s eastward
at 6°N**, where the South Equatorial Current must flow **west**
(OSCAR gives −0.37 m/s at 5°S). It also scores 11/14 on the
relationship gates against OSCAR's 7/14 — the physics gates exist to
catch exactly this, so it was **rejected and recorded** rather than
shipped. OSCAR **v2.0** (0.25°, daily, `nrt`) keeps the diagnostic
model and is the real answer, but it needs a **NASA Earthdata**
credential (PO.DAAC) or registration (ICDC, whose THREDDS answers
**401** from this box).

**THE NAME MUST NOT CLAIM WHAT THE DATA CANNOT SUPPORT.** The layer
was "Ocean currents (live)" over a 2014 field. It is now **"🌊 Ocean
currents (OSCAR)"**, the legend shows the composite's date and age,
and the **URL slug stays `ocean-currents-live`** (the owner's links
use it — **an identifier is not a claim of freshness**, and the slug is
pinned in `REVERSE_LAYER_SLUGS` so the slugifier cannot break those
links). The Earth-portrait preset dropped the currents on **2026-11-08**
— a twelve-year-old field has no business opening a showcase map — but
the slug did not change, so every link that names it still resolves.

**THE FRAME CHAIN MUST SURVIVE A HIDDEN TAB** — the same rule the
globe's engine follows, and the same bug it had. See **"The Globe's
Animations"** above for the whole story: `step()`'s `document.hidden`
branch used to return **before** the `finally` that re-schedules, and
**Firefox KEEPS FIRING `requestAnimationFrame` in a background tab**
where Chrome suspends it — so in Firefox the currents were **frozen for
good** after the reader switched tabs.

**A LEGEND THAT IS NEVER MOUNTED IS A LEGEND THAT DOES NOT EXIST.**
`mountLegend()` was written and exported and **nothing called it**, so
the reader had no speed key and the Probe button and the style chips
were not on the page at all — while the CSS for them sat in
`styles.css`. **Every layer that owns a legend must MOUNT it**, and
because app.js creates the layers control *after* the layer modules
initialise, the injection is **retried until the control exists** (the
climate / soil / cropland / geology / etopo pattern).

**A BUTTON THAT IS IN THE LEGEND MUST DO SOMETHING.** Two of this
layer's controls were dead on arrival: the **Probe** (`showProbe()`
was never called from anywhere) and the **Arrows** chip (nothing ever
read `state.style`). The same trap catches the next one.

**THE OCEAN'S THRESHOLDS ARE NOT THE WIND'S.** The median ocean
surface current is **0.11 m/s**, so the wind layer's 0.2 m/s cut-off
would leave the whole ocean blank. Anything moving at all gets an
arrow.

## The HOW TO Tour (2026-11-04)

Owner ask: *"we might want to build a 'how to' or a 'demo' of how all
our features work when people first visit or ask for help."*

`public_html/tour.js` walks a reader through the map in **six steps**,
each pointing at the **real control it talks about**. It is a **button**
(⚙ → TOOLS → *How to*; the help panel → *Show me how this works*), so
"ask for help" can be answered by SHOWING rather than telling.

**IT NO LONGER SHOWS ITSELF (owner, 2026-11-13).** It used to appear on
its own, 1.8 s after the boot, on a first visit. The owner: *"dont show
the 'how to' on the first load thats kinda annoying.. just put that with
something else"*. On a phone the card is a **sheet** covering most of
the screen, so the reader's first sight of the site was a modal card
about a map they had not looked at yet — and **a tour nobody asked for
is a tour that is closed unread**. There is **no auto-start**: the
module has no `maybeAutoStart`, and the two buttons are the whole way
in. Do not add one back without the owner asking for it.

**The rules, each one load-bearing:**

- **THE SPOTLIGHT NEVER SWALLOWS A CLICK.** The cut-out is
  `pointer-events: none` (`.xyzo-tour-spot`), so the reader can press
  the very control the step is describing while the step is on screen.
  A tour that blocks the map teaches "you cannot touch this". The CARD
  is the only thing the tour puts on the pointer path.
- **IT IS ALWAYS DISMISSIBLE** — Escape, the ✕, and Skip. A tour that
  cannot be dismissed is a hostage.
- **IT NEVER MOVES THE MAP.** No `setView` / `flyTo` / `panTo` in
  `tour.js`. The steps describe what is already on screen; flying the
  reader somewhere else would be a second thing happening at once.
- **IT IS A SHEET ON A PHONE** (below 640 px), docked to the bottom
  with `env(safe-area-inset-bottom)`. A floating card on a 390 px
  screen covers the control it is describing.
- **THE CARD NEVER COVERS THE CONTROL IT DESCRIBES.** The placement is
  MEASURED (the space right / left / below / above the target), and
  `scripts/tour_audit.py` asserts the two never overlap.
- **A SHARED LINK DOES NOT TRIGGER IT.** The decision is made on
  `BOOT_HASH` — the hash **as it arrived**, captured at MODULE level
  in `tour.js`. `tour.js`'s tag is **before** `app.js`'s for exactly
  this reason: the default map is a preset, and the preset becomes the
  URL, so reading `location.hash` later would mistake a first visit
  for a shared link.
- **A ZERO-SIZED ELEMENT IS NOT A TARGET.** A step's `target` may be a
  **LIST** of selectors and the first one with a real size wins — the
  layers toggle is 0 × 0 while the panel is OPEN, and the live panel's
  own box sits off-screen at `translateX(-100%)` while it is CLOSED
  (both windows start closed now), so the live step points at
  `#live-panel-reopen` first. The placement is **retried** for a
  beat (`retryPlacement`), because the layers toggle is created by
  Leaflet and may not be laid out yet.
- **THE DISMISSAL IS `localStorage["xyzo.tourSeen"]`** and it is set
  when the tour is STOPPED, not when it is shown — a reader who
  closed the tab mid-tour has still been shown it.
- **ON A PHONE THE SHEET CLEARS THE BOTTOM BAR** —
  `bottom: calc(var(--bottom-bar-top, 58px) + 12px)`, never a typed
  constant. The bar holds the **⚙ button** and **step 6 POINTS AT the
  ⚙ button**: a sheet that covered the bar would cover the very
  control the last step describes.
- **THE "🆘 HELP ME" PILL IS HIDDEN WHILE THE TOUR IS OPEN**
  (`body[data-tour-open] #help-me-btn { display: none }`). It is
  `position: fixed` on `<body>` at z-index 9998 — *above* the tour
  card — and it floated over a third of the card's text. The same
  thing it does to the control menu; it is an emergency affordance,
  not a control, and hiding it costs nothing.

Pinned by `public_html/tests/tour.bun.test.js` (20) and measured by
`scripts/tour_audit.py`.

---

## The Live Feed's Tab Strip, and the 🛰️ Default Map (2026-11-13)

Owner report: *"when the live feed pops up.. the Ai suggested isn't
really showing correctly its all smooshed.. playwrite?"* — plus *"can
you have a easy way to 'clear the map to a default satellite only view'
maybe down near [the ⚙]"*, with their own map as the default.

**THE TAB STRIP IS A GRID, NOT A FLEX ROW.** Five tabs in a 320 px
panel gave each ~58 px: **"🤖 AI Suggested" broke into FOUR lines**, every
other label into two, and the strip **overflowed the panel by 14 px**
(measured: 300 px of content in a 285.8 px box) — the last tab was cut
off at the panel's edge. It is `grid-template-columns: 1fr 1fr` now, the
longest label takes the whole last row (`grid-column: 1 / -1`), and
`white-space: nowrap` keeps every label on ONE line. **Below ~330 px,
and at the largest text size (`html.ts-130`, where the header's content
box is 290/1.3 = 223 px), it falls back to one column.** The strip is
the one place where a squeezed label is a broken control.

**A LIST QUERY MUST CARRY A WINDOW.** The "AI Suggested" tab asked
`/api/pins?min_confidence=0.85` with **no time window**, and that
query's articles leg has no time predicate — so the plan was a
**sequential scan of the 17 GB `news_articles` table**. **MEASURED: the
query was still running after THIRTEEN MINUTES** (four copies of it,
each reading 17 GB) and the tab said "Loading AI Suggestions…" the
whole time. **THE SAME ENDPOINT WITH A WINDOW ANSWERS IN 0.94 s (24 h)
AND 3.4 s (3 d).** `/api/pins/map` has had a guardrail for this since
2026-10-31; `/api/pins` has not (README Q-N38).

**THE WINDOW'S ARITHMETIC IS THE POINT.** A window is `[since, now]`,
so a **shorter** window has the **LATER** start: the answer is the
**later** of the reader's `since` and the cap (`max`, not `min`). The
first version took the earlier one and made the three-day cap **widen**
the window — the default 24 h filter asked for three days.

**NEVER INVENT A NUMBER.** The tab's badge was `confidence_score ||
0.9`, so a story the server had said **nothing** about was shown as
**"🤖 90 % Match"**. And the failure path fell back to the feed's hot
list — **a different answer under the same tab name**, which the reader
cannot see. A failed list says so, with a retry.

**THE DEFAULT MAP IS A HASH, LIKE EVERY OTHER VIEW.** `map-presets.js`'s
`DEFAULT_MAP` holds the owner's own map **verbatim**; it is parsed by
the same `parseHash()` a preset and a shared link use and applied
through the same `applyMapState()`. **A button that assembles the map
by hand is a second implementation of "what a map is", and the second
implementation is the one that drifts.** The hash names no base layer,
so the button states `satellite` itself.

**THE BOTTOM BAR HAS NO ROOM ON A PHONE, AND THE ⚙ IS THE LAST ITEM IN
IT.** MEASURED at 393 px: the language switcher takes **157 px** and
each button is **44 px** (the WCAG floor), so the bar's content is
**397 px in a 377 px bar** — the ⚙ hangs **29 px off the right edge**,
and with it the whole control menu. So the bar button is **hidden below
560 px** and the same action is in **⚙ → MAP → "🛰️ Default map"**.
**A button that pushes the ⚙ off the screen has cost more than it
gives.** `scripts/live_panel_audit.py` now asserts that **every**
bottom-bar button is on screen and hit-testable, on a desktop and a
phone.

Pinned by `public_html/tests/default-map-button.bun.test.js` (11),
`public_html/tests/live-panel-tabs.bun.test.js` (11) and measured by
`scripts/live_panel_audit.py` (desktop · 393×852 phone · A++).

---

## The NASA Tile Proxy (2026-11-04)

The three NASA GIBS overlays (rain rate, true-colour satellite, night
lights) are the only layers that come from another server **live**.

**A 404 ON A TILE IS A CONSOLE ERROR, AND NO JAVASCRIPT CAN SUPPRESS
IT.** GIBS publishes a tile only where the product has a value and
answers **HTTP 404** for the rest (the open ocean, the poles). A 404
on a tile is a 404 on an `<img>`, and the BROWSER logs it — so every
first visit filled the console with red lines that said nothing
useful. The tiles therefore come through
`api/src/routes/tileProxy.ts` (`/api/tile/:dataset/:date/:z/:y/:x`),
which applies the same rule the image proxy already uses: **a missing
tile answers HTTP 200 with a 1×1 transparent PNG.**

**"YESTERDAY" IS NOT "THE MOST RECENT PUBLISHED PRODUCT".** GIBS
publishes the true-colour satellite a day or two behind, so the client
asking for `nasaDate(1)` got a whole layer of 404s — the checkbox said
"on" and the map drew **nothing**. The proxy **probes** a **canary
tile** (a fixed one over central Africa, covered by every one of these
products) and walks the date back until one answers, then serves the
whole layer from that date — one consistent picture, not a seam of
three days. The night lights are pinned to 2016-01-01 and are served
as asked.

**The rules of the route:**

- **THE URL IS BUILT SERVER-SIDE, NEVER TAKEN FROM THE CALLER.** The
  dataset, the date, the zoom and the tile numbers are path segments
  and the upstream URL is assembled from a **whitelist** — there is no
  `?url=` parameter, so the route has **no SSRF surface at all**.
- **THE EXTENSION IS PER DATASET** (true colour = JPEG, rain and
  night = PNG) and **THE ZOOM RANGE IS ENFORCED** (GIBS answers 400
  for a level its matrix does not have, and a 400 is a console error
  too).
- **A 404 IS RETRIED BEFORE IT IS BELIEVED.** GIBS sits behind a CDN
  with more than one origin: the same tile URL answered **404, 200,
  200, 404** across four identical requests. Without the retry a tile
  that *does* exist is served blank, and the date probe walks back a
  day for no reason.
- **THE PROBE IS SHARED** — a screenful of tiles arrives together, so
  the canary is asked once per dataset per hour, not once per tile.
- **A MALFORMED REQUEST IS A 400** (about the request, and the reader
  can act on it). Only a *missing tile* becomes a placeholder.

**BOTH VIEWS GO THROUGH IT** — `app.js` and `globe.js` — so the globe
is clean too.

**`scripts/check-api-paths.sh` MUST UNDERSTAND ROUTE PARAMETERS.** The
client asks for `/api/tile/rain` (the date and the tile numbers are
built at runtime) and the route is `/api/tile/:dataset/:date/:z/:y/:x`
— the literal `rain` **is** the `:dataset`, and the route carries four
more segments the frontend literal never spells out. The matcher now
compares **positionally**: a route segment that is not a parameter must
equal the frontend's, a `:param` may stand for any one segment, and
the route may carry extra segments **only if they are all parameters**.
The rule is strictly **additive** — it can only turn a non-match into a
match, so nothing that passed before can fail now. The old lenient
rule stays as a fallback.

Pinned by `api/tests/tile-proxy.test.ts` (10).

---

## The Image URL Pipeline (2026-11-04)

**THE IMAGE PROXY MAY ANSWER 200 OR 400 — AND NOTHING ELSE.**
A failed subresource is logged by the **BROWSER**, and no JavaScript
can suppress it, so every status that is not a success is a red line
in the reader's console that they can neither silence nor act on (the
picture is gone AT THE PUBLISHER). So:

- **EVERY UPSTREAM FAILURE ANSWERS THE PLACEHOLDER** — HTTP 200 with a
  1×1 transparent PNG and `X-Proxy-Placeholder: 1`. That includes a
  host that **no longer resolves**, a network error or timeout, an
  upstream 200 with an **empty body**, a body that is **not an image**,
  a body that is **too large**, and the **host circuit breaker**.
- **THE NEGATIVE CACHE ANSWERS THE PLACEHOLDER TOO.** It used to hand
  back the upstream's own status (a 403, a 429, a 413) — the same
  console noise one step later. The ONE exception is a cached **400**:
  that is about the *request*.
- **THE ONLY ERRORS LEFT ARE 400 (a malformed or blocked URL) and the
  400 for a private address** — the SSRF guard, and a caller needs to
  see those — plus the 429 above, which is a CLIENT's problem rather
  than a picture's.
- **THE RATE LIMIT HAS TWO ANSWERS, BECAUSE THERE ARE TWO KINDS OF
  CALLER.** It was **60/minute PER IP**, and **an IP is not a person**:
  a mobile carrier's CGNAT puts thousands of readers behind one
  address, so one reader's burst (a page load asks for ~15 images)
  starved everyone else behind that address, and every image they then
  lost was another console error. The limit is **300/minute** now (the
  endpoint exists to stop being used as an open relay, not to ration a
  scarce resource — the negative cache means a URL that failed is not
  re-fetched for 30 minutes), and:
  - a **BROWSER asking for an image** (its `Accept` says `image/*`)
    gets the **PLACEHOLDER**, with `Retry-After` and
    `X-Proxy-Rate-Limited` — a rate-limited *reader* can neither
    silence the error nor act on it;
  - a caller that **explicitly asked for JSON** gets the **429** — it
    can actually back off. Everything else (an <img>, or a caller that
    did not say what it wanted) gets the placeholder: **this endpoint
    exists to serve IMAGES, so an image-shaped answer is the right
    default.**

A comment in this file once claimed that *"404 keeps the browser
console quiet"*. It is **backwards**, and it is the whole reason three
404 paths survived a fix that had already removed the other one.

Pinned by `api/tests/image-proxy.test.ts` (6) and measured by
`scripts/image_proxy_audit.py` (a live page load plus 400 stored URLs).

**UNESCAPE THE HTML ENTITIES.** A URL lifted out of an RSS `<img src>`
or an HTML `<meta>` tag still carries them:
`src="…?format=jpg&amp;name=large"` is stored verbatim and the
publisher answers **404** for it. `worker/fetch.py`,
`worker/image_scorer.py` and `worker/fulltext.py` all `html.unescape`
what they extract (`worker/video_discover.py` already did). **39,856
stored rows** were repaired by `scripts/fix_image_urls.py`.

**A TWO-LETTER LAST LABEL IS A COUNTRY-CODE TLD.** Every ISO 3166-1
alpha-2 code is two letters, so `www.infomoney.com.br` is a VALID host
even when `.br` is not in the TLD table. Without that rule the
hostname splitter cut the domain at `.in` or `.info` — and because the
two candidates TIED on position and the tie was broken by the
iteration order of a **SET** (randomised per process by
`PYTHONHASHSEED`), the same URL became a **different broken host on
every run**. A tie-break that depends on a set's iteration order is
non-deterministic by construction.

## Hydrological Basins Overlay Rules (FAO)

- The source is the **FAO "Major hydrological basins of the world"** (AQUASTAT / SOLAW), `maps/bas_wrld_38047.zip` → `bas_wrld_38047.shp`, CC BY-SA 4.0. Basin boundaries delineated from hydrologically corrected elevation data (WWF **HydroSHEDS** and Hydro1K), 15 arc-seconds between 60 N and 60 S. `scripts/basin_build.py` converts it into **TWO detail levels of the same 235 basins** — `basins_major.geojson` (0.05°, ~6 MB) and `basins_detailed.geojson` (0.01°, ~13 MB) — plus `meta.json`, whose `levels[]` table names those files and whose `default_level` is `major`. The layer reads the filename from `meta.levels[].file` (`levelUrl()`); **a single `basins.geojson` is not produced any more and `build()` deletes a stale copy** so it cannot be served beside the per-level files. Switching levels never changes what is on the map, only its precision.
- **THE PUBLISHED ATTRIBUTE TABLE IS NOT IN THE DOWNLOAD.** The dataset documents `MAJ_BAS / MAJ_NAME / MAJ_AREA / SUB_BAS / SUB_NAME / SUB_AREA / TO_BAS`, but the zip only carries `NAME_BASIN / GRID_CODE / AREA / PERIMETER`, and the FAO SOLAW WMS exposes nothing more (the second layer, `basins_ws_38002`, adds water-stress attributes). The overlay therefore carries what the data actually has: the **235 FAO basin names** plus the area **computed from the polygons**. Do not invent a MAJ/SUB grouping.
- **The `-9999` sentinel is dropped.** 20,854 of the 50,225 source polygons carry the FAO name `-9999` (small slivers in no named basin). They are excluded; the remaining 235 basins total 147 M km², which is essentially all of Earth's land.
- **DISSOLVE FIRST, THEN SIMPLIFY, THEN MAKE VALID.** The source is 50,225 polygons and 139 MB of geometry. `ST_Union` by name → 235 polygons; Douglas-Peucker at 0.05° → 6 MB; `ogr2ogr -makevalid -nlt MULTIPOLYGON` → valid output. The order matters: **Douglas-Peucker creates bowties** (121 of 235 features were invalid without the make-valid pass), and a `-makevalid` pass without `-nlt MULTIPOLYGON` silently writes an **empty** file.
- **THE AREA FORMULA NEEDS RADIANS.** `A = R²/2 · Σ Δλ_rad · (2 + sin φ_i + sin φ_{i+1})`. Using degrees for `Δλ` inflates the area by ~57×, which is why `verify()` bounds the total between 40 and 200 M km². SQLite's `ST_Transform` is unavailable here (no spatialite/PROJ binding) and PROJ's equal-area `cea` rejects valid geometry in this dataset, so the area is computed in Python with the spherical formula.
- `verify()` is a **gate**: 15 known places must land in a plausible basin (Amazon, Congo, Nile, Mississippi, Danube, Ganges, Murray, Ob, Yangtze, Volga, Mekong, La Plata, Paris), and the total area must be sane. The probe points must be INSIDE the basin — (31, 24) is the Sahara, not the Nile, and (-99.1, 19.4) is Mexico City, not the Mississippi.
- `public_html/basin-layer.js` loads BEFORE `app.js` and is in `bump_frontend.sh`'s `ASSETS`. Pane is `basinPane` (z-index **362** — above the isobars, below the rivers).
- **THE POLYGONS MUST NOT BE INTERACTIVE.** An interactive polygon captures the click and breaks the click-to-submit flow, so the pane is `pointer-events: none` and the probe does its own ray-cast point-in-polygon test on the raw coordinates. `blocksClick()` returns true only while the probe is armed.
- The GeoJSON is 6 MB raw / **1.4 MB gzipped** and is only fetched when the layer is switched on — `meta.json` (837 bytes) is fetched separately so the legend can mount without it.
- **Colour schemes** (blue / red / black) live in `SCHEMES` in basin-layer.js and persist in `localStorage["xyzo.basinScheme"]`. The legend carries three colour-dot buttons; clicking one calls `setColorScheme()` which restyles the polygons AND calls `refreshLegendSwatches()` to recolour the legend's class rows. The scheme must feed `kindColors()`, or `styleFor()` keeps painting the meta colours after a switch.
- **app.js's click-to-submit guard must check `BasinLayer.blocksClick()`** — the basin probe owns map clicks while armed, same as the climate/temp/soil/cropland/geology/mag probes. It was missing on 2026-10-28; without it the basin probe and the submitter overlay both fired on the same tap.

## Geology Overlay Rules (Macrostrat + USGS/GSC)

- Two layers-control entries share one module and one pane: **🪨 Geology (Macrostrat)** (colourful bedrock tiles) and **🗺️ Geologic contacts (USGS)** (the fault/contact line network as a WMS `contacts` layer). Both live in `geologyPane` (z-index **354** — above cropland 353, below temperature 355).
- **Tiles are hotlinked, not baked.** Macrostrat serves `https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png` (CC BY 4.0); a global pyramid through z14 is 4^14 tiles — impossible. Nothing is written under `public_html/data/geology/`, so there is **no BUILD token and no Caddy immutable-cache trap** (unlike Köppen/soil/cropland). Ocean tiles are 1 KB transparent PNGs (200, not 404).
- **NEVER set `tileSize: 512`.** Macrostrat serves 512 px images on the **standard XYZ grid** — same geographic bounds as 256 px tiles, just higher resolution. Leaflet's CRS scale is fixed at `256 * 2^z`, so `tileSize: 512` doubles the spacing and the whole overlay comes out stretched and shifted. Keep the default 256; the browser downscales the image into the correct slot. **Do NOT define a `TILE_SIZE` constant either** — a `TILE_SIZE` reference shipped once and threw `ReferenceError` at boot (`geology-layer.js` line 113, 2026-10-28). Pinned by `overlay-contracts.bun.test.js` and `geology-layer.bun.test.js`.
- `maxNativeZoom: 14`; beyond that Leaflet upscales. The USGS contacts WMS (`https://mrdata.usgs.gov/services/worldgeol`, layer `contacts`, WMS 1.1.1 + EPSG:3857) draws **black** lines — the CSS class `xyzo-geology-contacts` inverts them to bright white so they read on a dark basemap. Without the invert the contacts are invisible (fixed 2026-10-28).
- **The probe IS the legend.** Thousands of units make a static key impossible; with Probe armed, `updateProbe()` debounces 250 ms and queries Macrostrat's point API (`/api/v2/geologic_units/map?lat=&lng=`), cached to 0.1° in `probeCache`. It requires `enabled.geology` (not contacts-only). `blocksClick()` returns true while the probe is armed — app.js's click-to-submit guard checks it.
- The module loads BEFORE `app.js` and is in `bump_frontend.sh`'s `ASSETS`. app.js calls `GeologyLayer.init(map)` after creating the map; `getTileLayer()` / `getContactLayer()` are lazy so a disabled overlay costs nothing.
- Both entries get the standard `OverlayOpacity` slider (`setOpacity` / `getOpacity` on the module; the WMS layer has Leaflet's own `setOpacity`).
- On the globe: the Macrostrat XYZ ports as a MapLibre raster source; the contacts WMS deliberately does **not** (MapLibre raster sources need XYZ templates, not BBOX/GetMap).
- The probe is a **network fetch**, so geology is deliberately excluded from the Hover HUD's `SAMPLERS` (same rule as basins) — a mousemove must not fire an HTTP request per cell.

## Facebook Friendships Overlay (NOAA SOS Explorer)

- The source is the NOAA SOS Explorer **"Facebook Friendships"** dataset,
  `ftp://public.sos.noaa.gov/extras/facebook/2048.png` →
  `maps/facebook_2048.png`. Ten million Facebook friendship pairs plotted
  as a global arc map. `scripts/facebook_build.py` slices it into
  `public_html/data/facebook/tiles/{z}/{x}/{y}.png` (z0–z5, 1,365 tiles,
  17 MB raw).
- **THE ALPHA IS THE SOURCE RED CHANNEL.** The PNG is fully opaque
  (alpha 255 everywhere) with a dark-blue background; the red channel
  carries the density (ocean 1, Sahara 1, India 117, USA 250). The build
  maps `alpha = red × 1.3` so the basemap shows through where nobody is.
  Replacing this with a colour ramp destroys the "portrait of the
  internet" reading the dataset was made for.
- **The Mercator inversion is per-pixel.** `lat = arctan(sinh(π(1−2y/n)))`
  per output pixel, then nearest-neighbour sampling of the source. An
  `L.imageOverlay` over the whole world stretches plate carrée content
  linearly across the projected rectangle and distorts the poles.
- **`verify()` runs twice: source first, tiles second.** A flipped axis
  or a broken density channel must not reach the pyramid; an inverted
  Mercator passes the source gate and only shows up in the tiles. Both
  probe 13 known places. The probe table includes **the Amazon** — a
  Brazil probe pointed at the rainforest reads alpha 2 while São Paulo
  reads 175, and only the two of them together catch the mistake.
- **z0–z5, not deeper.** The source is 2048 px wide; z5 is already 4×
  upsampling. Going deeper only inflates the tile count.
- The overlay is a plain `L.tileLayer` in `WEATHER_OVERLAYS` (no module,
  no `blocksClick`, no probe) — it is a picture, not a probe.

## World Languages Overlay Rules (Glottolog)

- The source is **Glottolog** (glottolog.org/meta/downloads), the free
  authoritative database of the world's languages from the Max Planck
  Institute for Geoanthropology — **CC BY-SA 4.0**.
  `languages_and_dialects_geo.csv` (22,324 languoids, 8,889 with a
  coordinate). `scripts/languages_build.py` writes
  `public_html/data/languages/{languages.geojson, meta.json}`.
- **POINTS, NOT POLYGONS.** The previous overlay (Native Land Digital,
  1,473 polygons) could only ever show ONE language per area: where
  several share a territory the topmost polygon hid the rest. Points
  overlap, so a cluster reads as "many languages here" and the probe
  lists every language under the cursor — the Papua New Guinea
  highlands return 675 languages in a 4° box. Do not regress to
  polygons.
- **Dot size encodes co-location**: `2.5 + min(6, log₂(n) × 1.6)` where
  n is `properties.colocated` (how many languages share that exact
  coordinate). Colour comes from Glottolog's **macroarea** — six colours
  that read as a region, not a random per-language hash.
- **Render on a canvas** (`L.canvas()` → `renderer` on the circleMarker).
  8,889 SVG circles is a lot of DOM and stutters while panning.
- **`verify()` is a gate, not a checkpoint**: six known languages must
  land in their known places (Basque, Ainu, Aasax, Sámi, Yaghan, Wintu),
  and the count must be ≥ 8,000. A flipped axis puts every one of them
  in the wrong ocean.
- **The probe owns the click**: `blocksClick()` returns true while armed
  and app.js's click-to-submit guard checks it. The layer's pane is
  `pointer-events: none` and the dots are `interactive: false` — a
  language dot must never swallow a map click.
- `public_html/languages-layer.js` loads BEFORE `app.js` and is in
  `bump_frontend.sh`'s `ASSETS`. Pane is `langPane` (z-index **364** —
  above basins 362, below rivers 365 and wind 370). URL slug:
  `languages`. The legend is a light-theme block inside the white
  layers dropdown (like the Köppen key) — `var(--fg)` renders it
  invisible there. Pinned by `public_html/tests/languages-layer.bun.test.js`.
- `public_html/indigenous-layer.js` was deleted; its `window.IndigenousLayer`
  name is gone and `app.js` no longer references it. A browser with a
  cached index.html gets a one-time 404 on that file and skips the layer
  (every call site is guarded), which clears on the next load.

## City-Name Labels Overlay Rules

`public_html/city-labels.js` draws population-filtered city names on ONE
canvas in `cityLabelPane` (z-index **380** — above wind 370, below the
pins at 400; `pointer-events:none`, `blocksClick()` → false). Loads
BEFORE `app.js`, is in `bump_frontend.sh`'s `ASSETS`, one layers-dropdown
entry `🏙️ City names` (slugs `city-names`, `cities`).

- **Reuse CityEngine's index — never refetch the 4 MB JSON.** The
  labels sort `CE._state().allCities` population-descending once; a
  direct `fetch("/data/cities.10k.json")` is only the fallback when
  CityEngine is somehow absent.
- Density = a **population floor per zoom** (z0: only 10 M+
  megacities; z8+: everything) plus **greedy collision avoidance**
  (largest-first, skip overlaps), capped at `MAX_LABELS = 400`.
- **Restore the on/off preference on a bare revisit.** `init()` reads
  `localStorage["xyzo.cityLabels"]` and, when `"1"`, puts the layer on
  the map **and flips `state.enabled` DIRECTLY** (via
  `onLayerToggled(hasLayer)`). `overlayadd` is fired by the layers
  control, which does not exist yet at init time — waiting for the
  event leaves `enabled=false` and `redraw()` bails while the checkbox
  looks checked. The restore must run AFTER the overlayadd/overlayremove
  listeners are registered (pinned by `city-labels.bun.test.js`).
- **THE PANE-TRANSLATE ANCHOR (the 2026-10-29 "all off centre" bug).**
  The canvas rides inside the pane, and Leaflet's map-pane translate
  **persists after every drag-pan** (`panBy([150,80])` →
  `translate3d(-150,-80,0)`; only a setView/zoom zeroes it). Drawing at
  `latLngToContainerPoint` on that canvas put every label paneOffset
  from its city — correct on a fresh load, drifting with every pan.
  Every `redraw()` re-anchors the canvas so its origin IS screen (0,0):
  `const a = map.containerPointToLayerPoint([0, 0]); c.style.left/top =
  a.x/a.y`. The translate changes per pan, so the anchor belongs in
  redraw, not just in a resize hook.
- **Un-hide at the END of redraw(), never on a bare moveend.**
  `scheduleRedraw` coalesces moveend/zoomend/resize over 80 ms; an
  immediate `visibility=""` on moveend flashed the previous view's
  labels at stale positions for that window. `movestart/zoomstart`
  hide; `redraw()` reveals after painting.
- Pinned by `public_html/tests/city-labels.bun.test.js` (module
  contract, restore ordering, anchor, reveal-after-paint, data file).

## Mobile & Floating-Overlay Rules (2026-10-30)

Every rule here was found by driving a **real iPhone-14-Pro Chromium
profile with real `touchscreen.tap()` events** — not by reading code.
Four of the six defects **lied to `document.elementFromPoint()`** (the
DOM said the control was on top while the finger landed elsewhere), and
all of them passed a desktop-width screenshot. Verify on a phone
profile; a desktop screenshot proves nothing.

### Every ✕ must vanish when what it closes is closed

`mountLayersCloseButton()` appends the ✕ to the layers control and
**never removes it**, so it survives `collapse()` still sitting in the
panel's top-right corner. Collapsed, the panel is only the stack-icon
toggle — **the same 44×44 box** — so the ✕ lands directly ON TOP of the
toggle, swallows every tap, and its own handler calls `collapse()`
again. **After the first ✕ the layers panel could never be reopened, on
mobile or desktop.** Fixed in CSS, because `display: none` is what
actually removes an element from hit-testing:

```css
.leaflet-control-layers:not(.leaflet-control-layers-expanded) .leaflet-layers-close { display: none; }
```

A close button is absolutely positioned; its parent collapsing does not
move it out of the hit-test.

### Never hand-roll a Leaflet control's open/close

The touch toggle used to add the expanded class and set
`display: block` by hand and never call `layersControl.expand()` — which
is the **only** thing that caps the list height and applies
`leaflet-control-layers-scrollbar` (`overflow-y: scroll`). The panel
came out **3,078 px tall on a 660 px phone**, and 26 overlays were
below the fold with no way to scroll to them. Everything goes through
`setLayersPanelOpen()`, and `capLayersListHeight()` re-caps with a
**measured** bottom reservation (Leaflet hard-codes 50 px; a phone's
`#bottom-bar` floats over the map and needs more). The cap re-applies on
resize and on every panel class change.

### A tap on a layers row must survive Leaflet's `_expandSafely`

**`_expandSafely` fires from `mouseenter`, and on touch Chrome
synthesises that mouseenter from the SAME gesture as the tap** — so it
runs ~0 ms before the click, and it does three things that each break a
tap independently. All three must be undone together or the row still
does nothing:

1. **It rewrites the list's height with Leaflet's hard-coded 50 px
   reserve** (`mapSize.y − offsetTop − 50`), overwriting the measured
   cap. **Rewriting `height` on a scroll container RESETS `scrollTop`
   to 0** — the row you had just scrolled to vanishes, and the click
   Chrome synthesises at the same coordinates then lands on whatever row
   moved in: measured as `touchend INPUT…selector scroll=1173` →
   `mousedown BUTTON.leaflet-preset-chip scroll=0`, so a Cool-maps
   preset got *applied* instead of the layer toggling. `capLayersListHeight()`
   must **not** clear `height` to re-measure — `scrollHeight` is the
   CONTENT height whether or not the box has one, so the clear bought
   nothing — and the write must be skipped when the value is unchanged.
   `layersControl.expand` is wrapped to re-apply the cap and restore the
   offset after Leaflet's own `expand()`.
2. **It registers `L.DomEvent.preventDefault` on the whole list for one
   tick**, which cancels the click that toggles the checkbox.
3. **It sets `_preventClick`**, and `_onInputClick` is gated on
   `if (!this._preventClick)` — so even with the click delivered the
   layer is never added: the box ticks and nothing happens.

**Symptom of (1) alone:** the click hits a *different* control.
**Symptom of (1)+(2):** the box ticks but the layer never activates.
**Symptom of all three:** "the checkbox does nothing" — which is what
was reported. Fixing one or two leaves a broken tap that looks fixed.

### The layers panel has no width of its own — cap it

`.leaflet-control-layers-expanded` is right-anchored with no `max-width`,
so it sizes to its **widest row**, and it grew when the legibility sweep
raised the base font: on a 393 px phone it went **383 px → 418 px at
x = −35**, putting the **checkbox column off the left edge**
(`document.elementFromPoint()` at the City names box returned `null`).
That reads exactly like "the layer ignores the checkbox". It is now
`max-width: calc(100vw - 20px)`; the rows are flex with a shrinkable
label and leader, so the names **wrap** instead of pushing the panel
off-screen. Any new right-anchored panel in the layers control needs the
same cap.

### CSS `zoom` is invisible to Leaflet — divide widths by it

The text-size control gives `.leaflet-popup-content-wrapper` `zoom:
var(--ui-zoom)` (115 % by default). Leaflet measures `offsetWidth`
**before** the zoom, takes `maxWidth` from it and pans to fit **that
number**, while the popup renders 15 % wider. On a 393 px phone a 341 px
popup rendered **392 px**, pushing the ✕ Close off the right-hand edge.
`popupMaxWidthForViewport()` hands Leaflet the **pre-zoom** width
(`min(340, innerWidth − 96) / zoom`) and the CSS `max-width` divides by
the zoom too — `max-width` resolves *inside* the zoomed space, so
`calc(100vw - 24px)` was rendering 15 % over the viewport.

**Consequence: do NOT put Leaflet-measured surfaces on the `--ui-zoom`
list.** A zoomed layers panel renders taller than the height cap
believes and the 3,078 px unscrollable panel returns.

### Anything floating over the bottom bar must be measured against it

`#help-me-btn` is `position: fixed; z-index: 9998`;
`#bottom-bar` is `z-index: 500`. On a phone the bar spans the full
width, so the pill covered the bar's **right end — exactly where ⚙ and
Markers live**. Measured overlap 4,580 px²; `elementFromPoint` at the
gear returned `#help-me-btn`. The **entire control menu was untappable
on mobile**. `publishChromeEdges()` measures the real bar and writes
`--help-me-bottom`; the pill rides above it only when the bar reaches
under it. The same must hold for the **layers panel**:
`mountLayersCloseButton()`'s `MutationObserver` sets
`data-layers-open="1"` only when the panel's box actually reaches the
pill's corner, and the pill slides clear.

### A fixed dropdown is anchored to EDGES, not to heights

The ⚙ control menu was anchored to typed constants that had drifted from
the real chrome, so it collided with three different pieces of furniture
depending on which anchor you fixed (measured on a 393×660 iPhone 14 Pro):

- **`bottom: 58px` was the bar's HEIGHT, not its top edge (70 px).** The
  bar is itself `bottom: 12px`, plus `env(safe-area-inset-bottom)` on a
  device with a home indicator, so a `bottom:` anchor needs
  `window.innerHeight − bar.top`. The menu sat **12 px inside the bar**
  and its last row, "AI / Help", was half-hidden.
- **There was no top constraint at all.** The menu is **799 px tall in a
  538 px band**, so it can never fit and must scroll inside a box
  bounded by BOTH edges. Anchoring only to the bottom grew it up under
  the search pill.
- **`--top-band` is NOT the fix.** It measures the *map control stack*,
  which sits below the search pill. An overlay anchored at the top needs
  **`#top-bar`'s own bottom edge** — a different quantity, and nothing
  published it.

`publishChromeEdges()` (renamed from `publishBottomBarHeight()`, which
only ever measured the bar) writes both, re-measuring on resize,
orientation change and after the i18n labels land:

```js
--bottom-bar-top:    window.innerHeight - bar.getBoundingClientRect().top
--top-chrome-bottom: topBar.getBoundingClientRect().bottom
```

`.bar-dropdown` derives `bottom`, `top` **and** `max-height` from them.
**Do not restate a `max-height` in `.bar-dropdown--wide`** — a second
calc ignores the bar's real top edge and undershoots the band.

### A column flex container's child will not shrink unless you say so

The scroll needed **`min-height: 0` on the shell AND `flex: 1 1 auto` on
`.control-menu-inner`**, and without both the 550 px shell clips
**silently**: the inner is a flex item whose automatic minimum is its
content height, so it *stretches* to 918 px, and
`scrollHeight === clientHeight === 918` means `overflow-y: auto` never
engages and there is no scrollbar to notice. `flex: 1 1 auto` resolves
the basis against the shell's definite box instead.

### Park anything else in the clear band while a dropdown is open

`#help-me-btn` is `position: fixed` on `<body>` and painted **OVER** the
dropdown (z 10000 vs 9998), covering **~5 rows — "MY STYLE", "Save this
view", "Next visit", "My default map" — about 45,000 px²**. On a 393 px
phone the menu is centred and spans the whole band, so there is nowhere
the pill could move to; hiding it costs nothing because it is an
emergency affordance, not a control.

`setDropdownOpen()` sets `body[data-dropdown-open]`. It is called from
`closeOtherMenus()` with `!!exceptMenuId` — that function runs **before**
the caller shows its menu, so a second loop could only ever see the menus
just closed — and cleared by **ONE document click listener**, not by six
close paths (each dropdown hides its own menu in its toggle's else-branch,
an outside-click handler and an option click, and six sites is six
chances to drift).

### A fixed dropdown sized by shrink-to-fit can be too narrow for its row

Shrink-to-fit settled at **323 px** while the widest row — four 44 px
chips, the WCAG 2.5.5 floor — needs **305 px of content plus 28 px of
padding = 333 px**, so the **"✨ Cool" chip lost its tail at every text
size**. `width: max-content` re-centres at 352 px with 20 px of margin
either side; because the shell is centred with `translateX(-50%)`,
growing it cannot push it off-screen.

### A popup must be still and on-screen when the user taps it

`openPinPopup()` **waits for `moveend` on a touch device** instead of
opening 150 ms into a 400 ms pan — a popup that appears mid-pan slides
for the rest of the animation, so a tap aimed at the ✕ lands on
whatever moved into that spot. `keepPopupOnScreen()` replaces Leaflet's
autoPan (which is **animated**, so a post-`popupopen` correction *races*
it — 2 of 6 popups still off-screen) with one measured, immediate pan
that also clears the **search pill** and **`#bottom-bar`**.

### An overlay pinned above the popup pane can make a popup un-closable

The outage banner is `z-index: 9999` against the popup pane's `1200`
and was anchored to `--top-band`, which measures the **control stack**
only. It slid under the search pill and over the top of any
top-anchored popup, so a popup opened during an incident **could not be
closed** — `elementFromPoint` at the ✕ returned
`DIV.system-wide-error-banner`. It now reserves the measured chrome
(`--map-top-chrome`) and is capped to the space actually free.

### Legibility: the A / A+ / A++ control scales NINE selectors

`.live-panel-*`, `.leaflet-popup-content-wrapper`,
`.explore-panel > *`, `#help-panel > *`, `.overlay-card > *`,
`.bar-dropdown > *`, `.nav-links`. The layers dropdown, its legends, the
bottom bar, the control menu, the probe cards and the hover HUD are
**not** among them, so they were stuck at 9–12 px whatever the user
picked. Raise their **base** sizes (scoped sweep: 9→11, 10→12, 11→13,
12→14), never their `zoom`.

- **An `em` in vendored CSS resolves against a base you may not have
  set.** `.leaflet-control-layers label` and `.leaflet-popup-content`
  are both `1.0833em`; against the unset inherited base the **layer row**
  — the most-touched control on the map — rendered at **12.75 px**. It
  is now an explicit 14 px override. Measure the rendered px; do not
  read the stylesheet.
- **A percentage-positioned label overhangs at BOTH ends.** Legend ticks
  are positioned by `s.style.left = <pct>` with no centring, so a tick
  at 100 % starts at the bar's right edge and runs into the unit
  gutter. Centring every label with `translateX(-50%)` fixed the right
  and **broke the left**: `.leaflet-control-layers-scrollbar` has
  `overflow-x: hidden`, so "-40" lost its minus sign. Adjust **only the
  end labels** (`:first-child` stays, `:last-child` gets
  `translateX(-100%)`).
- **A hidden-labels rule must match the element, not an attribute you
  assume.** The bottom-bar rule matched `span[data-i18n]`;
  `#markers-dropdown-label` is a plain `<span>`, so it survived into a
  46 px box holding 76 px of text and rendered as a clipped "Marker".

### The 3D globe panel must be dismissible, and 44 px on a phone

On a phone `#globe-panel` is **298×606 on a 393×660 screen — 76 % of
the width** — and shipped with **no close affordance at all**.
`#globe-panel-head` carries a `position: sticky` ✕ and
`#globe-panel-open` ("☰ Layers") reopens it, so the ✕ is never a one-way
door. A phone starts collapsed. MapLibre's own controls ship at **29 px**
— under the 44 px minimum — raised under `@media (pointer: coarse)`.

### The debug overlay is not a product feature

`map-debug.js` built its UI unconditionally, putting a "🐛 debug" button
at `bottom: 12px / left: 12px` on top of the language selector. It is
gated behind `?debug` / `localStorage["xyzo.debug"] = "1"`, and it
carries a `?v=` token (it had none, so a cached copy could never pick
up a fix).

Pinned by `public_html/tests/mobile-close-affordances.bun.test.js` and
`public_html/tests/control-chrome-collision.bun.test.js`.

## 3D Globe View Rules (MapLibre)

`public_html/globe.html` is a **separate** 3D globe view. The flat map is
Leaflet and **stays Leaflet** — the canvas pin renderer, the isobar layer,
the basins probe and the layers dropdown are all deeply Leaflet-coupled,
so a globe is additive, not a port.

- **MapLibre GL JS 5.6 is vendored** at `public_html/vendor/maplibre-gl/`
  (939 KB raw / 248 KB gzipped). It is loaded **only by the globe page** —
  the flat map never pays for it.
- **THE CONSTRUCTOR'S `projection` OPTION IS IGNORED in MapLibre 5.6.**
  `getProjection()` stays `null` and the map silently renders FLAT. The
  globe has to be set with `map.setProjection({type: "globe"})` inside the
  `map.on("load")` handler.
- **Sources and layers must be added inside the load handler too.** Calling
  `addSource()`/`addLayer()` before the style is ready throws *"Style is
  not done loading"* and the whole page dies.
- The globe carries the **same overlays** as the flat map: Köppen, Soil
  (9 properties + a chip switcher in the panel), Cropland and Land Cover
  are Web Mercator raster tiles (warped by the globe); Geology is
  external Macrostrat XYZ; NASA Satellite/Rain/Night are GIBS XYZ with
  the date baked at load; Rivers, Basins and Magnetic lines are
  **vector** GeoJSON and reproject natively; Isobars are fetched once
  from `/api/weather/isobars` and coloured by level; Temperature is the
  GFS grid baked into an equirectangular canvas and draped as a
  MapLibre **image source**. Two flat-map overlays deliberately do NOT
  port: **Wind streamlines** (a screen-space canvas animation tied to
  Leaflet's 2D projection — particles behind the globe have no
  meaningful screen position) and **Geologic contacts** (a USGS WMS
  layer; MapLibre raster sources need XYZ templates, not BBOX/GetMap).
- **THE GLOBE PINS ITS OWN ISOBAR STEP (`step=2`) — it has no detail
  control, so it must choose a density.** Without a `step` the API
  returns EVERY published level, and the published set is the FINEST one
  (1 hPa), so the globe would silently double in density AND in payload
  the moment the worker published a finer interval — a hairball at
  ~1,100 lines and ~626 KB for a view that is not zoomable. **2 hPa is
  the globe's DEFAULT, and a SHARED LINK overrides it** (`iso=1` is the
  same segment the flat map writes, and the handoff passes it through
  untouched — "share the exact map" has to mean the same thing in both
  views). **The step is recorded BEFORE the isobars are fetched**: the
  globe's own hash writer runs on the first `moveend`, which can beat
  the fetch, and it must write the step the globe is drawing — with the
  assignment after the await, a shared link's `iso=1` was rewritten to
  `iso=2` and the detail was lost on the way back to the flat map
  (measured: the globe fetched `step=1` and then wrote `iso=2`).
  Pinned by `public_html/tests/globe.bun.test.js` and
  `public_html/tests/isobar-step.bun.test.js`.
- **THE GLOBE ALSO CARRIES THE ISOBAR COLOUR (`iso=<step>:<colour>`).**
  The segment is one token with two halves, and a reader that loses the
  second one on the way home gets a different map back: `globeIso()`
  parses it with a **regex** (a bare `Number("1:red")` is NaN, so the
  validity check would drop the whole segment — that is how the colour
  used to vanish), `resolveIsoStops()` runs the scheme through the
  SHARED `ramp-styles.js` `recolor` (so `globe.html` must load it —
  see the isobar rules), `ISO_INKS` holds the three single-ink hexes
  and is asserted equal to the flat map's, and the hash writer emits
  `iso=<step>:<colour>` **always**, not only when it differs from the
  default. Pinned by `public_html/tests/isobar-colour.bun.test.js`.
- **The temperature image source must stay OFF the exact poles.**
  Projecting ±90° onto the globe yields `y=Infinity` ("x=0, y=Infinity,
  z=0 outside of bounds") and the source silently never renders. The
  corners are inset to ±89.5° — half a grid cell, invisible, but it
  keeps the projection finite.
- **NEVER INDEX A RAMP BY EVEN SPACING — every ramp lookup scans for
  the bracketing pair.** `meta.ramp`'s stops are NOT evenly spaced (the
  temperature ramp's gaps run 4.2, 4.9, 3.5, 2.1 °C), so
  `ramp[round((c - lo) / ((hi - lo) / (n - 1)))]` picks the wrong stop:
  the globe landed **up to +4.9 °C too warm**, worst disagreement
  **113.9 RGB units at 0 °C** (lime-yellow where the flat map paints
  green), 19 of 36 sampled temperatures visibly wrong. `temp-layer.js`
  has always interpolated by each stop's real `c`; the globe now does
  the same. A comment in `globe.js` had asserted the temperature ramp
  was uniform, which is what let it ship — **do not re-introduce a
  "safe because even" claim about any ramp here**. `magRampColor()` and
  the lightning `rampAt()` already scan; the mag wash's uniform LUT is
  fine only because each entry is BUILT by calling `magRampColor()`.
  Pinned by `public_html/tests/globe-overlay-settings.bun.test.js`,
  which extracts `rgbOf` from the shipped file rather than copying it.
- **CAPTURE THE INCOMING HASH BEFORE MAPLIBRE CAN TOUCH IT, and gate
  the writer until it is consumed.** The map's initial `moveend` fires
  within ~250 ms and `writeGlobeHash()` → `applyGlobeHash()` replaces
  `location.hash` from DEFAULT overlay state — which ran before the
  `load` handler read the incoming link. Measured: a shared link asking
  for `12.35,76.54` with two layers on opened at **22,10 zoom 2.1 with
  every layer off**, and the URL itself was rewritten to the boot view.
  Capturing alone is NOT enough: without the `hashConsumed` gate the
  writer still goes first and the reader then sees its own overwritten
  value. Both halves are needed.
- **`public_html/view-handoff.js` is the ONE bridge between the two
  views, and it is loaded by BOTH pages.** The two vocabularies
  genuinely differ — the flat map's `getLayerSlug()` emits `temperature`,
  `magnetic`, `soil-soilgrids`, `cropland-esa`, `land-cover-esa`,
  `geology-macrostrat`, while `globe.js` keys them `temp`, `mag`, `soil`,
  `cropland`, `landcover`, `geology`. Six of fifteen dropped straight
  through the globe's `if (!st) continue`: a **silent partial transfer
  no screenshot can catch**. The alias table lives in that file only —
  neither `app.js` nor `globe.js` may hand-roll one. The flat link is
  built at CLICK time (the overlays a user ticks do not exist when the
  control is created), and the globe **flushes** its debounced hash
  before building the "Back to the map" link so toggling a layer and
  hitting back inside 250 ms does not take the previous view home.
  The globe carries only 15 of the flat map's overlays, so a handoff is
  faithful for what it has and silent for the rest (README Known 0n).
  Pinned by `view-handoff.bun.test.js` and
  `scripts/globe_handoff_check.py` (6/6 round trip, Playwright).
- **Audit the globe with Playwright, one overlay at a time.**
  `scripts/globe_audit.py` resets `localStorage["xyzo.globe.settings"]`
  first and isolates each layer — toggling them cumulatively leaves all
  15 on and every screenshot reads as "everything is broken" when it is
  really "everything is on at once". MapLibre does not set
  `preserveDrawingBuffer`, so `gl.readPixels()` returns **all zeros**;
  the visual verdict has to read the PNG. 15/15 currently render.
- **Magnetic on the globe draws the INDEX contours only.** The three
  line families (isogonics / isoclinics / isoporics) load as three
  MapLibre sources under the single `mag` toggle, each layer filtered
  with `["==", ["get", "major"], true]` — the 2° intermediate mesh the
  flat map hides below zoom 4 would turn the globe's fixed world view
  into a hairball. `layerIdsFor("mag")` and the `applyOpacity` kind
  loop must both list all THREE families (they lagged at two when
  isoporics shipped). Pinned by `public_html/tests/globe.bun.test.js`.
- The pins come from the same `/api/pins/map` call. **The limit is capped
  at 2000** — asking for more is a 400, and the globe shows 2,000.
- Every overlay needs a real `opacity` default or the slider readout
  renders "NaN%".
- The flat map links here with a globe button next to the "zoom out to the
  whole earth" control; a clicked pin links back to the flat map with the
  same story.

- **The globe lives at `/globe`, not `/globe.html`.** Caddy rewrites
  `/globe` and `/globe/` to `globe.html`; the old URL still works.
  `globe.html` uses **absolute** asset paths (`/globe.js`, `/globe.css`,
  `/vendor/...`) so the rewrite cannot break them. All links must point at
  `/globe`, not `/globe.html`.
- **The globe shares its state in the URL hash**, same shape as the flat
  map plus a projection token: `#lat,lng,zoom/overlay=koppen@50,soil@55/proj=globe`.
  Written on `moveend` and on every overlay/projection change, read back
  on load. Without it a shared link opens the globe at its default view
  with every overlay off. A bare slug (no `@pct`) still parses — links
  from before opacity-in-hash keep working.
- **NASA GIBS `maxZoom` must equal the Level number.** The tile URL
  contains `GoogleMapsCompatible_LevelN`; requesting zoom N+1 returns
  **HTTP 400** from GIBS (not 404). This bit the Rain Rate overlay
  (Level6 + maxZoom 7) on both the flat map and the globe.

Pinned by `public_html/tests/globe.bun.test.js`.
- **Overlay settings and the projection persist** in
  `localStorage["xyzo.globe.settings"]` — same contract as the flat map's
  layer prefs, under its own key so the two views never clobber each
  other. `loadSettings()`/`saveSettings()`/`persistOverlay()` in globe.js.
- **MapLibre's default popup is WHITE with dark text** — unreadable
  against the dark theme. `globe.css` overrides
  `.maplibregl-popup-content`, the tip (for all four anchor sides) and
  the close button to match the flat map's dark popups. Never ship a
  MapLibre popup without this override.
- **`bump_frontend.sh` stamps globe.html's assets too** (`globe.js`,
  `globe.css`, the vendored MapLibre bundle, and globe.js's internal `V`
  constant). A stale `?v=` on globe.js kept cached browsers on old
  overlay code. The index.html ASSETS loop never touches globe.html.
- **The flat-map 3D globe button is a ringed planet** (Saturn-style
  SVG), not a second copy of the world-view globe icon — the two
  controls in the zoom bar must be instantly distinguishable.
- **THE TWO VIEWS' LAYER PANELS MUST AGREE, AND THE GAP MUST BE AN
  EXPLICIT CONTRACT.** `WEATHER_OVERLAYS` (app.js) and `OVERLAYS`
  (globe.js) are two hand-maintained tables, so they drift quietly —
  and "the globe has fewer overlays" is true often enough that every
  real difference hides behind it. Measured live from a clean profile on
  2026-11-01: 12 of 15 shared overlays already agreed, and the five that
  did not were invisible to a screenshot. **(a) A shared overlay's
  LABEL must be identical in both views.** The globe said "🛰️ NASA
  Satellite" / "🌧️ NASA Rain Rate" where the flat map says "… (True
  Color)" / "… (IMERG)". **(b) A shared overlay's DEFAULT OPACITY must
  be identical**, and the globe must take it from the *module's own*
  default rather than inventing one — temperature was 0.9 vs 0.55,
  magnetic 0.9 vs 0.80, lightning 0.9 vs 0.85. **(c) An overlay the flat
  map has and the globe lacks must be listed in `NOT_PORTED` in
  `panel-parity.bun.test.js` WITH ITS REASON** — the reason is the
  contract (screen-space animation, WMS, a wrapping `L.GridLayer` …), so
  that porting it forces the entry to be deleted. The test also fails if
  a `NOT_PORTED` entry has since been ported **or** names an overlay the
  flat map no longer has, so the allowlist cannot rot in either
  direction. **Read both tables from source, never from a copied list** —
  a parity check over an incomplete list cannot fire (the same trap the
  pane-z-index test had).
- **A SHARED LINK MUST MEAN THE SAME THING IN BOTH VIEWS.** The two
  vocabularies genuinely differ (`temperature`/`magnetic`/
  `soil-soilgrids`/`cropland-esa`/`land-cover-esa`/`geology-macrostrat`
  vs `temp`/`mag`/`soil`/`cropland`/`landcover`/`geology`), and
  `view-handoff.js` is the ONE place that translates — neither page may
  hand-roll an alias. `panel-parity.bun.test.js` round-trips every
  shared key and pins the owner's example link,
  `#…/overlay=soil@40,isobars@100` ↔ `soil-soilgrids@40,isobars@100`,
  including the `@opacity` suffix and the bare-key form.
- **`--zoom-stack` is measured, not hand-tuned.** The zoom bar grew to
  four buttons (+, −, world, 3D globe) and the live panel — anchored at
  `--panel-top = --zoom-top + --zoom-stack` — slid over the bottom
  button. `syncZoomStack()` in `app.js` (inside `initGlobeControl`)
  measures the real bar height and writes `--zoom-stack`, with a
  `ResizeObserver`. The CSS fallback (`146px`) is only for no-JS.
- **AN OVERLAY'S `paint` OPACITY IS ITS INTRINSIC BASE, AND THE SLIDER
  MULTIPLIES IT — never replaces it.** The flat map has always done this
  (`basin-layer`: `fillOpacity: 0.16 * state.opacity`, `river-layer`:
  `opacity: 0.9 * state.opacity`), but the globe's generic fill/line
  builder wrote the slider straight over the paint value, so a
  deliberately low base was discarded. **Hydrological Basins** is where
  it showed, because its base is `0.16` and its slider default is `0.7`:
  at `basins@100` the globe applied **`fill-opacity: 1.0` — fully
  opaque** — and the whole planet became a flat cyan sheet with the
  satellite, Köppen, soil, cropland and every layer beneath it buried;
  at `basins@35` it applied `0.35`, still 2.2× the intended wash. You
  could see the watershed outlines and nothing else, which is the exact
  inverse of the flat map, where basins are a hairline over terrain you
  can still read. `baseOpacity(o, prop)` now reads the base (absent or
  out-of-range → 1) and both the **builder and `applyOpacity()`** compute
  the same product — keeping the two paths identical is what stops a
  freshly-loaded layer and a slider-dragged one disagreeing. The
  fill's `-line` sibling uses the **fill's** base, so the outline dims
  with the wash instead of glowing out of a faint fill.
- **A base that EQUALS the slider default hides the bug, so check every
  overlay when you change the semantics.** `rivers` shipped
  `line-opacity: 0.85` against a `0.85` slider — invisible under the old
  replace-the-base bug while it buried the basins. It is now `1.0` so
  rivers renders at exactly the strength it always shipped at; the
  comment on the spec says to drop it to `0.9` if you want the two views
  to MATCH rather than to stay put. Pinned by
  `public_html/tests/globe-overlay-opacity.bun.test.js`, which includes
  a mutation check (re-introduce `"fill-opacity": startOpacity` and it
  fails).

## Export Rules (client-side images + datasets)

The user can download the map they built: a PNG of the view, and the
underlying data as GeoTIFF / GeoJSON / KML / CSV, or one ZIP with all
of it. **All of it runs in the browser.** There is no export endpoint
on the server and there must never be one — the site already
publishes every dataset as a static file under `/data/`, so the
exporter READS. A whole-world GeoTIFF costs the site nothing.

Four new files, loaded **before** the layer modules:

| File | What it is |
|---|---|
| `public_html/export-contract.js` | the registry — `window.XYZO_EXPORT` |
| `public_html/export-writers.js` | pure writers: GeoTIFF, GeoJSON, KML, CSV, SVG, ZIP |
| `public_html/export-engine.js` | orchestration: rasterise, sample, write, download |
| `public_html/export-panel.js` | the ⚙ → EXPORT dialog |

They are in `bump_frontend.sh`'s ASSETS list.

### THE RULE — a layer exports ITSELF

**The exporter never re-implements a layer.** A second implementation
of a layer's ramp, its scale factor or its row order is a second
source of truth, and the second source of truth is the one that drifts
(the soil layer says it itself: *"never a second data source, or the
number under the cursor will eventually disagree with the colour"*).

So each layer module registers a **surface** at load time:

```js
window.XYZO_EXPORT.register({
  id: "temperature", label: "🌡️ Temperature (GFS)", kind: "raster",
  attribution: "NOAA NCEP GFS — 2 m air temperature",
  licence: "US Government work (public domain)",
  z: 355,                          // the map's pane order
  bands: [{ name: "air_temperature", unit: "°C" }],
  native: { cols: 360, rows: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360 },
  isActive: () => !!state.grid,
  sample(lat, lon) { ... },        // the layer's OWN sampler
  color(value) { ... },            // the layer's OWN ramp / LUT
});
```

`sample()` returns a number, an array (one per band) or null for
nodata. `color()` returns `[r,g,b]`. The exporter calls them; it
never computes them.

### The rules that are load-bearing

- **THE CONTRACT MUST LOAD BEFORE THE LAYER MODULES.** Each layer
  calls `registerExport()` at load time, so a contract that arrives
  late collects nothing. The `export-*.js` tags sit **above**
  `climate-layer.js` in `index.html`, not beside `app.js`.
- **`z` IS THE MAP'S PANE ORDER.** The exported PNG draws the layers
  in the order the map stacks its panes (climate 350 → soil 352 →
  temperature 355 → lightning 356 → mag 358 → isobars 360 → basins
  362 → rivers 365), NOT in the order the user ticked them. Drawing
  the Köppen wash over the temperature field produced a picture that
  disagreed with the screen it came from.
- **NODATA IS NaN, NEVER 0.** The lattice is `Float64Array` filled
  with NaN, and the GeoTIFF declares `GDAL_NODATA = nan`. A blank
  cell that exports as 0 is a false 0 °C.
- **ROW 0 IS THE NORTHERNMOST ROW.** The GeoTIFF tiepoint puts
  raster (0,0) at (minLon, maxLat); the engine samples north to
  south. `ModelPixelScale` + `ModelTiepoint` + a `GeoKeyDirectory`
  with `GTModelType=2` and `GeographicTypeGeoKey=4326` make it open
  natively in QGIS. **Verified against GDAL**, not just against a
  byte-level test.
- **THE PINS EXPORT THEIR TRUE COORDINATES.** The canvas renderer
  stores a SPREAD copy of the pins (it nudges overlapping pins apart
  so none is hidden), and a spread position is a lie about where a
  story happened. `app.js` keeps `_rawPins` and publishes
  `window.__xyzoExportPins()`.
- **THE BASEMAP IS NOT EXPORTED.** A world PNG assembled from OSM or
  Esri tiles would be a bulk download, and neither tile policy allows
  it. Overlays only.
- **EVERY EXPORT CARRIES ITS LICENCE.** A PNG gets an attribution
  footer; a GeoTIFF gets `GDAL_METADATA`; a GeoJSON gets foreign
  members; a ZIP always gets a `LICENSE.txt`. CC BY-SA 4.0 (the FAO
  basins, Glottolog) makes the derivative share-alike, and the
  pins' stories belong to their publishers.
- **`window._xyzoMap`, NOT `window.map`.** `app.js` declares the map
  as a top-level `const`, which does NOT become a window property.

Pinned by `public_html/tests/export-writers.bun.test.js` (GeoTIFF
bytes, geokeys, row order, ZIP structure), `public_html/tests/export-contract.bun.test.js`
(registration, the engine's bbox and lattice maths) and the export
section of `public_html/tests/data-licences.bun.test.js`.

## Daily Digest Rules (curation + video)

- The digest artifact is `data/daily_digest.json`, written by `worker/daily_digest.py` and served by `GET /api/digest/today`. It is a **file, not a table** — it is written once a day, reviewed by a human, and published.
- **Selection is deterministic; the model only writes.** The signals (`news_event_velocity`, `news_event_sources`, `news_story_links`), the world test, the category filter and the variety pass decide what runs. The model writes the *why* / narration / English headline / place and may veto — it never picks.
- The **world test** is the load-bearing rule: ≥4 credible outlets AND (≥2 countries OR ≥8 outlets). Without it the digest fills with football results and local notices.
- **Duplicates are rejected at selection time, not in the pool.** The story graph is transitive — de-duplicating the pool first chains unrelated events together and swallows the good candidates. Use `is_duplicate()` (article overlap + strong story links) inside `diversify()`.
- `news_undercovered` and `news_problems` are **stale** (last written 2026-09-13) — do not rely on them for live signals. The under-coverage signal is computed live instead.
- The AI box (`http://localhost:3011`, primary) is far sharper than the local fallback (`192.168.1.3:8888`, gemma-4-E2B). The fallback often returns empty for structured prompts. **Ask one narrow question at a time** — a binary A/B question is answered reliably where a multi-field JSON form is not.
- The model sometimes copies sentences from the prompt — never put a reusable example sentence in the system prompt, and strip meta-language ("for viewers", "this news item") from the output.
- `worker/digest_render.py` drives `public_html/digest-render.html` with Playwright. **`[hidden] { display: none !important }` is required there**: the title card and lower third are toggled with the `hidden` attribute, and an id-level `display:flex` outranks the UA's `[hidden]` rule — without it the title card covers every frame.
- `worker/digest_upload.py` is **inert without credentials** and must stay that way: `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` live in `/etc/xyzo/xyzo.env`, never in the repo.

---

## Deployment Rules

- Run `scripts/validate-api.sh` before deploying (catches missing exports)
- API service: `systemctl restart xyzo-api`
- Frontend: served by Caddy from `public_html/` (no restart needed, just edit files)
- Workers: `systemctl restart xyzo-fast-fetcher` (5min timer) or `xyzo-fetcher` (15min timer)

## Crash Recovery (Fetch Lease System)

Sources use a 5-minute lease to prevent double-fetching when multiple workers run:

- `worker/fetch.py:LEASE_TTL_S = 300` — lease expires after 5 minutes
- `FOR UPDATE SKIP LOCKED` — only one worker can claim a source at a time
- `_release_lease()` uses CAS (`lease_token`) — a crashed worker can't accidentally
  release another worker's claim
- Every exit path (`finally`) releases the lease

**On sudden reboot:** `fetch.run()` calls `cleanup_stale_leases()` at startup. It clears
any `fetch_in_progress=TRUE` rows where `lease_token IS NULL` OR `lease_expires_at < now()`.  
Sources are immediately reclaimable — no need to wait for the 5-minute TTL.

```bash
# Manually clear stale leases
python3 -c "from worker.fetch import cleanup_stale_leases; print(cleanup_stale_leases())"
```

**Robots.txt disk cache** (`~/.xyzo/robots_cache.json`) survives process restarts —
hosts already looked up don't generate new HTTP requests on restart.

## Robots.txt Tracking System

Every robots.txt check result is persisted to `news_sources`:

- Columns: `robots_checked_at`, `robots_status`, `robots_content_hash`,
  `robots_http_status`, `robots_sitemaps`, `robots_crawl_delay_s`
- `RobotsCache.persist_to_db()` in `worker/robots.py` handles the write
- `fetch.py` calls `persist_to_db()` inline after every robots check — no separate
  scheduling needed
- `worker/robots_verify.py` — backfill and change-detection tool:
  - `--since N` — check sources not verified in N days
  - `--only-changed` — re-check all verified hosts, persist only on hash change
  - `--verbose` — show each changed host's old→new hash

```bash
python -m worker.robots_verify --since 7 --limit 500        # catch up stale sources
python -m worker.robots_verify --only-changed --verbose     # detect robots.txt changes
```

## Wildlife Source Network (2026-10-29)

The registry is `worker/data/wildlife_sources.json` — **443 candidate**
wildlife / conservation / biodiversity organisations, of which **101
live feeds** were probed and imported (plus 7 that were already in the
DB). The tool is `worker/wildlife_sources.py`; the evidence is
`logs/wildlife_sources_report.json`.

### A feed is PROBED before it is written — never imported blind

A homepage that answers 200 proves nothing about the feed. Half the
conservation orgs in the world publish a site whose feed was moved, sits
behind a bot wall, or parses cleanly and has been empty for two years.
An unprobed feed becomes a row that looks healthy in the admin panel and
never yields an article — which is exactly what the dormant `Smithsonian
Magazine`, `National Geographic` and `Yale Environment 360` rows were.

`worker/wildlife_sources.py::probe_candidate` does, in order:

1. every candidate feed URL in the registry;
2. the homepage's `<link rel="alternate" type="application/rss+xml">`;
3. a scan of the homepage for ANY feed-ish href (publishers link the
   feed from a nav item, not a head tag);
4. the common conventions (`/feed/`, `/rss/`, `/feed.xml`, `?feed=rss2`,
   `/atom.xml`, `/index.xml`, …);
5. `feedparser` + **at least one entry** — a feed that parses but is
   empty is EMPTY, not WORKING;
6. `robots.txt` for the winning URL — a disallowed feed is NEVER
   imported.

**24 of the 101 feeds were found by discovery, not by guess** — the
registry's own URL guesses were wrong that often.

### THREE feed traps that parse cleanly and carry no news

- **Comment feeds.** `forest-trends.org/comments/feed/` returns 200 and
  a valid RSS document — with **zero entries** and the title "Comments
  on:". `birdlife.org/<region>/feed/` is the same shape. The
  entry-count check catches them, and `BAD_TITLE_HINTS` catches the rest.
- **Podcast enclosure feeds.** `wilderness-society.org/feed/podcast`
  returns a valid feed of episode metadata. `BAD_FEED_URL_HINTS` in
  `worker/wildlife_sources.py` rejects it.
- **Duplicate feeds.** Eight regional BirdLife editions all resolve to
  `www.birdlife.org/feed/`. `news_sources.feed_url` is UNIQUE, so the
  extras would silently vanish — `dedupe_rows()` drops them at import
  and keeps the highest-priority entry.

### ONE PUBLISHER, ONE ROW — the alias rule

`snowleopard.org` **is** the Snow Leopard Trust (same publisher, same
feed, different host). `hakaimagazine.com/feed/` and
`www.hakaimagazine.com/feed/` are the same documents. `woah.org/en/feed/`
and `woah.org/en/rss/` are the same documents. Two rows for one publisher
means the same story lands on the map twice.

These are marked with **`alias_of`** in the registry — a curated field,
because only a human knows that two hosts are one organisation — and
`derive_skip_flags()` turns it into a skip flag with the reason
"same publisher as X". Pinned by
`worker/tests/test_wildlife_sources.py::test_no_duplicate_publisher_rows`.

### THE COUNTRY MUST BE THE PUBLISHER'S EDITORIAL BASE — verified, not guessed

`news_sources.country` drives the single-city source fallback, so a
wrong value puts every story of that publisher on one capital (the
Bamako pileup — see "Source Placement Pileups" above).

- **A source whose output covers a whole region or the whole world
  carries `country = NULL`** plus the coverage role in `locality`
  ('regional' / 'international'). The first import gave 36 of them a
  country and the fallback duly put African conservation stories on a
  US city and global science stories on London — 593 mis-placed
  articles had to be re-opened. **A country-less source is placed from
  its own text or left unlocated, which is the honest outcome.**
- **National bodies carry their own country** plus
  `locality='national'` — that is what makes the placement gate work.
- **Regional desks' editorial bases, each checked against the
  publisher's own site:** Snow Leopard Trust → `US` (**Seattle** HQ —
  it is a US 501(c)(3) with partners in Mongolia, India, Kyrgyzstan,
  China and Pakistan); Eurobats → `DE` (UNEP, Bonn); African
  Conservation Foundation → `GB` (**UK registered charity 1120705**).
- `worker/tests/test_news_source_addition.py::test_active_sources_have_country`
  enforces that an active source has a country OR is marked
  regional/global — the marker is `region IN ('mena','global')` **or**
  `locality IN ('regional','international')`.

### A GENERAL feed is NOT a wildlife feed

`topic` and `topics` are the map's filter vocabulary. Tagging BBC
Science & Environment, PBS NewsHour, Euronews Green or Phys.org as
`wildlife` would make a wildlife filter lie. Those carry
`topic='science'` or `topic='environment'`; the registry's
`feed_scope` field (`wildlife` / `general`) records the distinction and
`worker/wildlife_registry_patch.py` (via `scripts/`) sets it.

### The skip flags are DERIVED, never hand-maintained

`worker/wildlife_sources.py::derive_skip_flags()` reads the probe
report and writes `skip` + `skip_reason` back into the registry, so the
registry can never claim a source works when it does not. A source with
no feed today may have one tomorrow — the row stays, with the reason.

### BOTH STORES ARE WRITTEN

`news_sources` (what `worker/fetch.py::CLAIM_SQL` reads) **and**
`worker/feeds.json` (what `worker/check_feeds.py` audits). The fleet
already carries a **1,873-row** drift between the two; the wildlife
import adds none.

```bash
python3 -m worker.wildlife_sources validate                    # probe all (≈5 min)
python3 -m worker.wildlife_sources validate --retry-failed     # deep re-probe of failures
python3 -m worker.wildlife_sources import --write-skips        # dry run + derived skip flags
python3 -m worker.wildlife_sources import --apply             # write to news_sources + feeds.json
```

News feeds are **linked, never republished**: headline, publication
date, original URL, source id and the publisher's own summary only. No
article body, no image. `paywall` / `free_access` record what a reader
actually gets (6 of the 101 are paywalled).

Pinned by `worker/tests/test_wildlife_sources.py`.

## Source Types

| Type | How it works | Example |
|---|---|---|
| `rss` | Feedparser on RSS/Atom XML | BBC, Reuters |
| `web` | HTML scraper (robots.txt checked) | Sites without RSS |
| `json` | JSON parser (USGS, GDELT, NASA EONET) | API-based sources |

## Geolocation Pipeline

1. **Fast path** (`auto_categorize.py`): city name in title + body[:500], keyword classification
2. **AI path** (`extract.py`): Gemma-4 extracts location_text, summary, event_type; includes circuit breaker
3. **Place disambiguation** (`place_disambiguation.py`): 60+ watchlist entries; source_country prior; comma-less qualifiers
4. **Geocode** (`geocode.py`): Nominatim turns location_text → lat/lng; negative caching (1hr TTL)
5. **Density check** (`density.py`): flags clusters, Phase 1 body re-read, Phase 2 wiki_geo + cities_text fallback
6. **Cross-country validation**: source country vs detected country — rejects mismatches
7. **Anomaly detection** (`city_anomaly_detector.py`): periodic quarantine of mislocated clusters
8. **Source-geography gate** (`auto_categorize._source_geo_is_country_specific`):
   the single-city fallback ("every article the fast path could not place
   belongs to the source's newsroom") is only allowed for a source whose own
   country really is its centre of gravity. A global platform (dev.to), a
   pan-regional wire (`country="ME"` means the Middle East, **not** ISO
   Montenegro) or a mis-tagged source is refused → the article is left
   **unlocated** instead of being pinned to a capital.

## Source Placement Pileups & Location-Table Repair (2026-10-22)

The "103 Stories in Bamako, ML" incident: dev.to was seeded with `country=ML`
and 141 pan-Arab sources with `country="ME"` (ISO **Montenegro**), so the
source-based fallback collapsed their whole output onto one capital —
12.4k stories on Bamako, 41k on Podgorica. Full write-up:
`docs/SESSION_NOTES_2026-10-22-BAMAKO_PILEUP.md`.

**Rules that keep it fixed:**
- `news_sources.country` must be a real country the source publishes from.
  `ME`+`region=MENA`, `UN`, `EU` are **not** countries; regional/global
  sources carry `country = NULL` + their region.
- `news_locations.country` is **ISO-2**. Nominatim returns full country
  names ("United States", "Türkiye", "ایران") — normalise them, or every
  cross-country comparison silently mismatches.
- `news_source_geography` measures **content** placements only
  (`auto_categorize_method IS DISTINCT FROM 'source_fallback'`), so a
  fallback pile can never become the source's "top city" and re-inflate
  itself.
- A location row's label must match the place its **articles** name
  (`news_articles.location_text`) — the gazetteer label alone is not proof.

**Repair tooling:**
```bash
python3 -m worker.fix_source_pileups --dry-run      # audit pileups
python3 -m worker.fix_source_pileups --fix-sources --apply   # country metadata
python3 -m worker.fix_source_pileups --apply        # reset polluted placements
python3 -m worker.normalize_location_countries --apply       # ISO-2 country
python3 -m worker.repair_locations --dry-run        # mislabelled / duplicate rows
python3 -m worker.repair_locations --apply          # relabel + move (cheap)
python3 -m worker.repair_locations --apply --merge  # merge duplicates (SLOW)
```
`--merge` repoints every `news_articles` row of a duplicate location —
~220k rows at ~18 rows/s on a busy disk. **Run it in a quiet window.**

**After changing placement code:** `python3 -m worker.source_profiles --all
--days 30` (the profiles feed the gate) and restart the fetchers —
`sudo systemctl restart xyzo-fast-fetcher xyzo-fetcher` — a running cycle
keeps the old code in memory.

## City Coordinate Validation

**Script:** `worker/validate_cities.py`

Uses Natural Earth 110m country polygons (loaded into `spatial.ne_countries` table) to validate city coordinates:
- **Wrong country**: city point falls in a different country's NE polygon
- **Disputed**: Crimea (UA cities in RU polygon area)
- **Island**: legitimate territories (Canary Islands, Azores, Puerto Rico, Okinawa, etc.)
- **Valid**: within-country coordinate

**Running validation:**
```bash
python -m worker.validate_cities --stats    # quick stats
python -m worker.validate_cities            # full report
python -m worker.validate_cities --fix       # apply auto-fixes
```

**coord_quality column** (`public.cities.coord_quality`):
- `valid` — coordinate within stated country
- `island` — legitimate territory (island, overseas territory)
- `disputed` — disputed territory (e.g., Crimea)
- `wrong_country` — coordinate falls in different country
- `swapped` — possibly lat/lng swapped
- `unvalidated` — not yet checked

**Known limitations:**
- NE 110m polygons are coarse — Caribbean islands near US, Philippine islands near CN may be misclassified
- French Polynesia, Vanuatu have incomplete NE coverage
- Norway's ISO code was `-99` in original NE — fixed manually

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `XYZO_PORT` | 3008 | API server port |
| `XYZO_FETCH_CONCURRENT` | 8 | Max parallel host groups |
| `XYZO_FETCH_INTERVAL` | 1.0 | Min seconds between same-host requests |
| `XYZO_AI_CHAT_URL` | `http://192.168.1.3:8888/chat/stream` | AI endpoint |
| `XYZO_AI_TIMEOUT` | 25 | AI request timeout (seconds) |
| `XYZO_DB_DSN` | `postgresql://xyzo_app:...@localhost:5432/xyzo` | Database connection |
| `XYZO_WIKI_DB_URL` | `postgresql://xyzo_app:...@localhost:5432/wikipedia` | Wikipedia DB (18M articles) |
| `NER_BATCH_SIZE` | 25 | NER extraction batch size |
| `NER_DELAY_SECONDS` | 2.0 | Delay between NER batches (CPU throttling) |
| `NER_MAX_ARTICLES` | 1000000 | Max articles for NER backfill |

## NER Extraction Pipeline

Fast Named Entity Recognition using spaCy for entity extraction:

```bash
# spaCy NER (CPU, ~40 articles/sec):
python3 -m worker.ner_extract --method spacy --batch-size 100 --max-articles 10000

# GPU-aware NER with Gemma (configurable GPU budget):
python3 -m worker.entity_extract --gpu-budget 0.3 --max-articles 5000 --backfill

# Gentle backfill (low CPU usage):
python3 scripts/ner_backfill_gentle.py --max-articles 563000
```

### spaCy vs Transformer NER

| Method | Speed | GPU | Accuracy |
|--------|-------|-----|---------|
| spaCy (`en_core_web_sm`) | ~40 articles/sec | No | Good for standard entities |
| Transformer (`dslim/bert-base-NER`) | ~20 articles/sec | Yes (GPU) | Higher accuracy |

### Wikimedia Resolution Experiment

Measure Wikipedia/Wikidata resolution rates:

```bash
python3 -m worker.wikimedia_experiment 3000
```

## Diagnostic Instrumentation Pattern

When adding new frontend network requests or API failure paths in `public_html/app.js`:
- Use `_logFetchError(kind, context)` to capture failure context (e.g., `kind: "http"`, `kind: "network"`, `kind: "retry_exhausted"`).
- Failures populate the in-memory diagnostic ring buffer exposed via `window.__xyzoFetchDiagnostics()`.
- Expandable error details are surfaced to users in the stale-data banner details toggle without cluttering console output.

## XYZO Debugging Infrastructure

Run `xyzo-debug` (Python module: `worker.xyzo_debug.xyzo_debug`) for comprehensive diagnostics.

### Quick Commands

```bash
# Full system health (DB + sources + UI)
python -m worker.xyzo_debug.xyzo_debug health

# UI health scan — checks all important buttons/elements
python -m worker.xyzo_debug.xyzo_debug ui --url http://xyzo.org

# Pin count diagnostic — trace DB → API → Browser
python -m worker.xyzo_debug.xyzo_debug pins --bbox "105.0,-7.0,107.0,-5.0"
python -m worker.xyzo_debug.xyzo_debug pins --bbox "..." --compare       # desktop vs mobile
python -m worker.xyzo_debug.xyzo_debug pins --bbox "..." --explain       # EXPLAIN ANALYZE

# Mobile test matrix — 6 devices (Desktop, Laptop, Tablet, iPhone, Android)
python -m worker.xyzo_debug.xyzo_debug mobile --lat -6.2 --lng 106.8 --zoom 8

# Check mobile pin bug — specifically diagnose mobile vs desktop pin count
python -m worker.xyzo_debug.xyzo_debug mobile --check-bug --lat -6.2 --lng 106.8 --zoom 8

# Click investigation — diagnose why a button isn't clickable
python -m worker.xyzo_debug.xyzo_debug click --url http://xyzo.org --selector "#reload-btn"

# Network throttle — test under Fast, Normal, Slow 4G, Very Slow, Offline
python -m worker.xyzo_debug.xyzo_debug network --condition slow_4g
python -m worker.xyzo_debug.xyzo_debug network --condition all           # all conditions

# Bug packet — generate full diagnostic report
python -m worker.xyzo_debug.xyzo_debug bug --description "Load More broken" --url http://xyzo.org

# Screenshot
python -m worker.xyzo_debug.xyzo_debug screenshot --url "http://xyzo.org/#-6.2,106.8,8" --name jakarta

# Rapid interaction test — expose race conditions
python -m worker.xyzo_debug.xyzo_debug rapid --zoom --network slow_4g --count 10

# Compare desktop vs mobile for specific coordinates
python -m worker.xyzo_debug.xyzo_debug compare --lat -6.2 --lng 106.8 --zoom 8
```

### Architecture

```
BROWSER
   ↓
NETWORK (Chrome DevTools MCP + Playwright traces)
   ↓
API (httpx diagnostics, response validation)
   ↓
SQL (EXPLAIN ANALYZE, bbox query tracing)
   ↓
POSTGRES + POSTGIS
```

### Chrome DevTools MCP

Configured in `~/.config/opencode/opencode.json`:
```json
"mcp": {
  "MCP_DOCKER": {
    "type": "local",
    "command": ["docker", "mcp", "gateway", "npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect", "run"],
    "enabled": true
  }
}
```
Provides: Console, Network, DOM, CSS, JS, Performance, browser state.

### Playwright Diagnostics

`worker/xyzo_debug/playwright_diagnostics.py` — Playwright with trace recording:
- Chromium/Firefox/WebKit support
- Automatic trace capture on failures
- DOM snapshots
- Screenshot on error
- Network/console event capture
- Mobile device emulation

### Key Files

| File | Purpose |
|---|---|
| `worker/xyzo_debug/click_investigator.py` | Diagnose unclickable elements (z-index, pointer-events, obstruction) |
| `worker/xyzo_debug/ui_health_scanner.py` | 15-point automated element checks |
| `worker/xyzo_debug/bug_packet.py` | Auto-generated diagnostic bug packets |
| `worker/xyzo_debug/playwright_diagnostics.py` | Playwright with traces |
| `worker/xyzo_debug/mobile_testing.py` | Device matrix (6 devices), mobile pin comparison |
| `worker/xyzo_debug/visual_regression.py` | Screenshot comparison, baseline capture |
| `worker/xyzo_debug/network_throttle.py` | Network conditions testing, race detection |
| `worker/xyzo_debug/db_diagnostics.py` | DB → API → Browser tracing |

### Mobile Pin Bug Investigation Pattern

When investigating mobile pin display issues:
1. `xyzo-debug mobile --check-bug --lat X --lng Y --zoom Z` — compare desktop vs mobile
2. `xyzo-debug pins --bbox ... --compare` — trace DB count vs API count
3. Check API response: `curl "http://localhost:3008/api/pins/map?bbox=...&limit=2000"`
4. Check if `limit` is being capped differently for mobile vs desktop

Common causes: mobile bbox calculation, pagination truncation (LIMIT 500 vs 5000), request cancellation races, frontend replacing instead of merging results.

---

## Session Notes — Oct 15, 2026 (Console-Error Cleanup)

### Problem
Every `systemctl restart xyzo-api` surfaced a storm of browser console errors
(`502` on /api/feed/live, /api/feed/live/stream, /api/health, /api/sysload,
/api/version, /api/ai-status + `net::ERR_HTTP2_PROTOCOL_ERROR` on open SSE
streams). Deploys close the port ~10s (ExecStartPre validation runs while
down); Caddy returned 502 immediately and `process.exit()` reset in-flight
HTTP/2 streams.

### Fixes
1. **Caddy `lb_try_duration 20s` / `lb_try_interval 250ms`** on all
   localhost:3008 proxies (`/api/*`, `/search/results`, nova) — refused dials
   are queued instead of 502'd. Verified: restart with a 0.3s probe loop →
   **90/90 × HTTP 200** (one request held 1.5s), zero 502s.
2. **Graceful SSE shutdown** — `feed-broadcaster.ts` gained
   `closeStream()`/`closeAllClients()`; `server.ts` shutdown calls
   `closeFeedStreams(signal)` right after `server.stop()`, before the 30s
   worker-pool drain. Open streams get `event: bye` + clean EOF →
   EventSource reconnects silently. Verified live: stream ends with
   `bye` + curl exit 0 (no HTTP/2 reset).
3. **SSE snapshot bug (live)** — `feed.ts` SSE initial snapshot used
   `${sql.unsafe(graphBoostExpr)}` on a postgres.js *fragment* →
   stringified to `[object Object]` → `syntax error at or near "["` →
   every client got `snapshot_failed` (swallowed silently since the graph-boost
   WIP). Fixed to `${graphBoostExpr}` (matches the JSON handler). Added
   `console.error` logging in both snapshot catches (initial + 60s resync).
4. **Test-DB drift** — `news_event_graph_features` (migration
   2026-10-02) existed in prod but not `xyzo_test` → 8 pre-existing
   `feed-bbox.test.ts` failures. Applied DDL-only (lines 5–43; the backfill
   needs `news_story_links`, absent in xyzo_test) via `XYZO_DB_URL` from
   `api/.env.test` — note tests use **XYZO_DB_URL**, not XYZO_DB_DSN.
5. Tests: `sse-feed` + `feed-bbox` + `health` = 21/21 pass;
   `validate-api.sh --quick` ✅.

### Files changed
- `/etc/caddy/Caddyfile` (lb_try on 4 reverse_proxies)
- `api/src/feed-broadcaster.ts`, `api/src/server.ts`, `api/src/routes/feed.ts`
- `api/tests/sse-feed.test.ts` (closeStream unit tests)
- xyzo_test DB: `news_event_graph_features` DDL

---

## Session Notes — Sep 21, 2026 (Evening)

### Completed

1. **Geolocation Misassignment Fixes** (major — ~15k+ articles affected):
   - Added 7 new entries to `place_disambiguation.py` watchlist: valencia, fargo, negara, victoria, el paso, jos
   - Added fargo, negara, jos to `cities_text.py` SKIP_WORDS
   - Added cross-country validation in `auto_categorize.py` `_source_fallback()` (was missing!)
   - Fixed `full_stats.get("all")` → `full_stats.get("cities")` bug in `_source_fallback()`
   - Strengthened cross-country validation in `extract.py` (removed src_country requirement)

2. **Statistical Anomaly Detection** — Found 6 categories of misassignment:
   - Common word = city name (Fargo/Wells Fargo, Negara/Indonesian, Victoria, El Paso/Spanish)
   - Publication name = location (Silicon Republic, 36Kr, WXYZ Detroit)
   - Country code confusion (Vancouver, CA → Toronto)
   - City name wrong country (Valencia CF → VE instead of ES)
   - Subword matching (Jos in Croatian words)
   - Duplicate location IDs (Wollongong has 5 IDs)

### Test Status

- `worker/tests/test_place_disambiguation.py`: ✅ 215/215 passed
- Manual verification: ✅ 13/13 new disambiguation tests passed
- cities_text SKIP_WORDS: ✅ Fargo/Negara/Jos no longer match as cities

### Files Changed

- `worker/place_disambiguation.py` — 7 new watchlist entries
- `worker/cities_text.py` — 3 new SKIP_WORDS
- `worker/auto_categorize.py` — cross-country validation in _source_fallback(), fixed "all" → "cities"
- `worker/extract.py` — stronger cross-country validation
- `docs/GEOLOCATION_MISASSIGNMENTS_2026-09-21.md` — full documentation

### Known Issues (Not Fixed)

1. Publication name leak — source names (Silicon Republic, 36Kr) leak into location_text via `geocoded_location` field
2. Duplicate location IDs — Wollongong has 5 IDs inflating counts
3. Vancouver, CA geocoding — Nominatim confuses CA (Canada) vs CA (California)
4. 781 existing Valencia, VE articles need cleanup job

---

## Session Notes — Sep 19, 2026

### Completed

1. **VIZ Default States Fixed** (`public_html/viz.js`):
   - All VIZ features now default to `false` (PULSE_RINGS, HEXBIN_DENSITY, CONSTELLATIONS)
   - Prevents unwanted activation on hard refresh

2. **VIZ Button States Syncced** (`public_html/index.html`):
   - All viz buttons (arcs, pulse, hex, timeline, stars) now have `aria-pressed="false"` to match defaults

3. **Pins Toggle Added**:
   - New `viz-pins-btn` button in `index.html` (📍 Pins)
   - Handler in `app.js` (line 10407) toggles markers on/off via `activeModes`
   - Button state stays in sync when mode buttons are clicked (line 11693)

4. **City Name Bug Fixed** (`public_html/app.js` line 6374):
   - `spreadOverlappingPins()` now checks `group[0].pn` for compact-format pins
   - Previously only checked `place_name` and `location?.place_name`
   - Fixes "43 Stories in this location" → "43 Stories in Bandar Lampung, ID"

### Known Issues

1. **Hexbins don't follow map pan** — container point caching issue in viz.js
2. **Pulse rings not visible over specific pins** — position calculation issue
3. **City name assignment bugs** — extractor matches first city without checking context/country

### Test Status

- `tests/test_viz.py`: ✅ 6/6 passed
- `tests/test_boot_fetch_coordinator.py`: ✅ 7/7 passed
- `tests/test_time_dropdown_wiring.py`: ⚠️ 1 failure (pre-existing DOMContentLoaded listener at line 11612)
- `tests/layer-toggle-regression.bun.test.js`: ⚠️ 1 failure (pre-existing test regex mismatch)
- API: ✅ Working (`/api/pins/map` returns correct data with `place_name`)

### Files Changed Today

- `public_html/viz.js` — FEATURES flags all false, aria-pressed sync
- `public_html/index.html` — viz-pins-btn added, aria-pressed states corrected
- `public_html/app.js` — city name fix (pn check), pins toggle handler, syncPinsBtnState

---

## Session Notes — Sep 21, 2026

### Completed

1. **Escape Key Search Clear Fixed** (`public_html/app.js:1540`):
   - Pressing Escape when search was active now calls `clearSearch()`
   - Previously only called `closeActivePopup()`, leaving search active

2. **Source Country Prior in Disambiguation** (`place_disambiguation.py`):
   - Added `_try_source_country_prior()` for 19 multi-country ambiguous cities
   - When no context matches, uses source country as prior (e.g., US source → Virginia, USA)
   - Cities: virginia, alexandria, cordoba, santiago, granada, memphis, trinidad, merida, lima, sucre, potosi, tucuman, copiapo, iquique, antofagasta, valparaiso, concepcion, santa cruz, cochabamba

3. **Comma-less Qualifier Detection** (`place_disambiguation.py:is_qualified()`):
   - Now detects: "City of X", "Town of X", "X TN" (US state abbrevs), "X city"
   - Qualified locations bypass watchlist without needing comma

4. **Nominatim Negative Caching** (`geocode.py:run()`):
   - Failed lookups cached for 1 hour to prevent repeated API calls
   - Format: `dict[str, tuple[int | None, float]]` with timestamp

5. **Density Phase 2 cities_text Fallback** (`worker/density.py`):
   - Added `cities_text.stats()` fallback before hash-spread
   - Scans full body for cities before deterministic spread

6. **world_cities FK Orphan Fixed** (Database):
   - Fixed 1 orphaned `primary_city_id` (Channel NewsAsia Indonesia → Singapore)

### Test Status

- `worker/tests/test_place_disambiguation.py`: ✅ 183 passed
- `tests/test_viz.py`: ✅ 6 passed
- Playwright UI test: ✅ Escape key clears search

### Files Changed Today

- `public_html/app.js` — Escape key handler fixed
- `worker/place_disambiguation.py` — source_country prior, comma-less qualifiers
- `worker/extract.py` — pass source_country to disambiguate() + fixed system prompt placeholder
- `worker/auto_categorize.py` — pass source_country to disambiguate()
- `worker/wiki_geo.py` — pass source_country to disambiguate()
- `worker/city_anomaly_detector.py` — pass source_country to disambiguate()
- `worker/geocode.py` — negative caching
- `worker/density.py` — cities_text fallback

### Documentation Created

- `docs/SESSION_NOTES_2026-09-21.md` — Tonight's session notes
- Updated `docs/VIRGINIA_ZA_BUG_FIX.md` — Added Sep 21 improvements

### Known Issues (Not Fixed Tonight)

1. Hexbins don't follow map pan — container point caching issue in viz.js
2. Pulse rings not visible over specific pins — position calculation issue
3. ~~System prompt `{source_country}` placeholder never formatted~~ ✅ FIXED
4. Anomaly detector not integrated into density auto_correct phase (complex integration required)

---

## Session Notes — Sep 20, 2026

### Completed

1. **Stale Fetch Leases Cleared**:
   - 1843 sources had expired leases blocking fetch
   - Ran `cleanup_stale_leases()` to clear them
   - Sources now actively being fetched again

2. **Primary City Misassignments Fixed**:
   - Fixed 33 sources with `primary_city_id` pointing to wrong countries
   - Blic.rs (RS→Belgrade), Meduza (LV→Riga), Siasat (IN→Delhi), etc.
   - Corrected world_cities ID references (found ID corruption in table)

3. **triblive.com Source Classification Fixed**:
   - Changed country from PA (Panama) to US (Pittsburgh Steelers sports source)

4. **Yangchun Bug Investigation**:
   - Found 518 Panama articles incorrectly geolocated to China (Yangchun city)
   - Articles had incorrect `location_text = 'Yangchun'` set

5. **Source Health Dashboard API** (`/api/sources/health`):
   - New endpoint returns comprehensive health metrics
   - Tracks: total/active/healthy/high_error sources, article stats, contamination count

6. **High-Error Sources Documented**:
   - 1330 sources with >100 errors investigated
   - Marked with `locality` reason tags: `gov_blocked`, `never_succeeded`, `intermittent`, `defunct`
   - Created `docs/source_blocking_patterns.json` with full documentation

7. **Virginia, ZA Bug Fixed**:
   - Articles about Virginia, USA were being geolocated to Virginia, ZA (South Africa)
   - Added disambiguation rule in `place_disambiguation.py`
   - Fixed qualified-location logic to check watchlist even with comma
   - Cleared 165 mislocated articles (24 with clear US context + 141 from US sources)

### Known Issues

1. **Hexbins don't follow map pan** — container point caching issue in viz.js
2. **Pulse rings not visible over specific pins** — position calculation issue
3. **world_cities table has some corruption** — some city IDs have wrong country codes (worked around)

### Documentation Created

- `docs/HIGH_ERROR_SOURCES_REPORT.md` — Analysis of 1330 high-error sources
- `docs/source_blocking_patterns.json` — Country/region blocking patterns database
- `docs/VIRGINIA_ZA_BUG_FIX.md` — Root cause and fix for Virginia misplacement
- `docs/DIAGNOSTIC_REPORT_2026-09-20.md` — Full diagnostic findings

### Test Status

- `tests/test_viz.py`: ✅ 6/6 passed
- `tests/test_boot_fetch_coordinator.py`: ✅ 7/7 passed
- `tests/test_article_validation.py`: ✅ 9/9 passed
- `tests/test_ai_validate.py`: ✅ 8/8 passed
- API validation: ✅ ALL CHECKS PASSED

### Files Changed Today

- `api/src/routes/sources.ts` — Added `/sources/health` endpoint
- `worker/place_disambiguation.py` — Added Virginia disambiguation rule, fixed qualified-location logic
- `worker/fetch.py` — cleanup_stale_leases() function documented
- Database: news_sources.locality updated with reason tags (847 sources marked)
- Database: 165 Virginia, ZA articles cleared for re-processing
- Database: primary_city_id corrected for 33 sources

### API Endpoints

- `GET /api/sources/health` — Returns source health dashboard:
  ```json
  {
    "source_health": { "total": 4049, "active": 3660, "healthy": 1815, "high_error": 1330 },
    "contamination": { "misassigned_primary_city": 7 },
    "article_stats": { "last_24h": 51412, "last_7d": 397300 },
    "top_countries": [...]
  }
  ```

### Key Commands

```bash
# Clear stale fetch leases
XYZO_DB_DSN="postgres://..." python3 -c "from worker.fetch import cleanup_stale_leases; print(cleanup_stale_leases())"

# Check source health
curl http://localhost:3008/api/sources/health

# Validate API before deploy
bash scripts/validate-api.sh

# Restart services
systemctl restart xyzo-api xyzo-fast-fetcher
```

---

## Session Notes — Sep 28, 2026

### Completed

1. **User News Submissions** (`POST /api/news/submit` — new `api/src/routes/news.ts`):
   - Queue table `user_news_submissions` (migration `api/migrations/2026-09-28-user-news-submissions.sql`, applied to prod + xyzo_test)
   - Zod-validated, RateLimiter 10/h/IP, SSRF-guarded via `lib/ssrf.ts` assertSafeUrl
   - Pending-only queue: never touches news_articles, never scrapes synchronously; URL-level dedupe via partial unique index
   - UI: paste-URL form inside existing Explore panel "Submit News" section (index.html) — no layout changes

2. **Article Recommendations** (`POST/GET /api/news/:id/recommend`):
   - `news_article_recommendations` (one vote/IP, partial unique index) + `news_articles.recommend_count` INT maintained by integer increment
   - All aggregate reads `::float` + `Math.round()` (BigInt rule); pin-id → article-id resolution mirrors feedback.ts
   - UI: 👍 button in pin popups (desktop actions row + mobile row), localStorage state, XLog-only diagnostics
   - Tests: `api/tests/news-routes.test.ts` (9 tests, pass)

3. **BigInt Serialization Audit** (all `api/src/routes/*.ts` + `metrics.ts`, two-agent sweep of ~370 aggregate sites):
   - **Fixed live 500s**: `insights.ts` /insights/event/:id/stats (COUNT DISTINCT uncast), `explore.ts` /region-sources (raw BIGSERIAL id passthrough)
   - **Fixed latent**: `city-story.ts` (3 handlers: city_id/story_id/quadrants + stats aggregates → ::float/Number), `service-events.ts` (2 raw id passthroughs), `nn.ts` POST /nn/feedback id, `metrics.ts getStats()`
   - **Semantics fix**: `insights.ts:527` `articleCount === 0` never true for BigInt (`0n === 0` → false) — dead early-return revived via Number()
   - ~370 other sites verified safe (already Number()/::cast wrapped)

4. **Fetch Lease Batch-Limiting** (`worker/fetch.py`):
   - `CLAIM_BATCH_SIZE=200` (`XYZO_FETCH_CLAIM_BATCH`), LIMIT inside claimable CTE
   - `fetch_all` restructured: claim batch → `_run_batch()` → re-claim (leases fresh per batch; was one 5-min lease over a 40–60 min ~2,400-source sweep)
   - Verified live: 184 in-flight leases post-deploy (was ~2,400)
   - Pinned by 3 new tests in `worker/tests/test_fetch_smart_policy.py` (12/12 pass)

5. **Bounded Feed Parsing Extended**:
   - `worker/web_scraper.py`: `_bounded_get()` streams with `MAX_FEED_BYTES` (8MB) cap — main page, article fetches, validate_web_source (was unbounded `client.get()`)
   - `worker/audio_fetch.py`: podcast feeds now stream under the same 8MB cap; `max_redirects=6` on Client constructor (2026-09-26 outage lesson)

6. **Cooperative CPU Guard Activated**:
   - `health_monitor --cpu-guard` existed but NOTHING scheduled it — added `*/2` crontab line (per deploy/systemd-limits/README.md)
   - Added `--quiet` flag to health_monitor (README referenced it; argparse rejected it)
   - `worker.run` already honors `data/load_pause` ✅

### Test Status

- `bash scripts/validate-api.sh`: ✅ ALL CHECKS PASSED
- `bun run scripts/api-health-check.js`: ✅ 9/10 unchanged after `--update` (pins/map hash drifts with live data by design; **story-links/stats takes >10s — exceeds the health-check timeout, pre-existing perf issue**, baseline entry dropped until it's sped up)
- `bun test public_html/tests/*.bun.test.js`: 114 pass / 8 fail — **all 8 pre-existing** (verified they fail on git HEAD: #share-btn & #reload-pins-btn don't exist in index.html; app.js 682KB > 525KB size gate at HEAD; flag-quality.js eager-load)
- `api/tests` full-suite parallel run: 93 fails from cross-file truncateAll races (pre-existing; files pass individually — news-routes 9/9, admin 10/10)
- `python3 -m pytest worker/tests/`: 633 pass / 24 fail — all pre-existing files (ai_client, image_pipeline ×11, labeling, location_id_backfill, news_source_addition ×6, service_events_api ×2, source_quality). Fixed `test_pipeline_smoke` scrape test for the new streaming interface (36/36 pass)

### Files Changed

- `api/src/routes/news.ts` (new), `api/src/server.ts` (register newsRoute)
- `api/migrations/2026-09-28-user-news-submissions.sql` (new, applied prod+test)
- `api/src/routes/{city-story,explore,insights,nn,service-events}.ts`, `api/src/metrics.ts` (BigInt fixes)
- `api/tests/news-routes.test.ts` (new)
- `public_html/index.html` (submit form in Explore drawer, ?v= bump), `public_html/app.js` (submit wiring, 👍 recommend button)
- `worker/fetch.py` (batch claims), `worker/web_scraper.py` + `worker/audio_fetch.py` (bounded fetches), `worker/health_monitor.py` (--quiet)
- `worker/tests/{test_fetch_smart_policy,test_pipeline_smoke}.py`
- crontab: `*/2` cpu-guard line

### Known Issues (Not Fixed)

1. `/api/story-links/stats` >10s (COUNT over 5.2M links) — needs precomputed stats or index work
2. api/tests full-suite parallel races (truncateAll CASCADE across files) — suite needs per-file schemas or serial mode
3. 8 pre-existing frontend test failures (stale tests vs current index.html/app.js)
4. Null-IP recommend votes (no X-Forwarded-For) can't dedupe — bounded by 30/h rate limit only

---

## Session Notes — Sep 28, 2026 (Late) — Click-to-Submit + Two-Stage Moderation + Layer Toggles

### Feature: click any empty map point → submit a story idea

**Flow:** map click (guarded: not when popups/panels/fix-mode are active) → existing
submitter overlay opens pre-pinned to the click point → title (+ optional details,
name, email, URL, category) → **Stage 1** sync fast scan → published + **Stage 2**
queued → success panel shows the submitter what the scanner understood
("We read this as a sports story (matched: …), likely Spanish").

**Stage 1 — `api/src/lib/quickmod.ts` (pure TS, sub-ms, no I/O):**
- Multilingual spam/scam blocklist (15 languages) + scam regexes (URL shorteners,
  WhatsApp/Telegram harvest, crypto patterns), slur list
- Gibberish detection (script-aware vowel-ratio/consonant-run; Latin+Cyrillic models)
- All-caps / punctuation-spam / repeated-token / link-count / zero-width-char checks
- Lite topic classifier: 12 categories × 13 languages, word-boundary regex matching
  (fixes "war"⊂"warning" class of false hits), inflection-tolerant (≥5-char keywords)
- Deliberately NEVER blocks violence/disaster vocabulary — it's a news map
- Route adds: (0,0) null-island reject, 7-day exact-title + trgm-similar/250km dedupe
  (409), per-IP burst limiter (3/10min) + DB velocity check (5/h), honeypot kept

**Stage 2 — `worker/pin_moderate.py` via `community_triage` queue (op=moderate_pin):**
- word_freq extended analysis (langdetect, doc_type, frequency profile)
- Ocean/land check via `spatial.ne_countries` (xyzo_cities DB — separate DSN!)
- canonical_url → robots.txt verdict + bounded 8MB fetch (fetch._bounded_get) +
  page text extraction + frequency analysis
- LLM verdict ONLY when extract.py's circuit breaker says the box is free; SSE
  protocol (same wire format as _stream_chat) with own moderation prompt; 12s cap;
  strict JSON {ok, topic, category, reason≤60w}; skip → 'deep_ok_no_llm' (stays live)
- reject → pins.status='hidden' + mod_status='rejected'; category refinement when
  user didn't pick one (VALID_CATEGORIES = full pins_category_check set)
- Audit trail: community_details.mod_fast/mod_deep JSONB, mod_status lifecycle

**Layer toggles:** bottom bar Tools group → 📰 News / 👥 Community buttons
(`layerPrefs` persisted in localStorage `xyzo.layerPrefs`). Server-side filtering via
`source_type=rss,editorial|community` — MapPinsQuerySchema/ListPinsQuerySchema now
accept comma-separated lists (new `SourceTypeFilter` in validate.ts). Both-off →
fetchPinsForViewport early-returns with cleared canvas. Search deliberately bypasses
the layer filter (explicit intent).

**Schema:** `CommunitySubmissionSchema` — name/email now OPTIONAL (default
"Anonymous"), new `story_note` (max 2000). Migration
`2026-09-28-community-submissions.sql` (applied prod+test): story_note, submitter_ip,
mod_fast/mod_deep/mod_status cols; name/email DROP NOT NULL.

**Also fixed en route:** popup "Read more" button was DEAD (wired to `.read-more`,
markup emits `.popup-read-btn`) — now works for editorial body_markdown AND
community story_note.

### Verified live (E2E)

- POST → 201 + detected verdict JSON; queue job completed in ~7s
- Stage 2 real run: country=PK (Karachi point-in-polygon), lang=en, doc_type=news_report,
  LLM ran (breaker closed): ok=true, topic summary, category other→culture
- Spam POST → 400 rejected ["scam_pattern","spam_blocklist"], never stored
- `source_type=community` → community only; `rss,editorial` → news only

### Tests

- `api/tests/quickmod.test.ts` (24) + `api/tests/pins-submit-flow.test.ts` (7) +
  `worker/tests/test_pin_moderate.py` (9) — all pass
- pins.test.ts (12) unbroken by schema relaxation; targeted api suite 79/79
- Frontend bun: 114/122 (same 8 pre-existing); worker pytest: 642 pass / 24 pre-existing fail
- validate-api.sh ✅; health-check: shape-stable (count drift only), story-links >10s pre-existing

### Known limits

1. LLM stage depends on AI box availability — by design degrades to 'deep_ok_no_llm'
2. No admin review UI for mod_status='rejected'/'uncertain' rows yet (SQL only)
3. Layer toggles don't filter explicit searches (documented choice)
4. fastScan blocklist is curated, not exhaustive — stage 2 + rate limits are the backstop
